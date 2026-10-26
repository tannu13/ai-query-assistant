import { PROMPT_MAX_CHARS } from '@repo/shared';
import z from 'zod';

const EnvSchema = z.object({
  APP_PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_STAGE: z.enum(['dev', 'prod']).default('dev'),

  /** bcrypt cost factor, used when hashing and comparing the demo password. */
  SALT_ROUNDS: z.coerce.number().positive().default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /**
   * Asserted on verify, not merely stamped on sign — a claim that is never
   * checked is decoration.
   */
  JWT_ISSUER: z.string().min(1).default('ai-query-assistant'),
  JWT_AUDIENCE: z.string().min(1).default('ai-query-assistant-web'),
  /** Any `jsonwebtoken` expiresIn value, e.g. `15m`, `30s`, `1h`. */
  JWT_EXPIRES_IN: z.string().min(1).default('15m'),

  /**
   * Google AI Studio credential. Whether the key is *valid* cannot be checked
   * here — that would mean spending a network call on every boot — so this
   * asserts only presence and a plausible length. The first real proof is the
   * provider smoke check; a wrong-but-present key fails there, not here.
   */
  GEMINI_API_KEY: z
    .string()
    .min(10, 'GEMINI_API_KEY is too short to be a real key'),
  GEMINI_MODEL: z.string().min(1).default('gemini-flash-latest'),

  /** Upper bound on a single provider call before it is aborted. */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /**
   * Authoritative prompt cap. Defaults to the shared contract value so the
   * client-side mirror agrees unless this is deliberately overridden.
   */
  LLM_MAX_PROMPT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(PROMPT_MAX_CHARS),

  /**
   * Browser origins allowed to call this API. Comma-separated; no wildcard,
   * because CORS forbids `*` alongside credentials.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3020')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

type Env = z.infer<typeof EnvSchema>;

let env: Env;
try {
  env = EnvSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    // Fail at boot, loudly and specifically, rather than at the first request
    // that happens to need the missing value.
    console.error('Invalid environment variables:\n');
    for (const issue of error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    console.error('\nSee apps/backend/.env.example for the expected shape.\n');
    process.exit(1);
  }
  throw error;
}

export default env;
export { env };
