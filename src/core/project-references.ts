import { posix } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import { readCandidateFile } from "./candidate.js";
import type {
  CandidateDescriptor,
  ProjectReferenceConfigEvidence,
  ProjectReferenceEvidence,
} from "./types.js";

const PROJECT_CONFIG_PATTERN = /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$|(?:^|\/)jsconfig\.json$/;
const MAX_PROJECT_CONFIGS = 1024;
const MAX_PROJECT_REFERENCE_EDGES = 4096;

export interface ProjectReferenceAnalysis {
  evidence: ProjectReferenceEvidence;
  limitations: string[];
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function targetForReference(configPath: string, declaredPath: string): { target?: string; limitation?: string } {
  if (!declaredPath || declaredPath.includes("\0")) {
    return { limitation: `${configPath} project reference path must be a non-empty string without NUL` };
  }
  if (declaredPath.includes("\\")) {
    return { limitation: `${configPath} project reference ${JSON.stringify(declaredPath)} uses backslashes; only candidate-relative POSIX paths are admitted` };
  }
  if (posix.isAbsolute(declaredPath) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(declaredPath)) {
    return { limitation: `${configPath} project reference ${JSON.stringify(declaredPath)} is absolute/external` };
  }

  const resolved = posix.normalize(posix.join(posix.dirname(configPath), declaredPath));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    return { limitation: `${configPath} project reference ${JSON.stringify(declaredPath)} escapes candidate authority` };
  }

  return {
    target: resolved.endsWith(".json") ? resolved : posix.join(resolved, "tsconfig.json"),
  };
}

