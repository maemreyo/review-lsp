import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { runEntryPointGate } from "./entry-points.js";
import { verifyDerivedWorkspaceArtifact } from "./derived-artifact.js";
import { verifyDependencySnapshot } from "./dependency-snapshot.js";
import { ReviewLspError } from "./errors.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  DerivedWorkspaceArtifactDescriptor,
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

const PROJECTION_IMPLEMENTATION = "review-lsp.projection.v1+copy-source+dependency-facade-relative-workspace-links+derived-artifacts";

interface VerifiedProjectionLease {
  descriptor_binding: string;
  execution_realpath: string;
  execution_dev: number;
  execution_ino: number;
  execution_mode: number;
}

const verifiedProjectionLeases = new Map<string, VerifiedProjectionLease>();

async function projectionLeaseFingerprint(
  projection: ProjectionDescriptor,
): Promise<VerifiedProjectionLease> {
  const [executionRealpath, executionInfo] = await Promise.all([
    realpath(projection.execution_root),
    stat(projection.execution_root),
  ]);
  if (!executionInfo.isDirectory()) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} execution root is not a directory`,
    );
  }
  if ((executionInfo.mode & 0o222) !== 0) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} execution root is not sealed read-only`,
    );
  }
  return {
    descriptor_binding: canonicalJson(projection),
    execution_realpath: executionRealpath,
    execution_dev: executionInfo.dev,
    execution_ino: executionInfo.ino,
    execution_mode: executionInfo.mode,
  };
}

function sameProjectionLease(a: VerifiedProjectionLease, b: VerifiedProjectionLease): boolean {
  return a.descriptor_binding === b.descriptor_binding
    && a.execution_realpath === b.execution_realpath
    && a.execution_dev === b.execution_dev
    && a.execution_ino === b.execution_ino
    && a.execution_mode === b.execution_mode;
}

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
  workspaceManifests: string[],
): Promise<string[]> {
  const mounts: string[] = [];
  const snapshotRoot = await realpath(snapshot.dependency_root);
  const workspaceTargets = new Map<string, string>();

  for (const manifestPath of workspaceManifests) {
    const workspaceRelative = dirname(manifestPath) === "." ? "" : dirname(manifestPath);
    workspaceTargets.set(
      workspaceRelative.split(sep).join("/"),
      workspaceRelative,
    );
  }

  async function linkPackageEntry(source: string, destination: string): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const target = await readlink(source);
      const lexicalTarget = isAbsolute(target)
        ? resolvePath(target)
        : resolvePath(dirname(source), target);
      // Workspace links may point at pruned stubs, so match those lexically against
      // the descriptor path before requiring a resolvable target. Do not mix this with the
      // canonical containment check below: macOS aliases /tmp as /private/tmp.
      const lexicalSnapshotRelative = within(snapshot.dependency_root, lexicalTarget);
      const normalizedWorkspacePath = lexicalSnapshotRelative?.split(sep).join("/");
      const workspaceTarget = normalizedWorkspacePath === undefined
        ? undefined
        : workspaceTargets.get(normalizedWorkspacePath);
      if (workspaceTarget !== undefined) {
        // Keep workspace links internal to the projection and relative so atomic rename of the
        // staging projection cannot strand them on the old .staging-* absolute path.
        const projectionPackage = workspaceTarget
          ? join(executionRoot, workspaceTarget)
          : executionRoot;
        const relativeTarget = relative(dirname(destination), projectionPackage) || ".";
        await symlink(relativeTarget, destination);
        return;
      }

      // External package links must resolve now and their canonical target must remain in the
      // sealed snapshot. This catches true escapes while accepting /tmp -> /private/tmp aliases.
      const resolved = await realpath(source).catch(() => null);
      if (!resolved || within(snapshotRoot, resolved) === undefined) {
        throw new ReviewLspError(
          "PROJECTION_INVALID",
          `dependency symlink ${source} escapes admitted snapshot and is not an admitted workspace link`,
        );
      }
      await symlink(source, destination);
      return;
    }
    // pnpm uses scope directories containing package symlinks. Recreate only that shallow
    // namespace so workspace links can be rebound individually; opaque package/store
    // directories remain sealed snapshot-backed.
    if (info.isDirectory() && !info.isSymbolicLink() && source.split(sep).at(-1)?.startsWith("@")) {
      await mkdir(destination, { recursive: true });
      for (const child of (await readdir(source)).sort()) {
        await linkPackageEntry(join(source, child), join(destination, child));
      }
      return;
    }
    await symlink(source, destination);
  }

  async function materializeNodeModulesFacade(sourceNodeModules: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(sourceNodeModules)).sort()) {
      await linkPackageEntry(join(sourceNodeModules, name), join(destination, name));
    }
  }

  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(snapshot.dependency_root, relativePath) : snapshot.dependency_root;
    for (const name of await readdir(absolute)) {
      const childRelative = relativePath ? join(relativePath, name) : name;
      if (name === "node_modules") {
        const sourceNodeModules = join(snapshot.dependency_root, childRelative);
        const sourceReal = await realpath(sourceNodeModules);
        if (within(snapshotRoot, sourceReal) === undefined) {
          throw new ReviewLspError("PROJECTION_INVALID", `dependency mount escapes admitted snapshot: ${childRelative}`);
        }
        const destination = join(executionRoot, childRelative);
        await mkdir(dirname(destination), { recursive: true });
        await rm(destination, { recursive: true, force: true }).catch(() => undefined);
        await materializeNodeModulesFacade(sourceNodeModules, destination);
        mounts.push(childRelative);
        continue;
      }
      const info = await lstat(join(absolute, name));
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(childRelative);
    }
  }

  await visit("");
  return mounts.sort();
}

