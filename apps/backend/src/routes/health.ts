import type { HealthResponse, ReadinessResponse } from '@repo/shared';
import { Router, type Request, type Response } from 'express';

import env from '../env';
import { isDraining as isDrainingNow } from '../lib/lifecycle';

export interface HealthRouterOptions {
  /**
   * Seam for tests. A factory rather than a singleton for the same reason
   * `createRateLimit` is one: the alternative is a test that has to mutate
   * shared module state and remember to put it back.
   */
  isDraining?: () => boolean;
}

/**
 * Liveness and readiness, as two endpoints answering two questions.
 *
 * Both are unauthenticated and unlimited, because the container healthcheck
 * and the load balancer both call them and neither discloses anything.
 */
export function createHealthRouter(options: HealthRouterOptions = {}): Router {
  const { isDraining = isDrainingNow } = options;
  const router = Router();

  /**
   * Liveness: is this process alive and serving?
   *
   * It does NOT call the LLM provider. A health check that spends a token per
   * probe makes the container's own healthcheck a recurring cost, and it
   * would fail the task during a provider outage the process can do nothing
   * about — turning a degraded dependency into a restart loop.
   *
   * It also stays 200 while draining, which is the counter-intuitive half. A
   * liveness probe going red is an instruction to restart, and a process that
   * is shutting down correctly is the last thing that should be killed
   * harder. "Stop sending me traffic" is a different sentence, and `/ready`
   * below is where it is said.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const body: HealthResponse = {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      stage: env.APP_STAGE,
    };
    res.status(200).json(body);
  });

  /**
   * Readiness: should this process receive new traffic?
   *
   * False from the first instant of a drain, so a load balancer polling this
   * stops routing here before `server.close()` starts refusing connections —
   * the window in which a client would otherwise get a reset rather than an
   * answer. ECS is configured to deregister before SIGTERM anyway (see
   * DEPLOYMENT.md), but that is the orchestrator being polite; on Kubernetes
   * the readiness probe *is* the drain mechanism, and an app with no readiness
   * signal cannot participate in its own rollout.
   *
   * 503 rather than 200-with-a-flag because a probe reads the status code. A
   * readiness endpoint that always returns 200 and expects the poller to
   * parse the body is one default load-balancer configuration away from
   * silently never draining.
   */
  router.get('/ready', (_req: Request, res: Response) => {
    const draining = isDraining();
    const body: ReadinessResponse = {
      status: draining ? 'draining' : 'ready',
      uptimeSeconds: Math.round(process.uptime()),
      stage: env.APP_STAGE,
    };
    res.status(draining ? 503 : 200).json(body);
  });

  return router;
}

export const healthRouter = createHealthRouter();

export default healthRouter;
