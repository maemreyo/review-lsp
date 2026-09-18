import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { canonicalJson, contentId, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type { CandidateDescriptor, CandidateEntry } from "./types.js";

const execFileAsync = promisify(execFile);
const LFS_PREFIX = "version https://git-lfs.github.com/spec/v1";
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface CandidatePreparationLimits {
  max_entries?: number;
  max_file_bytes?: number;
  max_total_bytes?: number;
}

interface RawEntry {
  path: string;
  mode: string;
  oid: string;
  kind: "file" | "symlink";
  bytes: Buffer;
}

async function git(repo: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReviewLspError("GIT_COMMAND_FAILED", `git ${args.join(" ")} failed: ${detail}`);
  }
}

function validatedPath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `invalid Git path ${JSON.stringify(path)}`);
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || normalized === "." || normalized !== path) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `non-canonical Git path ${JSON.stringify(path)}`);
  }
  return path;
}

function targetPath(linkPath: string, target: string): string {
  if (!target || target.includes("\0") || isAbsolute(target)) {
    throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `symlink ${linkPath} has unsupported target ${JSON.stringify(target)}`);
  }
  const rootRelative = normalize(join(dirname(linkPath), target));
  if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
    throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `symlink ${linkPath} escapes candidate root`);
  }
  return rootRelative;
}

function validateSymlinks(entries: RawEntry[]): void {
  const paths = new Set(entries.map((entry) => entry.path));
  const linkTargets = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    const target = entry.bytes.toString("utf8");
    const resolved = targetPath(entry.path, target);
    const targetExists = paths.has(resolved) || entries.some((candidate) => candidate.path.startsWith(`${resolved}/`));
    if (!targetExists) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `symlink ${entry.path} points to missing candidate path ${JSON.stringify(resolved)}`);
    }
    linkTargets.set(entry.path, resolved);
  }

  for (const start of linkTargets.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current && linkTargets.has(current)) {
      if (seen.has(current)) {
        throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `symlink cycle detected from ${start}`);
      }
      seen.add(current);
      current = linkTargets.get(current);
    }
  }
}

