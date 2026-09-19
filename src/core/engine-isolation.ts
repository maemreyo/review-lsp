import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { scanDependencyTree } from "./dependency-tree.js";
import { ReviewLspError } from "./errors.js";
import type {
  AdmittedEngineArtifact,
  DependencySnapshotDescriptor,
  ExecutionProfile,
} from "./types.js";

const execFileAsync = promisify(execFile);

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

/**
 * Binds the exact engine the candidate's admitted dependency state selects.
 *
 * Identity covers the whole engine tree, not just a version string, because the version alone
 * does not say which bytes would run.
 */
export async function admitEngineArtifact(input: {
  snapshot: DependencySnapshotDescriptor;
  projectRoot?: string | null;
}): Promise<AdmittedEngineArtifact | null> {
  const roots = [
    input.projectRoot ? join(input.snapshot.dependency_root, input.projectRoot) : null,
    input.snapshot.dependency_root,
  ].filter((value): value is string => typeof value === "string");

  for (const root of roots) {
    const engineRoot = join(root, "node_modules", "typescript");
    let version: string;
    try {
      const manifest = JSON.parse(await readFile(join(engineRoot, "package.json"), "utf8")) as { version?: unknown };
      if (typeof manifest.version !== "string") continue;
      version = manifest.version;
    } catch {
      continue;
    }

    const shape = await detectEngineShape(engineRoot);
    if (!shape) {
      throw new ReviewLspError(
        "PROFILE_INVALID",
        `candidate TypeScript ${version} exposes neither lib/tsserver.js nor lib/tsc.js, so no admitted engine shape applies`,
      );
    }

    const tree = await scanDependencyTree(engineRoot);
    const identityMaterial = {
      schema_version: "review-lsp.engine-artifact.v1" as const,
      package_name: "typescript" as const,
      version,
      engine_kind: shape.kind,
      tree_manifest_sha256: tree.tree_manifest_sha256,
      dependency_snapshot_id: input.snapshot.snapshot_id,
    };

    return {
      ...identityMaterial,
      artifact_id: contentId("engine", identityMaterial),
      engine_root: engineRoot,
      entrypoint: shape.entrypoint,
      entrypoint_sha256: sha256(await readFile(shape.entrypoint)),
      file_count: tree.file_count,
      // Policy the engine must be launched under, recorded with the artifact so a receipt
      // states the conditions rather than leaving them to the launch site.
      policy: {
        plugins: "DISABLED",
        automatic_type_acquisition: "DISABLED",
        network: "DENIED",
      },
    };
  }

  return null;
}

/** Whether Docker can actually provide the container profile on this host. */
async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Os}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
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
  platform?: NodeJS.Platform;
} = {}): Promise<ExecutionProfile> {
  const platform = options.platform ?? process.platform;

  if (options.preferContainer !== false && await dockerAvailable()) {
    return {
      schema_version: "review-lsp.execution-profile.v1",
      kind: "CONTAINER_READ_ONLY",
      enforced: true,
      platform,
      identity: `container:${platform}`,
      reason: null,
    };
  }

  // No enforced local sandbox profile is defined yet for any platform. Naming one here
  // without implementing the confinement would be the silent fallback D11 forbids.
  return {
    schema_version: "review-lsp.execution-profile.v1",
    kind: "TRUSTED_LOCAL",
    enforced: false,
    platform,
    identity: `native:${platform}:${process.arch}`,
    reason: `no enforced execution profile is available on ${platform}; a candidate-selected engine would run with the host's own trust`,
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

export function engineArtifactBinding(artifact: AdmittedEngineArtifact): string {
  return canonicalJson({
    artifact_id: artifact.artifact_id,
    version: artifact.version,
    engine_kind: artifact.engine_kind,
    tree_manifest_sha256: artifact.tree_manifest_sha256,
  });
}
