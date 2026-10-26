import { ApiError, FinishReason, type GenerateContentResponse } from '@google/genai';
import type { ErrorCode } from '@repo/shared';
import { describe, expect, it } from 'bun:test';

import { AppError } from '../src/lib/errors';
import createFakeLlmProvider from '../src/services/llm/fake';
import {
  createGeminiProvider,
  interpretGeminiResponse,
} from '../src/services/llm/gemini';

/**
 * Builds a response object with the shape the SDK returns.
 *
 * `response.text` is a GETTER on the real class (confirmed against the
 * v2.31.0 type definitions — `get text(): string | undefined`), so a plain
 * object literal with a `text` property would not reproduce it. Defining it
 * as an accessor is what makes these fixtures faithful rather than
 * approximately right.
 */
function buildResponse(parts: {
  text?: string;
  finishReason?: FinishReason;
  blockReason?: string;
  modelVersion?: string;
  candidates?: unknown[];
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number };
}): GenerateContentResponse {
  const response = {
    modelVersion: parts.modelVersion,
    promptFeedback:
      parts.blockReason === undefined
        ? undefined
        : { blockReason: parts.blockReason },
    candidates:
      parts.candidates ??
      (parts.finishReason === undefined && parts.text === undefined
        ? undefined
        : [{ finishReason: parts.finishReason, content: { parts: [] } }]),
    usageMetadata: parts.usage,
  };
  Object.defineProperty(response, 'text', { get: () => parts.text });
  return response as unknown as GenerateContentResponse;
}

