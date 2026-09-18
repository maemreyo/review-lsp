import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { ReviewLspError } from "../core/errors.js";
import type { SemanticSession } from "../core/session.js";

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { value },
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ReviewLspError ? error.code : "INTERNAL_ERROR";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

function requireCandidate(session: SemanticSession, expectedCandidateId: string): void {
  if (expectedCandidateId !== session.candidate.candidate_id) {
    throw new ReviewLspError(
      "CANDIDATE_MISMATCH",
      `expected candidate ${expectedCandidateId} but this MCP process is bound to ${session.candidate.candidate_id}`,
    );
  }
}

export async function serveCandidateMcp(session: SemanticSession): Promise<void> {
  const server = new McpServer({
    name: "review-lsp",
    version: "0.0.0",
  });

  server.registerTool("review_lsp_candidate_info", {
    description: "Return the immutable candidate/environment/profile identity bound to this Review-LSP MCP process.",
    inputSchema: {},
  }, async () => {
    try {
      const info = await session.candidateInfo();
      return jsonResult({
        candidate_id: info.candidate.candidate_id,
        repository_identity: info.candidate.repository_identity,
        commit_oid: info.candidate.commit_oid,
        tree_oid: info.candidate.tree_oid,
        source_manifest_sha256: info.candidate.source_manifest_sha256,
        source_binding: "VERIFIED",
        environment_binding: info.environment.binding,
        environment_manifest_sha256: info.environment.environment_manifest_sha256,
        profile_id: info.profile.profile_id,
        profile_sha256: info.profile.profile_sha256,
        isolation: info.candidate.isolation,
        capabilities: info.capabilities,
        limitations: info.environment.limitations,
        session_id: info.session_id,
        session_epoch: info.session_epoch,
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  const querySchema = {
    expected_candidate_id: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().nonnegative().describe("0-based LSP line"),
    character: z.number().int().nonnegative().describe("0-based UTF-16 character offset"),
  };

  server.registerTool("review_lsp_hover", {
    description: "Run textDocument/hover against the exact candidate bound to this server and return a provenance receipt.",
    inputSchema: querySchema,
  }, async ({ expected_candidate_id, path, line, character }) => {
    try {
      requireCandidate(session, expected_candidate_id);
      return jsonResult(await session.hover({ path, line, character }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("review_lsp_definition", {
    description: "Run textDocument/definition against the exact candidate bound to this server and return a provenance receipt with URI bindings.",
    inputSchema: querySchema,
  }, async ({ expected_candidate_id, path, line, character }) => {
    try {
      requireCandidate(session, expected_candidate_id);
      return jsonResult(await session.definition({ path, line, character }));
    } catch (error) {
      return errorResult(error);
    }
  });

  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  transport.onerror = (error) => {
    process.stderr.write(`review-lsp MCP transport error: ${error.message}\n`);
  };
  transport.onclose = () => {
    void session.close();
  };

  const shutdown = async (): Promise<void> => {
    await session.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  await server.connect(transport);
}
