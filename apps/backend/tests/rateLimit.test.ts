import { errorEnvelopeSchema } from '@repo/shared';
import { afterEach, describe, expect, it } from 'bun:test';
import express, { type Request } from 'express';

import errorHandler from '../src/middleware/errorHandler';
import createRateLimit from '../src/middleware/rateLimit';
import requestId from '../src/middleware/requestId';
import { startTestServer, type TestServer } from './helpers/testServer';

/**
 * Keys every request to one bucket, so the limit is exercised rather than the
 * loopback address's stability.
 */
const singleBucket = (_req: Request) => 'test';

function buildApp(
  capacity: number,
  refillPerMinute: number,
  keyOf: (req: Request) => string = singleBucket,
) {
  const app = express();
  app.use(requestId);
  app.get(
    '/limited',
    createRateLimit({ capacity, refillPerMinute, keyOf }),
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  app.use(errorHandler);
  return app;
}

describe('rateLimit', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('allows up to capacity, then answers RATE_LIMITED', async () => {
    server = await startTestServer(buildApp(3, 1));

    // Sequential, not parallel: a token bucket's whole job is ordering, and a
    // parallel burst would make the boundary between allowed and rejected
    // depend on scheduling.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${server.url}/limited`);
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('answers in the shared envelope with a Retry-After header', async () => {
    server = await startTestServer(buildApp(1, 60));

    await fetch(`${server.url}/limited`);
    const rejected = await fetch(`${server.url}/limited`);
    const parsed = errorEnvelopeSchema.parse(await rejected.json());

    expect(rejected.status).toBe(429);
    expect(parsed.error.code).toBe('RATE_LIMITED');
    // 60/minute means roughly a second to earn the next token; the header must
    // be a positive integer whatever the arithmetic rounds to.
    const retryAfter = Number(rejected.headers.get('Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', async () => {
    // 600/minute = one token every 100ms, so a short wait is enough to prove
    // the clock is consulted without making the suite slow.
    server = await startTestServer(buildApp(1, 600));

    expect((await fetch(`${server.url}/limited`)).status).toBe(200);
    expect((await fetch(`${server.url}/limited`)).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await fetch(`${server.url}/limited`)).status).toBe(200);
  });

  it('keys buckets independently', async () => {
    const keyOf = (req: Request) => req.header('x-test-key') ?? 'default';
    server = await startTestServer(buildApp(1, 1, keyOf));

    const alice = () => fetch(`${server!.url}/limited`, { headers: { 'x-test-key': 'alice' } });
    const bob = () => fetch(`${server!.url}/limited`, { headers: { 'x-test-key': 'bob' } });

    expect((await alice()).status).toBe(200);
    expect((await alice()).status).toBe(429);
    // Bob's budget is untouched by Alice exhausting hers.
    expect((await bob()).status).toBe(200);
  });
});
