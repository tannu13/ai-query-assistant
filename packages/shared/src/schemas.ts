import z from 'zod';

import { ERROR_CODES } from './errors';

/**
 * Every error response from the API has exactly this shape, whatever failed.
 * One envelope means the web app has one error path rather than one per route.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    /** Safe to show the user. Never carries upstream provider detail. */
    message: z.string(),
    /** Correlates the failure the user saw with the server log line. */
    requestId: z.string(),
    /** Field-level detail, present only for VALIDATION_FAILED. */
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
  stage: z.enum(['dev', 'prod']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const loginRequestSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  /** Lifetime in seconds, so the client need not parse the JWT to know it. */
  expiresIn: z.number().int().positive(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * Identity of the caller behind the current token.
 *
 * Exists so Phase 3's auth cycle is verifiable before `/api/query` exists,
 * and kept because it is genuinely useful in the README's curl walkthrough:
 * it is the one call that shows a token's claims without asking the reader
 * to base64-decode anything.
 */
export const meResponseSchema = z.object({
  /** Opaque subject id — deliberately not the email. */
  sub: z.string(),
  email: z.email(),
  /** `exp` claim, seconds since the epoch. */
  exp: z.number().int().positive(),
  /** Seconds until this token expires, for convenience. */
  expiresInSeconds: z.number().int(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Contract default for the prompt cap, mirrored client-side for immediate
 * feedback. The server's own cap is configurable (LLM_MAX_PROMPT_CHARS) and is
 * the only one that is authoritative — the client-side check is a convenience,
 * never a control. Lowering the server cap below this value leaves the mirror
 * permissive, which is harmless: the server still rejects.
 */
export const PROMPT_MAX_CHARS = 4000;

/**
 * Built as a factory so the server can inject its configured cap while sharing
 * one definition of the request shape.
 */
export function makeQueryRequestSchema(maxChars: number = PROMPT_MAX_CHARS) {
  return z.object({
    prompt: z
      .string()
      .trim()
      .min(1, 'Enter a question before submitting')
      .max(maxChars, `Prompt must be at most ${maxChars} characters`),
  });
}

export const queryRequestSchema = makeQueryRequestSchema();
export type QueryRequest = z.infer<typeof queryRequestSchema>;

export const queryResponseSchema = z.object({
  answer: z.string(),
  /** Echoed back so the UI can show which model actually answered. */
  model: z.string(),
  /** Provider's stop reason, when it reports one. */
  finishReason: z.string().nullable(),
  /**
   * True when the provider stopped at its token limit. The answer is still
   * usable but incomplete, which is a different thing to tell the user than
   * either success or failure.
   */
  truncated: z.boolean(),
  requestId: z.string(),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      responseTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export type QueryResponse = z.infer<typeof queryResponseSchema>;
