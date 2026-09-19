import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { contentId, sha256 } from "./canonical.js";
import { runEntryPointGate } from "./entry-points.js";
import { ReviewLspError } from "./errors.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
  ProjectionUriClass,
  ProjectionUriClassification,
} from "./types.js";

/**
 * The semantic execution projection.
 *
 * The exact Git candidate stays immutable and dependency-free, because it is the source
 * authority and its path-set/bytes invariant is what a document receipt rests on. Semantic
 * execution needs something else: a tree where the project's own `node_modules` is resolvable.
 * The projection is that tree — candidate source bytes plus admitted dependency material —
 * and the language server is pointed at it, never at the candidate.
 *
 * Every source path in the projection must still hash back to its candidate entry, so a
 * document answered here is a document from the candidate.
 */

const PROJECTION_IMPLEMENTATION = "review-lsp.projection.v1+copy-source+link-dependencies";

export function projectionDirectory(stateDirectory: string, projectionId: string): string {
  return join(stateDirectory, "projections", projectionId);
}

function within(root: string, path: string): string | undefined {
  const delta = relative(root, path);
  if (delta === "") return "";
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) return undefined;
  return delta;
}

/** Materializes candidate bytes into the projection, verifying each entry as it is written. */
async function writeCandidateSource(candidate: CandidateDescriptor, executionRoot: string): Promise<void> {
  for (const entry of candidate.entries) {
    const destination = join(executionRoot, entry.path);
    if (within(executionRoot, destination) === undefined) {
      throw new ReviewLspError("PROJECTION_INVALID", `candidate entry ${entry.path} escapes the projection root`);
    }
    await mkdir(dirname(destination), { recursive: true });

    if (entry.kind === "symlink") {
      if (typeof entry.symlink_target !== "string") {
        throw new ReviewLspError("PROJECTION_INVALID", `candidate symlink ${entry.path} has no recorded target`);
      }
      await symlink(entry.symlink_target, destination);
      continue;
    }

    const bytes = await readFile(join(candidate.source_root, entry.path));
    if (sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byte_count) {
      throw new ReviewLspError(
        "CANDIDATE_INTEGRITY_INVALID",
        `candidate file ${entry.path} changed while building the projection`,
      );
    }
    await writeFile(destination, bytes, { mode: entry.mode === "100755" ? 0o500 : 0o400 });
  }
}

/**
 * Links the snapshot's dependency trees into the projection.
 *
 * A real projection is hundreds of megabytes, so it is linked rather than copied. The link
 * target is the sealed snapshot, which is itself an admitted root, and URI classification
 * accepts a result whose realpath lands there.
 */
async function linkDependencies(
  snapshot: DependencySnapshotDescriptor,
  executionRoot: string,
): Promise<string[]> {
  const mounts: string[] = [];

  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(snapshot.dependency_root, relativePath) : snapshot.dependency_root;
    for (const name of await readdir(absolute)) {
      const childRelative = relativePath ? join(relativePath, name) : name;
      if (name === "node_modules") {
        const destination = join(executionRoot, childRelative);
        await mkdir(dirname(destination), { recursive: true });
        await rm(destination, { recursive: true, force: true }).catch(() => undefined);
        await symlink(join(snapshot.dependency_root, childRelative), destination);
        mounts.push(childRelative);
        continue;
      }
      const info = await lstat(join(absolute, name));
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(childRelative);
    }
  }

  await visit("");
  return mounts;
}

