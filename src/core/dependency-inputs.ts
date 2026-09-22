import { posix } from "node:path";

import { readCandidateFile } from "./candidate.js";
import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { CandidateDescriptor, DependencyInputSet, DependencyInputFile } from "./types.js";

/**
 * Derives the exact dependency inputs a candidate declares.
 *
 * Every input is read from the candidate's own admitted bytes, never from the live
 * workspace, and every file that participates is recorded with its digest. The resulting
 * identity is what a dependency snapshot is content-addressed by, so anything that can change
 * resolution must be bound here or it cannot be claimed as admitted later.
 */

const SUPPORTED_LOCKFILE_VERSIONS = new Set(["9.0", "9"]);

/**
 * `.npmrc` keys that cannot redirect resolution, execute anything, or grant credentials.
 * Everything else makes the candidate's package-manager configuration unsupported rather
 * than being silently dropped, because dropping it would change what resolution means.
 */
const NPMRC_SAFE_KEYS = new Set([
  "auto-install-peers",
  "dedupe-peer-dependents",
  "enable-pre-post-scripts",
  "link-workspace-packages",
  "prefer-workspace-packages",
  "resolution-mode",
  "save-exact",
  "shamefully-hoist",
  "strict-peer-dependencies",
  "node-linker",
  "hoist",
  "hoist-pattern",
  "public-hoist-pattern",
]);

function requireEntry(candidate: CandidateDescriptor, path: string): boolean {
  return candidate.entries.some((entry) => entry.path === path && entry.kind === "file");
}

async function readInput(candidate: CandidateDescriptor, path: string): Promise<DependencyInputFile> {
  const { bytes, sha256: digest } = await readCandidateFile(candidate, path);
  return { path, sha256: digest, byte_count: bytes.byteLength };
}

function localFileReferences(lockfileText: string): string[] {
  const references = new Set<string>();
  for (const match of lockfileText.matchAll(/file:([^,\s}\]"']+)/g)) {
    const value = match[1];
    if (value) references.add(value);
  }
  return [...references].sort();
}

function localTarballPaths(
  candidate: CandidateDescriptor,
  workspaceManifests: string[],
  lockfileText: string,
): string[] {
  const importerDirectories = [
    ".",
    ...workspaceManifests.map((path) => posix.dirname(path)),
  ];
  const resolved = new Set<string>();

  for (const reference of localFileReferences(lockfileText)) {
    if (!reference.endsWith(".tgz")) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `local file dependency ${JSON.stringify(reference)} is not an admitted .tgz artifact`,
      );
    }
    if (reference.includes("\\") || posix.isAbsolute(reference)) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `local tarball dependency ${JSON.stringify(reference)} is not a portable candidate-relative path`,
      );
    }

    const matches = new Set<string>();
    for (const importerDirectory of importerDirectories) {
      const candidatePath = posix.normalize(posix.join(importerDirectory, reference));
      if (candidatePath === ".." || candidatePath.startsWith("../") || posix.isAbsolute(candidatePath)) continue;
      if (requireEntry(candidate, candidatePath)) matches.add(candidatePath);
    }

    if (matches.size === 0) {
      throw new ReviewLspError(
        "DEPENDENCY_INPUT_INVALID",
        `local tarball dependency ${JSON.stringify(reference)} does not resolve to an admitted candidate file`,
      );
    }
    if (matches.size > 1) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `local tarball dependency ${JSON.stringify(reference)} resolves ambiguously inside the candidate: ${[...matches].join(", ")}`,
      );
    }
    resolved.add([...matches][0]!);
  }

  return [...resolved].sort();
}

