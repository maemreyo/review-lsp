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
import { catFileBatch, GIT_ENV } from "./git-batch.js";
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
        ...GIT_ENV,
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

interface ListedEntry {
  path: string;
  mode: string;
  oid: string;
  kind: "file" | "symlink";
  /** Size as declared by `git ls-tree -l`, observed independently of the object payload. */
  declaredSize: number;
}

function parseTreeListing(listing: string, limits: Required<CandidatePreparationLimits>): ListedEntry[] {
  const records = listing.split("\0").filter(Boolean);
  if (records.length > limits.max_entries) {
    throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate has ${records.length} entries; limit is ${limits.max_entries}`);
  }
  const listed: ListedEntry[] = [];
  const caseKeys = new Map<string, string>();
  let totalBytes = 0;

  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new ReviewLspError("CANDIDATE_UNSUPPORTED", "git ls-tree record lacks a path separator");
    // `-l` right-aligns the size field, so collapse the run of separating spaces.
    const meta = record.slice(0, tab).split(" ").filter(Boolean);
    const path = validatedPath(record.slice(tab + 1));
    const [mode, type, oid, rawSize] = meta;
    if (!mode || !type || !oid || !rawSize) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `invalid git ls-tree metadata for ${path}`);
    }
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
    if (!/^[0-9]+$/.test(rawSize)) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `invalid blob size for ${path}`);
    }
    const declaredSize = Number(rawSize);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `invalid blob size for ${path}`);
    }
    if (declaredSize > limits.max_file_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate file ${path} is ${declaredSize} bytes; limit is ${limits.max_file_bytes}`);
    }
    totalBytes += declaredSize;
    if (totalBytes > limits.max_total_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate tracked bytes exceed ${limits.max_total_bytes}`);
    }

    listed.push({ path, mode, oid, kind: mode === "120000" ? "symlink" : "file", declaredSize });
  }

  return listed;
}

async function rawEntries(
  repo: string,
  commitOid: string,
  limits: Required<CandidatePreparationLimits>,
): Promise<RawEntry[]> {
  // One tree enumeration and one object stream, instead of two `git cat-file` processes per
  // blob. Every rejection rule below is evaluated on the same values as before; the size
  // cross-check gains a third independent observation rather than losing one.
  const listing = await git(repo, ["ls-tree", "-rz", "-r", "-l", "--full-tree", commitOid]);
  const listed = parseTreeListing(listing.toString("utf8"), limits);

  // Identical OIDs are identical bytes, so a repository that stores the same blob at many
  // paths is read once; each path still cross-checks its own declared size against it.
  const requested = [...new Set(listed.map((entry) => entry.oid))];
  const payloads = new Map<string, { headerSize: number; bytes: Buffer }>();
  await catFileBatch(repo, requested, ({ oid, headerSize, bytes }) => {
    payloads.set(oid, { headerSize, bytes });
  });

  const result: RawEntry[] = [];
  for (const entry of listed) {
    const payload = payloads.get(entry.oid);
    if (!payload) {
      throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `git object ${entry.oid} for ${entry.path} was not returned`);
    }
    if (entry.declaredSize !== payload.headerSize || payload.headerSize !== payload.bytes.byteLength) {
      throw new ReviewLspError(
        "CANDIDATE_INTEGRITY_INVALID",
        `blob size disagreement for ${entry.path}: tree=${entry.declaredSize} header=${payload.headerSize} payload=${payload.bytes.byteLength}`,
      );
    }
    if (entry.kind !== "symlink" && payload.bytes.subarray(0, 200).toString("utf8").startsWith(LFS_PREFIX)) {
      throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `unresolved Git LFS pointer at ${entry.path}`);
    }
    result.push({ path: entry.path, mode: entry.mode, oid: entry.oid, kind: entry.kind, bytes: payload.bytes });
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

/**
 * Maps an exact (repository, commit) pair to a previously retained candidate.
 *
 * A commit OID fixes its tree, which fixes every path, mode and blob OID, which fixes the
 * manifest and therefore the content-addressed candidate identity. That makes the lookup a
 * sound shortcut past re-reading every blob — but only a shortcut: the retained candidate is
 * still fully verified, and its manifest is still re-checked against the caller's limits,
 * before it can be used.
 */
function retainedIndexPath(stateDirectory: string, repositoryIdentity: string, commitOid: string): string {
  return join(stateDirectory, "candidates", "index", `${repositoryIdentity}-${commitOid}.json`);
}

function assertManifestWithinLimits(entries: CandidateEntry[], limits: Required<CandidatePreparationLimits>): void {
  if (entries.length > limits.max_entries) {
    throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate has ${entries.length} entries; limit is ${limits.max_entries}`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.byte_count > limits.max_file_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate file ${entry.path} is ${entry.byte_count} bytes; limit is ${limits.max_file_bytes}`);
    }
    totalBytes += entry.byte_count;
    if (totalBytes > limits.max_total_bytes) {
      throw new ReviewLspError("CANDIDATE_RESOURCE_LIMIT", `candidate tracked bytes exceed ${limits.max_total_bytes}`);
    }
  }
}

async function loadRetainedCandidate(
  stateDirectory: string,
  repositoryIdentity: string,
  commitOid: string,
  treeOid: string,
  objectFormat: string,
  limits: Required<CandidatePreparationLimits>,
): Promise<CandidateDescriptor | undefined> {
  let candidateId: string;
  try {
    const index = JSON.parse(await readFile(retainedIndexPath(stateDirectory, repositoryIdentity, commitOid), "utf8")) as {
      candidate_id?: unknown;
    };
    if (typeof index.candidate_id !== "string" || !/^cand_[0-9a-f]{32}$/.test(index.candidate_id)) return undefined;
    candidateId = index.candidate_id;
  } catch {
    return undefined;
  }

  let descriptor: CandidateDescriptor;
  try {
    descriptor = JSON.parse(await readFile(join(stateDirectory, "candidates", candidateId, "candidate.json"), "utf8")) as CandidateDescriptor;
  } catch {
    return undefined;
  }

  // A stale or rewritten index must never widen what counts as the requested candidate.
  if (
    descriptor.candidate_id !== candidateId ||
    descriptor.commit_oid !== commitOid ||
    descriptor.tree_oid !== treeOid ||
    descriptor.repository_identity !== repositoryIdentity ||
    descriptor.git_object_format !== objectFormat ||
    descriptor.schema_version !== "review-lsp.candidate.v1" ||
    !Array.isArray(descriptor.entries)
  ) {
    return undefined;
  }

  assertManifestWithinLimits(descriptor.entries, limits);
  await verifyCandidateIntegrity(descriptor);
  return descriptor;
}

async function writeRetainedIndex(
  stateDirectory: string,
  repositoryIdentity: string,
  commitOid: string,
  candidateId: string,
): Promise<void> {
  const path = retainedIndexPath(stateDirectory, repositoryIdentity, commitOid);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify({
    schema_version: "review-lsp.candidate-index.v1",
    repository_identity: repositoryIdentity,
    commit_oid: commitOid,
    candidate_id: candidateId,
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
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
  const repositoryIdentity = sha256(canonicalJson({ git_dir: gitDir, object_format: objectFormat }));
  const retained = await loadRetainedCandidate(input.stateDirectory, repositoryIdentity, commitOid, treeOid, objectFormat, limits);
  if (retained) return retained;

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
    await writeRetainedIndex(input.stateDirectory, repositoryIdentity, commitOid, candidateId);
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
    // Published last: an index entry must never name a candidate that is not fully retained.
    await writeRetainedIndex(input.stateDirectory, repositoryIdentity, commitOid, candidateId);
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
  const stateDirectory = dirname(dirname(candidateDirectory));
  await rm(retainedIndexPath(stateDirectory, candidate.repository_identity, candidate.commit_oid), { force: true }).catch(() => undefined);
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
