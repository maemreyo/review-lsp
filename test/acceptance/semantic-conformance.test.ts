import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { contentId } from "../../src/core/canonical.js";
import { scanDependencyTree } from "../../src/core/dependency-tree.js";
import { removeDependencySnapshot } from "../../src/core/dependency-snapshot.js";
import { buildEnvironmentManifest } from "../../src/core/environment.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { buildProjection, removeProjection } from "../../src/core/projection.js";
import { queryDiagnosticsCore, SemanticSession } from "../../src/core/session.js";
import { resolveProjectForDocument } from "../../src/core/toolchain.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
} from "../../src/core/types.js";
import { StdioLspDriver } from "../../src/lsp/client.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const projections: ProjectionDescriptor[] = [];
const snapshots: DependencySnapshotDescriptor[] = [];

afterEach(async () => {
  await Promise.all(projections.splice(0).map((projection) => removeProjection(projection).catch(() => undefined)));
  await Promise.all(snapshots.splice(0).map((snapshot) => removeDependencySnapshot(snapshot).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Review LSP Conformance",
      GIT_AUTHOR_EMAIL: "conformance@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Review LSP Conformance",
      GIT_COMMITTER_EMAIL: "conformance@example.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  return stdout.trim();
}

async function sealTree(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of await readdir(root)) await sealTree(join(root, name));
    await chmod(root, 0o500);
    return;
  }
  if (!info.isSymbolicLink()) await chmod(root, (info.mode & 0o111) !== 0 ? 0o500 : 0o400);
}

async function exactProjectFixture(options: {
  enginePackage?: "typescript" | "typescript7";
  valueSource?: string;
  mainSource?: string;
  projectReferences?: boolean;
  inheritedOwnership?: boolean;
  overlappingOwnership?: boolean;
} = {}): Promise<{
  root: string;
  referenceRoot: string;
  candidate: CandidateDescriptor;
  snapshot: DependencySnapshotDescriptor;
  projection: ProjectionDescriptor;
  state: string;
  profile: Awaited<ReturnType<typeof createTypeScriptProfile>>;
  engineRoot: string;
  engineVersion: string;
  nativeEntrypoint: string | null;
}> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-conformance-"));
  roots.push(root);
  const repo = join(root, "repo");
  const referenceRoot = join(root, "reference");
  const state = join(root, "state");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(referenceRoot, "src"), { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main", "--object-format=sha1", repo]);

  const profile = await createTypeScriptProfile();
  const enginePackage = options.enginePackage ?? "typescript";
  const engineManifestPath = fileURLToPath(import.meta.resolve(`${enginePackage}/package.json`));
  const engineRoot = dirname(engineManifestPath);
  const engineManifest = JSON.parse(await readFile(engineManifestPath, "utf8")) as { version: string };
  const engineVersion = engineManifest.version;
  const packageJson = JSON.stringify({
    name: `@fixture/conformance-ts${engineVersion.split(".")[0]}`,
    private: true,
    type: "module",
    packageManager: "pnpm@10.20.0",
    devDependencies: { typescript: engineVersion },
  }, null, 2) + "\n";
  const compilerOptions = {
    strict: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    noEmit: true,
  };
  const tsconfig = JSON.stringify(options.inheritedOwnership
    ? {
        extends: "./configs/tsconfig.base.json",
        ...(options.projectReferences ? { references: [{ path: "./packages/lib" }] } : {}),
      }
    : {
        compilerOptions,
        include: ["src/**/*.ts"],
        ...(options.projectReferences ? { references: [{ path: "./packages/lib" }] } : {}),
      }, null, 2) + "\n";
  const inheritedBaseTsconfig = JSON.stringify({
    compilerOptions,
    include: ["../src/**/*.ts"],
  }, null, 2) + "\n";
  const overlappingTsconfig = JSON.stringify({
    compilerOptions,
    include: ["../../src/**/*.ts"],
  }, null, 2) + "\n";
  const referencedTsconfig = JSON.stringify({
    compilerOptions: {
      composite: true,
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      declaration: true,
      outDir: "dist",
    },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n";
  const valueSource = options.valueSource ?? 'export const value: string = "candidate";\n';
  const mainSource = options.mainSource ?? 'import { value } from "./value";\nexport const result = value;\n';

  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      typescript:",
    `        specifier: ${engineVersion}`,
    `        version: ${engineVersion}`,
    "",
  ].join("\n");
  for (const base of [repo, referenceRoot]) {
    await writeFile(join(base, "package.json"), packageJson);
    await writeFile(join(base, "pnpm-lock.yaml"), lockfile);
    await writeFile(join(base, "tsconfig.json"), tsconfig);
    await writeFile(join(base, "src", "value.ts"), valueSource);
    await writeFile(join(base, "src", "main.ts"), mainSource);
    if (options.inheritedOwnership) {
      await mkdir(join(base, "configs"), { recursive: true });
      await writeFile(join(base, "configs", "tsconfig.base.json"), inheritedBaseTsconfig);
    }
    if (options.overlappingOwnership) {
      await mkdir(join(base, "packages", "overlap"), { recursive: true });
      await writeFile(join(base, "packages", "overlap", "tsconfig.json"), overlappingTsconfig);
    }
    if (options.projectReferences) {
      await mkdir(join(base, "packages", "lib", "src"), { recursive: true });
      await writeFile(join(base, "packages", "lib", "tsconfig.json"), referencedTsconfig);
      await writeFile(join(base, "packages", "lib", "src", "lib.ts"), "export const lib = 1;\n");
    }
  }

  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "semantic conformance fixture");
  const commit = await git(repo, "rev-parse", "HEAD");
  const candidate = await prepareCandidate({ repo, commit, stateDirectory: state });
  candidates.push(candidate);

  const snapshotDirectory = join(root, "snapshot");
  const dependencyRoot = join(snapshotDirectory, "dependencies");
  await mkdir(join(dependencyRoot, "node_modules"), { recursive: true });
  await cp(engineRoot, join(dependencyRoot, "node_modules", "typescript"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  let nativeEntrypoint: string | null = null;
  if (Number(engineVersion.split(".")[0]) >= 7) {
    const nativePackage = `@typescript/typescript-${process.platform}-${process.arch}`;
    const requireFromEngine = createRequire(engineManifestPath);
    const nativeManifestPath = requireFromEngine.resolve(`${nativePackage}/package.json`);
    const nativeRoot = dirname(nativeManifestPath);
    const nativeDestination = join(
      dependencyRoot,
      "node_modules",
      "@typescript",
      `typescript-${process.platform}-${process.arch}`,
    );
    await mkdir(dirname(nativeDestination), { recursive: true });
    await cp(nativeRoot, nativeDestination, { recursive: true, verbatimSymlinks: true });
    nativeEntrypoint = join(nativeRoot, "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
  }
  const scan = await scanDependencyTree(dependencyRoot);
  const identity = {
    schema_version: "review-lsp.dependency-snapshot.v1" as const,
    ecosystem: "node" as const,
    package_manager: "pnpm" as const,
    package_manager_version: "10.20.0",
    platform: process.platform,
    arch: process.arch,
    input_set_id: "depin_conformance_ts6_00000000000000",
    network_policy: "OFFLINE" as const,
    script_policy: "IGNORE_SCRIPTS" as const,
    lockfile_policy: "FROZEN" as const,
    dependency_graph: "INCLUDES_DEV" as const,
    tree_manifest_sha256: scan.tree_manifest_sha256,
  };
  await sealTree(dependencyRoot);
  const snapshot: DependencySnapshotDescriptor = {
    ...identity,
    snapshot_id: contentId("depsnap", identity),
    input_manifest: [],
    lockfile_binding: { path: "pnpm-lock.yaml", sha256: "0".repeat(64), byte_count: 1 },
    workspace_binding: null,
    patch_binding: [],
    config_binding: {},
    dependency_root: dependencyRoot,
    file_count: scan.file_count,
    symlink_count: scan.symlink_count,
    total_bytes: scan.total_bytes,
    materialization_method: "conformance-copy",
    created_at: new Date().toISOString(),
  };
  snapshots.push(snapshot);

  const projection = await buildProjection({
    candidate,
    snapshot,
    stateDirectory: state,
    workspaceManifests: ["package.json"],
  });
  projections.push(projection);
  return {
    root,
    referenceRoot,
    candidate,
    snapshot,
    projection,
    state,
    profile,
    engineRoot,
    engineVersion,
    nativeEntrypoint,
  };
}

function normalizeUris(value: unknown, root: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeUris(item, root));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "uri" || key === "targetUri") && typeof child === "string" && child.startsWith("file:")) {
      result[key] = relative(root, fileURLToPath(child)).split("\\").join("/");
    } else {
      result[key] = normalizeUris(child, root);
    }
  }
  return result;
}

