import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { scanDependencyTree } from "./dependency-tree.js";
import { verifyDependencySnapshot } from "./dependency-snapshot.js";
import { ReviewLspError } from "./errors.js";
import type {
  AdmittedEngineArtifact,
  DependencySnapshotDescriptor,
  ExecutionProfile,
  TypeScriptProfile,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface NativeRuntimeAdmission {
  package_name: string;
  version: string;
  root: string;
  tree_manifest_sha256: string;
  entrypoint: string;
  entrypoint_sha256: string;
  file_count: number;
}

function stableNativeRuntime(runtime: NativeRuntimeAdmission | null): unknown {
  return runtime
    ? {
        package_name: runtime.package_name,
        version: runtime.version,
        tree_manifest_sha256: runtime.tree_manifest_sha256,
        entrypoint_sha256: runtime.entrypoint_sha256,
        file_count: runtime.file_count,
      }
    : null;
}

interface AdmittedEngineLease {
  artifact: AdmittedEngineArtifact;
  root_realpath: string;
  root_dev: number;
  root_ino: number;
  root_mode: number;
}

const admittedEngineLeases = new Map<string, AdmittedEngineLease>();

async function engineRootFingerprint(root: string): Promise<Omit<AdmittedEngineLease, "artifact">> {
  const [rootRealpath, info] = await Promise.all([realpath(root), stat(root)]);
  if (!info.isDirectory()) {
    throw new ReviewLspError("PROFILE_INVALID", `candidate TypeScript engine root is not a directory: ${root}`);
  }
  if ((info.mode & 0o222) !== 0) {
    throw new ReviewLspError("PROFILE_INVALID", `candidate TypeScript engine root is not sealed read-only: ${root}`);
  }
  return {
    root_realpath: rootRealpath,
    root_dev: info.dev,
    root_ino: info.ino,
    root_mode: info.mode,
  };
}

function sameEngineRoot(
  a: Omit<AdmittedEngineLease, "artifact">,
  b: Omit<AdmittedEngineLease, "artifact">,
): boolean {
  return a.root_realpath === b.root_realpath
    && a.root_dev === b.root_dev
    && a.root_ino === b.root_ino
    && a.root_mode === b.root_mode;
}

/**
 * Admission and execution policy for a candidate-selected semantic engine.
 *
 * Answering with the project's own TypeScript means executing bytes the candidate chose.
 * Registry and lockfile integrity prove which bytes were acquired; they prove nothing about
 * whether those bytes are safe to run. Refusing package lifecycle scripts does not help here
 * either — a compiler or language server is precisely the thing being asked to execute.
 *
 * So two separate things must hold before an answer from a candidate-selected engine can be
 * strong project-aligned evidence: the engine artifact is admitted by exact identity, and it
 * runs under a profile that actually enforces isolation. When no such profile exists for the
 * host, the honest outcome is a lower admission ceiling, never a silent fall back to running
 * candidate-selected code with the same trust as Review-LSP's own.
 */

/** TypeScript 7 ships a native binary; TypeScript 6 and earlier ship `lib/tsserver.js`. */
async function detectEngineShape(engineRoot: string): Promise<{
  kind: "TSSERVER_LEGACY" | "NATIVE_LSP";
  entrypoint: string;
} | null> {
  const tsserver = join(engineRoot, "lib", "tsserver.js");
  if (await stat(tsserver).then(() => true).catch(() => false)) {
    return { kind: "TSSERVER_LEGACY", entrypoint: tsserver };
  }
  // The native package resolves its executable through a platform-specific sibling package,
  // so the launcher is the stable entry point to bind.
  const launcher = join(engineRoot, "lib", "tsc.js");
  if (await stat(launcher).then(() => true).catch(() => false)) {
    return { kind: "NATIVE_LSP", entrypoint: launcher };
  }
  return null;
}

async function admitNativeRuntime(input: {
  engineRoot: string;
  engineVersion: string;
  snapshotRoot: string;
}): Promise<NativeRuntimeAdmission> {
  const packageName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const requireFromEngine = createRequire(join(input.engineRoot, "package.json"));
  let manifestPath: string;
  try {
    manifestPath = requireFromEngine.resolve(`${packageName}/package.json`);
  } catch {
    throw new ReviewLspError(
      "PROFILE_INVALID",
      `candidate TypeScript ${input.engineVersion} requires ${packageName}, but that native runtime is absent`,
    );
  }
  const root = await realpath(dirname(manifestPath));
  const snapshotRoot = await realpath(input.snapshotRoot);
  const delta = relative(snapshotRoot, root);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_ESCAPED",
      `candidate native TypeScript runtime ${packageName} resolves outside the admitted dependency snapshot`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
  if (manifest.version !== input.engineVersion) {
    throw new ReviewLspError(
      "PROFILE_INVALID",
      `candidate TypeScript ${input.engineVersion} resolved native runtime ${packageName}@${String(manifest.version)}`,
    );
  }
  const entrypoint = join(root, "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
  const entrypointBytes = await readFile(entrypoint).catch(() => null);
  if (!entrypointBytes) {
    throw new ReviewLspError(
      "PROFILE_INVALID",
      `candidate native TypeScript runtime ${packageName} lacks executable ${entrypoint}`,
    );
  }
  const tree = await scanDependencyTree(root);
  return {
    package_name: packageName,
    version: input.engineVersion,
    root,
    tree_manifest_sha256: tree.tree_manifest_sha256,
    entrypoint,
    entrypoint_sha256: sha256(entrypointBytes),
    file_count: tree.file_count,
  };
}

/**
 * Binds the exact engine the candidate's admitted dependency state selects.
 *
 * Identity covers every package whose bytes execute. For TypeScript <=6 that is the tsserver
 * package tree. TypeScript 7's JS launcher execs a platform-specific native package, so both
 * the launcher tree and native runtime tree are bound.
 */
export async function admitEngineArtifact(input: {
  snapshot: DependencySnapshotDescriptor;
  projectRoot?: string | null;
}): Promise<AdmittedEngineArtifact | null> {
  await verifyDependencySnapshot(input.snapshot);
  const roots = [
    input.projectRoot ? join(input.snapshot.dependency_root, input.projectRoot) : null,
    input.snapshot.dependency_root,
  ].filter((value): value is string => typeof value === "string");

  for (const root of roots) {
    const engineAlias = join(root, "node_modules", "typescript");
    let engineRoot: string;
    let version: string;
    try {
      engineRoot = await realpath(engineAlias);
      const snapshotRoot = await realpath(input.snapshot.dependency_root);
      const delta = relative(snapshotRoot, engineRoot);
      if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
        throw new ReviewLspError(
          "DEPENDENCY_SNAPSHOT_ESCAPED",
          "candidate TypeScript engine resolves outside the admitted dependency snapshot",
        );
      }
      const manifest = JSON.parse(await readFile(join(engineRoot, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string") continue;
      version = manifest.version;
    } catch (error) {
      if (error instanceof ReviewLspError) throw error;
      continue;
    }

    const shape = await detectEngineShape(engineRoot);
    if (!shape) {
      throw new ReviewLspError(
        "PROFILE_INVALID",
        `candidate TypeScript ${version} exposes neither lib/tsserver.js nor lib/tsc.js, so no admitted engine shape applies`,
      );
    }

    const engineFingerprint = await engineRootFingerprint(engineRoot);
    const engineLeaseKey = `${input.snapshot.snapshot_id}:${engineFingerprint.root_realpath}`;
    const cached = admittedEngineLeases.get(engineLeaseKey);
    if (cached && sameEngineRoot(cached, engineFingerprint)) {
      return cached.artifact;
    }

    const tree = await scanDependencyTree(engineRoot);
    const nativeRuntime = shape.kind === "NATIVE_LSP"
      ? await admitNativeRuntime({
          engineRoot,
          engineVersion: version,
          snapshotRoot: input.snapshot.dependency_root,
        })
      : null;
    const identityMaterial = {
      schema_version: "review-lsp.engine-artifact.v1" as const,
      package_name: "typescript" as const,
      version,
      engine_kind: shape.kind,
      tree_manifest_sha256: tree.tree_manifest_sha256,
      native_runtime: stableNativeRuntime(nativeRuntime),
      dependency_snapshot_id: input.snapshot.snapshot_id,
    };

    const artifact: AdmittedEngineArtifact = {
      ...identityMaterial,
      artifact_id: contentId("engine", identityMaterial),
      engine_root: engineRoot,
      entrypoint: shape.entrypoint,
      entrypoint_sha256: sha256(await readFile(shape.entrypoint)),
      file_count: tree.file_count,
      native_runtime: nativeRuntime,
      // Policy the engine must be launched under, recorded with the artifact so a receipt
      // states the conditions rather than leaving them to the launch site.
      policy: {
        plugins: "DISABLED",
        automatic_type_acquisition: "DISABLED",
        network: "DENIED",
      },
    };
    admittedEngineLeases.set(engineLeaseKey, { artifact, ...engineFingerprint });
    return artifact;
  }

  return null;
}

/**
 * Whether Docker can actually provide the container profile on this host.
 *
 * The probe asks for the *server* version, not the client's: a Docker CLI with no reachable
 * daemon cannot confine anything, and treating its presence as enforcement would grant an
 * admission the host cannot honour. The distinction between absent and unreachable is kept
 * because it tells the operator what to do about it.
 */
async function probeMacSandbox(): Promise<
  { available: true; executable: string; sha256: string }
  | { available: false; reason: string }
> {
  if (process.platform !== "darwin") {
    return { available: false, reason: "macOS sandbox-exec is only available on darwin" };
  }
  const executable = "/usr/bin/sandbox-exec";
  try {
    await access(executable, fsConstants.X_OK);
    return { available: true, executable, sha256: sha256(await readFile(executable)) };
  } catch {
    return { available: false, reason: "/usr/bin/sandbox-exec is unavailable or not executable" };
  }
}

function sbplString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Minimal enforced macOS profile for candidate-selected semantic engines.
 *
 * The engine may read the system runtime plus explicitly admitted semantic roots, may write
 * only to the session-owned HOME/TMP roots, and has no network entitlement. The profile is
 * passed directly to sandbox-exec; it is not a descriptive label.
 */
export async function buildMacSandboxPolicy(input: {
  readRoots: string[];
  writableRoots: string[];
}): Promise<{ policy: string; identity: string }> {
  const stableReadRoots = [...new Set(await Promise.all(input.readRoots.map(async (root) => (
    await realpath(root).catch(() => root)
  ))))].sort();
  const stableWritableRoots = [...new Set(await Promise.all(input.writableRoots.map(async (root) => (
    await realpath(root).catch(() => root)
  ))))].sort();
  const systemReadRoots = ["/System", "/usr", "/Library", "/private/etc", "/dev"];
  const admittedRoots = [...new Set([...systemReadRoots, ...stableReadRoots, ...stableWritableRoots])];
  const readRules = [...new Set([...systemReadRoots, ...stableReadRoots, ...stableWritableRoots])]
    .map((root) => `(subpath "${sbplString(root)}")`)
    .join(" ");
  const writeRules = stableWritableRoots
    .map((root) => `(subpath "${sbplString(root)}")`)
    .join(" ");

  // realpath(3) must lstat each ancestor before Node can reach an admitted leaf. Grant only
  // metadata on those ancestors; their file contents remain unreadable unless separately
  // admitted above.
  const ancestorMetadata = new Set<string>();
  for (const root of admittedRoots) {
    let current = dirname(root);
    while (current !== "/" && current !== ".") {
      ancestorMetadata.add(current);
      current = dirname(current);
    }
  }
  const metadataRules = [...ancestorMetadata].sort()
    .map((root) => `(literal "${sbplString(root)}")`)
    .join(" ");

  const policy = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(deny network*)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    ...(metadataRules ? [`(allow file-read-metadata ${metadataRules})`] : []),
    `(allow file-read* ${readRules})`,
    ...(writeRules ? [`(allow file-write* ${writeRules})`] : []),
  ].join("\n");
  return {
    policy,
    identity: `macos-sandbox:${sha256(canonicalJson({
      read_roots: stableReadRoots,
      writable_roots: stableWritableRoots,
      policy_sha256: sha256(policy),
    }))}`,
  };
}

async function probeDocker(): Promise<{ available: true } | { available: false; reason: string }> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Os}}"], { timeout: 10_000 });
    return { available: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/ENOENT|not found/i.test(detail)) {
      return { available: false, reason: "Docker is not installed, so the container execution profile cannot be provided" };
    }
    if (/daemon|Cannot connect/i.test(detail)) {
      return {
        available: false,
        reason: "the Docker daemon is not reachable, so the container execution profile cannot enforce isolation",
      };
    }
    return { available: false, reason: `the container execution profile is unavailable: ${detail.split("\n")[0]}` };
  }
}

