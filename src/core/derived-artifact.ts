import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";

import { readCandidateFile } from "./candidate.js";
import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { scanDependencyTree } from "./dependency-tree.js";
import { admitEngineArtifact, buildMacSandboxPolicy, resolveExecutionProfile } from "./engine-isolation.js";
import { ReviewLspError } from "./errors.js";
import type {
  AdmittedEngineArtifact,
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  DerivedWorkspaceArtifactDescriptor,
  EntryPointGateResult,
  ProjectionDescriptor,
} from "./types.js";

const COMPILER_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 1_000_000;
const DERIVED_POLICY_TEMPLATE_ROOT = "/__review_lsp_derived_policy_v1__";

interface VerifiedDerivedLease {
  descriptor_binding: string;
  output_realpath: string;
  output_dev: number;
  output_ino: number;
  output_mode: number;
}

const verifiedDerivedLeases = new Map<string, VerifiedDerivedLease>();

async function derivedLeaseFingerprint(
  artifact: DerivedWorkspaceArtifactDescriptor,
): Promise<VerifiedDerivedLease> {
  const [outputRealpath, outputInfo] = await Promise.all([
    realpath(artifact.output_root),
    stat(artifact.output_root),
  ]);
  if (!outputInfo.isDirectory()) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} output root is not a directory`,
    );
  }
  if ((outputInfo.mode & 0o222) !== 0) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} output root is not sealed read-only`,
    );
  }
  return {
    descriptor_binding: canonicalJson(artifact),
    output_realpath: outputRealpath,
    output_dev: outputInfo.dev,
    output_ino: outputInfo.ino,
    output_mode: outputInfo.mode,
  };
}

function sameDerivedLease(a: VerifiedDerivedLease, b: VerifiedDerivedLease): boolean {
  return a.descriptor_binding === b.descriptor_binding
    && a.output_realpath === b.output_realpath
    && a.output_dev === b.output_dev
    && a.output_ino === b.output_ino
    && a.output_mode === b.output_mode;
}

function compilerArgvBinding(projectConfigPath: string): string[] {
  return [
    "<ADMITTED_NODE>",
    "<ADMITTED_TSC>",
    "-p",
    projectConfigPath,
    "--outDir",
    "<DERIVED_OUTPUT>",
    "--pretty",
    "false",
  ];
}

async function stableDerivedExecutionProfileBinding(): Promise<string> {
  const policy = await buildMacSandboxPolicy({
    readRoots: [
      join(DERIVED_POLICY_TEMPLATE_ROOT, "candidate"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "snapshot"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "prior-derived"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "engine"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "node"),
    ],
    writableRoots: [
      join(DERIVED_POLICY_TEMPLATE_ROOT, "output"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "home"),
      join(DERIVED_POLICY_TEMPLATE_ROOT, "tmp"),
    ],
  });
  const sandboxExecutableSha256 = sha256(await readFile("/usr/bin/sandbox-exec"));
  return `review-lsp.derived-execution.v1:${sha256(policy.policy)}:sandbox-exec:${sandboxExecutableSha256}`;
}

function derivedArtifactIdentityMaterial(artifact: DerivedWorkspaceArtifactDescriptor) {
  return {
    candidate_id: artifact.candidate_id,
    source_manifest_sha256: artifact.source_manifest_sha256,
    dependency_snapshot_id: artifact.dependency_snapshot_id,
    package_manifest_path: artifact.package_manifest_path,
    package_name: artifact.package_name,
    project_config_path: artifact.project_config_path,
    project_config_sha256: artifact.project_config_sha256,
    config_chain: artifact.config_chain,
    compiler_artifact_id: artifact.compiler_artifact_id,
    compiler_version: artifact.compiler_version,
    compiler_entrypoint_sha256: artifact.compiler_entrypoint_sha256,
    node_executable_sha256: artifact.node_executable_sha256,
    fixed_compiler_argv: compilerArgvBinding(artifact.project_config_path),
    mount_relative_path: artifact.mount_relative_path,
    execution_profile_kind: artifact.execution_profile_kind,
    execution_profile_binding: artifact.execution_profile_binding,
    compiler_exit_code: artifact.compiler_exit_code,
    diagnostic_error_count: artifact.diagnostic_error_count,
    stdout_sha256: artifact.stdout_sha256,
    stderr_sha256: artifact.stderr_sha256,
    output_tree_manifest_sha256: artifact.output_tree_manifest_sha256,
    output_file_count: artifact.output_file_count,
    output_total_bytes: artifact.output_total_bytes,
    strong_admission: artifact.strong_admission,
    limitation: artifact.limitation,
  };
}

