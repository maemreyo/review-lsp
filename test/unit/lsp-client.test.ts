import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TypeScriptProfile } from "../../src/core/types.js";
import { StdioLspDriver } from "../../src/lsp/client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function profile(entrypoint: string): TypeScriptProfile {
  return {
    schema_version: "review-lsp.profile.typescript.v1",
    profile_id: "prof_fake",
    language_id: "typescript",
    extensions: [".ts", ".tsx"],
    node_executable: process.execPath,
    node_executable_sha256: "0".repeat(64),
    server_entrypoint: entrypoint,
    server_entrypoint_sha256: "1".repeat(64),
    server_runtime_root: resolve("."),
    server_runtime_kind: "PACKAGE",
    server_package_version: "fake",
    server_package_sha256: "2".repeat(64),
    typescript_root: process.cwd(),
    typescript_version: "fake",
    typescript_package_sha256: "3".repeat(64),
    args: ["--stdio"],
    initialization_options: {
      disableAutomaticTypingAcquisition: true,
      plugins: [],
      tsserver: {
        path: process.cwd(),
        fallbackPath: process.cwd(),
        logVerbosity: "off",
        useSyntaxServer: "never",
      },
    },
    environment_allowlist: ["PATH", "HOME", "TMPDIR"],
    document_limit_bytes: 1024 * 1024,
    result_limit_bytes: 1024 * 1024,
    profile_sha256: "4".repeat(64),
  };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "review-lsp-driver-"));
  roots.push(value);
  return value;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function open(driver: StdioLspDriver, rootDir: string) {
  return driver.openDocument({
    path: join(rootDir, "main.ts"),
    text: "export const value = 1;\n",
    languageId: "typescript",
  });
}

describe("stdio LSP lifecycle fault injection", () => {
  const entrypoint = resolve("test/fixtures/fake-lsp-server.mjs");

  it("times out without accepting a late hover and reaps the server on shutdown", async () => {
    await access(entrypoint);
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "delay", REVIEW_LSP_FAKE_DELAY_MS: "1000" },
      300,
      200,
    );
    await driver.start();
    const pid = driver.processId;
    expect(pid).toBeTypeOf("number");
    const document = await open(driver, rootDir);

    await expect(driver.hover(document, 0, 13)).rejects.toMatchObject({ code: "LSP_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 750));

    await driver.shutdown();
    await driver.shutdown();
    expect(alive(pid!)).toBe(false);
  });

  it("fails closed when the language server crashes during a request", async () => {
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "crash" },
      1_000,
      200,
    );
    await driver.start();
    const pid = driver.processId;
    const document = await open(driver, rootDir);

    await expect(driver.hover(document, 0, 13)).rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
    await driver.shutdown();
    expect(alive(pid!)).toBe(false);
  });

  it("closing during an in-flight request rejects the request and leaves no child", async () => {
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "delay", REVIEW_LSP_FAKE_DELAY_MS: "500" },
      2_000,
      200,
    );
    await driver.start();
    const pid = driver.processId;
    const document = await open(driver, rootDir);
    const pending = driver.hover(document, 0, 13).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    await driver.shutdown();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("in-flight hover unexpectedly completed during shutdown");
    expect(outcome.error).toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
    expect(alive(pid!)).toBe(false);
  });

  it("fails an in-flight request when the server dies instead of returning a stale answer", async () => {
    await access(entrypoint);
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "delay", REVIEW_LSP_FAKE_DELAY_MS: "5000" },
      30_000,
      200,
    );
    await driver.start();
    const pid = driver.processId;
    expect(pid).toBeTypeOf("number");
    const document = await open(driver, rootDir);

    // A crash mid-query must surface as a failure. Anything else would let a killed process
    // contribute to an admitted result, which is the one outcome a receipt must never allow.
    const pending = driver.hover(document, 0, 13);
    const settled = pending.then(() => "resolved" as const, () => "rejected" as const);
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(pid as number, "SIGKILL");

    await expect(settled).resolves.toBe("rejected");
    expect(alive(pid as number)).toBe(false);
    await driver.shutdown();
  }, 60_000);
});
