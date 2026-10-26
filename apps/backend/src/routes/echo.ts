import { makeQueryRequestSchema } from '@repo/shared';
import { Router, type Request, type Response } from 'express';

import env from '../env';
import { parseOrThrow } from '../lib/validate';
import createRateLimit from '../middleware/rateLimit';

/**
 * TEMPORARY SCAFFOLDING — removed in Phase 5.
 *
 * The error spine, the body limit and the rate limiter all need a POST route
 * to be verifiable, and they are built before `/api/query` exists so that a
 * later failure in the query path is unambiguously the query path's fault.
 * This route validates with the real shared schema against the real
 * configured cap, so the checks it passes are the same checks `/api/query`
 * will have to pass.
 *
 * It is listed in the plan as scaffolding precisely so it cannot survive to
 * submission unnoticed.
 */
export const echoRouter = Router();

const echoRequestSchema = makeQueryRequestSchema(env.LLM_MAX_PROMPT_CHARS);

echoRouter.post(
  '/api/echo',
  createRateLimit({ capacity: 20, refillPerMinute: 20 }),
  (req: Request, res: Response) => {
    const { prompt } = parseOrThrow(echoRequestSchema, req.body);
    res.status(200).json({ prompt, requestId: req.requestId });
  },
);

export default echoRouter;
