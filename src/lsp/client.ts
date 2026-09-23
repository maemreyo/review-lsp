import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { basename, dirname } from "node:path";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  ReferencesRequest,
  InitializedNotification,
  ShutdownRequest,
  type Definition,
  type Diagnostic,
  type DocumentDiagnosticReport,
  type Hover,
  type InitializeResult,
  type Location,
  type LocationLink,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";

import { ReviewLspError } from "../core/errors.js";
import type { TypeScriptProfile } from "../core/types.js";

interface RequestOutcome<T> {
  value: T;
  durationMs: number;
}

export interface LspLaunchSpec {
  command: string;
  args: string[];
  initializationOptions: unknown;
  implementation: string;
  typescriptVersion: string;
  projectEngineAdmitted: boolean;
}

export interface OpenDocument {
  path: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LegacyDiagnosticLocation {
  line: number;
  offset: number;
}

export interface LegacyDiagnosticRelatedInformation {
  category: string;
  code: number;
  message: string;
  span?: {
    file: string;
    start: LegacyDiagnosticLocation;
    end: LegacyDiagnosticLocation;
  };
}

export interface LegacyDiagnostic {
  start: LegacyDiagnosticLocation;
  end: LegacyDiagnosticLocation;
  text: string;
  category: string;
  reportsUnnecessary?: unknown;
  reportsDeprecated?: unknown;
  relatedInformation?: LegacyDiagnosticRelatedInformation[];
  code?: number;
  source?: string;
}

interface LegacyDiagnosticResponse {
  type: "response";
  command: string;
  success: true;
  body: LegacyDiagnostic[];
}

export type DiagnosticTransportOutcome =
  | {
      kind: "LSP_DOCUMENT_DIAGNOSTIC";
      diagnostics: Diagnostic[];
      diagnosticProvider: {
        identifier: string | null;
        interFileDependencies: boolean | null;
        workspaceDiagnostics: boolean | null;
      };
      protocolOperations: ["textDocument/diagnostic"];
      durationMs: number;
    }
  | {
      kind: "TSSERVER_SYNC_DIAGNOSTICS";
      syntactic: LegacyDiagnostic[];
      semantic: LegacyDiagnostic[];
      suggestion: LegacyDiagnostic[];
      protocolOperations: [
        "syntacticDiagnosticsSync",
        "semanticDiagnosticsSync",
        "suggestionDiagnosticsSync",
      ];
      durationMs: number;
    };

export class StdioLspDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, OpenDocument>();
  private initialized = false;
  private closed = false;
  private exited = false;
  private stderrTail = "";
  private serverLogTail = "";
  private serverInfo: unknown;
  private capabilities: InitializeResult["capabilities"] | undefined;

