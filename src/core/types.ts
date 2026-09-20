export type BindingState = "VERIFIED" | "PARTIAL" | "UNKNOWN" | "INVALID";
export type ExecutionStatus = "OK" | "ERROR" | "TIMEOUT" | "CANCELLED";
export type IsolationKind = "TRUSTED_LOCAL" | "CONTAINER_READ_ONLY" | "MACOS_SANDBOX";

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
  server_runtime_root: string;
  server_runtime_kind: "BUNDLED" | "PACKAGE";
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
  dependency_snapshot: {
    state: "NONE" | "BOUND" | "MISSING" | "UNSUPPORTED";
    snapshot_id?: string;
    sha256?: string;
  };
  projection: {
    projection_id: string;
    projection_implementation: string;
    derived_artifact_ids: string[];
    derived_artifact_tree_manifests: string[];
    entry_point_gate_state: "COMPLETE" | "INCOMPLETE";
    entry_point_targets_checked: number;
  } | null;
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
    /** What the candidate source holds at the requested position. */
    context: CoordinateContext;
  };
  request: { line: number; character: number };
  execution_status: ExecutionStatus;
  source_binding: BindingState;
  environment_binding: BindingState;
  /**
   * How the answering engine relates to the project's declared toolchain.
   *
   * Recorded separately from `environment_binding` so that a reproducible environment is
   * never read as evidence that the project's own semantics answered.
   */
  semantic_toolchain: SemanticToolchainEvidence;
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

export interface DependencyTreeEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  sha256?: string;
  byte_count?: number;
  executable?: boolean;
  symlink_target?: string;
}

export type DependencySnapshotState = "NONE" | "BOUND" | "MISSING" | "UNSUPPORTED";

/**
 * A sealed, content-addressed dependency projection.
 *
 * `snapshot_id` binds the semantic inputs and the resulting tree manifest only.
 * `materialization_method` and `created_at` are operational metadata: two snapshots that
 * publish byte-identical trees from identical inputs are the same snapshot whether they were
 * cloned or copied.
 */
export interface DependencySnapshotDescriptor {
  schema_version: "review-lsp.dependency-snapshot.v1";
  snapshot_id: string;
  ecosystem: "node";
  package_manager: "pnpm";
  package_manager_version: string;
  platform: string;
  arch: string;
  input_set_id: string;
  input_manifest: DependencyInputFile[];
  lockfile_binding: DependencyInputFile;
  workspace_binding: DependencyInputFile | null;
  patch_binding: DependencyInputFile[];
  config_binding: Record<string, string>;
  network_policy: "OFFLINE";
  script_policy: "IGNORE_SCRIPTS";
  lockfile_policy: "FROZEN";
  dependency_graph: "INCLUDES_DEV";
  tree_manifest_sha256: string;
  dependency_root: string;
  file_count: number;
  symlink_count: number;
  total_bytes: number;
  materialization_method: string;
  created_at: string;
}

export interface EntryPointFinding {
  manifest_path: string;
  package_name: string | null;
  field: string;
  declared_target: string;
  limitation: string;
}

/**
 * Whether every workspace package's declared semantic entry point is actually present.
 *
 * `INCOMPLETE` must prevent VERIFIED: a linked-but-empty entry point makes TypeScript resolve
 * that package to nothing, which degrades queries without any other signal.
 */
export interface EntryPointGateResult {
  schema_version: "review-lsp.entry-point-gate.v1";
  state: "COMPLETE" | "INCOMPLETE";
  targets_checked: number;
  findings: EntryPointFinding[];
}

export type ProjectionUriClass =
  | "CANDIDATE_SOURCE"
  | "DEPENDENCY_SNAPSHOT"
  | "DERIVED_WORKSPACE_ARTIFACT"
  | "TOOLCHAIN"
  | "UNBOUND";

export interface ProjectionUriClassification {
  uri: string;
  path: string;
  realpath: string | null;
  classification: ProjectionUriClass;
  /** Path relative to the admitted root, when one was identified. */
  relative_path?: string;
  reason?: string;
}

/**
 * An execution view built from an exact candidate plus an admitted dependency snapshot.
 *
 * The candidate remains the source authority: every source path in the projection must hash
 * back to its candidate entry, and the projection is what the language server is pointed at.
 */
export interface DerivedWorkspaceArtifactDescriptor {
  schema_version: "review-lsp.derived-workspace-artifact.v1";
  artifact_id: string;
  candidate_id: string;
  source_manifest_sha256: string;
  dependency_snapshot_id: string;
  package_manifest_path: string;
  package_name: string | null;
  project_config_path: string;
  project_config_sha256: string;
  config_chain: Array<{ path: string; sha256: string }>;
  compiler_artifact_id: string;
  compiler_version: string;
  compiler_entrypoint: string;
  compiler_entrypoint_sha256: string;
  node_executable: string;
  node_executable_sha256: string;
  fixed_compiler_argv: string[];
  mount_relative_path: string;
  execution_profile_kind: IsolationKind;
  /** Stable binding for the enforcement implementation; unlike identity, excludes random staging paths. */
  execution_profile_binding: string;
  /** Exact runtime profile identity used for the build, retained for audit but not artifact addressing. */
  execution_profile_identity: string;
  compiler_exit_code: number;
  diagnostic_error_count: number | null;
  stdout_sha256: string;
  stderr_sha256: string;
  output_tree_manifest_sha256: string;
  output_root: string;
  output_file_count: number;
  output_total_bytes: number;
  strong_admission: boolean;
  limitation: string | null;
  created_at: string;
}

