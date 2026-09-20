import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runEntryPointGate } from "../../src/core/entry-points.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function workspace(packages: Record<string, { manifest: unknown; files?: Record<string, string> }>): Promise<{
  root: string;
  manifests: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-entrypoints-"));
  roots.push(root);
  const manifests: string[] = [];
  for (const [name, spec] of Object.entries(packages)) {
    const packageRoot = join(root, name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(spec.manifest, null, 2)}\n`);
    manifests.push(join(name, "package.json"));
    for (const [file, body] of Object.entries(spec.files ?? {})) {
      const target = join(packageRoot, file);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, body);
    }
  }
  return { root, manifests };
}

async function run(root: string, manifests: string[]) {
  return runEntryPointGate({
    projectionRoot: root,
    workspaceManifests: manifests,
    readManifest: async (relativePath) => (await import("node:fs/promises")).readFile(join(root, relativePath), "utf8"),
  });
}

describe("workspace entry-point resolvability gate", () => {
  it("accepts a package whose declared types target exists", async () => {
    const { root, manifests } = await workspace({
      "packages/provider": {
        manifest: { name: "@fixture/provider", types: "./dist/index.d.ts" },
        files: { "dist/index.d.ts": "export declare const provider: number;\n" },
      },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("COMPLETE");
    expect(result.findings).toEqual([]);
  });

  it("refuses a package whose declared types target is build output that is absent", async () => {
    // The case this gate exists for: `dist/` is gitignored, so it is not candidate material
    // and no install produces it. The package links correctly and resolves to nothing.
    const { root, manifests } = await workspace({
      "packages/provider": {
        manifest: { name: "@fixture/provider", types: "./dist/index.d.ts" },
        files: { "src/index.ts": "export const provider = 1;\n" },
      },
    });
    const result = await run(root, manifests);

    expect(result.state).toBe("INCOMPLETE");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.package_name).toBe("@fixture/provider");
    expect(result.findings[0]?.field).toBe("types");
    expect(result.findings[0]?.declared_target).toBe("./dist/index.d.ts");
    expect(result.findings[0]?.limitation).toMatch(/absent from the projection/);
  });

  it("keeps a script-requiring package incomplete instead of executing its lifecycle build", async () => {
    const { root, manifests } = await workspace({
      "packages/generated": {
        manifest: {
          name: "@fixture/generated",
          types: "./dist/index.d.ts",
          scripts: { prepare: "node generate-types.js" },
        },
        files: {
          "src/index.ts": "export const generated = 1;\n",
          "generate-types.js": "throw new Error('must never execute');\n",
        },
      },
    });

    const result = await run(root, manifests);
    expect(result.state).toBe("INCOMPLETE");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.declared_target).toBe("./dist/index.d.ts");
    expect(result.findings[0]?.limitation).toMatch(/absent from the projection/);
  });

  it("checks exports type conditions", async () => {
    const { root, manifests } = await workspace({
      "packages/a": {
        manifest: { name: "@fixture/a", exports: { ".": { types: "./dist/a.d.ts", import: "./dist/a.js" } } },
        files: { "dist/a.js": "export const a = 1;\n" },
      },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("INCOMPLETE");
    expect(result.findings[0]?.field).toBe("exports[.].types");
  });

  it("fails closed when wildcard exports select unprovable generated targets", async () => {
    const { root, manifests } = await workspace({
      "packages/wild": {
        manifest: {
          name: "@fixture/wild",
          exports: {
            "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
          },
        },
        files: { "src/a.ts": "export const a = 1;\n" },
      },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("INCOMPLETE");
    expect(result.targets_checked).toBe(1);
    expect(result.findings[0]?.field).toBe("exports[./*].types");
    expect(result.findings[0]?.declared_target).toBe("./dist/*.d.ts");
  });

  it("accepts a wildcard export when it maps to one concrete admitted target", async () => {
    const { root, manifests } = await workspace({
      "packages/wild": {
        manifest: {
          name: "@fixture/wild",
          exports: {
            "./*": { types: "./dist/index.d.ts" },
          },
        },
        files: { "dist/index.d.ts": "export declare const value: number;\n" },
      },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("COMPLETE");
    expect(result.targets_checked).toBe(1);
  });

  it("resolves extensionless and directory targets the way a resolver would", async () => {
    const { root, manifests } = await workspace({
      "packages/ext": {
        manifest: { name: "@fixture/ext", types: "./src/index" },
        files: { "src/index.d.ts": "export declare const value: number;\n" },
      },
      "packages/dir": {
        manifest: { name: "@fixture/dir", main: "./lib" },
        files: { "lib/index.js": "module.exports = 1;\n" },
      },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("COMPLETE");
  });

  it("refuses a target that reaches outside its own package", async () => {
    const { root, manifests } = await workspace({
      "packages/escape": {
        manifest: { name: "@fixture/escape", types: "../../outside/index.d.ts" },
      },
    });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "index.d.ts"), "export declare const x: number;\n");

    const result = await run(root, manifests);
    expect(result.state).toBe("INCOMPLETE");
  });

  it("does not fault a package that declares no type-bearing entry point", async () => {
    const { root, manifests } = await workspace({
      "packages/plain": { manifest: { name: "@fixture/plain", private: true } },
    });
    const result = await run(root, manifests);
    expect(result.state).toBe("COMPLETE");
    expect(result.targets_checked).toBe(0);
  });
});
