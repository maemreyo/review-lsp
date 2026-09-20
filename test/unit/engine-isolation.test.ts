import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admitEngineArtifact,
  buildMacSandboxPolicy,
  engineMayClaimExactProject,
  resolveExecutionProfile,
} from "../../src/core/engine-isolation.js";
import type { AdmittedEngineArtifact, DependencySnapshotDescriptor, ExecutionProfile } from "../../src/core/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

/** Builds a snapshot-shaped directory holding a TypeScript package of the given shape. */
async function snapshotWithEngine(
  version: string,
  shape: "TSSERVER_LEGACY" | "NATIVE_LSP" | "NEITHER",
): Promise<DependencySnapshotDescriptor> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-engine-"));
  roots.push(root);
  const engineRoot = join(root, "node_modules", "typescript", "lib");
  await mkdir(engineRoot, { recursive: true });
  await writeFile(join(root, "node_modules", "typescript", "package.json"), `${JSON.stringify({ name: "typescript", version })}\n`);
  if (shape === "TSSERVER_LEGACY") await writeFile(join(engineRoot, "tsserver.js"), "// tsserver\n");
  if (shape === "NATIVE_LSP") await writeFile(join(engineRoot, "tsc.js"), "// native launcher\n");

  return {
    schema_version: "review-lsp.dependency-snapshot.v1",
    snapshot_id: "depsnap_00000000000000000000000000000000",
    ecosystem: "node",
    package_manager: "pnpm",
    package_manager_version: "10.20.0",
    platform: process.platform,
    arch: process.arch,
    input_set_id: "depin_00000000000000000000000000000000",
    input_manifest: [],
    lockfile_binding: { path: "pnpm-lock.yaml", sha256: "0".repeat(64), byte_count: 1 },
    workspace_binding: null,
    patch_binding: [],
    config_binding: {},
    network_policy: "OFFLINE",
    script_policy: "IGNORE_SCRIPTS",
    lockfile_policy: "FROZEN",
    dependency_graph: "INCLUDES_DEV",
    tree_manifest_sha256: "1".repeat(64),
    dependency_root: root,
    file_count: 0,
    symlink_count: 0,
    total_bytes: 0,
    materialization_method: "clone-or-copy",
    created_at: new Date().toISOString(),
  };
}

function profile(enforced: boolean): ExecutionProfile {
  return {
    schema_version: "review-lsp.execution-profile.v1",
    kind: enforced ? "CONTAINER_READ_ONLY" : "TRUSTED_LOCAL",
    enforced,
    platform: process.platform,
    identity: enforced ? "container:test" : "native:test",
    reason: enforced ? null : "no enforced execution profile is available",
  };
}

describe("candidate-selected engine admission", () => {
  it("binds a legacy tsserver engine by its whole tree, not just its version", async () => {
    const artifact = await admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY") });

    expect(artifact?.engine_kind).toBe("TSSERVER_LEGACY");
    expect(artifact?.version).toBe("6.0.3");
    expect(artifact?.artifact_id).toMatch(/^engine_[0-9a-f]{32}$/);
    expect(artifact?.tree_manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact?.entrypoint).toMatch(/lib\/tsserver\.js$/);
  });

  it("recognises the native TypeScript 7 engine shape", async () => {
    // TypeScript 7 exposes no `lib/tsserver.js` at all; it is a different engine, not a
    // different version of the same one.
    const artifact = await admitEngineArtifact({ snapshot: await snapshotWithEngine("7.0.2", "NATIVE_LSP") });

    expect(artifact?.engine_kind).toBe("NATIVE_LSP");
    expect(artifact?.entrypoint).toMatch(/lib\/tsc\.js$/);
  });

  it("gives different identities to different engine bytes at the same version", async () => {
    const first = await admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY") });
    const second = await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY");
    await writeFile(join(second.dependency_root, "node_modules", "typescript", "lib", "tsserver.js"), "// different bytes\n");
    const changed = await admitEngineArtifact({ snapshot: second });

    expect(changed?.version).toBe(first?.version);
    expect(changed?.artifact_id).not.toBe(first?.artifact_id);
  });

  it("refuses an engine whose shape matches nothing admitted", async () => {
    await expect(admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "NEITHER") }))
      .rejects.toThrow(/PROFILE_INVALID/);
  });

  it("returns nothing when the snapshot holds no TypeScript", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-engine-empty-"));
    roots.push(root);
    const snapshot = await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY");
    snapshot.dependency_root = root;

    expect(await admitEngineArtifact({ snapshot })).toBeNull();
  });

  it("records the policy the engine must be launched under", async () => {
    const artifact = await admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY") });
    expect(artifact?.policy).toEqual({
      plugins: "DISABLED",
      automatic_type_acquisition: "DISABLED",
      network: "DENIED",
    });
  });
});

describe("execution profile and the EXACT_PROJECT ceiling", () => {
  it("refuses strong admission when no enforced profile is available", async () => {
    const artifact = await admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY") });
    const decision = engineMayClaimExactProject({ artifact, profile: profile(false) });

    // Running candidate-selected bytes with the host's own trust cannot be strong evidence,
    // and must not silently become it.
    expect(decision.permitted).toBe(false);
    expect(decision.reason).toMatch(/no enforced execution profile/);
  });

  it("refuses strong admission when no engine artifact is admitted, even under enforcement", () => {
    const decision = engineMayClaimExactProject({ artifact: null, profile: profile(true) });
    expect(decision.permitted).toBe(false);
    expect(decision.reason).toMatch(/no candidate-selected engine artifact/);
  });

  it("permits strong admission only when both conditions hold", async () => {
    const artifact = await admitEngineArtifact({ snapshot: await snapshotWithEngine("6.0.3", "TSSERVER_LEGACY") });
    const decision = engineMayClaimExactProject({ artifact, profile: profile(true) });

    expect(decision.permitted).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("never reports an unenforced profile as enforced", async () => {
    const resolved = await resolveExecutionProfile({ preferContainer: false });

    expect(resolved.enforced).toBe(false);
    expect(resolved.kind).toBe("TRUSTED_LOCAL");
    expect(resolved.reason).toMatch(/no enforced execution profile/);
  });

  it.runIf(process.platform === "darwin")("enforces the network deny in the macOS sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-sandbox-network-"));
    roots.push(root);
    const policy = await buildMacSandboxPolicy({
      readRoots: [root],
      writableRoots: [root],
    });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind local test server");

    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("/usr/bin/sandbox-exec", [
          "-p",
          policy.policy,
          process.execPath,
          "-e",
          [
            'const net=require("node:net");',
            `const s=net.connect(${address.port},"127.0.0.1");`,
            's.once("connect",()=>process.exit(0));',
            's.once("error",()=>process.exit(7));',
            'setTimeout(()=>process.exit(8),1500);',
          ].join(""),
        ], {
          cwd: root,
          env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root },
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("exit", (code) => resolve(code));
      });
      expect(exit).not.toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
