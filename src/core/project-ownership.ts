import { posix } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import { readCandidateFile } from "./candidate.js";
import { analyzeProjectReferences } from "./project-references.js";
import type {
  CandidateDescriptor,
  ProjectOwnershipAllowJsEvidence,
  ProjectOwnershipConfigEvidence,
  ProjectOwnershipEvidence,
  ProjectOwnershipRuleEvidence,
  ResolvingProject,
} from "./types.js";

const PROJECT_CONFIG_PATTERN = /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$|(?:^|\/)jsconfig\.json$/;
const MAX_PROJECT_CONFIGS = 1024;
const MAX_EXTENDS_DEPTH = 64;

type RuleKind = "files" | "include" | "exclude";

interface ParsedConfig {
  path: string;
  sha256: string;
  value: Record<string, unknown> | null;
  limitations: string[];
  extendsTarget: string | null;
  ownFiles: ProjectOwnershipRuleEvidence | null | undefined;
  ownInclude: ProjectOwnershipRuleEvidence | null | undefined;
  ownExclude: ProjectOwnershipRuleEvidence | null | undefined;
  ownAllowJs: ProjectOwnershipAllowJsEvidence | undefined;
}

interface EffectiveConfig {
  evidence: ProjectOwnershipConfigEvidence;
  limitations: string[];
}

