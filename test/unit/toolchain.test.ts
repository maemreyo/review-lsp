import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import {
  alignmentBlocksStrongAdmission,
  assessToolchainAlignment,
  resolveProjectForDocument,
  resolveProjectToolchain,
  resolvingProjectIdentity,
} from "../../src/core/toolchain.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function candidateFor(rootTypeScript?: string): Promise<CandidateDescriptor> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-toolchain-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root, rootTypeScript ? { rootTypeScript } : {});
  const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") });
  candidates.push(candidate);
  return candidate;
}

const base = {
  projectVersionSource: "MANIFEST_DECLARATION" as const,
  engineVersion: "6.0.3",
  engineIsProjectAdmitted: false,
};

describe("toolchain alignment", () => {
  it("reports MISMATCH when the project and the answering engine are different generations", () => {
    // The dogfood gap: the candidate declares TypeScript 7, a native implementation with its
    // own LSP, while Review-LSP's profile answers with TypeScript 6.
    const assessment = assessToolchainAlignment({ ...base, projectVersion: "7.0.2" });

    expect(assessment.alignment).toBe("MISMATCH");
    expect(assessment.reason).toMatch(/different TypeScript generations/);
    expect(alignmentBlocksStrongAdmission(assessment.alignment)).toBe(true);
  });

  it("never claims EXACT_PROJECT while the engine is not the project's own admitted artifact", () => {
    // Same version on both sides is still not project alignment: the bytes that answered are
    // Review-LSP's, and executing the candidate's engine is a separate trust decision.
    const assessment = assessToolchainAlignment({ ...base, projectVersion: "6.0.3" });

    expect(assessment.alignment).toBe("COMPATIBILITY_PROFILE");
    expect(assessment.reason).toMatch(/not the project's own admitted engine/);
    expect(alignmentBlocksStrongAdmission(assessment.alignment)).toBe(false);
  });

  it("reaches EXACT_PROJECT only when the project's own admitted engine answered", () => {
    const assessment = assessToolchainAlignment({
      ...base,
      projectVersion: "6.0.3",
      engineIsProjectAdmitted: true,
    });
    expect(assessment.alignment).toBe("EXACT_PROJECT");
    expect(assessment.reason).toBeNull();
  });

  it("treats an absent declaration as a compatibility profile rather than a contradiction", () => {
    const assessment = assessToolchainAlignment({
      ...base,
      projectVersion: null,
      projectVersionSource: "ABSENT",
    });
    expect(assessment.alignment).toBe("COMPATIBILITY_PROFILE");
    expect(alignmentBlocksStrongAdmission(assessment.alignment)).toBe(false);
  });

  it("reports UNKNOWN when a declared version cannot be interpreted", () => {
    const assessment = assessToolchainAlignment({ ...base, projectVersion: "next" });
    expect(assessment.alignment).toBe("UNKNOWN");
    expect(alignmentBlocksStrongAdmission(assessment.alignment)).toBe(true);
  });

  it("accepts a range declaration by its generation", () => {
    expect(assessToolchainAlignment({ ...base, projectVersion: "^6.1.0" }).alignment).toBe("COMPATIBILITY_PROFILE");
    expect(assessToolchainAlignment({ ...base, projectVersion: "^7.0.0" }).alignment).toBe("MISMATCH");
  });
});

describe("resolving project", () => {
  it("binds config path, config bytes, and ownership evidence into resolving-project identity", () => {
    const a = resolvingProjectIdentity({
      state: "RESOLVED",
      config_path: "packages/a/tsconfig.json",
      config_sha256: "f".repeat(64),
      project_root: "packages/a",
    });
    const b = resolvingProjectIdentity({
      state: "RESOLVED",
      config_path: "packages/b/tsconfig.json",
      config_sha256: "f".repeat(64),
      project_root: "packages/b",
    });

    expect(a).not.toBe(b);

    const ownershipA = resolvingProjectIdentity({
      state: "RESOLVED",
      config_path: "packages/a/tsconfig.json",
      config_sha256: "f".repeat(64),
      project_root: "packages/a",
      ownership_sha256: "a".repeat(64),
    });
    const ownershipB = resolvingProjectIdentity({
      state: "RESOLVED",
      config_path: "packages/a/tsconfig.json",
      config_sha256: "f".repeat(64),
      project_root: "packages/a",
      ownership_sha256: "b".repeat(64),
    });
    expect(ownershipA).not.toBe(ownershipB);
  });

  it("does not infer project ownership from directory proximity", async () => {
    const candidate = await candidateFor();
    const resolved = await resolveProjectForDocument(candidate, "packages/app/src/index.ts");

    // The fixture has no admitted membership covering this path, so proximity cannot invent an owner.
    expect(resolved.state).toBe("UNRESOLVED");
  });

  it("reads the project TypeScript declaration from the candidate manifest", async () => {
    const candidate = await candidateFor("7.0.2");
    const toolchain = await resolveProjectToolchain({ candidate, snapshot: null, projectRoot: "" });

    expect(toolchain.version).toBe("7.0.2");
    expect(toolchain.source).toBe("MANIFEST_DECLARATION");
  });

  it("reports ABSENT when the candidate pins no TypeScript", async () => {
    const candidate = await candidateFor();
    const toolchain = await resolveProjectToolchain({ candidate, snapshot: null, projectRoot: "" });

    expect(toolchain.version).toBeNull();
    expect(toolchain.source).toBe("ABSENT");
  });
});