async function linkDerivedArtifacts(
  candidate: CandidateDescriptor,
  snapshot: DependencySnapshotDescriptor | null,
  artifacts: DerivedWorkspaceArtifactDescriptor[],
  executionRoot: string,
  stateDirectory: string,
): Promise<string[]> {
  if (artifacts.length === 0) return [];
  if (!snapshot) {
    throw new ReviewLspError("PROJECTION_INVALID", "derived workspace artifacts require an admitted dependency snapshot");
  }
  const mounts: string[] = [];
  for (const artifact of artifacts) {
    await verifyDerivedWorkspaceArtifact(artifact, {
      candidate,
      snapshot,
      stateDirectory,
    });
    if (!artifact.strong_admission) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `derived artifact ${artifact.artifact_id} is advisory only and cannot satisfy the strong projection gate`,
      );
    }
    const packageRoot = dirname(artifact.package_manifest_path) === "." ? "" : dirname(artifact.package_manifest_path);
    const relativeMount = packageRoot
      ? join(packageRoot, artifact.mount_relative_path)
      : artifact.mount_relative_path;
    const destination = join(executionRoot, relativeMount);
    if (within(executionRoot, destination) === undefined) {
      throw new ReviewLspError("PROJECTION_INVALID", `derived artifact mount escapes projection: ${relativeMount}`);
    }
    const existing = await lstat(destination).catch(() => null);
    if (existing) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `derived artifact ${artifact.artifact_id} would overwrite candidate/projection path ${relativeMount}`,
      );
    }
    await mkdir(dirname(destination), { recursive: true });
    await symlink(artifact.output_root, destination);
    mounts.push(relativeMount);
  }
  return mounts.sort();
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
  /** Strongly admitted derived workspace artifacts to expose at their declared output mounts. */
  derivedArtifacts?: DerivedWorkspaceArtifactDescriptor[];
  /** Workspace manifest paths the entry-point gate must check, relative to the root. */
  workspaceManifests?: string[];
}