export interface ProjectionDescriptor {
  schema_version: "review-lsp.projection.v1";
  projection_id: string;
  projection_implementation: string;
  candidate_id: string;
  source_manifest_sha256: string;
  dependency_snapshot_id: string | null;
  dependency_tree_manifest_sha256: string | null;
  derived_artifact_ids: string[];
  derived_artifact_tree_manifests: string[];
  isolation: IsolationKind;
  execution_root: string;
  dependency_mounts: string[];
  derived_artifact_mounts: string[];
  derived_artifact_roots: string[];
  /** Sorted candidate-relative workspace manifests whose declared entry points this projection gates. */
  workspace_manifests: string[];
  entry_point_gate: EntryPointGateResult;
  created_at: string;
}

export interface ResolvingProject {
  state: "RESOLVED" | "UNRESOLVED";
  config_path: string | null;
  config_sha256: string | null;
  project_root: string | null;
}

/**
 * How the engine that answered relates to the toolchain the candidate project declares.
 *
 * `VERIFIED` describes the environment's reproducibility; it says nothing about whether the
 * project's own semantics answered. That is this field's job, and the two must not be
 * conflated.
 */
export type ToolchainAlignment = "EXACT_PROJECT" | "COMPATIBILITY_PROFILE" | "MISMATCH" | "UNKNOWN";

export interface ToolchainAssessment {
  alignment: ToolchainAlignment;
  reason: string | null;
}

export interface SemanticToolchainEvidence {
  resolving_project: ResolvingProject;
  resolving_project_identity: string;
  project_toolchain: {
    typescript_version: string | null;
    source: "DEPENDENCY_SNAPSHOT" | "MANIFEST_DECLARATION" | "ABSENT";
  };
  semantic_engine: {
    implementation: string;
    typescript_version: string;
    is_project_admitted: boolean;
  };
  /**
   * The candidate's own engine, when the admitted dependency state selects one.
   *
   * Recorded whether or not it answered: knowing that an exact engine exists and was not used
   * is the difference between "no project engine" and "a project engine that could not be
   * trusted to run here".
   */
  candidate_engine: {
    artifact_id: string;
    version: string;
    engine_kind: "TSSERVER_LEGACY" | "NATIVE_LSP";
    tree_manifest_sha256: string;
  } | null;
  execution_profile: {
    kind: IsolationKind;
    enforced: boolean;
    identity: string;
  };
  toolchain_alignment: ToolchainAlignment;
  toolchain_alignment_reason: string | null;
  /** Why strong project alignment was not claimed, when it was not. */
  exact_project_blocked_by: string | null;
}

/**
 * A candidate-selected semantic engine bound by exact identity.
 *
 * The version alone does not say which bytes would run, so identity covers the whole engine
 * tree. `policy` records the conditions the engine must be launched under, with the artifact
 * rather than at the launch site, so a receipt can state them.
 */
export interface AdmittedEngineArtifact {
  schema_version: "review-lsp.engine-artifact.v1";
  artifact_id: string;
  package_name: "typescript";
  version: string;
  engine_kind: "TSSERVER_LEGACY" | "NATIVE_LSP";
  tree_manifest_sha256: string;
  dependency_snapshot_id: string;
  engine_root: string;
  entrypoint: string;
  entrypoint_sha256: string;
  file_count: number;
  policy: {
    plugins: "DISABLED";
    automatic_type_acquisition: "DISABLED";
    network: "DENIED";
  };
}

/**
 * The execution profile a candidate-selected engine would run under.
 *
 * `enforced` is what admission turns on. A profile that only describes the host, without
 * constraining what the engine can reach, does not become enforcement by being named.
 */
export interface ExecutionProfile {
  schema_version: "review-lsp.execution-profile.v1";
  kind: IsolationKind;
  enforced: boolean;
  platform: string;
  identity: string;
  reason: string | null;
}

/**
 * Everything that must be identical before two callers may share a semantic runtime.
 *
 * Anything absent from this key is something two callers could legitimately disagree about
 * while using the same runtime, so absence is a correctness claim, not an omission.
 */
export interface RuntimeKey {
  candidate_id: string;
  source_manifest_sha256: string;
  dependency_snapshot_id: string | null;
  derived_artifact_snapshot_ids: string[];
  projection_id: string | null;
  profile_sha256: string;
  /**
   * The project whose toolchain applies. A monorepo can resolve different TypeScript
   * generations per package, and one language server cannot serve both.
   */
  resolving_project_identity: string | null;
  isolation: IsolationKind;
}

/**
 * What the bound candidate source actually holds at the requested position.
 *
 * Returned with every answer so a caller can see what it asked about. Provenance cannot
 * detect a mis-aimed question, because a mis-aimed question has perfectly sound provenance.
 */
export interface CoordinateContext {
  line_text: string;
  line_sha256: string;
  /** Identifier-ish run containing the requested column, or null when there is none. */
  token: string | null;
  line_length: number;
}

/** What the caller says it is aiming at. Any stated field that does not match fails the request. */
export interface CoordinateExpectation {
  token?: string;
  line_sha256?: string;
  line_contains?: string;
}
