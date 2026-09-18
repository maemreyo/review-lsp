import { createRequire } from "node:module";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { TypeScriptProfile } from "./types.js";

const require = createRequire(import.meta.url);

function stableProfile(profile: Omit<TypeScriptProfile, "profile_id" | "profile_sha256"> | TypeScriptProfile): unknown {
  const { profile_id: _profileId, profile_sha256: _profileSha256, ...stable } = profile as TypeScriptProfile;
  return stable;
}

async function digestTree(root: string): Promise<string> {
  const records: Array<{ path: string; kind: "file" | "symlink"; sha256: string; bytes?: number; target?: string }> = [];

  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const info = await stat(absolute, { bigint: false });
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        records.push({
          path: relative(root, absolute),
          kind: "file",
          sha256: sha256(bytes),
          bytes: bytes.byteLength,
        });
      }
    }
  }

  await visit(root);
  return sha256(canonicalJson(records));
}

export async function createTypeScriptProfile(): Promise<TypeScriptProfile> {
  const nodeExecutable = await realpath(process.execPath);
  const nodeExecutableSha256 = sha256(await readFile(nodeExecutable));

  const serverPackageJson = require.resolve("typescript-language-server/package.json");
  const serverRoot = await realpath(dirname(serverPackageJson));
  const serverPackage = JSON.parse(await readFile(serverPackageJson, "utf8")) as { version?: unknown };
  if (typeof serverPackage.version !== "string") {
    throw new ReviewLspError("PROFILE_INVALID", "typescript-language-server package version is missing");
  }
  const serverEntrypoint = join(serverRoot, "lib", "cli.mjs");
  const serverEntrypointSha256 = sha256(await readFile(serverEntrypoint));
  const serverPackageSha256 = await digestTree(serverRoot);

  const typescriptPackageJson = require.resolve("typescript/package.json");
  const typescriptRoot = await realpath(dirname(typescriptPackageJson));
  const typescriptPackage = JSON.parse(await readFile(typescriptPackageJson, "utf8")) as { version?: unknown };
  if (typeof typescriptPackage.version !== "string") {
    throw new ReviewLspError("PROFILE_INVALID", "TypeScript package version is missing");
  }
  const tsserverPath = join(typescriptRoot, "lib", "tsserver.js");
  try {
    await stat(tsserverPath);
  } catch {
    throw new ReviewLspError(
      "PROFILE_INVALID",
      `TypeScript ${typescriptPackage.version} does not expose lib/tsserver.js required by the v0.1 profile`,
    );
  }
  const typescriptPackageSha256 = await digestTree(typescriptRoot);

  const stable = {
    schema_version: "review-lsp.profile.typescript.v1" as const,
    language_id: "typescript" as const,
    extensions: [".ts", ".tsx"] as [".ts", ".tsx"],
    node_executable: nodeExecutable,
    node_executable_sha256: nodeExecutableSha256,
    server_entrypoint: serverEntrypoint,
    server_entrypoint_sha256: serverEntrypointSha256,
    server_package_version: serverPackage.version,
    server_package_sha256: serverPackageSha256,
    typescript_root: typescriptRoot,
    typescript_version: typescriptPackage.version,
    typescript_package_sha256: typescriptPackageSha256,
    args: ["--stdio"] as ["--stdio"],
    initialization_options: {
      disableAutomaticTypingAcquisition: true as const,
      plugins: [] as [],
      tsserver: {
        path: typescriptRoot,
        fallbackPath: typescriptRoot,
        logVerbosity: "off" as const,
        useSyntaxServer: "never" as const,
      },
    },
    environment_allowlist: ["PATH", "HOME", "TMPDIR"],
    document_limit_bytes: 4 * 1024 * 1024,
    result_limit_bytes: 4 * 1024 * 1024,
  };
  const profileSha256 = sha256(canonicalJson(stableProfile(stable)));
  return {
    ...stable,
    profile_id: contentId("prof", stableProfile(stable)),
    profile_sha256: profileSha256,
  };
}

export async function verifyTypeScriptProfile(profile: TypeScriptProfile): Promise<void> {
  const stable = stableProfile(profile);
  if (sha256(canonicalJson(stable)) !== profile.profile_sha256 || contentId("prof", stable) !== profile.profile_id) {
    throw new ReviewLspError("PROFILE_INVALID", "profile content-addressed identity does not match profile fields");
  }
  if (!Number.isSafeInteger(profile.document_limit_bytes) || profile.document_limit_bytes <= 0
    || !Number.isSafeInteger(profile.result_limit_bytes) || profile.result_limit_bytes <= 0) {
    throw new ReviewLspError("PROFILE_INVALID", "profile resource limits must be positive safe integers");
  }
  const observedNode = sha256(await readFile(profile.node_executable));
  const observedServer = sha256(await readFile(profile.server_entrypoint));
  if (observedNode !== profile.node_executable_sha256) {
    throw new ReviewLspError("PROFILE_INVALID", "Node executable digest changed after profile admission");
  }
  if (observedServer !== profile.server_entrypoint_sha256) {
    throw new ReviewLspError("PROFILE_INVALID", "TypeScript language server entrypoint digest changed after profile admission");
  }
  const serverRoot = await realpath(dirname(dirname(profile.server_entrypoint)));
  const typescriptRoot = await realpath(profile.typescript_root);
  if (await digestTree(serverRoot) !== profile.server_package_sha256) {
    throw new ReviewLspError("PROFILE_INVALID", "TypeScript language server package bytes changed after profile admission");
  }
  if (await digestTree(typescriptRoot) !== profile.typescript_package_sha256) {
    throw new ReviewLspError("PROFILE_INVALID", "TypeScript package bytes changed after profile admission");
  }
}
