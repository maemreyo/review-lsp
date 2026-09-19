import { contentId } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import { SemanticSession } from "./session.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ProjectionDescriptor,
  ResolvingProject,
  RuntimeKey,
  TypeScriptProfile,
} from "./types.js";

/**
 * Reuse of an exact candidate's semantic runtime across many questions.
 *
 * Preparing a candidate, publishing a dependency snapshot and starting a language server are
 * all expensive, and none of them depends on which question is being asked. Doing them per
 * query — as the consumer adapter did — guarantees the cost can never be amortised, which is
 * the friction this exists to remove.
 *
 * Reuse is only safe if what is reused is identical in every respect that could change an
 * answer, so the key binds all of them. Anything not in the key is something two callers
 * could disagree about while sharing a runtime.
 */

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

export function runtimeKeyId(key: RuntimeKey): string {
  return contentId("rt", {
    candidate_id: key.candidate_id,
    source_manifest_sha256: key.source_manifest_sha256,
    dependency_snapshot_id: key.dependency_snapshot_id,
    derived_artifact_snapshot_ids: [...key.derived_artifact_snapshot_ids].sort(),
    projection_id: key.projection_id,
    profile_sha256: key.profile_sha256,
    resolving_project_identity: key.resolving_project_identity,
    isolation: key.isolation,
  });
}

export function runtimeKeyFor(input: {
  candidate: CandidateDescriptor;
  profile: TypeScriptProfile;
  projection?: ProjectionDescriptor | null;
  snapshot?: DependencySnapshotDescriptor | null;
  derivedArtifactSnapshotIds?: string[];
  resolvingProjectIdentity?: string | null;
}): RuntimeKey {
  return {
    candidate_id: input.candidate.candidate_id,
    source_manifest_sha256: input.candidate.source_manifest_sha256,
    dependency_snapshot_id: input.snapshot?.snapshot_id ?? null,
    derived_artifact_snapshot_ids: input.derivedArtifactSnapshotIds ?? [],
    projection_id: input.projection?.projection_id ?? null,
    profile_sha256: input.profile.profile_sha256,
    resolving_project_identity: input.resolvingProjectIdentity ?? null,
    isolation: input.candidate.isolation,
  };
}

export interface RuntimeLease {
  readonly session: SemanticSession;
  readonly key_id: string;
  /**
   * Returns the runtime to the pool. Idempotent, because cleanup that must be called exactly
   * once is cleanup that will eventually be called twice.
   */
  release(): void;
}

interface RuntimeEntry {
  keyId: string;
  session: Promise<SemanticSession>;
  /** Outstanding leases. A runtime is never closed while this is above zero. */
  leases: number;
  idleTimer: NodeJS.Timeout | undefined;
  /** Set once the runtime is being torn down, so no new lease can attach to it. */
  closing: boolean;
  failed: boolean;
}

export interface AcquireRequest {
  candidate: CandidateDescriptor;
  profile: TypeScriptProfile;
  stateDirectory: string;
  projection?: ProjectionDescriptor | null;
  snapshot?: DependencySnapshotDescriptor | null;
  derivedArtifactSnapshotIds?: string[];
  /** The project that owns the documents this lease will query, when known. */
  resolvingProject?: ResolvingProject | null;
  resolvingProjectIdentity?: string | null;
  requestTimeoutMs?: number;
}

export interface RuntimeManagerOptions {
  /** How long an unreferenced runtime stays warm before it is closed. */
  idleTtlMs?: number;
  /** Maximum simultaneously live runtimes; the least recently released is closed first. */
  maxRuntimes?: number;
}

/**
 * Owns the lifetime of candidate-bound semantic runtimes.
 *
 * The manager deliberately holds no review or policy concepts. When to start, how long to keep
 * a runtime warm and when to discard it are consumer decisions; what this guarantees is that
 * sharing one is safe.
 */
export class SemanticRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly idleTtlMs: number;
  private readonly maxRuntimes: number;
  private disposed = false;

  constructor(options: RuntimeManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxRuntimes = options.maxRuntimes ?? 8;
  }

  get liveRuntimeCount(): number {
    return this.entries.size;
  }

  async acquire(request: AcquireRequest): Promise<RuntimeLease> {
    if (this.disposed) throw new ReviewLspError("LSP_CANCELLED", "runtime manager has been disposed");

    const key = runtimeKeyFor({
      candidate: request.candidate,
      profile: request.profile,
      projection: request.projection ?? null,
      snapshot: request.snapshot ?? null,
      ...(request.derivedArtifactSnapshotIds ? { derivedArtifactSnapshotIds: request.derivedArtifactSnapshotIds } : {}),
      resolvingProjectIdentity: request.resolvingProjectIdentity
        ?? (request.resolvingProject ? request.resolvingProject.config_sha256 : null),
    });
    const keyId = runtimeKeyId(key);

    let entry = this.entries.get(keyId);
    if (entry?.closing) {
      // A runtime already being torn down must not be handed out again; start a fresh one.
      entry = undefined;
    }

    if (!entry) {
      entry = {
        keyId,
        // Concurrent acquisitions share one creation, so four simultaneous questions start
        // one language server rather than four.
        session: SemanticSession.create({
          candidate: request.candidate,
          profile: request.profile,
          stateDirectory: request.stateDirectory,
          ...(request.projection ? { projection: request.projection } : {}),
          ...(request.snapshot ? { snapshot: request.snapshot } : {}),
          ...(request.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: request.requestTimeoutMs }),
        }),
        leases: 0,
        idleTimer: undefined,
        closing: false,
        failed: false,
      };
      this.entries.set(keyId, entry);
      const created = entry;
      created.session.catch(() => {
        // A runtime that never started must not be cached as if it had.
        if (this.entries.get(keyId) === created) {
          created.failed = true;
          this.entries.delete(keyId);
        }
      });
    }

    const held = entry;
    held.leases += 1;
    if (held.idleTimer) {
      clearTimeout(held.idleTimer);
      held.idleTimer = undefined;
    }

    let session: SemanticSession;
    try {
      session = await held.session;
    } catch (error) {
      held.leases -= 1;
      throw error;
    }

    await this.evictIfOverCapacity(keyId);

    let released = false;
    return {
      session,
      key_id: keyId,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(held);
      },
    };
  }

  private releaseEntry(entry: RuntimeEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0 || entry.closing) return;
    if (this.disposed) {
      void this.closeEntry(entry);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.leases === 0) void this.closeEntry(entry);
    }, this.idleTtlMs);
    // A warm runtime must not hold the process open on its own.
    entry.idleTimer.unref?.();
  }

  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    // Closing is guarded by the lease count, so an admitted in-flight query cannot have its
    // server shut down underneath it.
    if (entry.closing || entry.leases > 0) return;
    entry.closing = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (this.entries.get(entry.keyId) === entry) this.entries.delete(entry.keyId);
    try {
      const session = await entry.session;
      await session.close();
    } catch {
      // A runtime that failed to start, or has already gone, needs no further teardown.
    }
  }

  private async evictIfOverCapacity(keepKeyId: string): Promise<void> {
    if (this.entries.size <= this.maxRuntimes) return;
    for (const entry of [...this.entries.values()]) {
      if (this.entries.size <= this.maxRuntimes) break;
      if (entry.keyId === keepKeyId || entry.leases > 0 || entry.closing) continue;
      await this.closeEntry(entry);
    }
  }

  /** Closes every unreferenced runtime now, leaving leased ones to close on release. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry)));
  }
}
