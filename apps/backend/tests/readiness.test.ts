import { healthResponseSchema, readinessResponseSchema } from '@repo/shared';
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';

import {
  beginDraining,
  currentPhase,
  isDraining,
  resetLifecycleForTest,
} from '../src/lib/lifecycle';
import { createHealthRouter } from '../src/routes/health';
import app from '../src/server';
import { startTestServer, type TestServer } from './helpers/testServer';

function buildApp(draining: boolean) {
  const probe = express();
  probe.use(createHealthRouter({ isDraining: () => draining }));
  return probe;
}

describe('lifecycle', () => {
  afterEach(() => {
    resetLifecycleForTest();
  });

  it('starts running and is not draining', () => {
    expect(currentPhase()).toBe('running');
    expect(isDraining()).toBe(false);
  });

  it('reports whether the caller is the one that started the drain', () => {
    // The return value is what `shutdown()` uses to tell a first signal from
    // a second, so it is the contract rather than a convenience.
    expect(beginDraining()).toBe(true);
    expect(beginDraining()).toBe(false);
    expect(beginDraining()).toBe(false);
    expect(isDraining()).toBe(true);
  });
});

describe('GET /health and GET /ready', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    resetLifecycleForTest();
  });

  it('answers ready while running', async () => {
    server = await startTestServer(buildApp(false));

    const response = await fetch(`${server.url}/ready`);
    expect(response.status).toBe(200);

    const body = readinessResponseSchema.parse(await response.json());
    expect(body.status).toBe('ready');
  });

  it('answers 503 draining once a drain has begun', async () => {
    server = await startTestServer(buildApp(true));

    const response = await fetch(`${server.url}/ready`);
    // The status code is the payload as far as a load balancer is concerned.
    expect(response.status).toBe(503);

    const body = readinessResponseSchema.parse(await response.json());
    expect(body.status).toBe('draining');
  });

  /**
   * The counter-intuitive half, and the reason these are two endpoints: a
   * liveness probe going red tells the orchestrator to restart, which is the
   * wrong answer for a process that is shutting down on request.
   */
  it('keeps liveness at 200 while draining', async () => {
    server = await startTestServer(buildApp(true));

    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json()).status).toBe('ok');
  });

  it('wires both endpoints into the real app, reading real lifecycle state', async () => {
    // The shipped app, not a probe assembled for the test — so a router that
    // was never mounted in server.ts would fail here.
    server = await startTestServer(app);

    expect((await fetch(`${server.url}/ready`)).status).toBe(200);

    beginDraining();

    const response = await fetch(`${server.url}/ready`);
    expect(response.status).toBe(503);
    expect(readinessResponseSchema.parse(await response.json()).status).toBe(
      'draining',
    );
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });
});
