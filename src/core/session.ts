import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { Diagnostic } from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { readCandidateFile, verifyCandidateIntegrity } from "./candidate.js";
import { buildEnvironmentManifest } from "./environment.js";
import { verifyDependencySnapshot } from "./dependency-snapshot.js";
import { ReviewLspError } from "./errors.js";
import { assertCoordinateExpectation, buildCoordinateContext } from "./coordinate.js";
import { classifyProjectionUri, verifyProjectionDescriptor } from "./projection.js";
import { admitEngineArtifact, buildCandidateEngineLaunch, engineMayClaimExactProject, resolveExecutionProfile } from "./engine-isolation.js";
import {
  alignmentBlocksStrongAdmission,
  assessToolchainAlignment,
  resolveProjectForDocument,
  resolveProjectToolchain,
  resolvingProjectIdentity,
} from "./toolchain.js";
import { persistDiagnosticsReceipt, persistReceipt } from "./receipts.js";
import { verifyTypeScriptProfile } from "./profile.js";
import type {
  AdmittedEngineArtifact,
  BindingState,
  CandidateDescriptor,
  CoordinateExpectation,
  DependencySnapshotDescriptor,
  DiagnosticsReceipt,
  EnvironmentManifest,
  ExecutionProfile,
  IsolationKind,
  NormalizedDiagnostic,
  NormalizedDiagnosticRelatedInformation,
  NormalizedDiagnosticSeverity,
  ProjectionDescriptor,
  ResolvingProject,
  SemanticReceipt,
  SemanticTargetBinding,
  SemanticToolchainEvidence,
  TypeScriptProfile,
} from "./types.js";
import {
  candidateSafeEnvironment,
  languageIdForPath,
  StdioLspDriver,
  type DiagnosticTransportOutcome,
  type LegacyDiagnostic,
  type LegacyDiagnosticRelatedInformation,
} from "../lsp/client.js";

export interface SemanticQueryInput {
  path: string;
  line: number;
  character: number;
  /**
   * Optional statement of what the caller is aiming at.
   *
   * A guard on the question, never an upgrade to the evidence: matching it does not make an
   * answer stronger, and a semantically irrelevant result stays irrelevant.
   */
  expect?: CoordinateExpectation;
}

export interface ReferencesQueryInput extends SemanticQueryInput {
  /** Whether the declaration location itself is part of the requested reference set. */
  includeDeclaration: boolean;
}

export interface DiagnosticsQueryInput {
  path: string;
}

const diagnosticsCoreQuery = Symbol("review-lsp.diagnostics-core-query");

