import { readinessResponseSchema } from '@repo/shared';
import { describe, expect, it } from 'bun:test';

import {
  BACKEND_DIR,
  childEnv,
  findLog,
  parseLogLines,
  probe,
  reserveFreePort,
  waitForListening,
} from './helpers/childProcess';

interface Drained {
  before: Awaited<ReturnType<typeof probe>>;
  readyDuring: Awaited<ReturnType<typeof probe>>;
  healthDuring: Awaited<ReturnType<typeof probe>>;
  exitCode: number;
  logs: ReturnType<typeof parseLogLines>;
}

/**
 * Starts the real entrypoint, SIGTERMs it, and probes readiness on a **fresh
 * connection** during the drain.
 *
 * A fresh connection is the whole point of running this out of process. The
 * in-process test in `readiness.test.ts` proves the handler returns 503 when
 * the lifecycle says draining — and it would keep proving that even if the
 * listener were closed before any poller could ever ask. Only a real socket
 * against a real `server.close()` can tell those apart.
 */
async function drainWith(readinessDrainMs: number): Promise<Drained> {
  const port = await reserveFreePort();
  const child = Bun.spawn({
    cmd: ['bun', 'src/index.ts'],
    cwd: BACKEND_DIR,
    env: childEnv(port, { READINESS_DRAIN_MS: String(readinessDrainMs) }),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForListening(base);

  const before = await probe(`${base}/ready`);

  child.kill('SIGTERM');
  // Comfortably inside a non-zero window and comfortably past the tick in
  // which a zero window closes the listener.
  await Bun.sleep(150);

  const readyDuring = await probe(`${base}/ready`);
  const healthDuring = await probe(`${base}/health`);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    before,
    readyDuring,
    healthDuring,
    exitCode,
    logs: parseLogLines(stdout, stderr),
  };
}

describe('two-phase drain', () => {
  it('answers 503 draining on a fresh connection, while liveness stays 200', async () => {
    const run = await drainWith(2_000);

    expect(run.before.status).toBe(200);

    // The assertion this whole file exists for.
    expect(run.readyDuring.status).toBe(503);
    expect(
      readinessResponseSchema.parse(run.readyDuring.body).status,
    ).toBe('draining');

    // Liveness must NOT go red during a deliberate drain: a failing liveness
    // probe is an instruction to restart, which is the wrong response to a
    // process that is shutting down correctly.
    expect(run.healthDuring.status).toBe(200);

    expect(findLog(run.logs, 'advertising unreadiness before closing the listener')).toBeDefined();
    expect(findLog(run.logs, 'shutdown complete')).toBeDefined();
    // Asked to stop, and stopped. Not a fault.
    expect(run.exitCode).toBe(0);
  }, 20_000);

  /**
   * The counterfactual, committed on purpose.
   *
   * With no window, `server.close()` runs in the same tick as the readiness
   * flip and the 503 becomes unreachable — the listener is gone before any
   * poller can ask. `readiness.test.ts` passes either way, which is precisely
   * why this test is here: it is the one that fails if someone decides the
   * window is redundant and removes it.
   */
  it('without the window, the 503 is unobservable — which is why the window exists', async () => {
    const run = await drainWith(0);

    // Proof the server really was up, so the failure below is the drain
    // closing the listener and not a child that never started.
    expect(run.before.status).toBe(200);

    expect(run.readyDuring.unreachable).toBe(true);
    expect(run.healthDuring.unreachable).toBe(true);

    expect(findLog(run.logs, 'advertising unreadiness before closing the listener')).toBeUndefined();
    expect(run.exitCode).toBe(0);
  }, 20_000);
});
