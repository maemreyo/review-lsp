import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import type {
  AcquisitionNetworkPolicy,
  AcquisitionReport,
  CandidateDescriptor,
  DependencyInputSet,
} from "./types.js";

/**
 * Explicit dependency acquisition.
 *
 * Acquisition is a separate operation from semantic execution, and the separation is the
 * point: a hover must never be able to reach the network, but a historical candidate whose
 * packages are simply absent from the local store must not be permanently unusable either.
 * This module populates a Review-LSP-owned store so that a later snapshot publication and
 * every semantic query can run strictly offline.
 *
 * Nothing here publishes a snapshot or grants `BOUND` evidence. The acquisition store is
 * mutable working state; admission happens in P2B against sealed, copied material.
 */

/** Acquisition runs the candidate's pinned pnpm through corepack, never an ambient pnpm. */
const COREPACK_TIMEOUT_MS = 10 * 60 * 1000;

export interface AcquisitionOptions {
  candidate: CandidateDescriptor;
  inputs: DependencyInputSet;
  stateDirectory: string;
  /**
   * `OFFLINE` (default) never contacts a registry and reports `ACQUISITION_REQUIRED` when the
   * store cannot satisfy the lockfile. `EXPLICIT_ACQUISITION` authorizes this one operation
   * to fetch the exact locked artifacts.
   */
  networkPolicy?: AcquisitionNetworkPolicy;
  timeoutMs?: number;
}

export function acquisitionStoreDirectory(stateDirectory: string): string {
  return join(stateDirectory, "dependency-acquisition", "pnpm-store");
}

/**
 * Corepack's package-manager cache is Review-LSP state, not scratch state.
 *
 * Corepack downloads the pinned pnpm on first use. If that cache lived in a per-run scratch
 * directory, every acquisition would re-fetch the package manager — and, worse, an "offline"
 * run would reach the network through corepack even while pnpm itself was offline.
 */
function corepackHome(stateDirectory: string): string {
  return join(stateDirectory, "dependency-acquisition", "corepack");
}

function acquisitionWorkRoot(stateDirectory: string): string {
  return join(stateDirectory, "dependency-acquisition", "work");
}

/**
 * Builds the environment pnpm runs under.
 *
 * `HOME` and every config path point inside a scratch directory, so the developer's global
 * `.npmrc` — including any credentials or registry overrides it holds — cannot influence or
 * observe acquisition. Only the candidate's own admitted configuration applies.
 */
