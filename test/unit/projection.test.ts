import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import {
  buildProjection,
  classifyProjectionUri,
  projectionDocumentUri,
  removeProjection,
  verifyProjectionDescriptor,
  verifyProjectionSource,
} from "../../src/core/projection.js";
import type { CandidateDescriptor, ProjectionDescriptor } from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const projections: ProjectionDescriptor[] = [];

afterEach(async () => {
  await Promise.all(projections.splice(0).map((projection) => removeProjection(projection).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function projected(): Promise<{ candidate: CandidateDescriptor; projection: ProjectionDescriptor; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-projection-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root);
  const state = join(root, "state");
  const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
  candidates.push(candidate);
  const projection = await buildProjection({
    candidate,
    snapshot: null,
    stateDirectory: state,
    workspaceManifests: ["packages/app/package.json"],
  });
  projections.push(projection);
  return { candidate, projection, state };
}

describe("semantic execution projection", () => {
  it("reproduces candidate bytes exactly and leaves the candidate untouched", async () => {
    const { candidate, projection } = await projected();

    for (const entry of candidate.entries.filter((item) => item.kind === "file")) {
      const projected = await readFile(join(projection.execution_root, entry.path));
      const original = await readFile(join(candidate.source_root, entry.path));
      expect(projected.equals(original)).toBe(true);
    }
    await verifyProjectionSource(projection, candidate);

    // The candidate must remain dependency-free source authority.
    await expect(readFile(join(candidate.source_root, "node_modules", ".modules.yaml"))).rejects.toThrow();
  });

  it("gives the same projection identity to the same candidate, dependency state and gate scope", async () => {
    const { candidate, projection, state } = await projected();
    const again = await buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: ["packages/app/package.json"],
    });
    expect(again.projection_id).toBe(projection.projection_id);
  });

  it("binds the workspace-manifest gate scope into projection identity", async () => {
    const { candidate, projection, state } = await projected();
    const ungated = await buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: [],
    });
    projections.push(ungated);

    expect(ungated.projection_id).not.toBe(projection.projection_id);
    expect(ungated.workspace_manifests).toEqual([]);
    expect(projection.workspace_manifests).toEqual(["packages/app/package.json"]);
  });

  it("rejects a workspace-manifest path that lexically escapes candidate authority", async () => {
    const { candidate, state } = await projected();

    await expect(buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: ["../outside/package.json"],
    })).rejects.toThrow(/PROJECTION_INVALID/);
  });

  it("detects drift between the projection and the candidate it must reproduce", async () => {
    const { candidate, projection } = await projected();
    const target = join(projection.execution_root, "package.json");
    await chmod(join(projection.execution_root), 0o700);
    await chmod(target, 0o600);
    await writeFile(target, '{"name":"tampered"}\n');

    await expect(verifyProjectionSource(projection, candidate)).rejects.toThrow(/PROJECTION_INVALID/);
  });

  it("invalidates a verified projection lease when a child file changes but the root stays sealed", async () => {
    const { candidate, projection, state } = await projected();
    await verifyProjectionDescriptor(projection, { candidate, snapshot: null, stateDirectory: state });

    const target = join(projection.execution_root, "package.json");
    await chmod(target, 0o600);
    await writeFile(target, '{"name":"tampered"}\n');
    await chmod(target, 0o400);

    await expect(verifyProjectionDescriptor(projection, {
      candidate,
      snapshot: null,
      stateDirectory: state,
    })).rejects.toThrow(/PROJECTION_INVALID/);
  });

  it("rejects a cached descriptor whose execution root was forged", async () => {
    const { candidate, projection, state } = await projected();
    const descriptorPath = join(state, "projections", projection.projection_id, "projection.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as ProjectionDescriptor;
    descriptor.execution_root = candidate.source_root;
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: ["packages/app/package.json"],
    })).rejects.toThrow(/PROJECTION_INVALID/);
  });

  it("runs the entry-point gate as part of building the projection", async () => {
    const { projection } = await projected();
    // The fixture's workspace package points `main` at real source, so the gate is satisfied.
    expect(projection.entry_point_gate.state).toBe("COMPLETE");
    expect(projection.entry_point_gate.schema_version).toBe("review-lsp.entry-point-gate.v1");
  });

  it("reports an incomplete gate when a workspace entry point is absent from the projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-projection-gate-"));
    roots.push(root);
    // `dist/` is not candidate material, so a manifest naming it cannot be satisfied here.
    const fixture = await createPnpmFixture(root, { workspaceTypesTarget: "./dist/index.d.ts" });
    const state = join(root, "state");
    const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
    candidates.push(candidate);

    const projection = await buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: ["packages/app/package.json"],
    });
    projections.push(projection);

    expect(projection.entry_point_gate.state).toBe("INCOMPLETE");
    expect(projection.entry_point_gate.findings[0]?.declared_target).toBe("./dist/index.d.ts");

    const descriptorPath = join(state, "projections", projection.projection_id, "projection.json");
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as ProjectionDescriptor;
    descriptor.entry_point_gate = {
      ...descriptor.entry_point_gate,
      state: "COMPLETE",
      findings: [],
    };
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    await expect(buildProjection({
      candidate,
      snapshot: null,
      stateDirectory: state,
      workspaceManifests: ["packages/app/package.json"],
    })).rejects.toThrow(/PROJECTION_INVALID/);
  });
});