function normalizeWorkspaceManifests(paths: string[]): string[] {
  const normalized = paths.map((path) => {
    if (isAbsolute(path)) {
      throw new ReviewLspError("PROJECTION_INVALID", `workspace manifest is absolute: ${path}`);
    }
    const value = normalize(path.split("/").join(sep));
    if (value === ""
      || value === "."
      || value === ".."
      || value.startsWith(`..${sep}`)
      || isAbsolute(value)) {
      throw new ReviewLspError("PROJECTION_INVALID", `workspace manifest escapes candidate authority: ${path}`);
    }
    return value.split(sep).join("/");
  });
  return [...new Set(normalized)].sort();
}

function derivedMountPath(artifact: DerivedWorkspaceArtifactDescriptor): string {
  const packageRoot = dirname(artifact.package_manifest_path) === "." ? "" : dirname(artifact.package_manifest_path);
  return packageRoot
    ? join(packageRoot, artifact.mount_relative_path)
    : artifact.mount_relative_path;
}

function projectionIdentity(input: {
  candidate: CandidateDescriptor;
  snapshot: DependencySnapshotDescriptor | null;
  derivedArtifacts: DerivedWorkspaceArtifactDescriptor[];
  workspaceManifests: string[];
}): string {
  return contentId("proj", {
    schema_version: "review-lsp.projection.v1" as const,
    projection_implementation: PROJECTION_IMPLEMENTATION,
    candidate_id: input.candidate.candidate_id,
    source_manifest_sha256: input.candidate.source_manifest_sha256,
    dependency_snapshot_id: input.snapshot?.snapshot_id ?? null,
    dependency_tree_manifest_sha256: input.snapshot?.tree_manifest_sha256 ?? null,
    derived_artifacts: input.derivedArtifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      output_tree_manifest_sha256: artifact.output_tree_manifest_sha256,
      package_manifest_path: artifact.package_manifest_path,
      mount_relative_path: artifact.mount_relative_path,
    })),
    workspace_manifests: input.workspaceManifests,
    isolation: input.candidate.isolation,
  });
}

async function dependencyMountPaths(snapshot: DependencySnapshotDescriptor | null): Promise<string[]> {
  if (!snapshot) return [];
  const dependencyRoot = snapshot.dependency_root;
  const mounts: string[] = [];
  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(dependencyRoot, relativePath) : dependencyRoot;
    for (const name of (await readdir(absolute)).sort()) {
      const childRelative = relativePath ? join(relativePath, name) : name;
      if (name === "node_modules") {
        mounts.push(childRelative);
        continue;
      }
      const info = await lstat(join(absolute, name));
      if (info.isDirectory() && !info.isSymbolicLink()) await visit(childRelative);
    }
  }
  await visit("");
  return mounts.sort();
}

async function loadDerivedArtifactsForProjection(
  projection: ProjectionDescriptor,
  input: {
    candidate: CandidateDescriptor;
    snapshot: DependencySnapshotDescriptor | null;
    stateDirectory: string;
  },
): Promise<DerivedWorkspaceArtifactDescriptor[]> {
  if (projection.derived_artifact_ids.length === 0) return [];
  if (!input.snapshot) {
    throw new ReviewLspError("PROJECTION_INVALID", "projection declares derived artifacts without a dependency snapshot");
  }

  const artifacts: DerivedWorkspaceArtifactDescriptor[] = [];
  for (const artifactId of projection.derived_artifact_ids) {
    const descriptorPath = join(input.stateDirectory, "derived", artifactId, "derived-artifact.json");
    let artifact: DerivedWorkspaceArtifactDescriptor;
    try {
      artifact = JSON.parse(await readFile(descriptorPath, "utf8")) as DerivedWorkspaceArtifactDescriptor;
    } catch (error) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `projection derived artifact ${artifactId} is not readable: ${(error as Error).message}`,
      );
    }
    await verifyDerivedWorkspaceArtifact(artifact, {
      candidate: input.candidate,
      snapshot: input.snapshot,
      stateDirectory: input.stateDirectory,
    });
    artifacts.push(artifact);
  }
  artifacts.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  return artifacts;
}

