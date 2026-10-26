/**
 * The error vocabulary shared by both sides of the API.
 *
 * The backend maps each code to an HTTP status in its error middleware; the web
 * app maps each code to a message the user can act on. Keeping the union here
 * means neither side can invent a code the other does not understand, and
 * adding a code forces both to be updated.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'AUTH_MISSING_TOKEN',
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED_TOKEN',
  'AUTH_INVALID_CREDENTIALS',
  'RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_CONTENT_BLOCKED',
  'LLM_NO_CONTENT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes for which retrying the identical request may plausibly succeed.
 *
 * This drives whether the UI offers a retry button: a timeout or an upstream
 * outage is worth retrying, while a validation failure or a prompt blocked by
 * the provider's safety filter will fail identically every time.
 *
 * `satisfies` keeps every member checked against ErrorCode, so a typo or a
 * renamed code fails to compile rather than silently never matching.
 */
export const RETRYABLE_ERROR_CODES = [
  'RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
] as const satisfies readonly ErrorCode[];

export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

export function isRetryableErrorCode(code: ErrorCode): code is RetryableErrorCode {
  return (RETRYABLE_ERROR_CODES as readonly ErrorCode[]).includes(code);
}