interface DerivationIndexRecord {
  schema_version: "review-lsp.derived-index.v1";
  derivation_key: string;
  artifact_id: string;
}

interface PackageManifest {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
}

interface StrictBuildRecipe {
  package_manifest_path: string;
  package_root: string;
  package_name: string | null;
  project_config_path: string;
  project_config_sha256: string;
  config_chain: Array<{ path: string; sha256: string }>;
  mount_relative_path: string;
}

function inside(root: string, path: string): boolean {
  const delta = relative(root, path);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`));
}

function candidateRelativeJoin(baseRelative: string, requested: string, label: string): string {
  if (isAbsolute(requested)) {
    throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `${label} is absolute and escapes candidate authority`);
  }
  const combined = normalize(join(baseRelative || ".", requested));
  if (combined === ""
    || combined === "."
    || combined === ".."
    || combined.startsWith(`..${sep}`)
    || isAbsolute(combined)) {
    throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `${label} escapes candidate authority`);
  }
  return combined.split(sep).join("/");
}

async function candidateJson<T>(candidate: CandidateDescriptor, path: string): Promise<{ value: T; sha256: string }> {
  const file = await readCandidateFile(candidate, path);
  try {
    return { value: JSON.parse(file.bytes.toString("utf8")) as T, sha256: file.sha256 };
  } catch (error) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${path} is not strict JSON and is outside the first constrained derived-artifact provider: ${(error as Error).message}`,
    );
  }
}

