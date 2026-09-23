import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { DiagnosticsReceipt, SemanticReceipt } from "./types.js";

function stableReceipt(receipt: Omit<SemanticReceipt, "receipt_id"> | SemanticReceipt): unknown {
  const { receipt_id: _receiptId, ...stable } = receipt as SemanticReceipt;
  return stable;
}

function stableDiagnosticsReceipt(
  receipt: Omit<DiagnosticsReceipt, "receipt_id"> | DiagnosticsReceipt,
): unknown {
  const { receipt_id: _receiptId, ...stable } = receipt as DiagnosticsReceipt;
  return stable;
}

export async function persistReceipt(
  stateDirectory: string,
  receipt: Omit<SemanticReceipt, "receipt_id">,
): Promise<SemanticReceipt> {
  const receiptId = contentId("rcpt", stableReceipt(receipt));
  const full: SemanticReceipt = { ...receipt, receipt_id: receiptId };
  const directory = join(stateDirectory, "receipts", full.candidate.candidate_id);
  const path = join(directory, `${receiptId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${receiptId}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  let published = false;
  try {
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  if (published) return full;
  const existing = JSON.parse(await readFile(path, "utf8")) as SemanticReceipt;
  validateReceipt(existing);
  if (canonicalJson(existing) !== canonicalJson(full)) {
    throw new ReviewLspError("RECEIPT_INVALID", `existing receipt ${receiptId} differs from deterministic content`);
  }
  return existing;
}

export function validateReceipt(receipt: SemanticReceipt): void {
  if (receipt.schema_version !== "review-lsp.receipt.v1") {
    throw new ReviewLspError("RECEIPT_INVALID", `unsupported receipt schema ${String(receipt.schema_version)}`);
  }
  if (!["hover", "definition", "references"].includes(receipt.operation)) {
    throw new ReviewLspError("RECEIPT_INVALID", `unsupported semantic operation ${String(receipt.operation)}`);
  }
  if (!receipt.request
    || !Number.isSafeInteger(receipt.request.line)
    || receipt.request.line < 0
    || !Number.isSafeInteger(receipt.request.character)
    || receipt.request.character < 0) {
    throw new ReviewLspError("RECEIPT_INVALID", "receipt request position must contain non-negative integer line/character");
  }
  const hasIncludeDeclaration = Object.prototype.hasOwnProperty.call(receipt.request, "include_declaration");
  if (receipt.operation === "references") {
    if (!hasIncludeDeclaration || typeof receipt.request.include_declaration !== "boolean") {
      throw new ReviewLspError("RECEIPT_INVALID", "references receipt must bind boolean request.include_declaration");
    }
  } else if (hasIncludeDeclaration) {
    throw new ReviewLspError("RECEIPT_INVALID", `${receipt.operation} receipt must not contain request.include_declaration`);
  }
  if (contentId("rcpt", stableReceipt(receipt)) !== receipt.receipt_id) {
    throw new ReviewLspError("RECEIPT_INVALID", "receipt content-addressed identity does not match content");
  }
  if (sha256(canonicalJson(receipt.result)) !== receipt.result_sha256) {
    throw new ReviewLspError("RECEIPT_INVALID", "receipt result digest does not match result");
  }
}

export async function validateReceiptFile(path: string): Promise<SemanticReceipt> {
  const receipt = JSON.parse(await readFile(path, "utf8")) as SemanticReceipt;
  validateReceipt(receipt);
  return receipt;
}

export function receiptPath(stateDirectory: string, receipt: SemanticReceipt): string {
  return join(stateDirectory, "receipts", receipt.candidate.candidate_id, `${receipt.receipt_id}.json`);
}

export async function persistDiagnosticsReceipt(
  stateDirectory: string,
  receipt: Omit<DiagnosticsReceipt, "receipt_id">,
): Promise<DiagnosticsReceipt> {
  const receiptId = contentId("rcpt", stableDiagnosticsReceipt(receipt));
  const full: DiagnosticsReceipt = { ...receipt, receipt_id: receiptId };
  validateDiagnosticsReceipt(full);
  const directory = join(stateDirectory, "diagnostics-receipts", full.candidate.candidate_id);
  const path = join(directory, `${receiptId}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${receiptId}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  let published = false;
  try {
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  if (published) return full;
  const existing = JSON.parse(await readFile(path, "utf8")) as DiagnosticsReceipt;
  validateDiagnosticsReceipt(existing);
  if (canonicalJson(existing) !== canonicalJson(full)) {
    throw new ReviewLspError("RECEIPT_INVALID", `existing diagnostics receipt ${receiptId} differs from deterministic content`);
  }
  return existing;
}

export function validateDiagnosticsReceipt(receipt: DiagnosticsReceipt): void {
  if (receipt.schema_version !== "review-lsp.diagnostics-receipt.v1") {
    throw new ReviewLspError("RECEIPT_INVALID", `unsupported diagnostics receipt schema ${String(receipt.schema_version)}`);
  }
  if (receipt.operation !== "diagnostics"
    || receipt.request?.scope !== "document"
    || receipt.result_scope !== "DOCUMENT_DIAGNOSTICS"
    || receipt.completeness !== "ENGINE_FULL_DOCUMENT_RESPONSE") {
    throw new ReviewLspError("RECEIPT_INVALID", "diagnostics receipt scope contract is invalid");
  }
  let expectedOperations: string[] | null = null;
  if (receipt.transport.kind === "LSP_DOCUMENT_DIAGNOSTIC") {
    expectedOperations = ["textDocument/diagnostic"];
  } else if (receipt.transport.kind === "TSSERVER_SYNC_DIAGNOSTICS") {
    expectedOperations = ["syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync"];
  }
  if (!expectedOperations
    || canonicalJson(receipt.transport.protocol_operations) !== canonicalJson(expectedOperations)) {
    throw new ReviewLspError("RECEIPT_INVALID", "diagnostics receipt transport operations do not match transport kind");
  }
  if (receipt.transport.kind === "LSP_DOCUMENT_DIAGNOSTIC" && receipt.transport.diagnostic_provider === null) {
    throw new ReviewLspError("RECEIPT_INVALID", "LSP diagnostics receipt must bind diagnostic-provider metadata");
  }
  if (receipt.transport.kind === "TSSERVER_SYNC_DIAGNOSTICS" && receipt.transport.diagnostic_provider !== null) {
    throw new ReviewLspError("RECEIPT_INVALID", "legacy diagnostics receipt must not bind LSP diagnostic-provider metadata");
  }
  if (!Array.isArray(receipt.result)) {
    throw new ReviewLspError("RECEIPT_INVALID", "diagnostics receipt result must be an array");
  }
  if (contentId("rcpt", stableDiagnosticsReceipt(receipt)) !== receipt.receipt_id) {
    throw new ReviewLspError("RECEIPT_INVALID", "diagnostics receipt content-addressed identity does not match content");
  }
  if (sha256(canonicalJson(receipt.result)) !== receipt.result_sha256) {
    throw new ReviewLspError("RECEIPT_INVALID", "diagnostics receipt result digest does not match result");
  }
}

export async function validateDiagnosticsReceiptFile(path: string): Promise<DiagnosticsReceipt> {
  const receipt = JSON.parse(await readFile(path, "utf8")) as DiagnosticsReceipt;
  validateDiagnosticsReceipt(receipt);
  return receipt;
}

export function diagnosticsReceiptPath(stateDirectory: string, receipt: DiagnosticsReceipt): string {
  return join(stateDirectory, "diagnostics-receipts", receipt.candidate.candidate_id, `${receipt.receipt_id}.json`);
}
