import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(process.cwd());
const cli = join(root, "dist", "review-lsp.mjs");
const image = process.env.REVIEW_LSP_CONTAINER_IMAGE ?? "review-lsp:alpha-local";
const scratch = await mkdtemp(join(tmpdir(), "review-lsp-container-smoke-"));
const repo = join(scratch, "repo");
const state = join(scratch, "state");

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  return { stdout, stderr };
}

async function git(...args) {
  return (await run("git", ["-C", repo, ...args])).stdout.trim();
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git("config", "user.name", "Review-LSP Container Smoke");
  await git("config", "user.email", "container-smoke@example.invalid");
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
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "CONTAINER_A";\n');
  await writeFile(join(repo, "src", "main.ts"), 'import { value } from "./value";\nexport const result = value;\n');
  await git("add", ".");
  await git("commit", "-qm", "candidate A");
  const a = await git("rev-parse", "HEAD");

  await writeFile(join(repo, "src", "value.ts"), "export const value: number = 42;\n");
  await git("add", "src/value.ts");
  await git("commit", "-qm", "live B");
  const b = await git("rev-parse", "HEAD");

  const prepared = JSON.parse((await run(process.execPath, [
    cli, "prepare", repo, a, "--state", state,
  ])).stdout);
  const descriptor = prepared.candidate_descriptor;
  if (typeof descriptor !== "string") throw new Error("prepare omitted candidate descriptor");

  const queried = JSON.parse((await run(process.execPath, [
    cli,
    "container-query",
    image,
    descriptor,
    "hover",
    "src/main.ts",
    "1",
    String("export const result = ".length),
    "--state",
    state,
  ], { timeout: 240_000 })).stdout);

  const imageId = (await run("docker", ["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim();
  if (queried.image_id !== imageId) throw new Error(`image identity mismatch: ${queried.image_id} != ${imageId}`);
  if (queried.receipt?.isolation !== "CONTAINER_READ_ONLY"
    || queried.receipt?.source_binding !== "VERIFIED"
    || queried.receipt?.environment_binding !== "VERIFIED") {
    throw new Error(`container receipt binding mismatch: ${JSON.stringify(queried.receipt)}`);
  }
  if (queried.environment?.platform !== "linux"
    || queried.environment?.isolation !== "CONTAINER_READ_ONLY"
    || queried.environment?.isolation_identity !== `docker:${imageId}`) {
    throw new Error(`container environment mismatch: ${JSON.stringify(queried.environment)}`);
  }
  const resultText = JSON.stringify(queried.receipt.result);
  if (!resultText.includes("string") || resultText.includes("number")) {
    throw new Error(`container returned wrong candidate semantics: ${resultText}`);
  }

  await run(process.execPath, [cli, "close", descriptor, "--state", state]);
  process.stdout.write(JSON.stringify({
    ok: true,
    candidate_a: a,
    live_b: b,
    image,
    image_id: imageId,
    inner_platform: queried.environment.platform,
    isolation: queried.receipt.isolation,
    source_binding: queried.receipt.source_binding,
    environment_binding: queried.receipt.environment_binding,
  }, null, 2) + "\n");
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
