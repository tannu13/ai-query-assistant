import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import {
  BACKEND_DIR,
  childEnv,
  findLog,
  parseLogLines,
  reserveFreePort,
  type LogLine,
} from './helpers/childProcess';

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  logs: LogLine[];
}

async function runHarness(fixture: string, mode?: string): Promise<Run> {
  const port = await reserveFreePort();

  const child = Bun.spawn({
    cmd: [
      'bun',
      'run',
      path.join('tests', 'fixtures', fixture),
      ...(mode === undefined ? [] : [mode]),
    ],
    cwd: BACKEND_DIR,
    /**
     * No readiness window here. What these tests assert is the *fault* path —
     * that a crash is logged, drained and exited deliberately. The window's
     * own behaviour is `drain.test.ts`'s subject, and leaving it on would add
     * a second of wall clock to every case below for no extra assertion.
     */
    env: childEnv(port, { READINESS_DRAIN_MS: '0' }),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr, logs: parseLogLines(stdout, stderr) };
}

describe('fatal fault handling', () => {
  /**
   * The premise the handlers exist for. If this ever fails because the
   * process survived, the justification in `src/index.ts` has gone stale and
   * needs rewriting — which is the only reason to assert a runtime's own
   * behaviour in an application's suite.
   */
  it('without a handler, Bun kills the process on an unhandled rejection', async () => {
    const run = await runHarness('no-handler-harness.ts');

    expect(run.stdout).not.toContain('STILL_ALIVE');
    expect(run.exitCode).not.toBe(0);
  }, 15_000);

  it('survives an unhandled rejection long enough to log it and drain', async () => {
    const run = await runHarness('crash-harness.ts', 'rejection');

    // Logged, in this app's format, at a level that alerts.
    const fatalLine = findLog(run.logs, 'fatal: unhandledRejection');
    expect(fatalLine).toBeDefined();
    expect(fatalLine?.level).toBe('error');
    expect(JSON.stringify(fatalLine)).toContain('provoked unhandled rejection');

    // Drained rather than died: both ends of the shutdown sequence ran.
    expect(findLog(run.logs, 'shutdown requested')?.reason).toBe(
      'unhandledRejection',
    );
    expect(findLog(run.logs, 'shutdown complete')).toBeDefined();

    // A fault is not a clean stop, and the exit code has to say so — this is
    // what an orchestrator reads to decide whether the task failed.
    expect(run.exitCode).toBe(1);
  }, 15_000);

  it('handles an uncaught exception the same way', async () => {
    const run = await runHarness('crash-harness.ts', 'exception');

    const fatalLine = findLog(run.logs, 'fatal: uncaughtException');
    expect(fatalLine).toBeDefined();
    expect(fatalLine?.level).toBe('error');
    expect(JSON.stringify(fatalLine)).toContain('provoked uncaught exception');

    expect(findLog(run.logs, 'shutdown requested')?.reason).toBe(
      'uncaughtException',
    );
    expect(run.exitCode).toBe(1);
  }, 15_000);

  /**
   * A second fault mid-drain must not restart the clock, and must not recurse
   * through `shutdown`.
   */
  it('force-exits when a second fault arrives during the drain', async () => {
    const run = await runHarness('crash-harness.ts', 'double');

    expect(findLog(run.logs, 'shutdown requested')).toBeDefined();
    const second = findLog(
      run.logs,
      'second shutdown trigger while already draining; exiting now',
    );
    expect(second).toBeDefined();
    expect(second?.level).toBe('warn');

    // Exactly one drain was started, whatever arrived afterwards.
    expect(
      run.logs.filter((entry) => entry.message === 'shutdown requested'),
    ).toHaveLength(1);

    expect(run.exitCode).toBe(1);
  }, 15_000);

  /**
   * The log line is the deliverable, and `process.exit()` is capable of
   * truncating a pipe that is still flushing. Measured as intact under Bun
   * 1.3.13, and asserted here so a regression in that behaviour shows up as a
   * test failure rather than as a crash nobody can explain.
   */
  it('does not lose the fatal log line to the immediate exit', async () => {
    const run = await runHarness('crash-harness.ts', 'rejection');

    expect(run.stderr).toContain('fatal: unhandledRejection');
    // The last thing written before process.exit, so it is the line most
    // exposed to a truncated flush.
    expect(run.stdout).toContain('shutdown complete');
  }, 15_000);
});
