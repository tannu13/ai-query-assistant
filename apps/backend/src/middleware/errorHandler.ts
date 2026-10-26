import type { ErrorEnvelope } from '@repo/shared';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  AppError,
  INTERNAL_ERROR_MESSAGE,
  ValidationFailedError,
} from '../lib/errors';
import logger from '../lib/logger';
import { toFieldErrors } from '../lib/validate';

/**
 * Failures raised by `express.json` before any of this app's code runs. They
 * arrive as `http-errors` instances carrying a `type` discriminant, and
 * without this mapping Express's default handler answers them with an HTML
 * page — the one hole through which a non-envelope error response can escape
 * (plan §17 item 5).
 */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'The request body is larger than this API accepts.',
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.verify.failed': 'The request body could not be verified.',
  'encoding.unsupported': 'The request body uses an unsupported encoding.',
  'charset.unsupported': 'The request body uses an unsupported charset.',
  'request.aborted': 'The request was aborted before it completed.',
  'request.size.did.not.match':
    'The request body size did not match its Content-Length header.',
};

function bodyParserMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { type } = error as { type?: unknown };
  return typeof type === 'string' ? BODY_PARSER_MESSAGES[type] : undefined;
}

/**
 * Normalises anything throwable into an AppError.
 *
 * Note what is NOT here: no attempt to read a status off an arbitrary error,
 * and no reuse of an unknown error's message. Both are the usual route by
 * which an upstream message reaches a client.
 */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationFailedError(toFieldErrors(error));
  }

  const parserMessage = bodyParserMessage(error);
  if (parserMessage) {
    return new ValidationFailedError([], parserMessage);
  }

  return new AppError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, {
    cause: error,
  });
}

/**
 * The only place in this application that turns an exception into a response.
 *
 * Everything else throws. That is what makes the "no provider error reaches
 * the client verbatim" rule (plan §9) a property of the architecture rather
 * than something each handler has to remember.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Streaming had already begun, so the status and headers are committed and
  // an envelope is no longer possible. Hand back to Express, which destroys
  // the socket — the only honest option left.
  if (res.headersSent) {
    next(error);
    return;
  }

  /**
   * The socket is gone, so there is nothing to answer on. Log it and stop,
   * rather than writing to a destroyed stream and turning one failure into
   * two.
   */
  if (res.destroyed || !res.writable) {
    (req.log ?? logger).warn('request abandoned before a response was sent', {
      method: req.method,
      path: req.originalUrl,
      err: error,
    });
    return;
  }

  const appError = toAppError(error);
  const requestId = req.requestId ?? 'unassigned';
  const log = req.log ?? logger;

  const fields = {
    code: appError.code,
    status: appError.status,
    method: req.method,
    path: req.originalUrl,
    ...appError.context,
    // The full error, cause chain included. This is the only sink for
    // upstream detail; the response below sees none of it.
    err: appError,
  };

  // A 4xx is the client's problem and is expected traffic; a 5xx is ours and
  // is the thing worth alerting on. Logging both at the same level makes the
  // alertable signal unfindable.
  if (appError.status >= 500) log.error('request failed', fields);
  else log.warn('request rejected', fields);

  if (appError.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds));
  }

  const body: ErrorEnvelope = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId,
      ...(appError.details && appError.details.length > 0
        ? { details: appError.details }
        : {}),
    },
  };

  res.status(appError.status).json(body);
}

export default errorHandler;
