import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  createTypeScriptProfile,
  prepareCandidate,
  removeCandidate,
  SemanticSession,
} from "../dist/src/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "review-lsp-benchmark-"));
const repo = join(root, "repo");
const state = join(root, "state");
let candidate;

async function run(command, args, options = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout.trim();
}

async function git(...args) {
  return run("git", ["-C", repo, ...args]);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 1000) / 1000;
}

function summary(values) {
  return {
    samples: values.length,
    min_ms: percentile(values, 0),
    median_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    max_ms: percentile(values, 100),
  };
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git("config", "user.name", "Review-LSP Benchmark");
  await git("config", "user.email", "benchmark@example.invalid");
  await writeFile(join(repo, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "benchmark";\n');
  await writeFile(join(repo, "src", "main.ts"), 'import { value } from "./value";\nexport const result = value;\n');
  await git("add", ".");
  await git("commit", "-qm", "benchmark candidate");
  const commit = await git("rev-parse", "HEAD");

  const prepareStart = performance.now();
  candidate = await prepareCandidate({ repo, commit, stateDirectory: state });
  const prepareMs = performance.now() - prepareStart;

  const profileStart = performance.now();
  const profile = await createTypeScriptProfile();
  const profileMs = performance.now() - profileStart;

  const sessionStarts = [];
  const hovers = [];
  const definitions = [];
  const iterations = 5;
  const character = "export const result = ".length;

  for (let index = 0; index < iterations; index += 1) {
    const sessionStart = performance.now();
    const session = await SemanticSession.create({ candidate, profile, stateDirectory: state });
    sessionStarts.push(performance.now() - sessionStart);
    try {
      const hoverStart = performance.now();
      const hover = await session.hover({ path: "src/main.ts", line: 1, character });
      hovers.push(performance.now() - hoverStart);
      if (!JSON.stringify(hover.result).includes("string")) throw new Error("benchmark hover returned wrong semantics");

      const definitionStart = performance.now();
      const definition = await session.definition({ path: "src/main.ts", line: 1, character });
      definitions.push(performance.now() - definitionStart);
      if (!JSON.stringify(definition.result).includes("src/value.ts")) throw new Error("benchmark definition did not bind source definition");
    } finally {
      await session.close();
    }
  }

  process.stdout.write(JSON.stringify({
    schema: "review-lsp.benchmark.v1",
    package_version: "0.1.0-alpha.1",
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    iterations,
    cold_prepare_ms: Math.round(prepareMs * 1000) / 1000,
    profile_admission_ms: Math.round(profileMs * 1000) / 1000,
    session_start: summary(sessionStarts),
    hover: summary(hovers),
    definition: summary(definitions),
    semantics: "observational benchmark only; no release threshold is implied",
  }, null, 2) + "\n");
} finally {
  if (candidate) await removeCandidate(candidate).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
