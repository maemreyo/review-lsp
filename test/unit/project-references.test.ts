import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCandidate, removeCandidate } from "../../src/core/candidate.js";
import { buildEnvironmentManifest } from "../../src/core/environment.js";
import { createTypeScriptProfile } from "../../src/core/profile.js";
import { analyzeProjectReferences } from "../../src/core/project-references.js";
import type { CandidateDescriptor, TypeScriptProfile } from "../../src/core/types.js";
import { createPnpmFixture } from "../helpers/pnpm-fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const candidates: CandidateDescriptor[] = [];
let profile: TypeScriptProfile | undefined;

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function candidateWithConfigs(configs: Record<string, string>): Promise<CandidateDescriptor> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-project-refs-"));
  roots.push(root);
  const fixture = await createPnpmFixture(root);
  for (const [path, body] of Object.entries(configs)) {
    const absolute = join(fixture.repo, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, body);
  }
  await execFileAsync("git", ["-C", fixture.repo, "add", "-A"]);
  await execFileAsync("git", ["-C", fixture.repo, "commit", "-qm", "project reference fixture"]);
  const { stdout } = await execFileAsync("git", ["-C", fixture.repo, "rev-parse", "HEAD"], { encoding: "utf8" });
  const candidate = await prepareCandidate({
    repo: fixture.repo,
    commit: stdout.trim(),
    stateDirectory: join(root, "state"),
  });
  candidates.push(candidate);
  return candidate;
}

function config(references?: unknown): string {
  return JSON.stringify({
    compilerOptions: { composite: true },
    ...(references === undefined ? {} : { references }),
  }, null, 2) + "\n";
}

describe("project-reference admission", () => {
  it("reports NONE when candidate configs declare no project references", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config(),
      "packages/a/tsconfig.json": config(),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence).toEqual({ state: "NONE", configs: [] });
    expect(analysis.limitations).toEqual([]);
  });

  it("binds deterministic directory and explicit-config references including transitive edges", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/b/tsconfig.json" }, { path: "./packages/a" }]),
      "packages/a/tsconfig.json": config([{ path: "../b" }]),
      "packages/b/tsconfig.json": config(),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("BOUND");
    expect(analysis.evidence.graph_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(analysis.limitations).toEqual([]);
    expect(analysis.evidence.configs.map((item) => item.path)).toEqual([
      "packages/a/tsconfig.json",
      "tsconfig.json",
    ]);
    expect(analysis.evidence.configs[0]?.references[0]?.resolved_config_path).toBe("packages/b/tsconfig.json");
    expect(analysis.evidence.configs[1]?.references.map((item) => item.resolved_config_path)).toEqual([
      "packages/a/tsconfig.json",
      "packages/b/tsconfig.json",
    ]);
  });

  it("rejects differently named explicit JSON configs outside the existing config authority", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/a/custom.json" }]),
      "packages/a/custom.json": config(),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(/missing\/unadmitted config packages\/a\/custom\.json/);
  });

  it("rejects duplicate normalized edges", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/a" }, { path: "./packages/a/tsconfig.json" }]),
      "packages/a/tsconfig.json": config(),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations).toContain(
      "tsconfig.json has duplicate project references resolving to packages/a/tsconfig.json",
    );
  });

  it.each([
    ["missing target", [{ path: "./packages/missing" }], /missing\/unadmitted config/],
    ["absolute target", [{ path: "/tmp/tsconfig.json" }], /absolute\/external/],
    ["parent escape", [{ path: "../outside" }], /escapes candidate authority/],
    ["extra fields", [{ path: "./packages/a", prepend: true }], /unsupported fields/],
    ["non-array references", { path: "./packages/a" }, /references must be an array/],
    ["non-object entry", ["./packages/a"], /must be an object/],
  ])("rejects %s", async (_name, references, pattern) => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config(references),
      "packages/a/tsconfig.json": config(),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(pattern);
  });

  it("rejects cycles rather than attempting TypeScript build-mode recovery", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/a" }]),
      "packages/a/tsconfig.json": config([{ path: "../.." }]),
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations.join("\n")).toMatch(/contains a cycle/);
  });

  it("rejects malformed project config JSON", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": "{ invalid json",
    });

    const analysis = await analyzeProjectReferences(candidate);

    expect(analysis.evidence.state).toBe("UNSUPPORTED");
    expect(analysis.limitations).toContain("tsconfig.json could not be parsed for project-reference admission");
  });

  it("binds graph evidence into the environment manifest and blocks strong admission on unsupported graphs", async () => {
    const candidate = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/missing" }]),
    });
    profile ??= await createTypeScriptProfile();

    const environment = await buildEnvironmentManifest(candidate, profile);

    expect(environment.project_references.state).toBe("UNSUPPORTED");
    expect(environment.binding).toBe("PARTIAL");
    expect(environment.limitations.join("\n")).toMatch(/missing\/unadmitted config/);
  });

  it("changes graph identity when an admitted edge changes", async () => {
    const first = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/a" }]),
      "packages/a/tsconfig.json": config(),
      "packages/b/tsconfig.json": config(),
    });
    const second = await candidateWithConfigs({
      "tsconfig.json": config([{ path: "./packages/b" }]),
      "packages/a/tsconfig.json": config(),
      "packages/b/tsconfig.json": config(),
    });

    const a = await analyzeProjectReferences(first);
    const b = await analyzeProjectReferences(second);

    expect(a.evidence.state).toBe("BOUND");
    expect(b.evidence.state).toBe("BOUND");
    expect(a.evidence.graph_sha256).not.toBe(b.evidence.graph_sha256);
  });
});
