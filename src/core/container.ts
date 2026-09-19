import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256 } from "./canonical.js";
import { ReviewLspError } from "./errors.js";
import { persistReceipt, validateReceipt } from "./receipts.js";
import type { CandidateDescriptor, EnvironmentManifest, SemanticReceipt } from "./types.js";

const execFileAsync = promisify(execFile);
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

interface MountInfoEntry {
  mount_point: string;
  mount_options: string[];
}

function decodeMountInfoPath(value: string): string {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

export function parseLinuxMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || !fields[4] || !fields[5]) continue;
    entries.push({
      mount_point: decodeMountInfoPath(fields[4]),
      mount_options: fields[5].split(",").filter(Boolean),
    });
  }
  return entries;
}

export async function verifyLinuxReadOnlyMount(rootInput: string): Promise<{ mount_point: string; mount_options: string[] }> {
  if (process.platform !== "linux") {
    throw new ReviewLspError("CONTAINER_ISOLATION_INVALID", "CONTAINER_READ_ONLY admission requires a Linux runtime");
  }
  const root = await realpath(rootInput);
  const entries = parseLinuxMountInfo(await readFile("/proc/self/mountinfo", "utf8"));
  const exact = entries.find((entry) => entry.mount_point === root);
  if (!exact) {
    throw new ReviewLspError(
      "CONTAINER_ISOLATION_INVALID",
      `candidate root ${root} is not an explicit Linux mount point`,
    );
  }
  if (!exact.mount_options.includes("ro")) {
    throw new ReviewLspError(
      "CONTAINER_ISOLATION_INVALID",
      `candidate mount ${root} is not read-only: ${exact.mount_options.join(",")}`,
    );
  }
  return exact;
}

async function docker(args: string[], options: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
      },
    });
    return { stdout, stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    const detail = [value.message, value.stderr, value.stdout].filter(Boolean).join("\n").slice(0, 8000);
    throw new ReviewLspError("CONTAINER_EXECUTION_FAILED", detail || "docker command failed");
  }
}

export async function resolveDockerImageId(image: string): Promise<string> {
  if (!image || image.startsWith("-") || /[\r\n\0]/.test(image)) {
    throw new ReviewLspError("CONTAINER_IMAGE_INVALID", `invalid Docker image reference ${JSON.stringify(image)}`);
  }
  let inspected: { stdout: string };
  try {
    inspected = await docker(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000 });
  } catch (error) {
    if (error instanceof ReviewLspError) {
      throw new ReviewLspError("CONTAINER_UNAVAILABLE", `cannot inspect Docker image ${image}: ${error.message}`);
    }
    throw error;
  }
  const id = inspected.stdout.trim();
  if (!IMAGE_ID_RE.test(id)) {
    throw new ReviewLspError("CONTAINER_IMAGE_INVALID", `Docker image ${image} resolved to invalid ID ${JSON.stringify(id)}`);
  }
  return id;
}

function assertedRelativePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `invalid candidate path ${JSON.stringify(path)}`);
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized === "." || normalized !== path) {
    throw new ReviewLspError("CANDIDATE_PATH_INVALID", `non-canonical candidate path ${JSON.stringify(path)}`);
  }
  return path;
}

function requireMountSafeHostPath(path: string, label: string): void {
  if (path.includes(",") || /[\r\n\0]/.test(path)) {
    throw new ReviewLspError(
      "CONTAINER_ISOLATION_INVALID",
      `${label} contains a character unsupported by the v0.1 Docker mount encoder: ${JSON.stringify(path)}`,
    );
  }
}


export interface ContainerMount {
  /** Absolute host path to expose. */
  source: string;
  /** Absolute path inside the container. */
  destination: string;
  label: string;
}

export interface ContainerRunSpec {
  imageId: string;
  operation: "hover" | "definition";
  path: string;
  line: number;
  character: number;
  /** Read-only mounts: candidate source or projection, dependency snapshot, derived artifacts. */
  mounts: ContainerMount[];
  descriptorPath: string;
  /** Working root inside the container the language server is pointed at. */
  containerRoot: string;
}

