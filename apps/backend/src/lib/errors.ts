import type { ErrorCode } from '@repo/shared';

/** Field-level validation detail. Only VALIDATION_FAILED carries these. */
export interface FieldError {
  path: string;
  message: string;
}

/**
 * The single code -> HTTP status table (plan §9).
 *
 * `satisfies Record<ErrorCode, number>` makes it exhaustive by construction:
 * adding a code to the shared union without giving it a status here is a
 * compile error rather than a 500 discovered in production.
 */
export const HTTP_STATUS_BY_ERROR_CODE = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  AUTH_MISSING_TOKEN: 401,
  AUTH_INVALID_TOKEN: 401,
  AUTH_EXPIRED_TOKEN: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  RATE_LIMITED: 429,
  LLM_TIMEOUT: 504,
  LLM_RATE_LIMITED: 429,
  LLM_UNAVAILABLE: 502,
  LLM_CONTENT_BLOCKED: 422,
  LLM_NO_CONTENT: 502,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

export interface AppErrorOptions {
  /** Field-level detail. This is the only extra that reaches the client. */
  details?: FieldError[];
  /**
   * The underlying failure. Logged in full; NEVER serialised into a response.
   * Upstream provider errors can carry internal endpoints, quota details,
   * project identifiers and — worst case — fragments of the credential used.
   */
  cause?: unknown;
  /** Extra context for the log line only. Same no-serialisation rule. */
  context?: Record<string, unknown>;
  /** Seconds, for a Retry-After header. */
  retryAfterSeconds?: number;
}

/**
 * Base class for every failure this application raises deliberately.
 *
 * The invariant that makes the one-envelope rule enforceable rather than
 * merely intended: `message` on an AppError is always safe to show a user,
 * because it was written at the throw site by this codebase. Anything unsafe
 * goes in `cause`, which only the logger reads.
 *
 * A failure arriving at the error handler *without* an AppError wrapper is by
 * definition unexpected, so its message is replaced with a generic one rather
 * than guessed at. That is the whole reason this class exists instead of
 * attaching a status to plain Errors.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: FieldError[];
  readonly context?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    // `new.target` so subclasses report their own name without each one
    // repeating the assignment.
    this.name = new.target.name;
    this.code = code;
    this.status = HTTP_STATUS_BY_ERROR_CODE[code];
    this.details = options.details;
    this.context = options.context;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class ValidationFailedError extends AppError {
  constructor(
    details: FieldError[] = [],
    message = 'The request is not valid.',
  ) {
    super('VALIDATION_FAILED', message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource does not exist.') {
    super('NOT_FOUND', message);
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      'RATE_LIMITED',
      `Too many requests. Try again in ${retryAfterSeconds} second(s).`,
      { retryAfterSeconds },
    );
  }
}

/**
 * Four distinguishable 401s rather than one generic one.
 *
 * The distinction is not pedantry: the web app returns an expired session to
 * the login screen with "your session expired", while a bad signature is a
 * tampering signal worth a different message and a different log severity.
 * Collapsing them would also make the logs undiagnosable — "401" tells you
 * nothing about whether a client is broken, a token is stale, or someone is
 * probing.
 *
 * What is NOT distinguished, deliberately: which half of a credential pair
 * was wrong. See AuthInvalidCredentialsError.
 */
export class AuthMissingTokenError extends AppError {
  constructor() {
    super(
      'AUTH_MISSING_TOKEN',
      'This endpoint requires a bearer token. Sign in first.',
    );
  }
}

export class AuthInvalidTokenError extends AppError {
  constructor(cause?: unknown) {
    super('AUTH_INVALID_TOKEN', 'Your session token is not valid.', { cause });
  }
}

export class AuthExpiredTokenError extends AppError {
  constructor(cause?: unknown) {
    super(
      'AUTH_EXPIRED_TOKEN',
      'Your session has expired. Sign in again.',
      { cause },
    );
  }
}

/**
 * One message for both "no such user" and "wrong password", on purpose.
 *
 * Saying which was wrong turns the login endpoint into an account-existence
 * oracle. The timing side of the same leak is handled in the route, which
 * runs the bcrypt compare whether or not the email matched.
 */
export class AuthInvalidCredentialsError extends AppError {
  constructor() {
    super('AUTH_INVALID_CREDENTIALS', 'Incorrect email or password.');
  }
}

/**
 * Generic message for anything that reaches the error handler unwrapped.
 *
 * Deliberately says nothing about the cause: the request id in the same
 * envelope is how a user-visible failure is tied back to the log line that
 * holds the real detail.
 */
export const INTERNAL_ERROR_MESSAGE =
  'Something went wrong on our side. Please try again.';
