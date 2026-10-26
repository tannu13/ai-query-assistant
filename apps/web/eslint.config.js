/**
 * The React config rather than the base one: it adds the browser globals this
 * app actually runs in, and `eslint-plugin-react-hooks`, whose
 * `exhaustive-deps` rule catches the stale-closure bugs that are easy to
 * write in `useCallback`/`useEffect` and hard to see in review.
 */
import { config } from '@repo/eslint-config/react-internal';

export default config;
