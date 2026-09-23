#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAndVerifyArtifactManifest } from "./core/artifact.js";
import {
  containerImageIdFromEnvironment,
  runDockerDiagnostics,
  runDockerSemanticQuery,
  verifyLinuxReadOnlyMount,
} from "./core/container.js";
import {
  candidateDescriptorPath,
  loadCandidateDescriptor,
  prepareCandidate,
  removeCandidate,
} from "./core/candidate.js";
import { acquireDependencies } from "./core/dependency-acquisition.js";
import { deriveDependencyInputs } from "./core/dependency-inputs.js";
import { prepareSemanticEnvironment } from "./core/semantic-environment.js";
import { resolveProjectForDocument, resolvingProjectIdentity } from "./core/toolchain.js";
import { ReviewLspError } from "./core/errors.js";
import { createTypeScriptProfile } from "./core/profile.js";
import {
  diagnosticsReceiptPath,
  receiptPath,
  validateDiagnosticsReceiptFile,
  validateReceiptFile,
} from "./core/receipts.js";
import { SemanticRuntimeManager } from "./core/runtime.js";
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

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function referenceDeclarationOption(operation: string, raw: string | undefined): boolean | undefined {
  if (operation !== "references") {
    if (raw !== undefined) throw new Error("--include-declaration is only valid for references queries");
    return undefined;
  }
  if (raw === undefined) throw new Error("references queries require --include-declaration <true|false>");
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("--include-declaration must be true or false");
}

type QueryOperation = "hover" | "definition" | "references";

async function runSessionQuery(input: {
  session: SemanticSession;
  operation: QueryOperation;
  path: string;
  line: number;
  character: number;
  includeDeclaration?: boolean | undefined;
}) {
  const { session, operation, path, line, character } = input;
  if (operation === "hover") return session.hover({ path, line, character });
  if (operation === "definition") return session.definition({ path, line, character });
  if (typeof input.includeDeclaration !== "boolean") {
    throw new Error("references query requires includeDeclaration");
  }
  return session.references({ path, line, character, includeDeclaration: input.includeDeclaration });
}

