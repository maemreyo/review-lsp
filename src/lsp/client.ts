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
  ExitNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  type Definition,
  type Hover,
  type InitializeResult,
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

export class StdioLspDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, OpenDocument>();
  private initialized = false;
  private closed = false;
  private exited = false;
  private stderrTail = "";
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
      processId: process.pid,
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
    this.connection.onNotification("window/logMessage", () => undefined);
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
    if (this.closed) throw new ReviewLspError("LSP_PROTOCOL_ERROR", "language server session is closed");
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
