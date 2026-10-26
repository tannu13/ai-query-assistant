import {
  LlmContentBlockedError,
  LlmNoContentError,
  LlmRateLimitedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../../lib/errors';
import type { LlmCompleteInput, LlmCompletion, LlmProvider } from './provider';

/**
 * Deterministic stand-in for a real provider.
 *
 * This is what makes the query path testable at all: every failure in the
 * error matrix becomes reachable on demand, with no network, no token spend
 * and no waiting for a real rate limit. Those are precisely the paths most
 * likely to break in use and least likely to be covered, because provoking
 * them against a live API is somewhere between awkward and impossible.
 *
 * It is also selectable at runtime via LLM_PROVIDER=fake, which makes the
 * frontend's error states demonstrable without burning quota — and is
 * refused outright when APP_STAGE=prod.
 */

export const FAKE_MODEL = 'fake-model-1';

/**
 * Outcomes the fake can produce, named for the condition rather than the
 * mechanism, so a test reads as the scenario it is asserting.
 */
export type FakeOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'truncated'; text: string }
  | { kind: 'empty' }
  | { kind: 'blocked'; reason?: string }
  | { kind: 'timeout' }
  | { kind: 'rateLimited' }
  | { kind: 'unavailable' }
  /** Never settles until the caller's signal aborts — for cancellation tests. */
  | { kind: 'hang' };

/**
 * Prompt prefixes that trigger a failure, so a human poking the running app
 * can reach every error state from the UI without restarting anything. The
 * frontend gate in Phase 6 needs exactly this.
 */
const PROMPT_TRIGGERS: ReadonlyArray<[string, FakeOutcome]> = [
  ['!empty', { kind: 'empty' }],
  ['!blocked', { kind: 'blocked', reason: 'prompt:SAFETY' }],
  ['!timeout', { kind: 'timeout' }],
  ['!ratelimit', { kind: 'rateLimited' }],
  ['!unavailable', { kind: 'unavailable' }],
  ['!truncated', { kind: 'truncated', text: 'This answer stops mid-' }],
  ['!hang', { kind: 'hang' }],
];

export interface FakeProviderOptions {
  /**
   * Fixed outcome, overriding prompt triggers. A test that wants one
   * behaviour says so once rather than encoding it into every prompt.
   */
  outcome?: FakeOutcome;
  /** Simulated latency, so cancellation and ordering are observable. */
  latencyMs?: number;
}

function outcomeFor(prompt: string, override?: FakeOutcome): FakeOutcome {
  if (override) return override;
  const trigger = PROMPT_TRIGGERS.find(([prefix]) =>
    prompt.trim().toLowerCase().startsWith(prefix),
  );
  return trigger?.[1] ?? { kind: 'text', text: echoAnswer(prompt) };
}

/**
 * Deliberately not an LLM impression. The point of the fake is that its
 * output is predictable, and an answer that quoted the prompt back without
 * saying so could be mistaken for a real one in a screenshot.
 */
function echoAnswer(prompt: string): string {
  return [
    'This is a canned answer from the fake LLM provider — no model was called.',
    '',
    `You asked: ${prompt.trim()}`,
  ].join('\n');
}

export function createFakeLlmProvider(
  options: FakeProviderOptions = {},
): LlmProvider {
  const { outcome: override, latencyMs = 0 } = options;

  return {
    name: 'fake',

    async complete({ prompt, signal }: LlmCompleteInput): Promise<LlmCompletion> {
      const outcome = outcomeFor(prompt, override);

      if (outcome.kind === 'hang') {
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(new LlmTimeoutError(0, signal?.reason));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      }

      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      // Honour cancellation even on the fast paths, so the fake cannot make a
      // caller look like it handles abort correctly when it does not.
      signal?.throwIfAborted();

      switch (outcome.kind) {
        case 'timeout':
          throw new LlmTimeoutError(1);
        case 'rateLimited':
          throw new LlmRateLimitedError(30);
        case 'unavailable':
          throw new LlmUnavailableError(new Error('fake provider: simulated 503'));
        case 'blocked':
          throw new LlmContentBlockedError(outcome.reason ?? 'prompt:SAFETY');
        case 'empty':
          // What the real adapter raises for HTTP 200 with no usable text.
          throw new LlmNoContentError({ finishReason: 'STOP' });
        case 'truncated':
          return {
            text: outcome.text,
            model: FAKE_MODEL,
            finishReason: 'MAX_TOKENS',
            truncated: true,
            usage: { promptTokens: prompt.length, responseTokens: 8 },
          };
        case 'text':
          return {
            text: outcome.text,
            model: FAKE_MODEL,
            finishReason: 'STOP',
            truncated: false,
            usage: { promptTokens: prompt.length, responseTokens: 42 },
          };
      }
    },
  };
}

export default createFakeLlmProvider;
