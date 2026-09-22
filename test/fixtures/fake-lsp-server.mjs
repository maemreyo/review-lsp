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
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));

connection.listen();
