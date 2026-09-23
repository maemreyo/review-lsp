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

  it("binds the references includeDeclaration option and refuses an unsupported references capability", async () => {
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env },
      1_000,
      200,
    );
    await driver.start();
    const document = await open(driver, rootDir);
    try {
      const withoutDeclaration = await driver.references(document, 0, 13, false);
      const withDeclaration = await driver.references(document, 0, 13, true);
      expect(withoutDeclaration.value?.[0]?.range.start.character).toBe(7);
      expect(withDeclaration.value?.[0]?.range.start.character).toBe(0);
    } finally {
      await driver.shutdown();
    }

    const unsupported = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "unsupported-references" },
      1_000,
      200,
    );
    await unsupported.start();
    const unsupportedDocument = await open(unsupported, rootDir);
    try {
      await expect(unsupported.references(unsupportedDocument, 0, 13, false))
        .rejects.toMatchObject({ code: "LSP_CAPABILITY_UNSUPPORTED" });
    } finally {
      await unsupported.shutdown();
    }
  });

  it("fails diagnostics closed when no deterministic transport is advertised", async () => {
    const rootDir = await root();
    const driver = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env },
      1_000,
      200,
    );
    await driver.start();
    const document = await open(driver, rootDir);
    try {
      await expect(driver.diagnostics(document))
        .rejects.toMatchObject({ code: "LSP_CAPABILITY_UNSUPPORTED" });
    } finally {
      await driver.shutdown();
    }
  });

  it("accepts full document diagnostics and rejects widened, unchanged, or malformed pull responses", async () => {
    const rootDir = await root();
    const admitted = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "diagnostic-lsp" },
      1_000,
      200,
    );
    await admitted.start();
    const document = await open(admitted, rootDir);
    try {
      const outcome = await admitted.diagnostics(document);
      expect(outcome.kind).toBe("LSP_DOCUMENT_DIAGNOSTIC");
      if (outcome.kind !== "LSP_DOCUMENT_DIAGNOSTIC") throw new Error("expected pull diagnostics");
      expect(outcome.diagnosticProvider).toEqual({
        identifier: "review-lsp-fake",
        interFileDependencies: true,
        workspaceDiagnostics: false,
      });
      expect(outcome.diagnostics).toMatchObject([{ code: 9001, message: "fake diagnostic" }]);
    } finally {
      await admitted.shutdown();
    }

    for (const mode of ["diagnostic-lsp-unchanged", "diagnostic-lsp-related", "diagnostic-lsp-malformed"]) {
      const rejected = new StdioLspDriver(
        profile(entrypoint),
        rootDir,
        { ...process.env, REVIEW_LSP_FAKE_MODE: mode },
        1_000,
        200,
      );
      await rejected.start();
      const rejectedDocument = await open(rejected, rootDir);
      try {
        await expect(rejected.diagnostics(rejectedDocument))
          .rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
      } finally {
        await rejected.shutdown();
      }
    }
  });

  it("uses the fixed legacy diagnostic command set and shares one timeout budget", async () => {
    const rootDir = await root();
    const admitted = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "diagnostic-legacy" },
      1_000,
      200,
    );
    await admitted.start();
    const document = await open(admitted, rootDir);
    try {
      const outcome = await admitted.diagnostics(document);
      expect(outcome.kind).toBe("TSSERVER_SYNC_DIAGNOSTICS");
      if (outcome.kind !== "TSSERVER_SYNC_DIAGNOSTICS") throw new Error("expected legacy diagnostics");
      expect(outcome.protocolOperations).toEqual([
        "syntacticDiagnosticsSync",
        "semanticDiagnosticsSync",
        "suggestionDiagnosticsSync",
      ]);
      expect(outcome.syntactic).toEqual([]);
      expect(outcome.semantic).toMatchObject([{ code: 9001, category: "error" }]);
      expect(outcome.suggestion).toEqual([]);
    } finally {
      await admitted.shutdown();
    }

    const malformed = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      { ...process.env, REVIEW_LSP_FAKE_MODE: "diagnostic-legacy-malformed" },
      1_000,
      200,
    );
    await malformed.start();
    const malformedDocument = await open(malformed, rootDir);
    try {
      await expect(malformed.diagnostics(malformedDocument))
        .rejects.toMatchObject({ code: "LSP_PROTOCOL_ERROR" });
    } finally {
      await malformed.shutdown();
    }

    const timed = new StdioLspDriver(
      profile(entrypoint),
      rootDir,
      {
        ...process.env,
        REVIEW_LSP_FAKE_MODE: "diagnostic-legacy-delay",
        REVIEW_LSP_FAKE_DELAY_MS: "80",
      },
      120,
      200,
    );
    await timed.start();
    const timedDocument = await open(timed, rootDir);
    try {
      await expect(timed.diagnostics(timedDocument))
        .rejects.toMatchObject({ code: "LSP_TIMEOUT" });
    } finally {
      await timed.shutdown();
    }
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
