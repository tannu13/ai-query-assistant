import env from '../../env';
import logger from '../../lib/logger';
import createFakeLlmProvider from './fake';
import createGeminiProvider from './gemini';
import type { LlmProvider } from './provider';

export type { LlmCompleteInput, LlmCompletion, LlmProvider } from './provider';

/**
 * Chooses the provider from configuration, once, at import time.
 *
 * A singleton because the Gemini client holds connection state worth reusing
 * across requests, and because constructing it per request would make the
 * credential appear in a hot path for no benefit.
 */
function createProvider(): LlmProvider {
  if (env.LLM_PROVIDER === 'fake') {
    // env.ts refuses this combination at boot; this is the second gate, so
    // that a future caller constructing a provider directly cannot bypass it.
    if (env.APP_STAGE === 'prod') {
      throw new Error('LLM_PROVIDER=fake is not permitted when APP_STAGE=prod');
    }
    logger.warn('using the FAKE llm provider — no model will be called', {
      stage: env.APP_STAGE,
    });
    return createFakeLlmProvider();
  }

  return createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
  });
}

export const llmProvider: LlmProvider = createProvider();
export default llmProvider;