/**
 * Builds the full `docker run` argument list for one semantic query.
 *
 * Kept pure and exported so the isolation itself is testable. The container profile is the
 * only execution profile this project treats as enforced, and what makes it enforced is
 * exactly this argument list: no network, read-only root, all capabilities dropped, no
 * privilege escalation, a non-root user, bounded resources, and every mount read-only. A
 * regression in any one of those is a silent loss of the property the profile is admitted
 * for, so each is asserted rather than assumed.
 */
export function buildContainerRunArgs(spec: ContainerRunSpec): string[] {
  requireMountSafeHostPath(spec.descriptorPath, "container descriptor path");
  for (const mount of spec.mounts) {
    requireMountSafeHostPath(mount.source, mount.label);
    if (!mount.destination.startsWith("/")) {
      throw new ReviewLspError(
        "CONTAINER_ISOLATION_INVALID",
        `${mount.label} destination must be absolute inside the container: ${JSON.stringify(mount.destination)}`,
      );
    }
  }

  const mountArgs: string[] = [];
  for (const mount of spec.mounts) {
    mountArgs.push("--mount", `type=bind,src=${mount.source},dst=${mount.destination},readonly`);
  }

  return [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "1024m",
    "--cpus", "2",
    "--user", "65532:65532",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=1777,size=268435456",
    "--tmpfs", "/state:rw,nosuid,nodev,noexec,mode=1777,size=134217728",
    ...mountArgs,
    "--mount", `type=bind,src=${spec.descriptorPath},dst=/input/candidate.json,readonly`,
    "--env", `REVIEW_LSP_CONTAINER_IMAGE_ID=${spec.imageId}`,
    spec.imageId,
    "__container-query",
    "/input/candidate.json",
    spec.operation,
    spec.path,
    String(spec.line),
    String(spec.character),
    "--state",
    "/state",
  ];
}

function assertContainerReceipt(input: {
  receipt: SemanticReceipt;
  environment: EnvironmentManifest;
  candidate: CandidateDescriptor;
  operation: "hover" | "definition";
  path: string;
  line: number;
  character: number;
  imageId: string;
}): void {
  validateReceipt(input.receipt);
  if (input.receipt.candidate.candidate_id !== input.candidate.candidate_id
    || input.receipt.candidate.commit_oid !== input.candidate.commit_oid
    || input.receipt.candidate.tree_oid !== input.candidate.tree_oid
    || input.receipt.candidate.source_manifest_sha256 !== input.candidate.source_manifest_sha256) {
    throw new ReviewLspError("CANDIDATE_MISMATCH", "container receipt candidate identity differs from host candidate");
  }
  if (input.receipt.operation !== input.operation
    || input.receipt.document.path !== input.path
    || input.receipt.request.line !== input.line
    || input.receipt.request.character !== input.character) {
    throw new ReviewLspError("RECEIPT_INVALID", "container receipt operation/document/request differs from host request");
  }
  if (input.receipt.source_binding !== "VERIFIED"
    || input.receipt.isolation !== "CONTAINER_READ_ONLY") {
    throw new ReviewLspError("CONTAINER_ISOLATION_INVALID", "container receipt lacks VERIFIED source or CONTAINER_READ_ONLY isolation");
  }
  if (input.receipt.environment_binding !== input.environment.binding
    || input.receipt.profile_sha256 !== input.environment.profile_sha256) {
    throw new ReviewLspError(
      "RECEIPT_INVALID",
      "container receipt environment/profile binding differs from the returned environment manifest",
    );
  }
  const expectedIsolationIdentity = `docker:${input.imageId}`;
  const { environment_manifest_sha256: _environmentDigest, ...stableEnvironment } = input.environment;
  const observedEnvironmentDigest = sha256(canonicalJson(stableEnvironment));
  if (observedEnvironmentDigest !== input.environment.environment_manifest_sha256
    || input.receipt.environment_manifest_sha256 !== input.environment.environment_manifest_sha256) {
    throw new ReviewLspError("RECEIPT_INVALID", "container environment manifest digest does not match receipt");
  }
  if (input.environment.candidate_id !== input.candidate.candidate_id
    || input.environment.platform !== "linux"
    || input.environment.isolation !== "CONTAINER_READ_ONLY"
    || input.environment.isolation_identity !== expectedIsolationIdentity) {
    throw new ReviewLspError(
      "CONTAINER_ISOLATION_INVALID",
      `container environment is not bound to candidate/image isolation ${expectedIsolationIdentity}`,
    );
  }
}

