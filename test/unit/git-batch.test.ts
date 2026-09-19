import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { catFileBatch } from "../../src/core/git-batch.js";
import { createGitShim } from "../helpers/git-shim.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function repoWithBlobs(contents: Record<string, string>): Promise<{ repo: string; oids: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), "review-lsp-batch-"));
  roots.push(root);
  const repo = join(root, "repo");
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.name", "Batch Fixture");
  await git(repo, "config", "user.email", "batch@example.invalid");
  for (const [path, body] of Object.entries(contents)) {
    await writeFile(join(repo, path), body);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "batch fixture");

  const listing = await git(repo, "ls-tree", "-r", "--full-tree", "HEAD");
  const oids: Record<string, string> = {};
  for (const row of listing.split("\n").filter(Boolean)) {
    const [meta, path] = row.split("\t") as [string, string];
    oids[path] = meta.split(/\s+/)[2] as string;
  }
  return { repo, oids };
}

describe("git cat-file --batch plumbing", () => {
  it("streams every requested object in request order with exact bytes", async () => {
    const bodies = {
      "a.txt": "alpha\n",
      "b.txt": "beta beta\n",
      "c.txt": `${"x".repeat(5000)}\n`,
    };
    const { repo, oids } = await repoWithBlobs(bodies);
    const requested = [oids["a.txt"], oids["b.txt"], oids["c.txt"]] as string[];

    const received: { oid: string; headerSize: number; text: string }[] = [];
    await catFileBatch(repo, requested, (blob) => {
      received.push({ oid: blob.oid, headerSize: blob.headerSize, text: blob.bytes.toString("utf8") });
    });

    expect(received.map((entry) => entry.oid)).toEqual(requested);
    expect(received[0]?.text).toBe(bodies["a.txt"]);
    expect(received[1]?.text).toBe(bodies["b.txt"]);
    expect(received[2]?.text).toBe(bodies["c.txt"]);
    for (const entry of received) {
      expect(entry.headerSize).toBe(Buffer.byteLength(entry.text));
    }
  });

  it("preserves exact bytes for binary and multi-byte UTF-8 payloads", async () => {
    const utf8 = "ünïcode — 🧪 multi-byte\n";
    const { repo, oids } = await repoWithBlobs({ "utf8.txt": utf8 });
    const received: Buffer[] = [];
    await catFileBatch(repo, [oids["utf8.txt"] as string], (blob) => {
      received.push(blob.bytes);
    });
    expect(received[0]?.toString("utf8")).toBe(utf8);
    expect(received[0]?.byteLength).toBe(Buffer.byteLength(utf8, "utf8"));
  });

  it("reads a large object set through a single process without deadlocking", async () => {
    const bodies: Record<string, string> = {};
    for (let index = 0; index < 400; index += 1) {
      bodies[`file-${index}.txt`] = `${"payload ".repeat(64)}${index}\n`;
    }
    const { repo, oids } = await repoWithBlobs(bodies);
    const requested = Object.keys(bodies).map((path) => oids[path] as string);

    let count = 0;
    let bytes = 0;
    await catFileBatch(repo, requested, (blob) => {
      count += 1;
      bytes += blob.bytes.byteLength;
    });
    expect(count).toBe(400);
    expect(bytes).toBeGreaterThan(400 * 500);
    // Committing 400 objects dominates this test's runtime on a contended host.
  }, 60_000);

  it("rejects a missing object rather than yielding a short candidate", async () => {
    const { repo } = await repoWithBlobs({ "a.txt": "alpha\n" });
    await expect(
      catFileBatch(repo, ["0000000000000000000000000000000000000000"], () => undefined),
    ).rejects.toThrow(/CANDIDATE_INTEGRITY_INVALID/);
  });

  it("rejects a non-blob object", async () => {
    const { repo } = await repoWithBlobs({ "a.txt": "alpha\n" });
    const treeOid = await git(repo, "rev-parse", "HEAD^{tree}");
    await expect(catFileBatch(repo, [treeOid], () => undefined)).rejects.toThrow(/CANDIDATE_UNSUPPORTED/);
  });

  it("fails closed when the repository cannot serve the stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-lsp-batch-norepo-"));
    roots.push(root);
    await expect(
      catFileBatch(root, ["0000000000000000000000000000000000000000"], () => undefined),
    ).rejects.toThrow(/GIT_COMMAND_FAILED|CANDIDATE_INTEGRITY_INVALID/);
  });

  it("fails fast when Git dies while the request pipe is backpressured", async () => {
    // A shim that drains stdin before exiting never lets the pipe fill, so it cannot reach
    // this path. This shim exits without reading anything, and the request volume is large
    // enough that the writer blocks on backpressure: if the writer only awaited `drain`,
    // that wait would never be satisfied and the call would never settle.
    const shimRoot = await mkdtemp(join(tmpdir(), "review-lsp-backpressure-"));
    roots.push(shimRoot);
    const directory = await createGitShim(join(shimRoot, "bin"), "exit-before-reading");
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;

    const oids = Array.from({ length: 100_000 }, (_, index) => index.toString(16).padStart(40, "0"));
    try {
      await expect(catFileBatch("/tmp", oids, () => undefined)).rejects.toThrow(/GIT_COMMAND_FAILED/);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 20_000);

  it("propagates a consumer failure instead of completing the read", async () => {
    const { repo, oids } = await repoWithBlobs({ "a.txt": "alpha\n", "b.txt": "beta\n" });
    const requested = [oids["a.txt"], oids["b.txt"]] as string[];
    await expect(
      catFileBatch(repo, requested, () => {
        throw new Error("consumer rejected the blob");
      }),
    ).rejects.toThrow(/consumer rejected the blob/);
  });
});
