import {
  errorEnvelopeSchema,
  loginResponseSchema,
  meResponseSchema,
} from '@repo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import jwt from 'jsonwebtoken';

import env from '../src/env';
import { DEMO_USER_ID } from '../src/services/token';
import app from '../src/server';
import { startTestServer, type TestServer } from './helpers/testServer';

const BASE_CLAIMS = { email: env.DEMO_USER_EMAIL } as const;

/** Signs a token with this app's real secret, varying one thing at a time. */
function sign(options: jwt.SignOptions = {}, secret = env.JWT_SECRET): string {
  return jwt.sign(BASE_CLAIMS, secret, {
    algorithm: 'HS256',
    subject: DEMO_USER_ID,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: '15m',
    ...options,
  });
}

async function callMe(authorization?: string) {
  const response = await fetch(`${server.url}/api/me`, {
    headers: authorization === undefined ? {} : { authorization },
  });
  return { response, body: await response.json() };
}

/** Asserts the envelope and returns the code, so each case reads as one line. */
async function codeFor(authorization?: string): Promise<string> {
  const { response, body } = await callMe(authorization);
  expect(response.status).toBe(401);
  return errorEnvelopeSchema.parse(body).error.code;
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(app);
});
afterAll(async () => {
  await server.close();
});

describe('POST /api/auth/login', () => {
  async function login(payload: unknown) {
    const response = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { response, body: await response.json() };
  }

  it('mints a token for the demo credentials', async () => {
    const { response, body } = await login({
      email: env.DEMO_USER_EMAIL,
      password: 'demo-password',
    });

    expect(response.status).toBe(200);
    // Parsed against the shared schema rather than field-by-field, so a
    // contract drift fails here instead of in the browser.
    const parsed = loginResponseSchema.parse(body);
    expect(parsed.tokenType).toBe('Bearer');
    // 15m default, derived from the signed token rather than re-parsed from
    // JWT_EXPIRES_IN — so `expiresIn` cannot disagree with the `exp` claim.
    expect(parsed.expiresIn).toBe(900);
  });

  it('stamps the claims it asserts on verify', async () => {
    const { body } = await login({
      email: env.DEMO_USER_EMAIL,
      password: 'demo-password',
    });
    const { token } = loginResponseSchema.parse(body);
    const decoded = jwt.decode(token, { complete: true });

    expect(decoded?.header.alg).toBe('HS256');
    expect(decoded?.payload).toMatchObject({
      sub: DEMO_USER_ID,
      iss: env.JWT_ISSUER,
      aud: env.JWT_AUDIENCE,
      email: env.DEMO_USER_EMAIL,
    });
    // `sub` is an opaque id, not the email: it is the claim most likely to be
    // logged or used as a rate-limit key, so it must not carry PII.
    expect(decoded?.payload).not.toMatchObject({ sub: env.DEMO_USER_EMAIL });
  });

  it('rejects a wrong password as AUTH_INVALID_CREDENTIALS, not a 500', async () => {
    const { response, body } = await login({
      email: env.DEMO_USER_EMAIL,
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(errorEnvelopeSchema.parse(body).error.code).toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
  });

  it('answers an unknown email identically to a wrong password', async () => {
    // Account-existence oracle check: same status, same code, same message.
    const unknown = await login({
      email: 'nobody@example.com',
      password: 'demo-password',
    });
    const wrongPassword = await login({
      email: env.DEMO_USER_EMAIL,
      password: 'wrong-password',
    });

    const a = errorEnvelopeSchema.parse(unknown.body).error;
    const b = errorEnvelopeSchema.parse(wrongPassword.body).error;

    expect(unknown.response.status).toBe(wrongPassword.response.status);
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
    expect(a.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('rejects a malformed body as validation, not as bad credentials', async () => {
    const { response, body } = await login({ email: 'not-an-email' });
    const parsed = errorEnvelopeSchema.parse(body);

    expect(response.status).toBe(400);
    expect(parsed.error.code).toBe('VALIDATION_FAILED');
    expect(parsed.error.details?.map((d) => d.path).sort()).toEqual([
      'email',
      'password',
    ]);
  });
});

describe('requireAuth', () => {
  it('lets a valid token through and attaches the subject', async () => {
    const { response, body } = await callMe(`Bearer ${sign()}`);

    expect(response.status).toBe(200);
    const parsed = meResponseSchema.parse(body);
    expect(parsed.sub).toBe(DEMO_USER_ID);
    expect(parsed.email).toBe(env.DEMO_USER_EMAIL);
    expect(parsed.expiresInSeconds).toBeGreaterThan(0);
  });

  describe('maps each failure cause to its own code', () => {
    it('no header at all -> AUTH_MISSING_TOKEN', async () => {
      expect(await codeFor()).toBe('AUTH_MISSING_TOKEN');
    });

    it('a non-Bearer scheme -> AUTH_MISSING_TOKEN', async () => {
      // Basic auth is not "an invalid token", it is no token.
      expect(await codeFor('Basic ZGVtbzpkZW1v')).toBe('AUTH_MISSING_TOKEN');
    });

    it('an empty bearer value -> AUTH_MISSING_TOKEN', async () => {
      expect(await codeFor('Bearer ')).toBe('AUTH_MISSING_TOKEN');
    });

    it('a garbage token -> AUTH_INVALID_TOKEN', async () => {
      expect(await codeFor('Bearer garbage')).toBe('AUTH_INVALID_TOKEN');
    });

    it('a token signed with another secret -> AUTH_INVALID_TOKEN', async () => {
      const forged = sign({}, 'a-different-secret-at-least-32-characters-long');
      expect(await codeFor(`Bearer ${forged}`)).toBe('AUTH_INVALID_TOKEN');
    });

    it('an expired token -> AUTH_EXPIRED_TOKEN', async () => {
      // A negative lifetime is already past, so no waiting.
      expect(await codeFor(`Bearer ${sign({ expiresIn: '-1s' })}`)).toBe(
        'AUTH_EXPIRED_TOKEN',
      );
    });

    it('a wrong issuer -> AUTH_INVALID_TOKEN', async () => {
      // Proves `issuer` is asserted on verify and not merely stamped on sign.
      expect(await codeFor(`Bearer ${sign({ issuer: 'some-other-service' })}`)).toBe(
        'AUTH_INVALID_TOKEN',
      );
    });

    it('a wrong audience -> AUTH_INVALID_TOKEN', async () => {
      expect(await codeFor(`Bearer ${sign({ audience: 'some-other-api' })}`)).toBe(
        'AUTH_INVALID_TOKEN',
      );
    });

    it('a verified token missing a required claim -> AUTH_INVALID_TOKEN', async () => {
      // A good signature proves provenance, not shape. Without the claims
      // schema this one reaches the handler and `email` is undefined.
      const shapeless = jwt.sign({}, env.JWT_SECRET, {
        algorithm: 'HS256',
        subject: DEMO_USER_ID,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        expiresIn: '15m',
      });
      expect(await codeFor(`Bearer ${shapeless}`)).toBe('AUTH_INVALID_TOKEN');
    });
  });

  describe('algorithm pinning', () => {
    /**
     * The measured case, not the textbook one.
     *
     * `algorithms: ['HS256']` on verify is what makes this fail. Left
     * unspecified, `jsonwebtoken` derives the acceptable set from the key
     * type, and for a string secret that is the entire HMAC family — so a
     * token this service would never issue verifies anyway. The second
     * assertion is the point: it shows the same token IS accepted without the
     * pin, so the line is doing work rather than decorating.
     */
    it('rejects an HS512 token, which verifies without the pin', async () => {
      const hs512 = sign({ algorithm: 'HS512' });

      expect(await codeFor(`Bearer ${hs512}`)).toBe('AUTH_INVALID_TOKEN');

      expect(() =>
        jwt.verify(hs512, env.JWT_SECRET, {
          issuer: env.JWT_ISSUER,
          audience: env.JWT_AUDIENCE,
        }),
      ).not.toThrow();
    });

    it('rejects an unsigned alg:none token', async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: DEMO_USER_ID,
          email: env.DEMO_USER_EMAIL,
          iss: env.JWT_ISSUER,
          aud: env.JWT_AUDIENCE,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');

      expect(await codeFor(`Bearer ${header}.${payload}.`)).toBe(
        'AUTH_INVALID_TOKEN',
      );
    });
  });
});