async function admitConfigChain(
  candidate: CandidateDescriptor,
  configPath: string,
  seen = new Set<string>(),
): Promise<Array<{ path: string; sha256: string }>> {
  if (seen.has(configPath)) {
    throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `tsconfig extends cycle at ${configPath}`);
  }
  seen.add(configPath);
  const config = await candidateJson<{ extends?: unknown }>(candidate, configPath);
  const chain = [{ path: configPath, sha256: config.sha256 }];
  if (config.value.extends === undefined) return chain;
  if (typeof config.value.extends !== "string" || !config.value.extends.startsWith(".")) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${configPath} extends an external/non-relative config; the narrow provider only admits candidate-relative extends chains`,
    );
  }
  const relativeBase = candidateRelativeJoin(
    dirname(configPath) === "." ? "" : dirname(configPath),
    config.value.extends,
    `${configPath} extends target`,
  );
  const relativeConfig = extname(relativeBase) ? relativeBase : `${relativeBase}.json`;
  return [...chain, ...(await admitConfigChain(candidate, relativeConfig, seen))];
}

async function strictRecipe(candidate: CandidateDescriptor, manifestPath: string): Promise<StrictBuildRecipe> {
  const manifest = await candidateJson<PackageManifest>(candidate, manifestPath);
  const scripts = manifest.value.scripts;
  const build = scripts && typeof scripts === "object" && !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>).build
    : undefined;
  if (typeof build !== "string") {
    throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `${manifestPath} has no plain TypeScript build recipe`);
  }
  const match = /^tsc\s+-p\s+([A-Za-z0-9._/-]+)$/.exec(build.trim());
  if (!match?.[1]) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${manifestPath} build recipe is not the allowlisted plain form "tsc -p <config>"`,
    );
  }

  const packageRoot = dirname(manifestPath) === "." ? "" : dirname(manifestPath);
  const packageAbsolute = resolvePath("/", packageRoot);
  const projectConfigPath = candidateRelativeJoin(
    packageRoot,
    match[1],
    `${manifestPath} build config`,
  );
  const configAbsolute = resolvePath("/", projectConfigPath);
  if (!inside(packageAbsolute, configAbsolute)) {
    throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `${manifestPath} build config escapes its workspace package`);
  }
  const config = await candidateJson<{
    compilerOptions?: { outDir?: unknown; declarationDir?: unknown };
  }>(candidate, projectConfigPath);
  const outDir = config.value.compilerOptions?.outDir;
  if (typeof outDir !== "string" || outDir.length === 0) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${projectConfigPath} must declare an explicit compilerOptions.outDir for constrained derivation`,
    );
  }
  if (config.value.compilerOptions?.declarationDir !== undefined) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${projectConfigPath} uses declarationDir; split output roots are not supported by the first constrained provider`,
    );
  }

  // Preserve lexical traversal before projecting candidate-relative paths onto the
  // synthetic "/" namespace. resolve("/", "../escaped") would otherwise collapse the
  // traversal into "/escaped" and make a root-package escape look like a child of "/".
  const outCandidateRelative = normalize(join(dirname(projectConfigPath), outDir));
  if (isAbsolute(outCandidateRelative)
    || outCandidateRelative === ".."
    || outCandidateRelative.startsWith(`..${sep}`)) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${projectConfigPath} outDir escapes the candidate root`,
    );
  }
  const normalizedPackageRoot = packageRoot.split("/").join(sep);
  if (normalizedPackageRoot
    && outCandidateRelative !== normalizedPackageRoot
    && !outCandidateRelative.startsWith(`${normalizedPackageRoot}${sep}`)) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${projectConfigPath} outDir must stay inside its workspace package`,
    );
  }

  const outAbsolute = resolvePath("/", outCandidateRelative);
  if (outAbsolute === packageAbsolute) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${projectConfigPath} outDir must be a contained subdirectory of the workspace package`,
    );
  }

  return {
    package_manifest_path: manifestPath,
    package_root: packageRoot,
    package_name: typeof manifest.value.name === "string" ? manifest.value.name : null,
    project_config_path: projectConfigPath,
    project_config_sha256: config.sha256,
    config_chain: await admitConfigChain(candidate, projectConfigPath),
    mount_relative_path: relative(packageAbsolute, outAbsolute),
  };
}

function dependencyNames(manifest: PackageManifest): string[] {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const section = manifest[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const name of Object.keys(section as Record<string, unknown>)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Orders only packages whose current entry-point gate is incomplete. Workspace dependencies
 * among that set are derived first. Cycles fail closed rather than invoking a package manager
 * or a custom build orchestrator.
 */
export async function planWorkspaceDerivations(input: {
  candidate: CandidateDescriptor;
  workspaceManifests: string[];
  gate: EntryPointGateResult;
}): Promise<string[]> {
  const relevant = new Set(input.gate.findings.map((finding) => finding.manifest_path));
  if (relevant.size === 0) return [];

  const byName = new Map<string, string>();
  const manifests = new Map<string, PackageManifest>();
  for (const path of input.workspaceManifests) {
    const parsed = await candidateJson<PackageManifest>(input.candidate, path);
    manifests.set(path, parsed.value);
    if (typeof parsed.value.name === "string") byName.set(parsed.value.name, path);
  }

  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    if (visiting.has(path)) {
      throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `workspace derivation dependency cycle includes ${path}`);
    }
    visiting.add(path);
    const manifest = manifests.get(path);
    if (!manifest) {
      throw new ReviewLspError("DERIVED_ARTIFACT_UNSUPPORTED", `workspace manifest ${path} is not admitted`);
    }
    for (const name of dependencyNames(manifest)) {
      const dependencyPath = byName.get(name);
      if (dependencyPath && relevant.has(dependencyPath)) visit(dependencyPath);
    }
    visiting.delete(path);
    visited.add(path);
    ordered.push(path);
  };

  for (const path of [...relevant].sort()) visit(path);
  return ordered;
}

function isolatedCompilerEnvironment(home: string, tmp: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    NO_PROXY: "*",
    no_proxy: "*",
    CI: "1",
    LANG: "C.UTF-8",
  };
}

async function runCompiler(input: {
  nodeExecutable: string;
  compilerPath: string;
  configPath: string;
  outputRoot: string;
  cwd: string;
  policy: string;
  home: string;
  tmp: string;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const args = [
    "-p",
    input.policy,
    input.nodeExecutable,
    input.compilerPath,
    "-p",
    input.configPath,
    "--outDir",
    input.outputRoot,
    "--pretty",
    "false",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sandbox-exec", args, {
      cwd: input.cwd,
      env: isolatedCompilerEnvironment(input.home, input.tmp),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const collect = (current: string, chunk: Buffer): string =>
      current.length >= OUTPUT_LIMIT_BYTES
        ? current
        : `${current}${chunk.toString("utf8")}`.slice(0, OUTPUT_LIMIT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, COMPILER_TIMEOUT_MS);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ReviewLspError("DERIVED_ARTIFACT_FAILED", `candidate compiler failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

