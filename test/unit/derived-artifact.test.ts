import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { contentId } from "../../src/core/canonical.js";
import { scanDependencyTree } from "../../src/core/dependency-tree.js";
import {
  deriveWorkspaceArtifact,
  verifyDerivedWorkspaceArtifact,
} from "../../src/core/derived-artifact.js";
import { buildProjection, removeProjection } from "../../src/core/projection.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  DerivedWorkspaceArtifactDescriptor,
  ProjectionDescriptor,
} from "../../src/core/types.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const projections: ProjectionDescriptor[] = [];

afterEach(async () => {
  await Promise.all(projections.splice(0).map((projection) => removeProjection(projection).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(join(root, "state", "fixture-snapshot", "dependencies"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }));
});

async function sealFixtureTree(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(root)) await sealFixtureTree(join(root, name));
    await chmod(root, 0o500);
    return;
  }
  if (!info.isSymbolicLink()) await chmod(root, (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
}

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Review LSP Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Review LSP Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  return stdout.trim();
}

async function scenario(options: {
  buildScript?: string;
  outDir?: string;
  source?: string;
  extendsConfig?: string;
  compilerSource?: string;
} = {}): Promise<{
  candidate: CandidateDescriptor;
  snapshot: DependencySnapshotDescriptor;
  projection: ProjectionDescriptor;
  state: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-derived-"));
  roots.push(root);
  const repo = join(root, "repo");
  const state = join(root, "state");
  await mkdir(join(repo, "src"), { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main", "--object-format=sha1", repo]);
  await git(repo, "config", "user.name", "Review LSP Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "commit.gpgsign", "false");

  await writeFile(join(repo, "package.json"), `${JSON.stringify({
    name: "@fixture/derived",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { build: options.buildScript ?? "tsc -p tsconfig.json" },
    types: "./dist/index.d.ts",
  }, null, 2)}\n`);
  await writeFile(join(repo, "tsconfig.json"), `${JSON.stringify({
    ...(options.extendsConfig ? { extends: options.extendsConfig } : {}),
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      rootDir: "./src",
      outDir: options.outDir ?? "./dist",
      strict: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  await writeFile(join(repo, "src", "index.ts"), options.source ?? "export const answer: number = 42;\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "derived fixture");
  const commit = await git(repo, "rev-parse", "HEAD");

  const candidate = await prepareCandidate({ repo, commit, stateDirectory: state });
  candidates.push(candidate);

  const snapshotRoot = join(state, "fixture-snapshot", "dependencies");
  const localTypescriptRoot = dirname(fileURLToPath(import.meta.resolve("typescript/package.json")));
  await mkdir(join(snapshotRoot, "node_modules"), { recursive: true });
  const fixtureTypeScriptRoot = join(snapshotRoot, "node_modules", "typescript");
  await cp(localTypescriptRoot, fixtureTypeScriptRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  if (options.compilerSource !== undefined) {
    await writeFile(join(fixtureTypeScriptRoot, "lib", "tsc.js"), options.compilerSource);
  }
  const scan = await scanDependencyTree(snapshotRoot);
  await sealFixtureTree(snapshotRoot);
  const snapshotIdentity = {
    schema_version: "review-lsp.dependency-snapshot.v1" as const,
    ecosystem: "node" as const,
    package_manager: "pnpm" as const,
    package_manager_version: "10.20.0",
    platform: process.platform,
    arch: process.arch,
    input_set_id: "depin_fixture_derived",
    network_policy: "OFFLINE" as const,
    script_policy: "IGNORE_SCRIPTS" as const,
    lockfile_policy: "FROZEN" as const,
    dependency_graph: "INCLUDES_DEV" as const,
    tree_manifest_sha256: scan.tree_manifest_sha256,
  };
  const snapshot: DependencySnapshotDescriptor = {
    ...snapshotIdentity,
    snapshot_id: contentId("depsnap", snapshotIdentity),
    input_manifest: [],
    lockfile_binding: { path: "pnpm-lock.yaml", sha256: "0".repeat(64), byte_count: 0 },
    workspace_binding: null,
    patch_binding: [],
    config_binding: {},
    dependency_root: snapshotRoot,
    file_count: scan.file_count,
    symlink_count: scan.symlink_count,
    total_bytes: scan.total_bytes,
    materialization_method: "fixture-copy",
    created_at: new Date().toISOString(),
  };

  const projection = await buildProjection({
    candidate,
    snapshot,
    stateDirectory: state,
    workspaceManifests: ["package.json"],
  });
  projections.push(projection);
  expect(projection.entry_point_gate.state).toBe("INCOMPLETE");

  return { candidate, snapshot, projection, state };
}

describe.runIf(process.platform === "darwin")("derived workspace artifact admission", () => {
  it("reuses a deterministic content identity and closes the entry-point gate", async () => {
    const { candidate, snapshot, projection, state } = await scenario();

    const first = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });
    const second = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });

    expect({
      strong_admission: first.strong_admission,
      compiler_exit_code: first.compiler_exit_code,
      diagnostic_error_count: first.diagnostic_error_count,
      limitation: first.limitation,
    }).toEqual({
      strong_admission: true,
      compiler_exit_code: 0,
      diagnostic_error_count: 0,
      limitation: null,
    });
    expect(first.artifact_id).toBe(second.artifact_id);
    expect(first.output_tree_manifest_sha256).toBe(second.output_tree_manifest_sha256);
    await verifyDerivedWorkspaceArtifact(first, {
      candidate,
      snapshot,
      stateDirectory: state,
    });

    const withDerived = await buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [first],
      workspaceManifests: ["package.json"],
    });
    projections.push(withDerived);
    expect(withDerived.entry_point_gate.state).toBe("COMPLETE");
    expect(withDerived.entry_point_gate.findings).toHaveLength(0);
  }, 120_000);

  it("invalidates a verified derived-artifact lease when emitted bytes change under a sealed root", async () => {
    const { candidate, snapshot, projection, state } = await scenario();
    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });
    await verifyDerivedWorkspaceArtifact(artifact, {
      candidate,
      snapshot,
      stateDirectory: state,
    });

    const target = join(artifact.output_root, "index.d.ts");
    await chmod(target, 0o600);
    await writeFile(target, "export declare const answer: string;\n");
    await chmod(target, 0o400);

    await expect(verifyDerivedWorkspaceArtifact(artifact, {
      candidate,
      snapshot,
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_INVALID/);
  }, 120_000);

  it("rejects a persisted descriptor whose mount provenance was mutated", async () => {
    const { candidate, snapshot, projection, state } = await scenario();
    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });
    const tampered: DerivedWorkspaceArtifactDescriptor = {
      ...artifact,
      mount_relative_path: "dist-forged",
    };

    await expect(verifyDerivedWorkspaceArtifact(tampered, {
      candidate,
      snapshot,
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_INVALID/);

    await expect(buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [tampered],
      workspaceManifests: ["package.json"],
    })).rejects.toThrow(/DERIVED_ARTIFACT_INVALID/);
  }, 120_000);

  it("keeps emitted declarations advisory when the compiler reports a type error", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      source: 'export const answer: number = "not-a-number";\n',
    });
    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });

    expect(artifact.compiler_exit_code).not.toBe(0);
    expect(artifact.diagnostic_error_count).toBeGreaterThan(0);
    expect(artifact.strong_admission).toBe(false);
    expect(artifact.limitation).toMatch(/compiler exited/);
    await expect(readFile(join(artifact.output_root, "index.d.ts"), "utf8")).resolves.toMatch(/answer/);
    await expect(buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [artifact],
      workspaceManifests: ["package.json"],
    })).rejects.toThrow(/advisory only/);
  }, 120_000);

  it("keeps a compiler crash with no parseable diagnostics below strong admission", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      compilerSource: "process.stderr.write('compiler crashed\\n'); process.exit(7);\n",
    });

    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });

    expect(artifact.compiler_exit_code).toBe(7);
    expect(artifact.diagnostic_error_count).toBeNull();
    expect(artifact.strong_admission).toBe(false);
    expect(artifact.limitation).toMatch(/diagnostic error count could not be determined/);
    expect(await readdir(join(state, "derived", "by-derivation"))).toEqual([]);

    // Advisory/debug evidence is retained, but it must not become cache authority. A later
    // preparation retries and remains PARTIAL/advisory instead of failing on a poisoned index.
    const repeated = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    });
    expect(repeated.artifact_id).toBe(artifact.artifact_id);
    expect(repeated.strong_admission).toBe(false);
    expect(await readdir(join(state, "derived", "by-derivation"))).toEqual([]);

    await expect(buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [artifact],
      workspaceManifests: ["package.json"],
    })).rejects.toThrow(/advisory only/);
  }, 120_000);

  it("keeps a compiler timeout below strong admission without waiting for the production timeout", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      compilerSource: "setInterval(() => {}, 1_000);\n",
    });

    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
      compilerTimeoutMs: 75,
    });

    expect(artifact.compiler_exit_code).toBe(-1);
    expect(artifact.diagnostic_error_count).toBeNull();
    expect(artifact.strong_admission).toBe(false);
    expect(artifact.limitation).toMatch(/compiler timed out/);
    await expect(buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [artifact],
      workspaceManifests: ["package.json"],
    })).rejects.toThrow(/advisory only/);
  }, 120_000);

  it("rejects an invalid compiler timeout before executing candidate compiler bytes", async () => {
    const { candidate, snapshot, projection, state } = await scenario();
    await expect(deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
      compilerTimeoutMs: 0,
    })).rejects.toThrow(/compiler timeout must be a positive safe integer/);
  }, 120_000);

  it("refuses custom build recipes instead of executing candidate scripts", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      buildScript: "node custom-build.js",
    });

    await expect(deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_UNSUPPORTED/);
  }, 120_000);

  it("refuses a derived outDir that escapes its workspace package", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      outDir: "../escaped-dist",
    });

    await expect(deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_UNSUPPORTED/);
  }, 120_000);

  it("refuses a build config path that lexically escapes the candidate", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      buildScript: "tsc -p ../outside.json",
    });

    await expect(deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_UNSUPPORTED/);
  }, 120_000);

  it("refuses a tsconfig extends target that lexically escapes the candidate", async () => {
    const { candidate, snapshot, projection, state } = await scenario({
      extendsConfig: "../outside.json",
    });

    await expect(deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection,
      manifestPath: "package.json",
      stateDirectory: state,
    })).rejects.toThrow(/DERIVED_ARTIFACT_UNSUPPORTED/);
  }, 120_000);
});
