import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { persistReceipt, receiptPath, validateReceipt, validateReceiptFile } from "../../src/core/receipts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("receipt integrity", () => {
  it("detects receipt/result mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-receipt-"));
    roots.push(root);
    const receipt = await persistReceipt(root, {
      schema_version: "review-lsp.receipt.v1",
      candidate: {
        candidate_id: "cand_fixture",
        repository_identity: "repo",
        git_object_format: "sha1",
        commit_oid: "a",
        tree_oid: "b",
        source_manifest_sha256: "c",
      },
      environment_manifest_sha256: "d",
      profile_sha256: "e",
      session_id: "sess",
      session_epoch: 1,
      operation: "hover",
      document: {
        path: "src/a.ts",
        uri: "file:///src/a.ts",
        sha256: "f",
        version: 1,
        language_id: "typescript",
        position_encoding: "utf-16",
      context: { line_text: "export const value = 1;", line_sha256: "5".repeat(64), token: "value", line_length: 23 },
      },
      request: { line: 0, character: 0 },
      execution_status: "OK",
      semantic_toolchain: {
      resolving_project: { state: "RESOLVED", config_path: "tsconfig.json", config_sha256: "0".repeat(64), project_root: "" },
      resolving_project_identity: "1".repeat(64),
      project_toolchain: { typescript_version: "6.0.3", source: "MANIFEST_DECLARATION" },
      semantic_engine: { implementation: "typescript-language-server", typescript_version: "6.0.3", is_project_admitted: false },
      candidate_engine: null,
      execution_profile: { kind: "TRUSTED_LOCAL", enforced: false, identity: "native:test" },
      toolchain_alignment: "COMPATIBILITY_PROFILE",
      toolchain_alignment_reason: null,
      exact_project_blocked_by: "no candidate-selected engine artifact is admitted",
    },
    source_binding: "VERIFIED",
      environment_binding: "VERIFIED",
      isolation: "TRUSTED_LOCAL",
      result_scope: "SERVER_RESPONSE",
      limitations: [],
      result: { contents: "string" },
      result_sha256: "8a4d76e0d4af28f0e8625dbf0c73ee7b2524541acd9bb5ec8c45f6fab39e57f4",
      request_duration_ms: 1,
      observed_at: "2026-09-18T00:00:00.000Z",
    });
    expect(() => validateReceipt({ ...receipt, operation: "references" })).toThrow(/include_declaration/);
    expect(() => validateReceipt({
      ...receipt,
      request: { ...receipt.request, include_declaration: false },
    })).toThrow(/must not contain request\.include_declaration/);

    const path = receiptPath(root, receipt);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    stored.result = { contents: "number" };
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
    await expect(validateReceiptFile(path)).rejects.toThrow(/RECEIPT_INVALID/);
  });
});
