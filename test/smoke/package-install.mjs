import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(process.cwd());
const artifactsDir = join(repoRoot, "artifacts");
const scratch = await mkdtemp(join(tmpdir(), "review-lsp-package-"));
const consumer = join(scratch, "consumer");
const fixture = join(scratch, "fixture");
const state = join(scratch, "state");

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
  });
  return { stdout, stderr };
}

async function git(...args) {
  return (await run("git", ["-C", fixture, ...args])).stdout.trim();
}

try {
  await run("pnpm", ["build"]);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const packed = await run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    artifactsDir,
  ]);
  const packResult = JSON.parse(packed.stdout);
  if (!Array.isArray(packResult) || packResult.length !== 1 || typeof packResult[0]?.filename !== "string") {
    throw new Error(`unexpected npm pack output: ${packed.stdout}`);
  }
  const tarball = join(artifactsDir, packResult[0].filename);
  const tarballBytes = await readFile(tarball);
  const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");

  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "review-lsp-clean-install-smoke",
    private: true,
    type: "module",
  }, null, 2) + "\n");
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    tarball,
  ], { cwd: consumer, timeout: 240_000 });

  const installedRoot = join(consumer, "node_modules", "review-lsp");
  const installedCli = join(installedRoot, "dist", "review-lsp.mjs");
  const artifactInfo = JSON.parse((await run(process.execPath, [installedCli, "artifact-info"], { cwd: consumer })).stdout);
  if (artifactInfo.package_version !== "0.1.0-alpha.1") {
    throw new Error(`unexpected installed package version: ${artifactInfo.package_version}`);
  }
  if (artifactInfo.identity_scope !== "provider_bundle_server_bundle_and_package_json") {
    throw new Error(`unexpected artifact identity scope: ${artifactInfo.identity_scope}`);
  }
  const bundleEntry = artifactInfo.files?.find((entry) => entry.path === "dist/review-lsp.mjs");
  if (!bundleEntry?.sha256) throw new Error("artifact-info omitted provider bundle digest");
  const serverBundleEntry = artifactInfo.files?.find(
    (entry) => entry.path === "dist/typescript-language-server/lib/cli.mjs",
  );
  if (!serverBundleEntry?.sha256) throw new Error("artifact-info omitted TypeScript server bundle digest");

  await mkdir(join(fixture, "src"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", fixture]);
  await git("config", "user.name", "Review-LSP Package Smoke");
  await git("config", "user.email", "package-smoke@example.invalid");
  await writeFile(join(fixture, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2) + "\n");
  await writeFile(join(fixture, "src", "value.ts"), 'export const value: string = "A";\n');
  await writeFile(join(fixture, "src", "main.ts"), 'import { value } from "./value";\nexport const result = value;\n');
  await git("add", ".");
  await git("commit", "-qm", "candidate A");
  const a = await git("rev-parse", "HEAD");

  await writeFile(join(fixture, "src", "value.ts"), "export const value: number = 42;\n");
  await git("add", "src/value.ts");
  await git("commit", "-qm", "live B");
  const b = await git("rev-parse", "HEAD");

  const prepared = JSON.parse((await run(process.execPath, [
    installedCli,
    "prepare",
    fixture,
    a,
    "--state",
    state,
  ], { cwd: consumer })).stdout);
  const descriptor = prepared.candidate_descriptor;
  if (typeof descriptor !== "string") throw new Error("installed prepare omitted candidate_descriptor");

  const query = JSON.parse((await run(process.execPath, [
    installedCli,
    "query",
    descriptor,
    "hover",
    "src/main.ts",
    "1",
    String("export const result = ".length),
    "--state",
    state,
  ], { cwd: consumer })).stdout);

  const resultText = JSON.stringify(query.receipt?.result);
  if (!resultText.includes("string") || resultText.includes("number")) {
    throw new Error(`installed package returned wrong candidate semantics: ${resultText}`);
  }
  if (query.receipt?.candidate?.commit_oid !== a
    || query.receipt?.source_binding !== "VERIFIED"
    || query.receipt?.environment_binding !== "VERIFIED") {
    throw new Error(`installed package receipt binding mismatch: ${JSON.stringify(query.receipt)}`);
  }

  await run(process.execPath, [installedCli, "close", descriptor, "--state", state], { cwd: consumer });

  process.stdout.write(JSON.stringify({
    ok: true,
    package_version: artifactInfo.package_version,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    tarball,
    tarball_sha256: tarballSha256,
    tarball_bytes: tarballBytes.byteLength,
    provider_artifact_id: artifactInfo.artifact_id,
    provider_artifact_sha256: artifactInfo.artifact_sha256,
    provider_bundle_sha256: bundleEntry.sha256,
    typescript_server_bundle_sha256: serverBundleEntry.sha256,
    candidate_a: a,
    live_b: b,
    source_binding: query.receipt.source_binding,
    environment_binding: query.receipt.environment_binding,
  }, null, 2) + "\n");
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
