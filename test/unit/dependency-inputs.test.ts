import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { deriveDependencyInputs } from "../../src/core/dependency-inputs.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createPnpmFixture, type PnpmFixtureShape } from "../helpers/pnpm-fixture.js";

const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function candidateFor(shape: PnpmFixtureShape = {}): Promise<CandidateDescriptor> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-depinputs-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root, shape);
  const candidate = await prepareCandidate({ repo: fixture.repo, commit: fixture.commit, stateDirectory: join(root, "state") });
  candidates.push(candidate);
  return candidate;
}

describe("dependency input derivation", () => {
  it("binds every file that can change resolution", async () => {
    const inputs = await deriveDependencyInputs(await candidateFor());

    const paths = inputs.files.map((file) => file.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("pnpm-lock.yaml");
    expect(paths).toContain("pnpm-workspace.yaml");
    expect(paths).toContain("packages/app/package.json");
    for (const file of inputs.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.byte_count).toBeGreaterThan(0);
    }
    expect(inputs.package_manager_version).toBe("10.20.0");
    expect(inputs.workspace_manifests).toEqual(["packages/app/package.json"]);
    expect(inputs.input_set_id).toMatch(/^depin_[0-9a-f]{32}$/);
  });

  it("gives the same identity to identical inputs and a different one to changed inputs", async () => {
    const first = await deriveDependencyInputs(await candidateFor());
    const second = await deriveDependencyInputs(await candidateFor());
    expect(second.input_set_id).toBe(first.input_set_id);

    const changed = await deriveDependencyInputs(await candidateFor({ rootTypeScript: "7.0.2" }));
    expect(changed.input_set_id).not.toBe(first.input_set_id);
    // Three independent Git fixtures; generation dominates the runtime.
  }, 60_000);

  it("records the project TypeScript declaration without admitting it", async () => {
    const inputs = await deriveDependencyInputs(await candidateFor({ rootTypeScript: "7.0.2" }));
    expect(inputs.project_toolchain.root_typescript).toBe("7.0.2");
  });

  it("binds referenced patch files", async () => {
    const inputs = await deriveDependencyInputs(await candidateFor({ withPatch: true }));
    expect(inputs.patches.map((patch) => patch.path)).toEqual(["patches/is-number@7.0.0.patch"]);
    expect(inputs.files.map((file) => file.path)).toContain("patches/is-number@7.0.0.patch");
  });

  it("refuses a patch reference that is not part of the candidate", async () => {
    await expect(deriveDependencyInputs(await candidateFor({ withDanglingPatch: true })))
      .rejects.toThrow(/DEPENDENCY_INPUT_INVALID/);
  });

  it("refuses a candidate without a lockfile", async () => {
    await expect(deriveDependencyInputs(await candidateFor({ withoutLockfile: true })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED/);
  });

  it("refuses a candidate that does not pin an exact pnpm version", async () => {
    await expect(deriveDependencyInputs(await candidateFor({ rawPackageManager: "pnpm@^10" })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED/);
  });

  it("fails closed for valid pnpm workspace glob syntax outside the admitted subset", async () => {
    await expect(deriveDependencyInputs(await candidateFor({ workspaceGlobs: ["packages/{app,other}"] })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED.*unsupported pnpm glob syntax/);
  });

  it("still admits literal, single-star and recursive-star workspace patterns", async () => {
    const literal = await deriveDependencyInputs(await candidateFor({ workspaceGlobs: ["packages/app"] }));
    expect(literal.workspace_manifests).toEqual(["packages/app/package.json"]);

    const single = await deriveDependencyInputs(await candidateFor({ workspaceGlobs: ["packages/*"] }));
    expect(single.workspace_manifests).toEqual(["packages/app/package.json"]);

    const recursive = await deriveDependencyInputs(await candidateFor({ workspaceGlobs: ["packages/**"] }));
    expect(recursive.workspace_manifests).toEqual(["packages/app/package.json"]);
  });

  it("refuses an unsupported lockfile version", async () => {
    const lockfile = "lockfileVersion: '6.0'\n\nimporters:\n\n  .: {}\n";
    await expect(deriveDependencyInputs(await candidateFor({ lockfile })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED/);
  });

  it("admits only safe .npmrc keys", async () => {
    const allowed = await deriveDependencyInputs(await candidateFor({ npmrc: "node-linker=isolated\n" }));
    expect(allowed.npmrc_settings["node-linker"]).toBe("isolated");

    // A registry override redirects where packages come from, so it cannot be silently kept
    // and cannot be silently dropped either.
    await expect(deriveDependencyInputs(await candidateFor({ npmrc: "registry=https://evil.invalid/\n" })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED/);

    await expect(deriveDependencyInputs(await candidateFor({ npmrc: "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n" })))
      .rejects.toThrow(/DEPENDENCY_UNSUPPORTED/);
  });
});
