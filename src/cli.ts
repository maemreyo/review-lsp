#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAndVerifyArtifactManifest } from "./core/artifact.js";
import { containerImageIdFromEnvironment, runDockerSemanticQuery, verifyLinuxReadOnlyMount } from "./core/container.js";
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

async function packageRootFromModule(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === "review-lsp") return current;
    } catch {
      // Keep walking; source and bundled entrypoints live at different depths.
    }
    if (current === filesystemRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("cannot locate review-lsp package root from CLI module path");
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
    "  review-lsp artifact-info",
    "  review-lsp prepare <repo> <commit> [--state DIR]",
    "  review-lsp inspect <candidate.json>",
    "  review-lsp query <candidate.json> <hover|definition> <path> <line> <character> [--state DIR]",
    "  review-lsp container-query <image> <candidate.json> <hover|definition> <path> <line> <character> [--state DIR]",
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

  if (command === "artifact-info") {
    if (args.length !== 0) usage();
    const packageRoot = await packageRootFromModule();
    const manifest = await loadAndVerifyArtifactManifest(packageRoot);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

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

  if (command === "container-query") {
    const [image, descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!image || !descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 6) usage();
    if (operation !== "hover" && operation !== "definition") usage();
    const line = Number(lineRaw);
    const character = Number(characterRaw);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const container = await runDockerSemanticQuery({
      candidate,
      operation,
      path,
      line,
      character,
      image,
      stateDirectory,
    });
    process.stdout.write(`${JSON.stringify({
      receipt_path: receiptPath(stateDirectory, container.receipt),
      receipt: container.receipt,
      environment: container.environment,
      image_id: container.image_id,
    }, null, 2)}\n`);
    return;
  }

  if (command === "__container-query") {
    const [descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 5) usage();
    if (operation !== "hover" && operation !== "definition") usage();
    const line = Number(lineRaw);
    const character = Number(characterRaw);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    await verifyLinuxReadOnlyMount(candidate.source_root);
    const imageId = containerImageIdFromEnvironment();
    const profile = await createTypeScriptProfile();
    const session = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory,
      isolation: "CONTAINER_READ_ONLY",
      isolationIdentity: `docker:${imageId}`,
    });
    try {
      const receipt = operation === "hover"
        ? await session.hover({ path, line, character })
        : await session.definition({ path, line, character });
      process.stdout.write(`${JSON.stringify({
        receipt,
        environment: session.environment,
      }, null, 2)}\n`);
    } finally {
      await session.close();
    }
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
