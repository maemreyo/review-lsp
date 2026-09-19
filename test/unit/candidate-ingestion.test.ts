import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate, verifyCandidateIntegrity } from "../../src/core/candidate.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createGitShim, type GitShimMode } from "../helpers/git-shim.js";
import { createMonorepoRepo } from "../helpers/monorepo.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Runs `body` with a shimmed `git` first on PATH, restoring PATH afterwards. */
async function withGitShim<T>(mode: GitShimMode, body: () => Promise<T>): Promise<T> {
  const shimRoot = await scratch("review-lsp-shim-");
  const directory = await createGitShim(join(shimRoot, "bin"), mode);
  const originalPath = process.env.PATH;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = originalPath;
  }
}

describe("candidate ingestion", () => {
  it("reproduces the recorded P0 candidate identity exactly", async () => {
    const baseline = JSON.parse(
      await readFile(join(repoRoot, "docs", "baselines", "P0_CANDIDATE_BASELINE.json"), "utf8"),
    ) as { identity: { content: Record<string, unknown> } };
    const expected = baseline.identity.content;

    const root = await scratch("review-lsp-parity-");
    const fixture = await createMonorepoRepo(root);
    const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") });
    candidates.push(candidate);

    // Batch ingestion may change what preparation costs; it may not change what it produces.
    // `candidate_id`/`repository_identity` hash the absolute git directory, so they are
    // deliberately excluded here: they differ between temporary checkouts by design.
    expect(candidate.schema_version).toBe(expected.schema_version);
    expect(candidate.git_object_format).toBe(expected.git_object_format);
    expect(candidate.commit_oid).toBe(expected.commit_oid);
    expect(candidate.tree_oid).toBe(expected.tree_oid);
    expect(candidate.source_manifest_sha256).toBe(expected.source_manifest_sha256);
    expect(candidate.isolation).toBe(expected.isolation);
    expect(candidate.entries.length).toBe(expected.entry_count);
    expect(candidate.entries.reduce((total, entry) => total + entry.byte_count, 0)).toBe(expected.tracked_bytes);
    // Generating the full 522-entry baseline fixture dominates this test's runtime.
  }, 60_000);

  it("preserves non-ASCII paths, executable modes and symlink entries", async () => {
    const root = await scratch("review-lsp-modes-");
    const fixture = await createMonorepoRepo(root, { packages: 2, modulesPerPackage: 2, paddingBytesPerModule: 0 });
    const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") });
    candidates.push(candidate);

    const unicode = candidate.entries.find((entry) => entry.path === "docs-ünïcode.md");
    expect(unicode?.mode).toBe("100644");

    const executable = candidate.entries.find((entry) => entry.path === "scripts/build.sh");
    expect(executable?.mode).toBe("100755");
    expect((await lstat(join(candidate.source_root, "scripts/build.sh"))).mode & 0o111).toBeGreaterThan(0);

    const link = candidate.entries.find((entry) => entry.path === "scripts/entry.ts");
    expect(link?.kind).toBe("symlink");
    expect(link?.mode).toBe("120000");
    expect(link?.symlink_target).toBe("../packages/pkg-0/src/index.ts");
    expect(await readlink(join(candidate.source_root, "scripts/entry.ts"))).toBe("../packages/pkg-0/src/index.ts");

    await verifyCandidateIntegrity(candidate);
  });

  it("enforces resource limits before reading candidate objects", async () => {
    const root = await scratch("review-lsp-limits-");
    const fixture = await createMonorepoRepo(root, { packages: 2, modulesPerPackage: 3, paddingBytesPerModule: 0 });
    const state = join(root, "state");

    await expect(
      prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state, limits: { max_entries: 3 } }),
    ).rejects.toThrow(/CANDIDATE_RESOURCE_LIMIT/);
    await expect(
      prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state, limits: { max_file_bytes: 8 } }),
    ).rejects.toThrow(/CANDIDATE_RESOURCE_LIMIT/);
    await expect(
      prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state, limits: { max_total_bytes: 64 } }),
    ).rejects.toThrow(/CANDIDATE_RESOURCE_LIMIT/);
  });

  it("reuses a retained candidate without re-reading its objects", async () => {
    const root = await scratch("review-lsp-warm-");
    const fixture = await createMonorepoRepo(root, { packages: 3, modulesPerPackage: 8, paddingBytesPerModule: 0 });
    const state = join(root, "state");

    const cold = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
    candidates.push(cold);

    // With the candidate retained, a shim that cannot serve any object must still succeed:
    // proof that the warm path did not fall through to re-reading blobs.
    const warm = await withGitShim("premature-exit", () =>
      prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state }));

    expect(warm.candidate_id).toBe(cold.candidate_id);
    expect(warm.source_manifest_sha256).toBe(cold.source_manifest_sha256);
  });

  it("re-reads objects when the retained candidate no longer satisfies the caller's limits", async () => {
    const root = await scratch("review-lsp-warm-limits-");
    const fixture = await createMonorepoRepo(root, { packages: 2, modulesPerPackage: 3, paddingBytesPerModule: 0 });
    const state = join(root, "state");

    const cold = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state });
    candidates.push(cold);

    await expect(
      prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: state, limits: { max_entries: 2 } }),
    ).rejects.toThrow(/CANDIDATE_RESOURCE_LIMIT/);
  });

  it("rejects a batch response whose declared size disagrees with the tree", async () => {
    const root = await scratch("review-lsp-size-");
    const fixture = await createMonorepoRepo(root, { packages: 1, modulesPerPackage: 1, paddingBytesPerModule: 0 });
    await expect(
      withGitShim("oversized-header", () =>
        prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") })),
    ).rejects.toThrow(/CANDIDATE_INTEGRITY_INVALID|GIT_COMMAND_FAILED/);
  });

  it("rejects a malformed batch response header", async () => {
    const root = await scratch("review-lsp-malformed-");
    const fixture = await createMonorepoRepo(root, { packages: 1, modulesPerPackage: 1, paddingBytesPerModule: 0 });
    await expect(
      withGitShim("malformed-header", () =>
        prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") })),
    ).rejects.toThrow(/GIT_COMMAND_FAILED/);
  });

  it("rejects a premature Git exit instead of producing a short candidate", async () => {
    const root = await scratch("review-lsp-premature-");
    const fixture = await createMonorepoRepo(root, { packages: 1, modulesPerPackage: 1, paddingBytesPerModule: 0 });
    await expect(
      withGitShim("premature-exit", () =>
        prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") })),
    ).rejects.toThrow(/GIT_COMMAND_FAILED/);
  });

  it("rejects a truncated batch payload", async () => {
    const root = await scratch("review-lsp-truncated-");
    const fixture = await createMonorepoRepo(root, { packages: 1, modulesPerPackage: 1, paddingBytesPerModule: 0 });
    await expect(
      withGitShim("truncated-payload", () =>
        prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") })),
    ).rejects.toThrow(/GIT_COMMAND_FAILED|CANDIDATE_INTEGRITY_INVALID/);
  });
});