function isolatedEnvironment(
  home: string,
  storeDirectory: string,
  corepackDirectory: string,
  networkPolicy: AcquisitionNetworkPolicy,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    // Neutralize ambient npm/pnpm authority rather than hoping it is absent.
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, ".npmrc-global"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_globalconfig: join(home, ".npmrc-global"),
    PNPM_HOME: join(home, ".pnpm"),
    npm_config_store_dir: storeDirectory,
    COREPACK_HOME: corepackDirectory,
    // Corepack must not prompt or silently substitute a different package manager version.
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_STRICT: "1",
    // Under an offline policy corepack itself must not reach the registry. Without this the
    // package manager would be downloaded even though the install was told to stay offline.
    ...(networkPolicy === "OFFLINE" ? { COREPACK_ENABLE_NETWORK: "0" } : {}),
    CI: "1",
  };
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function run(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ReviewLspError(
        "DEPENDENCY_ACQUISITION_FAILED",
        `${command} ${args.join(" ")} exceeded ${options.timeoutMs} ms`,
      ));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ReviewLspError("DEPENDENCY_ACQUISITION_FAILED", `${command} failed to start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Recognizes the failure that means "the store lacks these exact artifacts".
 *
 * This must stay narrow. Treating an unrelated failure as `ACQUISITION_REQUIRED` would
 * suggest that enabling the network fixes something it cannot fix.
 */
function isOfflineShortfall(output: string): boolean {
  return /ERR_PNPM_NO_OFFLINE/i.test(output)
    || (/offline/i.test(output) && /missing from the store|not found in the store|no cached|failed to resolve/i.test(output));
}

/** Corepack could not provide the pinned package manager because the network was withheld. */
function isPackageManagerUnavailableOffline(output: string): boolean {
  return /COREPACK_ENABLE_NETWORK|corepack.*network|Network access disabled/i.test(output);
}

function isLockfileDrift(output: string): boolean {
  return /ERR_PNPM_OUTDATED_LOCKFILE|lockfile is not up to date|specifiers in the lockfile don't match/i.test(output);
}

/**
 * Materializes the candidate's dependency-defining files into a scratch project.
 *
 * Only the admitted input files are written — no source, no build output — so the install is
 * a pure function of what `deriveDependencyInputs` bound.
 */
async function writeInstallProject(
  candidate: CandidateDescriptor,
  inputs: DependencyInputSet,
  projectRoot: string,
): Promise<void> {
  const { readCandidateFile } = await import("./candidate.js");
  for (const file of inputs.files) {
    const { bytes, sha256: digest } = await readCandidateFile(candidate, file.path);
    if (digest !== file.sha256) {
      throw new ReviewLspError(
        "DEPENDENCY_INPUT_INVALID",
        `candidate input ${file.path} changed between derivation and acquisition`,
      );
    }
    const destination = join(projectRoot, file.path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
}

/** A digest over what the store holds for these inputs, used to prove the projection source. */
async function storeIdentity(storeDirectory: string, inputSetId: string): Promise<string> {
  let storeVersion = "absent";
  try {
    storeVersion = (await readFile(join(storeDirectory, "store.json"), "utf8")).trim();
  } catch {
    // An absent store manifest is normal before the first acquisition.
  }
  return sha256(canonicalJson({ store_directory: storeDirectory, input_set_id: inputSetId, store_manifest: storeVersion }));
}

export async function acquireDependencies(options: AcquisitionOptions): Promise<AcquisitionReport> {
  const networkPolicy = options.networkPolicy ?? "OFFLINE";
  const timeoutMs = options.timeoutMs ?? COREPACK_TIMEOUT_MS;
  const storeDirectory = acquisitionStoreDirectory(options.stateDirectory);
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(corepackHome(options.stateDirectory), { recursive: true, mode: 0o700 });
  await mkdir(acquisitionWorkRoot(options.stateDirectory), { recursive: true, mode: 0o700 });

  const workspace = await mkdtemp(join(acquisitionWorkRoot(options.stateDirectory), "acq-"));
  const home = join(workspace, "home");
  const projectRoot = join(workspace, "project");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  // An empty user config that exists is more reliable than one that merely does not.
  await writeFile(join(home, ".npmrc"), "", { mode: 0o600 });
  await writeFile(join(home, ".npmrc-global"), "", { mode: 0o600 });

  const base = (state: AcquisitionReport["state"], networkUsed: boolean): AcquisitionReport => ({
    schema_version: "review-lsp.dependency-acquisition.v1",
    state,
    input_set_id: options.inputs.input_set_id,
    package_manager: "pnpm",
    package_manager_version: options.inputs.package_manager_version,
    network_policy: networkPolicy,
    network_used: networkUsed,
    script_policy: "IGNORE_SCRIPTS",
    lockfile_policy: "FROZEN",
    dependency_graph: "INCLUDES_DEV",
    store_directory: storeDirectory,
    store_identity: "",
    acquired_at: new Date().toISOString(),
  });

  try {
    await writeInstallProject(options.candidate, options.inputs, projectRoot);

    const environment = isolatedEnvironment(home, storeDirectory, corepackHome(options.stateDirectory), networkPolicy);
    // `pnpm fetch` populates the store from the lockfile and ignores package manifests. That
    // is exactly acquisition: it produces no node_modules projection, so it cannot be mistaken
    // for the admitted semantic environment that P2B publishes from sealed material.
    // No `--prod`: the semantic environment needs the development graph, for instance to
    // resolve `@types/node` declared only in root devDependencies.
    const args = [
      `pnpm@${options.inputs.package_manager_version}`,
      "fetch",
      `--store-dir=${storeDirectory}`,
      ...(networkPolicy === "OFFLINE" ? ["--offline"] : ["--prefer-offline"]),
    ];

    const result = await run("corepack", args, { cwd: projectRoot, env: environment, timeoutMs });
    const combined = `${result.stdout}\n${result.stderr}`;

    if (result.code === 0) {
      const report = base("SATISFIED", networkPolicy === "EXPLICIT_ACQUISITION");
      report.store_identity = await storeIdentity(storeDirectory, options.inputs.input_set_id);
      return report;
    }

    if (isLockfileDrift(combined)) {
      const report = base("UNSUPPORTED", false);
      report.store_identity = await storeIdentity(storeDirectory, options.inputs.input_set_id);
      report.limitation = "candidate lockfile does not match its manifests";
      report.remediation = "the candidate itself is inconsistent; no acquisition policy can resolve this";
      return report;
    }

    if (networkPolicy === "OFFLINE" && isPackageManagerUnavailableOffline(combined)) {
      const report = base("ACQUISITION_REQUIRED", false);
      report.store_identity = await storeIdentity(storeDirectory, options.inputs.input_set_id);
      report.limitation = `pnpm ${options.inputs.package_manager_version} is not present in the Review-LSP corepack cache`;
      report.remediation = "run acquisition once with the explicit network policy to cache the pinned package manager";
      return report;
    }

    if (networkPolicy === "OFFLINE" && isOfflineShortfall(combined)) {
      const report = base("ACQUISITION_REQUIRED", false);
      report.store_identity = await storeIdentity(storeDirectory, options.inputs.input_set_id);
      report.limitation = "required packages are absent from the Review-LSP acquisition store";
      report.remediation = "re-run acquisition with the explicit network policy to fetch the exact locked artifacts";
      return report;
    }

    throw new ReviewLspError(
      "DEPENDENCY_ACQUISITION_FAILED",
      `pnpm install failed (exit ${result.signal ?? result.code}): ${combined.trim().slice(-2000)}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
