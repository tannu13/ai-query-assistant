import { errorEnvelopeSchema } from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';

import { AppError } from '../src/lib/errors';
import errorHandler from '../src/middleware/errorHandler';
import notFound from '../src/middleware/notFound';
import requestId, { REQUEST_ID_HEADER } from '../src/middleware/requestId';
import app from '../src/server';
import { startTestServer, type TestServer } from './helpers/testServer';

/**
 * A message with the shape of the thing that must never be returned: an
 * upstream error quoting an internal endpoint and a credential fragment.
 *
 * The credential is a sentinel rather than a realistic `AIza…` string on
 * purpose. The repository's secret scan greps tracked content for key-shaped
 * literals, and a fixture that matched the pattern would make that scan
 * permanently noisy — training everyone to ignore the one check that catches
 * a real leak. What the assertion needs is a distinctive string, not a
 * plausible one.
 */
const CANARY_CREDENTIAL = 'CANARY-NOT-A-REAL-CREDENTIAL';
const CANARY_ENDPOINT = 'internal.provider.invalid';
const LEAKY_MESSAGE =
  `provider 500 at https://${CANARY_ENDPOINT}/v1 (key=${CANARY_CREDENTIAL})`;

/**
 * A second app, assembled from the same middleware, carrying routes that
 * fail in ways the real app has no route for. Testing an unhandled throw
 * needs a handler that throws, and adding one to the shipped app to make a
 * test possible would be the test dictating the product.
 */
function buildThrowingApp() {
  const throwing = express();
  throwing.use(requestId);
  throwing.get('/sync-throw', () => {
    throw new Error(LEAKY_MESSAGE);
  });
  throwing.get('/async-throw', async () => {
    await Promise.resolve();
    throw new Error(LEAKY_MESSAGE);
  });
  throwing.get('/non-error-throw', () => {
    // Nothing obliges a thrower to throw an Error.
    throw 'a bare string';
  });
  throwing.get('/typed-throw', () => {
    throw new AppError('LLM_UNAVAILABLE', 'The model is unavailable.', {
      cause: new Error(LEAKY_MESSAGE),
    });
  });
  throwing.use(notFound);
  throwing.use(errorHandler);
  return throwing;
}

describe('errorHandler', () => {
  let server: TestServer;
  let realServer: TestServer;

  beforeAll(async () => {
    server = await startTestServer(buildThrowingApp());
    realServer = await startTestServer(app);
  });

  afterAll(async () => {
    await server.close();
    await realServer.close();
  });

  describe('an unhandled throw', () => {
    it('answers with the shared envelope and INTERNAL_ERROR', async () => {
      const response = await fetch(`${server.url}/sync-throw`);
      const body = await response.json();

      expect(response.status).toBe(500);
      // Parsed against the shared schema, not hand-asserted field by field:
      // this is the contract both sides compile against, so a drift in the
      // envelope fails here rather than in the browser.
      const parsed = errorEnvelopeSchema.parse(body);
      expect(parsed.error.code).toBe('INTERNAL_ERROR');
      expect(parsed.error.message).toBe(
        'Something went wrong on our side. Please try again.',
      );
      expect(parsed.error.details).toBeUndefined();
    });

    it('carries a request id that matches the response header', async () => {
      const response = await fetch(`${server.url}/sync-throw`);
      const parsed = errorEnvelopeSchema.parse(await response.json());

      expect(parsed.error.requestId).not.toBe('');
      expect(response.headers.get(REQUEST_ID_HEADER)).toBe(
        parsed.error.requestId,
      );
    });

    it('gives each request its own id', async () => {
      const [first, second] = await Promise.all([
        fetch(`${server.url}/sync-throw`).then((r) => r.json()),
        fetch(`${server.url}/sync-throw`).then((r) => r.json()),
      ]);

      expect(errorEnvelopeSchema.parse(first).error.requestId).not.toBe(
        errorEnvelopeSchema.parse(second).error.requestId,
      );
    });

    it('never echoes the underlying error message to the client', async () => {
      // The rule that the single translation point exists to enforce. An
      // upstream message can carry internal endpoints, quota detail and
      // credential fragments, so the whole serialised response is checked —
      // not just `message` — to catch a leak through any other field.
      for (const path of ['/sync-throw', '/async-throw', '/non-error-throw']) {
        const response = await fetch(`${server.url}${path}`);
        const raw = await response.text();

        expect(response.status).toBe(500);
        expect(raw).not.toContain(CANARY_CREDENTIAL);
        expect(raw).not.toContain(CANARY_ENDPOINT);
        expect(raw).not.toContain('a bare string');
        expect(errorEnvelopeSchema.parse(JSON.parse(raw)).error.code).toBe(
          'INTERNAL_ERROR',
        );
      }
    });
  });

  describe('a typed AppError', () => {
    it('keeps its own code, status and message but not its cause', async () => {
      const response = await fetch(`${server.url}/typed-throw`);
      const raw = await response.text();
      const parsed = errorEnvelopeSchema.parse(JSON.parse(raw));

      expect(response.status).toBe(502);
      expect(parsed.error.code).toBe('LLM_UNAVAILABLE');
      expect(parsed.error.message).toBe('The model is unavailable.');
      // The cause is for the log line only.
      expect(raw).not.toContain(CANARY_CREDENTIAL);
    });
  });

  describe('the real app', () => {
    it('answers an unmatched route with NOT_FOUND, not Express HTML', async () => {
      const response = await fetch(`${realServer.url}/api/nope`);

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe(
        'NOT_FOUND',
      );
    });

    it('rejects an invalid body with field-level details', async () => {
      const response = await fetch(`${realServer.url}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   ' }),
      });
      const parsed = errorEnvelopeSchema.parse(await response.json());

      expect(response.status).toBe(400);
      expect(parsed.error.code).toBe('VALIDATION_FAILED');
      expect(parsed.error.details).toEqual([
        { path: 'prompt', message: 'Enter a question before submitting' },
      ]);
    });

    it('rejects malformed JSON in the envelope rather than as HTML', async () => {
      const response = await fetch(`${realServer.url}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"prompt": ',
      });

      expect(response.status).toBe(400);
      expect(errorEnvelopeSchema.parse(await response.json()).error.code).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('rejects an oversized body in the envelope rather than as HTML', async () => {
      // Plan §17 item 5: `express.json` raises its own `entity.too.large`
      // before any application code runs, and Express's default handler
      // answers it with an HTML page. This is the assertion that the
      // single-envelope guarantee has no hole at the transport layer.
      const response = await fetch(`${realServer.url}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x'.repeat(2_000_000) }),
      });
      const parsed = errorEnvelopeSchema.parse(await response.json());

      expect(response.status).toBe(400);
      expect(parsed.error.code).toBe('VALIDATION_FAILED');
      expect(parsed.error.message).toContain('larger than this API accepts');
    });
  });
});