describe("projection over an admitted dependency snapshot", () => {
  const networkTests = process.env.REVIEW_LSP_NETWORK_TESTS === "1";

  it.runIf(networkTests)("links admitted dependencies and classifies them to the snapshot", async () => {
    const { acquireDependencies } = await import("../../src/core/dependency-acquisition.js");
    const { deriveDependencyInputs } = await import("../../src/core/dependency-inputs.js");
    const { publishDependencySnapshot, removeDependencySnapshot } = await import("../../src/core/dependency-snapshot.js");

    const root = await mkdtemp(join(tmpdir(), "review-lsp-projection-e2e-"));
    roots.push(root);
    const fixture = await createPnpmFixture(root);
    const state = join(root, "state");
    const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
    candidates.push(candidate);

    const inputs = await deriveDependencyInputs(candidate);
    await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION" });
    const snapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });

    try {
      const projection = await buildProjection({
        candidate,
        snapshot,
        stateDirectory: state,
        workspaceManifests: inputs.workspace_manifests,
      });
      projections.push(projection);

      expect(projection.dependency_snapshot_id).toBe(snapshot.snapshot_id);
      expect(projection.dependency_mounts).toContain("node_modules");
      // Source authority is unchanged even though dependencies are now reachable.
      await verifyProjectionSource(projection, candidate);

      // Reached lexically through the projection, really living in the sealed snapshot.
      const dependencyUri = pathToFileURL(join(projection.execution_root, "node_modules", "is-number", "package.json")).toString();
      const classified = await classifyProjectionUri(dependencyUri, {
        executionRoot: projection.execution_root,
        dependencyRoot: snapshot.dependency_root,
      });
      expect(classified.classification).toBe("DEPENDENCY_SNAPSHOT");
    } finally {
      await removeDependencySnapshot(snapshot).catch(() => undefined);
    }
  }, 900_000);
});

describe("projection URI classification", () => {
  it("classifies a candidate source path", async () => {
    const { projection } = await projected();
    const uri = projectionDocumentUri(projection, "packages/app/src/index.ts");
    const result = await classifyProjectionUri(uri, { executionRoot: projection.execution_root });

    expect(result.classification).toBe("CANDIDATE_SOURCE");
    expect(result.relative_path).toBe("packages/app/src/index.ts");
  });

  it("classifies a path reached through a symlink by where the bytes actually are", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-classify-"));
    roots.push(root);
    const execution = join(root, "execution");
    const dependencies = join(root, "dependencies");
    await mkdir(join(dependencies, "is-number"), { recursive: true });
    await mkdir(execution, { recursive: true });
    await writeFile(join(dependencies, "is-number", "index.d.ts"), "export declare const n: number;\n");
    await symlink(dependencies, join(execution, "node_modules"));

    // Lexically inside the projection, really inside the sealed snapshot: admitted, and
    // classified by where the bytes are rather than by how they were reached.
    const result = await classifyProjectionUri(
      pathToFileURL(join(execution, "node_modules", "is-number", "index.d.ts")).toString(),
      { executionRoot: execution, dependencyRoot: dependencies },
    );
    expect(result.classification).toBe("DEPENDENCY_SNAPSHOT");
    expect(result.relative_path).toBe("is-number/index.d.ts");
  });

  it("marks a symlink escaping every admitted root as UNBOUND", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-classify-escape-"));
    roots.push(root);
    const execution = join(root, "execution");
    const outside = join(root, "outside");
    await mkdir(execution, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "leaked.d.ts"), "export declare const leaked: number;\n");
    await symlink(outside, join(execution, "escape"));

    const result = await classifyProjectionUri(
      pathToFileURL(join(execution, "escape", "leaked.d.ts")).toString(),
      { executionRoot: execution },
    );

    // A lexical hit must not inherit the root's classification when the bytes are elsewhere.
    expect(result.classification).toBe("UNBOUND");
    expect(result.reason).toMatch(/resolves outside every admitted root/);
  });

  it("marks a path outside every admitted root as UNBOUND", async () => {
    const { projection } = await projected();
    const result = await classifyProjectionUri(
      pathToFileURL("/usr/lib/something.d.ts").toString(),
      { executionRoot: projection.execution_root },
    );
    expect(result.classification).toBe("UNBOUND");
  });

  it("classifies a toolchain path", async () => {
    const { projection } = await projected();
    const root = await mkdtemp(join(tmpdir(), "review-lsp-classify-toolchain-"));
    roots.push(root);
    await writeFile(join(root, "lib.es5.d.ts"), "declare var x: number;\n");

    const result = await classifyProjectionUri(
      pathToFileURL(join(root, "lib.es5.d.ts")).toString(),
      { executionRoot: projection.execution_root, toolchainRoots: [root] },
    );
    expect(result.classification).toBe("TOOLCHAIN");
  });
});
