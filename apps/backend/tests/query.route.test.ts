import {
  errorEnvelopeSchema,
  queryResponseSchema,
  type ErrorCode,
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import env from '../src/env';
import { llmProvider } from '../src/services/llm';
import { DEMO_USER_ID, signAccessToken } from '../src/services/token';
import app from '../src/server';
import { startTestServer, type TestServer } from './helpers/testServer';

let server: TestServer;
let token: string;

beforeAll(async () => {
  server = await startTestServer(app);
  token = signAccessToken(DEMO_USER_ID, env.DEMO_USER_EMAIL).token;
});
afterAll(async () => {
  await server.close();
});

async function query(
  body: unknown,
  options: { authenticated?: boolean } = {},
) {
  const { authenticated = true } = options;
  const response = await fetch(`${server.url}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function errorFrom(body: unknown) {
  return errorEnvelopeSchema.parse(body).error;
}

describe('POST /api/query', () => {
  /**
   * The suite runs against LLM_PROVIDER=fake (set in .env.test), so the whole
   * route is exercised with no network and no token spend, and every failure
   * in the error matrix is reachable from a prompt prefix.
   */
  it('answers the happy path in the shape the shared schema defines', async () => {
    const { response, body } = await query({ prompt: 'Why is the sky blue?' });

    expect(response.status).toBe(200);
    const parsed = queryResponseSchema.parse(body);
    expect(parsed.answer).toContain('fake LLM provider');
    expect(parsed.model).toBe('fake-model-1');
    expect(parsed.finishReason).toBe('STOP');
    expect(parsed.truncated).toBe(false);
    // The same id the error envelope would carry, and the one in the logs.
    expect(parsed.requestId).toBe(response.headers.get('X-Request-Id') ?? '');
  });

  it('surfaces a truncated answer as usable but incomplete', async () => {
    const { response, body } = await query({ prompt: '!truncated go' });
    const parsed = queryResponseSchema.parse(body);

    // Not an error: the text is real, and the flag is what lets the UI say
    // the answer was cut short rather than pretending it is complete.
    expect(response.status).toBe(200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.answer.length).toBeGreaterThan(0);
  });

  describe('authentication', () => {
    it('rejects an unauthenticated call with 401, before validating', async () => {
      const { response, body } = await query(
        { prompt: 'hello' },
        { authenticated: false },
      );

      expect(response.status).toBe(401);
      expect(errorFrom(body).code).toBe('AUTH_MISSING_TOKEN');
    });

    it('rejects an unauthenticated call even when the body is invalid', async () => {
      // Order matters: leaking "your body is malformed" to an unauthenticated
      // caller would describe the API's shape to someone with no access to it.
      const { response, body } = await query({}, { authenticated: false });

      expect(response.status).toBe(401);
      expect(errorFrom(body).code).toBe('AUTH_MISSING_TOKEN');
    });
  });

  describe('validation', () => {
    it('rejects an empty prompt with field-level detail', async () => {
      const { response, body } = await query({ prompt: '' });
      const error = errorFrom(body);

      expect(response.status).toBe(400);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details).toEqual([
        { path: 'prompt', message: 'Enter a question before submitting' },
      ]);
    });

    it('rejects a missing prompt', async () => {
      const { response, body } = await query({});

      expect(response.status).toBe(400);
      expect(errorFrom(body).details?.[0]?.path).toBe('prompt');
    });

    it('rejects an over-cap prompt WITHOUT calling the provider', async () => {
      // The assertion that matters commercially: the cap is enforced before
      // anything is spent. A test that only checked the 400 would pass just
      // as happily with the provider call left in front of it.
      const spy = spyOn(llmProvider, 'complete');
      try {
        const { response, body } = await query({
          prompt: 'x'.repeat(env.LLM_MAX_PROMPT_CHARS + 1),
        });
        const error = errorFrom(body);

        expect(response.status).toBe(400);
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.details?.[0]?.message).toContain(
          `at most ${env.LLM_MAX_PROMPT_CHARS} characters`,
        );
        expect(spy).toHaveBeenCalledTimes(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('accepts a prompt exactly at the cap', async () => {
      // Off-by-one guard on the boundary the UI mirrors.
      const { response } = await query({
        prompt: 'x'.repeat(env.LLM_MAX_PROMPT_CHARS),
      });

      expect(response.status).toBe(200);
    });
  });

  describe('provider failures map to their documented code and status', () => {
    const cases: ReadonlyArray<[string, ErrorCode, number]> = [
      ['!timeout', 'LLM_TIMEOUT', 504],
      ['!ratelimit', 'LLM_RATE_LIMITED', 429],
      ['!unavailable', 'LLM_UNAVAILABLE', 502],
      ['!blocked', 'LLM_CONTENT_BLOCKED', 422],
      ['!empty', 'LLM_NO_CONTENT', 502],
    ];

    it.each(cases)('%s -> %s (%i)', async (prompt, code, status) => {
      const { response, body } = await query({ prompt });

      expect(response.status).toBe(status);
      expect(errorFrom(body).code).toBe(code);
    });

    it('sets Retry-After when the provider rate-limits us', async () => {
      const response = await fetch(`${server.url}/api/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: '!ratelimit' }),
      });

      expect(response.status).toBe(429);
      expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    });

    it('never leaks a provider message into the response', async () => {
      const spy = spyOn(llmProvider, 'complete').mockRejectedValue(
        new Error(
          'provider 500 at https://internal.provider.invalid/v1 (key=CANARY-NOT-A-REAL-CREDENTIAL)',
        ),
      );
      try {
        const response = await fetch(`${server.url}/api/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ prompt: 'hello' }),
        });
        const raw = await response.text();

        // An untyped throw from the provider is an unexpected failure, so it
        // collapses to INTERNAL_ERROR with nothing of the original in it.
        expect(response.status).toBe(500);
        expect(raw).not.toContain('CANARY-NOT-A-REAL-CREDENTIAL');
        expect(raw).not.toContain('internal.provider.invalid');
        expect(errorFrom(JSON.parse(raw)).code).toBe('INTERNAL_ERROR');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('the temporary scaffolding is gone', () => {
    it('no longer serves /api/echo', async () => {
      const response = await fetch(`${server.url}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      });

      expect(response.status).toBe(404);
      expect(errorFrom(await response.json()).code).toBe('NOT_FOUND');
    });
  });
});

