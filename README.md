# AI Query Assistant

A small full-stack app: you type a question, a JWT-protected API sends it to Google's Gemini API, and the answer comes back rendered as text. Built as a take-home exercise for Husqvarna Group / GIS India.

```
┌──────────────────────┐                      ┌──────────────────────┐
│  apps/web            │  POST /api/query     │  apps/backend        │
│  Vite + React + TS   │ ───────────────────▶ │  Express 5 + Bun     │
│                      │  Authorization:      │                      │
│  • login form        │    Bearer <jwt>      │  • JWT verify        │
│  • prompt textarea   │                      │  • rate limit        │
│  • answer panel      │ ◀─────────────────── │  • LlmProvider seam  │
└──────────────────────┘  { answer, model,    └──────────┬───────────┘
                            finishReason,                │ GEMINI_API_KEY
   token in memory only     requestId, usage }           ▼
   — never localStorage                        Gemini (@google/genai)
```

**The flow:** sign in with the demo credentials → `POST /api/auth/login` returns a 15-minute HS256 JWT → the token is held in React state → the prompt goes to `POST /api/query` → the backend calls Gemini and returns a typed response → the answer renders with the model id that produced it. Every failure along the way has its own error code and its own message.

---

## Why there is a separate backend at all

**The provider credential never reaches the browser.** That is the whole architectural point, and it is the one decision everything else follows from.

A React app can call Gemini directly in about ten lines. Doing so puts `GEMINI_API_KEY` in the JavaScript bundle, where it is readable by anyone who opens devtools — and a bundled key is not "obscured", it is published. So the key lives only in the backend's environment, the browser gets a short-lived JWT instead, and the only thing the client can do with that JWT is ask this API to spend tokens on its behalf — under a rate limit, with a prompt-length cap, against one model.

`apps/web` therefore takes exactly one environment variable, `VITE_API_BASE_URL`, and it holds nothing secret. Everything in a Vite bundle is public; there is no safe place in it for a credential.

---

## Repository layout

```
apps/backend           Express 5 API on Bun — JWT auth, rate limiting, Gemini adapter
apps/web               Vite + React + TypeScript single-screen SPA
packages/shared        @repo/shared — zod schemas, inferred types, the ErrorCode union
packages/*-config      inherited ESLint / TypeScript configs

specs/implementation-plan.md   the plan this was built from, with measured outcomes per phase
DEPLOYMENT.md                  the AWS deployment plan the brief asks for
```

`packages/shared` is what makes the monorepo worth having. The request/response schemas live there once; the backend validates with them and the web app imports the inferred types, so changing a response field is a `check-types` failure rather than a runtime surprise. It is also the client's defence against a non-API response: a 200 whose body does not match the contract raises `MALFORMED_RESPONSE` instead of being read as `undefined` — which is what a load-balancer 502 or a wrong base URL actually looks like, since both arrive as HTML.

**Layering rule:** `route → middleware → service → provider adapter`. Routes parse and delegate. Adapters are the only files that know a vendor SDK exists. Everything throws typed errors and **exactly one** middleware turns an exception into a response, which is what makes "no upstream provider error ever reaches a client verbatim" a property of the architecture rather than something each handler has to remember.

---

## Prerequisites

