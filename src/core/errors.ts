export type ReviewLspErrorCode =
  | "GIT_COMMAND_FAILED"
  | "CANDIDATE_UNSUPPORTED"
  | "CANDIDATE_PATH_INVALID"
  | "CANDIDATE_INTEGRITY_INVALID"
  | "CANDIDATE_MISMATCH"
  | "CANDIDATE_RESOURCE_LIMIT"
  | "PROFILE_INVALID"
  | "ENVIRONMENT_PARTIAL"
  | "LSP_PROTOCOL_ERROR"
  | "LSP_TIMEOUT"
  | "LSP_CANCELLED"
  | "LSP_CAPABILITY_UNSUPPORTED"
  | "RECEIPT_INVALID";

export class ReviewLspError extends Error {
  constructor(public readonly code: ReviewLspErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReviewLspError";
  }
}