export async function queryDiagnosticsCore(
  session: SemanticSession,
  input: DiagnosticsQueryInput,
): Promise<DiagnosticsReceipt> {
  return session[diagnosticsCoreQuery](input);
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

/**
 * Binds a semantic target URI to an admitted root.
 *
 * Classification goes through the projection-aware classifier so that a result reached
 * lexically through the projection but really living in the sealed dependency snapshot is
 * recognised as such. Without that, every correct definition into a dependency would look
 * like an escape and downgrade the evidence.
 *
 * A candidate-source result is bound to the candidate entry's digest, not to the bytes found
 * in the projection, so the binding remains a statement about the candidate.
 */
async function bindSemanticTargetUri(
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  uri: string,
  roots: { executionRoot: string; dependencyRoot?: string | undefined; derivedRoots?: string[] | undefined },
): Promise<SemanticTargetBinding> {
  const serverRoot = profile.server_runtime_root;
  const classified = await classifyProjectionUri(uri, {
    executionRoot: roots.executionRoot,
    dependencyRoot: roots.dependencyRoot,
    derivedRoots: roots.derivedRoots,
    toolchainRoots: [profile.typescript_root, serverRoot],
  });

  if (classified.classification === "UNBOUND") {
    return { uri, classification: "UNBOUND", ...(classified.reason ? { reason: classified.reason } : {}) };
  }

  if (classified.classification === "CANDIDATE_SOURCE") {
    const normalized = (classified.relative_path ?? "").split("\\").join("/");
    const entry = candidate.entries.find((item) => item.path === normalized && item.kind === "file");
    return entry
      ? { uri, classification: "SOURCE_CANDIDATE", path: normalized, sha256: entry.sha256 }
      : { uri, classification: "UNBOUND", reason: "path is inside the source root but is not an admitted candidate file" };
  }

  if (classified.classification === "DEPENDENCY_SNAPSHOT") {
    const bytes = await readFile(classified.realpath ?? classified.path).catch(() => undefined);
    return bytes
      ? { uri, classification: "DEPENDENCY_SNAPSHOT", path: classified.relative_path ?? "", sha256: sha256(bytes) }
      : { uri, classification: "UNBOUND", reason: "dependency snapshot path could not be read" };
  }

  if (classified.classification === "DERIVED_WORKSPACE_ARTIFACT") {
    const bytes = await readFile(classified.realpath ?? classified.path).catch(() => undefined);
    return bytes
      ? {
          uri,
          classification: "DERIVED_WORKSPACE_ARTIFACT",
          path: classified.relative_path ?? "",
          sha256: sha256(bytes),
        }
      : { uri, classification: "UNBOUND", reason: "derived workspace artifact path could not be read" };
  }

  if (classified.classification === "TOOLCHAIN") {
    const resolved = classified.realpath ?? classified.path;
    const bytes = await readFile(resolved).catch(() => undefined);
    if (!bytes) return { uri, classification: "UNBOUND", reason: "toolchain path could not be read" };
    const typescriptRoot = await realpath(profile.typescript_root).catch(() => profile.typescript_root);
    const tsDelta = relative(typescriptRoot, resolved);
    const inTypeScript = !tsDelta.startsWith("..") && !isAbsolute(tsDelta);
    return {
      uri,
      classification: inTypeScript ? "TOOLCHAIN_TYPESCRIPT" : "TOOLCHAIN_SERVER",
      path: classified.relative_path ?? "",
      sha256: sha256(bytes),
    };
  }

  return { uri, classification: "UNBOUND", reason: "result is not bound to an admitted root" };
}

interface DiagnosticBindingRoots {
  executionRoot: string;
  dependencyRoot?: string | undefined;
  derivedRoots?: string[] | undefined;
}

function normalizeLspRange(range: Diagnostic["range"]): NormalizedDiagnostic["range"] {
  if (!range || !range.start || !range.end) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "diagnostic range is malformed");
  }
  const values = [range.start.line, range.start.character, range.end.line, range.end.character];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "diagnostic range must contain non-negative integer coordinates");
  }
  if (range.end.line < range.start.line
    || (range.end.line === range.start.line && range.end.character < range.start.character)) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "diagnostic range end precedes its start");
  }
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function normalizeLegacyRange(
  start: { line: number; offset: number },
  end: { line: number; offset: number },
): NormalizedDiagnostic["range"] {
  if (!start || !end) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic range is malformed");
  }
  const values = [start.line, start.offset, end.line, end.offset];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 1)) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic range must contain positive integer locations");
  }
  if (end.line < start.line || (end.line === start.line && end.offset < start.offset)) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic range end precedes its start");
  }
  return {
    start: { line: start.line - 1, character: start.offset - 1 },
    end: { line: end.line - 1, character: end.offset - 1 },
  };
}

function normalizeLspSeverity(severity: number | undefined): NormalizedDiagnosticSeverity {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  if (severity === 4) return "hint";
  return "unknown";
}

function normalizeLegacySeverity(category: string): NormalizedDiagnosticSeverity {
  if (category === "error") return "error";
  if (category === "warning") return "warning";
  if (category === "message") return "information";
  if (category === "suggestion") return "hint";
  return "unknown";
}

function normalizeDiagnosticCode(code: unknown): string | number | null {
  return typeof code === "string" || typeof code === "number" ? code : null;
}

