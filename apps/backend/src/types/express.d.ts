import type { Logger } from '../lib/logger';
import type { AuthContext } from '../middleware/requireAuth';

/**
 * Per-request fields this app attaches to `req`.
 *
 * Declared here rather than cast at each use site so that a handler reading
 * `req.requestId` is type-checked against the middleware that sets it.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id, set by the `requestId` middleware. */
      requestId: string;
      /** Logger bound to this request's id, set by the same middleware. */
      log: Logger;
      /**
       * Verified JWT claims. Optional because it is absent on every
       * unprotected route — so a handler that reads it must either sit behind
       * `requireAuth` or narrow it, and the compiler says which.
       */
      auth?: AuthContext;
    }
  }
}

export {};
