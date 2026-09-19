import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Same sanitisation as the monorepo fixture: the commit must not depend on host Git config. */
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
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8", env: DETERMINISTIC_ENV });
  return stdout.trim();
}

export interface PnpmFixtureShape {
  /** Exact pnpm version the candidate pins through `packageManager`. */
  packageManagerVersion?: string;
  /** Written verbatim as the root `packageManager` value when provided. */
  rawPackageManager?: string;
  /** `.npmrc` contents; omitted entirely when undefined. */
  npmrc?: string;
  /** Replaces the generated lockfile when provided. */
  lockfile?: string;
  /** Omits `pnpm-lock.yaml` entirely. */
  withoutLockfile?: boolean;
  /** Declares a TypeScript devDependency at the root. */
  rootTypeScript?: string;
  /** Adds a patch file and a `patchedDependencies` entry referencing it. */
  withPatch?: boolean;
  /** References a patch that is not present in the candidate. */
  withDanglingPatch?: boolean;
}

export interface PnpmFixture {
  repo: string;
  commit: string;
}

/**
 * A small pnpm workspace whose dependency inputs are fully declared in the candidate.
 *
 * The lockfile is written by hand rather than generated, so building the fixture needs no
 * registry access. It pins one tiny real package, which lets acquisition be exercised for
 * real against a store that genuinely does or does not hold it.
 */
export async function createPnpmFixture(root: string, shape: PnpmFixtureShape = {}): Promise<PnpmFixture> {
  const packageManagerVersion = shape.packageManagerVersion ?? "10.20.0";
  const repo = join(root, "repo");
  await mkdir(join(repo, "packages", "app", "src"), { recursive: true });
  await runGit(["init", "-q", "-b", "main", "--object-format=sha1", repo]);
  const git = (...args: string[]) => runGit(["-C", repo, ...args]);
  await git("config", "user.name", "Review LSP Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.autocrlf", "false");
  await git("config", "commit.gpgsign", "false");

  const rootManifest: Record<string, unknown> = {
    name: "pnpm-fixture-root",
    private: true,
    packageManager: shape.rawPackageManager ?? `pnpm@${packageManagerVersion}`,
    devDependencies: {
      "is-number": "7.0.0",
      ...(shape.rootTypeScript ? { typescript: shape.rootTypeScript } : {}),
    },
  };
  await writeFile(join(repo, "package.json"), `${JSON.stringify(rootManifest, null, 2)}\n`);

  const workspaceLines = ["packages:", "  - packages/*"];
  if (shape.withPatch || shape.withDanglingPatch) {
    workspaceLines.push("", "patchedDependencies:", "  is-number@7.0.0: patches/is-number@7.0.0.patch");
  }
  await writeFile(join(repo, "pnpm-workspace.yaml"), `${workspaceLines.join("\n")}\n`);

  if (shape.withPatch) {
    await mkdir(join(repo, "patches"), { recursive: true });
    await writeFile(join(repo, "patches", "is-number@7.0.0.patch"), "--- a/index.js\n+++ b/index.js\n");
  }

  await writeFile(join(repo, "packages", "app", "package.json"), `${JSON.stringify({
    name: "@fixture/app",
    version: "0.0.0",
    type: "module",
    main: "./src/index.ts",
  }, null, 2)}\n`);
  await writeFile(join(repo, "packages", "app", "src", "index.ts"), "export const app = 1;\n");

  if (!shape.withoutLockfile) {
    const lockfile = shape.lockfile ?? [
      "lockfileVersion: '9.0'",
      "",
      "settings:",
      "  autoInstallPeers: true",
      "  excludeLinksFromLockfile: false",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      is-number:",
      "        specifier: 7.0.0",
      "        version: 7.0.0",
      "",
      "  packages/app: {}",
      "",
      "packages:",
      "",
      "  is-number@7.0.0:",
      "    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}",
      "    engines: {node: '>=0.12.0'}",
      "",
      "snapshots:",
      "",
      "  is-number@7.0.0: {}",
      "",
    ].join("\n");
    await writeFile(join(repo, "pnpm-lock.yaml"), lockfile);
  }

  if (shape.npmrc !== undefined) await writeFile(join(repo, ".npmrc"), shape.npmrc);

  await git("add", "-A");
  await git("commit", "-qm", "pnpm fixture candidate");
  return { repo, commit: await git("rev-parse", "HEAD") };
}
