import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { validateReceipt } from "../../src/core/receipts.js";
import { SemanticSession } from "../../src/core/session.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createTypeScriptAbRepo } from "../helpers/git.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript A/B candidate semantics", () => {
  it("returns A semantics while the live checkout is B, with candidate-bound receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-ab-"));
    roots.push(root);
    const { repo, a, b } = await createTypeScriptAbRepo(root);
    const state = join(root, "state");

    const candidateA = await prepareCandidate({ repo, commit: a, stateDirectory: state });
    const candidateB = await prepareCandidate({ repo, commit: b, stateDirectory: state });
    candidates.push(candidateA, candidateB);
    const profile = await createTypeScriptProfile();

    const lineText = 'export const observed = "🧪", result = value;';
    const character = lineText.indexOf("value");
    const sessionA = await SemanticSession.create({ candidate: candidateA, profile, stateDirectory: state });
    const sessionB = await SemanticSession.create({ candidate: candidateB, profile, stateDirectory: state });
    try {
      const hoverA = await sessionA.hover({ path: "src/main.ts", line: 1, character });
      const hoverB = await sessionB.hover({ path: "src/main.ts", line: 1, character });
      validateReceipt(hoverA);
      validateReceipt(hoverB);

      expect(hoverA.candidate.commit_oid).toBe(a);
      expect(hoverB.candidate.commit_oid).toBe(b);
      expect(JSON.stringify(hoverA.result)).toContain("string");
      expect(JSON.stringify(hoverB.result)).toContain("number");
      expect(hoverA.environment_binding).toBe("VERIFIED");
      expect(hoverA.source_binding).toBe("VERIFIED");
      expect(hoverA.document.position_encoding).toBe("utf-16");

      const definition = await sessionA.definition({ path: "src/main.ts", line: 1, character });
      validateReceipt(definition);
      const definitionResult = definition.result as { bindings?: Array<{ classification?: string; path?: string }> };
      expect(definitionResult.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ classification: "SOURCE_CANDIDATE", path: "src/value.ts" }),
      ]));
    } finally {
      await Promise.all([sessionA.close(), sessionB.close()]);
    }
  });

  it("refuses to emit a successful query after candidate mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-ab-mutate-"));
    roots.push(root);
    const { repo, a } = await createTypeScriptAbRepo(root);
    const state = join(root, "state");
    const candidate = await prepareCandidate({ repo, commit: a, stateDirectory: state });
    candidates.push(candidate);
    const profile = await createTypeScriptProfile();
    const session = await SemanticSession.create({ candidate, profile, stateDirectory: state });
    try {
      const path = join(candidate.source_root, "src", "value.ts");
      await chmod(path, 0o644);
      await writeFile(path, "export const value = false;\n");
      await expect(session.hover({ path: "src/main.ts", line: 1, character: 41 }))
        .rejects.toThrow(/CANDIDATE_INTEGRITY_INVALID/);
    } finally {
      await session.close();
    }
  });
});