function cycleIn(adjacency: Map<string, string[]>): string[] | null {
  const state = new Map<string, "VISITING" | "DONE">();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const current = state.get(node);
    if (current === "DONE") return null;
    if (current === "VISITING") {
      const start = stack.lastIndexOf(node);
      return [...stack.slice(Math.max(0, start)), node];
    }

    state.set(node, "VISITING");
    stack.push(node);
    for (const target of adjacency.get(node) ?? []) {
      const found = visit(target);
      if (found) return found;
    }
    stack.pop();
    state.set(node, "DONE");
    return null;
  };

  for (const node of [...adjacency.keys()].sort()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/**
 * Admits the candidate-contained TypeScript project-reference graph.
 *
 * This is deliberately narrower than TypeScript build mode. It binds the exact config bytes
 * and candidate-contained reference edges without executing a compiler or consulting the host
 * filesystem outside candidate authority.
 */
export async function analyzeProjectReferences(candidate: CandidateDescriptor): Promise<ProjectReferenceAnalysis> {
  const configEntries = candidate.entries
    .filter((entry) => entry.kind === "file" && PROJECT_CONFIG_PATTERN.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (configEntries.length > MAX_PROJECT_CONFIGS) {
    return {
      evidence: { state: "UNSUPPORTED", configs: [] },
      limitations: [
        `candidate has ${configEntries.length} TypeScript/JavaScript project configs; project-reference admission limit is ${MAX_PROJECT_CONFIGS}`,
      ],
    };
  }

  const fileEntries = new Map(
    candidate.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => [entry.path, entry] as const),
  );
  const verifiedConfigs = new Map<string, Awaited<ReturnType<typeof readCandidateFile>>>();
  for (const entry of configEntries) {
    verifiedConfigs.set(entry.path, await readCandidateFile(candidate, entry.path));
  }

  const limitations: string[] = [];
  const evidenceConfigs: ProjectReferenceConfigEvidence[] = [];
  const adjacency = new Map<string, string[]>();
  let sawReferences = false;
  let edgeCount = 0;

  for (const entry of configEntries) {
    const verifiedConfig = verifiedConfigs.get(entry.path);
    if (!verifiedConfig) throw new Error(`verified project config missing for ${entry.path}`);
    const { bytes, sha256: configSha256 } = verifiedConfig;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(bytes.toString("utf8"))) as unknown;
    } catch {
      limitations.push(`${entry.path} could not be parsed for project-reference admission`);
      adjacency.set(entry.path, []);
      continue;
    }

    if (!isObject(parsed)) {
      limitations.push(`${entry.path} is not a JSON object for project-reference admission`);
      adjacency.set(entry.path, []);
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, "references")) {
      adjacency.set(entry.path, []);
      continue;
    }
    sawReferences = true;

    if (!Array.isArray(parsed.references)) {
      limitations.push(`${entry.path} references must be an array`);
      adjacency.set(entry.path, []);
      continue;
    }

    const bindings: ProjectReferenceConfigEvidence["references"] = [];
    const targets: string[] = [];
    const seenTargets = new Set<string>();

    for (let index = 0; index < parsed.references.length; index += 1) {
      const reference = parsed.references[index];
      if (!isObject(reference)) {
        limitations.push(`${entry.path} references[${index}] must be an object containing only path`);
        continue;
      }
      const keys = Object.keys(reference).sort();
      if (keys.length !== 1 || keys[0] !== "path") {
        limitations.push(
          `${entry.path} references[${index}] has unsupported fields ${JSON.stringify(keys)}; Alpha.5 admits only { path }`,
        );
        continue;
      }
      if (typeof reference.path !== "string") {
        limitations.push(`${entry.path} references[${index}].path must be a string`);
        continue;
      }

      const resolved = targetForReference(entry.path, reference.path);
      if (!resolved.target) {
        limitations.push(resolved.limitation ?? `${entry.path} references[${index}] could not be resolved`);
        continue;
      }
      const targetEntry = fileEntries.get(resolved.target);
      const verifiedTarget = verifiedConfigs.get(resolved.target);
      if (!targetEntry || !verifiedTarget || !PROJECT_CONFIG_PATTERN.test(resolved.target)) {
        limitations.push(
          `${entry.path} project reference ${JSON.stringify(reference.path)} resolves to missing/unadmitted config ${resolved.target}`,
        );
        continue;
      }
      if (seenTargets.has(resolved.target)) {
        limitations.push(
          `${entry.path} has duplicate project references resolving to ${resolved.target}`,
        );
        continue;
      }
      seenTargets.add(resolved.target);

      edgeCount += 1;
      if (edgeCount > MAX_PROJECT_REFERENCE_EDGES) {
        limitations.push(
          `candidate project-reference graph exceeds the ${MAX_PROJECT_REFERENCE_EDGES}-edge admission limit`,
        );
        continue;
      }

      bindings.push({
        declared_path: reference.path,
        resolved_config_path: resolved.target,
        resolved_config_sha256: verifiedTarget.sha256,
      });
      targets.push(resolved.target);
    }

    bindings.sort((a, b) =>
      a.resolved_config_path.localeCompare(b.resolved_config_path)
      || a.declared_path.localeCompare(b.declared_path));
    targets.sort();
    adjacency.set(entry.path, targets);
    evidenceConfigs.push({
      path: entry.path,
      sha256: configSha256,
      references: bindings,
    });
  }

  const cycle = cycleIn(adjacency);
  if (cycle) {
    limitations.push(`candidate project-reference graph contains a cycle: ${cycle.join(" -> ")}`);
  }

  evidenceConfigs.sort((a, b) => a.path.localeCompare(b.path));

  if (limitations.length > 0) {
    return {
      evidence: { state: "UNSUPPORTED", configs: evidenceConfigs },
      limitations: [...new Set(limitations)],
    };
  }
  if (!sawReferences) {
    return { evidence: { state: "NONE", configs: [] }, limitations: [] };
  }

  const graphSha256 = sha256(canonicalJson(evidenceConfigs));
  return {
    evidence: {
      state: "BOUND",
      graph_sha256: graphSha256,
      configs: evidenceConfigs,
    },
    limitations: [],
  };
}
