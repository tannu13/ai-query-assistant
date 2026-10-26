import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import logger from '../lib/logger';

/** Response header carrying the id back, so a user can quote it in a report. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Assigns a correlation id, binds a logger to it, and emits one line per
 * completed request. All three together are what make the id worth having:
 * the error envelope quotes it, every log line from that request carries it,
 * and the access line records how the request ended.
 *
 * Mounted first, ahead of body parsing, so that a body-parser failure is
 * still attributable — otherwise the one class of error most likely to be
 * malformed is the one with no id.
 *
 * The inbound `X-Request-Id` is deliberately NOT adopted. A client-supplied
 * value lands verbatim in the logs, which is a log-injection and
 * log-poisoning vector; honouring it would need a format allowlist first. In
 * production behind a load balancer the right move is to adopt the
 * infrastructure's trace header (`X-Amzn-Trace-Id`), which is not
 * attacker-controlled.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  req.requestId = id;
  req.log = logger.child({ requestId: id });
  res.setHeader(REQUEST_ID_HEADER, id);

  const startedAt = performance.now();
  res.on('finish', () => {
    req.log.info('request completed', {
      method: req.method,
      // `originalUrl` rather than `url`: inside a mounted router `url` has
      // the mount prefix stripped, which makes the log line ambiguous.
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    });
  });

  next();
}

export default requestId;
