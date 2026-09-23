import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  buildProjection,
  createTypeScriptProfile,
  dependencySnapshotDescriptorPath,
  deriveDependencyInputs,
  prepareCandidate,
  publishDependencySnapshot,
  removeCandidate,
  removeDependencySnapshot,
  removeProjection,
  resolveProjectForDocument,
  scanDependencyTree,
  SemanticRuntimeManager,
  verifyDependencySnapshot,
} from "../dist/src/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "review-lsp-benchmark-"));
const repo = join(root, "repo");
const state = join(root, "state");
let candidate;
let semanticCandidate;
let snapshot;
let projection;
let manager;

async function run(command, args, options = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
    env: options.env ?? process.env,
  });
  return stdout.trim();
}

async function git(...args) {
  return run("git", ["-C", repo, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Review-LSP Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Review-LSP Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[index]);
}

function summary(values) {
  return {
    samples: values.length,
    min_ms: percentile(values, 0),
    median_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: percentile(values, 100),
  };
}

async function makeWritable(rootPath) {
  const info = await lstat(rootPath).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(rootPath, 0o700).catch(() => undefined);
    for (const name of await readdir(rootPath)) await makeWritable(join(rootPath, name));
    return;
  }
  await chmod(rootPath, 0o600).catch(() => undefined);
}