describe.runIf(process.platform === "darwin")("P7 semantic differential conformance", () => {
  it("matches a trusted TypeScript <=6 reference for exact-project hover and definition", async () => {
    const { root, referenceRoot, candidate, snapshot, projection, state, profile } = await exactProjectFixture();
    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    expect(resolvingProject.state).toBe("RESOLVED");

    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });

    const referenceHome = join(root, "reference-home");
    const referenceTmp = join(root, "reference-tmp");
    await Promise.all([
      mkdir(referenceHome, { recursive: true }),
      mkdir(referenceTmp, { recursive: true }),
    ]);
    const reference = new StdioLspDriver(
      profile,
      referenceRoot,
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: referenceHome,
        TMPDIR: referenceTmp,
      },
      10_000,
      1_000,
    );

    try {
      await reference.start();
      const mainSource = 'import { value } from "./value";\nexport const result = value;\n';
      const position = "export const result = ".length;
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "src", "main.ts"),
        text: mainSource,
        languageId: "typescript",
      });

      const [admittedHover, referenceHover] = await Promise.all([
        admitted.hover({ path: "src/main.ts", line: 1, character: position }),
        reference.hover(referenceDocument, 1, position),
      ]);
      expect(admittedHover.source_binding).toBe("VERIFIED");
      expect(admittedHover.environment_binding).toBe("VERIFIED");
      expect(admittedHover.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(admittedHover.semantic_toolchain.candidate_engine).not.toBeNull();
      expect(admittedHover.semantic_toolchain.execution_profile.enforced).toBe(true);
      expect(admittedHover.result).toEqual(referenceHover.value);

      // The LSP server watchdog probes initialize.processId every three seconds. Sandboxed
      // candidate engines must survive beyond that boundary without cross-sandbox PID probes.
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_250));
      const repeatedHover = await admitted.hover({ path: "src/main.ts", line: 1, character: position });
      expect(repeatedHover.result).toEqual(referenceHover.value);

      const [admittedDefinition, referenceDefinition] = await Promise.all([
        admitted.definition({ path: "src/main.ts", line: 1, character: position }),
        reference.definition(referenceDocument, 1, position),
      ]);
      expect(admittedDefinition.environment_binding).toBe("VERIFIED");
      expect(admittedDefinition.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      const admittedResult = admittedDefinition.result as { server_response?: unknown };
      expect(normalizeUris(admittedResult.server_response, projection.execution_root))
        .toEqual(normalizeUris(referenceDefinition.value, referenceRoot));

      const [admittedReferences, referenceReferences] = await Promise.all([
        admitted.references({ path: "src/main.ts", line: 1, character: position, includeDeclaration: true }),
        reference.references(referenceDocument, 1, position, true),
      ]);
      expect(admittedReferences.environment_binding).toBe("VERIFIED");
      expect(admittedReferences.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      const admittedReferenceResult = admittedReferences.result as { server_response?: unknown };
      expect(normalizeUris(admittedReferenceResult.server_response, projection.execution_root))
        .toEqual(normalizeUris(referenceReferences.value, referenceRoot));

      const [admittedDiagnostics, referenceDiagnostics] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);
      expect(admittedDiagnostics.environment_binding).toBe("VERIFIED");
      expect(admittedDiagnostics.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(admittedDiagnostics.transport.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      expect(admittedDiagnostics.result).toEqual([]);
      expect(referenceDiagnostics.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      if (referenceDiagnostics.kind !== "TSSERVER_SYNC_DIAGNOSTICS") throw new Error("expected legacy diagnostics transport");
      expect([
        ...referenceDiagnostics.syntactic,
        ...referenceDiagnostics.semantic,
        ...referenceDiagnostics.suggestion,
      ]).toEqual([]);
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);

  it("matches a trusted TypeScript 7 native-LSP reference and binds the platform runtime", async () => {
    const {
      root,
      referenceRoot,
      candidate,
      snapshot,
      projection,
      state,
      profile,
      engineVersion,
      nativeEntrypoint,
    } = await exactProjectFixture({ enginePackage: "typescript7" });
    expect(engineVersion).toBe("7.0.2");
    expect(nativeEntrypoint).not.toBeNull();

    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });

    const referenceHome = join(root, "reference-home-ts7");
    const referenceTmp = join(root, "reference-tmp-ts7");
    await Promise.all([
      mkdir(referenceHome, { recursive: true }),
      mkdir(referenceTmp, { recursive: true }),
    ]);
    const reference = new StdioLspDriver(
      profile,
      referenceRoot,
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: referenceHome,
        TMPDIR: referenceTmp,
      },
      10_000,
      1_000,
      {
        command: nativeEntrypoint!,
        args: ["--lsp", "--stdio"],
        initializationOptions: {},
        implementation: "typescript-native-lsp-reference",
        typescriptVersion: engineVersion,
        projectEngineAdmitted: false,
      },
    );

    try {
      await reference.start();
      const mainSource = 'import { value } from "./value";\nexport const result = value;\n';
      const position = "export const result = ".length;
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "src", "main.ts"),
        text: mainSource,
        languageId: "typescript",
      });

      const [admittedHover, referenceHover] = await Promise.all([
        admitted.hover({ path: "src/main.ts", line: 1, character: position }),
        reference.hover(referenceDocument, 1, position),
      ]);
      expect(admittedHover.environment_binding).toBe("VERIFIED");
      expect(admittedHover.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(admittedHover.semantic_toolchain.semantic_engine.implementation).toBe("typescript-native-lsp");
      expect(admittedHover.semantic_toolchain.candidate_engine?.native_runtime_tree_manifest_sha256)
        .toMatch(/^[0-9a-f]{64}$/);
      expect(admittedHover.result).toEqual(referenceHover.value);

      const [admittedDefinition, referenceDefinition] = await Promise.all([
        admitted.definition({ path: "src/main.ts", line: 1, character: position }),
        reference.definition(referenceDocument, 1, position),
      ]);
      const admittedResult = admittedDefinition.result as { server_response?: unknown };
      expect(normalizeUris(admittedResult.server_response, projection.execution_root))
        .toEqual(normalizeUris(referenceDefinition.value, referenceRoot));

      const [admittedReferences, referenceReferences] = await Promise.all([
        admitted.references({ path: "src/main.ts", line: 1, character: position, includeDeclaration: true }),
        reference.references(referenceDocument, 1, position, true),
      ]);
      expect(admittedReferences.environment_binding).toBe("VERIFIED");
      expect(admittedReferences.semantic_toolchain.semantic_engine.implementation).toBe("typescript-native-lsp");
      const admittedReferenceResult = admittedReferences.result as { server_response?: unknown };
      expect(normalizeUris(admittedReferenceResult.server_response, projection.execution_root))
        .toEqual(normalizeUris(referenceReferences.value, referenceRoot));

      const [admittedDiagnostics, referenceDiagnostics] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);
      expect(admittedDiagnostics.environment_binding).toBe("VERIFIED");
      expect(admittedDiagnostics.semantic_toolchain.semantic_engine.implementation).toBe("typescript-native-lsp");
      expect(admittedDiagnostics.transport.kind).toBe("LSP_DOCUMENT_DIAGNOSTIC");
      expect(admittedDiagnostics.transport.diagnostic_provider).toMatchObject({
        identifier: "typescript",
        inter_file_dependencies: true,
        workspace_diagnostics: false,
      });
      expect(admittedDiagnostics.result).toEqual([]);
      expect(referenceDiagnostics.kind).toBe("LSP_DOCUMENT_DIAGNOSTIC");
      if (referenceDiagnostics.kind !== "LSP_DOCUMENT_DIAGNOSTIC") throw new Error("expected native document diagnostics transport");
      expect(referenceDiagnostics.diagnostics).toEqual([]);
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);

  it.each([
    ["TypeScript 6", "typescript" as const],
    ["TypeScript 7", "typescript7" as const],
  ])("admits a candidate-bound project-reference graph under %s exact-engine semantics", async (_label, enginePackage) => {
    const { candidate, snapshot, projection, state, profile } = await exactProjectFixture({
      enginePackage,
      projectReferences: true,
    });
    const environment = await buildEnvironmentManifest(candidate, profile, { snapshot, projection });

    expect(environment.project_references.state).toBe("BOUND");
    expect(environment.project_references.graph_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(environment.project_references.configs).toHaveLength(1);
    expect(environment.project_references.configs[0]?.references[0]?.resolved_config_path)
      .toBe("packages/lib/tsconfig.json");
    expect(environment.project_ownership.state).toBe("BOUND");
    expect(environment.project_ownership.model_sha256).toMatch(/^[0-9a-f]{64}$/);
    const rootOwnership = environment.project_ownership.configs.find((entry) => entry.path === "tsconfig.json");
    expect(rootOwnership).toMatchObject({ routable_project: true, routing_reason: "CONVENTIONAL_CONFIG" });
    expect(rootOwnership?.membership_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(environment.binding).toBe("VERIFIED");

    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    expect(resolvingProject).toMatchObject({ state: "RESOLVED", config_path: "tsconfig.json" });
    expect(resolvingProject.ownership_sha256).toBe(rootOwnership?.membership_sha256);
    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });

    try {
      const position = "export const result = ".length;
      const receipt = await admitted.hover({
        path: "src/main.ts",
        line: 1,
        character: position,
      });
      expect(receipt.source_binding).toBe("VERIFIED");
      expect(receipt.environment_binding).toBe("VERIFIED");
      expect(receipt.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(receipt.semantic_toolchain.resolving_project).toMatchObject({
        state: "RESOLVED",
        config_path: "tsconfig.json",
        ownership_sha256: rootOwnership?.membership_sha256,
      });
    } finally {
      await admitted.close();
    }
  }, 120_000);

  it.each([
    ["TypeScript 6", "typescript" as const],
    ["TypeScript 7", "typescript7" as const],
  ])("routes inherited project ownership under %s exact-engine semantics", async (_label, enginePackage) => {
    const { candidate, snapshot, projection, state, profile } = await exactProjectFixture({
      enginePackage,
      inheritedOwnership: true,
    });
    const environment = await buildEnvironmentManifest(candidate, profile, { snapshot, projection });
    expect(environment.binding).toBe("VERIFIED");
    expect(environment.project_ownership.state).toBe("BOUND");

    const baseOwnership = environment.project_ownership.configs.find((entry) => entry.path === "configs/tsconfig.base.json");
    const rootOwnership = environment.project_ownership.configs.find((entry) => entry.path === "tsconfig.json");
    expect(baseOwnership).toMatchObject({
      routable_project: false,
      routing_reason: "INHERITANCE_ONLY",
    });
    expect(rootOwnership).toMatchObject({
      routable_project: true,
      routing_reason: "CONVENTIONAL_CONFIG",
      effective_include: expect.objectContaining({
        origin_config_path: "configs/tsconfig.base.json",
        values: ["src/**/*.ts"],
      }),
    });

    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    expect(resolvingProject).toMatchObject({
      state: "RESOLVED",
      config_path: "tsconfig.json",
      ownership_sha256: rootOwnership?.membership_sha256,
    });

    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });
    try {
      const receipt = await admitted.hover({
        path: "src/main.ts",
        line: 1,
        character: "export const result = ".length,
      });
      expect(receipt.source_binding).toBe("VERIFIED");
      expect(receipt.environment_binding).toBe("VERIFIED");
      expect(receipt.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(receipt.semantic_toolchain.resolving_project.ownership_sha256)
        .toBe(rootOwnership?.membership_sha256);
    } finally {
      await admitted.close();
    }
  }, 120_000);

  it.each([
    ["TypeScript 6", "typescript" as const],
    ["TypeScript 7", "typescript7" as const],
  ])("fails closed when two admitted projects both own the queried document under %s", async (_label, enginePackage) => {
    const { candidate, snapshot, projection, state, profile } = await exactProjectFixture({
      enginePackage,
      overlappingOwnership: true,
    });
    const environment = await buildEnvironmentManifest(candidate, profile, { snapshot, projection });
    expect(environment.project_ownership.state).toBe("BOUND");
    expect(environment.binding).toBe("VERIFIED");

    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    expect(resolvingProject.state).toBe("AMBIGUOUS");
    expect(resolvingProject.candidate_configs?.map((entry) => entry.config_path)).toEqual([
      "packages/overlap/tsconfig.json",
      "tsconfig.json",
    ]);
    expect(resolvingProject.ownership_sha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    })).rejects.toThrow(/ENVIRONMENT_PARTIAL.*owned by multiple admitted projects/);
  }, 120_000);

  it("matches TypeScript <=6 sync diagnostics for an error document and binds related information provenance", async () => {
    const mainSource = [
      "interface Foo { x: string }",
      "export const value: Foo = { x: 1 };",
      "",
    ].join("\n");
    const { root, referenceRoot, candidate, snapshot, projection, state, profile } = await exactProjectFixture({
      mainSource,
    });
    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });

    const referenceHome = join(root, "reference-home-diag-ts6");
    const referenceTmp = join(root, "reference-tmp-diag-ts6");
    await Promise.all([
      mkdir(referenceHome, { recursive: true }),
      mkdir(referenceTmp, { recursive: true }),
    ]);
    const reference = new StdioLspDriver(
      profile,
      referenceRoot,
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: referenceHome,
        TMPDIR: referenceTmp,
      },
      10_000,
      1_000,
    );

    try {
      await reference.start();
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "src", "main.ts"),
        text: mainSource,
        languageId: "typescript",
      });
      const [receipt, raw] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);

      expect(raw.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      if (raw.kind !== "TSSERVER_SYNC_DIAGNOSTICS") throw new Error("expected legacy diagnostics transport");
      expect(raw.syntactic).toEqual([]);
      expect(raw.suggestion).toEqual([]);
      expect(raw.semantic).toHaveLength(1);
      const rawDiagnostic = raw.semantic[0]!;
      expect(rawDiagnostic.code).toBe(2322);
      expect(rawDiagnostic.relatedInformation).toHaveLength(1);

      expect(receipt.transport.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      expect(receipt.environment_binding).toBe("VERIFIED");
      expect(receipt.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(receipt.result).toHaveLength(1);
      const diagnostic = receipt.result[0]!;
      expect(diagnostic).toMatchObject({
        kind: "semantic",
        severity: "error",
        code: 2322,
        message: rawDiagnostic.text,
        tags: { unnecessary: false, deprecated: false },
      });
      expect(diagnostic.range).toEqual({
        start: { line: rawDiagnostic.start.line - 1, character: rawDiagnostic.start.offset - 1 },
        end: { line: rawDiagnostic.end.line - 1, character: rawDiagnostic.end.offset - 1 },
      });

      const rawRelated = rawDiagnostic.relatedInformation![0]!;
      const related = diagnostic.related_information[0]!;
      expect(related).toMatchObject({
        message: rawRelated.message,
        code: rawRelated.code,
        severity: "information",
      });
      expect(related.range).toEqual({
        start: {
          line: rawRelated.span!.start.line - 1,
          character: rawRelated.span!.start.offset - 1,
        },
        end: {
          line: rawRelated.span!.end.line - 1,
          character: rawRelated.span!.end.offset - 1,
        },
      });
      expect(related.binding).toMatchObject({
        classification: "SOURCE_CANDIDATE",
        path: "src/main.ts",
      });

      const repeated = await queryDiagnosticsCore(admitted, { path: "src/main.ts" });
      expect(repeated.result).toEqual(receipt.result);
      expect(repeated.candidate).toEqual(receipt.candidate);
      expect(repeated.environment_manifest_sha256).toBe(receipt.environment_manifest_sha256);
      expect(repeated.semantic_toolchain).toEqual(receipt.semantic_toolchain);
      expect(repeated.session_id).toBe(receipt.session_id);
      expect(repeated.session_epoch).toBe(receipt.session_epoch);
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);

  it("retains diagnostics but downgrades environment binding when related information is unbound", async () => {
    const { root, candidate, snapshot, projection, state, profile } = await exactProjectFixture();
    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });
    const outsideUri = pathToFileURL(join(root, "outside.ts")).toString();
    const diagnosticSpy = vi.spyOn(StdioLspDriver.prototype, "diagnostics").mockResolvedValue({
      kind: "LSP_DOCUMENT_DIAGNOSTIC",
      diagnostics: [{
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 6 },
        },
        severity: 1,
        code: 9999,
        source: "fixture",
        message: "fixture diagnostic",
        relatedInformation: [{
          location: {
            uri: outsideUri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
          message: "outside admitted roots",
        }],
      }],
      diagnosticProvider: {
        identifier: "fixture",
        interFileDependencies: true,
        workspaceDiagnostics: false,
      },
      protocolOperations: ["textDocument/diagnostic"],
      durationMs: 1,
    });

    try {
      const receipt = await queryDiagnosticsCore(admitted, { path: "src/main.ts" });
      expect(receipt.environment_binding).toBe("PARTIAL");
      expect(receipt.result).toHaveLength(1);
      expect(receipt.result[0]?.related_information[0]).toMatchObject({
        uri: outsideUri,
        binding: {
          classification: "UNBOUND",
        },
      });
      expect(receipt.limitations).toEqual(expect.arrayContaining([
        expect.stringContaining("diagnostic related information includes a URI outside every admitted root"),
      ]));

      diagnosticSpy.mockResolvedValueOnce({
        kind: "LSP_DOCUMENT_DIAGNOSTIC",
        diagnostics: [{
          range: {
            start: { line: 1, character: 6 },
            end: { line: 1, character: 2 },
          },
          severity: 1,
          code: 9998,
          source: "fixture",
          message: "malformed range",
        }],
        diagnosticProvider: {
          identifier: "fixture",
          interFileDependencies: true,
          workspaceDiagnostics: false,
        },
        protocolOperations: ["textDocument/diagnostic"],
        durationMs: 1,
      });
      await expect(queryDiagnosticsCore(admitted, { path: "src/main.ts" }))
        .rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
    } finally {
      diagnosticSpy.mockRestore();
      await admitted.close();
    }
  }, 120_000);

  it("matches TypeScript 7 native document diagnostics for an error document", async () => {
    const mainSource = [
      "interface Foo { x: string }",
      "export const value: Foo = { x: 1 };",
      "",
    ].join("\n");
    const {
      root,
      referenceRoot,
      candidate,
      snapshot,
      projection,
      state,
      profile,
      engineVersion,
      nativeEntrypoint,
    } = await exactProjectFixture({ enginePackage: "typescript7", mainSource });
    expect(nativeEntrypoint).not.toBeNull();

    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    const admitted = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });
    const referenceHome = join(root, "reference-home-diag-ts7");
    const referenceTmp = join(root, "reference-tmp-diag-ts7");
    await Promise.all([
      mkdir(referenceHome, { recursive: true }),
      mkdir(referenceTmp, { recursive: true }),
    ]);
    const reference = new StdioLspDriver(
      profile,
      referenceRoot,
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: referenceHome,
        TMPDIR: referenceTmp,
      },
      10_000,
      1_000,
      {
        command: nativeEntrypoint!,
        args: ["--lsp", "--stdio"],
        initializationOptions: {},
        implementation: "typescript-native-lsp-reference",
        typescriptVersion: engineVersion,
        projectEngineAdmitted: false,
      },
    );

    try {
      await reference.start();
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "src", "main.ts"),
        text: mainSource,
        languageId: "typescript",
      });
      const [receipt, raw] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);

      expect(raw.kind).toBe("LSP_DOCUMENT_DIAGNOSTIC");
      if (raw.kind !== "LSP_DOCUMENT_DIAGNOSTIC") throw new Error("expected native diagnostics transport");
      expect(raw.diagnostics).toHaveLength(1);
      const rawDiagnostic = raw.diagnostics[0]!;
      expect(rawDiagnostic.code).toBe(2322);

      expect(receipt.transport.kind).toBe("LSP_DOCUMENT_DIAGNOSTIC");
      expect(receipt.environment_binding).toBe("VERIFIED");
      expect(receipt.semantic_toolchain.semantic_engine.implementation).toBe("typescript-native-lsp");
      expect(receipt.result).toHaveLength(1);
      const diagnostic = receipt.result[0]!;
      expect(diagnostic).toMatchObject({
        kind: "engine",
        severity: "error",
        code: rawDiagnostic.code,
        source: rawDiagnostic.source ?? null,
        message: rawDiagnostic.message,
      });
      expect(diagnostic.range).toEqual(rawDiagnostic.range);
      expect(diagnostic.tags).toEqual({
        unnecessary: rawDiagnostic.tags?.includes(1) ?? false,
        deprecated: rawDiagnostic.tags?.includes(2) ?? false,
      });

      const repeated = await queryDiagnosticsCore(admitted, { path: "src/main.ts" });
      expect(repeated.result).toEqual(receipt.result);
      expect(repeated.semantic_toolchain).toEqual(receipt.semantic_toolchain);
      expect(repeated.session_id).toBe(receipt.session_id);
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);
});