/**
 * Resolves the execution profile available for running a candidate-selected engine.
 *
 * `enforced` is the only field that matters for admission. A profile that merely describes
 * the host, without constraining what the engine can reach, does not become enforcement by
 * being named.
 */
export async function resolveExecutionProfile(options: {
  preferContainer?: boolean;
  preferMacSandbox?: boolean;
  platform?: NodeJS.Platform;
  readRoots?: string[];
  writableRoots?: string[];
} = {}): Promise<ExecutionProfile> {
  const platform = options.platform ?? process.platform;

  let unavailableReason = `no enforced execution profile was requested on ${platform}`;

  // When the caller explicitly disables container preference it is asking for an unenforced
  // host probe (used by tests and policy checks), so do not silently substitute another
  // enforced profile.
  if (platform === "darwin" && options.preferContainer !== false && options.preferMacSandbox !== false) {
    const sandbox = await probeMacSandbox();
    if (sandbox.available) {
      const policy = await buildMacSandboxPolicy({
        readRoots: options.readRoots ?? [],
        writableRoots: options.writableRoots ?? [],
      });
      return {
        schema_version: "review-lsp.execution-profile.v1",
        kind: "MACOS_SANDBOX",
        enforced: true,
        platform,
        identity: `${policy.identity}:sandbox-exec:${sandbox.sha256}`,
        reason: null,
      };
    }
    unavailableReason = sandbox.reason;
  }

  if (options.preferContainer !== false) {
    const docker = await probeDocker();
    if (docker.available) {
      // Container enforcement is implemented by the dedicated container-query path. A normal
      // in-process semantic session does not become container-confined merely because Docker
      // is reachable, so this generic resolver does not grant a false enforced profile here.
      unavailableReason = "Docker is reachable, but this semantic session is not running through the dedicated container execution path";
    } else {
      unavailableReason = docker.reason;
    }
  }

  return {
    schema_version: "review-lsp.execution-profile.v1",
    kind: "TRUSTED_LOCAL",
    enforced: false,
    platform,
    identity: `native:${platform}:${process.arch}`,
    reason: `no enforced execution profile is available: ${unavailableReason}; a candidate-selected engine would run with the host's own trust`,
  };
}

