import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { contentId } from "../../src/core/canonical.js";
import { scanDependencyTree } from "../../src/core/dependency-tree.js";
import { removeDependencySnapshot } from "../../src/core/dependency-snapshot.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { buildProjection, removeProjection } from "../../src/core/projection.js";
import { SemanticSession } from "../../src/core/session.js";
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
    devDependencies: { typescript: engineVersion },
  }, null, 2) + "\n";
  const tsconfig = JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n";
  const valueSource = 'export const value: string = "candidate";\n';
  const mainSource = 'import { value } from "./value";\nexport const result = value;\n';

  for (const base of [repo, referenceRoot]) {
    await writeFile(join(base, "package.json"), packageJson);
    await writeFile(join(base, "tsconfig.json"), tsconfig);
    await writeFile(join(base, "src", "value.ts"), valueSource);
    await writeFile(join(base, "src", "main.ts"), mainSource);
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
    const resolvingProject = resolveProjectForDocument(candidate, "src/main.ts");
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

      const [admittedDefinition, referenceDefinition] = await Promise.all([
        admitted.definition({ path: "src/main.ts", line: 1, character: position }),
        reference.definition(referenceDocument, 1, position),
      ]);
      expect(admittedDefinition.environment_binding).toBe("VERIFIED");
      expect(admittedDefinition.semantic_toolchain.toolchain_alignment).toBe("EXACT_PROJECT");
      const admittedResult = admittedDefinition.result as { server_response?: unknown };
      expect(normalizeUris(admittedResult.server_response, projection.execution_root))
        .toEqual(normalizeUris(referenceDefinition.value, referenceRoot));
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

    const resolvingProject = resolveProjectForDocument(candidate, "src/main.ts");
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
    } finally {
      await Promise.all([admitted.close(), reference.shutdown()]);
    }
  }, 120_000);
});
