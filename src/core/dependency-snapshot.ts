import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readCandidateFile } from "./candidate.js";
import { canonicalJson, contentId } from "./canonical.js";
import { acquisitionStoreDirectory, loadAcquiredDependencyTree, readAcquiredDependencyTreeDescriptor } from "./dependency-acquisition.js";
import { scanDependencyTree } from "./dependency-tree.js";
import { ReviewLspError } from "./errors.js";
import { treeMetadataFingerprint } from "./tree-metadata.js";
import type {
  CandidateDescriptor,
  DependencyInputSet,
  DependencySnapshotDescriptor,
} from "./types.js";

/**
 * Publication and admission of a dependency snapshot.
 *
 * Publication is strictly offline. Anything the projection needs must already be in the
 * acquisition store, put there by an explicit acquisition; if it is not, publication fails
 * rather than quietly reaching the network. The published tree is sealed read-only and
 * content-addressed, so it can be re-verified before every semantic use.
 */

const PUBLISH_TIMEOUT_MS = 15 * 60 * 1000;

interface VerifiedSnapshotLease {
  descriptor_binding: string;
  root_realpath: string;
  root_dev: number;
  root_ino: number;
  root_mode: number;
  tree_metadata_sha256: string;
}

/**
 * Process-local verified leases.
 *
 * This is deliberately not durable. A process restart must full-reverify a cached snapshot
 * once before reuse. Within one trusted-local process, a sealed root with the same descriptor
 * binding and filesystem identity may reuse that verification without re-hashing every file.
 */
const verifiedSnapshotLeases = new Map<string, VerifiedSnapshotLease>();

function snapshotIdentity(descriptor: DependencySnapshotDescriptor): string {
  return contentId("depsnap", {
    schema_version: descriptor.schema_version,
    ecosystem: descriptor.ecosystem,
    package_manager: descriptor.package_manager,
    package_manager_version: descriptor.package_manager_version,
    platform: descriptor.platform,
    arch: descriptor.arch,
    input_set_id: descriptor.input_set_id,
    network_policy: descriptor.network_policy,
    script_policy: descriptor.script_policy,
    lockfile_policy: descriptor.lockfile_policy,
    dependency_graph: descriptor.dependency_graph,
    tree_manifest_sha256: descriptor.tree_manifest_sha256,
  });
}

async function snapshotLeaseFingerprint(descriptor: DependencySnapshotDescriptor): Promise<VerifiedSnapshotLease> {
  const [rootRealpath, rootInfo] = await Promise.all([
    realpath(descriptor.dependency_root),
    stat(descriptor.dependency_root),
  ]);
  if (!rootInfo.isDirectory()) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} root is not a directory`,
    );
  }
  if ((rootInfo.mode & 0o222) !== 0) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} root is not sealed read-only`,
    );
  }
  return {
    descriptor_binding: canonicalJson(descriptor),
    root_realpath: rootRealpath,
    root_dev: rootInfo.dev,
    root_ino: rootInfo.ino,
    root_mode: rootInfo.mode,
    tree_metadata_sha256: await treeMetadataFingerprint(descriptor.dependency_root),
  };
}

function sameSnapshotLease(a: VerifiedSnapshotLease, b: VerifiedSnapshotLease): boolean {
  return a.descriptor_binding === b.descriptor_binding
    && a.root_realpath === b.root_realpath
    && a.root_dev === b.root_dev
    && a.root_ino === b.root_ino
    && a.root_mode === b.root_mode
    && a.tree_metadata_sha256 === b.tree_metadata_sha256;
}

export function dependencySnapshotDirectory(stateDirectory: string, snapshotId: string): string {
  return join(stateDirectory, "dependencies", snapshotId);
}

export function dependencySnapshotDescriptorPath(stateDirectory: string, snapshotId: string): string {
  return join(dependencySnapshotDirectory(stateDirectory, snapshotId), "dependency-snapshot.json");
}

function isolatedEnvironment(home: string, storeDirectory: string, corepackDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, ".npmrc-global"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, ".npmrc-global"),
    PNPM_HOME: join(home, ".pnpm"),
    npm_config_store_dir: storeDirectory,
    COREPACK_HOME: corepackDirectory,
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_STRICT: "1",
    // Publication never acquires. If the store cannot satisfy the lockfile, that is an
    // acquisition question, and answering it here would hide a network access inside
    // something whose output is admitted as evidence.
    COREPACK_ENABLE_NETWORK: "0",
    CI: "1",
  };
}