/** Asserts a thrown AppError and returns it, so each case stays one line. */
function expectAppError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('interpretGeminiResponse', () => {
  describe('HTTP 200 with no usable text cannot silently succeed', () => {
    it('maps an input-side block to LLM_CONTENT_BLOCKED', async () => {
      const error = expectAppError(() =>
        interpretGeminiResponse(
          buildResponse({ blockReason: 'SAFETY' }),
          'gemini-flash-latest',
        ),
      );

      expect(error.code).toBe('LLM_CONTENT_BLOCKED');
      // 422, not 502: the provider answered, and its answer was a refusal.
      expect(error.status).toBe(422);
      expect(error.context).toEqual({ reason: 'prompt:SAFETY' });
    });

    it('maps an output-side safety stop to LLM_CONTENT_BLOCKED too', async () => {
      const error = expectAppError(() =>
        interpretGeminiResponse(
          buildResponse({ finishReason: FinishReason.SAFETY }),
          'gemini-flash-latest',
        ),
      );

      expect(error.code).toBe('LLM_CONTENT_BLOCKED');
      expect(error.context).toEqual({ reason: 'response:SAFETY' });
    });

    it.each([
      FinishReason.RECITATION,
      FinishReason.BLOCKLIST,
      FinishReason.PROHIBITED_CONTENT,
      FinishReason.SPII,
    ])('treats %s as a content block, not an outage', (finishReason) => {
      expect(
        expectAppError(() =>
          interpretGeminiResponse(
            buildResponse({ finishReason }),
            'gemini-flash-latest',
          ),
        ).code,
      ).toBe('LLM_CONTENT_BLOCKED');
    });

    it('maps an empty answer with a normal stop to LLM_NO_CONTENT', async () => {
      const error = expectAppError(() =>
        interpretGeminiResponse(
          buildResponse({ text: '', finishReason: FinishReason.STOP }),
          'gemini-flash-latest',
        ),
      );

      expect(error.code).toBe('LLM_NO_CONTENT');
      expect(error.context).toEqual({ finishReason: 'STOP', candidateCount: 1 });
    });

    it('maps an undefined text to LLM_NO_CONTENT, never to ""', async () => {
      // The exact shape that the naive adapter forwards to the UI, which then
      // renders the string "undefined" with no error raised anywhere.
      expect(
        expectAppError(() =>
          interpretGeminiResponse(
            buildResponse({ text: undefined, finishReason: FinishReason.STOP }),
            'gemini-flash-latest',
          ),
        ).code,
      ).toBe('LLM_NO_CONTENT');
    });

    it('maps whitespace-only text to LLM_NO_CONTENT', async () => {
      expect(
        expectAppError(() =>
          interpretGeminiResponse(
            buildResponse({ text: '   \n\t ', finishReason: FinishReason.STOP }),
            'gemini-flash-latest',
          ),
        ).code,
      ).toBe('LLM_NO_CONTENT');
    });

    it('maps a response with no candidates at all to LLM_NO_CONTENT', async () => {
      const error = expectAppError(() =>
        interpretGeminiResponse(buildResponse({}), 'gemini-flash-latest'),
      );

      expect(error.code).toBe('LLM_NO_CONTENT');
      expect(error.context).toEqual({ finishReason: null, candidateCount: 0 });
    });
  });

  describe('truncation is surfaced, not discarded', () => {
    it('returns the partial text with truncated: true', async () => {
      const completion = interpretGeminiResponse(
        buildResponse({
          text: 'The sky is blue because',
          finishReason: FinishReason.MAX_TOKENS,
        }),
        'gemini-flash-latest',
      );

      // A truncated answer is a third outcome: useful, incomplete, and
      // neither a success nor a failure.
      expect(completion.truncated).toBe(true);
      expect(completion.text).toBe('The sky is blue because');
      expect(completion.finishReason).toBe('MAX_TOKENS');
    });

    it('still fails when the token limit left no text at all', async () => {
      // The limit can be consumed entirely by reasoning tokens. Truncated and
      // empty is still empty.
      expect(
        expectAppError(() =>
          interpretGeminiResponse(
            buildResponse({ text: '', finishReason: FinishReason.MAX_TOKENS }),
            'gemini-flash-latest',
          ),
        ).code,
      ).toBe('LLM_NO_CONTENT');
    });
  });

  describe('a successful completion', () => {
    it('reports the resolved model, not the requested alias', async () => {
      const completion = interpretGeminiResponse(
        buildResponse({
          text: 'Rayleigh scattering.',
          finishReason: FinishReason.STOP,
          modelVersion: 'gemini-2.5-flash-002',
          usage: { promptTokenCount: 7, candidatesTokenCount: 3 },
        }),
        'gemini-flash-latest',
      );

      expect(completion).toEqual({
        text: 'Rayleigh scattering.',
        // `gemini-flash-latest` is an alias; logging what actually answered is
        // what makes a log line reproducible.
        model: 'gemini-2.5-flash-002',
        finishReason: 'STOP',
        truncated: false,
        usage: { promptTokens: 7, responseTokens: 3 },
      });
    });

    it('falls back to the requested model when none is reported', async () => {
      const completion = interpretGeminiResponse(
        buildResponse({ text: 'ok', finishReason: FinishReason.STOP }),
        'gemini-flash-latest',
      );

      expect(completion.model).toBe('gemini-flash-latest');
      expect(completion.usage).toBeUndefined();
    });
  });
});

