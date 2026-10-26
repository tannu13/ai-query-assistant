import jwt, {
  JsonWebTokenError,
  NotBeforeError,
  TokenExpiredError,
} from 'jsonwebtoken';
import z from 'zod';

import env from '../env';
import {
  AuthExpiredTokenError,
  AuthInvalidTokenError,
} from '../lib/errors';

/**
 * The algorithm this service signs with and the only one it will verify.
 *
 * Pinned on BOTH sides. On verify it is the control that matters: left
 * unspecified, `jsonwebtoken` infers the acceptable set from the key type,
 * which for a string secret is the whole HMAC family — so a token the server
 * never intended to issue verifies anyway. Measured, not assumed: see the
 * Phase 3 notes in specs/implementation-plan.md.
 */
const ALGORITHM = 'HS256' as const;

/** Opaque subject id. Deliberately not the email — `sub` is an identifier,
 * and putting PII in it means the claim cannot be logged freely. */
export const DEMO_USER_ID = 'demo-user';

/**
 * Claims this app requires, checked after the signature verifies.
 *
 * A valid signature proves the token was issued by this service; it says
 * nothing about the payload's shape. Treating a verified payload as
 * structurally trusted is how `req.auth.email` becomes `undefined` three
 * layers downstream.
 */
const accessTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  iat: z.number(),
  exp: z.number(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export interface IssuedToken {
  token: string;
  /** Lifetime in seconds, so the client need not decode the JWT to know it. */
  expiresIn: number;
}

export function signAccessToken(subject: string, email: string): IssuedToken {
  const token = jwt.sign({ email }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  // Derived from the signed token rather than by re-parsing JWT_EXPIRES_IN,
  // so `expiresIn` cannot disagree with the `exp` claim it describes.
  const claims = accessTokenClaimsSchema.parse(jwt.decode(token));

  return { token, expiresIn: claims.exp - claims.iat };
}

/**
 * Verifies a token and returns its claims, or throws the specific auth error.
 *
 * `issuer` and `audience` are asserted here, not merely stamped at signing
 * time: a claim that is written and never checked is decoration. Asserting
 * them is what stops a token minted by a different service — or for a
 * different audience, such as a future admin API sharing the secret — from
 * being accepted here.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
  } catch (error) {
    // Expiry is the one failure that is both expected and actionable by the
    // user, so it gets its own code; everything else — malformed, bad
    // signature, wrong algorithm, wrong issuer, wrong audience, not-yet-valid
    // — is indistinguishable from tampering and collapses into one.
    if (error instanceof TokenExpiredError) {
      throw new AuthExpiredTokenError(error);
    }
    if (error instanceof JsonWebTokenError || error instanceof NotBeforeError) {
      throw new AuthInvalidTokenError(error);
    }
    throw error;
  }

  const claims = accessTokenClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw new AuthInvalidTokenError(claims.error);
  }
  return claims.data;
}