/**
 * Whether an answer from a candidate-selected engine may be treated as strong project-aligned
 * evidence.
 *
 * Both conditions are required, and neither substitutes for the other.
 */
export function engineMayClaimExactProject(input: {
  artifact: AdmittedEngineArtifact | null;
  profile: ExecutionProfile;
}): { permitted: boolean; reason: string | null } {
  if (!input.artifact) {
    return { permitted: false, reason: "no candidate-selected engine artifact is admitted" };
  }
  if (!input.profile.enforced) {
    return {
      permitted: false,
      reason: input.profile.reason
        ?? "the available execution profile does not enforce isolation for a candidate-selected engine",
    };
  }
  return { permitted: true, reason: null };
}

export interface CandidateEngineLaunch {
  command: string;
  args: string[];
  initializationOptions: unknown;
  implementation: string;
  typescriptVersion: string;
  projectEngineAdmitted: true;
}

/**
 * Builds the actual launch that makes the admitted project engine answer.
 *
 * Legacy TypeScript uses the pinned Review-LSP language-server wrapper but routes that wrapper
 * to the admitted project's tsserver tree. TypeScript 7 uses its admitted native LSP entrypoint.
 * On macOS the whole answering process is wrapped in the exact sandbox profile represented by
 * the execution-profile identity. Unsupported enforcement kinds fail closed.
 */