  constructor(
    private readonly profile: TypeScriptProfile,
    readonly rootDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly requestTimeoutMs = 10_000,
    private readonly shutdownGraceMs = 1_000,
    readonly launch: LspLaunchSpec = {
      command: profile.node_executable,
      args: [profile.server_entrypoint, ...profile.args],
      initializationOptions: profile.initialization_options,
      implementation: "typescript-language-server",
      typescriptVersion: profile.typescript_version,
      projectEngineAdmitted: false,
    },
  ) {
    this.child = spawn(launch.command, launch.args, {
      cwd: rootDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
    );
    this.child.on("exit", () => {
      this.exited = true;
      if (!this.closed) {
        this.closed = true;
        this.connection.dispose();
      }
    });
    this.registerHandlers();
  }

  get processId(): number | undefined {
    return this.child.pid;
  }

  get initializeEvidence(): { serverInfo: unknown; capabilities: unknown } {
    return { serverInfo: this.serverInfo, capabilities: this.capabilities ?? null };
  }

  async start(): Promise<void> {
    if (!this.child.pid) throw new ReviewLspError("LSP_PROTOCOL_ERROR", "language server did not expose a pid");
    this.connection.listen();
    const rootUri = URI.file(this.rootDir).toString();
    const initialized = await this.request<InitializeResult>(InitializeRequest.method, {
      // Sandboxed candidate engines cannot reliably probe the host client PID with
      // `kill(pid, 0)`. vscode-languageserver performs that watchdog every three seconds and
      // treats an EPERM as a dead client, exiting an otherwise healthy server. Review-LSP owns
      // this child lifecycle explicitly, so an admitted sandboxed engine declares the client
      // PID unknown instead of granting a cross-sandbox process probe.
      processId: this.launch.projectEngineAdmitted ? null : process.pid,
      clientInfo: { name: "review-lsp", version: "0.0.0" },
      rootPath: this.rootDir,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.rootDir) || "candidate" }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
        workspace: {
          configuration: true,
          workspaceFolders: true,
        },
      },
      initializationOptions: this.launch.initializationOptions,
      trace: "off",
    });
    this.serverInfo = initialized.value.serverInfo ?? null;
    this.capabilities = initialized.value.capabilities;
    await this.connection.sendNotification(InitializedNotification.method, {});
    this.initialized = true;
  }

  async openDocument(input: { path: string; text: string; languageId: string }): Promise<OpenDocument> {
    if (!this.initialized) throw new ReviewLspError("LSP_PROTOCOL_ERROR", "language server is not initialized");
    const uri = URI.file(input.path).toString();
    const prior = this.documents.get(uri);
    if (prior) {
      if (prior.text !== input.text || prior.languageId !== input.languageId) {
        throw new ReviewLspError("LSP_PROTOCOL_ERROR", "document bytes changed within a single immutable candidate session");
      }
      return prior;
    }
    const document: OpenDocument = {
      path: input.path,
      uri,
      languageId: input.languageId,
      version: 1,
      text: input.text,
    };
    this.documents.set(uri, document);
    await this.connection.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: {
        uri,
        languageId: document.languageId,
        version: document.version,
        text: document.text,
      },
    });
    return document;
  }

  async hover(document: OpenDocument, line: number, character: number): Promise<RequestOutcome<Hover | null>> {
    if (!this.capabilities?.hoverProvider) {
      throw new ReviewLspError("LSP_CAPABILITY_UNSUPPORTED", "server does not advertise hover support");
    }
    return this.request<Hover | null>(HoverRequest.method, {
      textDocument: { uri: document.uri },
      position: { line, character },
    });
  }

  async definition(document: OpenDocument, line: number, character: number): Promise<RequestOutcome<Definition | LocationLink[] | null>> {
    if (!this.capabilities?.definitionProvider) {
      throw new ReviewLspError("LSP_CAPABILITY_UNSUPPORTED", "server does not advertise definition support");
    }
    return this.request<Definition | LocationLink[] | null>(DefinitionRequest.method, {
      textDocument: { uri: document.uri },
      position: { line, character },
    });
  }

  async references(
    document: OpenDocument,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<RequestOutcome<Location[] | null>> {
    if (!this.capabilities?.referencesProvider) {
      throw new ReviewLspError("LSP_CAPABILITY_UNSUPPORTED", "server does not advertise references support");
    }
    return this.request<Location[] | null>(ReferencesRequest.method, {
      textDocument: { uri: document.uri },
      position: { line, character },
      context: { includeDeclaration },
    });
  }

  async diagnostics(document: OpenDocument): Promise<DiagnosticTransportOutcome> {
    const started = performance.now();
    const diagnosticProvider = this.capabilities?.diagnosticProvider;
    if (diagnosticProvider) {
      const response = await this.request<DocumentDiagnosticReport>(DocumentDiagnosticRequest.method, {
        textDocument: { uri: document.uri },
      });
      if (!response.value || response.value.kind !== "full") {
        throw new ReviewLspError(
          "LSP_PROTOCOL_ERROR",
          "document diagnostics requires a full report when no previous result id was supplied",
        );
      }
      if (!Array.isArray((response.value as { items?: unknown }).items)) {
        throw new ReviewLspError("LSP_PROTOCOL_ERROR", "document diagnostics full report must contain an items array");
      }
      if (Object.prototype.hasOwnProperty.call(response.value, "relatedDocuments")
        && response.value.relatedDocuments !== undefined) {
        throw new ReviewLspError(
          "LSP_PROTOCOL_ERROR",
          "document diagnostics response widened scope with relatedDocuments",
        );
      }
      const provider = diagnosticProvider as {
        identifier?: unknown;
        interFileDependencies?: unknown;
        workspaceDiagnostics?: unknown;
      };
      return {
        kind: "LSP_DOCUMENT_DIAGNOSTIC",
        diagnostics: response.value.items,
        diagnosticProvider: {
          identifier: typeof provider.identifier === "string" ? provider.identifier : null,
          interFileDependencies: typeof provider.interFileDependencies === "boolean"
            ? provider.interFileDependencies
            : null,
          workspaceDiagnostics: typeof provider.workspaceDiagnostics === "boolean"
            ? provider.workspaceDiagnostics
            : null,
        },
        protocolOperations: ["textDocument/diagnostic"],
        durationMs: Math.max(0, performance.now() - started),
      };
    }

    const executeCommands = this.capabilities?.executeCommandProvider?.commands ?? [];
    if (!executeCommands.includes("typescript.tsserverRequest")) {
      throw new ReviewLspError(
        "LSP_CAPABILITY_UNSUPPORTED",
        "server exposes neither diagnosticProvider nor typescript.tsserverRequest",
      );
    }

    const deadline = started + this.requestTimeoutMs;
    const requestLegacy = async (command: string): Promise<LegacyDiagnostic[]> => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {
        throw new ReviewLspError("LSP_TIMEOUT", "legacy diagnostics exceeded the shared semantic request deadline");
      }
      const response = await this.request<unknown>("workspace/executeCommand", {
        command: "typescript.tsserverRequest",
        arguments: [command, { file: document.uri }],
      }, remaining);
      const value = response.value as Partial<LegacyDiagnosticResponse> | null;
      if (!value
        || value.type !== "response"
        || value.command !== command
        || value.success !== true
        || !Array.isArray(value.body)) {
        throw new ReviewLspError(
          "LSP_PROTOCOL_ERROR",
          `legacy diagnostics command ${command} returned a malformed or unsuccessful response`,
        );
      }
      return value.body;
    };

    const syntactic = await requestLegacy("syntacticDiagnosticsSync");
    const semantic = await requestLegacy("semanticDiagnosticsSync");
    const suggestion = await requestLegacy("suggestionDiagnosticsSync");
    return {
      kind: "TSSERVER_SYNC_DIAGNOSTICS",
      syntactic,
      semantic,
      suggestion,
      protocolOperations: [
        "syntacticDiagnosticsSync",
        "semanticDiagnosticsSync",
        "suggestionDiagnosticsSync",
      ],
      durationMs: Math.max(0, performance.now() - started),
    };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.initialized && !this.exited) {
        await this.request<void>(ShutdownRequest.method, null, Math.min(this.requestTimeoutMs, 2_000)).catch(() => undefined);
        await this.connection.sendNotification(ExitNotification.method).catch(() => undefined);
      }
    } finally {
      this.connection.end();
      this.connection.dispose();
    }

    if (await this.waitForExit(this.shutdownGraceMs)) return;
    this.killTree("SIGTERM");
    if (await this.waitForExit(this.shutdownGraceMs)) return;
    this.killTree("SIGKILL");
    await this.waitForExit(this.shutdownGraceMs);
  }

  private registerHandlers(): void {
    this.connection.onRequest("workspace/configuration", (params: unknown) => {
      if (!params || typeof params !== "object" || !("items" in params) || !Array.isArray((params as { items?: unknown }).items)) return [];
      return (params as { items: unknown[] }).items.map(() => ({}));
    });
    this.connection.onRequest("workspace/workspaceFolders", () => [{
      uri: URI.file(this.rootDir).toString(),
      name: basename(this.rootDir),
    }]);
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onNotification("window/logMessage", (message: unknown) => {
      const text = typeof message === "object" && message !== null && "message" in message
        ? String((message as { message?: unknown }).message ?? "")
        : String(message ?? "");
      if (text) this.serverLogTail = `${this.serverLogTail}${text}\n`.slice(-8_192);
    });
    this.connection.onNotification("window/showMessage", (message: unknown) => {
      const text = typeof message === "object" && message !== null && "message" in message
        ? String((message as { message?: unknown }).message ?? "")
        : String(message ?? "");
      if (text) this.serverLogTail = `${this.serverLogTail}${text}\n`.slice(-8_192);
    });
    this.connection.onNotification("typescript-language-server/typescriptVersion", () => undefined);

    this.child.on("error", (error) => {
      if (!this.closed) {
        this.connection.dispose();
        this.closed = true;
        void error;
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-8_192);
    });
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<RequestOutcome<T>> {
    if (this.closed) {
      const exit = this.child.exitCode !== null
        ? ` exit_code=${this.child.exitCode}`
        : this.child.signalCode
          ? ` signal=${this.child.signalCode}`
          : "";
      const stderr = this.stderrTail.trim();
      const serverLog = this.serverLogTail.trim();
      throw new ReviewLspError(
        "LSP_PROTOCOL_ERROR",
        `language server session is closed${exit}${stderr ? `; server stderr: ${stderr}` : ""}${serverLog ? `; server log: ${serverLog}` : ""}`,
      );
    }
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        this.connection.sendRequest<T>(method, params),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ReviewLspError("LSP_TIMEOUT", `LSP request ${method} exceeded ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      return { value, durationMs: Math.max(0, performance.now() - started) };
    } catch (error) {
      if (error instanceof ReviewLspError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const stderr = this.stderrTail.trim();
      throw new ReviewLspError(
        "LSP_PROTOCOL_ERROR",
        `${method} failed: ${detail}${stderr ? `; server stderr: ${stderr}` : ""}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private killTree(signal: NodeJS.Signals): void {
    if (!this.child.pid || this.exited) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      this.child.kill(signal);
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export function languageIdForPath(path: string): "typescript" | undefined {
  return path.endsWith(".ts") || path.endsWith(".tsx") ? "typescript" : undefined;
}

export function candidateSafeEnvironment(input: { home: string; tmp: string; profile: TypeScriptProfile }): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(input.profile.node_executable)}:/usr/bin:/bin`,
    HOME: input.home,
    TMPDIR: input.tmp,
    NO_UPDATE_NOTIFIER: "1",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}