async function sealProjection(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      directories.push(path);
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    await chmod(path, (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
  }
  await visit(root);
  for (const directory of directories.sort((a, b) => b.length - a.length)) await chmod(directory, 0o500);
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

export interface BuildProjectionOptions {
  candidate: CandidateDescriptor;
  snapshot: DependencySnapshotDescriptor | null;
  stateDirectory: string;
  /** Workspace manifest paths the entry-point gate must check, relative to the root. */
  workspaceManifests?: string[];
}

export async function buildProjection(options: BuildProjectionOptions): Promise<ProjectionDescriptor> {
  const { candidate, snapshot, stateDirectory } = options;

  const projectionId = contentId("proj", {
    schema_version: "review-lsp.projection.v1" as const,
    projection_implementation: PROJECTION_IMPLEMENTATION,
    candidate_id: candidate.candidate_id,
    source_manifest_sha256: candidate.source_manifest_sha256,
    dependency_snapshot_id: snapshot?.snapshot_id ?? null,
    dependency_tree_manifest_sha256: snapshot?.tree_manifest_sha256 ?? null,
    isolation: candidate.isolation,
  });

  const directory = projectionDirectory(stateDirectory, projectionId);
  const executionRoot = join(directory, "execution");

  try {
    const existing = JSON.parse(await readFile(join(directory, "projection.json"), "utf8")) as ProjectionDescriptor;
    if (existing.projection_id === projectionId) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(join(stateDirectory, "projections"), { recursive: true, mode: 0o700 });
  const staging = join(stateDirectory, "projections", `.staging-${process.pid}-${randomUUID()}`);
  const stagingExecution = join(staging, "execution");
  await mkdir(stagingExecution, { recursive: true, mode: 0o700 });

  try {
    await writeCandidateSource(candidate, stagingExecution);
    const mounts = snapshot ? await linkDependencies(snapshot, stagingExecution) : [];

    const workspaceManifests = options.workspaceManifests ?? [];
    const gate = await runEntryPointGate({
      projectionRoot: stagingExecution,
      workspaceManifests,
      readManifest: (relativePath) => readFile(join(stagingExecution, relativePath), "utf8"),
    });

    const descriptor: ProjectionDescriptor = {
      schema_version: "review-lsp.projection.v1",
      projection_id: projectionId,
      projection_implementation: PROJECTION_IMPLEMENTATION,
      candidate_id: candidate.candidate_id,
      source_manifest_sha256: candidate.source_manifest_sha256,
      dependency_snapshot_id: snapshot?.snapshot_id ?? null,
      dependency_tree_manifest_sha256: snapshot?.tree_manifest_sha256 ?? null,
      isolation: candidate.isolation,
      execution_root: executionRoot,
      dependency_mounts: mounts,
      entry_point_gate: gate,
      created_at: new Date().toISOString(),
    };

    await writeFile(join(staging, "projection.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await sealProjection(stagingExecution);
    await rename(staging, directory);
    return descriptor;
  } catch (error) {
    await makeOwnerWritable(staging);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Re-checks that every candidate source path in the projection still holds candidate bytes.
 *
 * The projection is what answers queries, so its drift from the candidate is exactly the
 * failure a document receipt would otherwise hide.
 */
export async function verifyProjectionSource(
  projection: ProjectionDescriptor,
  candidate: CandidateDescriptor,
): Promise<void> {
  if (projection.candidate_id !== candidate.candidate_id
    || projection.source_manifest_sha256 !== candidate.source_manifest_sha256) {
    throw new ReviewLspError("PROJECTION_INVALID", `projection ${projection.projection_id} is not bound to this candidate`);
  }

  for (const entry of candidate.entries) {
    const absolute = join(projection.execution_root, entry.path);
    if (entry.kind === "symlink") continue;
    const bytes = await readFile(absolute).catch(() => undefined);
    if (!bytes) {
      throw new ReviewLspError("PROJECTION_INVALID", `projection is missing candidate path ${entry.path}`);
    }
    if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `projection path ${entry.path} no longer matches the candidate entry it must reproduce`,
      );
    }
  }
}

export interface ClassificationRoots {
  executionRoot: string;
  dependencyRoot?: string | undefined;
  toolchainRoots?: string[] | undefined;
  derivedRoots?: string[] | undefined;
}

/**
 * Classifies a URI a language server returned against the admitted roots.
 *
 * Both the lexical path and its realpath are considered. A pnpm projection reaches packages
 * through symlinks, so a result inside the projection legitimately resolves into the sealed
 * snapshot; that is admitted. What is not admitted is a lexical path inside a root whose
 * realpath leaves every root, or a path that matches nothing — those are `UNBOUND`, because
 * the evidence would otherwise cover bytes no admitted root binds.
 */
export async function classifyProjectionUri(
  uri: string,
  roots: ClassificationRoots,
): Promise<ProjectionUriClassification> {
  let path: string;
  try {
    path = uri.startsWith("file://") ? fileURLToPath(uri) : resolvePath(uri);
  } catch {
    return { uri, path: uri, realpath: null, classification: "UNBOUND", reason: "uri is not a filesystem path" };
  }

  const ordered: { root: string; classification: ProjectionUriClass }[] = [
    ...(roots.derivedRoots ?? []).map((root) => ({ root, classification: "DERIVED_WORKSPACE_ARTIFACT" as const })),
    ...(roots.dependencyRoot ? [{ root: roots.dependencyRoot, classification: "DEPENDENCY_SNAPSHOT" as const }] : []),
    ...(roots.toolchainRoots ?? []).map((root) => ({ root, classification: "TOOLCHAIN" as const })),
    { root: roots.executionRoot, classification: "CANDIDATE_SOURCE" as const },
  ];

  const resolved = await realpath(path).catch(() => null);

  // Prefer the realpath: it is where the bytes actually are, and it is what must be admitted.
  if (resolved) {
    for (const { root, classification } of ordered) {
      const rootReal = await realpath(root).catch(() => root);
      const delta = within(rootReal, resolved);
      if (delta !== undefined) {
        return { uri, path, realpath: resolved, classification, relative_path: delta };
      }
    }
  }

  // A lexical hit whose realpath escaped every admitted root must not inherit the root's
  // classification; the bytes answered from are not bound by anything admitted.
  for (const { root } of ordered) {
    if (within(root, path) !== undefined) {
      return {
        uri,
        path,
        realpath: resolved,
        classification: "UNBOUND",
        reason: resolved
          ? "path lies inside an admitted root but resolves outside every admitted root"
          : "path lies inside an admitted root but cannot be resolved",
      };
    }
  }

  return { uri, path, realpath: resolved, classification: "UNBOUND", reason: "path lies outside every admitted root" };
}

export function projectionDocumentUri(projection: ProjectionDescriptor, candidatePath: string): string {
  return pathToFileURL(join(projection.execution_root, candidatePath)).toString();
}

export async function removeProjection(projection: ProjectionDescriptor): Promise<void> {
  const directory = dirname(projection.execution_root);
  await makeOwnerWritable(directory);
  await rm(directory, { recursive: true, force: true });
}