export async function buildCandidateEngineLaunch(input: {
  artifact: AdmittedEngineArtifact;
  profile: TypeScriptProfile;
  executionProfile: ExecutionProfile;
  semanticRoot: string;
  writableRoots: string[];
  additionalReadRoots?: string[];
}): Promise<CandidateEngineLaunch> {
  if (!input.executionProfile.enforced) {
    throw new ReviewLspError(
      "PROFILE_INVALID",
      input.executionProfile.reason ?? "candidate engine execution profile is not enforced",
    );
  }

  let baseCommand: string;
  let baseArgs: string[];
  let initializationOptions: unknown;
  let implementation: string;

  if (input.artifact.engine_kind === "TSSERVER_LEGACY") {
    baseCommand = input.profile.node_executable;
    baseArgs = [input.profile.server_entrypoint, ...input.profile.args];
    initializationOptions = {
      ...input.profile.initialization_options,
      disableAutomaticTypingAcquisition: true,
      plugins: [],
      tsserver: {
        ...input.profile.initialization_options.tsserver,
        path: input.artifact.engine_root,
        fallbackPath: input.artifact.engine_root,
        logVerbosity: "off",
        useSyntaxServer: "never",
      },
    };
    implementation = "typescript-language-server+candidate-tsserver";
  } else {
    if (!input.artifact.native_runtime) {
      throw new ReviewLspError("PROFILE_INVALID", "native TypeScript engine has no admitted platform runtime");
    }
    baseCommand = input.artifact.native_runtime.entrypoint;
    baseArgs = ["--lsp", "--stdio"];
    initializationOptions = {};
    implementation = "typescript-native-lsp";
  }

  if (input.executionProfile.kind === "MACOS_SANDBOX") {
    const serverRoot = input.profile.server_runtime_root;
    const policy = await buildMacSandboxPolicy({
      readRoots: [
        input.semanticRoot,
        input.artifact.engine_root,
        ...(input.artifact.native_runtime ? [input.artifact.native_runtime.root] : []),
        input.profile.typescript_root,
        serverRoot,
        dirname(input.profile.node_executable),
        ...(input.additionalReadRoots ?? []),
      ],
      writableRoots: input.writableRoots,
    });
    if (!input.executionProfile.identity.startsWith(policy.identity)) {
      throw new ReviewLspError(
        "PROFILE_INVALID",
        "execution-profile identity does not match the sandbox policy required by the candidate engine",
      );
    }
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", policy.policy, baseCommand, ...baseArgs],
      initializationOptions,
      implementation,
      typescriptVersion: input.artifact.version,
      projectEngineAdmitted: true,
    };
  }

  throw new ReviewLspError(
    "PROFILE_INVALID",
    `normal semantic sessions cannot execute candidate engines under ${input.executionProfile.kind}; use a supported enforced launch path`,
  );
}

export function engineArtifactBinding(artifact: AdmittedEngineArtifact): string {
  return canonicalJson({
    artifact_id: artifact.artifact_id,
    version: artifact.version,
    engine_kind: artifact.engine_kind,
    tree_manifest_sha256: artifact.tree_manifest_sha256,
    native_runtime: stableNativeRuntime(artifact.native_runtime),
  });
}