function compareDiagnostics(left: NormalizedDiagnostic, right: NormalizedDiagnostic): number {
  const coordinates = [
    left.range.start.line - right.range.start.line,
    left.range.start.character - right.range.start.character,
    left.range.end.line - right.range.end.line,
    left.range.end.character - right.range.end.character,
  ];
  for (const delta of coordinates) if (delta !== 0) return delta;
  const leftFields = [
    left.severity,
    String(left.code ?? ""),
    left.source ?? "",
    left.message,
    left.kind,
    canonicalJson(left.related_information),
  ];
  const rightFields = [
    right.severity,
    String(right.code ?? ""),
    right.source ?? "",
    right.message,
    right.kind,
    canonicalJson(right.related_information),
  ];
  for (let index = 0; index < leftFields.length; index += 1) {
    const delta = leftFields[index]!.localeCompare(rightFields[index]!);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function normalizeLspRelatedInformation(
  diagnostic: Diagnostic,
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  roots: DiagnosticBindingRoots,
): Promise<NormalizedDiagnosticRelatedInformation[]> {
  const related = await Promise.all((diagnostic.relatedInformation ?? []).map(async (item) => {
    if (!item
      || typeof item.message !== "string"
      || !item.location
      || typeof item.location.uri !== "string"
      || item.location.uri.length === 0) {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "LSP diagnostic related information is malformed");
    }
    const binding = await bindSemanticTargetUri(candidate, profile, item.location.uri, roots);
    return {
      message: item.message,
      code: null,
      severity: "unknown" as const,
      range: normalizeLspRange(item.location.range),
      uri: item.location.uri,
      binding,
    };
  }));
  return related.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

async function normalizeLegacyRelatedInformation(
  related: LegacyDiagnosticRelatedInformation[] | undefined,
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  roots: DiagnosticBindingRoots,
): Promise<NormalizedDiagnosticRelatedInformation[]> {
  const normalized = await Promise.all((related ?? []).map(async (item) => {
    if (!item || typeof item.message !== "string" || typeof item.category !== "string") {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic related information is malformed");
    }
    if (!item.span) {
      return {
        message: item.message,
        code: normalizeDiagnosticCode(item.code),
        severity: normalizeLegacySeverity(item.category),
        range: null,
        uri: null,
        binding: null,
      };
    }
    if (typeof item.span.file !== "string" || item.span.file.length === 0) {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic related span has no file");
    }
    const uri = URI.file(item.span.file).toString();
    const binding = await bindSemanticTargetUri(candidate, profile, uri, roots);
    return {
      message: item.message,
      code: normalizeDiagnosticCode(item.code),
      severity: normalizeLegacySeverity(item.category),
      range: normalizeLegacyRange(item.span.start, item.span.end),
      uri,
      binding,
    };
  }));
  return normalized.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

async function normalizeLspDiagnostic(
  diagnostic: Diagnostic,
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  roots: DiagnosticBindingRoots,
): Promise<NormalizedDiagnostic> {
  if (!diagnostic || typeof diagnostic.message !== "string") {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "LSP diagnostic is malformed");
  }
  return {
    kind: "engine",
    range: normalizeLspRange(diagnostic.range),
    severity: normalizeLspSeverity(diagnostic.severity),
    code: normalizeDiagnosticCode(diagnostic.code),
    source: typeof diagnostic.source === "string" ? diagnostic.source : null,
    message: diagnostic.message,
    tags: {
      unnecessary: diagnostic.tags?.includes(1) ?? false,
      deprecated: diagnostic.tags?.includes(2) ?? false,
    },
    related_information: await normalizeLspRelatedInformation(diagnostic, candidate, profile, roots),
  };
}

async function normalizeLegacyDiagnostic(
  diagnostic: LegacyDiagnostic,
  kind: "syntactic" | "semantic" | "suggestion",
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  roots: DiagnosticBindingRoots,
): Promise<NormalizedDiagnostic> {
  if (!diagnostic
    || typeof diagnostic.text !== "string"
    || typeof diagnostic.category !== "string"
    || !diagnostic.start
    || !diagnostic.end) {
    throw new ReviewLspError("LSP_PROTOCOL_ERROR", "legacy diagnostic is malformed");
  }
  return {
    kind,
    range: normalizeLegacyRange(diagnostic.start, diagnostic.end),
    severity: normalizeLegacySeverity(diagnostic.category),
    code: normalizeDiagnosticCode(diagnostic.code),
    source: typeof diagnostic.source === "string" ? diagnostic.source : null,
    message: diagnostic.text,
    tags: {
      unnecessary: diagnostic.reportsUnnecessary !== undefined,
      deprecated: diagnostic.reportsDeprecated !== undefined,
    },
    related_information: await normalizeLegacyRelatedInformation(
      diagnostic.relatedInformation,
      candidate,
      profile,
      roots,
    ),
  };
}

async function normalizeDiagnostics(
  transport: DiagnosticTransportOutcome,
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  roots: DiagnosticBindingRoots,
): Promise<{ diagnostics: NormalizedDiagnostic[]; hasUnboundRelatedInformation: boolean }> {
  let diagnostics: NormalizedDiagnostic[];
  if (transport.kind === "LSP_DOCUMENT_DIAGNOSTIC") {
    diagnostics = await Promise.all(
      transport.diagnostics.map((diagnostic) => normalizeLspDiagnostic(diagnostic, candidate, profile, roots)),
    );
  } else {
    const groups: Array<{
      kind: "syntactic" | "semantic" | "suggestion";
      diagnostics: LegacyDiagnostic[];
    }> = [
      { kind: "syntactic", diagnostics: transport.syntactic },
      { kind: "semantic", diagnostics: transport.semantic },
      { kind: "suggestion", diagnostics: transport.suggestion },
    ];
    diagnostics = (await Promise.all(groups.flatMap(({ kind, diagnostics: values }) => values.map(
      (diagnostic) => normalizeLegacyDiagnostic(diagnostic, kind, candidate, profile, roots),
    ))));
  }
  diagnostics.sort(compareDiagnostics);
  const hasUnboundRelatedInformation = diagnostics.some((diagnostic) =>
    diagnostic.related_information.some((item) => item.binding?.classification === "UNBOUND"));
  return { diagnostics, hasUnboundRelatedInformation };
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
    private readonly snapshot: DependencySnapshotDescriptor | null = null,
    private readonly boundResolvingProject: ResolvingProject | null = null,
    private readonly candidateEngine: AdmittedEngineArtifact | null = null,
    private readonly executionProfileEvidence: ExecutionProfile = {
      schema_version: "review-lsp.execution-profile.v1",
      kind: "TRUSTED_LOCAL",
      enforced: false,
      platform: process.platform,
      identity: `native:${process.platform}:${process.arch}`,
      reason: "candidate-selected engine is not in use",
    },
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
    /** Project that owns all documents queried through this session. */
    resolvingProject?: ResolvingProject | null;
  }): Promise<SemanticSession> {
    await verifyCandidateIntegrity(input.candidate);
    await verifyTypeScriptProfile(input.profile);
    const projection = input.projection ?? null;
    const snapshot = input.snapshot ?? null;
    const resolvingProject = input.resolvingProject ?? null;
    if (snapshot && !projection) {
      throw new ReviewLspError(
        "PROJECTION_INVALID",
        "dependency snapshot semantic execution requires a bound execution projection",
      );
    }
    if (projection) {
      await verifyProjectionDescriptor(projection, {
        candidate: input.candidate,
        snapshot,
        stateDirectory: input.stateDirectory,
      });
    }

    const semanticRoot = projection?.execution_root ?? input.candidate.source_root;
    const provisionalSessionId = contentId("sessroot", {
      candidate_id: input.candidate.candidate_id,
      source_manifest_sha256: input.candidate.source_manifest_sha256,
      profile_sha256: input.profile.profile_sha256,
      resolving_project_identity: resolvingProject ? resolvingProjectIdentity(resolvingProject) : null,
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

    const candidateEngine = snapshot && resolvingProject
      ? await admitEngineArtifact({ snapshot, projectRoot: resolvingProject.project_root }).catch(() => null)
      : null;
    const serverRoot = input.profile.server_runtime_root;
    const engineReadRoots = candidateEngine
      ? [
          semanticRoot,
          candidateEngine.engine_root,
          ...(candidateEngine.native_runtime ? [candidateEngine.native_runtime.root] : []),
          input.profile.typescript_root,
          serverRoot,
          dirname(input.profile.node_executable),
          ...(snapshot ? [snapshot.dependency_root] : []),
          ...(projection?.derived_artifact_roots ?? []),
        ]
      : [];
    const executionProfile = candidateEngine
      ? await resolveExecutionProfile({
          readRoots: engineReadRoots,
          writableRoots: [home, tmp],
        })
      : await resolveExecutionProfile({ preferContainer: false });

    const launch = candidateEngine && engineMayClaimExactProject({ artifact: candidateEngine, profile: executionProfile }).permitted
      ? await buildCandidateEngineLaunch({
          artifact: candidateEngine,
          profile: input.profile,
          executionProfile,
          semanticRoot,
          writableRoots: [home, tmp],
          additionalReadRoots: [
            ...(snapshot ? [snapshot.dependency_root] : []),
            ...(projection?.derived_artifact_roots ?? []),
          ],
        })
      : undefined;

    const semanticIsolation = launch ? executionProfile.kind : (input.isolation ?? input.candidate.isolation);
    const semanticIsolationIdentity = launch
      ? executionProfile.identity
      : input.isolationIdentity
        ?? (semanticIsolation === "TRUSTED_LOCAL"
          ? `native:${process.platform}:${process.arch}`
          : `${semanticIsolation.toLowerCase()}:unbound`);
    const environment = await buildEnvironmentManifest(input.candidate, input.profile, {
      isolation: semanticIsolation,
      isolationIdentity: semanticIsolationIdentity,
      snapshot,
      projection,
    });

    const driver = new StdioLspDriver(
      input.profile,
      semanticRoot,
      candidateSafeEnvironment({ home, tmp, profile: input.profile }),
      input.requestTimeoutMs ?? 10_000,
      1_000,
      launch,
    );
    await driver.start();
    return new SemanticSession(
      input.candidate,
      input.profile,
      input.stateDirectory,
      environment,
      semanticIsolation,
      driver,
      projection,
      snapshot,
      resolvingProject,
      candidateEngine,
      executionProfile,
    );
  }

  async candidateInfo(): Promise<{
    candidate: CandidateDescriptor;
    environment: EnvironmentManifest;
    profile: TypeScriptProfile;
    session_id: string;
    session_epoch: number;
    capabilities: ["hover", "definition", "references"];
  }> {
    this.ensureOpen();
    await verifyCandidateIntegrity(this.candidate);
    return {
      candidate: this.candidate,
      environment: this.environment,
      profile: this.profile,
      session_id: this.sessionId,
      session_epoch: this.sessionEpoch,
      capabilities: ["hover", "definition", "references"],
    };
  }

  async hover(input: SemanticQueryInput): Promise<SemanticReceipt> {
    return this.query("hover", input);
  }

  async definition(input: SemanticQueryInput): Promise<SemanticReceipt> {
    return this.query("definition", input);
  }

  async references(input: ReferencesQueryInput): Promise<SemanticReceipt> {
    return this.query("references", input);
  }

  async [diagnosticsCoreQuery](input: DiagnosticsQueryInput): Promise<DiagnosticsReceipt> {
    return this.queryDiagnostics(input);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.shutdown();
  }

  private async verifySemanticEnvironment(): Promise<void> {
    if (this.projection) {
      await verifyProjectionDescriptor(this.projection, {
        candidate: this.candidate,
        snapshot: this.snapshot,
        stateDirectory: this.stateDirectory,
      });
      return;
    }
    if (this.snapshot) await verifyDependencySnapshot(this.snapshot);
  }

  private async queryDiagnostics(input: DiagnosticsQueryInput): Promise<DiagnosticsReceipt> {
    this.ensureOpen();
    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    await this.verifySemanticEnvironment();

    const absolute = this.projection
      ? admittedProjectionPath(this.projection, this.candidate, input.path)
      : admittedCandidatePath(this.candidate, input.path);
    const languageId = languageIdForPath(input.path);
    if (!languageId) {
      throw new ReviewLspError("CANDIDATE_PATH_INVALID", `unsupported document extension: ${input.path}`);
    }
    const sourceEntry = this.candidate.entries.find((entry) => entry.path === input.path && entry.kind === "file");
    if (!sourceEntry) {
      throw new ReviewLspError("CANDIDATE_PATH_INVALID", `document is not an admitted candidate file: ${input.path}`);
    }
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

    const resolvingProject = resolveProjectForDocument(this.candidate, input.path);
    if (this.boundResolvingProject
      && resolvingProjectIdentity(this.boundResolvingProject) !== resolvingProjectIdentity(resolvingProject)) {
      throw new ReviewLspError(
        "PROFILE_INVALID",
        "semantic session is bound to a different resolving project; acquire a project-specific runtime",
      );
    }
    const projectToolchain = await resolveProjectToolchain({
      candidate: this.candidate,
      snapshot: this.snapshot,
      projectRoot: resolvingProject.project_root,
    });
    const strongAdmission = engineMayClaimExactProject({
      artifact: this.candidateEngine,
      profile: this.executionProfileEvidence,
    });
    const assessment = assessToolchainAlignment({
      projectVersion: projectToolchain.version,
      projectVersionSource: projectToolchain.source,
      engineVersion: this.driver.launch.typescriptVersion,
      engineIsProjectAdmitted: this.driver.launch.projectEngineAdmitted,
    });
    const semanticToolchain: SemanticToolchainEvidence = {
      resolving_project: resolvingProject,
      resolving_project_identity: resolvingProjectIdentity(resolvingProject),
      project_toolchain: { typescript_version: projectToolchain.version, source: projectToolchain.source },
      semantic_engine: {
        implementation: this.driver.launch.implementation,
        typescript_version: this.driver.launch.typescriptVersion,
        is_project_admitted: this.driver.launch.projectEngineAdmitted,
      },
      candidate_engine: this.candidateEngine
        ? {
            artifact_id: this.candidateEngine.artifact_id,
            version: this.candidateEngine.version,
            engine_kind: this.candidateEngine.engine_kind,
            tree_manifest_sha256: this.candidateEngine.tree_manifest_sha256,
            native_runtime_tree_manifest_sha256: this.candidateEngine.native_runtime?.tree_manifest_sha256 ?? null,
          }
        : null,
      execution_profile: {
        kind: this.executionProfileEvidence.kind,
        enforced: this.executionProfileEvidence.enforced,
        identity: this.executionProfileEvidence.identity,
      },
      toolchain_alignment: assessment.alignment,
      toolchain_alignment_reason: assessment.reason,
      exact_project_blocked_by: assessment.alignment === "EXACT_PROJECT"
        ? null
        : strongAdmission.reason ?? assessment.reason,
    };

    let environmentBinding: BindingState = this.environment.binding;
    const limitations = [...this.environment.limitations];
    if (alignmentBlocksStrongAdmission(assessment.alignment)) {
      environmentBinding = "PARTIAL";
      if (assessment.reason) limitations.push(assessment.reason);
    }

    const transport = await this.driver.diagnostics(document);
    const roots: DiagnosticBindingRoots = {
      executionRoot: this.projection?.execution_root ?? this.candidate.source_root,
      dependencyRoot: this.snapshot?.dependency_root,
      derivedRoots: this.projection?.derived_artifact_roots ?? [],
    };
    const normalized = await normalizeDiagnostics(transport, this.candidate, this.profile, roots);
    if (normalized.hasUnboundRelatedInformation) {
      environmentBinding = "PARTIAL";
      limitations.push("diagnostic related information includes a URI outside every admitted root");
    }
    limitations.push(
      "document diagnostics are language-service semantic evidence for the requested document; they are not proof of project-wide build, test, lint, bundler, framework, or code-generation correctness",
    );
    if (transport.kind === "TSSERVER_SYNC_DIAGNOSTICS") {
      limitations.push(
        "legacy diagnostics completeness is limited to the fixed syntax, semantic, and suggestion tsserver diagnostic set",
      );
    }

    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    await this.verifySemanticEnvironment();

    const resultBytes = Buffer.byteLength(canonicalJson(normalized.diagnostics), "utf8");
    if (resultBytes > this.profile.result_limit_bytes) {
      throw new ReviewLspError(
        "CANDIDATE_RESOURCE_LIMIT",
        `diagnostics result is ${resultBytes} bytes; profile limit is ${this.profile.result_limit_bytes}`,
      );
    }

    return persistDiagnosticsReceipt(this.stateDirectory, {
      schema_version: "review-lsp.diagnostics-receipt.v1",
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
      operation: "diagnostics",
      document: {
        path: input.path,
        uri: document.uri,
        sha256: documentBytes.sha256,
        version: document.version,
        language_id: document.languageId,
        position_encoding: "utf-16",
      },
      request: { scope: "document" },
      transport: {
        kind: transport.kind,
        protocol_operations: [...transport.protocolOperations],
        diagnostic_provider: transport.kind === "LSP_DOCUMENT_DIAGNOSTIC"
          ? {
              identifier: transport.diagnosticProvider.identifier,
              inter_file_dependencies: transport.diagnosticProvider.interFileDependencies,
              workspace_diagnostics: transport.diagnosticProvider.workspaceDiagnostics,
            }
          : null,
      },
      execution_status: "OK",
      source_binding: "VERIFIED",
      environment_binding: environmentBinding,
      semantic_toolchain: semanticToolchain,
      isolation: this.isolation,
      result_scope: "DOCUMENT_DIAGNOSTICS",
      completeness: "ENGINE_FULL_DOCUMENT_RESPONSE",
      limitations: [...new Set(limitations)],
      result: normalized.diagnostics,
      result_sha256: sha256(canonicalJson(normalized.diagnostics)),
      request_duration_ms: Math.round(transport.durationMs * 1000) / 1000,
      observed_at: new Date().toISOString(),
    });
  }

  private async query(
    operation: "hover" | "definition" | "references",
    input: SemanticQueryInput | ReferencesQueryInput,
  ): Promise<SemanticReceipt> {
    this.ensureOpen();
    if (!Number.isSafeInteger(input.line) || input.line < 0 || !Number.isSafeInteger(input.character) || input.character < 0) {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "line and character must be non-negative 0-based integers");
    }
    const includeDeclaration = operation === "references"
      ? (input as ReferencesQueryInput).includeDeclaration
      : undefined;
    if (operation === "references" && typeof includeDeclaration !== "boolean") {
      throw new ReviewLspError("LSP_PROTOCOL_ERROR", "references requires an explicit boolean includeDeclaration");
    }

    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    await this.verifySemanticEnvironment();
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
    // Checked before the server is asked anything: a mis-aimed question should fail as a
    // question, not produce an authoritative-looking answer about the wrong thing.
    const coordinateContext = buildCoordinateContext({
      text: documentBytes.bytes.toString("utf8"),
      line: input.line,
      character: input.character,
    });
    assertCoordinateExpectation(coordinateContext, input.expect);
    const document = await this.driver.openDocument({
      path: absolute,
      text: documentBytes.bytes.toString("utf8"),
      languageId,
    });

    // The engine that answers is selected per document's owning project, so alignment is
    // assessed there rather than once for the whole repository.
    const resolvingProject = resolveProjectForDocument(this.candidate, input.path);
    if (this.boundResolvingProject
      && resolvingProjectIdentity(this.boundResolvingProject) !== resolvingProjectIdentity(resolvingProject)) {
      throw new ReviewLspError(
        "PROFILE_INVALID",
        "semantic session is bound to a different resolving project; acquire a project-specific runtime",
      );
    }
    const projectToolchain = await resolveProjectToolchain({
      candidate: this.candidate,
      snapshot: this.snapshot,
      projectRoot: resolvingProject.project_root,
    });
    const strongAdmission = engineMayClaimExactProject({
      artifact: this.candidateEngine,
      profile: this.executionProfileEvidence,
    });

    const assessment = assessToolchainAlignment({
      projectVersion: projectToolchain.version,
      projectVersionSource: projectToolchain.source,
      engineVersion: this.driver.launch.typescriptVersion,
      engineIsProjectAdmitted: this.driver.launch.projectEngineAdmitted,
    });
    const semanticToolchain: SemanticToolchainEvidence = {
      resolving_project: resolvingProject,
      resolving_project_identity: resolvingProjectIdentity(resolvingProject),
      project_toolchain: { typescript_version: projectToolchain.version, source: projectToolchain.source },
      semantic_engine: {
        implementation: this.driver.launch.implementation,
        typescript_version: this.driver.launch.typescriptVersion,
        is_project_admitted: this.driver.launch.projectEngineAdmitted,
      },
      candidate_engine: this.candidateEngine
        ? {
            artifact_id: this.candidateEngine.artifact_id,
            version: this.candidateEngine.version,
            engine_kind: this.candidateEngine.engine_kind,
            tree_manifest_sha256: this.candidateEngine.tree_manifest_sha256,
            native_runtime_tree_manifest_sha256: this.candidateEngine.native_runtime?.tree_manifest_sha256 ?? null,
          }
        : null,
      execution_profile: {
        kind: this.executionProfileEvidence.kind,
        enforced: this.executionProfileEvidence.enforced,
        identity: this.executionProfileEvidence.identity,
      },
      toolchain_alignment: assessment.alignment,
      toolchain_alignment_reason: assessment.reason,
      exact_project_blocked_by: assessment.alignment === "EXACT_PROJECT"
        ? null
        : strongAdmission.reason ?? assessment.reason,
    };

    let result: unknown;
    let durationMs: number;
    let environmentBinding: BindingState = this.environment.binding;
    const limitations = [...this.environment.limitations];

    if (alignmentBlocksStrongAdmission(assessment.alignment)) {
      environmentBinding = "PARTIAL";
      if (assessment.reason) limitations.push(assessment.reason);
    }

    if (operation === "hover") {
      const response = await this.driver.hover(document, input.line, input.character);
      result = response.value;
      durationMs = response.durationMs;
    } else if (operation === "definition") {
      const response = await this.driver.definition(document, input.line, input.character);
      const bindings = await Promise.all(resultUris(response.value).map((uri) => bindSemanticTargetUri(
        this.candidate,
        this.profile,
        uri,
        {
          executionRoot: this.projection?.execution_root ?? this.candidate.source_root,
          dependencyRoot: this.snapshot?.dependency_root,
          derivedRoots: this.projection?.derived_artifact_roots ?? [],
        },
      )));
      if (bindings.some((binding) => binding.classification === "UNBOUND")) {
        environmentBinding = "PARTIAL";
        limitations.push("definition result includes a URI outside every admitted root");
      }
      result = { server_response: response.value, bindings };
      durationMs = response.durationMs;
    } else {
      const response = await this.driver.references(document, input.line, input.character, includeDeclaration as boolean);
      const bindings = await Promise.all(resultUris(response.value).map((uri) => bindSemanticTargetUri(
        this.candidate,
        this.profile,
        uri,
        {
          executionRoot: this.projection?.execution_root ?? this.candidate.source_root,
          dependencyRoot: this.snapshot?.dependency_root,
          derivedRoots: this.projection?.derived_artifact_roots ?? [],
        },
      )));
      if (bindings.some((binding) => binding.classification === "UNBOUND")) {
        environmentBinding = "PARTIAL";
        limitations.push("references result includes a URI outside every admitted root");
      }
      limitations.push("references are limited to the language server static semantic model; dynamic or generated usages may be absent");
      result = { server_response: response.value, bindings };
      durationMs = response.durationMs;
    }

    await verifyCandidateIntegrity(this.candidate);
    await verifyTypeScriptProfile(this.profile);
    await this.verifySemanticEnvironment();
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
        context: coordinateContext,
      },
      request: {
        line: input.line,
        character: input.character,
        ...(operation === "references" ? { include_declaration: includeDeclaration as boolean } : {}),
      },
      execution_status: "OK",
      semantic_toolchain: semanticToolchain,
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