describe('the query rate limiter keys on the JWT subject', () => {
  /**
   * Fresh subjects, so this burst shares no bucket with the suites above and
   * the result does not depend on test ordering.
   */
  function tokenFor(subject: string) {
    return signAccessToken(subject, env.DEMO_USER_EMAIL).token;
  }

  async function send(subjectToken: string) {
    const response = await fetch(`${server.url}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${subjectToken}`,
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    // Drain the body so the socket is reusable and the loop does not stall.
    await response.arrayBuffer();
    return response;
  }

  it('gives each subject its own budget, from the same address', async () => {
    // The real proof that the key is the subject and not the IP: both callers
    // are loopback, so an IP-keyed limiter would reject the second one too.
    //
    // Why the subject is the right key: an IP key puts a whole office behind
    // a shared NAT into one bucket, while handing an attacker with a few
    // addresses a fresh budget per address. The limit should follow the
    // account.
    const alice = tokenFor('rate-limit-subject-a');
    const bob = tokenFor('rate-limit-subject-b');

    const statuses: number[] = [];
    for (let i = 0; i < 24; i += 1) {
      statuses.push((await send(alice)).status);
    }

    // Capacity is 20, so Alice is exhausted.
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(statuses.at(-1)).toBe(429);

    // Bob's budget is untouched.
    expect((await send(bob)).status).toBe(200);
  });

  it('rejects an exhausted subject with the shared envelope', async () => {
    const carol = tokenFor('rate-limit-subject-c');
    for (let i = 0; i < 21; i += 1) await send(carol);

    const rejected = await fetch(`${server.url}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${carol}`,
      },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    expect(rejected.status).toBe(429);
    expect(errorFrom(await rejected.json()).code).toBe('RATE_LIMITED');
    expect(Number(rejected.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});
