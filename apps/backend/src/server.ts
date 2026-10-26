import type { HealthResponse } from '@repo/shared';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';

import env from './env';

const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Liveness only, and deliberately so.
 *
 * This process has no database and no state of its own, so the only honest
 * thing it can report is that it is up and serving. It does NOT call the LLM
 * provider: a health check that spends a token per probe would make the
 * container's own healthcheck a recurring cost and would fail the task on a
 * provider outage the process cannot do anything about.
 */
app.get('/health', (_req: Request, res: Response) => {
  const body: HealthResponse = {
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    stage: env.APP_STAGE,
  };
  res.status(200).json(body);
});

export default app;
export { app };
