import type { Server } from 'node:http';

import type { Express } from 'express';

export interface TestServer {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  url: string;
  close(): Promise<void>;
}

/**
 * Starts an Express app on an OS-assigned port and returns its base URL.
 *
 * Port 0 is the point: the app is exported separately from `listen()` (so it
 * is testable at all), and binding an ephemeral port means the suite never
 * collides with a dev server on APP_PORT or with a parallel test file. Loopback
 * only, so nothing is exposed while the suite runs.
 *
 * Going through a real socket rather than calling handlers directly is
 * deliberate: the failures being tested here — `express.json` rejecting an
 * oversized body, Express's own HTML fallback for an unmatched route — live in
 * the HTTP layer and would be invisible to a handler-level test double.
 */
export async function startTestServer(app: Express): Promise<TestServer> {
  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an ephemeral TCP address');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
