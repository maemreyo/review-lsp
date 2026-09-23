import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
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

  it.each([
    ["unsupported glob", { include: ["src/[ab].ts"] }, /unsupported glob grammar/],
    ["absolute file", { files: ["/tmp/a.ts"] }, /absolute\/external/],
    ["escaping include", { include: ["../outside/**/*.ts"] }, /escapes candidate authority/],
    ["non-array include", { include: "src/**/*.ts" }, /include must be an array/],
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
