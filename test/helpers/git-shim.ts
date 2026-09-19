import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Behaviors a shimmed `git` can exhibit for `cat-file --batch`.
 *
 * The production code passes a deliberately minimal environment to Git, so a shim cannot be
 * steered at run time through an environment variable. Each shim therefore has its behavior
 * baked in, and tests select it by generating the shim they need.
 */
export type GitShimMode =
  /** Reports a payload size one byte larger than the object actually has. */
  | "oversized-header"
  /** Emits a response header that is not `<oid> <type> <size>`. */
  | "malformed-header"
  /** Reads every request, then exits before answering. */
  | "premature-exit"
  /**
   * Exits immediately without reading stdin at all.
   *
   * Distinct from `premature-exit`: a shim that drains stdin first never lets the request
   * pipe fill, so it cannot exercise the case where the child dies while the writer is
   * blocked on backpressure and `drain` will never arrive.
   */
  | "exit-before-reading"
  /** Emits a correct header but truncates the payload and closes the stream. */
  | "truncated-payload";

/** Emitted before stdin is read; these modes must not drain the request pipe. */
const BEFORE_READ: Partial<Record<GitShimMode, string>> = {
  "exit-before-reading": `
process.stderr.write("shim: exiting before reading any request\\n");
process.exit(1);
`,
};

/** Emitted once per request, after the real object bytes are in \`bytes\`. */
const PER_REQUEST: Partial<Record<GitShimMode, string>> = {
  "oversized-header": `
    process.stdout.write(\`\${oid} blob \${bytes.byteLength + 1}\\n\`);
    process.stdout.write(bytes);
    process.stdout.write("\\n");
  `,
  "malformed-header": `
    process.stdout.write("not-a-valid-batch-header\\n");
  `,
  "premature-exit": `
    process.stderr.write("shim: refusing to serve objects\\n");
    process.exit(1);
  `,
  "truncated-payload": `
    process.stdout.write(\`\${oid} blob \${bytes.byteLength}\\n\`);
    process.stdout.write(bytes.subarray(0, Math.max(0, bytes.byteLength - 4)));
    process.exit(0);
  `,
};

/**
 * Writes a `git` shim into a fresh directory and returns that directory.
 *
 * The shim delegates every command except `cat-file --batch` to the real Git, so candidate
 * enumeration, rev-parse and tree listing keep working normally while the object stream
 * misbehaves in exactly one way.
 */
export async function createGitShim(directory: string, mode: GitShimMode, realGit = "/usr/bin/git"): Promise<string> {
  await mkdir(directory, { recursive: true });
  const script = `import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const isBatch = argv.includes("cat-file") && argv.includes("--batch");
if (!isBatch) {
  const result = spawnSync(${JSON.stringify(realGit)}, argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
${BEFORE_READ[mode] ?? ""}
const repoIndex = argv.indexOf("-C");
const repo = repoIndex >= 0 ? argv[repoIndex + 1] : process.cwd();
let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  input = "";
}
const requests = input.split("\\n").filter(Boolean);
for (const oid of requests) {
  const real = spawnSync(${JSON.stringify(realGit)}, ["-C", repo, "cat-file", "blob", oid], { maxBuffer: 1 << 28 });
  const bytes = real.stdout ?? Buffer.alloc(0);
${PER_REQUEST[mode] ?? ""}
  break;
}
process.exit(0);
`;
  const scriptPath = join(directory, "git-shim.mjs");
  await writeFile(scriptPath, script);
  const binary = join(directory, "git");
  await writeFile(binary, `#!/bin/sh\nexec node ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(binary, 0o755);
  return directory;
}
