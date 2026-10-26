/**
 * Boots the real entrypoint, then provokes a fault in it.
 *
 * Importing `../../src/index` is the point: it installs the handlers and
 * binds a port exactly as production does, so what is under test is the
 * shipped wiring rather than a reconstruction of it. The alternative — a
 * route in the real app that throws on demand — would be the test dictating
 * the product, which this suite declines to do elsewhere too (see
 * `errorHandler.test.ts`, which builds its own throwing app for the same
 * reason).
 *
 * Run as a subprocess by `crash.test.ts`, which reads the exit code and the
 * log lines. It cannot be an in-process test: the behaviour being asserted is
 * that the process exits, and a test runner that exits is not a test runner.
 */
import '../../src/index';

const mode = process.argv[2];

/**
 * Deferred a tick so `listen()` has completed and the "server listening" line
 * is out before the fault — otherwise the test cannot tell a crash during
 * startup from a crash while serving.
 */
setTimeout(() => {
  switch (mode) {
    case 'rejection':
      void Promise.reject(new Error('provoked unhandled rejection'));
      return;

    case 'exception':
      throw new Error('provoked uncaught exception');

    /**
     * Two faults in the same tick. `unhandledRejection` fires on the
     * microtask checkpoint, so both handlers run back to back and the second
     * necessarily lands while the first drain is still open — `server.close()`
     * cannot have called back yet. That makes the force-exit branch reachable
     * deterministically, with no sleep and no race.
     */
    case 'double':
      void Promise.reject(new Error('provoked first fault'));
      void Promise.reject(new Error('provoked second fault'));
      return;

    default:
      process.stderr.write(`unknown mode: ${mode}\n`);
      process.exit(99);
  }
}, 50);
