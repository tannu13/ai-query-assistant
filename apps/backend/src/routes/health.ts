import type { HealthResponse } from '@repo/shared';
import { Router, type Request, type Response } from 'express';

import env from '../env';

export const healthRouter = Router();

/**
 * Liveness only, and deliberately so.
 *
 * This process has no database and no state of its own, so the only honest
 * thing it can report is that it is up and serving. It does NOT call the LLM
 * provider: a health check that spends a token per probe would make the
 * container's own healthcheck a recurring cost, and it would fail the task on
 * a provider outage the process can do nothing about — turning a degraded
 * dependency into a restart loop.
 *
 * Left unauthenticated and unlimited because the container healthcheck and
 * the load balancer both call it, and it discloses nothing.
 */
healthRouter.get('/health', (_req: Request, res: Response) => {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    stage: env.APP_STAGE,
  };
  res.status(200).json(body);
});

export default healthRouter;