function parseJson(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ReviewLspError("DEPENDENCY_INPUT_INVALID", `${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewLspError("DEPENDENCY_INPUT_INVALID", `${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Minimal YAML scalar lookup for the few top-level keys pnpm metadata needs. */
function yamlTopLevelScalar(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

/** Collects one block-style YAML string list while failing closed on unsupported syntax. */
function yamlStringList(text: string, key: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => {
    if (line.startsWith(" ") || line.startsWith("\t") || line.trim().startsWith("#")) return false;
    const separator = line.indexOf(":");
    return separator >= 0 && line.slice(0, separator).trim() === key;
  });
  if (start < 0) return [];

  const header = lines[start] ?? "";
  const separator = header.indexOf(":");
  if (header.slice(separator + 1).trim() !== "") {
    throw new ReviewLspError(
      "DEPENDENCY_UNSUPPORTED",
      `pnpm-workspace.yaml ${key} must use the admitted block-list syntax`,
    );
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) break;
    const item = line.trim();
    if (!item.startsWith("- ")) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `pnpm-workspace.yaml ${key} contains unsupported YAML list syntax`,
      );
    }
    const value = item.slice(2).trim().replace(/^['"]|['"]$/g, "");
    if (!value) {
      throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", `pnpm-workspace.yaml ${key} contains an empty workspace pattern`);
    }
    values.push(value);
  }
  return values;
}


function workspaceGlobPattern(glob: string): RegExp {
  if (glob.startsWith("!") || glob === "" || glob.startsWith("/") || glob.includes("\\")) {
    throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", `workspace glob ${JSON.stringify(glob)} is outside the admitted subset`);
  }

  const segments = glob.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", `workspace glob ${JSON.stringify(glob)} has an unsupported path segment`);
  }

  const patternSegments = segments.map((segment) => {
    if (segment === "**") return "[^\\0]+";
    if (segment === "*") return "[^/]+";
    // pnpm accepts a broader micromatch grammar. This provider intentionally implements only
    // literal segments plus * and **; every other glob construct fails closed instead of
    // silently shrinking the workspace authority used by later VERIFIED gates.
    if (/[*?{}()[\]!]/.test(segment)) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `workspace glob ${JSON.stringify(glob)} uses unsupported pnpm glob syntax`,
      );
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });

  return new RegExp(`^${patternSegments.join("/")}/package\\.json$`);
}

/** Expands the admitted literal, single-star and recursive-star workspace-glob subset. */
function workspaceManifestPaths(candidate: CandidateDescriptor, globs: string[]): string[] {
  const manifests = candidate.entries
    .filter((entry) => entry.kind === "file" && entry.path.endsWith("package.json"))
    .map((entry) => entry.path);

  const matched = new Set<string>();
  for (const glob of globs) {
    const pattern = workspaceGlobPattern(glob);
    for (const path of manifests) {
      if (pattern.test(path)) matched.add(path);
    }
  }
  return [...matched].sort();
}


function parseNpmrc(path: string, text: string): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) {
      throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", `${path} line ${JSON.stringify(line)} is not a key=value setting`);
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value.includes("${")) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `${path} key ${JSON.stringify(key)} interpolates the environment, which is not admissible`,
      );
    }
    if (!NPMRC_SAFE_KEYS.has(key)) {
      throw new ReviewLspError(
        "DEPENDENCY_UNSUPPORTED",
        `${path} key ${JSON.stringify(key)} is outside the admitted safe-key policy`,
      );
    }
    settings[key] = value;
  }
  return settings;
}

/** Reads the exact pnpm version from a `packageManager` declaration. */
function pnpmVersion(rootManifest: Record<string, unknown>): string {
  const declared = rootManifest.packageManager;
  if (typeof declared !== "string") {
    throw new ReviewLspError(
      "DEPENDENCY_UNSUPPORTED",
      "candidate does not declare an exact packageManager; pnpm version cannot be pinned from candidate evidence",
    );
  }
  const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.exec(declared);
  if (!match?.[1]) {
    throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", `packageManager ${JSON.stringify(declared)} is not an exact pnpm version`);
  }
  return match[1];
}

/** Extracts the TypeScript version a manifest declares, if any. */
function declaredTypeScript(manifest: Record<string, unknown>): string | undefined {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const group = manifest[field];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const version = (group as Record<string, unknown>).typescript;
    if (typeof version === "string") return version;
  }
  return undefined;
}

