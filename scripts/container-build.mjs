import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(process.cwd());
const image = process.env.REVIEW_LSP_CONTAINER_IMAGE ?? "review-lsp:alpha-local";
const scratch = await mkdtemp(join(tmpdir(), "review-lsp-image-"));

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFile(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
  });
  return { stdout, stderr };
}

try {
  await run("pnpm", ["build"]);
  const packDir = join(scratch, "pack");
  await mkdir(packDir, { recursive: true });
  const packed = await run("npm", [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ]);
  const parsed = JSON.parse(packed.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== "string") {
    throw new Error(`unexpected npm pack output: ${packed.stdout}`);
  }
  const sourceTarball = join(packDir, parsed[0].filename);
  const context = join(scratch, "context");
  await mkdir(context, { recursive: true });
  const targetTarball = join(context, "review-lsp.tgz");
  await copyFile(sourceTarball, targetTarball);

  await run("docker", [
    "build",
    "--pull=false",
    "--file",
    join(root, "container", "Dockerfile"),
    "--tag",
    image,
    context,
  ], { timeout: 600_000 });
  const inspected = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const imageId = inspected.stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error(`invalid Docker image ID: ${JSON.stringify(imageId)}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    image,
    image_id: imageId,
    package_tarball: basename(sourceTarball),
    package_bytes: (await readFile(sourceTarball)).byteLength,
  }, null, 2) + "\n");
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
