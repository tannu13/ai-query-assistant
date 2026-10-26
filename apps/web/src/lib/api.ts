import {
  errorEnvelopeSchema,
  loginResponseSchema,
  queryResponseSchema,
  type ErrorCode,
  type LoginRequest,
  type LoginResponse,
  type QueryResponse,
} from '@repo/shared';

/**
 * Failures the client can originate, which the server's `ErrorCode` union
 * knows nothing about.
 *
 * Kept separate rather than added to the shared union on purpose: that union
 * is the wire contract, and every member of it has an HTTP status in the
 * backend's translation table. A fetch that never reached the server has no
 * status, so putting it there would force a meaningless one and weaken the
 * exhaustiveness check that makes the table trustworthy.
 */
export const CLIENT_ERROR_CODES = [
  /** `fetch` rejected — server down, DNS, offline, blocked by CORS. */
  'NETWORK_ERROR',
  /** A 2xx body that does not match the shared schema. */
  'MALFORMED_RESPONSE',
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type AnyErrorCode = ErrorCode | ClientErrorCode;

export interface FieldError {
  path: string;
  message: string;
}

/**
 * One error type for the whole client, carrying the code the UI switches on.
 *
 * `requestId` is deliberately surfaced: it is what lets a user quote a
 * failure back and have it found in the logs.
 */
export class ApiError extends Error {
  readonly code: AnyErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly details: FieldError[];

  constructor(
    code: AnyErrorCode,
    message: string,
    options: {
      status?: number | null;
      requestId?: string | null;
      details?: FieldError[];
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? null;
    this.requestId = options.requestId ?? null;
    this.details = options.details ?? [];
  }
}

/**
 * Raised when a request is cancelled by the caller, and distinct from
 * ApiError because it is not a failure to report.
 *
 * The UI must not render anything for a superseded request — showing "request
 * cancelled" where the new answer is about to appear would be noise.
 */
export class RequestAbortedError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'RequestAbortedError';
  }
}

/**
 * Trailing slash trimmed so `${BASE}/api/query` cannot become a double slash,
 * which some proxies answer with a redirect that drops the Authorization
 * header.
 */
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  );
}

/**
 * Builds an ApiError from a non-2xx response.
 *
 * Parsed through the shared envelope schema, so a body that does not match
 * the contract is reported as such rather than silently read as `undefined`.
 * That matters in practice: a 502 from a load balancer, or a 404 from a
 * misconfigured base URL, arrives as HTML, and `body.error.code` on HTML is
 * exactly the class of bug this whole contract exists to prevent.
 */
async function errorFromResponse(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('X-Request-Id');

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return new ApiError(
      'MALFORMED_RESPONSE',
      `The server returned an unreadable response (HTTP ${response.status}).`,
      { status: response.status, requestId },
    );
  }

  const parsed = errorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return new ApiError(
      'MALFORMED_RESPONSE',
      `The server returned an unexpected error format (HTTP ${response.status}).`,
      { status: response.status, requestId, cause: parsed.error },
    );
  }

  const { error } = parsed.data;
  return new ApiError(error.code, error.message, {
    status: response.status,
    requestId: error.requestId,
    details: error.details,
  });
}

interface RequestOptions<T> {
  path: string;
  method: 'GET' | 'POST';
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown } };
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
}

async function request<T>({
  path,
  method,
  schema,
  body,
  token,
  signal,
}: RequestOptions<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbort(error)) throw new RequestAbortedError();
    // `fetch` rejects for a down server, DNS failure, offline browser, or a
    // blocked CORS preflight — and the browser deliberately hides which, so
    // the message cannot be more specific than this without lying.
    throw new ApiError(
      'NETWORK_ERROR',
      'Could not reach the server. Check that the API is running.',
      { cause: error },
    );
  }

  if (!response.ok) throw await errorFromResponse(response);

  const raw = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // The server said 200 but sent something the contract does not describe.
    // Reported rather than rendered: this is how `undefined` ends up on
    // screen in the naive version.
    throw new ApiError(
      'MALFORMED_RESPONSE',
      'The server returned a response this app does not understand.',
      {
        status: response.status,
        requestId: response.headers.get('X-Request-Id'),
        cause: parsed.error,
      },
    );
  }
  return parsed.data;
}

export function login(
  credentials: LoginRequest,
  signal?: AbortSignal,
): Promise<LoginResponse> {
  return request({
    path: '/api/auth/login',
    method: 'POST',
    schema: loginResponseSchema,
    body: credentials,
    signal,
  });
}

export function postQuery(
  prompt: string,
  token: string,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  return request({
    path: '/api/query',
    method: 'POST',
    schema: queryResponseSchema,
    body: { prompt },
    token,
    signal,
  });
}
