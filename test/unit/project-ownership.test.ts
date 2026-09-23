import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { buildEnvironmentManifest } from "../../src/core/environment.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { analyzeProjectOwnership, resolveProjectOwner } from "../../src/core/project-ownership.js";
import type { CandidateDescriptor } from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function candidateWith(files: Record<string, string>): Promise<CandidateDescriptor> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-project-ownership-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root);
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(fixture.repo, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }
  await execFileAsync("git", ["-C", fixture.repo, "add", "-A"]);
  await execFileAsync("git", ["-C", fixture.repo, "commit", "-qm", "project ownership fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", fixture.repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  const candidate = await prepareCandidate({
    repo: fixture.repo,
    commit: stdout.trim(),
    stateDirectory: join(root, "state"),
  });
  candidates.push(candidate);
  return candidate;
}

function config(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) + "\n";
}

describe("project ownership admission", () => {
  it("resolves explicit files membership and leaves siblings unowned", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ files: ["packages/app/src/index.ts"] }),
      "packages/app/src/other.ts": "export const other = 2;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(resolveProjectOwner(analysis, "packages/app/src/index.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "tsconfig.json",
    });
    expect(resolveProjectOwner(analysis, "packages/app/src/other.ts").state).toBe("UNRESOLVED");
  });

  it("treats files:[] as an explicit empty membership rule", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ files: [] }),
      "src/a.ts": "export const a = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(resolveProjectOwner(analysis, "src/a.ts").state).toBe("UNRESOLVED");
  });

  it("filters include membership by TypeScript-supported extensions when allowJs is false", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["src/**/*"] }),
      "src/a.ts": "export const a = 1;\n",
      "src/b.tsx": "export const b = 1;\n",
      "src/c.mts": "export const c = 1;\n",
      "src/d.cts": "export const d = 1;\n",
      "src/e.js": "export const e = 1;\n",
      "src/f.jsx": "export const f = 1;\n",
      "src/g.mjs": "export const g = 1;\n",
      "src/h.cjs": "export const h = 1;\n",
      "src/i.json": "{}\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const root = analysis.evidence.configs.find((entry) => entry.path === "tsconfig.json");
    expect(root?.effective_allow_js).toEqual({
      value: false,
      origin_config_path: null,
      source: "TYPESCRIPT_DEFAULT",
    });
    for (const path of ["src/a.ts", "src/b.tsx", "src/c.mts", "src/d.cts"]) {
      expect(resolveProjectOwner(analysis, path)).toMatchObject({
        state: "RESOLVED",
        config_path: "tsconfig.json",
      });
    }
    for (const path of ["src/e.js", "src/f.jsx", "src/g.mjs", "src/h.cjs", "src/i.json"]) {
      expect(resolveProjectOwner(analysis, path).state).toBe("UNRESOLVED");
    }
  });

  it("admits JS-family include membership only when effective allowJs is true", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({
        compilerOptions: { allowJs: true },
        include: ["src/**/*"],
      }),
      "src/a.js": "export const a = 1;\n",
      "src/b.jsx": "export const b = 1;\n",
      "src/c.mjs": "export const c = 1;\n",
      "src/d.cjs": "export const d = 1;\n",
      "src/e.json": "{}\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const root = analysis.evidence.configs.find((entry) => entry.path === "tsconfig.json");
    expect(root?.effective_allow_js).toEqual({
      value: true,
      origin_config_path: "tsconfig.json",
      source: "EXPLICIT",
    });
    for (const path of ["src/a.js", "src/b.jsx", "src/c.mjs", "src/d.cjs"]) {
      expect(resolveProjectOwner(analysis, path).state).toBe("RESOLVED");
    }
    expect(resolveProjectOwner(analysis, "src/e.json").state).toBe("UNRESOLVED");
  });

  it("models jsconfig implicit allowJs and explicit override", async () => {
    const inherited = await candidateWith({
      "jsconfig.json": config({ include: ["src/**/*"] }),
      "src/a.js": "export const a = 1;\n",
    });
    const inheritedAnalysis = await analyzeProjectOwnership(inherited);
    expect(inheritedAnalysis.evidence.configs.find((entry) => entry.path === "jsconfig.json")?.effective_allow_js)
      .toEqual({
        value: true,
        origin_config_path: "jsconfig.json",
        source: "JSCONFIG_DEFAULT",
      });
    expect(resolveProjectOwner(inheritedAnalysis, "src/a.js").state).toBe("RESOLVED");

    const overridden = await candidateWith({
      "jsconfig.json": config({
        compilerOptions: { allowJs: false },
        include: ["src/**/*"],
      }),
      "src/a.js": "export const a = 1;\n",
    });
    const overriddenAnalysis = await analyzeProjectOwnership(overridden);
    expect(overriddenAnalysis.evidence.configs.find((entry) => entry.path === "jsconfig.json")?.effective_allow_js)
      .toEqual({
        value: false,
        origin_config_path: "jsconfig.json",
        source: "EXPLICIT",
      });
    expect(resolveProjectOwner(overriddenAnalysis, "src/a.js").state).toBe("UNRESOLVED");
  });

  it("inherits allowJs through relative extends and lets jsconfig default override an inherited false", async () => {
    const inherited = await candidateWith({
      "configs/tsconfig.base.json": config({
        compilerOptions: { allowJs: true },
        include: ["../shared/**/*"],
      }),
      "packages/app/tsconfig.json": config({ extends: "../../configs/tsconfig.base.json" }),
      "shared/a.js": "export const a = 1;\n",
    });
    const inheritedAnalysis = await analyzeProjectOwnership(inherited);
    const app = inheritedAnalysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.json");
    expect(app?.effective_allow_js).toEqual({
      value: true,
      origin_config_path: "configs/tsconfig.base.json",
      source: "EXPLICIT",
    });
    expect(resolveProjectOwner(inheritedAnalysis, "shared/a.js").state).toBe("RESOLVED");

    const jsconfig = await candidateWith({
      "configs/tsconfig.base.json": config({
        compilerOptions: { allowJs: false },
        include: ["../shared/**/*"],
      }),
      "packages/app/jsconfig.json": config({ extends: "../../configs/tsconfig.base.json" }),
      "shared/a.js": "export const a = 1;\n",
    });
    const jsconfigAnalysis = await analyzeProjectOwnership(jsconfig);
    const jsApp = jsconfigAnalysis.evidence.configs.find((entry) => entry.path === "packages/app/jsconfig.json");
    expect(jsApp?.effective_allow_js).toEqual({
      value: true,
      origin_config_path: "packages/app/jsconfig.json",
      source: "JSCONFIG_DEFAULT",
    });
    expect(resolveProjectOwner(jsconfigAnalysis, "shared/a.js").state).toBe("RESOLVED");
  });

  it("keeps explicit files membership independent of include extension filtering", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({
        compilerOptions: { allowJs: false },
        files: ["src/a.js", "src/b.json"],
      }),
      "src/a.js": "export const a = 1;\n",
      "src/b.json": "{}\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(resolveProjectOwner(analysis, "src/a.js").state).toBe("RESOLVED");
    expect(resolveProjectOwner(analysis, "src/b.json").state).toBe("RESOLVED");
  });

  it.each([
    ["literal", "src/exact.ts", "src/exact.ts", "src/other.ts"],
    ["single star", "src/*.ts", "src/a.ts", "src/nested/b.ts"],
    ["question", "src/file?.ts", "src/file1.ts", "src/file10.ts"],
  ])("evaluates %s include patterns from the frozen glob subset", async (_name, pattern, matched, unmatched) => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: [pattern] }),
      [matched]: "export const matched = 1;\n",
      [unmatched]: "export const unmatched = 2;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(resolveProjectOwner(analysis, matched)).toMatchObject({ state: "RESOLVED", config_path: "tsconfig.json" });
    expect(resolveProjectOwner(analysis, unmatched).state).toBe("UNRESOLVED");
  });

  it("evaluates recursive include and exclude without removing explicit files", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({
        files: ["src/forced.ts"],
        include: ["src/**/*.ts"],
        exclude: ["src/excluded/**/*.ts", "src/forced.ts"],
      }),
      "src/a.ts": "export const a = 1;\n",
      "src/nested/b.ts": "export const b = 2;\n",
      "src/excluded/c.ts": "export const c = 3;\n",
      "src/forced.ts": "export const forced = 4;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(resolveProjectOwner(analysis, "src/a.ts").state).toBe("RESOLVED");
    expect(resolveProjectOwner(analysis, "src/nested/b.ts").state).toBe("RESOLVED");
    expect(resolveProjectOwner(analysis, "src/excluded/c.ts").state).toBe("UNRESOLVED");
    expect(resolveProjectOwner(analysis, "src/forced.ts").state).toBe("RESOLVED");
  });

  it("inherits files/include/exclude independently and preserves declaration origins", async () => {
    const candidate = await candidateWith({
      "configs/tsconfig.base.json": config({
        include: ["../shared/**/*.ts"],
        exclude: ["../shared/excluded.ts"],
      }),
      "packages/app/tsconfig.json": config({
        extends: "../../configs/tsconfig.base.json",
        files: ["src/explicit.ts"],
      }),
      "shared/base.ts": "export const base = 1;\n",
      "shared/excluded.ts": "export const excluded = 1;\n",
      "packages/app/src/explicit.ts": "export const explicit = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    const base = analysis.evidence.configs.find((entry) => entry.path === "configs/tsconfig.base.json");
    const app = analysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.json");
    expect(base).toMatchObject({ routable_project: false, routing_reason: "INHERITANCE_ONLY" });
    expect(app?.effective_include?.origin_config_path).toBe("configs/tsconfig.base.json");
    expect(app?.effective_files?.origin_config_path).toBe("packages/app/tsconfig.json");
    expect(resolveProjectOwner(analysis, "shared/base.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.json",
    });
    expect(resolveProjectOwner(analysis, "shared/excluded.ts").state).toBe("UNRESOLVED");
    expect(resolveProjectOwner(analysis, "packages/app/src/explicit.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.json",
    });
  });

  it("child declarations replace only the same inherited field", async () => {
    const candidate = await candidateWith({
      "configs/tsconfig.base.json": config({
        files: ["../shared/base.ts"],
        include: ["../shared/**/*.ts"],
      }),
      "packages/app/tsconfig.json": config({
        extends: "../../configs/tsconfig.base.json",
        include: ["src/**/*.ts"],
      }),
      "shared/base.ts": "export const base = 1;\n",
      "shared/not-inherited.ts": "export const nope = 1;\n",
      "packages/app/src/local.ts": "export const local = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const app = analysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.json");
    expect(app?.effective_files?.values).toEqual(["shared/base.ts"]);
    expect(app?.effective_include?.values).toEqual(["packages/app/src/**/*.ts"]);
    expect(resolveProjectOwner(analysis, "shared/base.ts").state).toBe("RESOLVED");
    expect(resolveProjectOwner(analysis, "shared/not-inherited.ts").state).toBe("UNRESOLVED");
    expect(resolveProjectOwner(analysis, "packages/app/src/local.ts").state).toBe("RESOLVED");
  });

  it("lets a child exclude override the inherited exclude without moving the inherited include base", async () => {
    const candidate = await candidateWith({
      "configs/tsconfig.base.json": config({
        include: ["../shared/**/*.ts"],
        exclude: ["../shared/parent-excluded.ts"],
      }),
      "packages/app/tsconfig.json": config({
        extends: "../../configs/tsconfig.base.json",
        exclude: ["../../shared/child-excluded.ts"],
      }),
      "shared/parent-excluded.ts": "export const parentExcluded = 1;\n",
      "shared/child-excluded.ts": "export const childExcluded = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const app = analysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.json");
    expect(app?.effective_include?.origin_config_path).toBe("configs/tsconfig.base.json");
    expect(app?.effective_exclude?.origin_config_path).toBe("packages/app/tsconfig.json");
    expect(resolveProjectOwner(analysis, "shared/parent-excluded.ts").state).toBe("RESOLVED");
    expect(resolveProjectOwner(analysis, "shared/child-excluded.ts").state).toBe("UNRESOLVED");
  });

  it("inherits ownership through a multi-level relative extends chain", async () => {
    const candidate = await candidateWith({
      "configs/tsconfig.base.json": config({ include: ["../shared/**/*.ts"] }),
      "configs/tsconfig.middle.json": config({ extends: "./tsconfig.base.json" }),
      "packages/app/tsconfig.json": config({ extends: "../../configs/tsconfig.middle.json" }),
      "shared/a.ts": "export const a = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    const app = analysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.json");
    expect(app?.extends_chain.map((entry) => entry.path)).toEqual([
      "configs/tsconfig.middle.json",
      "configs/tsconfig.base.json",
    ]);
    expect(app?.effective_include?.origin_config_path).toBe("configs/tsconfig.base.json");
    expect(resolveProjectOwner(analysis, "shared/a.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.json",
    });
  });

  it("routes by proven membership when nearest nested config does not own the document", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["packages/**/*.ts"] }),
      "packages/app/tsconfig.json": config({ include: ["owned/**/*.ts"] }),
      "packages/app/src/index.ts": "export const nested = 1;\n",
      "packages/app/owned/yes.ts": "export const yes = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const resolved = resolveProjectOwner(analysis, "packages/app/src/index.ts");
    expect(resolved).toMatchObject({ state: "RESOLVED", config_path: "tsconfig.json" });
  });

  it("lets the root own a nested document when the child explicitly excludes it", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["packages/**/*.ts"] }),
      "packages/app/tsconfig.json": config({
        include: ["src/**/*.ts"],
        exclude: ["src/index.ts"],
      }),
      "packages/app/src/index.ts": "export const nested = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(resolveProjectOwner(analysis, "packages/app/src/index.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "tsconfig.json",
    });
  });

  it("reports ambiguity when sibling projects explicitly list the same shared file", async () => {
    const candidate = await candidateWith({
      "packages/a/tsconfig.json": config({ files: ["../../shared.ts"] }),
      "packages/b/tsconfig.json": config({ files: ["../../shared.ts"] }),
      "shared.ts": "export const shared = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const resolved = resolveProjectOwner(analysis, "shared.ts");
    expect(resolved.state).toBe("AMBIGUOUS");
    expect(resolved.candidate_configs?.map((entry) => entry.config_path)).toEqual([
      "packages/a/tsconfig.json",
      "packages/b/tsconfig.json",
    ]);
  });

  it("allows explicit files membership outside a config's immediate directory", async () => {
    const candidate = await candidateWith({
      "packages/app/tsconfig.json": config({ files: ["../../shared.ts"] }),
      "shared.ts": "export const shared = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(resolveProjectOwner(analysis, "shared.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.json",
    });
  });

  it("fails closed on overlapping root and child ownership instead of choosing nearest", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["packages/**/*.ts"] }),
      "packages/app/tsconfig.json": config({ include: ["src/**/*.ts"] }),
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const resolved = resolveProjectOwner(analysis, "packages/app/src/index.ts");
    expect(resolved.state).toBe("AMBIGUOUS");
    expect(resolved.candidate_configs?.map((entry) => entry.config_path)).toEqual([
      "packages/app/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("does not let a solution root with files:[] steal referenced child ownership", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({
        files: [],
        references: [{ path: "./packages/app" }],
      }),
      "packages/app/tsconfig.json": config({ include: ["src/**/*.ts"] }),
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(resolveProjectOwner(analysis, "packages/app/src/index.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.json",
    });
  });

  it("treats an explicitly referenced tsconfig.*.json as a routable project", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({
        files: [],
        references: [{ path: "./packages/app/tsconfig.lib.json" }],
      }),
      "packages/app/tsconfig.lib.json": config({ include: ["src/**/*.ts"] }),
    });

    const analysis = await analyzeProjectOwnership(candidate);
    const explicit = analysis.evidence.configs.find((entry) => entry.path === "packages/app/tsconfig.lib.json");
    expect(explicit).toMatchObject({ routable_project: true, routing_reason: "PROJECT_REFERENCE_TARGET" });
    expect(resolveProjectOwner(analysis, "packages/app/src/index.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "packages/app/tsconfig.lib.json",
    });
  });

  it("marks a conventional project without files/include unsupported rather than assuming default discovery", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ compilerOptions: { strict: true } }),
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(/does not claim TypeScript default file discovery/);
    expect(resolveProjectOwner(analysis, "packages/app/src/index.ts").state).toBe("UNSUPPORTED");
  });

  it("keeps an unrelated non-routable tsconfig.* limitation as evidence without poisoning routing", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["src/**/*.ts"] }),
      "tsconfig.storybook.json": config({
        extends: "@storybook/tsconfig",
        include: ["stories/**/*.ts"],
      }),
      "src/main.ts": "export const main = 1;\n",
      "stories/story.ts": "export const story = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(analysis.limitations).toEqual([]);
    const storybook = analysis.evidence.configs.find((entry) => entry.path === "tsconfig.storybook.json");
    expect(storybook).toMatchObject({
      routable_project: false,
      routing_reason: "INHERITANCE_ONLY",
      routing_relevant: false,
    });
    expect(storybook?.limitations.join("\n")).toMatch(/package\/external config/);
    expect(resolveProjectOwner(analysis, "src/main.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "tsconfig.json",
    });
  });

  it("fails closed when an unsupported inheritance base is routing-relevant", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ extends: "./configs/tsconfig.base.json" }),
      "configs/tsconfig.base.json": config({
        extends: "@scope/external-base",
        include: ["../src/**/*.ts"],
      }),
      "src/main.ts": "export const main = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    const base = analysis.evidence.configs.find((entry) => entry.path === "configs/tsconfig.base.json");
    expect(base).toMatchObject({
      routable_project: false,
      routing_relevant: true,
    });
    expect(base?.limitations.join("\n")).toMatch(/package\/external config/);
    expect(resolveProjectOwner(analysis, "src/main.ts").state).toBe("UNSUPPORTED");
  });

  it.each([
    ["unsupported glob", { include: ["src/[ab].ts"] }, /unsupported glob grammar/],
    ["absolute file", { files: ["/tmp/a.ts"] }, /absolute\/external/],
    ["absolute pattern", { include: ["/tmp/*.ts"] }, /absolute\/external/],
    ["escaping include", { include: ["../outside/**/*.ts"] }, /escapes candidate authority/],
    ["backslash pattern", { include: ["src\\*.ts"] }, /uses backslashes/],
    ["NUL pattern", { include: ["src/\0a.ts"] }, /without NUL/],
    ["non-array include", { include: "src/**/*.ts" }, /include must be an array/],
    ["non-string include entry", { include: [42] }, /include\[0\] must be a string/],
    ["invalid allowJs", { compilerOptions: { allowJs: "yes" }, include: ["src/**/*.ts"] }, /allowJs must be a boolean/],
    ["invalid compilerOptions", { compilerOptions: "strict", include: ["src/**/*.ts"] }, /compilerOptions must be an object/],
    ["package extends", { extends: "@scope/base", include: ["src/**/*.ts"] }, /package\/external config/],
    ["missing extends", { extends: "./missing.json", include: ["src/**/*.ts"] }, /extends missing candidate config/],
  ])("rejects %s", async (_name, body, pattern) => {
    const candidate = await candidateWith({
      "tsconfig.json": config(body),
      "src/a.ts": "export const a = 1;\n",
    });
    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(pattern);
  });

  it("rejects duplicate normalized explicit files", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ files: ["./packages/app/src/index.ts", "packages/app/src/index.ts"] }),
    });
    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(/duplicate normalized entry/);
  });

  it("rejects extends cycles", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ extends: "./configs/tsconfig.base.json", include: ["packages/**/*.ts"] }),
      "configs/tsconfig.base.json": config({ extends: "../tsconfig.json" }),
    });
    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(/extends cycle/);
  });

  it("keeps unrelated standalone config limitations as evidence without poisoning routing or environment admission", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["src/**/*.ts"] }),
      "configs/tsconfig.unused.json": config({ extends: "@scope/base" }),
      "src/main.ts": "export const main = 1;\n",
    });

    const analysis = await analyzeProjectOwnership(candidate);
    expect(analysis.evidence.state).toBe("BOUND");
    expect(analysis.limitations).toEqual([]);
    const unused = analysis.evidence.configs.find((entry) => entry.path === "configs/tsconfig.unused.json");
    expect(unused).toMatchObject({
      routable_project: false,
      routing_reason: "INHERITANCE_ONLY",
      routing_relevant: false,
    });
    expect(unused?.limitations.join("\n")).toMatch(/package\/external config/);
    expect(resolveProjectOwner(analysis, "src/main.ts")).toMatchObject({
      state: "RESOLVED",
      config_path: "tsconfig.json",
    });

    const profile = await createTypeScriptProfile();
    const environment = await buildEnvironmentManifest(candidate, profile);
    expect(environment.project_ownership.state).toBe("BOUND");
    expect(environment.limitations.some((limitation) => limitation.includes("configs/tsconfig.unused.json"))).toBe(false);
  });

  it("changes membership identity when ownership rules change", async () => {
    const a = await candidateWith({
      "tsconfig.json": config({ include: ["packages/app/src/**/*.ts"] }),
    });
    const b = await candidateWith({
      "tsconfig.json": config({ files: ["packages/app/src/index.ts"] }),
    });
    const aa = await analyzeProjectOwnership(a);
    const bb = await analyzeProjectOwnership(b);
    expect(aa.evidence.model_sha256).not.toBe(bb.evidence.model_sha256);
    expect(aa.evidence.configs[0]?.membership_sha256).not.toBe(bb.evidence.configs[0]?.membership_sha256);
  });

  it("changes membership identity when effective allowJs changes", async () => {
    const a = await candidateWith({
      "tsconfig.json": config({
        compilerOptions: { allowJs: false },
        include: ["src/**/*"],
      }),
      "src/a.js": "export const a = 1;\n",
    });
    const b = await candidateWith({
      "tsconfig.json": config({
        compilerOptions: { allowJs: true },
        include: ["src/**/*"],
      }),
      "src/a.js": "export const a = 1;\n",
    });
    const aa = await analyzeProjectOwnership(a);
    const bb = await analyzeProjectOwnership(b);
    expect(aa.evidence.configs[0]?.effective_allow_js.value).toBe(false);
    expect(bb.evidence.configs[0]?.effective_allow_js.value).toBe(true);
    expect(aa.evidence.model_sha256).not.toBe(bb.evidence.model_sha256);
    expect(aa.evidence.configs[0]?.membership_sha256).not.toBe(bb.evidence.configs[0]?.membership_sha256);
  });

  it("fails candidate integrity when retained config bytes are tampered", async () => {
    const candidate = await candidateWith({
      "tsconfig.json": config({ include: ["packages/**/*.ts"] }),
    });
    const path = join(candidate.source_root, "tsconfig.json");
    await chmod(path, 0o644);
    await writeFile(path, config({ include: ["other/**/*.ts"] }));

    await expect(analyzeProjectOwnership(candidate)).rejects.toThrow(/CANDIDATE_INTEGRITY_INVALID/);
  });
});
