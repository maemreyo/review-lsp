import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "review-lsp-mcp-smoke-"));
const repo = join(root, "repo");
const state = join(root, "state");
let client;

async function git(...args) {
  const { stdout } = await execFile("git", ["-C", repo, ...args], { encoding: "utf8" });
  return stdout.trim();
}

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await execFile("git", ["init", "-b", "main", repo]);
  await git("config", "user.name", "Review LSP Smoke");
  await git("config", "user.email", "smoke@example.invalid");
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
  await writeFile(join(repo, "src", "value.ts"), 'export const value: string = "smoke";\n');
  await writeFile(join(repo, "src", "main.ts"), [
    'import { value } from "./value";',
    "export const result = value;",
    "",
  ].join("\n"));
  await git("add", ".");
  await git("commit", "-m", "smoke");
  const commit = await git("rev-parse", "HEAD");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/src/cli.js"), "serve", repo, commit, "--state", state],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? root,
      REVIEW_LSP_STATE_DIR: state,
    },
    maxBufferSize: 1024 * 1024,
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  client = new Client({ name: "review-lsp-smoke", version: "0.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = ["review_lsp_candidate_info", "review_lsp_definition", "review_lsp_hover"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected MCP tools: ${JSON.stringify(names)}`);
  }

  const info = await client.callTool({ name: "review_lsp_candidate_info", arguments: {} });
  if (info.isError) throw new Error(`candidate_info failed: ${JSON.stringify(info.content)}`);
  const structured = info.structuredContent;
  if (!structured || typeof structured.candidate_id !== "string") {
    throw new Error("candidate_info omitted candidate_id");
  }
  if (structured.commit_oid !== commit || structured.environment_binding !== "VERIFIED") {
    throw new Error(`candidate_info binding mismatch: ${JSON.stringify(structured)}`);
  }

  const hovers = await Promise.all(Array.from({ length: 4 }, () => client.callTool({
    name: "review_lsp_hover",
    arguments: {
      expected_candidate_id: structured.candidate_id,
      path: "src/main.ts",
      line: 1,
      character: "export const result = ".length,
    },
  })));
  for (const hover of hovers) {
    if (hover.isError) throw new Error(`hover failed: ${JSON.stringify(hover.content)}`);
    if (!JSON.stringify(hover.structuredContent).includes("string")) {
      throw new Error(`hover did not expose candidate string semantics: ${JSON.stringify(hover.structuredContent)}`);
    }
  }
  const sessionIds = new Set(hovers.map((hover) => hover.structuredContent?.session_id));
  if (sessionIds.size !== 1 || !sessionIds.has(structured.session_id)) {
    throw new Error(`concurrent queries did not share one live semantic runtime: info=${structured.session_id} hover=${JSON.stringify([...sessionIds])}`);
  }

  const mismatch = await client.callTool({
    name: "review_lsp_hover",
    arguments: {
      expected_candidate_id: "cand_wrong",
      path: "src/main.ts",
      line: 1,
      character: "export const result = ".length,
    },
  });
  if (!mismatch.isError || !JSON.stringify(mismatch.content).includes("expected candidate")) {
    throw new Error(`candidate mismatch was not rejected: ${JSON.stringify(mismatch)}`);
  }

  await client.close();
  client = undefined;
  if (!stderr.includes(`review-lsp bound candidate ${structured.candidate_id}`)) {
    throw new Error(`expected binding log on stderr, got: ${stderr}`);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    commit,
    candidate_id: structured.candidate_id,
    session_id: structured.session_id,
    concurrent_session_ids: [...sessionIds],
    tools: names,
  }) + "\n");
} finally {
  await client?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
