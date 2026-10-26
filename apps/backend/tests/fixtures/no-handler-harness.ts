/**
 * The premise, as a fixture: an unhandled rejection with NO handler installed.
 *
 * This asserts a fact about Bun, not about this application, and it is
 * committed deliberately. The whole justification for the handlers in
 * `src/index.ts` is that the default is immediate death with no log line — so
 * if a future Bun changes that, this is the test that fails and sends someone
 * to re-read the comment, rather than the comment quietly becoming untrue.
 *
 * Deliberately does NOT import `src/index.ts`.
 */
setTimeout(() => {
  process.stdout.write('STILL_ALIVE\n');
  process.exit(0);
}, 300);

void Promise.reject(new Error('nobody caught me'));
