import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { URI } from "vscode-uri";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { readCandidateFile, verifyCandidateIntegrity } from "./candidate.js";
import { buildEnvironmentManifest } from "./environment.js";
import { ReviewLspError } from "./errors.js";
import { verifyProjectionSource } from "./projection.js";
import { persistReceipt } from "./receipts.js";
import { verifyTypeScriptProfile } from "./profile.js";
import type {
  BindingState,
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  EnvironmentManifest,
  IsolationKind,
  ProjectionDescriptor,
  SemanticReceipt,
  TypeScriptProfile,
} from "./types.js";
import { candidateSafeEnvironment, languageIdForPath, StdioLspDriver } from "../lsp/client.js";

interface DefinitionBinding {
  uri: string;
  classification: "SOURCE_CANDIDATE" | "TOOLCHAIN_TYPESCRIPT" | "TOOLCHAIN_SERVER" | "UNBOUND";
  path?: string;
  sha256?: string;
}

function admittedCandidatePath(candidate: CandidateDescriptor, path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `invalid candidate path ${JSON.stringify(path)}`);
  }
  const absolute = resolve(candidate.source_root, path);
  const delta = relative(candidate.source_root, absolute);
  if (delta.startsWith("..") || isAbsolute(delta)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `candidate path escapes source root: ${JSON.stringify(path)}`);
  }
  return absolute;
}

/** Resolves an admitted candidate-relative path inside the execution projection. */
function admittedProjectionPath(
  projection: ProjectionDescriptor,
  candidate: CandidateDescriptor,
  path: string,
): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `invalid candidate path ${JSON.stringify(path)}`);
  }
  if (!candidate.entries.some((entry) => entry.path === path && entry.kind === "file")) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `document is not an admitted candidate file: ${path}`);
  }
  const absolute = resolve(projection.execution_root, path);
  const delta = relative(projection.execution_root, absolute);
  if (delta.startsWith("..") || isAbsolute(delta)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `candidate path escapes the projection root: ${JSON.stringify(path)}`);
  }
  return absolute;
}

function resultUris(value: unknown): string[] {
  const uris: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (typeof record.uri === "string") uris.push(record.uri);
    if (typeof record.targetUri === "string") uris.push(record.targetUri);
  };
  visit(value);
  return [...new Set(uris)];
}

async function bindDefinitionUri(
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  uri: string,
): Promise<DefinitionBinding> {
  let fsPath: string;
  try {
    const parsed = URI.parse(uri);
    if (parsed.scheme !== "file") return { uri, classification: "UNBOUND" };
    fsPath = await realpath(parsed.fsPath);
  } catch {
    return { uri, classification: "UNBOUND" };
  }

  const candidateRoot = await realpath(candidate.source_root);
  const candidateDelta = relative(candidateRoot, fsPath);
  if (!candidateDelta.startsWith("..") && !isAbsolute(candidateDelta)) {
    const normalized = candidateDelta.split("\\").join("/");
    const entry = candidate.entries.find((item) => item.path === normalized && item.kind === "file");
    return entry
      ? { uri, classification: "SOURCE_CANDIDATE", path: normalized, sha256: entry.sha256 }
      : { uri, classification: "UNBOUND" };
  }

  const typescriptRoot = await realpath(profile.typescript_root);
  const tsDelta = relative(typescriptRoot, fsPath);
  if (!tsDelta.startsWith("..") && !isAbsolute(tsDelta)) {
    const bytes = await readFile(fsPath);
    return { uri, classification: "TOOLCHAIN_TYPESCRIPT", path: tsDelta, sha256: sha256(bytes) };
  }

  const serverRoot = await realpath(dirname(dirname(profile.server_entrypoint)));
  const serverDelta = relative(serverRoot, fsPath);
  if (!serverDelta.startsWith("..") && !isAbsolute(serverDelta)) {
    const bytes = await readFile(fsPath);
    return { uri, classification: "TOOLCHAIN_SERVER", path: serverDelta, sha256: sha256(bytes) };
  }
  return { uri, classification: "UNBOUND" };
}

