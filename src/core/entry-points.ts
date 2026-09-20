import { lstat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { ReviewLspError } from "./errors.js";
import type { EntryPointFinding, EntryPointGateResult } from "./types.js";

/**
 * The workspace entry-point resolvability gate.
 *
 * Installing dependencies correctly does not make a workspace semantically complete. A
 * workspace package can be linked exactly as its lockfile says while the file its manifest
 * names as the type entry point does not exist — typically because it is build output under
 * an ignored `dist/`, which is therefore not candidate material and is not produced by any
 * install. TypeScript then resolves imports of that package to nothing, and every query that
 * depends on it degrades silently.
 *
 * Silent degradation under a VERIFIED environment is precisely what this project exists to
 * prevent, so a projection whose declared entry points are absent cannot be VERIFIED. The
 * check is deliberately about presence of the selected target, not about install success.
 */

/** Conditions that select a TypeScript-visible target within an `exports` entry. */
const TYPE_CONDITIONS = ["types", "typings"];
const RUNTIME_CONDITIONS = ["import", "require", "node", "default"];

interface ManifestLike {
  name?: unknown;
  main?: unknown;
  types?: unknown;
  typings?: unknown;
  exports?: unknown;
}

/**
 * Collects the relative targets a manifest selects, in TypeScript's order of preference.
 *
 * Only targets that can carry type information are collected. A package that declares none is
 * not a finding: TypeScript may still resolve it from its source layout.
 */
function selectedTargets(manifest: ManifestLike): { target: string; field: string }[] {
  const targets: { target: string; field: string }[] = [];

  if (typeof manifest.types === "string") targets.push({ target: manifest.types, field: "types" });
  else if (typeof manifest.typings === "string") targets.push({ target: manifest.typings, field: "typings" });

  const exportsField = manifest.exports;
  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    for (const [subpath, value] of Object.entries(exportsField as Record<string, unknown>)) {
      // Wildcard exports are deliberately not skipped. When the selected target itself contains
      // a wildcard, the conservative existence check below cannot prove the generated semantic
      // surface is present and therefore leaves the gate INCOMPLETE. A wildcard subpath that
      // maps to one concrete target can still pass when that exact target exists.
      if (typeof value === "string") {
        targets.push({ target: value, field: `exports[${subpath}]` });
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const conditions = value as Record<string, unknown>;
      for (const condition of [...TYPE_CONDITIONS, ...RUNTIME_CONDITIONS]) {
        const target = conditions[condition];
        if (typeof target === "string") {
          targets.push({ target, field: `exports[${subpath}].${condition}` });
          break;
        }
      }
    }
  }

  if (targets.length === 0 && typeof manifest.main === "string") {
    targets.push({ target: manifest.main, field: "main" });
  }
  return targets;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A declared target may be extensionless or point at a directory, exactly as module
 * resolution allows, so presence is checked the way a resolver would look for it.
 */
async function targetResolves(packageRoot: string, target: string): Promise<boolean> {
  const base = resolvePath(packageRoot, target);
  // Containment: a manifest must not reach outside its own package to claim an entry point.
  const relative = base.startsWith(packageRoot + "/") || base === packageRoot;
  if (!relative) return false;

  if (await exists(base)) {
    return true;
  }
  for (const extension of [".d.ts", ".ts", ".tsx", ".d.mts", ".mts", ".d.cts", ".cts", ".js", ".mjs", ".cjs", ".json"]) {
    if (await exists(`${base}${extension}`)) return true;
  }
  for (const indexFile of ["index.d.ts", "index.ts", "index.js", "index.mjs", "index.cjs"]) {
    if (await exists(join(base, indexFile))) return true;
  }
  return false;
}

export interface EntryPointGateInput {
  /** Root the manifests are resolved against; normally the execution projection. */
  projectionRoot: string;
  /** Workspace manifest paths relative to the projection root. */
  workspaceManifests: string[];
  readManifest: (relativePath: string) => Promise<string>;
}

export async function runEntryPointGate(input: EntryPointGateInput): Promise<EntryPointGateResult> {
  const findings: EntryPointFinding[] = [];
  let checked = 0;

  for (const manifestPath of input.workspaceManifests) {
    let manifest: ManifestLike;
    try {
      manifest = JSON.parse(await input.readManifest(manifestPath)) as ManifestLike;
    } catch (error) {
      throw new ReviewLspError(
        "DEPENDENCY_INPUT_INVALID",
        `workspace manifest ${manifestPath} is not valid JSON: ${(error as Error).message}`,
      );
    }

    const packageRoot = resolvePath(input.projectionRoot, dirname(manifestPath));
    for (const { target, field } of selectedTargets(manifest)) {
      checked += 1;
      if (await targetResolves(packageRoot, target)) continue;
      findings.push({
        manifest_path: manifestPath,
        package_name: typeof manifest.name === "string" ? manifest.name : null,
        field,
        declared_target: target,
        limitation: `${manifestPath} selects ${field}=${JSON.stringify(target)}, which is absent from the projection`,
      });
    }
  }

  return {
    schema_version: "review-lsp.entry-point-gate.v1",
    state: findings.length === 0 ? "COMPLETE" : "INCOMPLETE",
    targets_checked: checked,
    findings,
  };
}
