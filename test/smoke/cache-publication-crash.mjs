import { spawn, execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";

import {
  prepareCandidate,
  removeCandidate,
  verifyCandidateIntegrity,
} from "../../dist/src/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "review-lsp-cache-crash-"));
const repo = join(root, "repo");
const state = join(root, "state");
let recovered;

async function run(command, args, options = {}) {
  const { stdout } = await execFile(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Review LSP Crash Fixture",
      GIT_AUTHOR_EMAIL: "crash@example.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Review LSP Crash Fixture",
      GIT_COMMITTER_EMAIL: "crash@example.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  return stdout.trim();
}

async function waitForPublishedCandidateWithoutIndex(child, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error("candidate preparation completed before crash window was observed");
    }
    const candidatesRoot = join(state, "candidates");
    const entries = await readdir(candidatesRoot, { withFileTypes: true }).catch(() => []);
    const candidate = entries.find((entry) => entry.isDirectory() && /^cand_[0-9a-f]{32}$/.test(entry.name));
    const indexes = await readdir(join(candidatesRoot, "index")).catch(() => []);
    if (candidate && indexes.length === 0) return candidate.name;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for post-rename/pre-index candidate publication window");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", "--object-format=sha1", repo]);

  const files = 1800;
  const padding = "x".repeat(2048);
  for (let index = 0; index < files; index += 1) {
    const bucket = String(index % 30).padStart(2, "0");
    const directory = join(repo, "src", bucket);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `module-${String(index).padStart(4, "0")}.ts`),
      `export const value${index}: number = ${index};\n// ${padding}\n`,
    );
  }
  await writeFile(join(repo, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "commit", "-qm", "cache crash fixture"]);
  const commit = await run("git", ["-C", repo, "rev-parse", "HEAD"]);

  const childPath = resolve("test/fixtures/candidate-prepare-crash-child.mjs");
  const child = spawn(process.execPath, [childPath, repo, commit, state], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const candidateId = await waitForPublishedCandidateWithoutIndex(child);
  child.kill("SIGKILL");
  await once(child, "exit");

  if (stdout.includes("DONE")) {
    throw new Error("child completed instead of being killed during cache publication");
  }
  const indexBeforeRecovery = await readdir(join(state, "candidates", "index")).catch(() => []);
  if (indexBeforeRecovery.length !== 0) {
    throw new Error("retained index was published before crash injection");
  }

  recovered = await prepareCandidate({ repo, commit, stateDirectory: state });
  if (recovered.candidate_id !== candidateId) {
    throw new Error(`recovery changed candidate identity: ${candidateId} -> ${recovered.candidate_id}`);
  }
  await verifyCandidateIntegrity(recovered);
  const indexAfterRecovery = await readdir(join(state, "candidates", "index"));
  if (indexAfterRecovery.length !== 1) {
    throw new Error(`recovery did not publish exactly one retained index: ${JSON.stringify(indexAfterRecovery)}`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    schema: "review-lsp.cache-publication-crash.v1",
    injected_signal: "SIGKILL",
    crash_window: "candidate_directory_published_before_retained_index",
    candidate_id: recovered.candidate_id,
    entries: recovered.entries.length,
    child_stderr_tail: stderr.slice(-500),
    recovery: "verified retained candidate and republished index",
  }, null, 2) + "\n");
} finally {
  if (recovered) await removeCandidate(recovered).catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