export interface ProjectOwnershipAnalysis {
  evidence: ProjectOwnershipEvidence;
  limitations: string[];
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      if (index < input.length) output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length) {
        if (input[index] === "\n") output += "\n";
        if (input[index] === "*" && input[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    output += char;
  }
  return output;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectRoot(configPath: string): string {
  const dir = posix.dirname(configPath);
  return dir === "." ? "" : dir;
}

function isConventionalProjectConfig(path: string): boolean {
  const name = posix.basename(path);
  return name === "tsconfig.json" || name === "jsconfig.json";
}

function implicitAllowJs(configPath: string): ProjectOwnershipAllowJsEvidence | undefined {
  return posix.basename(configPath) === "jsconfig.json"
    ? { value: true, origin_config_path: configPath, source: "JSCONFIG_DEFAULT" }
    : undefined;
}

function typescriptDefaultAllowJs(): ProjectOwnershipAllowJsEvidence {
  return { value: false, origin_config_path: null, source: "TYPESCRIPT_DEFAULT" };
}

function invalidPortablePath(value: string): string | null {
  if (!value || value.includes("\0")) return "must be a non-empty string without NUL";
  if (value.includes("\\")) return "uses backslashes; only candidate-relative POSIX paths are admitted";
  if (posix.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return "is absolute/external";
  return null;
}

function resolveCandidateRelative(configPath: string, value: string): { value?: string; limitation?: string } {
  const invalid = invalidPortablePath(value);
  if (invalid) return { limitation: `${configPath} path ${JSON.stringify(value)} ${invalid}` };
  const resolved = posix.normalize(posix.join(posix.dirname(configPath), value));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    return { limitation: `${configPath} path ${JSON.stringify(value)} escapes candidate authority` };
  }
  return { value: resolved };
}

function validateGlob(configPath: string, value: string): { value?: string; limitation?: string } {
  const invalid = invalidPortablePath(value);
  if (invalid) return { limitation: `${configPath} pattern ${JSON.stringify(value)} ${invalid}` };
  if (value.startsWith("!")) {
    return { limitation: `${configPath} pattern ${JSON.stringify(value)} uses negation, which Alpha.6 does not admit` };
  }
  if (/[\[\]{}()]/.test(value)) {
    return { limitation: `${configPath} pattern ${JSON.stringify(value)} uses unsupported glob grammar` };
  }
  for (const segment of value.split("/")) {
    if (segment.includes("**") && segment !== "**") {
      return { limitation: `${configPath} pattern ${JSON.stringify(value)} uses ** outside a complete path segment` };
    }
  }

  const segments = [
    ...projectRoot(configPath).split("/").filter(Boolean),
    ...value.split("/"),
  ];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) {
        return { limitation: `${configPath} pattern ${JSON.stringify(value)} escapes candidate authority` };
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return { value: normalized.join("/") };
}

function ruleFrom(
  configPath: string,
  kind: RuleKind,
  raw: unknown,
  files: Map<string, { kind: "file" | "symlink" }>,
): { rule: ProjectOwnershipRuleEvidence | null; limitations: string[] } {
  if (!Array.isArray(raw)) {
    return { rule: null, limitations: [`${configPath} ${kind} must be an array`] };
  }
  const limitations: string[] = [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (typeof item !== "string") {
      limitations.push(`${configPath} ${kind}[${index}] must be a string`);
      continue;
    }
    const resolved = kind === "files"
      ? resolveCandidateRelative(configPath, item)
      : validateGlob(configPath, item);
    if (!resolved.value) {
      limitations.push(resolved.limitation ?? `${configPath} ${kind}[${index}] is unsupported`);
      continue;
    }
    if (kind === "files") {
      const entry = files.get(resolved.value);
      if (!entry || entry.kind !== "file") {
        limitations.push(`${configPath} files[${index}] resolves to missing/non-file candidate path ${resolved.value}`);
        continue;
      }
    }
    if (seen.has(resolved.value)) {
      limitations.push(`${configPath} ${kind} has duplicate normalized entry ${resolved.value}`);
      continue;
    }
    seen.add(resolved.value);
    values.push(resolved.value);
  }
  values.sort();
  return {
    rule: {
      origin_config_path: configPath,
      base_directory: projectRoot(configPath),
      values,
    },
    limitations,
  };
}

function targetForExtends(
  configPath: string,
  declared: string,
  configs: Map<string, ParsedConfig>,
): { target?: string; limitation?: string } {
  if (!declared.startsWith(".")) {
    return { limitation: `${configPath} extends package/external config ${JSON.stringify(declared)}; Alpha.6 admits only relative candidate-contained extends` };
  }
  const resolved = resolveCandidateRelative(configPath, declared);
  if (!resolved.value) return { limitation: resolved.limitation ?? `${configPath} extends target is unsupported` };
  const candidates = resolved.value.endsWith(".json")
    ? [resolved.value]
    : [resolved.value, `${resolved.value}.json`, posix.join(resolved.value, "tsconfig.json")];
  const matches = [...new Set(candidates)].filter((path) => configs.has(path));
  if (matches.length === 0) {
    return { limitation: `${configPath} extends missing candidate config ${JSON.stringify(declared)}` };
  }
  if (matches.length > 1) {
    return { limitation: `${configPath} extends ${JSON.stringify(declared)} is ambiguous: ${matches.sort().join(", ")}` };
  }
  return { target: matches[0]! };
}

function globRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      const next = pattern[i + 2];
      const prev = pattern[i - 1];
      if ((i === 0 || prev === "/") && next === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  out += "$";
  return new RegExp(out);
}

function matchesRule(rule: ProjectOwnershipRuleEvidence | null, documentPath: string): boolean {
  if (!rule) return false;
  return rule.values.some((pattern) => globRegex(pattern).test(documentPath));
}

function includeExtensionEligible(documentPath: string, allowJs: boolean): boolean {
  const extension = posix.extname(documentPath);
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return true;
  if (allowJs && [".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return true;
  return false;
}

function effectiveMembership(config: ProjectOwnershipConfigEvidence, documentPath: string): boolean {
  if (config.effective_files?.values.includes(documentPath)) return true;
  if (!includeExtensionEligible(documentPath, config.effective_allow_js.value)) return false;
  if (!matchesRule(config.effective_include, documentPath)) return false;
  return !matchesRule(config.effective_exclude, documentPath);
}

export function resolveProjectOwner(
  analysis: ProjectOwnershipAnalysis,
  documentPath: string,
): ResolvingProject {
  const normalized = posix.normalize(documentPath);
  if (!documentPath || normalized !== documentPath || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return {
      state: "UNSUPPORTED",
      config_path: null,
      config_sha256: null,
      project_root: null,
      ownership_sha256: null,
      limitations: [`document path ${JSON.stringify(documentPath)} is not an admitted canonical candidate-relative path`],
    };
  }

  if (analysis.evidence.state === "UNSUPPORTED") {
    return {
      state: "UNSUPPORTED",
      config_path: null,
      config_sha256: null,
      project_root: null,
      ownership_sha256: null,
      limitations: [...analysis.limitations],
    };
  }

  const owners = analysis.evidence.configs
    .filter((config) => config.routable_project && effectiveMembership(config, documentPath))
    .map((config) => ({
      config_path: config.path,
      config_sha256: config.sha256,
      project_root: projectRoot(config.path),
      ownership_sha256: config.membership_sha256,
    }))
    .sort((a, b) => a.config_path.localeCompare(b.config_path));

  if (owners.length === 0) {
    return {
      state: "UNRESOLVED",
      config_path: null,
      config_sha256: null,
      project_root: null,
      ownership_sha256: analysis.evidence.model_sha256 ?? null,
    };
  }
  if (owners.length > 1) {
    return {
      state: "AMBIGUOUS",
      config_path: null,
      config_sha256: null,
      project_root: null,
      ownership_sha256: analysis.evidence.model_sha256 ?? null,
      candidate_configs: owners,
      limitations: [`document ${documentPath} is owned by multiple admitted projects: ${owners.map((owner) => owner.config_path).join(", ")}`],
    };
  }
  const owner = owners[0]!;
  return {
    state: "RESOLVED",
    config_path: owner.config_path,
    config_sha256: owner.config_sha256,
    project_root: owner.project_root,
    ownership_sha256: owner.ownership_sha256,
  };
}

export async function analyzeProjectOwnership(candidate: CandidateDescriptor): Promise<ProjectOwnershipAnalysis> {
  const configEntries = candidate.entries
    .filter((entry) => entry.kind === "file" && PROJECT_CONFIG_PATTERN.test(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (configEntries.length === 0) {
    return {
      evidence: { schema_version: "review-lsp.project-ownership.v1", state: "NONE", configs: [] },
      limitations: [],
    };
  }
  if (configEntries.length > MAX_PROJECT_CONFIGS) {
    return {
      evidence: { schema_version: "review-lsp.project-ownership.v1", state: "UNSUPPORTED", configs: [] },
      limitations: [`candidate has ${configEntries.length} TypeScript/JavaScript project configs; ownership admission limit is ${MAX_PROJECT_CONFIGS}`],
    };
  }

  const files = new Map(
    candidate.entries.map((entry) => [entry.path, { kind: entry.kind }] as const),
  );
  const verified = new Map<string, Awaited<ReturnType<typeof readCandidateFile>>>();
  for (const entry of configEntries) {
    verified.set(entry.path, await readCandidateFile(candidate, entry.path));
  }

  const parsed = new Map<string, ParsedConfig>();
  for (const entry of configEntries) {
    const exact = verified.get(entry.path);
    if (!exact) throw new Error(`verified ownership config missing for ${entry.path}`);
    const limitations: string[] = [];
    let value: Record<string, unknown> | null = null;
    try {
      const decoded = JSON.parse(stripJsonComments(exact.bytes.toString("utf8"))) as unknown;
      if (!isObject(decoded)) {
        limitations.push(`${entry.path} is not a JSON object for project ownership admission`);
      } else {
        value = decoded;
      }
    } catch {
      limitations.push(`${entry.path} could not be parsed for project ownership admission`);
    }

    parsed.set(entry.path, {
      path: entry.path,
      sha256: exact.sha256,
      value,
      limitations,
      extendsTarget: null,
      ownFiles: undefined,
      ownInclude: undefined,
      ownExclude: undefined,
      ownAllowJs: implicitAllowJs(entry.path),
    });
  }

  for (const config of parsed.values()) {
    if (!config.value) continue;
    const compilerOptions = config.value.compilerOptions;
    if (compilerOptions !== undefined) {
      if (!isObject(compilerOptions)) {
        config.limitations.push(`${config.path} compilerOptions must be an object for allowJs admission`);
      } else if (Object.prototype.hasOwnProperty.call(compilerOptions, "allowJs")) {
        if (typeof compilerOptions.allowJs !== "boolean") {
          config.limitations.push(`${config.path} compilerOptions.allowJs must be a boolean`);
        } else {
          config.ownAllowJs = {
            value: compilerOptions.allowJs,
            origin_config_path: config.path,
            source: "EXPLICIT",
          };
        }
      }
    }

    const extendsValue = config.value.extends;
    if (extendsValue !== undefined) {
      if (typeof extendsValue !== "string") {
        config.limitations.push(`${config.path} extends must be a string`);
      } else {
        const target = targetForExtends(config.path, extendsValue, parsed);
        if (target.target) config.extendsTarget = target.target;
        else config.limitations.push(target.limitation ?? `${config.path} extends could not be admitted`);
      }
    }

    for (const [kind, property] of [["files", "ownFiles"], ["include", "ownInclude"], ["exclude", "ownExclude"]] as const) {
      if (!Object.prototype.hasOwnProperty.call(config.value, kind)) continue;
      const result = ruleFrom(config.path, kind, config.value[kind], files);
      config[property] = result.rule;
      config.limitations.push(...result.limitations);
    }
  }

  const projectReferences = await analyzeProjectReferences(candidate);
  const referencedTargets = new Set(
    projectReferences.evidence.configs.flatMap((config) => config.references.map((reference) => reference.resolved_config_path)),
  );
  const routingFor = (path: string): Pick<ProjectOwnershipConfigEvidence, "routable_project" | "routing_reason"> => {
    if (isConventionalProjectConfig(path)) return { routable_project: true, routing_reason: "CONVENTIONAL_CONFIG" };
    if (referencedTargets.has(path)) return { routable_project: true, routing_reason: "PROJECT_REFERENCE_TARGET" };
    return { routable_project: false, routing_reason: "INHERITANCE_ONLY" };
  };

  // Only routable projects, project-reference sources that participate in admitted routing,
  // and their relative-extends ancestors can affect Alpha.6 document ownership. Other admitted
  // tsconfig.* files remain evidence, but their unsupported constructs must not poison an
  // unrelated document's routing authority.
  const routingRelevantPaths = new Set<string>();
  const markRoutingRelevant = (path: string): void => {
    if (routingRelevantPaths.has(path)) return;
    routingRelevantPaths.add(path);
    const parent = parsed.get(path)?.extendsTarget;
    if (parent) markRoutingRelevant(parent);
  };
  for (const path of parsed.keys()) {
    if (routingFor(path).routable_project) markRoutingRelevant(path);
  }
  for (const config of projectReferences.evidence.configs) {
    markRoutingRelevant(config.path);
  }

  const memo = new Map<string, EffectiveConfig>();
  const visiting: string[] = [];

  const resolveEffective = (path: string, depth = 0): EffectiveConfig => {
    const prior = memo.get(path);
    if (prior) return prior;
    const config = parsed.get(path);
    if (!config) throw new Error(`project ownership config missing for ${path}`);
    if (depth > MAX_EXTENDS_DEPTH) {
      const result = {
        evidence: {
          path: config.path,
          sha256: config.sha256,
          ...routingFor(config.path),
          routing_relevant: routingRelevantPaths.has(config.path),
          extends_chain: [],
          effective_files: null,
          effective_include: null,
          effective_exclude: null,
          effective_allow_js: config.ownAllowJs ?? typescriptDefaultAllowJs(),
          limitations: [`${config.path} extends chain exceeds depth limit ${MAX_EXTENDS_DEPTH}`],
          membership_sha256: sha256(canonicalJson({ path: config.path, state: "DEPTH_EXCEEDED" })),
        },
        limitations: [`${config.path} extends chain exceeds depth limit ${MAX_EXTENDS_DEPTH}`],
      } satisfies EffectiveConfig;
      memo.set(path, result);
      return result;
    }
    const cycleAt = visiting.indexOf(path);
    if (cycleAt >= 0) {
      const cycle = [...visiting.slice(cycleAt), path];
      return {
        evidence: {
          path: config.path,
          sha256: config.sha256,
          ...routingFor(config.path),
          routing_relevant: routingRelevantPaths.has(config.path),
          extends_chain: [],
          effective_files: null,
          effective_include: null,
          effective_exclude: null,
          effective_allow_js: config.ownAllowJs ?? typescriptDefaultAllowJs(),
          limitations: [`project ownership extends cycle: ${cycle.join(" -> ")}`],
          membership_sha256: sha256(canonicalJson({ path: config.path, cycle })),
        },
        limitations: [`project ownership extends cycle: ${cycle.join(" -> ")}`],
      };
    }

    visiting.push(path);
    const parent = config.extendsTarget ? resolveEffective(config.extendsTarget, depth + 1) : null;
    visiting.pop();

    const effectiveFiles = config.ownFiles !== undefined ? config.ownFiles : parent?.evidence.effective_files ?? null;
    const effectiveInclude = config.ownInclude !== undefined ? config.ownInclude : parent?.evidence.effective_include ?? null;
    const effectiveExclude = config.ownExclude !== undefined ? config.ownExclude : parent?.evidence.effective_exclude ?? null;
    const effectiveAllowJs = config.ownAllowJs ?? parent?.evidence.effective_allow_js ?? typescriptDefaultAllowJs();
    const chain = parent
      ? [{ path: parent.evidence.path, sha256: parent.evidence.sha256 }, ...parent.evidence.extends_chain]
      : [];
    const limitations = [...config.limitations, ...(parent?.limitations ?? [])];
    if (routingFor(config.path).routable_project && !effectiveFiles && !effectiveInclude) {
      limitations.push(`${config.path} has no effective files/include rule; Alpha.6 does not claim TypeScript default file discovery`);
    }
    const uniqueLimitations = [...new Set(limitations)];
    const membershipStable = {
      path: config.path,
      sha256: config.sha256,
      ...routingFor(config.path),
      routing_relevant: routingRelevantPaths.has(config.path),
      extends_chain: chain,
      effective_files: effectiveFiles,
      effective_include: effectiveInclude,
      effective_exclude: effectiveExclude,
      effective_allow_js: effectiveAllowJs,
      limitations: uniqueLimitations,
    };
    const result: EffectiveConfig = {
      evidence: {
        ...membershipStable,
        membership_sha256: sha256(canonicalJson(membershipStable)),
      },
      limitations: uniqueLimitations,
    };
    memo.set(path, result);
    return result;
  };

  const configs = [...parsed.keys()].sort().map((path) => resolveEffective(path));
  const relevantReferenceLimitations = projectReferences.evidence.state === "UNSUPPORTED"
    ? projectReferences.limitations.filter((limitation) => {
        const sourcePath = [...parsed.keys()].find((path) => limitation.startsWith(`${path} `));
        return sourcePath ? routingRelevantPaths.has(sourcePath) : true;
      })
    : [];
  const limitations = [...new Set([
    ...configs
      .filter((config) => config.evidence.routing_relevant)
      .flatMap((config) => config.limitations),
    ...relevantReferenceLimitations
      .map((limitation) => `project-reference dependency for ownership routing: ${limitation}`),
  ])];
  const evidenceConfigs = configs.map((config) => config.evidence).sort((a, b) => a.path.localeCompare(b.path));
  const modelSha256 = sha256(canonicalJson(evidenceConfigs));
  return {
    evidence: {
      schema_version: "review-lsp.project-ownership.v1",
      state: limitations.length === 0 ? "BOUND" : "UNSUPPORTED",
      model_sha256: modelSha256,
      configs: evidenceConfigs,
    },
    limitations,
  };
}
