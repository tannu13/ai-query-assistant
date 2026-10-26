import net from 'node:net';
import path from 'node:path';

export const BACKEND_DIR = path.resolve(import.meta.dir, '..', '..');

/**
 * Binds an ephemeral port, reads it, releases it, and hands it to a child.
 *
 * There is a window between releasing and the child binding, so callers must
 * assert something specific rather than merely a non-zero exit — a lost race
 * surfaces as EADDRINUSE, which would otherwise pass a "it failed" assertion
 * for entirely the wrong reason.
 *
 * `env.APP_PORT` requires a positive integer, so a child cannot simply be
 * given port 0. That is correct for a server — a port nobody can predict is
 * not a port anyone can reach — and it is the reason this helper exists.
 */
export async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an ephemeral TCP address'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Environment for a child that must actually log.
 *
 * The suite runs with NODE_ENV=test, under which the logger is silent by
 * design — and in these tests the log line *is* the deliverable. The child
 * therefore runs as `development`, inheriting the rest of `.env.test`'s
 * placeholder configuration from this process so it still needs no local
 * `.env` to boot.
 *
 * `APP_STAGE` and `LLM_PROVIDER` are pinned explicitly: `fake` is refused
 * when APP_STAGE=prod, and a developer's own `.env` must not be able to
 * change what these tests assert.
 */
export function childEnv(
  port: number,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'development',
    APP_STAGE: 'dev',
    LLM_PROVIDER: 'fake',
    APP_PORT: String(port),
    ...overrides,
  };
}

/** One structured log line as the logger emits it. */
export type LogLine = Record<string, unknown>;

/**
 * Collects the child's structured lines from both streams.
 *
 * Both, because the logger splits by level on purpose — info to stdout, warn
 * and error to stderr, so `bun run start > app.log` still surfaces problems
 * on the terminal. A test that read only one stream would miss half the
 * sequence it is asserting.
 */
export function parseLogLines(stdout: string, stderr: string): LogLine[] {
  return [...stdout.split('\n'), ...stderr.split('\n')]
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogLine];
      } catch {
        return [];
      }
    });
}

export function findLog(
  logs: LogLine[],
  message: string,
): LogLine | undefined {
  return logs.find((entry) => entry.message === message);
}

/** Resolves once the child is serving, or throws if it never gets there. */
export async function waitForListening(
  base: string,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`child never started serving at ${base}`);
}

export interface ProbeResult {
  status: number | null;
  body: unknown;
  /** True when the connection itself failed — refused, reset, or closed. */
  unreachable: boolean;
}

export async function probe(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url);
    return {
      status: response.status,
      body: await response.json(),
      unreachable: false,
    };
  } catch {
    return { status: null, body: undefined, unreachable: true };
  }
}