/**
 * Rebinds a persisted projection to exact candidate, snapshot, derived-artifact and gate inputs.
 *
 * Projection state is mutable local cache, so a matching projection_id in projection.json is
 * never enough for reuse or semantic execution.
 */
export async function verifyProjectionDescriptor(
  projection: ProjectionDescriptor,
  input: {
    candidate: CandidateDescriptor;
    snapshot: DependencySnapshotDescriptor | null;
    stateDirectory: string;
  },
): Promise<void> {
  if (projection.schema_version !== "review-lsp.projection.v1"
    || projection.projection_implementation !== PROJECTION_IMPLEMENTATION
    || projection.candidate_id !== input.candidate.candidate_id
    || projection.source_manifest_sha256 !== input.candidate.source_manifest_sha256
    || projection.isolation !== input.candidate.isolation) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} is not bound to the exact candidate implementation`,
    );
  }

  if (input.snapshot) {
    await verifyDependencySnapshot(input.snapshot);
    if (projection.dependency_snapshot_id !== input.snapshot.snapshot_id
      || projection.dependency_tree_manifest_sha256 !== input.snapshot.tree_manifest_sha256) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `projection ${projection.projection_id} is not bound to the admitted dependency snapshot`,
      );
    }
  } else if (projection.dependency_snapshot_id !== null
    || projection.dependency_tree_manifest_sha256 !== null) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} declares dependency state without an admitted snapshot`,
    );
  }

  const workspaceManifests = normalizeWorkspaceManifests(projection.workspace_manifests ?? []);
  if (canonicalJson(workspaceManifests) !== canonicalJson(projection.workspace_manifests ?? [])) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} workspace manifest binding is not canonical`,
    );
  }

  const derivedArtifacts = await loadDerivedArtifactsForProjection(projection, input);
  const expectedId = projectionIdentity({
    candidate: input.candidate,
    snapshot: input.snapshot,
    derivedArtifacts,
    workspaceManifests,
  });
  if (expectedId !== projection.projection_id) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} does not match its exact input identity`,
    );
  }

  const expectedExecutionRoot = join(
    projectionDirectory(input.stateDirectory, projection.projection_id),
    "execution",
  );
  const [actualExecutionRoot, canonicalExpectedExecutionRoot] = await Promise.all([
    realpath(projection.execution_root).catch(() => null),
    realpath(expectedExecutionRoot).catch(() => null),
  ]);
  if (!actualExecutionRoot
    || !canonicalExpectedExecutionRoot
    || actualExecutionRoot !== canonicalExpectedExecutionRoot
    || resolvePath(projection.execution_root) !== resolvePath(expectedExecutionRoot)) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} execution root is not its content-addressed publication path`,
    );
  }

  let lease: VerifiedProjectionLease;
  try {
    lease = await projectionLeaseFingerprint(projection);
  } catch (error) {
    if (error instanceof ReviewLspError) throw error;
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} execution identity is not readable: ${(error as Error).message}`,
    );
  }
  const cached = verifiedProjectionLeases.get(projection.projection_id);
  if (cached && sameProjectionLease(cached, lease)) return;

  const expectedDerivedIds = derivedArtifacts.map((artifact) => artifact.artifact_id);
  const expectedDerivedTrees = derivedArtifacts.map((artifact) => artifact.output_tree_manifest_sha256);
  const expectedDerivedRoots = derivedArtifacts.map((artifact) => artifact.output_root);
  const expectedDerivedMounts = derivedArtifacts.map(derivedMountPath).sort();
  if (canonicalJson(projection.derived_artifact_ids) !== canonicalJson(expectedDerivedIds)
    || canonicalJson(projection.derived_artifact_tree_manifests) !== canonicalJson(expectedDerivedTrees)
    || canonicalJson(projection.derived_artifact_roots) !== canonicalJson(expectedDerivedRoots)
    || canonicalJson(projection.derived_artifact_mounts) !== canonicalJson(expectedDerivedMounts)) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} derived-artifact bindings changed after publication`,
    );
  }

  const expectedDependencyMounts = await dependencyMountPaths(input.snapshot);
  if (canonicalJson(projection.dependency_mounts) !== canonicalJson(expectedDependencyMounts)) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} dependency mount binding changed after publication`,
    );
  }

  await verifyProjectionSource(projection, input.candidate);

  for (const artifact of derivedArtifacts) {
    const mount = join(projection.execution_root, derivedMountPath(artifact));
    const [mountedRoot, artifactRoot] = await Promise.all([
      realpath(mount).catch(() => null),
      realpath(artifact.output_root).catch(() => null),
    ]);
    if (!mountedRoot || !artifactRoot || mountedRoot !== artifactRoot) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `projection derived mount for ${artifact.artifact_id} no longer resolves to its admitted artifact`,
      );
    }
  }

  for (const mount of expectedDependencyMounts) {
    const info = await lstat(join(projection.execution_root, mount)).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        `projection dependency mount ${mount} is missing or no longer a directory facade`,
      );
    }
  }

  const gate = await runEntryPointGate({
    projectionRoot: projection.execution_root,
    workspaceManifests,
    readManifest: (relativePath) => readFile(join(projection.execution_root, relativePath), "utf8"),
  });
  if (canonicalJson(gate) !== canonicalJson(projection.entry_point_gate)) {
    throw new ReviewLspError(
      "PROJECTION_INVALID",
      `projection ${projection.projection_id} entry-point gate changed after publication`,
    );
  }

  verifiedProjectionLeases.set(projection.projection_id, lease);
}

