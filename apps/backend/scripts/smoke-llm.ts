/**
 * One real provider call, with no Express involved.
 *
 *   bun run scripts/smoke-llm.ts "Why is the sky blue?"
 *   LLM_TIMEOUT_MS=1 bun run scripts/smoke-llm.ts "hello"
 *
 * This is the Phase 4 gate, and it is a script rather than a test on purpose:
 * it isolates "does the SDK behave the way the adapter assumes" from "is the
 * route wired correctly". If the first real query only failed at Phase 5, the
 * cause would be ambiguous across two layers — the HTTP plumbing and the
 * provider integration — and debugging would start by guessing which.
 *
 * It exits non-zero on failure, so it is usable as a deployment smoke check
 * and not only by eye.
 */
import env from '../src/env';
import { AppError } from '../src/lib/errors';
import { llmProvider } from '../src/services/llm';

const prompt = process.argv.slice(2).join(' ').trim() || 'Why is the sky blue?';

console.log('provider    :', llmProvider.name);
console.log('model       :', env.GEMINI_MODEL);
console.log('timeout     :', `${env.LLM_TIMEOUT_MS}ms`);
console.log('prompt      :', prompt);

if (llmProvider.name === 'fake') {
  // A smoke check that cannot fail is not a smoke check. Said loudly so a
  // green run with LLM_PROVIDER=fake is never mistaken for a real one.
  console.warn(
    '\n⚠  LLM_PROVIDER=fake — this did NOT call a real model.\n' +
      '   Set LLM_PROVIDER=gemini to exercise the real provider.\n',
  );
}

const startedAt = performance.now();

try {
  const completion = await llmProvider.complete({ prompt });
  const elapsedMs = Math.round(performance.now() - startedAt);

  console.log('\n--- ok ---');
  console.log('resolved model :', completion.model);
  console.log('finishReason   :', completion.finishReason);
  console.log('truncated      :', completion.truncated);
  console.log('usage          :', JSON.stringify(completion.usage ?? null));
  console.log('elapsed        :', `${elapsedMs}ms`);
  console.log('\nanswer:\n');
  console.log(completion.text);
  process.exit(0);
} catch (error) {
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (error instanceof AppError) {
    // The typed failure the adapter is supposed to produce. Printing the
    // code, status and cause separately is the point of the check: a timeout
    // must arrive as LLM_TIMEOUT/504, not as an unhandled rejection or a hang.
    console.error('\n--- typed failure ---');
    console.error('code      :', error.code);
    console.error('status    :', error.status);
    console.error('message   :', error.message);
    console.error('context   :', JSON.stringify(error.context ?? null));
    console.error('elapsed   :', `${elapsedMs}ms`);
    console.error(
      'cause     :',
      error.cause instanceof Error
        ? `${error.cause.name}: ${error.cause.message}`
        : String(error.cause ?? 'none'),
    );
    process.exit(1);
  }

  console.error('\n--- UNTYPED failure (the adapter should have mapped this) ---');
  console.error(error);
  process.exit(2);
}
