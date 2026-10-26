import type { QueryResponse } from '@repo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import ErrorNotice from './components/ErrorNotice';
import LoginForm from './components/LoginForm';
import QueryForm from './components/QueryForm';
import ResponsePanel from './components/ResponsePanel';
import { ApiError, postQuery, RequestAbortedError } from './lib/api';
import { useAuth } from './lib/useAuth';

export function App() {
  const auth = useAuth();
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [queryError, setQueryError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  /** The in-flight request, so a resubmit can supersede it. */
  const inFlight = useRef<AbortController | null>(null);
  /** Kept so the retry button can re-send the same prompt. */
  const lastPrompt = useRef<string>('');

  // Abort on unmount, so a resolving request cannot setState on a gone
  // component — and so the browser stops work nobody will see.
  useEffect(() => () => inFlight.current?.abort(), []);

  const runQuery = useCallback(
    async (prompt: string) => {
      const { session } = auth;
      if (!session) return;

      /**
       * Supersede rather than queue. Without this, submitting a second
       * prompt before the first returns leaves two responses racing, and
       * whichever finishes last wins — which is not necessarily the one the
       * user asked for second.
       */
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastPrompt.current = prompt;

      setPending(true);
      setQueryError(null);
      // Clear the previous answer so a stale one is never shown next to a
      // new in-flight request.
      setResponse(null);

      try {
        const result = await postQuery(prompt, session.token, controller.signal);
        setResponse(result);
      } catch (caught) {
        // A superseded request is not a failure. Returning here is what makes
        // "exactly one answer renders, and it is the second one" true.
        if (caught instanceof RequestAbortedError) return;

        if (caught instanceof ApiError) {
          /**
           * The server is the authority on token validity, so an expired or
           * rejected token returns the user to the login screen with the
           * cause named — rather than this app guessing from a local clock.
           */
          if (
            caught.code === 'AUTH_EXPIRED_TOKEN' ||
            caught.code === 'AUTH_INVALID_TOKEN' ||
            caught.code === 'AUTH_MISSING_TOKEN'
          ) {
            auth.expireSession();
            return;
          }
          setQueryError(caught);
          return;
        }

        setQueryError(
          new ApiError('NETWORK_ERROR', 'The request failed.', {
            cause: caught,
          }),
        );
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setPending(false);
        }
      }
    },
    [auth],
  );

  const cancel = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setPending(false);
  }, []);

  const retry = useCallback(() => {
    if (lastPrompt.current !== '') void runQuery(lastPrompt.current);
  }, [runQuery]);

  return (
    <div className="page">
      <header className="page__header">
        <h1>AI Query Assistant</h1>
        <p className="muted">
          Your question goes to a JWT-protected API, which calls the model.
          The provider credential never reaches this page.
        </p>
        {auth.session && (
          <div className="session">
            <span>
              Signed in as <strong>{auth.session.email}</strong>
            </span>
            <button
              type="button"
              className="button button--ghost"
              onClick={auth.signOut}
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      <main>
        {auth.session === null ? (
          <LoginForm
            pending={auth.pending}
            error={auth.error}
            onSubmit={(email, password) => void auth.signIn(email, password)}
          />
        ) : (
          <>
            <QueryForm
              pending={pending}
              onSubmit={(prompt) => void runQuery(prompt)}
              onCancel={cancel}
            />
            {queryError && <ErrorNotice error={queryError} onRetry={retry} />}
            {response && <ResponsePanel response={response} />}
          </>
        )}
      </main>

      <footer className="page__footer muted">
        <p>
          Token held in memory only — a page refresh signs you out, which is
          deliberate.
        </p>
      </footer>
    </div>
  );
}

export default App;
