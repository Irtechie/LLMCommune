// @ts-check
/**
 * Stable error codes for LLMCommune API responses.
 * Every 4xx/5xx response includes a `code` field from this set.
 *
 * @enum {string}
 */
export const ErrorCode = /** @type {const} */ ({
  // 400-level
  PROFILE_NOT_FOUND:       "PROFILE_NOT_FOUND",
  LANE_INVALID:            "LANE_INVALID",
  LANE_NOT_ALLOWED:        "LANE_NOT_ALLOWED",
  LANE_OCCUPIED:           "LANE_OCCUPIED",
  POLICY_BLOCKED:          "POLICY_BLOCKED",
  INPUT_INVALID:           "INPUT_INVALID",
  BODY_TOO_LARGE:          "BODY_TOO_LARGE",
  BODY_PARSE_ERROR:        "BODY_PARSE_ERROR",
  BODY_TIMEOUT:            "BODY_TIMEOUT",
  RATE_LIMITED:            "RATE_LIMITED",
  UNAUTHORIZED:            "UNAUTHORIZED",
  JOB_NOT_FOUND:           "JOB_NOT_FOUND",
  DRY_RUN_ONLY:            "DRY_RUN_ONLY",
  DRAFT_NOT_FOUND:         "DRAFT_NOT_FOUND",
  PRESET_NOT_FOUND:        "PRESET_NOT_FOUND",
  REVISION_CONFLICT:       "REVISION_CONFLICT",
  EVIDENCE_UNAVAILABLE:    "EVIDENCE_UNAVAILABLE",
  // 500-level
  ACTIVATION_FAILED:       "ACTIVATION_FAILED",
  ACTIVATION_TIMEOUT:      "ACTIVATION_TIMEOUT",
  LAUNCH_FAILED:           "LAUNCH_FAILED",
  WORKER_NOT_CLEAR:        "WORKER_NOT_CLEAR",
  CONFIG_INVALID:          "CONFIG_INVALID",
  INTERNAL_ERROR:          "INTERNAL_ERROR",
  // set management
  CONCURRENT_ACTIVATION:   "CONCURRENT_ACTIVATION",
  ACTIVATION_SUPERSEDED:   "ACTIVATION_SUPERSEDED",
  RECONCILE_REQUIRED:      "RECONCILE_REQUIRED",
  SET_NOT_FOUND:           "SET_NOT_FOUND",
  SET_LIMIT_REACHED:       "SET_LIMIT_REACHED",
  HARDWARE_UNAVAILABLE:    "HARDWARE_UNAVAILABLE",
  SET_ACTIVE:              "SET_ACTIVE",
});

/**
 * Build a standard error payload for API responses.
 * @param {string} code - One of ErrorCode values
 * @param {string} detail - Human-readable detail (safe to show to caller)
 * @param {number} [status] - HTTP status code
 * @returns {{ ok: false, accepted: false, code: string, detail: string }}
 */
export function apiError(code, detail, status) {
  void status; // status is used by callers, kept here for documentation
  return { ok: false, accepted: false, code, detail };
}
