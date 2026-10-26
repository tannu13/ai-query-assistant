import { isRetryableErrorCode, type ErrorCode } from '@repo/shared';

import type { ApiError } from '../lib/api';

/**
 * Cause-specific guidance, keyed on the stable code from the shared contract.
 *
 * The point of the whole `ErrorCode` union is that a timeout, a blocked
 * prompt and an expired token are three different situations with three
 * different things for the user to do — collapsing them into "something went
 * wrong" throws away information the backend went to trouble to preserve.
 *
 * The server's `message` is already safe to display, so this adds the
 * *next step* rather than restating the problem.
 */
const GUIDANCE: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'Check the highlighted field and try again.',
  NOT_FOUND: 'The app may be pointed at the wrong API URL.',
  AUTH_MISSING_TOKEN: 'Sign in to continue.',
  AUTH_INVALID_TOKEN: 'Sign in again to get a fresh token.',
  AUTH_EXPIRED_TOKEN: 'Sessions are short-lived by design. Sign in again.',
  AUTH_INVALID_CREDENTIALS:
    'Use the demo credentials shown above the form.',
  RATE_LIMITED: 'You are sending requests faster than the limit allows.',
  LLM_TIMEOUT: 'The model took too long. Retrying often succeeds.',
  LLM_RATE_LIMITED: 'The model is busy. Wait a moment, then retry.',
  LLM_UNAVAILABLE: 'The model service is not responding right now.',
  LLM_CONTENT_BLOCKED:
    'The model declined this prompt on safety grounds. Rephrasing usually helps.',
  LLM_NO_CONTENT: 'The model returned nothing usable. Try rewording.',
  INTERNAL_ERROR: 'Something broke on the server. Quote the request id below.',
};

const CLIENT_GUIDANCE: Record<string, string> = {
  NETWORK_ERROR:
    'The API did not respond at all. Is the backend running on the expected port?',
  MALFORMED_RESPONSE:
    'The response did not match the API contract — the client and server may be out of step.',
};

export interface ErrorNoticeProps {
  error: ApiError;
  onRetry?: () => void;
}

export function ErrorNotice({ error, onRetry }: ErrorNoticeProps) {
  const guidance =
    (GUIDANCE as Record<string, string | undefined>)[error.code] ??
    CLIENT_GUIDANCE[error.code] ??
    '';

  /**
   * Retry is offered only where it can plausibly work. `isRetryableErrorCode`
   * comes from the shared contract, so the backend decides — a blocked prompt
   * or a validation failure will fail identically every time, and a retry
   * button there teaches the user to distrust the button.
   *
   * NETWORK_ERROR is retryable for the obvious reason that the server may
   * simply have been starting up.
   */
  const retryable =
    error.code === 'NETWORK_ERROR' ||
    isRetryableErrorCode(error.code as ErrorCode);

  return (
    // `assertive` rather than `polite`: an error interrupts the task, and a
    // screen-reader user needs it now rather than after the current phrase.
    <div className="notice notice--error" role="alert" aria-live="assertive">
      <div className="notice__body">
        <p className="notice__message">{error.message}</p>
        {guidance !== '' && <p className="notice__guidance">{guidance}</p>}

        {error.details.length > 0 && (
          <ul className="notice__details">
            {error.details.map((detail) => (
              <li key={`${detail.path}:${detail.message}`}>
                <code>{detail.path}</code> — {detail.message}
              </li>
            ))}
          </ul>
        )}

        <p className="notice__meta">
          <code>{error.code}</code>
          {error.requestId !== null && (
            <>
              {' · request '}
              {/* Surfaced so a user can quote it and have the failure found
                  in the logs. */}
              <code>{error.requestId}</code>
            </>
          )}
        </p>
      </div>

      {retryable && onRetry && (
        <button type="button" className="button button--ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export default ErrorNotice;
