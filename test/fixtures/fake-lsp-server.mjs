import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

const mode = process.env.REVIEW_LSP_FAKE_MODE ?? "normal";
const delayMs = Number(process.env.REVIEW_LSP_FAKE_DELAY_MS ?? "250");

connection.onRequest("initialize", () => ({
  capabilities: {
    textDocumentSync: 1,
    hoverProvider: mode !== "unsupported",
    definitionProvider: true,
    referencesProvider: mode !== "unsupported-references",
    ...(mode.startsWith("diagnostic-lsp")
      ? {
          diagnosticProvider: {
            identifier: "review-lsp-fake",
            interFileDependencies: true,
            workspaceDiagnostics: false,
          },
        }
      : {}),
    ...(mode.startsWith("diagnostic-legacy")
      ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } }
      : {}),
  },
  serverInfo: { name: "review-lsp-fake", version: "1" },
}));

connection.onNotification("initialized", () => undefined);
connection.onNotification("textDocument/didOpen", () => undefined);

connection.onRequest("textDocument/hover", async () => {
  if (mode === "crash") {
    process.exit(23);
  }
  if (mode === "delay") {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { contents: { kind: "plaintext", value: "fake-hover" } };
});

connection.onRequest("textDocument/definition", () => null);
connection.onRequest("textDocument/references", (params) => [{
  uri: params.textDocument.uri,
  range: {
    start: { line: 0, character: params.context?.includeDeclaration ? 0 : 7 },
    end: { line: 0, character: params.context?.includeDeclaration ? 5 : 12 },
  },
}]);

connection.onRequest("textDocument/diagnostic", () => {
  if (mode === "diagnostic-lsp-unchanged") return { kind: "unchanged", resultId: "fake-result" };
  if (mode === "diagnostic-lsp-related") {
    return { kind: "full", items: [], relatedDocuments: {} };
  }
  if (mode === "diagnostic-lsp-malformed") return { kind: "full", items: "not-an-array" };
  return {
    kind: "full",
    items: [{
      range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
      severity: 1,
      code: 9001,
      source: "fake",
      message: "fake diagnostic",
    }],
  };
});

connection.onRequest("workspace/executeCommand", async (params) => {
  if (params.command !== "typescript.tsserverRequest") return null;
  const [command] = params.arguments ?? [];
  if (mode === "diagnostic-legacy-delay") {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (mode === "diagnostic-legacy-malformed" && command === "semanticDiagnosticsSync") {
    return { type: "response", command, success: false, body: [] };
  }
  return {
    type: "response",
    command,
    success: true,
    body: command === "semanticDiagnosticsSync"
      ? [{
          start: { line: 1, offset: 8 },
          end: { line: 1, offset: 13 },
          text: "fake diagnostic",
          code: 9001,
          category: "error",
        }]
      : [],
  };
});

connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
