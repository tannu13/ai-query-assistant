import type { NextFunction, Request, Response } from 'express';

import { AuthMissingTokenError } from '../lib/errors';
import { verifyAccessToken } from '../services/token';

export interface AuthContext {
  /** Opaque subject id from the `sub` claim. */
  subject: string;
  email: string;
  /** `exp`, in seconds since the epoch. */
  expiresAt: number;
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header.
 *
 * Returns undefined — meaning AUTH_MISSING_TOKEN — when the header is absent,
 * uses a different scheme, or carries an empty token. A present-but-garbage
 * token is a different thing, and gets AUTH_INVALID_TOKEN from the verifier:
 * the first says "you did not authenticate", the second says "you tried and
 * it did not hold up", and a client can act on the difference.
 */
function bearerToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header === undefined) return undefined;

  // Case-insensitive scheme, single space, per RFC 6750. Being strict about
  // the rest avoids silently accepting `Bearer: <token>` or a doubled scheme.
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * Gate for protected routes.
 *
 * Throws rather than responding, so the single error-translation point still
 * owns the response shape — an auth middleware that writes its own 401 is the
 * usual reason one endpoint's errors look different from the rest.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearerToken(req);
  if (token === undefined) {
    next(new AuthMissingTokenError());
    return;
  }

  const claims = verifyAccessToken(token);
  req.auth = {
    subject: claims.sub,
    email: claims.email,
    expiresAt: claims.exp,
  };

  // Bind the subject to this request's logger so every later line is
  // attributable without each call site remembering to pass it.
  req.log = req.log.child({ subject: claims.sub });

  next();
}

export default requireAuth;