function usage(): never {
  process.stderr.write([
    "Review-LSP",
    "",
    "  review-lsp artifact-info",
    "  review-lsp prepare <repo> <commit> [--state DIR] [--compact]",
    "  review-lsp inspect <candidate.json>",
    "  review-lsp dependency-inputs <candidate.json>",
    "  review-lsp acquire <candidate.json> [--state DIR] [--allow-network]",
    "  review-lsp query <candidate.json> <hover|definition|references> <path> <line> <character> [--include-declaration true|false] [--state DIR]",
    "  review-lsp diagnostics <candidate.json> <path> [--state DIR]",
    "  review-lsp container-query <image> <candidate.json> <hover|definition|references> <path> <line> <character> [--include-declaration true|false] [--state DIR]",
    "  review-lsp container-diagnostics <image> <candidate.json> <path> [--state DIR]",
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
    const compact = flag(args, "--compact");
    const [repo, commit] = args;
    if (!repo || !commit || args.length !== 2) usage();
    const candidate = await prepareCandidate({ repo: resolve(repo), commit, stateDirectory });
    // A consumer that only needs to bind and locate the candidate should not have to receive
    // the whole entries manifest over stdout; the descriptor on disk remains authoritative.
    const payload = compact
      ? {
          candidate_descriptor: candidateDescriptorPath(candidate),
          candidate: {
            schema_version: candidate.schema_version,
            candidate_id: candidate.candidate_id,
            repository_identity: candidate.repository_identity,
            git_object_format: candidate.git_object_format,
            commit_oid: candidate.commit_oid,
            tree_oid: candidate.tree_oid,
            source_manifest_sha256: candidate.source_manifest_sha256,
            source_root: candidate.source_root,
            isolation: candidate.isolation,
            prepared_at: candidate.prepared_at,
            entry_count: candidate.entries.length,
            tracked_bytes: candidate.entries.reduce((total, entry) => total + entry.byte_count, 0),
          },
        }
      : { candidate_descriptor: candidateDescriptorPath(candidate), candidate };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (command === "inspect") {
    const [descriptor] = args;
    if (!descriptor || args.length !== 1) usage();
    process.stdout.write(`${JSON.stringify(await loadCandidateDescriptor(resolve(descriptor)), null, 2)}\n`);
    return;
  }

  if (command === "dependency-inputs") {
    const [descriptor] = args;
    if (!descriptor || args.length !== 1) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    process.stdout.write(`${JSON.stringify(await deriveDependencyInputs(candidate), null, 2)}\n`);
    return;
  }

  if (command === "acquire") {
    // Acquisition is opt-in per invocation. Network access is never inherited from a previous
    // run, a configuration file, or the semantic query path.
    const allowNetwork = flag(args, "--allow-network");
    const [descriptor] = args;
    if (!descriptor || args.length !== 1) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const inputs = await deriveDependencyInputs(candidate);
    const report = await acquireDependencies({
      candidate,
      inputs,
      stateDirectory,
      networkPolicy: allowNetwork ? "EXPLICIT_ACQUISITION" : "OFFLINE",
    });
    process.stdout.write(`${JSON.stringify({ input_set: { input_set_id: inputs.input_set_id }, acquisition: report }, null, 2)}\n`);
    // A non-satisfied acquisition is an actionable outcome, not a crash, but it must not look
    // like success to a caller that only checks the exit status.
    if (report.state !== "SATISFIED") process.exitCode = 3;
    return;
  }

  if (command === "validate") {
    const [path] = args;
    if (!path || args.length !== 1) usage();
    const absolute = resolve(path);
    const raw = JSON.parse(await readFile(absolute, "utf8")) as { schema_version?: unknown };
    const receipt = raw.schema_version === "review-lsp.diagnostics-receipt.v1"
      ? await validateDiagnosticsReceiptFile(absolute)
      : await validateReceiptFile(absolute);
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

  if (command === "container-diagnostics") {
    const [image, descriptor, path] = args;
    if (!image || !descriptor || !path || args.length !== 3) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const container = await runDockerDiagnostics({
      candidate,
      path,
      image,
      stateDirectory,
    });
    process.stdout.write(`${JSON.stringify({
      receipt_path: diagnosticsReceiptPath(stateDirectory, container.receipt),
      receipt: container.receipt,
      environment: container.environment,
      image_id: container.image_id,
    }, null, 2)}\n`);
    return;
  }

  if (command === "container-query") {
    const includeDeclarationRaw = option(args, "--include-declaration");
    const [image, descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!image || !descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 6) usage();
    if (operation !== "hover" && operation !== "definition" && operation !== "references") usage();
    const includeDeclaration = referenceDeclarationOption(operation, includeDeclarationRaw);
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
      ...(operation === "references" ? { includeDeclaration: includeDeclaration as boolean } : {}),
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

  if (command === "__container-diagnostics") {
    const [descriptor, path] = args;
    if (!descriptor || !path || args.length !== 2) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    await verifyLinuxReadOnlyMount(candidate.source_root);
    const imageId = containerImageIdFromEnvironment();
    const profile = await createTypeScriptProfile();
    const resolvingProject = await resolveProjectForDocument(candidate, path);
    const session = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory,
      isolation: "CONTAINER_READ_ONLY",
      isolationIdentity: `docker:${imageId}`,
      resolvingProject,
    });
    try {
      const receipt = await session.diagnostics({ path });
      process.stdout.write(`${JSON.stringify({
        receipt,
        environment: session.environment,
      }, null, 2)}\n`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "__container-query") {
    const includeDeclarationRaw = option(args, "--include-declaration");
    const [descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 5) usage();
    if (operation !== "hover" && operation !== "definition" && operation !== "references") usage();
    const includeDeclaration = referenceDeclarationOption(operation, includeDeclarationRaw);
    const line = Number(lineRaw);
    const character = Number(characterRaw);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    await verifyLinuxReadOnlyMount(candidate.source_root);
    const imageId = containerImageIdFromEnvironment();
    const profile = await createTypeScriptProfile();
    const resolvingProject = await resolveProjectForDocument(candidate, path);
    const session = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory,
      isolation: "CONTAINER_READ_ONLY",
      isolationIdentity: `docker:${imageId}`,
      resolvingProject,
    });
    try {
      const receipt = await runSessionQuery({
        session,
        operation,
        path,
        line,
        character,
        ...(operation === "references" ? { includeDeclaration } : {}),
      });
      process.stdout.write(`${JSON.stringify({
        receipt,
        environment: session.environment,
      }, null, 2)}\n`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "diagnostics") {
    const [descriptor, path] = args;
    if (!descriptor || !path || args.length !== 2) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const inferredState = resolve(candidate.source_root, "..", "..", "..");
    const queryState = stateOverride ? stateDirectory : inferredState;
    const profile = await createTypeScriptProfile();
    const environment = await prepareSemanticEnvironment({
      candidate,
      stateDirectory: queryState,
    });
    const { snapshot, projection } = environment;
    const resolvingProject = await resolveProjectForDocument(candidate, path);
    const session = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: queryState,
      snapshot,
      projection,
      resolvingProject,
    });
    try {
      const info = await session.candidateInfo();
      if (!info.capabilities.includes("diagnostics")) {
        throw new ReviewLspError("LSP_CAPABILITY_UNSUPPORTED", "initialized semantic engine does not admit deterministic diagnostics");
      }
      const receipt = await session.diagnostics({ path });
      process.stdout.write(`${JSON.stringify({
        receipt_path: diagnosticsReceiptPath(queryState, receipt),
        receipt,
      }, null, 2)}\n`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command === "query") {
    const includeDeclarationRaw = option(args, "--include-declaration");
    const [descriptor, operation, path, lineRaw, characterRaw] = args;
    if (!descriptor || !operation || !path || lineRaw === undefined || characterRaw === undefined || args.length !== 5) usage();
    if (operation !== "hover" && operation !== "definition" && operation !== "references") usage();
    const includeDeclaration = referenceDeclarationOption(operation, includeDeclarationRaw);
    const line = Number(lineRaw);
    const character = Number(characterRaw);
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) usage();
    const candidate = await loadCandidateDescriptor(resolve(descriptor));
    const inferredState = resolve(candidate.source_root, "..", "..", "..");
    const queryState = stateOverride ? stateDirectory : inferredState;
    const profile = await createTypeScriptProfile();
    const environment = await prepareSemanticEnvironment({
      candidate,
      stateDirectory: queryState,
    });
    const { snapshot, projection } = environment;
    const resolvingProject = await resolveProjectForDocument(candidate, path);
    const session = await SemanticSession.create({
      candidate,
      profile,
      stateDirectory: queryState,
      snapshot,
      projection,
      resolvingProject,
    });
    try {
      const receipt = await runSessionQuery({
        session,
        operation,
        path,
        line,
        character,
        ...(operation === "references" ? { includeDeclaration } : {}),
      });
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
    const environment = await prepareSemanticEnvironment({ candidate, stateDirectory });
    const runtimeManager = new SemanticRuntimeManager();

    process.stderr.write(`review-lsp bound candidate ${candidate.candidate_id} commit ${candidate.commit_oid}\n`);
    await serveCandidateMcp({
      candidate,
      profile,
      stateDirectory,
      snapshot: environment.snapshot,
      projection: environment.projection,
      derivedArtifactSnapshotIds: environment.derived_artifacts.map((artifact) => artifact.artifact_id),
      runtimeManager,
      resolvingProjectIdentity,
    });
    return;
  }

  usage();
}

main().catch((error) => {
  const code = error instanceof ReviewLspError ? error.code : "INTERNAL_ERROR";
  process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