async function run(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{
  code: number | null;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("corepack", args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ReviewLspError("DEPENDENCY_ACQUISITION_FAILED", `pnpm install exceeded ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    const collect = (chunk: Buffer): void => {
      if (output.length < 1_000_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ReviewLspError("DEPENDENCY_ACQUISITION_FAILED", `corepack failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Writes the admitted dependency-defining files, re-checking each digest as it goes. */
async function writeProjectInputs(
  candidate: CandidateDescriptor,
  inputs: DependencyInputSet,
  projectRoot: string,
): Promise<void> {
  for (const file of inputs.files) {
    const { bytes, sha256: digest } = await readCandidateFile(candidate, file.path);
    if (digest !== file.sha256) {
      throw new ReviewLspError(
        "DEPENDENCY_INPUT_INVALID",
        `candidate input ${file.path} changed between derivation and publication`,
      );
    }
    const destination = join(projectRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
}

/**
 * pnpm bookkeeping that records wall-clock state rather than dependency content.
 *
 * `.pnpm-workspace-state-v1.json` carries a `lastValidatedTimestamp`, so binding it would
 * make every publication of identical inputs produce a different snapshot identity. It is
 * pnpm's own cache for deciding whether the workspace changed, it has no bearing on module
 * resolution, and nothing re-runs pnpm against a sealed snapshot. It is therefore removed
 * before the manifest is built, so it is neither present in the snapshot nor silently
 * excluded from what the manifest covers.
 */
const NON_DEPENDENCY_STATE_BASENAMES = new Set([
  // Carries `lastValidatedTimestamp`.
  ".pnpm-workspace-state-v1.json",
  // Carries `prunedAt`, written when pnpm prunes, which happens non-deterministically.
  ".modules.yaml",
]);

/**
 * Removes pnpm's own bookkeeping wherever it placed it.
 *
 * These files record wall-clock timestamps, so binding them would make snapshot identity a
 * function of when publication ran rather than of what it produced — two publications of
 * identical inputs would be different snapshots. Nothing is lost by excluding them: they
 * describe how the install was configured, and every part of that which affects resolution
 * (admitted `.npmrc` settings, lockfile, pinned pnpm version, platform and arch) is already
 * bound through `input_set_id`, which `snapshot_id` covers. They are removed rather than
 * skipped during scanning, so the manifest still covers everything present.
 *
 * The depth is not fixed: pnpm writes workspace state beside the root `node_modules` and may
 * write it beside a workspace package's own, so this matches on basename at every level
 * rather than guessing paths.
 */
async function removeNonDependencyState(root: string, relativePath = ""): Promise<void> {
  const absolute = relativePath ? join(root, relativePath) : root;
  const info = await lstat(absolute).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (!info.isDirectory()) return;
  for (const name of await readdir(absolute)) {
    const child = join(absolute, name);
    if (NON_DEPENDENCY_STATE_BASENAMES.has(name)) {
      await rm(child, { force: true, recursive: true }).catch(() => undefined);
      continue;
    }
    await removeNonDependencyState(root, relativePath ? join(relativePath, name) : name);
  }
}

/** Removes everything that is not a `node_modules` tree, leaving only dependency material. */
async function pruneToDependencyMaterial(root: string, relativePath = ""): Promise<boolean> {
  const absolute = relativePath ? join(root, relativePath) : root;
  const names = await readdir(absolute);
  let keptAnything = false;

  for (const name of names) {
    const childRelative = relativePath ? join(relativePath, name) : name;
    const childAbsolute = join(absolute, name);
    if (name === "node_modules") {
      keptAnything = true;
      continue;
    }
    const info = await lstat(childAbsolute);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      if (await pruneToDependencyMaterial(root, childRelative)) keptAnything = true;
      else await rm(childAbsolute, { recursive: true, force: true });
      continue;
    }
    await rm(childAbsolute, { force: true });
  }
  return keptAnything;
}

/** Seals the published tree: nothing under an admitted snapshot may be writable. */
async function seal(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(root, relativePath) : root;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      directories.push(absolute);
      for (const name of await readdir(absolute)) {
        await visit(relativePath ? join(relativePath, name) : name);
      }
      return;
    }
    await chmod(absolute, (info.mode & 0o111) !== 0 ? 0o555 : 0o444);
  }
  await visit("");
  for (const directory of directories.sort((a, b) => b.length - a.length)) {
    await chmod(directory, 0o555);
  }
}

async function makeOwnerWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700).catch(() => undefined);
    for (const name of await readdir(root)) await makeOwnerWritable(join(root, name));
    return;
  }
  await chmod(root, 0o600).catch(() => undefined);
}

export interface PublishOptions {
  candidate: CandidateDescriptor;
  inputs: DependencyInputSet;
  stateDirectory: string;
  timeoutMs?: number;
}