- **[Bun](https://bun.com) 1.3.13+** — runs everything: the API, the tests, Vite, and the package manager.
- **A Google AI Studio API key** — free tier is enough: <https://aistudio.google.com/apikey>
- **Node.js ≥ 24** — *optional*, and needed only for `turbo run lint`. See [A note on Node](#a-note-on-node).
- **Docker** — optional, only to build the container.

## Setup

```sh
git clone <this-repo> ai-query-assistant
cd ai-query-assistant
bun install

cp apps/backend/.env.example apps/backend/.env
```

Then open `apps/backend/.env` and set **one** value:

```sh
GEMINI_API_KEY=<your Google AI Studio key>
```

Everything else has a working default, including a real bcrypt hash of the documented demo password, so the app runs after that single edit. For anything beyond a local demo, also replace `JWT_SECRET` with a real one:

```sh
openssl rand -base64 48
```

The web app needs no configuration — `apps/web/.env.example` exists only to document the default, which already points at `http://localhost:3000`.

> The environment is validated by zod at boot and the process **exits non-zero** on a problem, listing every offending variable by name. A misconfigured deployment fails immediately and loudly instead of at the first user request.

> **If every query comes back `LLM_UNAVAILABLE` (502) or `LLM_RATE_LIMITED` (429), change `GEMINI_MODEL` before looking anywhere else.** Model capacity is a provider-side condition and the free tier feels it: measured across three rounds on one afternoon, `gemini-flash-latest` failed every call while pinned ids answered. The default is `gemini-2.5-flash`; `gemini-3.5-flash` is the known-good fallback. That this is a config change rather than a code change is why the model is a variable.

### Run both apps

Two terminals:

```sh
# terminal 1 — API on http://localhost:3000
cd apps/backend && bun run dev

# terminal 2 — web app on http://localhost:3020
cd apps/web && bun run dev
```

Open <http://localhost:3020> and sign in with:

| | |
| --- | --- |
| Email | `demo@example.com` |
| Password | `demo-password` |

The login form prefills these, so the demo is one click.

The Vite port is **pinned** to 3020 with `strictPort`, because the API's CORS allowlist names exactly that origin. Without the pin, Vite silently moves to 3021 when 3020 is busy and every request then fails a CORS preflight — a confusing console error whose actual cause is a port number. Failing to start is the better outcome; widening `CORS_ORIGINS` to make the error go away would be the wrong fix.

### Changing the demo password

There is no database and no registration, so the one credential lives in configuration — as a **bcrypt hash**, never a plaintext password:

```sh
cd apps/backend
bun run scripts/hash-password.ts 'your-new-password'
# → DEMO_USER_PASSWORD_HASH_B64=JDJiJDEwJDFr…
```

Paste the line into `.env`. The value is **base64-encoded** on purpose: a bcrypt hash is `$2b$10$…`, and Bun's dotenv loader expands `$VAR` in `.env` under every quoting style, so a raw hash silently arrives truncated and every login fails with no clue why. Base64 is byte-identical through Bun's loader, through Docker's `--env-file`, and through an injected secret. The schema validates by decoding and matching the bcrypt shape, so pasting the plaintext password by mistake fails at boot with a message saying so.

> The hash shipped in `.env.example` is real and works — it is the hash of the documented password `demo-password`. That is safe precisely *because* the password is public: what it demonstrates is that configuration holds a hash and login does a bcrypt compare. The provider key and the signing secret, which are the things that actually matter, are placeholders.

---

## Calling the API directly

```sh
# 1. Get a token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password"}' \
  | jq -r .token)

# 2. Inspect what it carries (protected route)
curl -s http://localhost:3000/api/me -H "Authorization: Bearer $TOKEN" | jq
# → { "sub": "demo-user", "email": "demo@example.com", "exp": 1792993898, "expiresInSeconds": 900 }

# 3. Ask something
curl -s -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"In one sentence, what is a Dockerfile?"}' | jq
```

```json
{
  "answer": "A Dockerfile is a text file containing a series of step-by-step instructions used by Docker to automatically build a container image.",
  "model": "gemini-2.5-flash",
  "finishReason": "STOP",
  "truncated": false,
  "requestId": "fc25f4d7-fa5b-4abb-80ef-e0d7bc4e780d",
  "usage": { "promptTokens": 11, "responseTokens": 27 }
}
```

Without the header, the same call returns `401 AUTH_MISSING_TOKEN`.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | — | Liveness. Does **not** call the LLM provider |
| `POST` | `/api/auth/login` | — | Demo credentials → 15-minute HS256 JWT |
| `GET` | `/api/me` | Bearer | The verified claims behind the current token |
| `POST` | `/api/query` | Bearer | `{ prompt }` → an answer |

### Errors have one shape

Every error response, from every route, looks like this:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request is not valid.",
    "requestId": "094c3757-9f1a-499d-a977-dc569520d544",
    "details": [{ "path": "prompt", "message": "Enter a question before submitting" }]
  }
}
```

`code` comes from the shared `ErrorCode` union, so the client cannot receive a code it does not understand. `message` is always safe to display. `requestId` is also returned as `X-Request-Id` and stamped on every log line for that request, so a user-visible failure maps to a server-side explanation.

`details` carries field-level validation errors and nothing else, and it is **omitted entirely** rather than sent as `[]` when there are none — so every other error is a three-field object:

```json
{
  "error": {
    "code": "LLM_TIMEOUT",
    "message": "The model did not respond in time. Please try again.",
    "requestId": "fc25f4d7-fa5b-4abb-80ef-e0d7bc4e780d"
  }
}
```

| Failure | Code | HTTP |
| --- | --- | --- |
| Empty, oversized, or malformed body | `VALIDATION_FAILED` | 400 |
| Missing or malformed `Authorization` | `AUTH_MISSING_TOKEN` | 401 |
| Expired token | `AUTH_EXPIRED_TOKEN` | 401 |
| Bad signature, wrong algorithm, wrong `iss`/`aud` | `AUTH_INVALID_TOKEN` | 401 |
| Wrong demo credentials | `AUTH_INVALID_CREDENTIALS` | 401 |
| Too many requests (per JWT subject) | `RATE_LIMITED` | 429 |
| Provider too slow | `LLM_TIMEOUT` | 504 |
| Provider rate-limited us | `LLM_RATE_LIMITED` | 429 |
| Provider 5xx or transport failure | `LLM_UNAVAILABLE` | 502 |
| Prompt or answer blocked by safety filters | `LLM_CONTENT_BLOCKED` | 422 |
| 200 from the provider with no usable content | `LLM_NO_CONTENT` | 502 |
| Anything unhandled | `INTERNAL_ERROR` | 500 |

The distinctions are the point. A timeout, a blocked prompt and an expired token are three different situations for the user, and the UI shows three different messages with a retry button on only the ones where retrying can plausibly work — driven by `isRetryableErrorCode` in the shared package, so the *server* decides what is worth retrying. A button that never works teaches people to distrust the button.

### Exercising the error states without spending tokens

Set `LLM_PROVIDER=fake` in `.env` and restart. The fake provider answers deterministically and reaches every failure above from a prompt prefix:

| Prompt starts with | Produces |
| --- | --- |
| `!empty` | `LLM_NO_CONTENT` |
| `!blocked` | `LLM_CONTENT_BLOCKED` |
| `!timeout` | `LLM_TIMEOUT` |
| `!ratelimit` | `LLM_RATE_LIMITED` |
| `!unavailable` | `LLM_UNAVAILABLE` |
| `!truncated` | a successful but truncated answer |

`LLM_PROVIDER=fake` is **refused at boot when `APP_STAGE=prod`**: a production deployment silently serving canned answers is a worse outcome than one that will not start.

---

## Tests

```sh
bun run test            # everything, via turbo
bun run check-types     # tsc --noEmit across all workspaces
```

**105 tests across 7 files** — 94 backend, 11 web. The target is proof that the hard paths work, not a coverage number, so the suite is concentrated on the failures most likely to break in real use and least likely to be tested:

- `requireAuth` maps missing / expired / bad-signature / wrong-algorithm tokens to four **distinct** codes, and rejects an `alg: none` token.
- The Gemini adapter's **no-content** path surfaces as `LLM_NO_CONTENT` or `LLM_CONTENT_BLOCKED` and *never* as an empty-string success.
- The adapter's deadline fires as `LLM_TIMEOUT`, a caller's cancellation is distinguishable from it, and a late provider rejection does not become an unhandled rejection.
- No provider message ever reaches the client-facing text.
- `/api/query` rejects an oversized prompt **before** calling the provider — asserted by the provider never being invoked.
- An oversized body, which body-parser rejects before application code runs, still comes back as the envelope rather than Express's HTML error page.
- Model output is rendered as **text**: `<img src=x onerror=…>` returns through the real response path and ends up as visible text with no element created, plus a structural check that no `dangerouslySetInnerHTML` or `innerHTML =` exists anywhere in `apps/web/src`.

That last one passes today for free because React escapes by default — which is exactly why it is worth having. The regression is one `dangerouslySetInnerHTML` added by someone wanting to render markdown, and nothing else in the suite would notice. Model output is untrusted data; treating it as markup is a prompt-injection sink.

A real end-to-end provider call is a script rather than a test, so the suite never depends on a network or a quota:

```sh
cd apps/backend
bun run scripts/smoke-llm.ts "Why is the sky blue?"     # exits non-zero on failure
```

---

## Docker

The backend has a working multi-stage image. **Build from the repository root** — this is a Bun workspace, so a `--frozen-lockfile` install needs the root `bun.lock` and every workspace manifest, none of which is reachable with `apps/backend` as the context:

```sh
docker build -f apps/backend/Dockerfile -t ai-query-assistant-api .
docker run --rm -p 3000:3000 --env-file apps/backend/.env ai-query-assistant-api
```

- Two stages; dependencies installed with `--frozen-lockfile --production --filter backend`, so the API image carries none of the web app's React tree.
- **No build step** — Bun executes TypeScript directly, so `src` *is* the artifact.
- Runs as **non-root** (`uid=1000`), with application files left root-owned so the service cannot rewrite its own code.
- `HEALTHCHECK` against `/health` using busybox `wget`.
- **No secret in the image.** `.dockerignore` excludes `**/.env` and `**/.env.*` at every depth, and the Dockerfile copies named paths rather than `COPY . .`. Verified by exporting the image with `docker save`, decompressing every layer and searching for the live key, signing secret and password hash as raw bytes — 0 hits, against a positive control proving the scan was reading real content.
- **Graceful shutdown**: `SIGTERM` stops new connections, drains in-flight requests, and exits 0. Measured: `docker stop` 600 ms into a live Gemini call waited 3.8 s and the client still received its full answer. Before this, the container was `SIGKILL`ed after Docker's 10-second grace period and in-flight queries were severed — which, since a rolling deploy signals every task, made "deploy" and "drop live requests" the same event.

[`DEPLOYMENT.md`](DEPLOYMENT.md) covers running this on AWS: ECR with immutable SHA tags, ECS Fargate behind an ALB, S3 + CloudFront with `/api/*` routed to the ALB so there is one origin, and secrets injected as task `secrets` rather than plaintext `environment`.

---

## Decisions and trade-offs

**Gemini via `@google/genai`.** The current SDK, not the legacy `@google/generative-ai`. It is reached through an `LlmProvider` interface, so `services/llm/gemini.ts` is the only file in the codebase that knows a vendor SDK exists — which is what makes the `fake` provider possible, and what would make switching providers an adapter change rather than a route change.

**A real login endpoint, not a hardcoded token.** The brief explicitly permits a static token. A genuine sign → verify → expire cycle cost about twenty extra lines and makes the security story demonstrable instead of asserted. The JWT is HS256, algorithm-pinned on verify, with `issuer` and `audience` **asserted** rather than merely stamped — a claim that is never checked is decoration.

The pin deserves an honest footnote: the usual justification is preventing `alg: none` and asymmetric→symmetric confusion, and that justification is wrong for `jsonwebtoken` v9, which already rejects `alg: none` and cannot be confused with a symmetric secret. What the pin actually prevents is the library deriving its acceptable set from the *key type* — the whole HMAC family for a string secret — so the server would accept tokens it would never issue. Worth the line as defence against configuration drift, not as a fix for a live exploit. ([Measured in the plan's Phase 3 outcome](specs/implementation-plan.md).)

**Vite + React, not Next.js.** A separate backend is the thing being tested. Next.js route handlers would blur that boundary — the JWT requirement becomes easy to bypass server-side — and it is a heavy framework for a single-form UI.

**The browser talks cross-origin in development, deliberately.** A Vite dev proxy would make the browser see one origin, which would leave the backend's explicit CORS allowlist as untested decoration. Calling `:3000` from `:3020` exercises the real preflight. Production collapses to one origin anyway, via CloudFront routing `/api/*` to the ALB, which *narrows* CORS rather than relying on it.

**The token lives in memory, not `localStorage`.** A token in `localStorage` is readable by any script on the page, so a single XSS — in the app or in any dependency — exfiltrates it, and it outlives the tab to be stolen later. The cost is that a page refresh signs you out. The app says so in its own footer, so the trade-off is visible to whoever is demoing rather than looking like a bug.

**Rate limiting is keyed on the JWT subject, not the IP.** The limit should follow the account, not the network path: keyed by IP, a shared NAT puts an entire office in one bucket while an attacker with a handful of addresses gets a fresh budget per address. Login is the exception — it is keyed by IP, because there is no authenticated identity yet, and because bcrypt at cost 10 is ~100 ms of CPU by design, which makes an unthrottled login both a credential risk and a self-inflicted denial of service.

**Login spends a bcrypt compare even when the email is unknown.** Short-circuiting would make the endpoint a timing oracle for account existence — a wrong email answering in under a millisecond while a right one spends ~100 ms.

**Prompts are never logged, but their length is.** Prompt text is user content and potentially PII. Character counts, token usage, duration, model and finish reason are what actually help diagnose a problem. The logger also redacts known-sensitive keys as a backstop — though only for string values, after live traffic showed `/token/i` matching `promptTokens` and redacting the cost data the logging exists to provide.

**Rejected alternatives**, for the record: a hardcoded static token (allowed and faster, but gives up depth on an axis the brief names); Postgres-backed users (`DATABASE_URL` and `SALT_ROUNDS` were already in the env schema implying a user table — but a DB plus migrations plus a compose file is a large fraction of the budget for zero marks against any stated requirement); `Bun.serve` with HTML imports (no bundler, but unconventional for a reviewer); and SSE streaming (see below).

---

## Known limitations and next steps

Each of these is a conscious omission rather than an oversight, and would be the next thing built.

**No streaming.** The answer appears all at once after several seconds, where a token-by-token stream would feel far better. Two honest reasons it is not here: `EventSource` cannot send an `Authorization` header, so streaming means `fetch` + `ReadableStream` rather than the easy API; and an error arriving mid-stream occurs *after* response headers are sent, so it cannot use the error envelope above and needs a separate in-band error convention that the client has to learn. Non-streaming and correct beats streaming and half-working.

**Rate limiting is per-process.** The token bucket is in memory, so with *n* instances the effective limit is *n* × the configured bucket, and a restart resets it. Redis is the production answer; the current limiter is honest about being a single-process defence. `DEPLOYMENT.md` pairs it with WAF rate limiting at the edge, which solves a different half of the problem.

**No persistence.** No database, no conversation history, no multi-turn context — each query is independent. Adding history is the change that would most alter the architecture, since it introduces the first real data store and with it a per-user data model.

**One demo user.** No registration, no refresh tokens, no revocation, no password reset. A 15-minute token that cannot be revoked is acceptable *because* it is short-lived; with refresh tokens, revocation stops being optional.

**Memory-only token storage** means a refresh signs you out. Deliberate, as above — but worth a conscious yes/no rather than inheriting the decision.

**Client disconnects do not cancel the upstream call.** The `LlmProvider` seam accepts an `AbortSignal` and the adapter honours it — this is unit-tested — but under Bun's `node:http` compatibility layer there is no server-side signal that reliably fires on a POST disconnect. Measured: `req` emits `close` when the *body* is consumed, whether or not the client is still there, and on an actual disconnect `res` emits nothing at all. So the conventional `res.on('close')` wiring fires exactly when it is not needed and stays silent when it is; shipping it would have *looked* like working cancellation while doing nothing, which is worse than its absence because it would be believed. It arrives free by running on Node, or by serving with `Bun.serve`, whose `Request.signal` aborts on disconnect. The adapter's own `LLM_TIMEOUT_MS` deadline still bounds every call, so a hung provider cannot pin a request open.

**Observability is structured logs only.** No tracing, no metrics backend. `DEPLOYMENT.md` specifies the CloudWatch alarms that would be the first addition.

**`lint` cannot fail.** `eslint-plugin-only-warn`, inherited from the Turborepo starter this repo was scaffolded from, downgrades every rule to a warning, so `turbo run lint` exits 0 regardless of findings. Fine as a developer-experience default, useless as a CI gate — removing the plugin from `packages/eslint-config/base.js` is a one-line change, and `DEPLOYMENT.md` flags it as a prerequisite before the pipeline is trusted.

**Not deployed.** The brief asks for a written plan, and [`DEPLOYMENT.md`](DEPLOYMENT.md) is it. Nothing in this repository has been applied to a cloud account, and there is no IaC — an unapplied Terraform module would be no more verified than prose while looking considerably more authoritative.

---

## A note on Node

The root `package.json` declares `engines: node >= 24`, and this is **not** advisory — but it applies to exactly one task.

Bun runs the API, the tests, Vite and the package manager, so `dev`, `start`, `build`, `test` and `check-types` all work with no Node installed at all. The web app's scripts use `bun --bun vite` specifically to force that, after Vite 7 resolved through its own shebang to a system Node 18 and failed with `TypeError: crypto.hash is not a function`.

**`turbo run lint` is the exception.** ESLint 10 uses import attributes and will not parse under Node 18 (`SyntaxError: Unexpected token 'with'`), and running it under Bun fails differently inside `@babel/eslint-parser`'s worker setup. A `.nvmrc` pins the version, so:

```sh
nvm use && bun run lint
```

If `bun run lint` fails with a syntax error in ESLint's own files, this is why.

---

## Where the reasoning lives

[`specs/implementation-plan.md`](specs/implementation-plan.md) is the plan this was built from, in nine gated phases, each recording what was **measured** rather than assumed — including the places the plan was wrong and was corrected by running the code. If a decision here looks arbitrary, its justification is probably in there.
