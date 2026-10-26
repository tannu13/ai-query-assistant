import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type GenerateContentResponse,
} from '@google/genai';

import {
  LlmContentBlockedError,
  LlmNoContentError,
  LlmRateLimitedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../../lib/errors';
import type { LlmCompleteInput, LlmCompletion, LlmProvider } from './provider';

/**
 * Finish reasons that mean "the model declined", as opposed to "the model
 * broke". Enumerated from the SDK's own `FinishReason` enum rather than
 * guessed at — it has 19 members, most of them image-specific, and the ones
 * that matter here are the content-policy family.
 *
 * `satisfies` keeps every member checked against the enum, so an SDK upgrade
 * that renames one is a compile error rather than a silently unhandled case
 * that falls through to LLM_NO_CONTENT.
 */
const CONTENT_BLOCKED_FINISH_REASONS = [
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
  FinishReason.IMAGE_RECITATION,
] as const satisfies readonly FinishReason[];

/** HTTP statuses worth another attempt. 429 is deliberately absent — see
 * `buildRequestConfig`. */
const RETRYABLE_STATUS_CODES = [408, 500, 502, 503, 504];

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** Overall deadline for one `complete()` call, retries included. */
  timeoutMs: number;
  /**
   * Seam for tests: the SDK call itself. Defaulting to the real client keeps
   * production wiring in one place while letting the error-mapping and
   * response-inspection paths be driven directly, with no mocking library and
   * no network.
   */
  generate?: GenerateFn;
}

export type GenerateFn = (args: {
  model: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
}) => Promise<GenerateContentResponse>;

/**
 * Reads the provider's answer and decides whether it is one.
 *
 * Pure and exported because this is the most interesting logic in the
 * integration and the least convenient to reach through a live API: `generate`
 * can return **HTTP 200 with no usable text**, and `response.text` is then
 * `undefined`. The naive adapter hands that to the UI, which renders
 * "undefined" with no error raised anywhere.
 *
 * Three distinct outcomes, not two:
 *   - input blocked, or generation stopped on a policy reason -> blocked
 *   - stopped at the token limit -> partial text, surfaced WITH a warning
 *     rather than discarded, because a truncated answer is still useful
 *   - empty for any other reason -> an error, never an empty-string success
 */
export function interpretGeminiResponse(
  response: GenerateContentResponse,
  requestedModel: string,
): LlmCompletion {
  // The input never reached generation. Checked first because when the prompt
  // is blocked there is no candidate to inspect at all.
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined) {
    throw new LlmContentBlockedError(`prompt:${blockReason}`);
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;

  if (
    finishReason !== undefined &&
    (CONTENT_BLOCKED_FINISH_REASONS as readonly FinishReason[]).includes(
      finishReason,
    )
  ) {
    throw new LlmContentBlockedError(`response:${finishReason}`);
  }

  // `text` is a getter on the response (confirmed against the v2.31.0 types,
  // not the README), and it concatenates the candidate's text parts.
  const text = response.text ?? '';
  const truncated = finishReason === FinishReason.MAX_TOKENS;

  if (text.trim() === '') {
    // Includes the MAX_TOKENS case where the limit was consumed entirely by
    // reasoning tokens: still no answer, so still a failure.
    throw new LlmNoContentError({
      finishReason: finishReason ?? null,
      candidateCount: response.candidates?.length ?? 0,
    });
  }

  const usage = response.usageMetadata;

  return {
    text,
    // `modelVersion` is what actually answered, which for an alias such as
    // `gemini-flash-latest` is a different, more specific string than what
    // was requested. Reporting the resolved value makes a log line
    // reproducible.
    model: response.modelVersion ?? requestedModel,
    finishReason: finishReason ?? null,
    truncated,
    ...(usage
      ? {
          usage: {
            promptTokens: usage.promptTokenCount ?? 0,
            responseTokens: usage.candidatesTokenCount ?? 0,
          },
        }
      : {}),
  };
}