async function rawEntries(
  repo: string,
  commitOid: string,
  limits: Required<CandidatePreparationLimits>,
): Promise<RawEntry[]> {
  const listing = await git(repo, ["ls-tree", "-rz", "-r", "--full-tree", commitOid]);
  const records = listing.toString("utf8").split("\0").filter(Boolean);
  if (records.length > limits.max_entries) {
    throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate has ${records.length} entries; limit is ${limits.max_entries}`);
  }
  const result: RawEntry[] = [];
  const caseKeys = new Map<string, string>();
  let totalBytes = 0;

  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new ReviewLspError("CANDIDATE_UNSUPPORTED", "git ls-tree record lacks a path separator");
    const meta = record.slice(0, tab).split(" ");
    const path = validatedPath(record.slice(tab + 1));
    const [mode, type, oid] = meta;
    if (!mode || !type || !oid) throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `invalid git ls-tree metadata for ${path}`);
    const caseKey = path.toLocaleLowerCase("en-US");
    const prior = caseKeys.get(caseKey);
    if (prior && prior !== path) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `case-colliding Git paths ${JSON.stringify(prior)} and ${JSON.stringify(path)}`);
    }
    caseKeys.set(caseKey, path);

    if (mode === "160000" || type === "commit") {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `submodule entry ${path} is unsupported in v0.1`);
    }
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `unsupported Git entry ${path}: mode=${mode} type=${type}`);
    }
    const byteCount = Number((await git(repo, ["cat-file", "-s", oid])).toString("utf8").trim());
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `invalid blob size for ${path}`);
    }
    if (byteCount > limits.max_file_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate file ${path} is ${byteCount} bytes; limit is ${limits.max_file_bytes}`);
    }
    totalBytes += byteCount;
    if (totalBytes > limits.max_total_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate tracked bytes exceed ${limits.max_total_bytes}`);
    }
    const bytes = await git(repo, ["cat-file", "blob", oid]);
    if (bytes.byteLength !== byteCount) {
      throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `blob size changed while reading ${path}`);
    }
    if (mode !== "120000" && bytes.subarray(0, 200).toString("utf8").startsWith(LFS_PREFIX)) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `unresolved Git LFS pointer at ${path}`);
    }
    result.push({ path, mode, oid, kind: mode === "120000" ? "symlink" : "file", bytes });
  }

  validateSymlinks(result);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function makeReadOnly(root: string, entries: CandidateEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === "file") await chmod(join(root, entry.path), entry.mode === "100755" ? 0o555 : 0o444);
  }
  const directories = new Set<string>([""]);
  for (const entry of entries) {
    let current = dirname(entry.path);
    while (current !== ".") {
      directories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await chmod(directory ? join(root, directory) : root, 0o555);
  }
}

async function materialize(root: string, entries: RawEntry[]): Promise<CandidateEntry[]> {
  const manifest: CandidateEntry[] = entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    oid: entry.oid,
    kind: entry.kind,
    sha256: sha256(entry.bytes),
    byte_count: entry.bytes.byteLength,
    ...(entry.kind === "symlink" ? { symlink_target: entry.bytes.toString("utf8") } : {}),
  }));

  for (const entry of entries.filter((candidate) => candidate.kind === "file")) {
    const output = join(root, entry.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, entry.bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644, flag: "wx" });
  }
  for (const entry of entries.filter((candidate) => candidate.kind === "symlink")) {
    const output = join(root, entry.path);
    await mkdir(dirname(output), { recursive: true });
    await symlink(entry.bytes.toString("utf8"), output);
  }
  await makeReadOnly(root, manifest);
  return manifest;
}

function stableCandidate(candidate: Omit<CandidateDescriptor, "candidate_id" | "prepared_at" | "source_root"> | CandidateDescriptor): unknown {
  return {
    schema_version: candidate.schema_version,
    repository_identity: candidate.repository_identity,
    git_object_format: candidate.git_object_format,
    commit_oid: candidate.commit_oid,
    tree_oid: candidate.tree_oid,
    source_manifest_sha256: candidate.source_manifest_sha256,
    entries: candidate.entries,
    isolation: candidate.isolation,
  };
}

function assertCandidateDescriptorIdentity(candidate: CandidateDescriptor): void {
  const manifestDigest = sha256(canonicalJson(candidate.entries));
  if (manifestDigest !== candidate.source_manifest_sha256) {
    throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", "candidate source manifest digest does not match descriptor entries");
  }
  const expectedId = contentId("cand", stableCandidate(candidate));
  if (expectedId !== candidate.candidate_id) {
    throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", "candidate content-addressed identity does not match descriptor");
  }
}

export async function prepareCandidate(input: {
  repo: string;
  commit: string;
  stateDirectory: string;
  limits?: CandidatePreparationLimits;
}): Promise<CandidateDescriptor> {
  const repo = await realpath(input.repo);
  const gitDirText = (await git(repo, ["rev-parse", "--absolute-git-dir"])).toString("utf8").trim();
  const gitDir = await realpath(gitDirText);
  const objectFormat = (await git(repo, ["rev-parse", "--show-object-format"])).toString("utf8").trim();
  const commitOid = (await git(repo, ["rev-parse", "--verify", `${input.commit}^{commit}`])).toString("utf8").trim();
  const treeOid = (await git(repo, ["rev-parse", "--verify", `${commitOid}^{tree}`])).toString("utf8").trim();
  const limits = {
    max_entries: input.limits?.max_entries ?? DEFAULT_MAX_ENTRIES,
    max_file_bytes: input.limits?.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: input.limits?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `${name} must be a positive safe integer`);
    }
  }
  const entries = await rawEntries(repo, commitOid, limits);
  const manifestEntries: CandidateEntry[] = entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    oid: entry.oid,
    kind: entry.kind,
    sha256: sha256(entry.bytes),
    byte_count: entry.bytes.byteLength,
    ...(entry.kind === "symlink" ? { symlink_target: entry.bytes.toString("utf8") } : {}),
  }));
  const sourceManifestSha256 = sha256(canonicalJson(manifestEntries));
  const repositoryIdentity = sha256(canonicalJson({ git_dir: gitDir, object_format: objectFormat }));
  const stable = {
    schema_version: "review-lsp.candidate.v1" as const,
    repository_identity: repositoryIdentity,
    repository_git_dir: gitDir,
    git_object_format: objectFormat,
    commit_oid: commitOid,
    tree_oid: treeOid,
    source_manifest_sha256: sourceManifestSha256,
    entries: manifestEntries,
    isolation: "TRUSTED_LOCAL" as const,
  };
  const candidateId = contentId("cand", stableCandidate(stable));
  const candidateDirectory = join(input.stateDirectory, "candidates", candidateId);
  const sourceRoot = join(candidateDirectory, "source");
  const descriptorPath = join(candidateDirectory, "candidate.json");

  try {
    const existing = JSON.parse(await readFile(descriptorPath, "utf8")) as CandidateDescriptor;
    if (
      existing.candidate_id !== candidateId ||
      existing.source_manifest_sha256 !== sourceManifestSha256 ||
      existing.commit_oid !== commitOid
    ) {
      throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `stored candidate ${candidateId} does not match requested identity`);
    }
    await verifyCandidateIntegrity(existing);
    return existing;
  } catch (error) {
    if (error instanceof ReviewLspError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(join(input.stateDirectory, "candidates"), { recursive: true, mode: 0o700 });
  const temporary = join(input.stateDirectory, "candidates", `.${candidateId}.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(join(temporary, "source"), { recursive: true, mode: 0o700 });

  try {
    const writtenManifest = await materialize(join(temporary, "source"), entries);
    if (canonicalJson(writtenManifest) !== canonicalJson(manifestEntries)) {
      throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", "materialized candidate manifest changed during preparation");
    }
    const descriptor: CandidateDescriptor = {
      ...stable,
      candidate_id: candidateId,
      source_root: sourceRoot,
      prepared_at: new Date().toISOString(),
    };
    await writeFile(join(temporary, "candidate.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, candidateDirectory);
    await verifyCandidateIntegrity(descriptor);
    return descriptor;
  } catch (error) {
    await chmod(join(temporary, "source"), 0o700).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function observedLeafPaths(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(relativePath: string): Promise<void> {
    const absolute = relativePath ? join(root, relativePath) : root;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      const { readdir } = await import("node:fs/promises");
      for (const name of (await readdir(absolute)).sort()) {
        await visit(relativePath ? join(relativePath, name) : name);
      }
      return;
    }
    result.push(relativePath);
  }
  await visit("");
  return result.sort();
}

export async function verifyCandidateIntegrity(candidate: CandidateDescriptor): Promise<void> {
  assertCandidateDescriptorIdentity(candidate);
  const expected = candidate.entries.map((entry) => entry.path).sort();
  const observed = await observedLeafPaths(candidate.source_root);
  if (canonicalJson(expected) !== canonicalJson(observed)) {
    throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", "candidate path set no longer matches source manifest");
  }

  for (const entry of candidate.entries) {
    const absolute = resolve(candidate.source_root, entry.path);
    const delta = relative(candidate.source_root, absolute);
    if (delta.startsWith("..") || isAbsolute(delta)) {
      throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `candidate path escaped root: ${entry.path}`);
    }
    if (entry.kind === "symlink") {
      const target = await readlink(absolute);
      if (target !== entry.symlink_target || sha256(target) !== entry.sha256) {
        throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `symlink changed: ${entry.path}`);
      }
      targetPath(entry.path, target);
      continue;
    }

    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `candidate entry is not a regular file: ${entry.path}`);
      const bytes = await handle.readFile();
      if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) {
        throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `candidate bytes changed: ${entry.path}`);
      }
    } finally {
      await handle?.close();
    }
  }
}

