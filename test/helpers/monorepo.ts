import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Deterministic environment.
 *
 * Fixed identity and fixed author/committer dates are not sufficient on their own: Git also
 * reads system and global configuration, and settings such as `init.defaultObjectFormat`,
 * `commit.gpgsign` or `core.autocrlf` change the resulting commit OID. Inheriting the
 * ambient environment would therefore make the "reproducible across machines" claim depend
 * on whatever the host developer has configured.
 *
 * The environment below is constructed rather than inherited, and mirrors the sanitisation
 * the production Git helper applies, so the fixture commit OID is a function of the fixture
 * content alone.
 */
const DETERMINISTIC_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Review LSP Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Review LSP Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: DETERMINISTIC_ENV,
  });
  return stdout.trim();
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return runGit(["-C", repo, ...args]);
}

export interface MonorepoShape {
  /** Number of workspace packages. */
  packages?: number;
  /** Source modules generated per package. */
  modulesPerPackage?: number;
  /** Approximate extra body bytes per module, used to reach a realistic tracked-byte total. */
  paddingBytesPerModule?: number;
  /** Emit an executable script and a relative symlink so non-regular modes stay covered. */
  includeNonRegularEntries?: boolean;
}

export interface MonorepoFixture {
  repo: string;
  commit: string;
  entryCount: number;
  trackedBytes: number;
}

function moduleSource(pkg: number, index: number, paddingBytes: number): string {
  const lines = [
    `export interface Shape${index} {`,
    `  readonly id: string;`,
    `  readonly weight: number;`,
    `}`,
    ``,
    `export const shape${index}: Shape${index} = { id: "p${pkg}-m${index}", weight: ${index} };`,
    ``,
    `export function describe${index}(input: Shape${index}): string {`,
    `  return \`\${input.id}:\${input.weight}\`;`,
    `}`,
    ``,
  ];
  // Deterministic padding so tracked bytes are realistic without random content.
  const padding = Math.max(0, paddingBytes);
  if (padding > 0) {
    const filler = "// ".concat("x".repeat(77));
    const repeats = Math.ceil(padding / (filler.length + 1));
    for (let index = 0; index < repeats; index += 1) lines.push(filler);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Builds a pnpm-workspace-shaped TypeScript monorepo with hundreds of tracked files.
 * The tiny two-file A/B fixture is fine for semantic assertions but cannot expose
 * per-blob ingestion cost, which is what the candidate-preparation baseline measures.
 */
export async function createMonorepoRepo(root: string, shape: MonorepoShape = {}): Promise<MonorepoFixture> {
  const packages = shape.packages ?? 12;
  const modulesPerPackage = shape.modulesPerPackage ?? 40;
  const paddingBytesPerModule = shape.paddingBytesPerModule ?? 900;
  const includeNonRegularEntries = shape.includeNonRegularEntries ?? true;

  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  // `init` must use the same sanitised environment as every other command, and the object
  // format must be explicit: a host that sets `init.defaultObjectFormat=sha256` would
  // otherwise produce a SHA-256 repository whose commit OID cannot match the baseline.
  await runGit(["init", "-q", "-b", "main", "--object-format=sha1", repo]);
  await git(repo, "config", "user.name", "Review LSP Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "core.autocrlf", "false");
  await git(repo, "config", "core.fileMode", "true");
  await git(repo, "config", "core.symlinks", "true");
  await git(repo, "config", "commit.gpgsign", "false");
  await git(repo, "config", "tag.gpgsign", "false");

  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(repo, "package.json"), `${JSON.stringify({
    name: "monorepo-fixture",
    private: true,
    packageManager: "pnpm@10.20.0",
  }, null, 2)}\n`);
  await writeFile(join(repo, "tsconfig.base.json"), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      declaration: true,
    },
  }, null, 2)}\n`);

  for (let pkg = 0; pkg < packages; pkg += 1) {
    const packageRoot = join(repo, "packages", `pkg-${pkg}`);
    await mkdir(join(packageRoot, "src"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: `@fixture/pkg-${pkg}`,
      version: "0.0.0",
      type: "module",
      main: "./src/index.ts",
      scripts: { build: "tsc -p tsconfig.json" },
    }, null, 2)}\n`);
    await writeFile(join(packageRoot, "tsconfig.json"), `${JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    }, null, 2)}\n`);

    const exports: string[] = [];
    for (let index = 0; index < modulesPerPackage; index += 1) {
      await writeFile(join(packageRoot, "src", `module-${index}.ts`), moduleSource(pkg, index, paddingBytesPerModule));
      exports.push(`export * from "./module-${index}.js";`);
    }
    await writeFile(join(packageRoot, "src", "index.ts"), `${exports.join("\n")}\n`);
  }

  if (includeNonRegularEntries) {
    await mkdir(join(repo, "scripts"), { recursive: true });
    await writeFile(join(repo, "scripts", "build.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Non-ASCII path plus a relative symlink that stays inside candidate authority.
    await writeFile(join(repo, "docs-ünïcode.md"), "# fixture\n");
    const { symlink } = await import("node:fs/promises");
    await symlink("../packages/pkg-0/src/index.ts", join(repo, "scripts", "entry.ts"));
  }

  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "monorepo fixture candidate");
  const commit = await git(repo, "rev-parse", "HEAD");

  const listing = await git(repo, "ls-tree", "-r", "-l", "--full-tree", commit);
  const rows = listing.split("\n").filter(Boolean);
  const trackedBytes = rows.reduce((total, row) => {
    const size = row.slice(0, row.indexOf("\t")).trim().split(/\s+/)[3];
    return total + (size === "-" ? 0 : Number(size));
  }, 0);

  return { repo, commit, entryCount: rows.length, trackedBytes };
}
