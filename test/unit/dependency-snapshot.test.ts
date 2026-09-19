import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { acquireDependencies } from "../../src/core/dependency-acquisition.js";
import { deriveDependencyInputs } from "../../src/core/dependency-inputs.js";
import { scanDependencyTree } from "../../src/core/dependency-tree.js";
import {
  publishDependencySnapshot,
  removeDependencySnapshot,
  verifyDependencySnapshot,
} from "../../src/core/dependency-snapshot.js";
import type { CandidateDescriptor, DependencyInputSet, DependencySnapshotDescriptor } from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
const snapshots: DependencySnapshotDescriptor[] = [];
const networkTests = process.env.REVIEW_LSP_NETWORK_TESTS === "1";

afterEach(async () => {
  await Promise.all(snapshots.splice(0).map((snapshot) => removeDependencySnapshot(snapshot).catch(() => undefined)));
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function scenario(): Promise<{ candidate: CandidateDescriptor; inputs: DependencyInputSet; state: string }> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-snapshot-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root);
  const state = join(root, "state");
  const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
  candidates.push(candidate);
  return { candidate, inputs: await deriveDependencyInputs(candidate), state };
}

describe("dependency snapshot publication", () => {
  it("refuses to publish when the store cannot satisfy the lockfile", async () => {
    const { candidate, inputs, state } = await scenario();
    // Publication is strictly offline. Reaching the network here would hide an acquisition
    // inside an operation whose output is admitted as evidence.
    await expect(publishDependencySnapshot({ candidate, inputs, stateDirectory: state }))
      .rejects.toThrow(/DEPENDENCY_ACQUISITION_REQUIRED/);
  }, 300_000);

  it.runIf(networkTests)("publishes a sealed, verifiable snapshot after acquisition", async () => {
    const { candidate, inputs, state } = await scenario();
    const acquired = await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION" });
    expect(acquired.state).toBe("SATISFIED");

    const snapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
    snapshots.push(snapshot);

    expect(snapshot.snapshot_id).toMatch(/^depsnap_[0-9a-f]{32}$/);
    expect(snapshot.input_set_id).toBe(inputs.input_set_id);
    expect(snapshot.network_policy).toBe("OFFLINE");
    expect(snapshot.script_policy).toBe("IGNORE_SCRIPTS");
    expect(snapshot.dependency_graph).toBe("INCLUDES_DEV");
    expect(snapshot.file_count).toBeGreaterThan(0);
    await verifyDependencySnapshot(snapshot);

    // The dev-only dependency must be present: a production-only graph would drop exactly the
    // type packages the semantic environment needs.
    const installed = await readdir(join(snapshot.dependency_root, "node_modules"));
    expect(installed).toContain("is-number");
  }, 900_000);

  it.runIf(networkTests)("seals the published tree read-only", async () => {
    const { candidate, inputs, state } = await scenario();
    await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION" });
    const snapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
    snapshots.push(snapshot);

    const info = await stat(join(snapshot.dependency_root, "node_modules"));
    expect(info.mode & 0o222).toBe(0);
  }, 900_000);

  it.runIf(networkTests)("invalidates a snapshot whose bytes were altered after sealing", async () => {
    const { candidate, inputs, state } = await scenario();
    await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION" });
    const snapshot = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
    snapshots.push(snapshot);
    await verifyDependencySnapshot(snapshot);

    // Tamper with real dependency bytes, not with metadata: the point is that altering a
    // package the semantic environment would read invalidates the admission.
    const target = join(snapshot.dependency_root, "node_modules", "is-number", "index.js");
    const directory = join(snapshot.dependency_root, "node_modules", ".pnpm", "is-number@7.0.0", "node_modules", "is-number");
    await chmod(directory, 0o755);
    await chmod(join(directory, "index.js"), 0o644);
    await writeFile(join(directory, "index.js"), "module.exports = () => 'tampered';\n");
    expect(target).toContain("is-number");

    await expect(verifyDependencySnapshot(snapshot)).rejects.toThrow(/DEPENDENCY_SNAPSHOT_INVALID/);
  }, 900_000);

  it.runIf(networkTests)("gives the same identity to a republished identical snapshot", async () => {
    const { candidate, inputs, state } = await scenario();
    await acquireDependencies({ candidate, inputs, stateDirectory: state, networkPolicy: "EXPLICIT_ACQUISITION" });

    const first = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });
    snapshots.push(first);
    const second = await publishDependencySnapshot({ candidate, inputs, stateDirectory: state });

    if (second.tree_manifest_sha256 !== first.tree_manifest_sha256) {
      // Name what actually diverged; a bare hash mismatch says nothing about the cause.
      const a = new Map((await scanDependencyTree(first.dependency_root)).entries.map((e) => [e.path, JSON.stringify(e)]));
      const b = new Map((await scanDependencyTree(second.dependency_root)).entries.map((e) => [e.path, JSON.stringify(e)]));
      const differing = [...a.keys()].filter((path) => b.has(path) && a.get(path) !== b.get(path));
      const onlyFirst = [...a.keys()].filter((path) => !b.has(path));
      const onlySecond = [...b.keys()].filter((path) => !a.has(path));
      throw new Error(`snapshot trees diverged: differing=${JSON.stringify(differing)} onlyFirst=${JSON.stringify(onlyFirst)} onlySecond=${JSON.stringify(onlySecond)}`);
    }
    expect(second.snapshot_id).toBe(first.snapshot_id);
    expect(second.tree_manifest_sha256).toBe(first.tree_manifest_sha256);
  }, 900_000);
});
