import { spawn } from "node:child_process";

import { ReviewLspError } from "./errors.js";

/**
 * Bounded `git cat-file --batch` plumbing.
 *
 * Enumerating a candidate by spawning `git cat-file` twice per blob makes preparation cost
 * scale with process-creation overhead rather than with candidate bytes. One long-lived
 * batch stream reads the same objects without weakening any integrity rule: the declared
 * size from `git ls-tree -l`, the size in the batch response header, and the number of
 * payload bytes actually received remain three separately observed values.
 */

const NEWLINE = 0x0a;

export const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
} as const;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    ...GIT_ENV,
  };
}

/**
 * Incremental byte reader over a child process stdout stream. Keeps a single contiguous
 * buffer with an explicit read offset and compacts it once consumed bytes dominate, so
 * parsing stays linear instead of re-concatenating on every response.
 */
class ByteStream {
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;
  private ended = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  push(chunk: Buffer): void {
    this.compact();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.signal();
  }

  end(): void {
    this.ended = true;
    this.signal();
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.ended = true;
    this.signal();
  }

  get available(): number {
    return this.buffer.length - this.offset;
  }

  private compact(): void {
    if (this.offset === 0) return;
    if (this.offset < 8192 && this.offset * 2 < this.buffer.length) return;
    this.buffer = this.buffer.subarray(this.offset);
    this.offset = 0;
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async waitForMore(what: string): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) {
      throw new ReviewLspError("GIT_COMMAND_FAILED", `git cat-file --batch ended before ${what}`);
    }
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    if (this.failure) throw this.failure;
  }

  /** Reads up to and including the next newline, returning the line without it. */
  async readLine(limit: number): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf(NEWLINE, this.offset);
      if (index >= 0) {
        const line = this.buffer.subarray(this.offset, index).toString("utf8");
        this.offset = index + 1;
        return line;
      }
      if (this.available > limit) {
        throw new ReviewLspError("GIT_COMMAND_FAILED", "git cat-file --batch produced an oversized response header");
      }
      await this.waitForMore("a complete response header");
    }
  }

  async readExact(count: number): Promise<Buffer> {
    while (this.available < count) {
      await this.waitForMore(`${count} payload bytes were received`);
    }
    const bytes = Buffer.from(this.buffer.subarray(this.offset, this.offset + count));
    this.offset += count;
    return bytes;
  }
}

export interface BatchBlob {
  oid: string;
  /** Size declared by the batch response header, observed independently of `git ls-tree -l`. */
  headerSize: number;
  bytes: Buffer;
}

/**
 * Reads every requested object through a single `git cat-file --batch` process.
 *
 * Requests are written while responses are consumed, so neither pipe can fill and deadlock.
 * Responses arrive in request order; the caller receives them in that same order.
 */
export async function catFileBatch(
  repo: string,
  oids: readonly string[],
  onBlob: (blob: BatchBlob) => void | Promise<void>,
): Promise<void> {
  if (oids.length === 0) return;

  const child = spawn("git", ["-C", repo, "cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: gitEnvironment(),
  });

  const stream = new ByteStream();
  const stderrChunks: Buffer[] = [];
  let exited = false;

  child.stdout.on("data", (chunk: Buffer) => stream.push(chunk));
  child.stdout.on("error", (error: Error) => stream.fail(error));
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrChunks.length < 64) stderrChunks.push(chunk);
  });
  child.on("error", (error: Error) => {
    stream.fail(new ReviewLspError("GIT_COMMAND_FAILED", `git cat-file --batch failed to start: ${error.message}`));
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => {
      exited = true;
      stream.end();
      resolve({ code, signal });
    });
  });

  // Ignore EPIPE on the request pipe: a premature child exit is reported through the
  // response stream with the accumulated stderr, which is the more useful diagnostic.
  child.stdin.on("error", () => undefined);

  const writeRequests = (async () => {
    for (let index = 0; index < oids.length; index += 1) {
      if (exited) return;
      if (!child.stdin.write(`${oids[index]}\n`)) {
        await new Promise<void>((resolve) => child.stdin.once("drain", resolve));
      }
    }
    child.stdin.end();
  })();

  try {
    for (const requested of oids) {
      const header = await stream.readLine(4096);
      const parts = header.split(" ");
      if (parts.length === 2 && (parts[1] === "missing" || parts[1] === "ambiguous")) {
        throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `git object ${requested} is ${parts[1]}`);
      }
      if (parts.length !== 3) {
        throw new ReviewLspError("GIT_COMMAND_FAILED", `malformed git cat-file --batch header ${JSON.stringify(header)}`);
      }
      const [oid, type, rawSize] = parts as [string, string, string];
      if (oid !== requested) {
        throw new ReviewLspError(
          "CANDIDATE_INTEGRITY_INVALID",
          `git cat-file --batch returned object ${oid} while ${requested} was requested`,
        );
      }
      if (type !== "blob") {
        throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `git object ${oid} is a ${type}, not a blob`);
      }
      if (!/^[0-9]+$/.test(rawSize)) {
        throw new ReviewLspError("GIT_COMMAND_FAILED", `malformed git cat-file --batch size ${JSON.stringify(rawSize)}`);
      }
      const headerSize = Number(rawSize);
      if (!Number.isSafeInteger(headerSize) || headerSize < 0) {
        throw new ReviewLspError("CANDIDATE_UNSUPPORTED", `git object ${oid} declares an unusable size`);
      }
      const bytes = await stream.readExact(headerSize);
      const terminator = await stream.readExact(1);
      if (terminator[0] !== NEWLINE) {
        throw new ReviewLspError("GIT_COMMAND_FAILED", `git cat-file --batch payload for ${oid} was not newline framed`);
      }
      // Belt-and-braces: readExact cannot return short, but the received length is the
      // third independent observation the integrity cross-check relies on.
      if (bytes.byteLength !== headerSize) {
        throw new ReviewLspError("CANDIDATE_INTEGRITY_INVALID", `git object ${oid} payload length does not match its header`);
      }
      await onBlob({ oid, headerSize, bytes });
    }

    const { code, signal } = await exit;
    if (code !== 0) {
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
      throw new ReviewLspError(
        "GIT_COMMAND_FAILED",
        `git cat-file --batch exited with ${signal ?? code}${detail ? `: ${detail}` : ""}`,
      );
    }
  } catch (error) {
    if (error instanceof ReviewLspError) {
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (detail && !error.message.includes(detail)) {
        throw new ReviewLspError(error.code, `${error.message} (git stderr: ${detail})`);
      }
    }
    throw error;
  } finally {
    if (!exited) child.kill("SIGKILL");
    await writeRequests.catch(() => undefined);
    await exit.catch(() => undefined);
  }
}
