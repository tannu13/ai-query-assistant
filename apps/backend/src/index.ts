import env from './env';
import logger from './lib/logger';
import app from './server';

/**
 * Process entrypoint. Everything testable lives in `server.ts`, which exports
 * the Express app without binding a port; this file is the only place that
 * listens, and therefore the only place that has to care about how the
 * process dies.
 */
const server = app.listen(env.APP_PORT, () => {
  logger.info('server listening', {
    port: env.APP_PORT,
    stage: env.APP_STAGE,
    provider: env.LLM_PROVIDER,
    model: env.GEMINI_MODEL,
  });
});

/**
 * Graceful shutdown, added because the container gate measured its absence:
 * `docker stop` took 10.16s and the container exited 137, meaning SIGTERM was
 * ignored and Docker resorted to SIGKILL after its grace period.
 *
 * That is not cosmetic here. A single LLM call is allowed up to
 * LLM_TIMEOUT_MS (20s by default), so on an unhandled SIGTERM every in-flight
 * query is severed mid-await — the client sees a dropped connection rather
 * than an answer or a typed error. Since a rolling deploy sends SIGTERM to
 * every task by design, "deploy" and "drop live requests" would be the same
 * event.
 *
 * What this does, in order: stop accepting new connections, let in-flight
 * requests finish, close keep-alive sockets that are idle (otherwise a
 * browser holding an open connection keeps the server alive to the deadline
 * for no reason), and exit 0 on our own terms.
 */
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  /**
   * A second signal means impatience, not a reason to restart the clock —
   * so it force-exits instead. This also makes a double Ctrl-C behave the way
   * everyone already expects it to.
   */
  if (shuttingDown) {
    logger.warn('second signal during shutdown; exiting now', { signal });
    process.exit(1);
  }
  shuttingDown = true;

  logger.info('shutdown requested', {
    signal,
    graceMs: env.SHUTDOWN_TIMEOUT_MS,
  });

  /**
   * Armed before `server.close()` rather than after, so a connection that
   * never finishes draining cannot leave the process hanging until the
   * orchestrator's own SIGKILL. `unref()` keeps this timer from being the
   * thing holding the event loop open once draining succeeds.
   */
  const deadline = setTimeout(() => {
    logger.error('shutdown deadline exceeded; forcing exit', {
      graceMs: env.SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  server.close((error) => {
    if (error) {
      logger.error('error while closing the server', { error });
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });

  // Idle keep-alive sockets only. `closeAllConnections` would kill the
  // in-flight requests this function exists to protect.
  server.closeIdleConnections();
}

// SIGTERM is what an orchestrator sends (Docker, ECS, Kubernetes); SIGINT is
// Ctrl-C in a terminal. Both should mean the same thing.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
