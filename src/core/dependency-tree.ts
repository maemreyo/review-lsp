import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { DependencyTreeEntry } from "./types.js";

/**
 * Walking, containment-checking and digesting a materialized dependency tree.
 *
 * Kept separate from the package-manager integration so the sealing and verification rules
 * can be exercised against a synthetic tree, without needing a populated package store.
 */

/**
 * Rejects a symlink whose target leaves the dependency root.
 *
 * pnpm projections are dense with symlinks — a real workspace install produced roughly 1,500 —
 * and they are legitimate: a package links into `node_modules/.pnpm`, a workspace dependency
 * links to its package directory. What must never happen is a link resolving outside the
 * admitted root, because the snapshot would then depend on bytes it does not bind.
 */
function containedTarget(root: string, linkPath: string, target: string): string {
  if (target.includes("\0")) {
    throw new ReviewLspError("DEPENDENCY_SNAPSHOT_INVALID", `symlink ${linkPath} has an invalid target`);
  }
  const absolute = isAbsolute(target) ? normalize(target) : normalize(join(root, linkPath, "..", target));
  const delta = relative(root, absolute);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new ReviewLspError(
      "DEPENDENCY_SNAPSHOT_ESCAPED",
      `symlink ${linkPath} resolves to ${JSON.stringify(absolute)}, outside the dependency root`,
    );
  }
  return delta;
}

export interface DependencyTreeScan {
  entries: DependencyTreeEntry[];
  tree_manifest_sha256: string;
  file_count: number;
  symlink_count: number;
  total_bytes: number;
  /** Regular files with more than one hard link, which must be zero in an admitted snapshot. */
  multiply_linked: string[];
}

/**
 * Walks a materialized dependency root and digests it.
 *
 * File contents are hashed, symlinks are bound by target, and directories contribute their
 * path so that an added or removed empty directory still changes the manifest.
 */
export async function scanDependencyTree(root: string): Promise<DependencyTreeScan> {
  const entries: DependencyTreeEntry[] = [];
  const multiplyLinked: string[] = [];
  let fileCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;

  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(root, relativePath) : root;
    const info = await lstat(absolute);

    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      containedTarget(root, relativePath, target);
      symlinkCount += 1;
      entries.push({ path: relativePath, kind: "symlink", symlink_target: target, sha256: sha256(target) });
      return;
    }

    if (info.isDirectory()) {
      if (relativePath) entries.push({ path: relativePath, kind: "directory" });
      for (const name of (await readdir(absolute)).sort()) {
        await visit(relativePath ? join(relativePath, name) : name);
      }
      return;
    }

    if (!info.isFile()) {
      throw new ReviewLspError(
        "DEPENDENCY_SNAPSHOT_INVALID",
        `${relativePath} is neither a regular file, directory nor symlink`,
      );
    }

    // A hard link would alias the snapshot to mutable state elsewhere: a later write through
    // any other alias would change admitted bytes without touching the snapshot.
    if (info.nlink > 1) multiplyLinked.push(relativePath);

    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      fileCount += 1;
      totalBytes += bytes.byteLength;
      entries.push({
        path: relativePath,
        kind: "file",
        sha256: sha256(bytes),
        byte_count: bytes.byteLength,
        executable: (info.mode & 0o111) !== 0,
      });
    } finally {
      await handle.close();
    }
  }

  await visit("");
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    entries,
    tree_manifest_sha256: sha256(canonicalJson(entries)),
    file_count: fileCount,
    symlink_count: symlinkCount,
    total_bytes: totalBytes,
    multiply_linked: multiplyLinked,
  };
}
