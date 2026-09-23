import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import { analyzeProjectOwnership, resolveProjectOwner } from "./project-ownership.js";
import type {
  CandidateDescriptor,
  DependencySnapshotDescriptor,
  ResolvingProject,
  ToolchainAlignment,
  ToolchainAssessment,
} from "./types.js";

/**
 * Project-aligned semantic toolchain resolution.
 *
 * Reproducing an engine is not the same as matching the project's engine. A profile can be
 * perfectly content-addressed and still answer with a different TypeScript generation than
 * the candidate declares, and the result would look identical in every other evidence field.
 * `toolchain_alignment` exists so that difference is stated rather than implied, and so
 * `VERIFIED` alone is never read as "the project's own semantics answered this".
 */

/**
 * Resolves the candidate-bound project that owns a document from Alpha.6 membership evidence.
 *
 * No path-proximity fallback is allowed here: a VERIFIED routing decision must come from the
 * admitted files/include/exclude/relative-extends ownership model.
 */
export async function resolveProjectForDocument(
  candidate: CandidateDescriptor,
  documentPath: string,
): Promise<ResolvingProject> {
  return resolveProjectOwner(await analyzeProjectOwnership(candidate), documentPath);
}

/** Ambiguous/unsupported ownership cannot select an engine or reusable runtime safely. */
export function assertProjectRoutingAdmitted(project: ResolvingProject, documentPath: string): void {
  if (project.state !== "AMBIGUOUS" && project.state !== "UNSUPPORTED") return;
  const detail = project.limitations?.join("; ")
    ?? `project ownership for ${documentPath} is ${project.state.toLowerCase()}`;
  throw new ReviewLspError("ENVIRONMENT_PARTIAL", detail);
}

/** The TypeScript generation a version string belongs to, e.g. `7.0.2` -> 7. */
function generation(version: string): number | null {
  const match = /^(\d+)\./.exec(version.replace(/^[\^~>=<\s]+/, ""));
  return match?.[1] ? Number(match[1]) : null;
}

function declaredTypeScript(manifest: Record<string, unknown>): string | undefined {
  for (const field of ["dependencies", "devDependencies"] as const) {
    const group = manifest[field];
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const version = (group as Record<string, unknown>).typescript;
    if (typeof version === "string") return version;
  }
  return undefined;
}

/**
 * Determines which TypeScript the candidate project would use.
 *
 * An admitted dependency snapshot is authoritative, because it holds the version that was
 * actually resolved. A manifest declaration is a fallback and is marked as such: a range is
 * not a resolved version.
 */
export async function resolveProjectToolchain(input: {
  candidate: CandidateDescriptor;
  snapshot?: DependencySnapshotDescriptor | null;
  projectRoot?: string | null;
}): Promise<{ version: string | null; source: "DEPENDENCY_SNAPSHOT" | "MANIFEST_DECLARATION" | "ABSENT" }> {
  const { candidate, snapshot } = input;

  if (snapshot) {
    const roots = [
      input.projectRoot ? join(snapshot.dependency_root, input.projectRoot) : null,
      snapshot.dependency_root,
    ].filter((value): value is string => typeof value === "string");
    for (const root of roots) {
      const manifestPath = join(root, "node_modules", "typescript", "package.json");
      try {
        const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string") return { version: parsed.version, source: "DEPENDENCY_SNAPSHOT" };
      } catch {
        // Try the next root; absence here is not an error.
      }
    }
  }

  for (const manifestPath of [
    input.projectRoot ? `${input.projectRoot}/package.json` : null,
    "package.json",
  ].filter((value): value is string => typeof value === "string")) {
    const entry = candidate.entries.find((item) => item.path === manifestPath && item.kind === "file");
    if (!entry) continue;
    try {
      const manifest = JSON.parse(await readFile(join(candidate.source_root, manifestPath), "utf8")) as Record<string, unknown>;
      const declared = declaredTypeScript(manifest);
      if (declared) return { version: declared, source: "MANIFEST_DECLARATION" };
    } catch {
      // A manifest that cannot be parsed simply does not answer the question.
    }
  }

  return { version: null, source: "ABSENT" };
}

export interface AlignmentInput {
  projectVersion: string | null;
  projectVersionSource: "DEPENDENCY_SNAPSHOT" | "MANIFEST_DECLARATION" | "ABSENT";
  /** Version of the engine that actually answered. */
  engineVersion: string;
  /**
   * Whether the engine that answered is the project's own admitted artifact, executed under a
   * profile that satisfies D11. False while the engine is Review-LSP's bundled TypeScript.
   */
  engineIsProjectAdmitted: boolean;
}

/**
 * Classifies how the answering engine relates to the project's declared toolchain.
 *
 * `EXACT_PROJECT` is deliberately unreachable while the answering engine is Review-LSP's own
 * bundled TypeScript. Running the candidate's engine is a separate trust decision requiring
 * enforced isolation, so claiming project alignment without it would assert something that was
 * never established.
 */
export function assessToolchainAlignment(input: AlignmentInput): ToolchainAssessment {
  const engineGeneration = generation(input.engineVersion);

  if (input.projectVersion === null) {
    // A project that pins no TypeScript has no project engine to be aligned with, so nothing
    // is contradicted and nothing is undeterminable. The admitted profile engine answered,
    // and that is exactly what a compatibility profile describes.
    return {
      alignment: "COMPATIBILITY_PROFILE",
      reason: `candidate declares no TypeScript version; answered by Review-LSP's admitted TypeScript ${input.engineVersion}`,
    };
  }

  const projectGeneration = generation(input.projectVersion);
  if (projectGeneration === null || engineGeneration === null) {
    return { alignment: "UNKNOWN", reason: "a toolchain version could not be interpreted as a TypeScript generation" };
  }

  if (projectGeneration !== engineGeneration) {
    // TypeScript 7 is a native implementation with its own LSP rather than another tsserver
    // package version, so a generation difference is an engine difference, not a version skew.
    return {
      alignment: "MISMATCH",
      reason: `candidate project uses TypeScript ${input.projectVersion} but TypeScript ${input.engineVersion} answered; these are different TypeScript generations`,
    };
  }

  if (!input.engineIsProjectAdmitted) {
    return {
      alignment: "COMPATIBILITY_PROFILE",
      reason: `answered by Review-LSP's admitted TypeScript ${input.engineVersion}, which shares a generation with the project's ${input.projectVersion} but is not the project's own admitted engine`,
    };
  }

  if (input.projectVersion !== input.engineVersion) {
    return {
      alignment: "COMPATIBILITY_PROFILE",
      reason: `project TypeScript ${input.projectVersion} and answering engine ${input.engineVersion} share a generation but are not the same version`,
    };
  }

  return { alignment: "EXACT_PROJECT", reason: null };
}

/** Alignments that may not support strong exact-candidate semantic admission. */
export function alignmentBlocksStrongAdmission(alignment: ToolchainAlignment): boolean {
  return alignment === "MISMATCH" || alignment === "UNKNOWN";
}

export function resolvingProjectIdentity(project: ResolvingProject): string {
  return sha256(JSON.stringify({
    state: project.state,
    config_path: project.config_path,
    config_sha256: project.config_sha256,
    ownership_sha256: project.ownership_sha256 ?? null,
    candidate_configs: [...(project.candidate_configs ?? [])]
      .sort((a, b) => a.config_path.localeCompare(b.config_path))
      .map((candidate) => ({
        config_path: candidate.config_path,
        config_sha256: candidate.config_sha256,
        project_root: candidate.project_root,
        ownership_sha256: candidate.ownership_sha256,
      })),
  }));
}
