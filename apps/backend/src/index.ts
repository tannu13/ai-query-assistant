import env from './env';
import { beginDraining } from './lib/lifecycle';
import logger from './lib/logger';
import app from './server';

/**
 * Process entrypoint. Everything testable lives in `server.ts`, which exports
 * the Express app without binding a port; this file is the only place that
 * listens, and therefore the only place that has to care about how the
 * process dies — by signal (an orchestrator stopping it) or by fault (a
 * promise nobody caught).
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
 * What this does, in order: mark the process as draining so `/ready` answers
 * 503; keep accepting for READINESS_DRAIN_MS so whatever polls readiness has
 * a chance to see that and stop routing here; then stop accepting, let
 * in-flight requests finish, close keep-alive sockets that are idle
 * (otherwise a browser holding an open connection keeps the server alive to
 * the deadline for no reason), and exit on our own terms.
 *
 * The two-phase shape is the part that is easy to get wrong. "Stop being
 * advertised" and "stop accepting" are different events, and collapsing them
 * into one tick leaves the readiness endpoint unreadable exactly when it
 * matters — see READINESS_DRAIN_MS in env.ts.
 *
 * `reason` is a string rather than a NodeJS.Signals because a fault is also a
 * reason to drain — see `fatal` below.
 */
function shutdown(reason: string, exitCode: number): void {
  /**
   * A second trigger means impatience, not a reason to restart the clock —
   * so it force-exits instead. This also makes a double Ctrl-C behave the way
   * everyone already expects it to, and it is what stops a fault raised
   * *during* a drain from recursing through this function.
   *
   * `beginDraining()` reports whether this call is the one that started the
   * drain, so the check and the state change are a single operation; a
   * separate boolean read first is the version with a race in it.
   */
  if (!beginDraining()) {
    logger.warn('second shutdown trigger while already draining; exiting now', {
      reason,
    });
    process.exit(1);
  }

  logger.info('shutdown requested', {
    reason,
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
      reason,
      graceMs: env.SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  /**
   * Stop accepting, finish what is in flight, exit.
   *
   * Separated from the readiness flip above because doing both in the same
   * tick makes the readiness signal unreadable: the listener is gone before
   * any poller can ask, so a fresh probe is refused rather than answered 503
   * and an idle keep-alive one is closed from under the poller. Measured
   * while closing the Phase 9 gate — the endpoint worked and was observable
   * only in-process, which is the kind of thing a unit test will happily
   * confirm forever.
   */
  const stopAccepting = (): void => {
    server.close((error) => {
      if (error) {
        logger.error('error while closing the server', { reason, error });
        process.exit(1);
      }
      logger.info('shutdown complete', { reason, exitCode });
      process.exit(exitCode);
    });

    // Idle keep-alive sockets only, and only now: during the readiness window
    // above they are deliberately left open, because a load balancer's probe
    // arrives on one of them. `closeAllConnections` would kill the in-flight
    // requests this function exists to protect.
    server.closeIdleConnections();
  };

  if (env.READINESS_DRAIN_MS > 0) {
    logger.info('advertising unreadiness before closing the listener', {
      reason,
      readinessDrainMs: env.READINESS_DRAIN_MS,
    });
    // `unref` deliberately NOT called: this timer must hold the event loop
    // open, or a process with nothing else pending would exit before it fires
    // and skip the drain it is waiting to perform.
    setTimeout(stopAccepting, env.READINESS_DRAIN_MS);
  } else {
    stopAccepting();
  }
}

/**
 * The net under every promise in the process.
 *
 * Measured, because the behaviour is the whole justification: with no handler
 * installed, Bun 1.3.13 kills the process on an unhandled rejection in the
 * same tick — a `setTimeout` scheduled 300ms out never fires, and nothing is
 * written in this application's log format. So the default outcome is every
 * in-flight query severed (up to LLM_TIMEOUT_MS of work each, for callers who
 * did nothing wrong), no correlation id, and the drain above skipped
 * entirely. A crash was the one exit path it did not cover.
 *
 * The adapter already guards the one instance of this that was known about:
 * `gemini.ts` keeps a handler on the promise its deadline race abandons,
 * because a provider rejecting after the deadline has won would otherwise
 * take the process down. That fix is one promise wide. This is the net behind
 * it, for the next one — in a dependency, or in a route nobody has written
 * yet.
 *
 * Two decisions worth stating, because both have a defensible opposite:
 *
 * 1. **Log and exit, never log and continue.** A process that has thrown past
 *    every `catch` is in a state nobody has reasoned about. Continuing to
 *    serve from it trades a loud restart for a quiet corruption, and only one
 *    of those is debuggable.
 *
 * 2. **Drain rather than exit immediately.** `process.exit(1)` here would
 *    discard exactly the in-flight requests the drain exists to protect, so a
 *    fault in one request would kill N others — the blast radius this handler
 *    is meant to shrink. Reusing `shutdown()` is safe *because* it is already
 *    bounded: the deadline above force-exits, so a wedged process cannot hang
 *    on the way out. The residual risk is a suspect process answering a few
 *    more in-flight requests, which `/ready` makes acceptable — it goes 503
 *    on the first line of the drain, so no *new* work is routed here.
 */
function fatal(
  kind: 'unhandledRejection' | 'uncaughtException',
  error: unknown,
): void {
  try {
    // Synchronous, and that is load-bearing: 40 stderr writes followed by an
    // immediate process.exit(1) were measured arriving intact through a pipe
    // under Bun 1.3.13, so the log line needs no flush dance to survive.
    logger.error(`fatal: ${kind}`, { kind, err: error });
  } catch (loggingFailure) {
    // The only place in this app where logging is wrapped. Everywhere else a
    // throwing logger is a bug worth surfacing; inside an uncaughtException
    // handler it is a second fault in the handler for the first, which is
    // unrecoverable and would discard the diagnostic entirely.
    console.error(`fatal: ${kind} (logger failed)`, error, loggingFailure);
  }

  shutdown(kind, 1);
}

process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
process.on('uncaughtException', (error) => fatal('uncaughtException', error));

// SIGTERM is what an orchestrator sends (Docker, ECS, Kubernetes); SIGINT is
// Ctrl-C in a terminal. Both should mean the same thing, and both are a
// clean exit: the process was asked to stop and did.
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
