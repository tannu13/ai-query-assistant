import { describe, expect, it } from 'bun:test';

import { redactForLog, truncate } from '../src/lib/logger';

describe('log redaction', () => {
  it('replaces values under sensitive key names', () => {
    const redacted = redactForLog({
      GEMINI_API_KEY: 'CANARY-NOT-A-REAL-CREDENTIAL',
      JWT_SECRET: 'a-real-signing-key',
      authorization: 'Bearer eyJhbGciOi.payload.sig',
      password: 'correct horse battery staple',
      refreshToken: 'rt_live_abc',
      apiKey: 'k_live_abc',
      // Not sensitive — redacting everything would make logs useless.
      email: 'demo@example.com',
      model: 'gemini-flash-latest',
    });

    expect(redacted).toEqual({
      GEMINI_API_KEY: '[redacted]',
      JWT_SECRET: '[redacted]',
      authorization: '[redacted]',
      password: '[redacted]',
      refreshToken: '[redacted]',
      apiKey: '[redacted]',
      email: 'demo@example.com',
      model: 'gemini-flash-latest',
    });
  });

  it('keeps numeric metrics whose names merely contain a sensitive word', () => {
    /**
     * Found in live traffic, not by review: the provider's usage block logged
     * as `{promptTokens: '[redacted]', responseTokens: '[redacted]'}`, because
     * `/token/i` matches the field names. That protected nothing and threw
     * away the only cost data the query log carries.
     */
    const redacted = redactForLog({
      usage: { promptTokens: 12, responseTokens: 48 },
      maxOutputTokens: 1024,
      candidatesTokenCount: 48,
      totalTokenCount: 60,
    });

    expect(redacted).toEqual({
      usage: { promptTokens: 12, responseTokens: 48 },
      maxOutputTokens: 1024,
      candidatesTokenCount: 48,
      totalTokenCount: 60,
    });
  });

  it('still redacts a sensitive key whose value is a string', () => {
    // The exemption is for numbers only — the name test alone was too blunt,
    // but loosening it to "anything named token-ish" would be too permissive.
    expect(
      redactForLog({ accessToken: 'eyJhbGciOi.payload.sig', refreshToken: 'rt_live' }),
    ).toEqual({ accessToken: '[redacted]', refreshToken: '[redacted]' });
  });

  it('redacts an object under a sensitive key rather than recursing into it', () => {
    // Otherwise a secret slips through simply by being nested one level down.
    expect(
      redactForLog({ authorization: { scheme: 'Bearer', raw: 'eyJ-secret' } }),
    ).toEqual({ authorization: '[redacted]' });
  });

  it('redacts nested values, not only top-level ones', () => {
    // The realistic leak: something logs a whole request or config object
    // rather than naming a secret directly.
    const redacted = redactForLog({
      request: { headers: { authorization: 'Bearer leak', accept: '*/*' } },
      provider: [{ config: { apiKey: 'CANARY-NESTED' } }],
    });

    expect(JSON.stringify(redacted)).not.toContain('Bearer leak');
    expect(JSON.stringify(redacted)).not.toContain('CANARY-NESTED');
    expect(JSON.stringify(redacted)).toContain('*/*');
  });

  it('truncates long strings, because prompts are user content', () => {
    const output = redactForLog({ prompt: 'x'.repeat(2000) }) as {
      prompt: string;
    };

    expect(output.prompt.length).toBeLessThan(600);
    expect(output.prompt).toContain('(+1488 chars)');
  });

  it('unpacks an Error and its cause chain, which JSON.stringify drops', () => {
    const cause = new Error('provider said: key=CANARY-NESTED');
    const error = new Error('upstream call failed', { cause });

    // The baseline this exists to beat.
    expect(JSON.stringify({ err: error })).toBe('{"err":{}}');

    const redacted = redactForLog({ err: error }) as {
      err: { message: string; stack: string; cause: { message: string } };
    };

    expect(redacted.err.message).toBe('upstream call failed');
    expect(redacted.err.stack).toContain('logger.test.ts');
    expect(redacted.err.cause.message).toBe('provider said: key=CANARY-NESTED');
  });

  it('survives values that do not serialise cleanly', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    // Depth-capped rather than thrown on: a logger that crashes while
    // reporting a failure turns one incident into two.
    expect(() => JSON.stringify(redactForLog(cyclic))).not.toThrow();
    expect(() =>
      JSON.stringify(redactForLog({ fn: () => 1, big: 10n, when: new Date(0) })),
    ).not.toThrow();
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('reports how much it dropped', () => {
    expect(truncate('abcdef', 3)).toBe('abc…(+3 chars)');
  });
});