describe('the Gemini adapter end to end, through its generate seam', () => {
  function provider(generate: Parameters<typeof createGeminiProvider>[0]['generate']) {
    return createGeminiProvider({
      apiKey: 'test-only-never-used',
      model: 'gemini-flash-latest',
      timeoutMs: 50,
      generate,
    });
  }

  it('surfaces its own deadline as LLM_TIMEOUT, not a generic failure', async () => {
    // Never settles until aborted, which is what a hung provider looks like.
    const hanging = provider(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const error = (await hanging
      .complete({ prompt: 'hello' })
      .catch((e: unknown) => e)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('LLM_TIMEOUT');
    expect(error.status).toBe(504);
    expect(error.context).toEqual({ timeoutMs: 50 });
  });

  it('maps an upstream 429 to LLM_RATE_LIMITED with a Retry-After hint', async () => {
    const limited = provider(() =>
      Promise.reject(new ApiError({ message: 'quota exceeded', status: 429 })),
    );

    const error = (await limited
      .complete({ prompt: 'hello' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('LLM_RATE_LIMITED');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it.each([500, 503, 400, 403])(
    'maps an upstream %i to LLM_UNAVAILABLE',
    async (status) => {
      const broken = provider(() =>
        Promise.reject(
          new ApiError({ message: `upstream said ${status}`, status }),
        ),
      );

      const error = (await broken
        .complete({ prompt: 'hello' })
        .catch((e: unknown) => e)) as AppError;

      // 400 and 403 mean OUR request or OUR key was wrong. From the client's
      // seat that is still "the service behind this one is not working", and
      // saying "invalid API key" would disclose our configuration state.
      expect(error.code).toBe('LLM_UNAVAILABLE');
      expect(error.status).toBe(502);
      expect(error.context).toEqual({ providerStatus: status });
    },
  );

  it('maps a transport failure to LLM_UNAVAILABLE', async () => {
    const offline = provider(() =>
      Promise.reject(new TypeError('fetch failed')),
    );

    expect(
      (
        (await offline
          .complete({ prompt: 'hello' })
          .catch((e: unknown) => e)) as AppError
      ).code,
    ).toBe('LLM_UNAVAILABLE');
  });

  it('never leaks the provider message to the client-facing text', async () => {
    const leaky = provider(() =>
      Promise.reject(
        new ApiError({
          message:
            'POST https://internal.provider.invalid/v1/models: API key CANARY-NOT-A-REAL-CREDENTIAL is invalid for project 1234567890',
          status: 403,
        }),
      ),
    );

    const error = (await leaky
      .complete({ prompt: 'hello' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.message).toBe(
      'The model is temporarily unavailable. Please try again.',
    );
    expect(error.message).not.toContain('CANARY-NOT-A-REAL-CREDENTIAL');
    expect(error.message).not.toContain('internal.provider.invalid');
    // The detail is retained for the log line, and only there.
    expect((error.cause as Error).message).toContain('1234567890');
  });

  it('honours a caller cancellation distinctly from its own deadline', async () => {
    const hanging = provider(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    const controller = new AbortController();
    const pending = hanging
      .complete({ prompt: 'hello', signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();

    const error = (await pending) as AppError;
    // The caller went away before the deadline, so this is NOT a timeout.
    expect(error.code).toBe('LLM_UNAVAILABLE');
  });

  it('passes a composed signal that the caller alone cannot un-abort', async () => {
    let seen: AbortSignal | undefined;
    const capturing = provider(({ signal }) => {
      seen = signal;
      return Promise.resolve(
        buildResponse({ text: 'ok', finishReason: FinishReason.STOP }),
      );
    });

    await capturing.complete({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(false);
  });
});

describe('the fake provider', () => {
  it('answers deterministically and says it is not a model', async () => {
    const completion = await createFakeLlmProvider().complete({
      prompt: 'Why is the sky blue?',
    });

    expect(completion.text).toContain('fake LLM provider');
    expect(completion.model).toBe('fake-model-1');
    expect(completion.truncated).toBe(false);
  });

  // Typed as the shared union, so a renamed code fails to compile here rather
  // than quietly never matching.
  const triggers: ReadonlyArray<[string, ErrorCode]> = [
    ['!empty why', 'LLM_NO_CONTENT'],
    ['!blocked why', 'LLM_CONTENT_BLOCKED'],
    ['!timeout why', 'LLM_TIMEOUT'],
    ['!ratelimit why', 'LLM_RATE_LIMITED'],
    ['!unavailable why', 'LLM_UNAVAILABLE'],
  ];

  it.each(triggers)('reaches %s on demand -> %s', async (prompt, code) => {
    // Every failure in the error matrix, triggerable with no network, no
    // token spend and no waiting for a real rate limit.
    const error = (await createFakeLlmProvider()
      .complete({ prompt })
      .catch((e: unknown) => e)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(code);
  });

  it('produces a truncated completion rather than an error', async () => {
    const completion = await createFakeLlmProvider().complete({
      prompt: '!truncated why',
    });

    expect(completion.truncated).toBe(true);
    expect(completion.finishReason).toBe('MAX_TOKENS');
  });

  it('respects a fixed outcome over the prompt trigger', async () => {
    const error = (await createFakeLlmProvider({
      outcome: { kind: 'unavailable' },
    })
      .complete({ prompt: '!empty ignored' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('LLM_UNAVAILABLE');
  });

  it('honours cancellation, so a caller cannot look correct by accident', async () => {
    const slow = createFakeLlmProvider({ latencyMs: 50 });
    const controller = new AbortController();
    const pending = slow
      .complete({ prompt: 'hello', signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();

    expect(await pending).toBeInstanceOf(Error);
  });
});
