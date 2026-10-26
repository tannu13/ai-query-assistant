import { makeQueryRequestSchema, type QueryResponse } from '@repo/shared';
import { Router, type Request, type Response } from 'express';

import env from '../env';
import { parseOrThrow } from '../lib/validate';
import createRateLimit from '../middleware/rateLimit';
import requireAuth from '../middleware/requireAuth';
import { llmProvider } from '../services/llm';

export const queryRouter = Router();

/**
 * Built once at module load with the configured cap, from the shared factory.
 *
 * The cap is therefore enforced by the same definition the web app imports
 * for its client-side mirror — so the two cannot drift into the state where
 * the UI permits a prompt the server rejects.
 */
const queryRequestSchema = makeQueryRequestSchema(env.LLM_MAX_PROMPT_CHARS);

/**
 * Keyed on the JWT subject rather than the IP.
 *
 * The limit should follow the account, not the network path: otherwise a
 * shared NAT puts an office behind one bucket, while an attacker with a
 * handful of addresses gets a fresh budget per address. `requireAuth` runs
 * first precisely so this key exists — which is why the middleware order on
 * the route below is not interchangeable.
 *
 * The IP fallback is unreachable while this sits behind `requireAuth`; it is
 * there so that mounting this limiter on an unauthenticated route cannot
 * silently collapse every caller into a single `undefined` bucket.
 */
const queryRateLimit = createRateLimit({
  capacity: 20,
  refillPerMinute: 20,
  keyOf: (req) => req.auth?.subject ?? `ip:${req.ip ?? 'unknown'}`,
});

queryRouter.post(
  '/api/query',
  requireAuth,
  queryRateLimit,
  async (req: Request, res: Response) => {
    // Validation precedes everything that costs money. An oversized or empty
    // prompt is rejected here, before a single token is spent — confirmed by
    // a test that asserts the provider was never called.
    const { prompt } = parseOrThrow(queryRequestSchema, req.body);

    /**
     * No client-disconnect cancellation, and that is a measured conclusion
     * rather than an omission.
     *
     * The intent was to abort the upstream call when the browser goes away,
     * so an abandoned request stops costing tokens. Under Bun's `node:http`
     * compatibility layer there is no server-side signal to hang it on. For
     * a POST, measured against Bun 1.3.13 + Express 5:
     *
     *   - `req` emits `close` at +0ms — when the request BODY is consumed,
     *     not when the client leaves — so it fires identically whether or
     *     not the client is still there. `req.destroyed` flips at the same
     *     moment, for the same reason.
     *   - On an actual disconnect, `res` emits nothing at all: no `close`,
     *     no `finish`. `req` emits no `aborted`. The socket emits no `close`
     *     and `socket.destroyed` stays false.
     *   - On a normal response, `res` emits `finish` then `close`.
     *
     * So the conventional `res.on('close')` wiring fires exactly when it is
     * not needed and stays silent when it is. Shipping it would have looked
     * like working cancellation while doing nothing — strictly worse than
     * not having it, because it would be believed.
     *
     * The seam itself is real and unit-tested: `LlmCompleteInput.signal` is
     * honoured by the adapter, which composes it with its own deadline. Only
     * the HTTP-layer source of that signal is missing, and it arrives free by
     * running on Node, or by serving with `Bun.serve`, whose `Request.signal`
     * aborts on disconnect. Noted in the README as a known limitation.
     *
     * The adapter's own `LLM_TIMEOUT_MS` deadline is unaffected and still
     * bounds every call, so a hung provider cannot pin a request open.
     */
    const startedAt = performance.now();
    // No try/catch. Every failure the provider can raise is already a typed
    // AppError, and the single error-translation middleware owns the
    // response — a catch here could only make the envelope inconsistent.
    const completion = await llmProvider.complete({ prompt });

    req.log.info('query completed', {
      provider: llmProvider.name,
      model: completion.model,
      finishReason: completion.finishReason,
      truncated: completion.truncated,
      promptChars: prompt.length,
      answerChars: completion.text.length,
      usage: completion.usage,
      durationMs: Math.round(performance.now() - startedAt),
      // Deliberately not the prompt text. It is user content and potentially
      // PII; its length is what is actually useful for diagnosis.
    });

    const body: QueryResponse = {
      answer: completion.text,
      model: completion.model,
      finishReason: completion.finishReason,
      truncated: completion.truncated,
      requestId: req.requestId,
      ...(completion.usage ? { usage: completion.usage } : {}),
    };
    res.status(200).json(body);
  },
);

export default queryRouter;