export async function readCandidateFile(candidate: CandidateDescriptor, path: string): Promise<{ bytes: Buffer; sha256: string }> {
  const relativePath = validatedPath(path);
  const entry = candidate.entries.find((item) => item.path === relativePath);
  if (!entry || entry.kind !== "file") {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `candidate file is not an admitted regular file: ${relativePath}`);
  }
  const bytes = await readFile(join(candidate.source_root, relativePath));
  const digest = sha256(bytes);
  if (digest !== entry.sha256) throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `candidate file changed: ${relativePath}`);
  return { bytes, sha256: digest };
}

async function makeOwnerWritable(root: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const name of await readdir(root)) await makeOwnerWritable(join(root, name));
    return;
  }
  await chmod(root, 0o600);
}

export async function removeCandidate(candidate: CandidateDescriptor): Promise<void> {
  const candidateDirectory = dirname(candidate.source_root);
  await makeOwnerWritable(candidateDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await rm(candidateDirectory, { recursive: true, force: true });
}

export function candidateDescriptorPath(candidate: CandidateDescriptor): string {
  return join(dirname(candidate.source_root), "candidate.json");
}

export async function loadCandidateDescriptor(path: string): Promise<CandidateDescriptor> {
  const candidate = JSON.parse(await readFile(path, "utf8")) as CandidateDescriptor;
  if (candidate.schema_version !== "review-lsp.candidate.v1" || typeof candidate.candidate_id !== "string") {
    throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", "candidate descriptor schema or identity is invalid");
  }
  await verifyCandidateIntegrity(candidate);
  return candidate;
}
