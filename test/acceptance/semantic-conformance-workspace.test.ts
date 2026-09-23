import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { contentId, sha256 } from "../../src/core/canonical.js";
import { scanDependencyTree } from "../../src/core/dependency-tree.js";
import { removeDependencySnapshot } from "../../src/core/dependency-snapshot.js";
import { deriveWorkspaceArtifact } from "../../src/core/derived-artifact.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { buildProjection, removeProjection } from "../../src/core/projection.js";
import { queryDiagnosticsCore, SemanticSession } from "../../src/core/session.js";
import { resolveProjectForDocument } from "../../src/core/toolchain.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
  SemanticReceipt,
  TypeScriptProfile,
} from "../../src/core/types.js";
import { StdioLspDriver } from "../../src/lsp/client.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const projections: ProjectionDescriptor[] = [];
const snapshots: DependencySnapshotDescriptor[] = [];
let profilePromise: Promise<TypeScriptProfile> | undefined;

afterEach(async () => {
  await Promise.all(projections.splice(0).map((projection) => removeProjection(projection).catch(() => undefined)));
  await Promise.all(snapshots.splice(0).map((snapshot) => removeDependencySnapshot(snapshot).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function profile(): Promise<TypeScriptProfile> {
  profilePromise ??= createTypeScriptProfile();
  return profilePromise;
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

async function writeFiles(base: string, files: Record<string, string>): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
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

async function createCandidate(repo: string, state: string, message: string): Promise<CandidateDescriptor> {
  await execFileAsync("git", ["init", "-q", "-b", "main", "--object-format=sha1", repo]);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", message);
  const commit = await git(repo, "rev-parse", "HEAD");
  const candidate = await prepareCandidate({ repo, commit, stateDirectory: state });
  candidates.push(candidate);
  return candidate;
}

async function createTs6Snapshot(
  root: string,
  label: string,
  extra?: (dependencyRoot: string) => Promise<void>,
): Promise<{ snapshot: DependencySnapshotDescriptor; profile: TypeScriptProfile }> {
  const admittedProfile = await profile();
  const snapshotDirectory = join(root, `snapshot-${label}`);
  const dependencyRoot = join(snapshotDirectory, "dependencies");
  await mkdir(join(dependencyRoot, "node_modules"), { recursive: true });
  await cp(admittedProfile.typescript_root, join(dependencyRoot, "node_modules", "typescript"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await extra?.(dependencyRoot);

  const scan = await scanDependencyTree(dependencyRoot);
  const identity = {
    schema_version: "review-lsp.dependency-snapshot.v1" as const,
    ecosystem: "node" as const,
    package_manager: "pnpm" as const,
    package_manager_version: "10.20.0",
    platform: process.platform,
    arch: process.arch,
    input_set_id: contentId("depin", { label, typescript: admittedProfile.typescript_version }),
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
    materialization_method: "semantic-conformance-copy",
    created_at: new Date().toISOString(),
  };
  snapshots.push(snapshot);
  return { snapshot, profile: admittedProfile };
}

async function referenceDriver(
  root: string,
  admittedProfile: TypeScriptProfile,
  suffix: string,
): Promise<StdioLspDriver> {
  const home = join(root, `.reference-home-${suffix}`);
  const tmp = join(root, `.reference-tmp-${suffix}`);
  await Promise.all([mkdir(home, { recursive: true }), mkdir(tmp, { recursive: true })]);
  const driver = new StdioLspDriver(
    admittedProfile,
    root,
    {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmp,
    },
    10_000,
    1_000,
  );
  await driver.start();
  return driver;
}

function stripUris(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUris);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = (key === "uri" || key === "targetUri") && typeof child === "string"
      ? "<file>"
      : stripUris(child);
  }
  return result;
}

function resultUris(value: unknown): string[] {
  const uris: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (typeof record.uri === "string") uris.push(record.uri);
    if (typeof record.targetUri === "string") uris.push(record.targetUri);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...new Set(uris)];
}

function definitionResult(receipt: SemanticReceipt): {
  server_response: unknown;
  bindings: Array<{ classification: string; path?: string; sha256?: string }>;
} {
  return receipt.result as {
    server_response: unknown;
    bindings: Array<{ classification: string; path?: string; sha256?: string }>;
  };
}

describe.runIf(process.platform === "darwin")("P7 workspace/dependency semantic conformance", () => {
  it("refuses VERIFIED before derived declarations exist, then matches a trusted plain-tsc build", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-derived-conformance-"));
    roots.push(root);
    const repo = join(root, "repo");
    const referenceRoot = join(root, "reference");
    const state = join(root, "state");
    const admittedProfile = await profile();

    const files = {
      "package.json": JSON.stringify({
        name: "@fixture/root",
        private: true,
        type: "module",
        devDependencies: { typescript: admittedProfile.typescript_version },
      }, null, 2) + "\n",
      "packages/provider/package.json": JSON.stringify({
        name: "@fixture/provider",
        private: true,
        type: "module",
        types: "./dist/index.d.ts",
        scripts: { build: "tsc -p tsconfig.json" },
      }, null, 2) + "\n",
      "packages/provider/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          declaration: true,
          emitDeclarationOnly: true,
          rootDir: "./src",
          outDir: "./dist",
        },
        include: ["src/**/*.ts"],
      }, null, 2) + "\n",
      "packages/provider/src/index.ts":
        "export interface Provider { name: string }\n"
        + "export const makeProvider = (name: string): Provider => ({ name });\n",
      "packages/app/package.json": JSON.stringify({
        name: "@fixture/app",
        private: true,
        type: "module",
        dependencies: { "@fixture/provider": "workspace:*" },
      }, null, 2) + "\n",
      "packages/app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      }, null, 2) + "\n",
      "packages/app/src/main.ts":
        'import { makeProvider, type Provider } from "@fixture/provider";\n'
        + 'export const result = makeProvider("Ada");\n'
        + 'export const broken: Provider = { name: 1 };\n',
    };
    await writeFiles(repo, files);
    await writeFiles(referenceRoot, files);
    const candidate = await createCandidate(repo, state, "derived semantic conformance");

    const { snapshot } = await createTs6Snapshot(root, "derived", async (dependencyRoot) => {
      const scope = join(dependencyRoot, "node_modules", "@fixture");
      await mkdir(scope, { recursive: true });
      await symlink("../../packages/provider", join(scope, "provider"));
    });

    const workspaceManifests = [
      "packages/app/package.json",
      "packages/provider/package.json",
    ];
    const initialProjection = await buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      workspaceManifests,
    });
    projections.push(initialProjection);
    expect(initialProjection.entry_point_gate.state).toBe("INCOMPLETE");

    const resolvingProject = await resolveProjectForDocument(candidate, "packages/app/src/main.ts");
    const initialSession = await SemanticSession.create({
      candidate,
      profile: admittedProfile,
      stateDirectory: state,
      snapshot,
      projection: initialProjection,
      resolvingProject,
    });
    try {
      const initialReceipt = await initialSession.hover({
        path: "packages/app/src/main.ts",
        line: 1,
        character: "export const result = ".length + 2,
      });
      expect(initialReceipt.environment_binding).toBe("PARTIAL");
      expect(initialReceipt.limitations.some((item) => item.includes("dist/index.d.ts"))).toBe(true);
    } finally {
      await initialSession.close();
    }

    const artifact = await deriveWorkspaceArtifact({
      candidate,
      snapshot,
      projection: initialProjection,
      manifestPath: "packages/provider/package.json",
      stateDirectory: state,
    });
    expect(artifact.strong_admission).toBe(true);

    const admittedProjection = await buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      derivedArtifacts: [artifact],
      workspaceManifests,
    });
    projections.push(admittedProjection);
    expect(admittedProjection.entry_point_gate.state).toBe("COMPLETE");

    await execFileAsync(admittedProfile.node_executable, [
      join(admittedProfile.typescript_root, "lib", "tsc.js"),
      "-p",
      "packages/provider/tsconfig.json",
    ], { cwd: referenceRoot });
    const referenceScope = join(referenceRoot, "node_modules", "@fixture");
    await mkdir(referenceScope, { recursive: true });
    await symlink("../../packages/provider", join(referenceScope, "provider"));

    const admitted = await SemanticSession.create({
      candidate,
      profile: admittedProfile,
      stateDirectory: state,
      snapshot,
      projection: admittedProjection,
      resolvingProject,
    });
    const reference = await referenceDriver(referenceRoot, admittedProfile, "derived");

    try {
      const source = files["packages/app/src/main.ts"];
      const position = "export const result = ".length + 2;
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "packages/app/src/main.ts"),
        text: source,
        languageId: "typescript",
      });

      const [admittedHover, referenceHover] = await Promise.all([
        admitted.hover({ path: "packages/app/src/main.ts", line: 1, character: position }),
        reference.hover(referenceDocument, 1, position),
      ]);
      expect(admittedHover.environment_binding).toBe("VERIFIED");
      expect(admittedHover.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(admittedHover.result).toEqual(referenceHover.value);

      const [admittedDefinition, referenceDefinition] = await Promise.all([
        admitted.definition({ path: "packages/app/src/main.ts", line: 1, character: position }),
        reference.definition(referenceDocument, 1, position),
      ]);
      expect(admittedDefinition.environment_binding).toBe("VERIFIED");
      const admittedResult = definitionResult(admittedDefinition);
      const derivedBinding = admittedResult.bindings.find(
        (binding) => binding.classification === "DERIVED_WORKSPACE_ARTIFACT",
      );
      expect(derivedBinding?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(stripUris(admittedResult.server_response)).toEqual(stripUris(referenceDefinition.value));
      const referenceUris = resultUris(referenceDefinition.value);
      expect(referenceUris).toHaveLength(1);
      const referencePath = await realpath(fileURLToPath(referenceUris[0]!));
      expect(derivedBinding?.sha256).toBe(sha256(await readFile(referencePath)));

      const [admittedReferences, referenceReferences] = await Promise.all([
        admitted.references({
          path: "packages/app/src/main.ts", line: 1, character: position, includeDeclaration: true,
        }),
        reference.references(referenceDocument, 1, position, true),
      ]);
      expect(admittedReferences.environment_binding).toBe("VERIFIED");
      const admittedReferenceResult = definitionResult(admittedReferences);
      expect(admittedReferenceResult.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ classification: "DERIVED_WORKSPACE_ARTIFACT" }),
        expect.objectContaining({ classification: "SOURCE_CANDIDATE" }),
      ]));
      expect(stripUris(admittedReferenceResult.server_response)).toEqual(stripUris(referenceReferences.value));

      const [admittedDiagnostics, referenceDiagnostics] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "packages/app/src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);
      expect(referenceDiagnostics.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      if (referenceDiagnostics.kind !== "TSSERVER_SYNC_DIAGNOSTICS") throw new Error("expected legacy diagnostics transport");
      const referenceError = referenceDiagnostics.semantic.find((item) => item.code === 2322);
      expect(referenceError?.relatedInformation).toHaveLength(1);
      expect(admittedDiagnostics.environment_binding).toBe("VERIFIED");
      const admittedError = admittedDiagnostics.result.find((item) => item.code === 2322);
      expect(admittedError?.related_information).toEqual(expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ classification: "DERIVED_WORKSPACE_ARTIFACT" }),
        }),
      ]));
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);

  it("routes two monorepo documents through their distinct resolving projects and matches reference semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-routing-conformance-"));
    roots.push(root);
    const repo = join(root, "repo");
    const referenceRoot = join(root, "reference");
    const state = join(root, "state");
    const admittedProfile = await profile();

    const packageJson = (name: string) => JSON.stringify({ name, private: true, type: "module" }, null, 2) + "\n";
    const tsconfig = (noUncheckedIndexedAccess: boolean) => JSON.stringify({
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2) + "\n";
    const source = 'const values = ["x"];\nexport const observed = values[0];\n';
    const files = {
      "package.json": JSON.stringify({
        name: "@fixture/routing-root",
        private: true,
        devDependencies: { typescript: admittedProfile.typescript_version },
      }, null, 2) + "\n",
      "packages/a/package.json": packageJson("@fixture/a"),
      "packages/a/tsconfig.json": tsconfig(true),
      "packages/a/src/main.ts": source,
      "packages/b/package.json": packageJson("@fixture/b"),
      "packages/b/tsconfig.json": tsconfig(false),
      "packages/b/src/main.ts": source,
    };
    await writeFiles(repo, files);
    await writeFiles(referenceRoot, files);
    const candidate = await createCandidate(repo, state, "multi-project routing conformance");
    const { snapshot } = await createTs6Snapshot(root, "routing");
    const projection = await buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      workspaceManifests: ["packages/a/package.json", "packages/b/package.json"],
    });
    projections.push(projection);

    const projectA = await resolveProjectForDocument(candidate, "packages/a/src/main.ts");
    const projectB = await resolveProjectForDocument(candidate, "packages/b/src/main.ts");
    expect(projectA.config_path).toBe("packages/a/tsconfig.json");
    expect(projectB.config_path).toBe("packages/b/tsconfig.json");

    const [sessionA, sessionB] = await Promise.all([
      SemanticSession.create({
        candidate,
        profile: admittedProfile,
        stateDirectory: state,
        snapshot,
        projection,
        resolvingProject: projectA,
      }),
      SemanticSession.create({
        candidate,
        profile: admittedProfile,
        stateDirectory: state,
        snapshot,
        projection,
        resolvingProject: projectB,
      }),
    ]);
    const reference = await referenceDriver(referenceRoot, admittedProfile, "routing");

    try {
      const [docA, docB] = await Promise.all([
        reference.openDocument({
          path: join(referenceRoot, "packages/a/src/main.ts"),
          text: source,
          languageId: "typescript",
        }),
        reference.openDocument({
          path: join(referenceRoot, "packages/b/src/main.ts"),
          text: source,
          languageId: "typescript",
        }),
      ]);
      const position = "export const ".length + 2;
      const [receiptA, receiptB, referenceA, referenceB] = await Promise.all([
        sessionA.hover({ path: "packages/a/src/main.ts", line: 1, character: position }),
        sessionB.hover({ path: "packages/b/src/main.ts", line: 1, character: position }),
        reference.hover(docA, 1, position),
        reference.hover(docB, 1, position),
      ]);

      expect(receiptA.environment_binding).toBe("VERIFIED");
      expect(receiptB.environment_binding).toBe("VERIFIED");
      expect(receiptA.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(receiptB.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(receiptA.semantic_toolchain.resolving_project.config_path).toBe("packages/a/tsconfig.json");
      expect(receiptB.semantic_toolchain.resolving_project.config_path).toBe("packages/b/tsconfig.json");
      expect(receiptA.result).toEqual(referenceA.value);
      expect(receiptB.result).toEqual(referenceB.value);
      expect(referenceA.value).not.toEqual(referenceB.value);
    } finally {
      await Promise.all([sessionA.close(), sessionB.close(), reference.shutdown()]);
    }
  }, 120_000);

  it("binds a dependency definition reached through a pnpm symlink to the sealed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-dependency-conformance-"));
    roots.push(root);
    const repo = join(root, "repo");
    const referenceRoot = join(root, "reference");
    const state = join(root, "state");
    const admittedProfile = await profile();
    const files = {
      "package.json": JSON.stringify({
        name: "@fixture/dependency-consumer",
        private: true,
        type: "module",
        dependencies: { "dep-pkg": "1.0.0" },
        devDependencies: { typescript: admittedProfile.typescript_version },
      }, null, 2) + "\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      }, null, 2) + "\n",
      "src/main.ts":
        'import { answer, type Dep } from "dep-pkg";\n'
        + "export const result = answer;\n"
        + "export const broken: Dep = { x: 1 };\n",
    };
    await writeFiles(repo, files);
    await writeFiles(referenceRoot, files);
    const candidate = await createCandidate(repo, state, "dependency symlink conformance");

    const packageBody = JSON.stringify({
      name: "dep-pkg",
      version: "1.0.0",
      types: "./index.d.ts",
    }, null, 2) + "\n";
    const declarationBody = "export interface Dep { x: string }\nexport declare const answer: 42;\n";
    const materializeDependency = async (base: string): Promise<void> => {
      const packageRoot = join(base, "node_modules", ".pnpm", "dep-pkg@1.0.0", "node_modules", "dep-pkg");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), packageBody);
      await writeFile(join(packageRoot, "index.d.ts"), declarationBody);
      await mkdir(join(base, "node_modules"), { recursive: true });
      await symlink(".pnpm/dep-pkg@1.0.0/node_modules/dep-pkg", join(base, "node_modules", "dep-pkg"));
    };

    const { snapshot } = await createTs6Snapshot(root, "dependency", materializeDependency);
    await materializeDependency(referenceRoot);

    const projection = await buildProjection({
      candidate,
      snapshot,
      stateDirectory: state,
      workspaceManifests: [],
    });
    projections.push(projection);
    const resolvingProject = await resolveProjectForDocument(candidate, "src/main.ts");
    const admitted = await SemanticSession.create({
      candidate,
      profile: admittedProfile,
      stateDirectory: state,
      snapshot,
      projection,
      resolvingProject,
    });
    const reference = await referenceDriver(referenceRoot, admittedProfile, "dependency");

    try {
      const source = files["src/main.ts"];
      const position = "export const result = ".length + 2;
      const referenceDocument = await reference.openDocument({
        path: join(referenceRoot, "src/main.ts"),
        text: source,
        languageId: "typescript",
      });
      const [admittedHover, referenceHover] = await Promise.all([
        admitted.hover({ path: "src/main.ts", line: 1, character: position }),
        reference.hover(referenceDocument, 1, position),
      ]);
      expect(admittedHover.environment_binding).toBe("VERIFIED");
      expect(admittedHover.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      expect(admittedHover.result).toEqual(referenceHover.value);

      const [admittedDefinition, referenceDefinition] = await Promise.all([
        admitted.definition({ path: "src/main.ts", line: 1, character: position }),
        reference.definition(referenceDocument, 1, position),
      ]);
      expect(admittedDefinition.environment_binding).toBe("VERIFIED");
      const admittedResult = definitionResult(admittedDefinition);
      const dependencyBinding = admittedResult.bindings.find(
        (binding) => binding.classification === "DEPENDENCY_SNAPSHOT",
      );
      expect(dependencyBinding?.path).toContain("dep-pkg@1.0.0");
      expect(dependencyBinding?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(stripUris(admittedResult.server_response)).toEqual(stripUris(referenceDefinition.value));

      const referenceUris = resultUris(referenceDefinition.value);
      expect(referenceUris).toHaveLength(1);
      const referencePath = await realpath(fileURLToPath(referenceUris[0]!));
      const referenceBytes = await readFile(referencePath);
      expect(dependencyBinding?.sha256).toBe(sha256(referenceBytes));

      const [admittedReferences, referenceReferences] = await Promise.all([
        admitted.references({ path: "src/main.ts", line: 1, character: position, includeDeclaration: true }),
        reference.references(referenceDocument, 1, position, true),
      ]);
      expect(admittedReferences.environment_binding).toBe("VERIFIED");
      const admittedReferenceResult = definitionResult(admittedReferences);
      expect(admittedReferenceResult.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ classification: "DEPENDENCY_SNAPSHOT" }),
        expect.objectContaining({ classification: "SOURCE_CANDIDATE" }),
      ]));
      expect(stripUris(admittedReferenceResult.server_response)).toEqual(stripUris(referenceReferences.value));

      const [admittedDiagnostics, referenceDiagnostics] = await Promise.all([
        queryDiagnosticsCore(admitted, { path: "src/main.ts" }),
        reference.diagnostics(referenceDocument),
      ]);
      expect(referenceDiagnostics.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      if (referenceDiagnostics.kind !== "TSSERVER_SYNC_DIAGNOSTICS") throw new Error("expected legacy diagnostics transport");
      const referenceError = referenceDiagnostics.semantic.find((item) => item.code === 2322);
      expect(referenceError?.relatedInformation).toHaveLength(1);
      expect(admittedDiagnostics.environment_binding).toBe("VERIFIED");
      const admittedError = admittedDiagnostics.result.find((item) => item.code === 2322);
      expect(admittedError?.related_information).toEqual(expect.arrayContaining([
        expect.objectContaining({
          binding: expect.objectContaining({ classification: "DEPENDENCY_SNAPSHOT" }),
        }),
      ]));
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);
});
