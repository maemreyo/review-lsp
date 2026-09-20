import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";

export const ARTIFACT_MANIFEST_SCHEMA = "review-lsp.artifact-manifest.v1" as const;
export const PROVIDER_ENTRYPOINT = "dist/review-lsp.mjs" as const;
export const TYPESCRIPT_SERVER_BUNDLE = "dist/typescript-language-server/lib/cli.mjs" as const;
export const TYPESCRIPT_SERVER_PACKAGE_JSON = "dist/typescript-language-server/package.json" as const;

export interface ArtifactManifestEntry {
  path: string;
  sha256: string;
  byte_count: number;
}

export interface ArtifactManifest {
  schema_version: typeof ARTIFACT_MANIFEST_SCHEMA;
  package_name: string;
  package_version: string;
  identity_scope: "provider_bundle_server_bundle_and_package_json";
  provider_entrypoint: typeof PROVIDER_ENTRYPOINT;
  semantic_toolchain: [
    { name: "typescript-language-server"; version: string },
    { name: "typescript"; version: string },
  ];
  files: ArtifactManifestEntry[];
  artifact_sha256: string;
  artifact_id: string;
}

interface PackageMetadata {
  name: string;
  version: string;
  dependencies: Record<string, string>;
}

function stableManifest(input: Omit<ArtifactManifest, "artifact_sha256" | "artifact_id"> | ArtifactManifest): unknown {
  return {
    schema_version: input.schema_version,
    package_name: input.package_name,
    package_version: input.package_version,
    identity_scope: input.identity_scope,
    provider_entrypoint: input.provider_entrypoint,
    semantic_toolchain: input.semantic_toolchain,
    files: input.files,
  };
}

async function packageMetadata(packageRoot: string): Promise<PackageMetadata> {
  const value = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    dependencies?: unknown;
  };
  if (typeof value.name !== "string" || value.name.length === 0 || typeof value.version !== "string" || value.version.length === 0) {
    throw new ReviewLspError("PROFILE_INVALID", "package.json lacks package name/version required for artifact identity");
  }
  const dependencies = value.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new ReviewLspError("PROFILE_INVALID", "package.json dependencies are required for artifact identity");
  }
  const normalized: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || version.length === 0) {
      throw new ReviewLspError("PROFILE_INVALID", `dependency ${name} has no exact version string`);
    }
    normalized[name] = version;
  }
  return { name: value.name, version: value.version, dependencies: normalized };
}

async function entryFor(packageRoot: string, path: string): Promise<ArtifactManifestEntry> {
  const bytes = await readFile(join(packageRoot, path));
  return { path, sha256: sha256(bytes), byte_count: bytes.byteLength };
}

export async function buildArtifactManifest(packageRootInput: string): Promise<ArtifactManifest> {
  const packageRoot = resolve(packageRootInput);
  const metadata = await packageMetadata(packageRoot);
  const tsls = metadata.dependencies["typescript-language-server"];
  const typescript = metadata.dependencies.typescript;
  if (!tsls || !typescript) {
    throw new ReviewLspError("PROFILE_INVALID", "TypeScript semantic toolchain dependencies must be pinned in package.json");
  }

  const files = await Promise.all([
    entryFor(packageRoot, "package.json"),
    entryFor(packageRoot, PROVIDER_ENTRYPOINT),
    entryFor(packageRoot, TYPESCRIPT_SERVER_BUNDLE),
    entryFor(packageRoot, TYPESCRIPT_SERVER_PACKAGE_JSON),
  ]);
  const stable = {
    schema_version: ARTIFACT_MANIFEST_SCHEMA,
    package_name: metadata.name,
    package_version: metadata.version,
    identity_scope: "provider_bundle_server_bundle_and_package_json" as const,
    provider_entrypoint: PROVIDER_ENTRYPOINT,
    semantic_toolchain: [
      { name: "typescript-language-server" as const, version: tsls },
      { name: "typescript" as const, version: typescript },
    ] as ArtifactManifest["semantic_toolchain"],
    files,
  };
  const artifactSha256 = sha256(canonicalJson(stable));
  return {
    ...stable,
    artifact_sha256: artifactSha256,
    artifact_id: `art_${artifactSha256.slice(0, 32)}`,
  };
}

export async function verifyArtifactManifest(packageRootInput: string, manifest: ArtifactManifest): Promise<void> {
  const packageRoot = resolve(packageRootInput);
  if (manifest.schema_version !== ARTIFACT_MANIFEST_SCHEMA) {
    throw new ReviewLspError("PROFILE_INVALID", `unsupported artifact manifest schema: ${String(manifest.schema_version)}`);
  }
  const expected = await buildArtifactManifest(packageRoot);
  if (canonicalJson(expected) !== canonicalJson(manifest)) {
    throw new ReviewLspError("PROFILE_INVALID", "provider bundle/package metadata does not match artifact manifest");
  }
}

export async function loadAndVerifyArtifactManifest(packageRootInput: string): Promise<ArtifactManifest> {
  const packageRoot = resolve(packageRootInput);
  const manifest = JSON.parse(await readFile(join(packageRoot, "dist", "review-lsp-artifact.json"), "utf8")) as ArtifactManifest;
  await verifyArtifactManifest(packageRoot, manifest);
  return manifest;
}