async function diskBytes(path) {
  try {
    const output = await run("du", ["-sk", path]);
    const kb = Number(output.trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

async function publishSyntheticAcquiredTree(inputs, profile) {
  const acquiredRoot = join(state, "dependency-acquisition", "materialized", inputs.input_set_id);
  const dependencyRoot = join(acquiredRoot, "dependencies");
  await mkdir(join(dependencyRoot, "node_modules"), { recursive: true });
  await cp(profile.typescript_root, join(dependencyRoot, "node_modules", "typescript"), {
    recursive: true,
    verbatimSymlinks: true,
  });

  const scan = await scanDependencyTree(dependencyRoot);
  await writeFile(join(acquiredRoot, "acquired-tree.json"), JSON.stringify({
    schema_version: "review-lsp.acquired-dependency-tree.v1",
    input_set_id: inputs.input_set_id,
    dependency_root: dependencyRoot,
    tree_manifest_sha256: scan.tree_manifest_sha256,
    file_count: scan.file_count,
    symlink_count: scan.symlink_count,
    total_bytes: scan.total_bytes,
    materialization_method: "pnpm-install-clone-or-copy",
    created_at: new Date().toISOString(),
  }, null, 2) + "\n");
  return scan;
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", "--object-format=sha1", repo]);

  const profile = await createTypeScriptProfile();
  const packageVersion = JSON.parse(await readFile("package.json", "utf8")).version;

  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "review-lsp-benchmark-fixture",
    private: true,
    type: "module",
    packageManager: "pnpm@10.20.0",
    devDependencies: { typescript: profile.typescript_version },
  }, null, 2) + "\n");
  await writeFile(join(repo, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      typescript:",
    `        specifier: ${profile.typescript_version}`,
    `        version: ${profile.typescript_version}`,
    "",
  ].join("\n"));
  await writeFile(join(repo, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    files: ["src/main.ts", "src/value.ts"],
  }, null, 2) + "\n");
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "benchmark";\n');
  await writeFile(
    join(repo, "src", "main.ts"),
    'import { value } from "./value";\n'
      + "export const result = value;\n",
  );

  const fixtureFiles = 520;
  const padding = "x".repeat(900);
  for (let index = 0; index < fixtureFiles; index += 1) {
    const bucket = String(index % 20).padStart(2, "0");
    const directory = join(repo, "fixture", bucket);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `module-${String(index).padStart(4, "0")}.ts`),
      `export const fixtureValue${index} = ${index};\n// ${padding}\n`,
    );
  }

  await git("add", "-A");
  await git("commit", "-qm", "benchmark candidate");
  const commit = await git("rev-parse", "HEAD");

  const candidateMetrics = {};
  const coldPrepareStart = performance.now();
  candidate = await prepareCandidate({
    repo,
    commit,
    stateDirectory: state,
    metrics: candidateMetrics,
  });
  const coldPrepareMs = performance.now() - coldPrepareStart;

  const warmMetrics = {};
  const warmPrepareStart = performance.now();
  const warmCandidate = await prepareCandidate({
    repo,
    commit,
    stateDirectory: state,
    metrics: warmMetrics,
  });
  const warmPrepareMs = performance.now() - warmPrepareStart;
  if (warmCandidate.candidate_id !== candidate.candidate_id) {
    throw new Error("warm candidate lookup changed candidate identity");
  }

  const inputs = await deriveDependencyInputs(candidate);
  const acquiredScan = await publishSyntheticAcquiredTree(inputs, profile);

  const coldSnapshotStart = performance.now();
  snapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
  const coldSnapshotMs = performance.now() - coldSnapshotStart;

  const warmSnapshotStart = performance.now();
  const warmSnapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
  const warmSnapshotMs = performance.now() - warmSnapshotStart;
  if (warmSnapshot.snapshot_id !== snapshot.snapshot_id) {
    throw new Error("warm dependency snapshot reuse changed snapshot identity");
  }

  const warmVerificationStart = performance.now();
  await verifyDependencySnapshot(snapshot);
  const warmVerificationMs = performance.now() - warmVerificationStart;

  const descriptorPath = dependencySnapshotDescriptorPath(state, snapshot.snapshot_id);
  const childVerification = JSON.parse(await run(process.execPath, [
    "scripts/benchmark-verify-snapshot.mjs",
    descriptorPath,
  ]));

  // Query lifecycle is benchmarked on a small second candidate with exactly the same
  // dependency inputs. Candidate preparation remains the realistic hundreds-file fixture above.
  await rm(join(repo, "fixture"), { recursive: true, force: true });
  await git("add", "-A");
  await git("commit", "-qm", "small semantic benchmark candidate");
  const semanticCommit = await git("rev-parse", "HEAD");
  semanticCandidate = await prepareCandidate({
    repo,
    commit: semanticCommit,
    stateDirectory: state,
  });
  const semanticInputs = await deriveDependencyInputs(semanticCandidate);
  if (semanticInputs.input_set_id !== inputs.input_set_id) {
    throw new Error("semantic benchmark changed dependency inputs and cannot reuse the admitted snapshot");
  }

  const projectionStart = performance.now();
  projection = await buildProjection({
    candidate: semanticCandidate,
    snapshot,
    stateDirectory: state,
    workspaceManifests: [],
  });
  const projectionMs = performance.now() - projectionStart;

  const resolvingProject = await resolveProjectForDocument(semanticCandidate, "src/main.ts");
  manager = new SemanticRuntimeManager({ idleTtlMs: 60_000, maxRuntimes: 4 });

  const firstSemanticStart = performance.now();
  const acquireStart = performance.now();
  const firstLease = await manager.acquire({
    candidate: semanticCandidate,
    profile,
    stateDirectory: state,
    projection,
    snapshot,
    resolvingProject,
  });
  const semanticServerStartMs = performance.now() - acquireStart;
  const character = "export const result = ".length;
  const firstHoverStart = performance.now();
  const firstHover = await firstLease.session.hover({ path: "src/main.ts", line: 1, character });
  const firstHoverMs = performance.now() - firstHoverStart;
  const firstSemanticResponseMs = performance.now() - firstSemanticStart;
  if (firstHover.environment_binding !== "VERIFIED") {
    throw new Error(`benchmark first hover was not VERIFIED: ${firstHover.environment_binding}`);
  }

  const warmHovers = [];
  const warmDefinitions = [];
  for (let index = 0; index < 5; index += 1) {
    let started = performance.now();
    await firstLease.session.hover({ path: "src/main.ts", line: 1, character });
    warmHovers.push(performance.now() - started);

    started = performance.now();
    await firstLease.session.definition({ path: "src/main.ts", line: 1, character });
    warmDefinitions.push(performance.now() - started);
  }

  const concurrentAcquireStart = performance.now();
  const concurrentLeases = await Promise.all(Array.from({ length: 4 }, () => manager.acquire({
    candidate: semanticCandidate,
    profile,
    stateDirectory: state,
    projection,
    snapshot,
    resolvingProject,
  })));
  const concurrentAcquireMs = performance.now() - concurrentAcquireStart;
  const keyIds = new Set([firstLease.key_id, ...concurrentLeases.map((lease) => lease.key_id)]);
  if (keyIds.size !== 1 || manager.liveRuntimeCount !== 1) {
    throw new Error("concurrent benchmark did not reuse exactly one semantic runtime");
  }
  const concurrentQueryStart = performance.now();
  await Promise.all(concurrentLeases.map((lease) =>
    lease.session.hover({ path: "src/main.ts", line: 1, character })));
  const concurrentQueryMs = performance.now() - concurrentQueryStart;

  for (const lease of concurrentLeases) lease.release();
  firstLease.release();

  const candidateTrackedBytes = candidate.entries.reduce((total, entry) => total + entry.byte_count, 0);
  const physicalBytes = await diskBytes(snapshot.dependency_root);

  process.stdout.write(JSON.stringify({
    schema: "review-lsp.benchmark.v2",
    package_version: packageVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    fixture: {
      tracked_entry_count: candidate.entries.length,
      tracked_bytes: candidateTrackedBytes,
      synthetic_fixture_files: fixtureFiles,
    },
    candidate_preparation: {
      cold_total_ms: round(coldPrepareMs),
      warm_lookup_total_ms: round(warmPrepareMs),
      git_enumeration_ms: round(candidateMetrics.git_enumeration_ms ?? 0),
      git_object_read_ms: round(candidateMetrics.git_object_read_ms ?? 0),
      materialization_ms: round(candidateMetrics.materialization_ms ?? 0),
      integrity_verification_ms: round(candidateMetrics.integrity_verification_ms ?? 0),
      initial_retained_lookup_ms: round(candidateMetrics.retained_lookup_ms ?? 0),
      warm_retained_lookup_and_verify_ms: round(warmMetrics.retained_lookup_ms ?? 0),
    },
    dependency_snapshot: {
      cold_materialization_ms: round(coldSnapshotMs),
      warm_reuse_ms: round(warmSnapshotMs),
      cold_process_verification_ms: round(childVerification.verification_ms),
      warm_process_verification_ms: round(warmVerificationMs),
      logical_bytes: snapshot.total_bytes,
      physical_bytes: physicalBytes,
      file_count: snapshot.file_count,
      symlink_count: snapshot.symlink_count,
      escaped_symlink_count: 0,
      source_acquired_file_count: acquiredScan.file_count,
      source_acquired_symlink_count: acquiredScan.symlink_count,
      materialization_method: snapshot.materialization_method,
      filesystem_class: snapshot.materialization_method.includes("copy") ? "copy-path" : "clone-or-reflink-path",
      note: "escaped symlink count is zero because scanDependencyTree fail-closes before snapshot admission",
    },
    projection: {
      cold_build_ms: round(projectionMs),
      projection_id: projection.projection_id,
    },
    query_lifecycle: {
      query_candidate_entry_count: semanticCandidate.entries.length,
      semantic_server_start_ms: round(semanticServerStartMs),
      first_hover_ms: round(firstHoverMs),
      first_semantic_response_ms: round(firstSemanticResponseMs),
      warm_hover: summary(warmHovers),
      warm_definition: summary(warmDefinitions),
      concurrent_acquire_4_ms: round(concurrentAcquireMs),
      concurrent_hover_4_ms: round(concurrentQueryMs),
      runtime_key_id: firstLease.key_id,
      distinct_runtime_keys_for_concurrent_reuse: keyIds.size,
      live_runtime_count_during_concurrent_reuse: 1,
    },
    semantics:
      "observational release evidence; metrics are reported by materialization class and do not weaken integrity or VERIFIED requirements",
  }, null, 2) + "\n");
} finally {
  await manager?.dispose().catch(() => undefined);
  if (projection) await removeProjection(projection).catch(() => undefined);
  if (snapshot) {
    await makeWritable(dirname(snapshot.dependency_root)).catch(() => undefined);
    await removeDependencySnapshot(snapshot).catch(() => undefined);
  }
  if (semanticCandidate) await removeCandidate(semanticCandidate).catch(() => undefined);
  if (candidate) await removeCandidate(candidate).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