function snapshotIdentityMaterial(inputs: DependencyInputSet, treeManifestSha256: string) {
  return {
    schema_version: "review-lsp.dependency-snapshot.v1" as const,
    ecosystem: "node" as const,
    package_manager: "pnpm" as const,
    package_manager_version: inputs.package_manager_version,
    platform: inputs.platform,
    arch: inputs.arch,
    input_set_id: inputs.input_set_id,
    network_policy: "OFFLINE" as const,
    script_policy: "IGNORE_SCRIPTS" as const,
    lockfile_policy: "FROZEN" as const,
    dependency_graph: "INCLUDES_DEV" as const,
    tree_manifest_sha256: treeManifestSha256,
  };
}

export async function publishDependencySnapshot(options: PublishOptions): Promise<DependencySnapshotDescriptor> {
  const { candidate, inputs, stateDirectory } = options;
  const storeDirectory = acquisitionStoreDirectory(stateDirectory);
  const corepackDirectory = join(stateDirectory, "dependency-acquisition", "corepack");
  // The staging path is derived from the input set, not randomised.
  //
  // pnpm records absolute paths in its own bookkeeping — `node_modules/.modules.yaml` and
  // `node_modules/.pnpm-workspace-state-v1.json` hold the store and virtual-store locations —
  // so a random staging directory puts a different absolute path inside admitted bytes on
  // every run, and two publications of identical inputs then produce different snapshot
  // identities. Those recorded paths still refer to the staging location after publication;
  // nothing re-runs pnpm against a sealed snapshot, and semantic resolution does not read
  // them, but they are bound rather than stripped because stripping would unbind real bytes.
  const stagingRoot = join(stateDirectory, "dependencies", `.staging-${inputs.input_set_id}`);
  const home = join(stagingRoot, "home");
  const projectRoot = join(stagingRoot, "project");

  await mkdir(join(stateDirectory, "dependencies"), { recursive: true, mode: 0o700 });
  // Leftovers from an interrupted publication of these same inputs are ours to clear; a
  // concurrent publication of the same inputs would produce the same snapshot anyway.
  await makeOwnerWritable(stagingRoot);
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(home, ".npmrc"), "", { mode: 0o600 });
  await writeFile(join(home, ".npmrc-global"), "", { mode: 0o600 });

  try {
    // Re-read every candidate dependency-defining input before publication. The acquisition
    // tree is mutable cache and never substitutes for candidate authority.
    await writeProjectInputs(candidate, inputs, projectRoot);

    // A materialized-acquisition descriptor may be used only as a cache-address hint.
    // If a sealed content-addressed snapshot for that exact tree already exists, verify the
    // snapshot itself and return it before copying hundreds of MB again. The mutable acquisition
    // bytes are not trusted by this fast path.
    const acquiredHint = await readAcquiredDependencyTreeDescriptor(stateDirectory, inputs.input_set_id);
    if (acquiredHint) {
      const hintedIdentity = snapshotIdentityMaterial(inputs, acquiredHint.tree_manifest_sha256);
      const hintedSnapshotId = contentId("depsnap", hintedIdentity);
      try {
        const existing = JSON.parse(
          await readFile(dependencySnapshotDescriptorPath(stateDirectory, hintedSnapshotId), "utf8"),
        ) as DependencySnapshotDescriptor;
        if (existing.input_set_id !== inputs.input_set_id) {
          throw new ReviewLspError("DEPENDENCY_SNAPSHOT_INVALID", "cached snapshot input-set binding does not match current candidate inputs");
        }
        await verifyDependencySnapshot(existing);
        return existing;
      } catch (error) {
        if (error instanceof ReviewLspError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    // Prefer an explicitly materialized acquisition graph. This handles resolver shapes such
    // as Git/codeload tarballs that pnpm can materialize during authorized acquisition but
    // cannot necessarily reconstruct later with --offline. P2B still copies, rescans and seals
    // the graph; acquisition bytes themselves are never admitted.
    const acquired = await loadAcquiredDependencyTree(stateDirectory, inputs.input_set_id);
    const materializationMethod = acquired
      ? "acquired-tree-copy"
      : "clone-or-copy";

    if (acquired) {
      await rm(projectRoot, { recursive: true, force: true });
      await cp(acquired.dependency_root, projectRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
    } else {
      const result = await run([
        `pnpm@${inputs.package_manager_version}`,
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--offline",
        `--store-dir=${storeDirectory}`,
        "--package-import-method=clone-or-copy",
        "--config.confirmModulesPurge=false",
      ], { cwd: projectRoot, env: isolatedEnvironment(home, storeDirectory, corepackDirectory), timeoutMs: options.timeoutMs ?? PUBLISH_TIMEOUT_MS });

      if (result.code !== 0) {
        throw new ReviewLspError(
          "DEPENDENCY_ACQUISITION_REQUIRED",
          `offline snapshot publication failed; run acquisition first: ${result.output.trim().slice(-1500)}`,
        );
      }

      await removeNonDependencyState(projectRoot);
      await pruneToDependencyMaterial(projectRoot);
    }

    const scan = await scanDependencyTree(projectRoot);
    if (scan.multiply_linked.length > 0) {
      throw new ReviewLspError(
        "DEPENDENCY_SNAPSHOT_INVALID",
        `${scan.multiply_linked.length} snapshot files are hard links, for example ${scan.multiply_linked[0]}`,
      );
    }

    const identityMaterial = snapshotIdentityMaterial(inputs, scan.tree_manifest_sha256);
    const snapshotId = contentId("depsnap", identityMaterial);
    const snapshotDirectory = dependencySnapshotDirectory(stateDirectory, snapshotId);

    const lockfile = inputs.files.find((file) => file.path === "pnpm-lock.yaml");
    if (!lockfile) throw new ReviewLspError("DEPENDENCY_INPUT_INVALID", "lockfile binding is missing from admitted inputs");

    const descriptor: DependencySnapshotDescriptor = {
      ...identityMaterial,
      snapshot_id: snapshotId,
      input_manifest: inputs.files,
      lockfile_binding: lockfile,
      workspace_binding: inputs.files.find((file) => file.path === "pnpm-workspace.yaml") ?? null,
      patch_binding: inputs.patches,
      config_binding: inputs.npmrc_settings,
      dependency_root: join(snapshotDirectory, "dependencies"),
      file_count: scan.file_count,
      symlink_count: scan.symlink_count,
      total_bytes: scan.total_bytes,
      materialization_method: materializationMethod,
      created_at: new Date().toISOString(),
    };

    // An identical snapshot already published is already sealed and verified; republishing
    // would only risk disturbing admitted bytes.
    try {
      const existing = JSON.parse(await readFile(dependencySnapshotDescriptorPath(stateDirectory, snapshotId), "utf8")) as DependencySnapshotDescriptor;
      await verifyDependencySnapshot(existing);
      return existing;
    } catch (error) {
      if (error instanceof ReviewLspError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const publishStaging = join(stateDirectory, "dependencies", `.publish-${process.pid}-${randomUUID()}`);
    await mkdir(publishStaging, { recursive: true, mode: 0o700 });
    await rename(projectRoot, join(publishStaging, "dependencies"));
    await writeFile(
      join(publishStaging, "dependency-snapshot.json"),
      `${JSON.stringify(descriptor, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await seal(join(publishStaging, "dependencies"));
    await rename(publishStaging, snapshotDirectory);

    await verifyDependencySnapshot(descriptor);
    return descriptor;
  } finally {
    await makeOwnerWritable(stagingRoot);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Re-derives a published snapshot's identity from what is actually on disk.
 *
 * Called before every semantic use: a snapshot that was sealed correctly but has since been
 * altered must not keep its admission simply because a descriptor file still says so.
 */
export async function verifyDependencySnapshot(descriptor: DependencySnapshotDescriptor): Promise<void> {
  const expectedId = snapshotIdentity(descriptor);
  if (expectedId !== descriptor.snapshot_id) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} does not match its own content-addressed identity`,
    );
  }

  let lease: VerifiedSnapshotLease;
  try {
    lease = await snapshotLeaseFingerprint(descriptor);
  } catch (error) {
    if (error instanceof ReviewLspError) throw error;
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} root identity is not readable: ${(error as Error).message}`,
    );
  }
  const cached = verifiedSnapshotLeases.get(descriptor.snapshot_id);
  if (cached && sameSnapshotLease(cached, lease)) return;

  const scan = await scanDependencyTree(descriptor.dependency_root).catch((error: unknown) => {
    if (error instanceof ReviewLspError) throw error;
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} is not readable: ${(error as Error).message}`,
    );
  });

  if (scan.tree_manifest_sha256 !== descriptor.tree_manifest_sha256) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} no longer matches its published tree manifest`,
    );
  }
  if (scan.multiply_linked.length > 0) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} contains hard-linked files`,
    );
  }

  if (scan.file_count !== descriptor.file_count
    || scan.symlink_count !== descriptor.symlink_count
    || scan.total_bytes !== descriptor.total_bytes) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_INVALID",
      `dependency snapshot ${descriptor.snapshot_id} published counts no longer match its tree`,
    );
  }

  verifiedSnapshotLeases.set(descriptor.snapshot_id, lease);
}

export async function removeDependencySnapshot(descriptor: DependencySnapshotDescriptor): Promise<void> {
  const directory = dirname(descriptor.dependency_root);
  await makeOwnerWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

/** Canonical JSON of a descriptor, for binding a snapshot into other evidence. */
export function dependencySnapshotBinding(descriptor: DependencySnapshotDescriptor): string {
  return canonicalJson({
    snapshot_id: descriptor.snapshot_id,
    input_set_id: descriptor.input_set_id,
    tree_manifest_sha256: descriptor.tree_manifest_sha256,
  });
}
