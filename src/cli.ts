#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  candidateDescriptorPath,
  loadCandidateDescriptor,
  prepareCandidate,
  removeCandidate,
} from "./core/candidate.js";
import { ReviewLspError } from "./core/errors.js";
import { createTypeScriptProfile } from "./core/profile.js";
import { receiptPath, validateReceiptFile } from "./core/receipts.js";
import { SemanticSession } from "./core/session.js";
import { serveCandidateMcp } from "./mcp/server.js";

function defaultStateDirectory(): string {
  return process.env.REVIEW_LSP_STATE_DIR
    ? resolve(process.env.REVIEW_LSP_STATE_DIR)
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "review-lsp");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function usage(): never {
  process.stderr.write([
    "Review-LSP",
    "",
    "  review-lsp prepare <repo> <commit> [--state DIR]",
    "  review-lsp inspect <candidate.json>",
    "  review-lsp query <candidate.json> <hover|definition> <path> <line> <character> [--state DIR]",
    "  review-lsp validate <receipt.json>",
    "  review-lsp close <candidate.json>",
    "  review-lsp serve <repo> <commit> [--state DIR]",
    "",
    "Positions are 0-based LSP positions; character is a UTF-16 code-unit offset for the v0.1 TypeScript profile.",
    "",
  ].join("\n"));
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command) usage();
  const stateOverride = option(args, "--state");
  const stateDirectory = resolve(stateOverride ?? defaultStateDirectory());

  if (command === "prepare") {
    const [repo, commit] = args;
    if (!repo || !commit || args.length !== 2) usage();
    const candidate = await prepareCandidate({ repo: resolve(repo), commit, stateDirectory });
    process.stdout.write(`${JSON.stringify({
      candidate_descriptor: candidateDescriptorPath(candidate),
      candidate,
    }, null, 2)}\n`);
    return;
  }

  if (command === "inspect") {
    const [descriptor] = args;
    if (!descriptor || args.length !== 1) usage();
    process.stdout.write(`${JSON.stringify(await loadCandidateDescriptor(resolve(descriptor)), null, 2)}\n`);
    return;
  }

  if (command === "validate") {
    const [path] = args;
    if (!path || args.length !== 1) usage();
    const receipt = await validateReceiptFile(resolve(path));
    process.stdout.write(`${JSON.stringify({ valid: true, receipt_id: receipt.receipt_id }, null, 2)}\n`);
    return;
  }

  if (command === "close") {
    const [descriptor] = args;
    if (!descriptor || args.length !== 1) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    await removeCandidate(candidate);
    process.stdout.write(`${JSON.stringify({ removed: true, candidate_id: candidate.candidate_id })}\n`);
    return;
  }

  if (command === "query") {
    const [descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 5) usage();
    if (operation !== "hover" && operation !== "definition") usage();
    const line = Number(lineRaw);
    const character = Number(characterRaw);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const inferredState = resolve(candidate.source_root, "..", "..", "..");
    const queryState = stateOverride ? stateDirectory : inferredState;
    const profile = await createTypeScriptProfile();
    const session = await SemanticSession.create({ candidate, profile, stateDirectory: queryState });
    try {
      const receipt = operation === "hover"
        ? await session.hover({ path, line, character })
        : await session.definition({ path, line, character });
      process.stdout.write(`${JSON.stringify({
        receipt_path: receiptPath(queryState, receipt),
        receipt,
      }, null, 2)}\n`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "serve") {
    const [repo, commit] = args;
    if (!repo || !commit || args.length !== 2) usage();
    const candidate = await prepareCandidate({ repo: resolve(repo), commit, stateDirectory });
    const profile = await createTypeScriptProfile();
    const session = await SemanticSession.create({ candidate, profile, stateDirectory });
    process.stderr.write(`review-lsp bound candidate ${candidate.candidate_id} commit ${candidate.commit_oid}\n`);
    await serveCandidateMcp(session);
    return;
  }

  usage();
}

main().catch((error) => {
  const code = error instanceof ReviewLspError ? error.code : "INTERNAL_ERROR";
  process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
