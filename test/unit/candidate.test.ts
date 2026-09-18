import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate, verifyCandidateIntegrity } from "../../src/core/candidate.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createTypeScriptAbRepo } from "../helpers/git.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate preparation", () => {
  it("materializes exact commit bytes independently of the live checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-candidate-"));
    roots.push(root);
    const { repo, a, b } = await createTypeScriptAbRepo(root);
    expect(a).not.toBe(b);

    const candidate = await prepareCandidate({ repo, commit: a, stateDirectory: join(root, "state") });
    candidates.push(candidate);
    expect(candidate.commit_oid).toBe(a);
    expect(await readFile(join(candidate.source_root, "src", "value.ts"), "utf8")).toContain("string");
    expect(await readFile(join(repo, "src", "value.ts"), "utf8")).toContain("number");
    await verifyCandidateIntegrity(candidate);
  });

  it("invalidates a trusted-local candidate if an owner mutates its bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-mutation-"));
    roots.push(root);
    const { repo, a } = await createTypeScriptAbRepo(root);
    const candidate = await prepareCandidate({ repo, commit: a, stateDirectory: join(root, "state") });
    candidates.push(candidate);
    const path = join(candidate.source_root, "src", "value.ts");
    await chmod(path, 0o644);
    await writeFile(path, "export const value = false;\n");
    await expect(verifyCandidateIntegrity(candidate)).rejects.toThrow(/CANDIDATE_INTEGRITY_INVALID/);
  });
});
