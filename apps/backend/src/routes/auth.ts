import { loginRequestSchema, type LoginResponse } from '@repo/shared';
import bcrypt from 'bcrypt';
import { Router, type Request, type Response } from 'express';

import env from '../env';
import { AuthInvalidCredentialsError } from '../lib/errors';
import { parseOrThrow } from '../lib/validate';
import createRateLimit from '../middleware/rateLimit';
import { DEMO_USER_ID, signAccessToken } from '../services/token';

export const authRouter = Router();

/**
 * Brute-force budget for the login endpoint.
 *
 * Tighter than the query endpoint's on purpose: a password guess is cheap for
 * an attacker and expensive for this process (bcrypt at cost 10 is ~100ms of
 * CPU by design), so an unthrottled login is simultaneously a credential risk
 * and a self-inflicted denial of service. Keyed by IP because there is no
 * authenticated identity yet — which is also why it belongs here and not only
 * on the protected routes.
 */
const loginRateLimit = createRateLimit({ capacity: 10, refillPerMinute: 10 });

/**
 * Exchanges the demo credentials for a short-lived JWT.
 *
 * The brief permits a hardcoded static token. A real sign -> verify -> expire
 * cycle costs a handful of extra lines and makes the security story
 * demonstrable rather than asserted; the cost is this one route.
 */
authRouter.post(
  '/api/auth/login',
  loginRateLimit,
  async (req: Request, res: Response) => {
    const { email, password } = parseOrThrow(loginRequestSchema, req.body);

    const emailMatches =
      email.trim().toLowerCase() === env.DEMO_USER_EMAIL.toLowerCase();

    /**
     * The compare runs whether or not the email matched.
     *
     * Short-circuiting on an unknown email would make the endpoint a timing
     * oracle for account existence: a wrong email would answer in under a
     * millisecond while a right one spent ~100ms in bcrypt, which is
     * measurable over a network. Spending the hash unconditionally is the
     * standard fix, and with a single demo user it costs one wasted hash per
     * bad request.
     */
    const passwordMatches = await bcrypt.compare(
      password,
      env.DEMO_USER_PASSWORD_HASH,
    );

    if (!emailMatches || !passwordMatches) {
      // Logged with enough detail to diagnose, and answered with none of it.
      req.log.warn('login rejected', {
        emailMatched: emailMatches,
        passwordMatched: passwordMatches,
      });
      throw new AuthInvalidCredentialsError();
    }

    const { token, expiresIn } = signAccessToken(
      DEMO_USER_ID,
      env.DEMO_USER_EMAIL,
    );

    req.log.info('login succeeded', { subject: DEMO_USER_ID, expiresIn });

    const body: LoginResponse = { token, tokenType: 'Bearer', expiresIn };
    res.status(200).json(body);
  },
);

export default authRouter;
