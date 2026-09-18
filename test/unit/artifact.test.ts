import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildArtifactManifest, verifyArtifactManifest } from "../../src/core/artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact manifest", () => {
  it("binds the bundled provider, package metadata, and semantic toolchain contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-artifact-"));
    roots.push(root);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "review-lsp",
      version: "0.1.0-alpha.1",
      dependencies: {
        "typescript-language-server": "6.0.0",
        typescript: "6.0.3",
      },
    }));
    await writeFile(join(root, "dist", "review-lsp.mjs"), "#!/usr/bin/env node\nconsole.log('provider');\n");

    const manifest = await buildArtifactManifest(root);
    expect(manifest.identity_scope).toBe("provider_bundle_and_package_json");
    expect(manifest.provider_entrypoint).toBe("dist/review-lsp.mjs");
    expect(manifest.semantic_toolchain).toEqual([
      { name: "typescript-language-server", version: "6.0.0" },
      { name: "typescript", version: "6.0.3" },
    ]);
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      "package.json",
      "dist/review-lsp.mjs",
    ]);
    await expect(verifyArtifactManifest(root, manifest)).resolves.toBeUndefined();

    await writeFile(join(root, "dist", "review-lsp.mjs"), "#!/usr/bin/env node\nconsole.log('mutated');\n");
    await expect(verifyArtifactManifest(root, manifest)).rejects.toMatchObject({ code: "PROFILE_INVALID" });
  });

  it("invalidates the artifact when the semantic toolchain contract changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-artifact-toolchain-"));
    roots.push(root);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "review-lsp",
      version: "0.1.0-alpha.1",
      dependencies: {
        "typescript-language-server": "6.0.0",
        typescript: "6.0.3",
      },
    }));
    await writeFile(join(root, "dist", "review-lsp.mjs"), "#!/usr/bin/env node\n");

    const manifest = await buildArtifactManifest(root);
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "review-lsp",
      version: "0.1.0-alpha.1",
      dependencies: {
        "typescript-language-server": "6.0.0",
        typescript: "6.0.4",
      },
    }));
    await expect(verifyArtifactManifest(root, manifest)).rejects.toMatchObject({ code: "PROFILE_INVALID" });
  });
});
