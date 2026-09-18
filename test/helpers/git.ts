import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return stdout.trim();
}

export async function createTypeScriptAbRepo(root: string): Promise<{ repo: string; a: string; b: string }> {
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, "config", "user.name", "Review LSP Fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");

  await writeFile(join(repo, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "A";\n');
  await writeFile(join(repo, "src", "main.ts"), [
    'import { value } from "./value";',
    'export const observed = "🧪", result = value;',
    "",
  ].join("\n"));
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "candidate A string");
  const a = await git(repo, "rev-parse", "HEAD");

  await writeFile(join(repo, "src", "value.ts"), "export const value: number = 42;\n");
  await git(repo, "add", "src/value.ts");
  await git(repo, "commit", "-m", "candidate B number");
  const b = await git(repo, "rev-parse", "HEAD");
  return { repo, a, b };
}
