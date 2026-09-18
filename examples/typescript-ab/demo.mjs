import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createTypeScriptProfile,
  prepareCandidate,
  removeCandidate,
  SemanticSession,
  validateReceipt,
} from "../../dist/src/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "review-lsp-demo-"));
const repo = join(root, "repo");
const state = join(root, "state");
const candidates = [];

async function git(...args) {
  const { stdout } = await execFile("git", ["-C", repo, ...args], { encoding: "utf8" });
  return stdout.trim();
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await execFile("git", ["init", "-b", "main", repo]);
  await git("config", "user.name", "Review-LSP Demo");
  await git("config", "user.email", "demo@example.invalid");
  await writeFile(join(repo, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "A";\n');
  await writeFile(join(repo, "src", "main.ts"), 'import { value } from "./value";\nexport const result = value;\n');
  await git("add", ".");
  await git("commit", "-m", "A string");
  const a = await git("rev-parse", "HEAD");

  await writeFile(join(repo, "src", "value.ts"), "export const value: number = 42;\n");
  await git("add", "src/value.ts");
  await git("commit", "-m", "B number");
  const b = await git("rev-parse", "HEAD");

  const profile = await createTypeScriptProfile();
  const candidateA = await prepareCandidate({ repo, commit: a, stateDirectory: state });
  const candidateB = await prepareCandidate({ repo, commit: b, stateDirectory: state });
  candidates.push(candidateA, candidateB);

  const sessionA = await SemanticSession.create({ candidate: candidateA, profile, stateDirectory: state });
  const sessionB = await SemanticSession.create({ candidate: candidateB, profile, stateDirectory: state });
  try {
    const character = "export const result = ".length;
    const receiptA = await sessionA.hover({ path: "src/main.ts", line: 1, character });
    const receiptB = await sessionB.hover({ path: "src/main.ts", line: 1, character });
    validateReceipt(receiptA);
    validateReceipt(receiptB);
    process.stdout.write(JSON.stringify({
      live_checkout: b,
      candidate_A: {
        commit: a,
        candidate_id: candidateA.candidate_id,
        hover: receiptA.result,
        source_binding: receiptA.source_binding,
        environment_binding: receiptA.environment_binding,
      },
      candidate_B: {
        commit: b,
        candidate_id: candidateB.candidate_id,
        hover: receiptB.result,
        source_binding: receiptB.source_binding,
        environment_binding: receiptB.environment_binding,
      },
      proves: "A semantic query stays bound to A even while the live checkout is B",
    }, null, 2) + "\n");
  } finally {
    await Promise.all([sessionA.close(), sessionB.close()]);
  }
} finally {
  await Promise.all(candidates.map((candidate) => removeCandidate(candidate).catch(() => undefined)));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
