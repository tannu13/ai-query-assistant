import type { MeResponse } from '@repo/shared';
import { Router, type Request, type Response } from 'express';

import requireAuth from '../middleware/requireAuth';

export const meRouter = Router();

/**
 * Echoes the verified claims behind the current token.
 *
 * Phase 3 has to be verifiable before `/api/query` exists, so it needs a
 * protected route of its own — otherwise an auth failure and an LLM failure
 * would surface at the same gate and be indistinguishable. Unlike the Phase 2
 * echo route this one ships: it is five lines, and it is the clearest way for
 * the README to show what a token actually carries.
 */
meRouter.get('/api/me', requireAuth, (req: Request, res: Response) => {
  // Non-null is safe and type-checked here only because `requireAuth` sits
  // directly in front of this handler; the field is optional precisely so
  // that an unprotected route cannot read it by accident.
  const auth = req.auth!;

  const body: MeResponse = {
    sub: auth.subject,
    email: auth.email,
    exp: auth.expiresAt,
    expiresInSeconds: auth.expiresAt - Math.floor(Date.now() / 1000),
  };
  res.status(200).json(body);
});

export default meRouter;
