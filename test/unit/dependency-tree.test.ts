import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanDependencyTree } from "../../src/core/dependency-tree.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * Builds a tree shaped like a pnpm projection: a virtual store, relative links into it, and
 * a workspace link. No package manager or populated store is needed to exercise the sealing
 * and containment rules.
 */
async function projection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-deptree-"));
  roots.push(root);
  const virtual = join(root, "node_modules", ".pnpm", "is-number@7.0.0", "node_modules", "is-number");
  await mkdir(virtual, { recursive: true });
  await writeFile(join(virtual, "package.json"), '{"name":"is-number","version":"7.0.0"}\n');
  await writeFile(join(virtual, "index.js"), "module.exports = () => true;\n");
  await symlink("./.pnpm/is-number@7.0.0/node_modules/is-number", join(root, "node_modules", "is-number"));
  return root;
}

describe("dependency tree scanning", () => {
  it("digests files, directories and symlink targets", async () => {
    const root = await projection();
    const scan = await scanDependencyTree(root);

    expect(scan.file_count).toBe(2);
    expect(scan.symlink_count).toBe(1);
    expect(scan.total_bytes).toBeGreaterThan(0);
    expect(scan.tree_manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(scan.entries.some((entry) => entry.kind === "symlink" && entry.symlink_target?.includes(".pnpm"))).toBe(true);
    expect(scan.multiply_linked).toEqual([]);
  });

  it("produces a different manifest when any byte changes", async () => {
    const root = await projection();
    const before = await scanDependencyTree(root);

    const target = join(root, "node_modules", ".pnpm", "is-number@7.0.0", "node_modules", "is-number", "index.js");
    await writeFile(target, "module.exports = () => false;\n");
    const after = await scanDependencyTree(root);

    expect(after.tree_manifest_sha256).not.toBe(before.tree_manifest_sha256);
  });

  it("produces a different manifest when a symlink is repointed", async () => {
    const root = await projection();
    const before = await scanDependencyTree(root);

    const link = join(root, "node_modules", "is-number");
    await rm(link);
    await symlink("./.pnpm", link);
    const after = await scanDependencyTree(root);

    expect(after.tree_manifest_sha256).not.toBe(before.tree_manifest_sha256);
  });

  it("refuses a symlink that resolves outside the dependency root", async () => {
    const root = await projection();
    await symlink("../../../../etc", join(root, "node_modules", "escape"));
    await expect(scanDependencyTree(root)).rejects.toThrow(/DEPENDENCY_SNAPSHOT_ESCAPED/);
  });

  it("refuses an absolute symlink target outside the root", async () => {
    const root = await projection();
    await symlink("/etc/hosts", join(root, "node_modules", "absolute"));
    await expect(scanDependencyTree(root)).rejects.toThrow(/DEPENDENCY_SNAPSHOT_ESCAPED/);
  });

  it("reports hard-linked files, which must never appear in an admitted snapshot", async () => {
    const root = await projection();
    const shared = join(root, "shared.txt");
    await writeFile(shared, "shared bytes\n");
    await link(shared, join(root, "node_modules", "aliased.txt"));

    const scan = await scanDependencyTree(root);

    // A hard link aliases the snapshot to state it does not bind: a write through any other
    // alias would change admitted bytes without touching the snapshot.
    expect(scan.multiply_linked.length).toBeGreaterThan(0);
  });
});
