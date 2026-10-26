import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import env from './env';
import errorHandler from './middleware/errorHandler';
import notFound from './middleware/notFound';
import requestId from './middleware/requestId';
import authRouter from './routes/auth';
import healthRouter from './routes/health';
import meRouter from './routes/me';
import queryRouter from './routes/query';

/**
 * Transport-level body cap, derived from the domain-level prompt cap rather
 * than picked as a round number.
 *
 * The prompt cap counts characters; a JSON body counts bytes. A UTF-8
 * character is at most four bytes, so 4x the cap plus a little room for the
 * JSON envelope is the tightest limit that cannot reject a legal prompt. The
 * express.json default of 100kb would otherwise let a 25x-oversized body be
 * buffered in full before zod rejected it.
 */
const JSON_BODY_LIMIT_BYTES = env.LLM_MAX_PROMPT_CHARS * 4 + 1024;

const app = express();

/**
 * Middleware order is load-bearing:
 *
 * 1. `requestId` first, ahead of body parsing, so that a malformed body — the
 *    failure most likely to need diagnosing — still has a correlation id.
 * 2. `helmet` and `cors` before any route, so a rejected origin never reaches
 *    application code.
 * 3. `express.json` with an explicit limit.
 * 4. Routes.
 * 5. `notFound`, which turns an unmatched path into a typed error.
 * 6. `errorHandler` last, as the single translation point.
 */
app.use(requestId);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use(
  cors({
    // An explicit allowlist, never a wildcard: CORS forbids `*` alongside
    // credentials, and silently widening the origin to make a browser error
    // go away is how an API ends up callable from anywhere.
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  }),
);

/**
 * JSON only. `express.urlencoded` was removed: nothing in this API accepts a
 * form body, and a JSON endpoint that also accepts `application/x-www-form-
 * urlencoded` is reachable from a cross-origin HTML form without a preflight.
 */
app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

app.use(healthRouter);
app.use(authRouter);
app.use(meRouter);
app.use(queryRouter);

app.use(notFound);
app.use(errorHandler);

export default app;
export { app, JSON_BODY_LIMIT_BYTES };
