import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import { ReviewLspError } from "../core/errors.js";
import type { SemanticRuntimeManager } from "../core/runtime.js";
import { resolveProjectForDocument } from "../core/toolchain.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
  ResolvingProject,
  TypeScriptProfile,
} from "../core/types.js";

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

export interface CandidateMcpHost {
  candidate: CandidateDescriptor;
  profile: TypeScriptProfile;
  stateDirectory: string;
  snapshot: DependencySnapshotDescriptor | null;
  projection: ProjectionDescriptor | null;
  derivedArtifactSnapshotIds: string[];
  runtimeManager: SemanticRuntimeManager;
  resolvingProjectIdentity(project: ResolvingProject): string;
}

function requireCandidate(host: CandidateMcpHost, expectedCandidateId: string): void {
  if (expectedCandidateId !== host.candidate.candidate_id) {
    throw new ReviewLspError(
      "CANDIDATE_MISMATCH",
      `expected candidate ${expectedCandidateId} but this MCP process is bound to ${host.candidate.candidate_id}`,
    );
  }
}

function candidateInfoProject(): ResolvingProject {
  // Candidate-info is repository-wide metadata, not a document query. Binding it to a fake
  // probe path would invent ownership under Alpha.6, so it deliberately uses no project owner.
  return {
    state: "UNRESOLVED",
    config_path: null,
    config_sha256: null,
    project_root: null,
    ownership_sha256: null,
  };
}

async function acquireHostRuntime(host: CandidateMcpHost, project: ResolvingProject) {
  return host.runtimeManager.acquire({
    candidate: host.candidate,
    profile: host.profile,
    stateDirectory: host.stateDirectory,
    snapshot: host.snapshot,
    projection: host.projection,
    derivedArtifactSnapshotIds: host.derivedArtifactSnapshotIds,
    resolvingProject: project,
    resolvingProjectIdentity: host.resolvingProjectIdentity(project),
  });
}

export async function serveCandidateMcp(host: CandidateMcpHost): Promise<void> {
  const server = new McpServer({
    name: "review-lsp",
    version: "0.0.0",
  });

  server.registerTool("review_lsp_candidate_info", {
    description: "Return the immutable candidate/environment/profile identity bound to this Review-LSP MCP process.",
    inputSchema: {},
  }, async () => {
    let lease;
    try {
      lease = await acquireHostRuntime(host, candidateInfoProject());
      const info = await lease.session.candidateInfo();
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
        runtime_key_id: lease.key_id,
      });
    } catch (error) {
      return errorResult(error);
    } finally {
      lease?.release();
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
    let lease;
    try {
      requireCandidate(host, expected_candidate_id);
      const project = await resolveProjectForDocument(host.candidate, path);
      lease = await acquireHostRuntime(host, project);
      return jsonResult(await lease.session.hover({ path, line, character }));
    } catch (error) {
      return errorResult(error);
    } finally {
      lease?.release();
    }
  });

  server.registerTool("review_lsp_definition", {
    description: "Run textDocument/definition against the exact candidate bound to this server and return a provenance receipt with URI bindings.",
    inputSchema: querySchema,
  }, async ({ expected_candidate_id, path, line, character }) => {
    let lease;
    try {
      requireCandidate(host, expected_candidate_id);
      const project = await resolveProjectForDocument(host.candidate, path);
      lease = await acquireHostRuntime(host, project);
      return jsonResult(await lease.session.definition({ path, line, character }));
    } catch (error) {
      return errorResult(error);
    } finally {
      lease?.release();
    }
  });

  server.registerTool("review_lsp_references", {
    description: "Run textDocument/references against the exact candidate and return the server response plus provenance bindings for every referenced URI.",
    inputSchema: {
      ...querySchema,
      include_declaration: z.boolean().describe("Whether to include the declaration location in the requested reference set"),
    },
  }, async ({ expected_candidate_id, path, line, character, include_declaration }) => {
    let lease;
    try {
      requireCandidate(host, expected_candidate_id);
      const project = await resolveProjectForDocument(host.candidate, path);
      lease = await acquireHostRuntime(host, project);
      return jsonResult(await lease.session.references({
        path,
        line,
        character,
        includeDeclaration: include_declaration,
      }));
    } catch (error) {
      return errorResult(error);
    } finally {
      lease?.release();
    }
  });

  server.registerTool("review_lsp_diagnostics", {
    description: "Return candidate-bound document diagnostics from the deterministic engine transport admitted for this exact candidate.",
    inputSchema: {
      expected_candidate_id: z.string().min(1),
      path: z.string().min(1),
    },
  }, async ({ expected_candidate_id, path }) => {
    let lease;
    try {
      requireCandidate(host, expected_candidate_id);
      const project = await resolveProjectForDocument(host.candidate, path);
      lease = await acquireHostRuntime(host, project);
      const info = await lease.session.candidateInfo();
      if (!info.capabilities.includes("diagnostics")) {
        throw new ReviewLspError("LSP_CAPABILITY_UNSUPPORTED", "initialized semantic engine does not admit deterministic diagnostics");
      }
      return jsonResult(await lease.session.diagnostics({ path }));
    } catch (error) {
      return errorResult(error);
    } finally {
      lease?.release();
    }
  });

  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  transport.onerror = (error) => {
    process.stderr.write(`review-lsp MCP transport error: ${error.message}\n`);
  };
  transport.onclose = () => {
    void host.runtimeManager.dispose();
  };

  const shutdown = async (): Promise<void> => {
    await host.runtimeManager.dispose().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  await server.connect(transport);
}
