export type BindingState = "VERIFIED" | "PARTIAL" | "UNKNOWN" | "INVALID";
export type ExecutionStatus = "OK" | "ERROR" | "TIMEOUT" | "CANCELLED";
export type IsolationKind = "TRUSTED_LOCAL" | "CONTAINER_READ_ONLY";

export interface CandidateEntry {
  path: string;
  mode: string;
  oid: string;
  kind: "file" | "symlink";
  sha256: string;
  byte_count: number;
  symlink_target?: string;
}

export interface CandidateDescriptor {
  schema_version: "review-lsp.candidate.v1";
  candidate_id: string;
  repository_identity: string;
  repository_git_dir: string;
  git_object_format: string;
  commit_oid: string;
  tree_oid: string;
  source_manifest_sha256: string;
  source_root: string;
  entries: CandidateEntry[];
  isolation: IsolationKind;
  prepared_at: string;
}

export interface TypeScriptProfile {
  schema_version: "review-lsp.profile.typescript.v1";
  profile_id: string;
  language_id: "typescript";
  extensions: [".ts", ".tsx"];
  node_executable: string;
  node_executable_sha256: string;
  server_entrypoint: string;
  server_entrypoint_sha256: string;
  server_package_version: string;
  server_package_sha256: string;
  typescript_root: string;
  typescript_version: string;
  typescript_package_sha256: string;
  args: ["--stdio"];
  initialization_options: {
    disableAutomaticTypingAcquisition: true;
    plugins: [];
    tsserver: {
      path: string;
      fallbackPath: string;
      logVerbosity: "off";
      useSyntaxServer: "never";
    };
  };
  environment_allowlist: string[];
  document_limit_bytes: number;
  result_limit_bytes: number;
  profile_sha256: string;
}

export interface EnvironmentManifest {
  schema_version: "review-lsp.environment.v1";
  environment_manifest_sha256: string;
  candidate_id: string;
  profile_sha256: string;
  platform: string;
  arch: string;
  node_version: string;
  isolation: IsolationKind;
  isolation_identity: string;
  source_config_digests: Array<{ path: string; sha256: string }>;
  dependency_snapshot: { state: "NONE" | "BOUND" | "MISSING"; sha256?: string };
  external_inputs: string[];
  binding: BindingState;
  limitations: string[];
}

export interface SemanticReceipt {
  schema_version: "review-lsp.receipt.v1";
  receipt_id: string;
  candidate: {
    candidate_id: string;
    repository_identity: string;
    git_object_format: string;
    commit_oid: string;
    tree_oid: string;
    source_manifest_sha256: string;
  };
  environment_manifest_sha256: string;
  profile_sha256: string;
  session_id: string;
  session_epoch: number;
  operation: "hover" | "definition";
  document: {
    path: string;
    uri: string;
    sha256: string;
    version: number;
    language_id: string;
    position_encoding: "utf-16";
  };
  request: { line: number; character: number };
  execution_status: ExecutionStatus;
  source_binding: BindingState;
  environment_binding: BindingState;
  isolation: IsolationKind;
  result_scope: "SERVER_RESPONSE";
  limitations: string[];
  result: unknown;
  result_sha256: string;
  request_duration_ms: number;
  observed_at: string;
}

export interface DependencyInputFile {
  path: string;
  sha256: string;
  byte_count: number;
}

/**
 * The exact candidate-declared inputs that determine dependency resolution.
 *
 * `input_set_id` is content-addressed over everything that can change what an install
 * produces, so two candidates with the same inputs share an acquisition and a snapshot,
 * and any change to a manifest, the lockfile, a patch or admitted configuration produces a
 * different identity.
 */
export interface DependencyInputSet {
  schema_version: "review-lsp.dependency-inputs.v1";
  input_set_id: string;
  ecosystem: "node";
  package_manager: "pnpm";
  package_manager_version: string;
  platform: string;
  arch: string;
  lockfile_version: string;
  workspace_globs: string[];
  workspace_manifests: string[];
  npmrc_settings: Record<string, string>;
  files: DependencyInputFile[];
  files_sha256: string;
  patches: DependencyInputFile[];
  /**
   * TypeScript as the candidate declares it, recorded so the semantic profile router can
   * later select the project's own generation. Recording is not admission.
   */
  project_toolchain: {
    root_typescript?: string;
    workspace_typescript: Record<string, string>;
  };
}

export type AcquisitionState = "SATISFIED" | "ACQUISITION_REQUIRED" | "UNSUPPORTED";

export type AcquisitionNetworkPolicy = "OFFLINE" | "EXPLICIT_ACQUISITION";

export interface AcquisitionReport {
  schema_version: "review-lsp.dependency-acquisition.v1";
  state: AcquisitionState;
  input_set_id: string;
  package_manager: "pnpm";
  package_manager_version: string;
  network_policy: AcquisitionNetworkPolicy;
  /** True only when this run actually contacted a registry under an explicit policy. */
  network_used: boolean;
  script_policy: "IGNORE_SCRIPTS";
  lockfile_policy: "FROZEN";
  dependency_graph: "INCLUDES_DEV";
  store_directory: string;
  store_identity: string;
  acquired_at: string;
  /** Present when state is not SATISFIED: what is missing and what would resolve it. */
  limitation?: string;
  remediation?: string;
}