export async function deriveDependencyInputs(candidate: CandidateDescriptor): Promise<DependencyInputSet> {
  if (!requireEntry(candidate, "package.json")) {
    throw new ReviewLspError("DEPENDENCY_UNSUPPORTED", "candidate has no root package.json");
  }
  if (!requireEntry(candidate, "pnpm-lock.yaml")) {
    throw new ReviewLspError(
      "DEPENDENCY_UNSUPPORTED",
      "candidate has no pnpm-lock.yaml; only lockfile-pinned pnpm projects are admissible",
    );
  }

  const files: DependencyInputFile[] = [];
  const rootManifestText = (await readCandidateFile(candidate, "package.json")).bytes.toString("utf8");
  const rootManifest = parseJson("package.json", rootManifestText);
  files.push(await readInput(candidate, "package.json"));

  const lockfileText = (await readCandidateFile(candidate, "pnpm-lock.yaml")).bytes.toString("utf8");
  files.push(await readInput(candidate, "pnpm-lock.yaml"));
  const lockfileVersion = yamlTopLevelScalar(lockfileText, "lockfileVersion");
  if (!lockfileVersion || !SUPPORTED_LOCKFILE_VERSIONS.has(lockfileVersion)) {
    throw new ReviewLspError(
      "DEPENDENCY_UNSUPPORTED",
      `pnpm lockfileVersion ${JSON.stringify(lockfileVersion ?? "(absent)")} is not supported by this provider`,
    );
  }

  let workspaceGlobs: string[] = [];
  if (requireEntry(candidate, "pnpm-workspace.yaml")) {
    const workspaceText = (await readCandidateFile(candidate, "pnpm-workspace.yaml")).bytes.toString("utf8");
    files.push(await readInput(candidate, "pnpm-workspace.yaml"));
    workspaceGlobs = yamlStringList(workspaceText, "packages");
  }

  const workspaceManifests = workspaceManifestPaths(candidate, workspaceGlobs);
  for (const path of workspaceManifests) files.push(await readInput(candidate, path));

  // pnpm needs candidate-contained local tarballs at their original relative paths while it
  // evaluates the frozen lockfile. Bind those bytes into the dependency input identity and
  // materialize them alongside manifests/lockfile during acquisition. Other local file
  // dependency shapes remain unsupported rather than silently widening source authority.
  for (const path of localTarballPaths(candidate, workspaceManifests, lockfileText)) {
    files.push(await readInput(candidate, path));
  }

  let npmrc: Record<string, string> = {};
  if (requireEntry(candidate, ".npmrc")) {
    const npmrcText = (await readCandidateFile(candidate, ".npmrc")).bytes.toString("utf8");
    files.push(await readInput(candidate, ".npmrc"));
    npmrc = parseNpmrc(".npmrc", npmrcText);
  }

  // Patches are candidate-controlled inputs that change installed bytes, so each referenced
  // patch must exist in the candidate and be bound by digest.
  const patches: DependencyInputFile[] = [];
  const patchedDependencies = requireEntry(candidate, "pnpm-workspace.yaml")
    ? patchEntries((await readCandidateFile(candidate, "pnpm-workspace.yaml")).bytes.toString("utf8"))
    : [];
  for (const patchPath of patchedDependencies) {
    if (!requireEntry(candidate, patchPath)) {
      throw new ReviewLspError("DEPENDENCY_INPUT_INVALID", `referenced patch ${patchPath} is not part of the candidate`);
    }
    const input = await readInput(candidate, patchPath);
    patches.push(input);
    files.push(input);
  }

  // Project TypeScript is recorded here so the semantic profile router can select the
  // candidate's own generation later. Recording it is not admitting it.
  const workspaceTypeScript: Record<string, string> = {};
  for (const path of workspaceManifests) {
    const manifest = parseJson(path, (await readCandidateFile(candidate, path)).bytes.toString("utf8"));
    const version = declaredTypeScript(manifest);
    if (version) workspaceTypeScript[path] = version;
  }
  const rootTypeScript = declaredTypeScript(rootManifest);

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const identityMaterial = {
    schema_version: "review-lsp.dependency-inputs.v1" as const,
    ecosystem: "node" as const,
    package_manager: "pnpm" as const,
    package_manager_version: pnpmVersion(rootManifest),
    platform: process.platform,
    arch: process.arch,
    lockfile_version: lockfileVersion,
    workspace_globs: workspaceGlobs,
    npmrc_settings: npmrc,
    files: sorted,
  };

  return {
    ...identityMaterial,
    input_set_id: contentId("depin", identityMaterial),
    files_sha256: sha256(canonicalJson(sorted)),
    workspace_manifests: workspaceManifests,
    patches,
    project_toolchain: {
      ...(rootTypeScript === undefined ? {} : { root_typescript: rootTypeScript }),
      workspace_typescript: workspaceTypeScript,
    },
  };
}

/** Reads `patchedDependencies:` patch paths from `pnpm-workspace.yaml`. */
function patchEntries(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => !line.startsWith(" ") && line.trim() === "patchedDependencies:");
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ") && !line.startsWith("\t")) break;
    const separator = line.indexOf(":");
    if (separator < 0) break;
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value) paths.push(value);
  }
  return paths;
}
