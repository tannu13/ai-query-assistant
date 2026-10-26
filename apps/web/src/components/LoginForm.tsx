import { useState, type FormEvent } from 'react';

import type { ApiError } from '../lib/api';
import ErrorNotice from './ErrorNotice';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password';

export interface LoginFormProps {
  pending: boolean;
  error: ApiError | null;
  onSubmit(email: string, password: string): void;
}

export function LoginForm({ pending, error, onSubmit }: LoginFormProps) {
  // Prefilled, because these are the documented public demo credentials and
  // making a reviewer type them adds friction without adding security.
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!pending) onSubmit(email, password);
  }

  return (
    <section className="card" aria-labelledby="signin-heading">
      <h2 id="signin-heading">Sign in</h2>
      <p className="muted">
        The query endpoint is JWT-protected. Signing in exchanges these
        credentials for a short-lived token, held in memory only.
      </p>

      {/* `noValidate` so the browser's own bubbles do not pre-empt the
          server's validation messages, which are the ones under test. */}
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            required
          />
        </div>

        <button type="submit" className="button" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {error && <ErrorNotice error={error} />}
    </section>
  );
}

export default LoginForm;
