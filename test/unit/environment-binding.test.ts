import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { buildEnvironmentManifest } from "../../src/core/environment.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { buildProjection, removeProjection } from "../../src/core/projection.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
  TypeScriptProfile,
} from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const projections: ProjectionDescriptor[] = [];
let profile: TypeScriptProfile | undefined;

afterEach(async () => {
  await Promise.all(projections.splice(0).map((projection) => removeProjection(projection).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

/** A descriptor standing in for a published snapshot; admission of bytes is tested elsewhere. */
function snapshotStub(): DependencySnapshotDescriptor {
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
    dependency_root: "/nonexistent",
    file_count: 0,
    symlink_count: 0,
    total_bytes: 0,
    materialization_method: "clone-or-copy",
    created_at: new Date().toISOString(),
  };
}

async function scenario(workspaceTypesTarget?: string) {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-envbind-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root, workspaceTypesTarget ? { workspaceTypesTarget } : {});
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
  profile ??= await createTypeScriptProfile();
  return { candidate, projection, profile };
}

describe("environment binding", () => {
  it("reports MISSING and refuses VERIFIED when a dependency-declaring candidate has no snapshot", async () => {
    const { candidate, profile: admitted } = await scenario();
    const environment = await buildEnvironmentManifest(candidate, admitted);

    expect(environment.dependency_snapshot.state).toBe("MISSING");
    expect(environment.binding).toBe("PARTIAL");
  });

  it("binds an admitted snapshot and reaches VERIFIED when the projection is complete", async () => {
    const { candidate, projection, profile: admitted } = await scenario();
    const snapshot = snapshotStub();

    const environment = await buildEnvironmentManifest(candidate, admitted, { snapshot, projection });

    expect(environment.dependency_snapshot.state).toBe("BOUND");
    expect(environment.dependency_snapshot.snapshot_id).toBe(snapshot.snapshot_id);
    expect(environment.dependency_snapshot.sha256).toBe(snapshot.tree_manifest_sha256);
    expect(environment.projection?.projection_id).toBe(projection.projection_id);
    expect(environment.projection?.entry_point_gate_state).toBe("COMPLETE");
    expect(environment.binding).toBe("VERIFIED");
  });

  it("refuses VERIFIED when a workspace entry point is absent, even with a bound snapshot", async () => {
    // The gate must block, not merely report: a bound snapshot says dependencies resolved,
    // which says nothing about a workspace package whose declared types target is build
    // output that no install produces.
    const { candidate, projection, profile: admitted } = await scenario("./dist/index.d.ts");
    const environment = await buildEnvironmentManifest(candidate, admitted, { snapshot: snapshotStub(), projection });

    expect(environment.dependency_snapshot.state).toBe("BOUND");
    expect(environment.projection?.entry_point_gate_state).toBe("INCOMPLETE");
    expect(environment.binding).toBe("PARTIAL");
    expect(environment.limitations.some((limitation) => limitation.includes("dist/index.d.ts"))).toBe(true);
  });

  it("carries the gate outcome into the manifest digest", async () => {
    const complete = await scenario();
    const incomplete = await scenario("./dist/index.d.ts");

    const a = await buildEnvironmentManifest(complete.candidate, complete.profile, {
      snapshot: snapshotStub(), projection: complete.projection,
    });
    const b = await buildEnvironmentManifest(incomplete.candidate, incomplete.profile, {
      snapshot: snapshotStub(), projection: incomplete.projection,
    });

    expect(a.environment_manifest_sha256).not.toBe(b.environment_manifest_sha256);
  });
});
