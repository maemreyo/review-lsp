import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { assertCoordinateExpectation, buildCoordinateContext } from "../../src/core/coordinate.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { SemanticSession } from "../../src/core/session.js";
import type { CandidateDescriptor, TypeScriptProfile } from "../../src/core/types.js";
import { createTypeScriptAbRepo } from "../helpers/git.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
let profile: TypeScriptProfile | undefined;

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

const source = [
  "export const alpha = 1;",
  "export const beta = 2;",
  "",
].join("\n");

describe("coordinate context", () => {
  it("reports the bound line and the identifier at the requested column", () => {
    const context = buildCoordinateContext({ text: source, line: 1, character: 13 });

    expect(context.line_text).toBe("export const beta = 2;");
    expect(context.token).toBe("beta");
    expect(context.line_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports no identifier when the column falls on punctuation or whitespace", () => {
    expect(buildCoordinateContext({ text: source, line: 1, character: 18 }).token).toBeNull();
  });

  it("refuses a line outside the document rather than reporting an empty context", () => {
    expect(() => buildCoordinateContext({ text: source, line: 99, character: 0 }))
      .toThrow(/CANDIDATE_PATH_INVALID/);
  });
});

describe("coordinate expectation", () => {
  const context = buildCoordinateContext({ text: source, line: 1, character: 13 });

  it("accepts a request whose stated target matches", () => {
    expect(() => assertCoordinateExpectation(context, { token: "beta" })).not.toThrow();
    expect(() => assertCoordinateExpectation(context, { line_contains: "beta = 2" })).not.toThrow();
    expect(() => assertCoordinateExpectation(context, { line_sha256: context.line_sha256 })).not.toThrow();
  });

  it("refuses a request aimed one line off", () => {
    // The dogfood failure: a hover with sound provenance, about the wrong symbol. Nothing in
    // the evidence could have caught it, because nothing about the evidence was wrong.
    const offByOne = buildCoordinateContext({ text: source, line: 0, character: 13 });
    expect(() => assertCoordinateExpectation(offByOne, { token: "beta" }))
      .toThrow(/COORDINATE_EXPECTATION_UNMET/);
  });

  it("refuses when the line digest does not match", () => {
    expect(() => assertCoordinateExpectation(context, { line_sha256: "0".repeat(64) }))
      .toThrow(/COORDINATE_EXPECTATION_UNMET/);
  });

  it("does nothing when the caller states no expectation", () => {
    expect(() => assertCoordinateExpectation(context, undefined)).not.toThrow();
  });
});

describe("guarded queries", () => {
  it("carries the bound context into the receipt and refuses a mis-aimed request", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-coordinate-"));
    roots.push(root);
    const { repo, a } = await createTypeScriptAbRepo(root);
    const state = join(root, "state");
    const candidate = await prepareCandidate({ repo, commit: a, stateDirectory: state });
    candidates.push(candidate);
    profile ??= await createTypeScriptProfile();

    const session = await SemanticSession.create({ candidate, profile, stateDirectory: state });
    try {
      const receipt = await session.hover({ path: "src/value.ts", line: 0, character: 13 });
      expect(receipt.document.context.token).toBe("value");
      expect(receipt.document.context.line_text).toContain("export const value");

      // Matching an expectation must not change the evidence, only confirm the aim.
      const guarded = await session.hover({
        path: "src/value.ts", line: 0, character: 13, expect: { token: "value" },
      });
      expect(guarded.environment_binding).toBe(receipt.environment_binding);
      expect(guarded.source_binding).toBe(receipt.source_binding);

      await expect(session.hover({
        path: "src/value.ts", line: 0, character: 13, expect: { token: "somethingElse" },
      })).rejects.toThrow(/COORDINATE_EXPECTATION_UNMET/);

      const guardedReferences = await session.references({
        path: "src/value.ts",
        line: 0,
        character: 13,
        includeDeclaration: true,
        expect: { token: "value" },
      });
      expect(guardedReferences.document.context.token).toBe("value");
      expect(guardedReferences.request.include_declaration).toBe(true);
      await expect(session.references({
        path: "src/value.ts",
        line: 0,
        character: 13,
        includeDeclaration: false,
        expect: { token: "somethingElse" },
      })).rejects.toThrow(/COORDINATE_EXPECTATION_UNMET/);
    } finally {
      await session.close();
    }
  }, 120_000);
});