export class SemanticSession {
  readonly sessionId: string;
  readonly sessionEpoch = 1;
  readonly environment: EnvironmentManifest;
  private closed = false;

  private constructor(
    readonly candidate: CandidateDescriptor,
    readonly profile: TypeScriptProfile,
    readonly stateDirectory: string,
    environment: EnvironmentManifest,
    readonly isolation: IsolationKind,
    private readonly driver: StdioLspDriver,
    private readonly projection: ProjectionDescriptor | null = null,
  ) {
    this.sessionId = contentId("sess", {
      candidate_id: candidate.candidate_id,
      environment_manifest_sha256: environment.environment_manifest_sha256,
      profile_sha256: profile.profile_sha256,
      epoch: this.sessionEpoch,
      process_nonce: `${process.pid}:${performance.timeOrigin}`,
    });
    this.environment = environment;
  }

  static async create(input: {
    candidate: CandidateDescriptor;
    profile: TypeScriptProfile;
    stateDirectory: string;
    requestTimeoutMs?: number;
    isolation?: IsolationKind;
    isolationIdentity?: string;
    /** An admitted dependency snapshot to bind into environment evidence. */
    snapshot?: DependencySnapshotDescriptor | null;
    /**
     * Execution projection to run the language server against.
     *
     * When present the server is rooted here rather than at the candidate, so the project's
     * own dependencies resolve. Documents are still read from the candidate, so a receipt
     * binds candidate bytes rather than whatever the projection happens to hold.
     */
    projection?: ProjectionDescriptor | null;
  }): Promise<SemanticSession> {
    await verifyCandidateIntegrity(input.candidate);
    await verifyTypeScriptProfile(input.profile);
    const isolation = input.isolation ?? input.candidate.isolation;
    const isolationIdentity = input.isolationIdentity
      ?? (isolation === "TRUSTED_LOCAL" ? `native:${process.platform}:${process.arch}` : "container:unbound");
    const projection = input.projection ?? null;
    if (projection) await verifyProjectionSource(projection, input.candidate);
    const environment = await buildEnvironmentManifest(input.candidate, input.profile, {
      isolation,
      isolationIdentity,
      snapshot: input.snapshot ?? null,
      projection,
    });

    const provisionalSessionId = contentId("sessroot", {
      candidate_id: input.candidate.candidate_id,
      environment_manifest_sha256: environment.environment_manifest_sha256,
      profile_sha256: input.profile.profile_sha256,
      pid: process.pid,
      nonce: performance.now(),
    });
    const runtimeRoot = join(input.stateDirectory, "sessions", provisionalSessionId);
    const home = join(runtimeRoot, "home");
    const tmp = join(runtimeRoot, "tmp");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(tmp, { recursive: true, mode: 0o700 }),
    ]);
    const driver = new StdioLspDriver(
      input.profile,
      projection?.execution_root ?? input.candidate.source_root,
      candidateSafeEnvironment({ home, tmp, profile: input.profile }),
      input.requestTimeoutMs ?? 10_000,
    );
    await driver.start();
    return new SemanticSession(input.candidate, input.profile, input.stateDirectory, environment, isolation, driver, projection);
  }

  async candidateInfo(): Promise<{
    candidate: CandidateDescriptor;
    environment: EnvironmentManifest;
    profile: TypeScriptProfile;
    session_id: string;
    session_epoch: number;
    capabilities: ["hover", "definition"];
  }> {
    this.ensureOpen();
    await verifyCandidateIntegrity(this.candidate);
    return {
      candidate: this.candidate,
      environment: this.environment,
      profile: this.profile,
      session_id: this.sessionId,
      session_epoch: this.sessionEpoch,
      capabilities: ["hover", "definition"],
    };
  }

  async hover(input: { path: string; line: number; character: number }): Promise<SemanticReceipt> {
    return this.query("hover", input);
  }

  async definition(input: { path: string; line: number; character: number }): Promise<SemanticReceipt> {
    return this.query("definition", input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.shutdown();
  }

  private async query(
    operation: "hover" | "definition",
    input: { path: string; line: number; character: number },
  ): Promise<SemanticReceipt> {
    this.ensureOpen();
    if (!Number.isSafeInteger(input.line) || input.line < 0 || !Number.isSafeInteger(input.character) || input.character < 0) {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "line and character must be non-negative 0-based integers");
    }

    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    // The server sees the projection path; the receipt binds the candidate document.
    const absolute = this.projection
      ? admittedProjectionPath(this.projection, this.candidate, input.path)
      : admittedCandidatePath(this.candidate, input.path);
    const languageId = languageIdForPath(input.path);
    if (!languageId) throw new ReviewLspError("CANDIDATE_PATH_INVALID", `unsupported document extension: ${input.path}`);
    const sourceEntry = this.candidate.entries.find((entry) => entry.path === input.path && entry.kind === "file");
    if (!sourceEntry) throw new ReviewLspError("CANDIDATE_PATH_INVALID", `document is not an admitted candidate file: ${input.path}`);
    if (sourceEntry.byte_count > this.profile.document_limit_bytes) {
      throw new ReviewLspError(
        "CANDIDATE_RESOURCE_LIMIT",
        `document ${input.path} is ${sourceEntry.byte_count} bytes; profile limit is ${this.profile.document_limit_bytes}`,
      );
    }
    const documentBytes = await readCandidateFile(this.candidate, input.path);
    const document = await this.driver.openDocument({
      path: absolute,
      text: documentBytes.bytes.toString("utf8"),
      languageId,
    });

    let result: unknown;
    let durationMs: number;
    let environmentBinding: BindingState = this.environment.binding;
    const limitations = [...this.environment.limitations];

    if (operation === "hover") {
      const response = await this.driver.hover(document, input.line, input.character);
      result = response.value;
      durationMs = response.durationMs;
    } else {
      const response = await this.driver.definition(document, input.line, input.character);
      const bindings = await Promise.all(resultUris(response.value).map((uri) => bindDefinitionUri(this.candidate, this.profile, uri)));
      if (bindings.some((binding) => binding.classification === "UNBOUND")) {
        environmentBinding = "PARTIAL";
        limitations.push("definition result includes URI outside admitted candidate/toolchain roots");
      }
      result = { server_response: response.value, bindings };
      durationMs = response.durationMs;
    }

    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    const stableResult = result ?? null;
    const resultBytes = Buffer.byteLength(canonicalJson(stableResult), "utf8");
    if (resultBytes > this.profile.result_limit_bytes) {
      throw new ReviewLspError(
        "CANDIDATE_RESOURCE_LIMIT",
        `semantic result is ${resultBytes} bytes; profile limit is ${this.profile.result_limit_bytes}`,
      );
    }
    return persistReceipt(this.stateDirectory, {
      schema_version: "review-lsp.receipt.v1",
      candidate: {
        candidate_id: this.candidate.candidate_id,
        repository_identity: this.candidate.repository_identity,
        git_object_format: this.candidate.git_object_format,
        commit_oid: this.candidate.commit_oid,
        tree_oid: this.candidate.tree_oid,
        source_manifest_sha256: this.candidate.source_manifest_sha256,
      },
      environment_manifest_sha256: this.environment.environment_manifest_sha256,
      profile_sha256: this.profile.profile_sha256,
      session_id: this.sessionId,
      session_epoch: this.sessionEpoch,
      operation,
      document: {
        path: input.path,
        uri: document.uri,
        sha256: documentBytes.sha256,
        version: document.version,
        language_id: document.languageId,
        position_encoding: "utf-16",
      },
      request: { line: input.line, character: input.character },
      execution_status: "OK",
      source_binding: "VERIFIED",
      environment_binding: environmentBinding,
      isolation: this.isolation,
      result_scope: "SERVER_RESPONSE",
      limitations: [...new Set(limitations)],
      result: stableResult,
      result_sha256: sha256(canonicalJson(stableResult)),
      request_duration_ms: Math.round(durationMs * 1000) / 1000,
      observed_at: new Date().toISOString(),
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new ReviewLspError("LSP_PROTOCOL_ERROR", "semantic session is closed");
  }
}