export async function buildProjection(options: BuildProjectionOptions): Promise<ProjectionDescriptor> {
  const { candidate, snapshot, stateDirectory } = options;
  const derivedArtifacts = [...(options.derivedArtifacts ?? [])]
    .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  const workspaceManifests = normalizeWorkspaceManifests(options.workspaceManifests ?? []);

  const projectionId = projectionIdentity({
    candidate,
    snapshot,
    derivedArtifacts,
    workspaceManifests,
  });

  const directory = projectionDirectory(stateDirectory, projectionId);
  const executionRoot = join(directory, "execution");

  try {
    const existing = JSON.parse(await readFile(join(directory, "projection.json"), "utf8")) as ProjectionDescriptor;
    if (existing.projection_id === projectionId) {
      await verifyProjectionDescriptor(existing, { candidate, snapshot, stateDirectory });
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(join(stateDirectory, "projections"), { recursive: true, mode: 0o700 });
  const staging = join(stateDirectory, "projections", `.staging-${process.pid}-${randomUUID()}`);
  const stagingExecution = join(staging, "execution");
  await mkdir(stagingExecution, { recursive: true, mode: 0o700 });

  try {
    await writeCandidateSource(candidate, stagingExecution);
    const mounts = snapshot
      ? await linkDependencies(snapshot, stagingExecution, workspaceManifests)
      : [];
    const derivedMounts = await linkDerivedArtifacts(
      candidate,
      snapshot,
      derivedArtifacts,
      stagingExecution,
      stateDirectory,
    );

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
      derived_artifact_ids: derivedArtifacts.map((artifact) => artifact.artifact_id),
      derived_artifact_tree_manifests: derivedArtifacts.map((artifact) => artifact.output_tree_manifest_sha256),
      isolation: candidate.isolation,
      execution_root: executionRoot,
      dependency_mounts: mounts,
      derived_artifact_mounts: derivedMounts,
      derived_artifact_roots: derivedArtifacts.map((artifact) => artifact.output_root),
      workspace_manifests: workspaceManifests,
      entry_point_gate: gate,
      created_at: new Date().toISOString(),
    };

    await writeFile(join(staging, "projection.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await sealProjection(stagingExecution);
    await rename(staging, directory);
    await verifyProjectionDescriptor(descriptor, { candidate, snapshot, stateDirectory });
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
