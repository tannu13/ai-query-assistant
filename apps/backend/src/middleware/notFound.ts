import type { NextFunction, Request, Response } from 'express';

import { NotFoundError } from '../lib/errors';

/**
 * Terminal fallback for unmatched routes.
 *
 * Without it, Express answers an unknown path with its own HTML page, so the
 * single-envelope guarantee would hold for every failure except the most
 * common one a client hits by accident.
 */
export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError());
}

export default notFound;
