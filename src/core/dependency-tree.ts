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

interface FileTask {
  path: string;
  absolute: string;
}

const FILE_HASH_CONCURRENCY = 32;

/**
 * Walks a materialized dependency root and digests it.
 *
 * Directory discovery is deterministic, while regular-file reads are bounded-concurrent. This
 * matters for pnpm trees with tens of thousands of small files: serial open/read/close made a
 * mandatory post-restart full verification take tens of seconds even when the underlying APFS
 * tree was already warm.
 *
 * File contents are still fully hashed, symlinks are still bound by target, and directories
 * still contribute their path. O_NOFOLLOW plus fstat after open prevents a path from being
 * swapped to a symlink between discovery and hashing.
 */
export async function scanDependencyTree(root: string): Promise<DependencyTreeScan> {
  const structuralEntries: DependencyTreeEntry[] = [];
  const fileTasks: FileTask[] = [];
  const directories: string[] = [""];

  for (let cursor = 0; cursor < directories.length; cursor += 1) {
    const relativeDirectory = directories[cursor] ?? "";
    const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
    const names = (await readdir(absoluteDirectory)).sort();

    const children = await Promise.all(names.map(async (name) => {
      const path = relativeDirectory ? join(relativeDirectory, name) : name;
      const absolute = join(root, path);
      return { path, absolute, info: await lstat(absolute) };
    }));

    for (const child of children) {
      if (child.info.isSymbolicLink()) {
        const target = await readlink(child.absolute);
        containedTarget(root, child.path, target);
        structuralEntries.push({
          path: child.path,
          kind: "symlink",
          symlink_target: target,
          sha256: sha256(target),
        });
        continue;
      }

      if (child.info.isDirectory()) {
        structuralEntries.push({ path: child.path, kind: "directory" });
        directories.push(child.path);
        continue;
      }

      if (!child.info.isFile()) {
        throw new ReviewLspError(
          "DEPENDENCY_SNAPSHOT_INVALID",
          `${child.path} is neither a regular file, directory nor symlink`,
        );
      }

      fileTasks.push({ path: child.path, absolute: child.absolute });
    }
  }

  const fileEntries = new Array<DependencyTreeEntry>(fileTasks.length);
  const multiplyLinked: string[] = [];
  let nextFile = 0;

  async function hashWorker(): Promise<void> {
    while (true) {
      const index = nextFile;
      nextFile += 1;
      if (index >= fileTasks.length) return;
      const task = fileTasks[index];
      if (!task) return;

      const handle = await open(task.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedInfo = await handle.stat();
        if (!openedInfo.isFile()) {
          throw new ReviewLspError(
            "DEPENDENCY_SNAPSHOT_INVALID",
            `${task.path} stopped being a regular file before hashing`,
          );
        }
        const bytes = await handle.readFile();
        if (openedInfo.nlink > 1) multiplyLinked.push(task.path);
        fileEntries[index] = {
          path: task.path,
          kind: "file",
          sha256: sha256(bytes),
          byte_count: bytes.byteLength,
          executable: (openedInfo.mode & 0o111) !== 0,
        };
      } finally {
        await handle.close();
      }
    }
  }

  const workerCount = Math.min(FILE_HASH_CONCURRENCY, Math.max(1, fileTasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => hashWorker()));

  const entries = [...structuralEntries, ...fileEntries];
  entries.sort((a, b) => a.path.localeCompare(b.path));
  multiplyLinked.sort();

  let totalBytes = 0;
  for (const entry of fileEntries) {
    if (entry.kind === "file") totalBytes += entry.byte_count ?? 0;
  }

  return {
    entries,
    tree_manifest_sha256: sha256(canonicalJson(entries)),
    file_count: fileEntries.length,
    symlink_count: structuralEntries.filter((entry) => entry.kind === "symlink").length,
    total_bytes: totalBytes,
    multiply_linked: multiplyLinked,
  };
}