export interface DockerSemanticQueryResult {
  receipt: SemanticReceipt;
  environment: EnvironmentManifest;
  image_id: string;
}

export async function runDockerSemanticQuery(input: {
  candidate: CandidateDescriptor;
  operation: "hover" | "definition";
  path: string;
  line: number;
  character: number;
  image: string;
  stateDirectory: string;
  timeoutMs?: number;
  /** Sealed dependency snapshot to expose read-only alongside the candidate. */
  dependencyRoot?: string | undefined;
}): Promise<DockerSemanticQueryResult> {
  const path = assertedRelativePath(input.path);
  const imageId = await resolveDockerImageId(input.image);
  const sourceRoot = await realpath(input.candidate.source_root);

  const runRootParent = join(input.stateDirectory, "container-runs");
  await mkdir(runRootParent, { recursive: true, mode: 0o700 });
  const runRoot = await mkdtemp(join(runRootParent, "run-"));
  const descriptorPath = join(runRoot, "candidate.json");
  requireMountSafeHostPath(descriptorPath, "container descriptor path");

  const containerCandidate: CandidateDescriptor = {
    ...input.candidate,
    source_root: "/candidate",
  };
  await writeFile(descriptorPath, `${JSON.stringify(containerCandidate, null, 2)}\n`, { mode: 0o444, flag: "wx" });

  try {
    const args = buildContainerRunArgs({
      imageId,
      operation: input.operation,
      path,
      line: input.line,
      character: input.character,
      mounts: [
        { source: sourceRoot, destination: "/candidate", label: "candidate source root" },
        ...(input.dependencyRoot
          ? [{ source: input.dependencyRoot, destination: "/dependencies", label: "dependency snapshot root" }]
          : []),
      ],
      descriptorPath,
      containerRoot: "/candidate",
    });
    const { stdout } = await docker(args, { timeoutMs: input.timeoutMs ?? 120_000 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new ReviewLspError("CONTAINER_EXECUTION_FAILED", `container returned invalid JSON: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("receipt" in parsed) || !("environment" in parsed)) {
      throw new ReviewLspError("CONTAINER_EXECUTION_FAILED", "container query output omitted receipt/environment");
    }
    const { receipt, environment } = parsed as { receipt: SemanticReceipt; environment: EnvironmentManifest };
    assertContainerReceipt({
      receipt,
      environment,
      candidate: input.candidate,
      operation: input.operation,
      path,
      line: input.line,
      character: input.character,
      imageId,
    });
    const { receipt_id: expectedReceiptId, ...stable } = receipt;
    const persisted = await persistReceipt(input.stateDirectory, stable);
    if (persisted.receipt_id !== expectedReceiptId) {
      throw new ReviewLspError("RECEIPT_INVALID", "host-persisted container receipt identity changed");
    }
    return { receipt: persisted, environment, image_id: imageId };
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

export function containerImageIdFromEnvironment(): string {
  const value = process.env.REVIEW_LSP_CONTAINER_IMAGE_ID;
  if (!value || !IMAGE_ID_RE.test(value)) {
    throw new ReviewLspError("CONTAINER_IMAGE_INVALID", "container runtime did not provide a pinned Docker image ID");
  }
  return value;
}
