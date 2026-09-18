import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { SemanticReceipt } from "./types.js";

function stableReceipt(receipt: Omit<SemanticReceipt, "receipt_id"> | SemanticReceipt): unknown {
  const { receipt_id: _receiptId, ...stable } = receipt as SemanticReceipt;
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
