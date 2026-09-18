import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import type { CandidateDescriptor, EnvironmentManifest, IsolationKind, TypeScriptProfile } from "./types.js";

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function configExtends(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const extendsValue = (value as Record<string, unknown>).extends;
  return typeof extendsValue === "string" ? extendsValue : undefined;
}

export async function buildEnvironmentManifest(
  candidate: CandidateDescriptor,
  profile: TypeScriptProfile,
  isolation: IsolationKind = candidate.isolation,
  isolationIdentity = isolation === "TRUSTED_LOCAL"
    ? `native:${process.platform}:${process.arch}`
    : "container:unbound",
): Promise<EnvironmentManifest> {
  const limitations: string[] = [];
  const sourceConfigDigests: Array<{ path: string; sha256: string }> = [];
  const configPaths = candidate.entries
    .filter((entry) => entry.kind === "file" && /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$|(?:^|\/)jsconfig\.json$/.test(entry.path))
    .map((entry) => entry.path)
    .sort();

  for (const path of configPaths) {
    const entry = candidate.entries.find((item) => item.path === path);
    if (!entry) continue;
    sourceConfigDigests.push({ path, sha256: entry.sha256 });
    try {
      const text = await readFile(join(candidate.source_root, path), "utf8");
      const parsed = JSON.parse(stripJsonComments(text)) as unknown;
      const extendsValue = configExtends(parsed);
      if (extendsValue) {
        if (!extendsValue.startsWith(".") && !isAbsolute(extendsValue)) {
          limitations.push(`${path} extends package/external config ${JSON.stringify(extendsValue)} without an admitted dependency snapshot`);
        } else {
          const resolved = normalize(join(dirname(path), extendsValue));
          if (isAbsolute(resolved) || resolved === ".." || resolved.startsWith("../")) {
            limitations.push(`${path} extends config outside the candidate root`);
          } else {
            const candidates = [resolved, `${resolved}.json`, join(resolved, "tsconfig.json")];
            if (!candidates.some((candidatePath) => candidate.entries.some((item) => item.path === candidatePath))) {
              limitations.push(`${path} extends missing candidate config ${JSON.stringify(extendsValue)}`);
            }
          }
        }
      }
    } catch {
      limitations.push(`${path} could not be parsed for environment admission`);
    }
  }

  let dependencyState: "NONE" | "MISSING" = "NONE";
  const packageEntry = candidate.entries.find((entry) => entry.path === "package.json" && entry.kind === "file");
  if (packageEntry) {
    try {
      const packageJson = JSON.parse(await readFile(join(candidate.source_root, "package.json"), "utf8")) as Record<string, unknown>;
      const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
      const declared = sections.some((key) => {
        const value = packageJson[key];
        return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
      });
      if (declared) {
        dependencyState = "MISSING";
        limitations.push("candidate declares package dependencies but no dependency snapshot is admitted in H1/H2");
      }
    } catch {
      dependencyState = "MISSING";
      limitations.push("package.json could not be parsed for dependency admission");
    }
  }

  const binding = limitations.length === 0 ? "VERIFIED" as const : "PARTIAL" as const;
  const stable = {
    schema_version: "review-lsp.environment.v1" as const,
    candidate_id: candidate.candidate_id,
    profile_sha256: profile.profile_sha256,
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    isolation,
    isolation_identity: isolationIdentity,
    source_config_digests: sourceConfigDigests,
    dependency_snapshot: { state: dependencyState } as { state: "NONE" | "MISSING" },
    external_inputs: [
      `typescript-language-server@${profile.server_package_version}:${profile.server_package_sha256}`,
      `typescript@${profile.typescript_version}:${profile.typescript_package_sha256}`,
      `node:${profile.node_executable_sha256}`,
    ],
    binding,
    limitations,
  };
  return {
    ...stable,
    environment_manifest_sha256: sha256(canonicalJson(stable)),
  };
}