/**
 * Translates a thrown provider failure into this application's vocabulary.
 *
 * The rule this function exists to enforce: **no provider message reaches the
 * client.** Each branch attaches the original as `cause`, which only the
 * logger reads, and supplies its own user-facing text. Provider errors can
 * carry internal endpoints, quota details, project identifiers and, in the
 * worst case, fragments of the credential.
 */
export function mapGeminiError(
  error: unknown,
  context: { timeoutMs: number; deadlineExceeded: boolean },
): never {
  // Our own deadline fired. Checked before anything else, because an aborted
  // fetch surfaces as a generic AbortError that is otherwise indistinguishable
  // from a caller cancelling.
  if (context.deadlineExceeded) {
    throw new LlmTimeoutError(context.timeoutMs, error);
  }

  if (error instanceof ApiError) {
    const { status } = error;
    if (status === 429) {
      // The SDK's ApiError carries `status` and `message` but not headers, so
      // an upstream `Retry-After` is not reachable here. A conservative fixed
      // hint beats inventing one or omitting the header entirely.
      throw new LlmRateLimitedError(30, error);
    }
    throw new LlmUnavailableError(error, { providerStatus: status });
  }

  // DOMException from an aborted fetch where the abort was NOT our deadline:
  // the caller went away. Still mapped to unavailable rather than invented
  // into a success.
  throw new LlmUnavailableError(error);
}

function defaultGenerate(apiKey: string): GenerateFn {
  const client = new GoogleGenAI({ apiKey });

  return ({ model, prompt, signal, timeoutMs }) =>
    client.models.generateContent({
      model,
      contents: prompt,
      config: {
        /**
         * Two timeout mechanisms, composing deliberately (read from the
         * SDK's `createAttemptSignal`, which combines them):
         *
         *   - `httpOptions.timeout` bounds EACH attempt. The SDK builds a
         *     fresh signal per attempt from it.
         *   - `abortSignal` is the same object across every attempt, so it
         *     bounds the WHOLE sequence, retries and backoff included.
         *
         * Without the second, `attempts x timeout + backoff` would be the
         * real worst case and the configured deadline would be a fiction.
         */
        httpOptions: {
          timeout: timeoutMs,
          /**
           * Retry is OFF in this SDK unless `retryOptions` is supplied — the
           * client returns early when it is absent — so the plan's worry
           * about stacking a hand-rolled backoff on top of the SDK was
           * backwards: nothing retries until asked.
           *
           * Asked for, but not with the defaults. Those are 5 attempts with
           * 1s -> 60s exponential backoff, lifted from a storage-retry
           * strategy; inside a request with a human waiting, one 503 would
           * spend 15 seconds in `setTimeout` alone. One extra attempt with a
           * half-second pause recovers a transient blip and costs little.
           *
           * 429 is excluded on purpose. Retrying a rate limit inside the
           * request burns the caller's deadline and adds load to the thing
           * that just asked for less; it belongs in the client's hands, which
           * is why LLM_RATE_LIMITED is a retryable code in the shared
           * contract and carries Retry-After.
           */
          retryOptions: {
            attempts: 2,
            initialDelay: 0.5,
            maxDelay: 2,
            httpStatusCodes: RETRYABLE_STATUS_CODES,
          },
        },
        abortSignal: signal,
      },
    });
}

export function createGeminiProvider(
  options: GeminiProviderOptions,
): LlmProvider {
  const { model, timeoutMs } = options;
  const generate = options.generate ?? defaultGenerate(options.apiKey);

  return {
    name: 'gemini',

    async complete({ prompt, signal }: LlmCompleteInput): Promise<LlmCompletion> {
      // Held separately from the combined signal so the catch block can tell
      // "we ran out of time" from "the caller went away" — two outcomes that
      // both arrive as an indistinguishable AbortError.
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined =
        signal === undefined
          ? deadline
          : AbortSignal.any([deadline, signal]);

      let response: GenerateContentResponse;
      try {
        response = await generate({
          model,
          prompt,
          signal: combined,
          timeoutMs,
        });
      } catch (error) {
        mapGeminiError(error, {
          timeoutMs,
          deadlineExceeded: deadline.aborted,
        });
      }

      return interpretGeminiResponse(response, model);
    },
  };
}

export default createGeminiProvider;
