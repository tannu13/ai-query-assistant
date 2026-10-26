import { useCallback, useRef, useState } from 'react';

import { ApiError, login as loginRequest, RequestAbortedError } from './api';

export interface Session {
  token: string;
  email: string;
}

export interface Auth {
  session: Session | null;
  pending: boolean;
  error: ApiError | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): void;
  /** Called by the query flow when the API rejects the token. */
  expireSession(): void;
}

/**
 * Holds the session token in React state and nowhere else.
 *
 * **Deliberately not `localStorage` or a cookie.** A token in `localStorage`
 * is readable by any script that runs on the page, so a single XSS — in the
 * app or in any dependency — exfiltrates it, and it survives the tab to be
 * stolen later. Memory-only means the token dies with the page and is
 * unreachable from injected script.
 *
 * The trade-off is real and is the reason most submissions reach for
 * `localStorage`: a refresh logs the user out. For a demo that is a fair
 * price, and the correct production answer is not `localStorage` either — it
 * is a short-lived access token in memory alongside a refresh token in an
 * `HttpOnly`, `Secure`, `SameSite` cookie, which is out of scope here and
 * recorded as such in the README.
 */
export function useAuth(): Auth {
  const [session, setSession] = useState<Session | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const signIn = useCallback(async (email: string, password: string) => {
    // Supersede an earlier submit rather than racing it: double-clicking
    // "sign in" must not leave two responses competing to set state.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setPending(true);
    setError(null);
    try {
      const result = await loginRequest(
        { email, password },
        controller.signal,
      );
      setSession({ token: result.token, email });
    } catch (caught) {
      // A superseded request is not a failure and must not be reported.
      if (caught instanceof RequestAbortedError) return;
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError('NETWORK_ERROR', 'Sign-in failed.', { cause: caught }),
      );
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }, []);

  const signOut = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setSession(null);
    setError(null);
  }, []);

  /**
   * Clears the session because the server rejected the token.
   *
   * There is deliberately no client-side expiry timer. The token's lifetime
   * is known, so one could pre-emptively log the user out — but the server is
   * the authority on whether a token is still valid, and a client clock that
   * runs fast would end a working session while one that runs slow would keep
   * a dead one. Acting on the server's `AUTH_EXPIRED_TOKEN` is both simpler
   * and correct, and it means the expiry path is genuinely exercised rather
   * than hidden behind a guess.
   */
  const expireSession = useCallback(() => {
    setSession(null);
    setError(
      new ApiError(
        'AUTH_EXPIRED_TOKEN',
        'Your session expired. Please sign in again.',
      ),
    );
  }, []);

  return { session, pending, error, signIn, signOut, expireSession };
}
