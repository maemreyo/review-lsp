import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { runtimeKeyFor, runtimeKeyId, SemanticRuntimeManager } from "../../src/core/runtime.js";
import type { CandidateDescriptor, ProjectionDescriptor, TypeScriptProfile } from "../../src/core/types.js";
import { createTypeScriptAbRepo } from "../helpers/git.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const managers: SemanticRuntimeManager[] = [];
let profile: TypeScriptProfile | undefined;

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose().catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function scenario(options: { idleTtlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-runtime-"));
  roots.push(root);
  const { repo, a } = await createTypeScriptAbRepo(root);
  const state = join(root, "state");
  const candidate = await prepareCandidate({ repo, commit: a, stateDirectory: state });
  candidates.push(candidate);
  profile ??= await createTypeScriptProfile();
  const manager = new SemanticRuntimeManager({ idleTtlMs: options.idleTtlMs ?? 60_000 });
  managers.push(manager);
  return { candidate, profile, state, manager };
}

describe("runtime key", () => {
  it("separates runtimes that differ in anything that could change an answer", () => {
    const candidate = { candidate_id: "cand_a", source_manifest_sha256: "s", isolation: "TRUSTED_LOCAL" } as CandidateDescriptor;
    const admitted = { profile_sha256: "p" } as TypeScriptProfile;
    const base = runtimeKeyFor({ candidate, profile: admitted });

    // A monorepo can resolve different TypeScript generations per package, so two documents
    // in different projects must not share one language server.
    const otherProject = runtimeKeyFor({ candidate, profile: admitted, resolvingProjectIdentity: "project-b" });
    expect(runtimeKeyId(otherProject)).not.toBe(runtimeKeyId(base));

    const otherProjection = runtimeKeyFor({
      candidate,
      profile: admitted,
      projection: { projection_id: "proj_b" } as ProjectionDescriptor,
    });
    expect(runtimeKeyId(otherProjection)).not.toBe(runtimeKeyId(base));
  });

  it("gives the same identity regardless of derived-artifact ordering", () => {
    const candidate = { candidate_id: "cand_a", source_manifest_sha256: "s", isolation: "TRUSTED_LOCAL" } as CandidateDescriptor;
    const admitted = { profile_sha256: "p" } as TypeScriptProfile;

    const first = runtimeKeyFor({ candidate, profile: admitted, derivedArtifactSnapshotIds: ["b", "a"] });
    const second = runtimeKeyFor({ candidate, profile: admitted, derivedArtifactSnapshotIds: ["a", "b"] });
    expect(runtimeKeyId(first)).toBe(runtimeKeyId(second));
  });
});

describe("semantic runtime reuse", () => {
  it("serves concurrent questions from one runtime", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario();

    // The acceptance criterion: four simultaneous questions on one review must not prepare
    // four runtimes.
    const leases = await Promise.all([0, 1, 2, 3].map(() => manager.acquire({
      candidate, profile: admitted, stateDirectory: state,
    })));

    expect(manager.liveRuntimeCount).toBe(1);
    expect(new Set(leases.map((lease) => lease.key_id)).size).toBe(1);
    expect(new Set(leases.map((lease) => lease.session)).size).toBe(1);

    const results = await Promise.all(leases.map((lease) => lease.session.hover({
      path: "src/main.ts", line: 1, character: "export const observed = ".length + 6,
    })));
    expect(results).toHaveLength(4);
    for (const lease of leases) lease.release();
  }, 120_000);

  it("reuses a warm runtime for a later question instead of rebuilding it", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario();

    const first = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    const firstSession = first.session;
    first.release();

    const second = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    expect(second.session).toBe(firstSession);
    expect(manager.liveRuntimeCount).toBe(1);
    second.release();
  }, 120_000);

  it("does not close a runtime while a question is still holding it", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario({ idleTtlMs: 10 });

    const holder = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    const transient = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    transient.release();

    // The idle timer belongs to the runtime, not to one lease: releasing one holder must not
    // shut the server down underneath another.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const receipt = await holder.session.hover({ path: "src/main.ts", line: 1, character: 30 });
    expect(receipt.execution_status).toBe("OK");
    holder.release();
  }, 120_000);

  it("closes an unreferenced runtime once it has been idle", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario({ idleTtlMs: 50 });

    const lease = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(manager.liveRuntimeCount).toBe(0);
  }, 120_000);

  it("treats releasing twice as releasing once", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario();

    const first = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    const second = await manager.acquire({ candidate, profile: admitted, stateDirectory: state });
    first.release();
    first.release();
    first.release();

    // A double release must not drop the other holder's reference.
    const receipt = await second.session.hover({ path: "src/main.ts", line: 1, character: 30 });
    expect(receipt.execution_status).toBe("OK");
    second.release();
  }, 120_000);

  it("does not cache a runtime that failed to start", async () => {
    const { candidate, profile: admitted, manager } = await scenario();

    await expect(manager.acquire({
      candidate,
      profile: admitted,
      // An unusable state directory makes session creation fail.
      stateDirectory: "/proc/review-lsp-cannot-exist",
    })).rejects.toThrow();

    expect(manager.liveRuntimeCount).toBe(0);
  }, 120_000);

  it("refuses to hand out runtimes after disposal", async () => {
    const { candidate, profile: admitted, state, manager } = await scenario();
    await manager.dispose();

    await expect(manager.acquire({ candidate, profile: admitted, stateDirectory: state }))
      .rejects.toThrow(/LSP_CANCELLED/);
  }, 120_000);
});
