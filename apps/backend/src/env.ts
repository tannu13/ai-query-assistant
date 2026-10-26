import { PROMPT_MAX_CHARS } from '@repo/shared';
import z from 'zod';

/** `$2b$10$` plus a 53-character salt-and-digest, per the bcrypt format. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** Total, never throwing: a malformed value must surface as a zod issue
 * alongside every other configuration problem, not as a crash that hides
 * them. */
function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const EnvSchema = z.object({
  APP_PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_STAGE: z.enum(['dev', 'prod']).default('dev'),

  /** bcrypt cost factor, used when hashing and comparing the demo password. */
  SALT_ROUNDS: z.coerce.number().positive().default(10),

  /**
   * The single demo identity. There is no database and no registration: the
   * brief asks for a protected endpoint, not user management, so one
   * credential in configuration is the honest minimum.
   */
  DEMO_USER_EMAIL: z.email().default('demo@example.com'),
  /**
   * bcrypt hash of the demo password, **base64-encoded**.
   *
   * The encoding is not decoration, and it is not paranoia — it is the only
   * form of the value that survives every loader this repo uses. A bcrypt
   * hash is `$2b$10$…`, and:
   *
   *   - Bun's dotenv loader expands `$VAR` in `.env`, under single quotes,
   *     double quotes and none alike, so `$2b`, `$10` and `$KLcJ…` are each
   *     consumed as undefined variables and the hash silently arrives 20
   *     characters long.
   *   - Backslash-escaping (`\$2b\$10\$…`) is the only thing Bun honours,
   *     but Docker's `--env-file` does not interpret escapes, so the same
   *     file would then deliver literal backslashes to the container.
   *
   * Base64 is byte-identical through both, and through an injected secret
   * (AWS Secrets Manager -> ECS task `secrets`), where no parsing happens at
   * all. `scripts/hash-password.ts` emits this form directly.
   *
   * Validated by decoding and matching the bcrypt shape, so the actual
   * mistake someone makes here — pasting the plaintext password, or the raw
   * unencoded hash — fails at boot with a message that says which.
   */
  DEMO_USER_PASSWORD_HASH_B64: z
    .string()
    .min(1, 'DEMO_USER_PASSWORD_HASH_B64 is required')
    .refine((value) => BCRYPT_HASH.test(decodeBase64(value)), {
      message:
        "DEMO_USER_PASSWORD_HASH_B64 must be a base64-encoded bcrypt hash. Generate one with: bun run scripts/hash-password.ts '<password>'",
    }),

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

  /**
   * Which implementation of the LlmProvider seam to use.
   *
   * `fake` exists so the frontend's error states and the full request path
   * can be demonstrated without spending tokens — every failure in the error
   * matrix is reachable from a prompt prefix. It is refused when
   * APP_STAGE=prod by the check below: a deployment silently serving canned
   * answers is a worse outcome than a deployment that will not start.
   */
  LLM_PROVIDER: z.enum(['gemini', 'fake']).default('gemini'),

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

/**
 * The validated environment, plus the one value that is derived rather than
 * read: the decoded password hash. Keeping the raw and decoded forms under
 * different names means no call site has to remember which it is holding.
 */
/**
 * Cross-field rules, which belong here rather than at the use site: a
 * misconfiguration should stop the process at boot, not surface on the first
 * request that happens to exercise it.
 */
const ValidatedEnvSchema = EnvSchema.superRefine((value, ctx) => {
  if (value.LLM_PROVIDER === 'fake' && value.APP_STAGE === 'prod') {
    ctx.addIssue({
      code: 'custom',
      path: ['LLM_PROVIDER'],
      message:
        'LLM_PROVIDER=fake is not permitted when APP_STAGE=prod — it would serve canned answers from a production deployment',
    });
  }
});

type Env = z.infer<typeof EnvSchema> & {
  /** Decoded from DEMO_USER_PASSWORD_HASH_B64, already shape-validated. */
  DEMO_USER_PASSWORD_HASH: string;
};

let env: Env;
try {
  const parsed = ValidatedEnvSchema.parse(process.env);
  env = {
    ...parsed,
    // Guaranteed to match BCRYPT_HASH: the refine above already decoded and
    // checked it, so this cannot fail without the schema having passed a
    // value it rejected.
    DEMO_USER_PASSWORD_HASH: decodeBase64(parsed.DEMO_USER_PASSWORD_HASH_B64),
  };
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
