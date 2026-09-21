import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";

interface TreeMetadataEntry {
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
  symlink_target?: string;
}

function metadataEntry(
  path: string,
  info: BigIntStats,
  symlinkTarget?: string,
): TreeMetadataEntry {
  const kind = info.isDirectory()
    ? "directory" as const
    : info.isFile()
      ? "file" as const
      : info.isSymbolicLink()
        ? "symlink" as const
        : "other" as const;
  return {
    path,
    kind,
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    mode: info.mode.toString(),
    nlink: info.nlink.toString(),
    size: info.size.toString(),
    mtime_ns: info.mtimeNs.toString(),
    ctime_ns: info.ctimeNs.toString(),
    ...(symlinkTarget === undefined ? {} : { symlink_target: symlinkTarget }),
  };
}

/**
 * Cheap process-local lease invalidation fingerprint.
 *
 * This deliberately does not hash file contents. A successful full verifier establishes the
 * content-addressed tree once; later live-lease checks walk only filesystem metadata. In-place
 * writes change ctime even when a caller restores size, mode and mtime, while replacement,
 * rename, link and symlink changes alter inode/directory/link metadata. Any metadata drift
 * invalidates the lease and forces the caller back through its full content verifier.
 */
export async function treeMetadataFingerprint(root: string): Promise<string> {
  const rootInfo = await lstat(root, { bigint: true });
  const entries: TreeMetadataEntry[] = [metadataEntry("", rootInfo)];
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return sha256(canonicalJson(entries));
  }

  const directories: string[] = [""];
  for (let cursor = 0; cursor < directories.length; cursor += 1) {
    const relativeDirectory = directories[cursor] ?? "";
    const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
    const names = (await readdir(absoluteDirectory)).sort();
    const children = await Promise.all(names.map(async (name) => {
      const relativePath = relativeDirectory ? join(relativeDirectory, name) : name;
      const absolutePath = join(root, relativePath);
      const info = await lstat(absolutePath, { bigint: true });
      const symlinkTarget = info.isSymbolicLink() ? await readlink(absolutePath) : undefined;
      return { relativePath, info, symlinkTarget };
    }));

    for (const child of children) {
      entries.push(metadataEntry(child.relativePath, child.info, child.symlinkTarget));
      if (child.info.isDirectory() && !child.info.isSymbolicLink()) directories.push(child.relativePath);
    }
  }

  return sha256(canonicalJson(entries));
}