async function sealTree(root: string): Promise<void> {
  const info = await stat(root);
  if (info.isDirectory()) {
    for (const name of await readdir(root)) await sealTree(join(root, name));
    await chmod(root, 0o500);
    return;
  }
  await chmod(root, (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
}

async function makeTreeOwnerWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700).catch(() => undefined);
    for (const name of await readdir(root)) await makeTreeOwnerWritable(join(root, name));
    return;
  }
  await chmod(root, 0o600).catch(() => undefined);
}

function diagnosticErrorCount(code: number | null, stdout: string, stderr: string): number | null {
  if (code === 0) return 0;
  const matches = `${stdout}\n${stderr}`.match(/error TS\d+:/g);
  return matches && matches.length > 0 ? matches.length : null;
}

async function publishDerivationIndex(path: string, record: DerivationIndexRecord): Promise<void> {
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(path, payload, { mode: 0o400, flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `existing derivation index cannot be read: ${(error as Error).message}`,
    );
  }
  if (canonicalJson(existing) !== canonicalJson(record)) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `existing derivation index ${record.derivation_key} points to different artifact state`,
    );
  }
}

export async function deriveWorkspaceArtifact(input: {
  candidate: CandidateDescriptor;
  snapshot: DependencySnapshotDescriptor;
  projection: ProjectionDescriptor;
  manifestPath: string;
  stateDirectory: string;
}): Promise<DerivedWorkspaceArtifactDescriptor> {
  const recipe = await strictRecipe(input.candidate, input.manifestPath);
  const engine = await admitEngineArtifact({
    snapshot: input.snapshot,
    projectRoot: recipe.package_root,
  });
  if (!engine) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_UNSUPPORTED",
      `${input.manifestPath} has no admitted candidate TypeScript compiler artifact`,
    );
  }
  // Semantic transport kind and compiler capability are independent. TypeScript 7 uses
  // the native LSP transport, but its admitted package still owns lib/tsc.js. Derived builds
  // bind and execute that exact compiler entrypoint, so NATIVE_LSP does not make compilation
  // less exact than TSSERVER_LEGACY.
  const compilerPath = join(engine.engine_root, "lib", "tsc.js");
  const compilerBytes = await readFile(compilerPath).catch(() => null);
  if (!compilerBytes) {
    throw new ReviewLspError("DERIVED_ARTIFACT_INVALID", `admitted engine lacks compiler entrypoint ${compilerPath}`);
  }
  const nodeExecutable = await realpath(process.execPath);
  const nodeExecutableSha256 = sha256(await readFile(nodeExecutable));

  const derivationKey = contentId("derive", {
    candidate_id: input.candidate.candidate_id,
    source_manifest_sha256: input.candidate.source_manifest_sha256,
    dependency_snapshot_id: input.snapshot.snapshot_id,
    projection_id: input.projection.projection_id,
    package_manifest_path: recipe.package_manifest_path,
    project_config_path: recipe.project_config_path,
    project_config_sha256: recipe.project_config_sha256,
    config_chain: recipe.config_chain,
    compiler_artifact_id: engine.artifact_id,
    compiler_entrypoint_sha256: sha256(compilerBytes),
    mount_relative_path: recipe.mount_relative_path,
  });
  const derivedRoot = join(input.stateDirectory, "derived");
  const derivationIndexRoot = join(derivedRoot, "by-derivation");
  await Promise.all([
    mkdir(derivedRoot, { recursive: true, mode: 0o700 }),
    mkdir(derivationIndexRoot, { recursive: true, mode: 0o700 }),
  ]);

  const indexPath = join(derivationIndexRoot, `${derivationKey}.json`);
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as DerivationIndexRecord;
    if (index.schema_version !== "review-lsp.derived-index.v1"
      || index.derivation_key !== derivationKey
      || !/^derived_[0-9a-f]{32}$/.test(index.artifact_id)) {
      throw new ReviewLspError(
        "DERIVED_ARTIFACT_INVALID",
        `derived cache index ${derivationKey} is malformed or bound to different inputs`,
      );
    }
    const existing = JSON.parse(
      await readFile(join(derivedRoot, index.artifact_id, "derived-artifact.json"), "utf8"),
    ) as DerivedWorkspaceArtifactDescriptor;
    await verifyDerivedWorkspaceArtifact(existing, {
      candidate: input.candidate,
      snapshot: input.snapshot,
      stateDirectory: input.stateDirectory,
    });
    if (!existing.strong_admission) {
      throw new ReviewLspError(
        "DERIVED_ARTIFACT_INVALID",
        `derived cache index ${derivationKey} points to an advisory artifact`,
      );
    }
    return existing;
  } catch (error) {
    if (error instanceof ReviewLspError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ReviewLspError(
        "DERIVED_ARTIFACT_INVALID",
        `derived cache index ${derivationKey} cannot be read: ${(error as Error).message}`,
      );
    }
  }

  const stagingRoot = join(derivedRoot, `.staging-${derivationKey}-${process.pid}-${randomUUID()}`);
  const outputRoot = join(stagingRoot, "output");
  const home = join(stagingRoot, "home");
  const tmp = join(stagingRoot, "tmp");
  await Promise.all([
    mkdir(outputRoot, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(tmp, { recursive: true, mode: 0o700 }),
  ]);

  try {
    const readRoots = [
      input.projection.execution_root,
      input.snapshot.dependency_root,
      ...input.projection.derived_artifact_roots,
      engine.engine_root,
      ...(engine.native_runtime ? [engine.native_runtime.root] : []),
      dirname(nodeExecutable),
    ];
    const writableRoots = [outputRoot, home, tmp];
    const executionProfile = await resolveExecutionProfile({ readRoots, writableRoots });
    if (!executionProfile.enforced || executionProfile.kind !== "MACOS_SANDBOX") {
      throw new ReviewLspError(
        "DERIVED_ARTIFACT_UNSUPPORTED",
        executionProfile.reason ?? "no enforced compiler isolation profile is available",
      );
    }
    const sandbox = await buildMacSandboxPolicy({ readRoots, writableRoots });
    if (!executionProfile.identity.startsWith(sandbox.identity)) {
      throw new ReviewLspError("DERIVED_ARTIFACT_INVALID", "compiler sandbox policy does not match the admitted execution profile");
    }

    const configInProjection = join(input.projection.execution_root, recipe.project_config_path);
    const packageInProjection = recipe.package_root
      ? join(input.projection.execution_root, recipe.package_root)
      : input.projection.execution_root;
    const run = await runCompiler({
      nodeExecutable,
      compilerPath,
      configPath: configInProjection,
      outputRoot,
      cwd: packageInProjection,
      policy: sandbox.policy,
      home,
      tmp,
    });
    const errors = diagnosticErrorCount(run.code, run.stdout, run.stderr);
    const scan = await scanDependencyTree(outputRoot);
    if (scan.multiply_linked.length > 0) {
      throw new ReviewLspError(
        "DERIVED_ARTIFACT_INVALID",
        `derived output contains multiply-linked files: ${scan.multiply_linked.slice(0, 5).join(", ")}`,
      );
    }

    const strong = !run.timedOut && run.code === 0 && errors === 0;
    const limitation = strong
      ? null
      : run.timedOut
        ? "candidate compiler timed out"
        : run.code === null
          ? "candidate compiler did not produce a trustworthy exit status"
          : errors === null
            ? `candidate compiler exited ${run.code} and diagnostic error count could not be determined`
            : `candidate compiler exited ${run.code} with ${errors} TypeScript error diagnostic(s)`;

    const executionProfileBinding = await stableDerivedExecutionProfileBinding();
    const descriptor: DerivedWorkspaceArtifactDescriptor = {
      schema_version: "review-lsp.derived-workspace-artifact.v1",
      artifact_id: "",
      candidate_id: input.candidate.candidate_id,
      source_manifest_sha256: input.candidate.source_manifest_sha256,
      dependency_snapshot_id: input.snapshot.snapshot_id,
      package_manifest_path: recipe.package_manifest_path,
      package_name: recipe.package_name,
      project_config_path: recipe.project_config_path,
      project_config_sha256: recipe.project_config_sha256,
      config_chain: recipe.config_chain,
      compiler_artifact_id: engine.artifact_id,
      compiler_version: engine.version,
      compiler_entrypoint: compilerPath,
      compiler_entrypoint_sha256: sha256(compilerBytes),
      node_executable: nodeExecutable,
      node_executable_sha256: nodeExecutableSha256,
      fixed_compiler_argv: compilerArgvBinding(recipe.project_config_path),
      mount_relative_path: recipe.mount_relative_path,
      execution_profile_kind: executionProfile.kind,
      execution_profile_binding: executionProfileBinding,
      execution_profile_identity: executionProfile.identity,
      compiler_exit_code: run.code ?? -1,
      diagnostic_error_count: errors,
      stdout_sha256: sha256(run.stdout),
      stderr_sha256: sha256(run.stderr),
      output_tree_manifest_sha256: scan.tree_manifest_sha256,
      output_root: "",
      output_file_count: scan.file_count,
      output_total_bytes: scan.total_bytes,
      strong_admission: strong,
      limitation,
      created_at: new Date().toISOString(),
    };
    const artifactId = contentId("derived", derivedArtifactIdentityMaterial(descriptor));
    const finalRoot = join(derivedRoot, artifactId);
    const finalOutput = join(finalRoot, "output");
    descriptor.artifact_id = artifactId;
    descriptor.output_root = finalOutput;

    await rm(home, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
    await writeFile(join(stagingRoot, "derived-artifact.json"), `${JSON.stringify(descriptor, null, 2)}\n`, {
      mode: 0o400,
      flag: "wx",
    });
    await sealTree(outputRoot);

    try {
      await rename(stagingRoot, finalRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await makeTreeOwnerWritable(stagingRoot);
      await rm(stagingRoot, { recursive: true, force: true });
      const existing = JSON.parse(
        await readFile(join(finalRoot, "derived-artifact.json"), "utf8"),
      ) as DerivedWorkspaceArtifactDescriptor;
      await verifyDerivedWorkspaceArtifact(existing, {
        candidate: input.candidate,
        snapshot: input.snapshot,
        stateDirectory: input.stateDirectory,
      });
      await publishDerivationIndex(indexPath, {
        schema_version: "review-lsp.derived-index.v1",
        derivation_key: derivationKey,
        artifact_id: existing.artifact_id,
      });
      return existing;
    }
    await publishDerivationIndex(indexPath, {
      schema_version: "review-lsp.derived-index.v1",
      derivation_key: derivationKey,
      artifact_id: descriptor.artifact_id,
    });
    return descriptor;
  } catch (error) {
    await makeTreeOwnerWritable(stagingRoot).catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function verifyDerivedWorkspaceArtifact(
  artifact: DerivedWorkspaceArtifactDescriptor,
  input: {
    candidate: CandidateDescriptor;
    snapshot: DependencySnapshotDescriptor;
    stateDirectory: string;
  },
): Promise<void> {
  if (artifact.schema_version !== "review-lsp.derived-workspace-artifact.v1"
    || artifact.candidate_id !== input.candidate.candidate_id
    || artifact.source_manifest_sha256 !== input.candidate.source_manifest_sha256
    || artifact.dependency_snapshot_id !== input.snapshot.snapshot_id) {
    throw new ReviewLspError("DERIVED_ARTIFACT_INVALID", `derived artifact ${artifact.artifact_id} is bound to different inputs`);
  }

  const expectedArtifactId = contentId("derived", derivedArtifactIdentityMaterial(artifact));
  if (expectedArtifactId !== artifact.artifact_id) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} does not match its content-addressed identity`,
    );
  }

  const expectedOutputRoot = join(input.stateDirectory, "derived", artifact.artifact_id, "output");
  const [observedOutputRoot, canonicalExpectedOutputRoot] = await Promise.all([
    realpath(artifact.output_root).catch(() => null),
    realpath(expectedOutputRoot).catch(() => null),
  ]);
  if (!observedOutputRoot || !canonicalExpectedOutputRoot || observedOutputRoot !== canonicalExpectedOutputRoot) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} output root is not its content-addressed publication path`,
    );
  }

  let lease: VerifiedDerivedLease;
  try {
    lease = await derivedLeaseFingerprint(artifact);
  } catch (error) {
    if (error instanceof ReviewLspError) throw error;
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} output identity is not readable: ${(error as Error).message}`,
    );
  }
  const cached = verifiedDerivedLeases.get(artifact.artifact_id);
  if (cached && sameDerivedLease(cached, lease)) return;

  const recipe = await strictRecipe(input.candidate, artifact.package_manifest_path);
  const expectedRecipe = canonicalJson({
    package_manifest_path: recipe.package_manifest_path,
    package_name: recipe.package_name,
    project_config_path: recipe.project_config_path,
    project_config_sha256: recipe.project_config_sha256,
    config_chain: recipe.config_chain,
    mount_relative_path: recipe.mount_relative_path,
  });
  const observedRecipe = canonicalJson({
    package_manifest_path: artifact.package_manifest_path,
    package_name: artifact.package_name,
    project_config_path: artifact.project_config_path,
    project_config_sha256: artifact.project_config_sha256,
    config_chain: artifact.config_chain,
    mount_relative_path: artifact.mount_relative_path,
  });
  if (expectedRecipe !== observedRecipe) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} recipe no longer matches the exact candidate`,
    );
  }

  const engine = await admitEngineArtifact({
    snapshot: input.snapshot,
    projectRoot: recipe.package_root,
  });
  if (!engine || engine.artifact_id !== artifact.compiler_artifact_id || engine.version !== artifact.compiler_version) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} compiler binding is not the candidate-selected engine`,
    );
  }
  const compilerPath = join(engine.engine_root, "lib", "tsc.js");
  const compilerSha256 = sha256(await readFile(compilerPath));
  if (artifact.compiler_entrypoint !== compilerPath || artifact.compiler_entrypoint_sha256 !== compilerSha256) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} compiler entrypoint changed after publication`,
    );
  }

  const nodeExecutable = await realpath(process.execPath);
  const nodeExecutableSha256 = sha256(await readFile(nodeExecutable));
  if (artifact.node_executable !== nodeExecutable || artifact.node_executable_sha256 !== nodeExecutableSha256) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} Node runtime binding changed after publication`,
    );
  }

  const expectedProfileBinding = await stableDerivedExecutionProfileBinding();
  if (artifact.execution_profile_kind !== "MACOS_SANDBOX"
    || artifact.execution_profile_binding !== expectedProfileBinding) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} execution-profile implementation is not the admitted sandbox`,
    );
  }
  const sandboxExecutableSha256 = expectedProfileBinding.split(":sandbox-exec:").at(-1);
  if (!sandboxExecutableSha256
    || !artifact.execution_profile_identity.endsWith(`:sandbox-exec:${sandboxExecutableSha256}`)) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} runtime sandbox identity is inconsistent with its stable binding`,
    );
  }

  if (canonicalJson(artifact.fixed_compiler_argv) !== canonicalJson(compilerArgvBinding(recipe.project_config_path))) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} compiler argv is not the constrained recipe`,
    );
  }

  const scan = await scanDependencyTree(artifact.output_root);
  if (scan.multiply_linked.length > 0
    || scan.tree_manifest_sha256 !== artifact.output_tree_manifest_sha256
    || scan.file_count !== artifact.output_file_count
    || scan.total_bytes !== artifact.output_total_bytes) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} output tree changed after publication`,
    );
  }

  if (artifact.strong_admission
    && (artifact.compiler_exit_code !== 0
      || artifact.diagnostic_error_count !== 0
      || artifact.limitation !== null)) {
    throw new ReviewLspError(
      "DERIVED_ARTIFACT_INVALID",
      `derived artifact ${artifact.artifact_id} claims strong admission without a zero-error, limitation-free compiler outcome`,
    );
  }

  verifiedDerivedLeases.set(artifact.artifact_id, lease);
}
