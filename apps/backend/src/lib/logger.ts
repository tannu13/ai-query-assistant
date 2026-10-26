/**
 * Structured logging with redaction.
 *
 * One JSON object per line on stdout, because that is what a log aggregator
 * wants and because the request id is only useful as a queryable field (plan
 * §12 makes it the CloudWatch correlation key). There is no pretty-printing
 * mode: two output formats means the one used in production is the one never
 * looked at during development.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** `silent` is a threshold only — nothing is ever logged *at* that level. */
type LevelThreshold = LogLevel | 'silent';

const LEVEL_WEIGHT: Record<LevelThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

/**
 * Derived from NODE_ENV rather than from a variable of its own, so the
 * documented env schema does not have to carry a key that only affects
 * console noise.
 *
 * `test` is silent because the suite's job is to provoke the failures this
 * logger is built to record: a run that logged them would bury thirteen
 * assertions under forty kilobytes of expected stack traces. What is under
 * test is the error *response*, which the assertions read directly.
 */
const MIN_LEVEL: LevelThreshold =
  process.env.NODE_ENV === 'test'
    ? 'silent'
    : process.env.NODE_ENV === 'production'
      ? 'info'
      : 'debug';

const REDACTED = '[redacted]';

/**
 * Key names whose values are never printed, matched on substring so
 * `GEMINI_API_KEY`, `authorization` and `refreshToken` are all covered.
 *
 * This is a backstop, not the primary control. The primary control is not
 * passing secrets to the logger in the first place; this catches the case
 * where someone logs a whole config or header object by accident.
 */
const SENSITIVE_KEY =
  /(secret|token|password|passwd|api[-_]?key|apikey|authorization|cookie|credential|bearer)/i;

/** Long strings are truncated: prompts are user content and possibly PII. */
const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_LENGTH = 20;
const MAX_DEPTH = 4;

export function truncate(value: string, max = MAX_STRING_LENGTH): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

/**
 * Exported so the redaction guarantee is testable.
 *
 * The logger is silent under NODE_ENV=test, so a test cannot observe it by
 * capturing stdout — and redaction is the reason this module exists instead
 * of `console.log`, so it is part of the contract rather than an internal.
 */
export function redactForLog(value: unknown): unknown {
  return redact(value);
}

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serialiseError(value, depth);

  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redact(item, depth + 1));
    return value.length > MAX_ARRAY_LENGTH
      ? [...head, `…(+${value.length - MAX_ARRAY_LENGTH} more)`]
      : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return out;
  }

  return String(value);
}

/**
 * Errors do not serialise through JSON.stringify — `{}` is the usual result —
 * so they are unpacked explicitly, including the `cause` chain, which is where
 * this app parks upstream provider detail it refuses to send to a client.
 */
function serialiseError(error: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: truncate(error.message, 1024),
  };
  if (error.stack) out.stack = truncate(error.stack, 4096);
  // Carried by AppError and by http-errors / provider SDK errors alike.
  for (const key of ['code', 'status', 'statusCode', 'type'] as const) {
    const extra = (error as unknown as Record<string, unknown>)[key];
    if (extra !== undefined) out[key] = extra;
  }
  if (error.cause !== undefined && depth < MAX_DEPTH) {
    out.cause = redact(error.cause, depth + 1);
  }
  return out;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bindings` onto every line it writes. */
  child(bindings: LogFields): Logger;
}

function write(level: LogLevel, bindings: LogFields, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(redact({ ...bindings, ...fields }) as LogFields),
  };

  const line = `${JSON.stringify(entry)}\n`;
  // stderr for warn/error so `bun run start > app.log` still surfaces
  // problems on the terminal.
  if (LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.warn) process.stderr.write(line);
  else process.stdout.write(line);
}

function createLogger(bindings: LogFields = {}): Logger {
  return {
    debug: (message, fields) => write('debug', bindings, message, fields),
    info: (message, fields) => write('info', bindings, message, fields),
    warn: (message, fields) => write('warn', bindings, message, fields),
    error: (message, fields) => write('error', bindings, message, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger();
export default logger;
