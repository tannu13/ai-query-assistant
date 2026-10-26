/**
 * Where the process keeps its opinion about whether it should be serving.
 *
 * This is a module with one variable in it, which deserves a justification:
 * the flag it replaces lived in `src/index.ts`, and `index.ts` is the file
 * that calls `listen()`. A route that imported the flag from there would
 * import binding a port as a side effect — so the state has to live somewhere
 * both the signal handler and a request handler can reach without dragging
 * the entrypoint into the import graph.
 *
 * Deliberately not a general "health registry" with pluggable checks. There
 * is exactly one input today, and a registry built for the second one before
 * it exists is speculative structure. When the upstream circuit breaker
 * lands (plan §18 item 2) it contributes a second input, and that is the
 * moment to generalise — with two real cases to generalise from.
 */

export type LifecyclePhase =
  /** Accepting new work. */
  | 'running'
  /** Draining: in-flight requests are being finished, new ones are not wanted. */
  | 'draining';

let phase: LifecyclePhase = 'running';

export function currentPhase(): LifecyclePhase {
  return phase;
}

/**
 * True once a drain has begun, for any reason — a signal from the
 * orchestrator or a fatal fault. Readiness reads this.
 */
export function isDraining(): boolean {
  return phase === 'draining';
}

/**
 * Moves the process into draining, returning whether this call is the one
 * that did it.
 *
 * The boolean is the whole point: it collapses "have we already started
 * shutting down?" into the same operation that starts it, so a second
 * SIGTERM — or a fault arriving mid-drain — is a distinguishable event the
 * caller can respond to, rather than a flag someone has to remember to check
 * first.
 */
export function beginDraining(): boolean {
  if (phase === 'draining') return false;
  phase = 'draining';
  return true;
}

/**
 * Test-only. Module state outlives a single `it()`, and a test that drains
 * the process would otherwise leak `draining` into every test that ran after
 * it — in file order, which is not a dependency anyone should have.
 */
export function resetLifecycleForTest(): void {
  phase = 'running';
}
