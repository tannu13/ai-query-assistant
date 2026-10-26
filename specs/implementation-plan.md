# AI Query Assistant — Implementation Plan

**Assignment:** Husqvarna Group / GIS India — Take-Home Engineering Exercise, Senior Full Stack Engineer (Cloud & AI Applications)
**Status:** Phases 0–6 complete on branch `feat/ai-query-assistant` (Phase 4 gate 1 awaits a real `GEMINI_API_KEY` — see its outcome). **Backend and frontend both feature-complete.** Phase 7 next.
**Budget:** ~3–4 hours, per the brief.

---

## 1. What the brief asks for

Build an AI-powered query assistant: a web UI where a user types a query, the query goes to an LLM API via a JWT-protected backend, and the response is displayed clearly. Plus a working backend `Dockerfile`, a `README.md`, a `DEPLOYMENT.md` with an AWS/Azure container plan, and a `.env.example`.

The brief states explicitly that it is **not** looking for a production-ready system, and names five evaluation axes:

| Axis | What it actually rewards |
| --- | --- |
| Code quality | Structure, readability, TypeScript discipline |
| API design | Clean separation, error resilience, sensible patterns |
| Security awareness | Secrets handling, auth implementation, safe API exposure |
| AI integration | How thoughtfully the LLM is wired in and its responses handled |
| Engineering communication | How clearly choices are explained in the docs |

Three of the five are about judgment and explanation rather than feature count. There is also a 60–75 minute debrief interview where the work is walked through collaboratively. **Both facts push effort toward defensible decisions and clear writing, not toward feature volume.** Where this plan declines to build something, it says so in the README as a deliberate trade-off rather than leaving it as a silent gap.

### Requirement traceability

| # | Requirement | Addressed by |
| --- | --- | --- |
| R1 | Clean UI, type a query, submit | §6 `apps/web` |
| R2 | Send query to an LLM API | §8 Gemini adapter |
| R3 | Display the response clearly | §6 response panel |
| R4 | JWT-based auth protecting the endpoint | §7 `requireAuth` + `/api/auth/login` |
| R5 | Meaningful error handling | §9 error matrix |
| R6 | Working backend Dockerfile | §11 |
| R7 | API key in `.env`, never hardcoded | §10 env schema |
| R8 | `README.md` — setup, assumptions, decisions | §13 |
| R9 | `DEPLOYMENT.md` — AWS/Azure via containers | §12 |
| R10 | `.env.example`, no real keys committed | §10, already present |

---

## 2. Locked decisions

Confirmed with the project owner before planning.

| Decision | Choice | Rationale |
| --- | --- | --- |
| LLM provider | **`@google/genai`** (Gemini) | Owner has a working key. Current SDK, not the legacy `@google/generative-ai`. |
| Frontend | **Vite + React + TypeScript** | Leanest path; keeps the backend as an explicit API boundary, so the JWT requirement is exercised for real rather than bypassed by server-side route handlers. |
| Auth | **`POST /api/auth/login` issuing a short-lived JWT** | The brief permits a hardcoded token, but a real sign → verify → expire cycle costs ~20 extra lines and gives materially more to discuss on the security axis. No database. |
| Scope | **Match the stated 3–4h** | Includes a small test suite. Streaming is documented as a next step rather than half-built. |

### Rejected alternatives (worth being able to defend in the debrief)

- **Next.js frontend** — matches the deleted `apps/docs` boilerplate and the existing `@repo/eslint-config/next-js`, but route handlers blur the separate-backend boundary the exercise is testing, and it is heavier for a single-form UI.
- **Bun `Bun.serve` + HTML imports** — what the stock `apps/backend/CLAUDE.md` prescribes. No extra bundler, but unconventional for a reviewer and a weaker signal of mainstream-ecosystem familiarity.
- **Hardcoded static token only** — explicitly allowed, and faster, but gives up depth on an axis that is named in the grading criteria.
- **Postgres-backed users** — `DATABASE_URL`, `bcrypt`, and `SALT_ROUNDS` are already in the env schema, implying a user table. Rejected: a DB plus migrations plus a compose file is a large fraction of the total budget for zero marks against any stated requirement.
- **SSE streaming** — see §14.

---

## 3. Current repository assessment

Monorepo: Turborepo, Bun 1.3.13 as package manager, one app (`apps/backend`) and two config packages. The Next.js `apps/docs` boilerplate has been deleted but not committed.

### Keep as-is — these already read as deliberate

- **`src/env.ts`** — zod-validated environment with fail-fast at boot and a `JWT_SECRET` minimum-length check. This is already a stronger secrets-handling signal than most submissions and needs only to be retargeted, not rewritten.
- **`src/server.ts`** — `helmet`, plus an explicit CORS allowlist carrying a comment on why no wildcard alongside credentials. The comment stays; it is the kind of thing a reviewer reads as intent.
- **The `index.ts` / `server.ts` split** — the app is exported separately from `listen()`, so it is testable without binding a port. The test plan in §15 depends on this.

### Must change

| # | Issue | Action |
| --- | --- | --- |
| C1 | `DATABASE_URL` is required by the env schema but no DB exists — a hard boot failure for anyone cloning the repo | Remove `DATABASE_URL`; add Gemini vars (§10) |
| C2 | `/health` advertises a DB check in commented-out code | Replace with a real, honest health response |
| C3 | No `build` or `start` script in `apps/backend` | Add; the Dockerfile depends on `start` |
| C4 | No `lint` / `check-types` scripts in `apps/backend`, so `turbo run lint` and `turbo run check-types` are silent no-ops repo-wide | Add both, so the Turborepo pipeline covers real work |
| C5 | `apps/backend/CLAUDE.md` is the stock Bun template and contradicts the actual repo — it says "Don't use `express`" next to an Express app, and "Don't use `vite`" against decision §2 | Delete. A reviewer browsing the repo reads it as the project's stated conventions. |
| C6 | Root `README.md` is still verbatim Turborepo starter text, describing `docs`, `web`, and `@repo/ui` apps that do not exist | Rewrite (§13). This is the single most visible unforced error in the repo. |
| C7 | Monorepo currently shares nothing between workspaces, making "why Turborepo?" an awkward question | Add `packages/shared` (§5) |
| C8 | `CORS_ORIGINS` defaults to `http://localhost:3020`; Vite defaults to `5173` | Pin Vite's dev server to 3020 rather than widening CORS |
| C9 | Root `engines` requires Node >=24; local Node is v18 | Bun runs everything, so this is advisory — but note it in the README so an npm user is not ambushed |

### Pre-flight safety check

`apps/backend/.env` exists and holds a real secret. It currently sits inside a wholly untracked directory (`?? apps/backend/`), so git status does not flag it as a distinct risk. Both the root and backend `.gitignore` should cover it, but this must be **verified before the first `git add`**:

```sh
git check-ignore -v apps/backend/.env
```

Committing a live Gemini key would directly undercut the security-awareness axis this exercise grades.

---

## 4. Target architecture

```
specs/
  implementation-plan.md          this document

packages/shared/                  @repo/shared — the contract
  src/
    schemas.ts                    zod request/response schemas
    errors.ts                     ErrorCode union, shared error envelope type
    index.ts
  package.json
  tsconfig.json

apps/backend/
  src/
    index.ts                      bootstrap only: listen()
    server.ts                     app assembly, middleware ordering
    env.ts                        zod env validation (retargeted)
    routes/
      health.ts
      auth.ts                     POST /api/auth/login
      me.ts                       GET  /api/me (protected; Phase 3 gate)
      query.ts                    POST /api/query
    middleware/
      requestId.ts                correlation id per request
      requireAuth.ts              JWT verification, algorithm-pinned
      rateLimit.ts                in-memory token bucket
      errorHandler.ts             the single translation point
    services/
      llm/
        provider.ts               LlmProvider interface + domain types
        gemini.ts                 @google/genai adapter
        fake.ts                   deterministic test double
        index.ts                  provider selection from env
    lib/
      errors.ts                   AppError hierarchy
      logger.ts                   structured logging, redaction
  scripts/
    hash-password.ts              generates DEMO_USER_PASSWORD_HASH for .env
    smoke-llm.ts                  one real provider call, no HTTP (Phase 4 gate)
  tests/
    errorHandler.test.ts
    requireAuth.test.ts
    gemini.adapter.test.ts
    query.route.test.ts
  Dockerfile
  .dockerignore
  .env.example                    (update)
  package.json                    (update: scripts, deps)

apps/web/                         Vite + React + TS
  src/
    main.tsx
    App.tsx
    components/
      LoginForm.tsx
      QueryForm.tsx
      ResponsePanel.tsx
      ErrorNotice.tsx
    lib/
      api.ts                      typed fetch client, AbortController
      useAuth.ts                  in-memory token state
    styles.css
  index.html
  vite.config.ts                  port 3020, /api proxy to backend
  package.json
  tsconfig.json

README.md                         (rewrite)
DEPLOYMENT.md                     (new)
```

### Layering rule

`route → middleware → service → provider adapter`. Routes parse and delegate; they contain no provider knowledge and no `try/catch`. Services hold domain logic. Adapters are the only code that knows a vendor SDK exists. Everything throws typed errors; exactly one middleware translates them to HTTP.

---

## 5. `packages/shared` — the contract

A small workspace package exporting the zod schemas, the inferred TypeScript types, and the `ErrorCode` union. The backend validates incoming requests with these schemas; the frontend imports the inferred types for its API client.

Two reasons this earns its place (141 lines as built, roughly half of it comments — the "~40 lines" first estimated here was wrong):

1. **Contract drift becomes a compile error.** Change a response field and the frontend fails `check-types` instead of failing at runtime.
2. **It justifies the monorepo.** Without it, a single-app Turborepo invites "why?"; with it, the answer is a shared, type-checked contract — turning the repo's weakest structural question into a deliberate choice.

---

## 6. Frontend

Single-screen SPA, three states: unauthenticated (login), ready (query form), responding.

- **`LoginForm`** — demo credentials, submits to `/api/auth/login`, holds the returned JWT in React state only. **Deliberately not `localStorage`:** memory-only storage is immune to XSS token theft, and the trade-off (a refresh loses the session) is correct for a demo and is documented in the README. This is a better answer than the reflexive `localStorage` most submissions use.
- **`QueryForm`** — textarea, client-side length cap mirroring the server's, submit disabled while in flight, Cmd/Ctrl+Enter to submit.
- **`ResponsePanel`** — renders the answer and shows which model produced it. Output is rendered as **text, never `innerHTML`**. Model output is untrusted data; treating it as markup is a prompt-injection sink. Stated explicitly in the README.
- **`ErrorNotice`** — reads the `code` from the error envelope and renders a cause-specific message, with a retry affordance only for retryable codes. A timeout, a blocked prompt, and an expired token are three different messages, not one generic "something went wrong".
- **`lib/api.ts`** — typed fetch wrapper over `@repo/shared`. Holds an `AbortController` per request, aborting on resubmit and on unmount. A 401 clears the in-memory token and returns the user to login.

Visual scope is intentionally modest: plain CSS, clear typography and spacing, visible focus states, accessible labels and an `aria-live` region for the response. The brief asks for a "clean UI", not a design system.

---

## 7. Auth design

**`POST /api/auth/login`** — accepts demo credentials, compares the password against a bcrypt hash held in `DEMO_USER_PASSWORD_HASH`. No database; `scripts/hash-password.ts` generates the hash for `.env`, which keeps `bcrypt` and `SALT_ROUNDS` honestly justified rather than vestigial. On success, signs an HS256 JWT.

**`requireAuth`** middleware on `/api/query`, with these specifics:

- **Algorithm pinned** via `algorithms: ['HS256']`. ⚠️ **The original rationale here was wrong — corrected by measurement in the Phase 3 outcome.** `jsonwebtoken` v9 already rejects `alg: none` with or without the pin, and the dangerous asymmetric→symmetric confusion is unreachable with a symmetric secret. What the pin actually prevents is the library deriving its acceptable set from the *key type* — the whole HMAC family for a string secret — so the server accepts tokens it would never issue. Worth the line as defence against configuration drift, not as a fix for a live exploit.
- **`issuer` and `audience` asserted** on verify, not merely set on sign. Signing claims that are never checked is decoration.
- **Short expiry** (15m default, env-configurable).
- **Distinct error codes** for missing, malformed, expired, and invalid-signature tokens — so the frontend can respond differently and the logs are diagnosable.
- **Minimum 32-character `JWT_SECRET`**, already enforced by the existing env schema.

---

## 8. LLM integration (`@google/genai`)

### Verified SDK facts

Checked against the npm registry and the published README for v2.31.0, rather than assumed:

- Latest is **2.31.0**; `engines: node >=20`. The legacy `@google/generative-ai` (0.24.1) is a different, older SDK.
- Surface: `new GoogleGenAI({ apiKey })` → `ai.models.generateContent({ model, contents })` → `response.text`. `generateContentStream` exists for streaming.
- The README's own current example model is **`gemini-flash-latest`** — not `gemini-2.5-flash`. This will be the default, set via `GEMINI_MODEL` so it is swappable without a code change.
- The SDK depends on **`p-retry`**, so it may already retry internally.

### The `LlmProvider` seam

```ts
interface LlmProvider {
  readonly name: string;
  complete(input: { prompt: string; signal?: AbortSignal }): Promise<LlmCompletion>;
}
```

The brief says "an LLM API of your choice", which invites "how would you swap it?" in the debrief. The interface is the answer. It also yields `fake.ts`, which makes the whole query path testable with no network and no token spend — including the failure paths, which are otherwise almost impossible to exercise on demand.

### Gemini's silent-failure mode — the most interesting part of this integration

`generateContent` can return **HTTP 200 with no usable text**:

- `response.promptFeedback.blockReason` — the *input* tripped a safety filter.
- `candidates[0].finishReason` — values such as safety, recitation, or token-limit truncation.

In these cases `response.text` is `undefined`. The naive implementation returns it straight to the UI, which renders `undefined` with no error raised anywhere. The adapter will therefore:

1. Treat a missing/empty `text` as a first-class failure, never as an empty success.
2. Map an input-side block to `LLM_CONTENT_BLOCKED` (422) and distinguish it from token-limit truncation, which returns partial text and should be surfaced *with* a truncation warning rather than discarded.
3. Never pass a raw provider error message to the client (§9).

This is a concrete, provider-specific demonstration of "thoughtfully handling LLM responses" — a named grading axis — and it is the single clearest differentiator available in this exercise.

### Timeout and retry

The timeout lives **in the adapter**, not the route, so the `LlmProvider` interface stays provider-agnostic. Preference order: the SDK's own `httpOptions` timeout / abort-signal support if present; otherwise an `AbortSignal.timeout()` wrapper at the adapter boundary. Default 20s, env-configurable.

On retry: because the SDK already bundles `p-retry`, **its built-in behaviour will be checked before any retry layer is added.** Stacking a hand-rolled backoff on top of an SDK that already retries silently multiplies worst-case latency, and it is a bug that looks like diligence.

⚠️ **Checked in Phase 4, and the concern was backwards.** Retry is *off* unless `httpOptions.retryOptions` is passed — the client returns early when it is absent — so the risk was never double-retrying but not retrying at all while assuming the SDK had it covered. See the Phase 4 outcome for the configuration chosen and why 429 is excluded from it.

---

## 9. Error handling

### Envelope

Every error response, from every route, has one shape:

```json
{
  "error": {
    "code": "LLM_TIMEOUT",
    "message": "The model did not respond in time. Please try again.",
    "requestId": "01JD...",
    "details": []
  }
}
```

`code` is a stable machine-readable value from the shared `ErrorCode` union; `message` is safe to display; `details` carries field-level validation errors only. `requestId` ties a user-visible failure to a log line.

### Matrix

| Failure | Mechanism | Code | HTTP |
| --- | --- | --- | --- |
| Malformed or oversized body | zod + `express.json({ limit })` + prompt length cap | `VALIDATION_FAILED` | 400 |
| No / malformed Authorization header | `requireAuth` | `AUTH_MISSING_TOKEN` | 401 |
| Expired JWT | `requireAuth` | `AUTH_EXPIRED_TOKEN` | 401 |
| Bad signature, wrong alg, bad iss/aud | `requireAuth`, algorithm-pinned | `AUTH_INVALID_TOKEN` | 401 |
| Wrong demo credentials | `/api/auth/login` | `AUTH_INVALID_CREDENTIALS` | 401 |
| Too many requests | in-memory token bucket, per JWT subject | `RATE_LIMITED` | 429 |
| LLM slow | `AbortSignal.timeout()` in adapter | `LLM_TIMEOUT` | 504 |
| LLM 429 | adapter error mapping, `Retry-After` honoured | `LLM_RATE_LIMITED` | 429 |
| LLM 5xx / transport failure | adapter error mapping | `LLM_UNAVAILABLE` | 502 |
| **200 with no content (input blocked)** | adapter response inspection | `LLM_CONTENT_BLOCKED` | 422 |
| **200 with no content (output policy stop)** | adapter response inspection — refined in Phase 4 | `LLM_CONTENT_BLOCKED` | 422 |
| **200 with no content (other)** | adapter response inspection | `LLM_NO_CONTENT` | 502 |
| Anything unhandled | `errorHandler` | `INTERNAL_ERROR` | 500 |

### The rule that matters

**Upstream provider errors never reach the client verbatim.** They are logged in full against the request id and mapped to a generic code. Provider error strings can carry internal endpoints, quota details, project identifiers, and — in the worst case — fragments of the credential used. One translation point means this cannot be forgotten in a single handler.

Correspondingly, `errorHandler` is the only place that converts an exception to a response. Handlers throw; they do not catch.

---

## 10. Environment variables

### Backend

| Variable | Purpose | Notes |
| --- | --- | --- |
| `APP_PORT` | HTTP port | default 3000 |
| `NODE_ENV` | runtime mode | existing |
| `APP_STAGE` | dev / prod | existing |
| `JWT_SECRET` | HS256 signing key | min 32 chars, already enforced |
| `JWT_ISSUER` / `JWT_AUDIENCE` | asserted on verify | new |
| `JWT_EXPIRES_IN` | token lifetime | default `15m` |
| `SALT_ROUNDS` | bcrypt cost | retained, used by the hash script |
| `DEMO_USER_EMAIL` | demo login identity | new — **added in Phase 3**, with the hash script |
| `DEMO_USER_PASSWORD_HASH_B64` | bcrypt hash, **base64-encoded**, never a plaintext password | new — added in Phase 3. Base64 because Bun's dotenv loader expands the `$` in `$2b$10$…`; see the Phase 3 outcome |
| `GEMINI_API_KEY` | provider credential | **new, required** |
| `GEMINI_MODEL` | model id | default `gemini-flash-latest` |
| `LLM_TIMEOUT_MS` | adapter timeout | default 20000 |
| `LLM_MAX_PROMPT_CHARS` | input cap | default 4000 |
| `CORS_ORIGINS` | browser allowlist | existing, keep the comment |
| ~~`DATABASE_URL`~~ | — | **removed** (C1) |

The env schema validates at boot and the process exits on failure, so a misconfigured deployment fails immediately and loudly rather than at the first user request. `.env.example` is updated in lockstep with placeholders only. No secret is ever logged; `lib/logger.ts` redacts known-sensitive keys, and prompt text is truncated in logs (it is user content, potentially PII).

### Frontend

Only `VITE_API_BASE_URL`. **No key, no model id, nothing secret** — anything in a Vite bundle is public. The entire reason the backend exists is to keep the provider credential off the client, and the README will say so in one line, since it is the central security decision of the architecture.

---

## 11. Containerisation

Multi-stage build on `oven/bun:1.3.13-alpine`.

**The non-obvious constraint:** this is a Bun workspace, so a `--frozen-lockfile` install needs the root `package.json`, the root `bun.lock`, *and* `apps/backend/package.json`. The **build context must therefore be the repository root**, not `apps/backend` — a Dockerfile that assumes its own directory as context cannot resolve the workspace lockfile. The documented build command will make the context explicit.

- Builder stage installs with the frozen lockfile; runtime stage carries production dependencies only.
- **No build step.** Bun runs TypeScript directly, so the runtime stage runs `bun src/index.ts` (the `start` script). See the Phase 1 outcome for why a bundling `build` script was tried and removed.
- Runs as a **non-root user**.
- `HEALTHCHECK` against `/health`.
- `.dockerignore` excludes `node_modules`, `.git`, `.turbo`, `specs`, and **`.env`** — keeping the secret out of the image layers is the main point of the file.
- Verified by actually building and running the image, not by inspection. The brief says "a working Dockerfile", and "working" is checkable.

---

## 12. `DEPLOYMENT.md` outline

Target **AWS**, opinionated rather than a feature tour.

- **Images:** ECR, immutable tags by commit SHA.
- **Backend:** ECS Fargate behind an ALB. Fargate over EC2 for zero node management at this scale.
- **Frontend:** static build to S3, served by CloudFront, with `/api/*` routed to the ALB so the browser sees one origin and CORS narrows to a single entry.
- **Secrets:** `GEMINI_API_KEY` and `JWT_SECRET` in **AWS Secrets Manager, injected as ECS task `secrets`** — not as plaintext `environment` entries in the task definition, which are readable by anyone with `ecs:DescribeTaskDefinition`. This distinction is the single most important line in the document.
- **Observability:** CloudWatch Logs with the request id as the correlation key; alarms on 5xx rate and p99 latency.
- **Scaling:** target-tracking on ALB request count per target. Note that LLM latency makes request-count a better signal than CPU here, since the container is I/O-bound and will scale late on CPU.
- **CI/CD:** GitHub Actions authenticating via **OIDC role assumption**, so no long-lived AWS access keys exist anywhere.
- **Edge:** WAF rate-limiting in front of CloudFront, complementing the in-process limiter.
- **Alternatives considered, with reasons for rejection:** Lambda (cold starts, response-streaming caveats), App Runner (simpler, less control), Azure Container Apps + Key Vault + Static Web Apps as the equivalent stack.
- **Provider auth note:** `@google/genai` supports both AI Studio API keys and Vertex AI. Vertex needs GCP service-account credentials, which is awkward to federate from AWS — so an API key in Secrets Manager is the right call for this app. Stating this shows the provider auth model was considered rather than defaulted.

The "alternatives considered" section is what makes the document read as reasoning rather than a recipe, which is the engineering-communication axis.

---

## 13. `README.md`

Full rewrite of the Turborepo starter text (C6). Sections:

1. What it is, and a screenshot or short description of the flow.
2. Architecture at a glance — why a separate backend exists (the credential never reaches the browser).
3. Prerequisites, setup, `.env` configuration, how to generate the demo password hash, how to run both apps.
4. How to get a token and call the API with `curl`.
5. **Decisions and trade-offs** — the §2 table plus the rejected alternatives, in prose.
6. **Known limitations and next steps** — explicitly: streaming, Redis-backed rate limiting, no persistence, memory-only token, single demo user.
7. Test instructions.
8. The Node-18-vs-`engines` note (C9).

Section 6 matters: naming a limitation deliberately reads as judgment, whereas the same gap unmentioned reads as an oversight. Same code, different grade.

---

## 14. Explicitly out of scope

Each of these is a conscious omission, documented in the README rather than silently absent.

- **SSE streaming.** The honest reasons it is not in a 3–4h build: `EventSource` cannot send an `Authorization` header, so streaming requires `fetch` + `ReadableStream`; and errors arriving mid-stream occur *after* response headers are sent, so they cannot use the §9 envelope and need a separate in-band error convention. Non-streaming and correct beats streaming and half-working — and the reasoning above is itself a good debrief answer.
- **Persistence** — no DB, no conversation history, no multi-turn context.
- **Real user management** — one demo credential, no registration, no refresh tokens, no revocation.
- **Distributed rate limiting** — the in-memory bucket resets per process and does not coordinate across tasks; Redis is named as the production answer.
- **Observability stack** — structured logs only; no tracing, no metrics backend.
- **Actual deployment** — the brief asks for a written plan.

---

## 15. Testing

`bun test`, roughly six focused cases. The target is proof that the hard paths work, not coverage percentage.

**Tests are written inside the phase that makes them meaningful (§16), not as a block at the end.** A phase whose tests land three phases later is not independently confirmable, which defeats the point of phasing. The per-phase time estimates include writing them.

| Test | Asserts | Written in |
| --- | --- | --- |
| `errorHandler` — unhandled throw | §9 envelope shape, `INTERNAL_ERROR`, request id present | Phase 2 |
| `requireAuth` — valid token | request proceeds, subject attached | Phase 3 |
| `requireAuth` — missing / expired / bad-signature / wrong-algorithm | each maps to its own distinct code; the alg-confusion token is rejected | Phase 3 |
| `gemini` adapter — fake provider timeout | surfaces as `LLM_TIMEOUT`, not a generic failure | Phase 4 |
| `gemini` adapter — fake provider returns no content | surfaces as `LLM_NO_CONTENT` / `LLM_CONTENT_BLOCKED`, never an empty-string success | Phase 4 |
| `/api/query` — invalid body | 400 with field-level details | Phase 5 |
| `/api/query` — fake provider success | 200, response matches the shared schema | Phase 5 |

The `fake.ts` provider is what makes the adapter failure tests possible at all; they are the cases most likely to break in real use and least likely to be tested. All tests import the exported `app` without binding a port (§3).

---

## 16. Phased implementation

Nine phases. Each one ends at a **gate**: a concrete, runnable check with an expected observable result. No phase begins until the previous gate passes. Every phase also states what is *deliberately* still broken at that point, so a gate is never failed by testing something that was never in scope yet.

Commands assume the repository root as the working directory unless stated. They are written shell-agnostically — where a gate says "exits non-zero", check your shell's status variable (`$status` in fish, `$?` in bash).

---

### Phase 0 — Secret safety and a clean baseline · ~10m

**Goal:** make the irreversible mistake impossible before any code is written.

**Deliverables:** boilerplate deletions committed; confirmation that `apps/backend/.env` is ignored; `specs/` committed; **lockfile regenerated** (see finding below).

**Gate:**

```sh
# 1. The live Gemini key cannot be committed. Must print a matching .gitignore rule.
git check-ignore -v apps/backend/.env

# 2. Nothing secret is staged. Must NOT list apps/backend/.env
git add -A && git status --short

# 3. No key-shaped string anywhere in tracked content.
git grep -I -nE "AIza[0-9A-Za-z_-]{10,}" -- . ; echo "exit above should be 1 (no matches)"
```

✅ Pass when check 1 prints a rule, check 2 omits `.env`, and check 3 finds nothing.

**Deliberately not working yet:** everything else.

**Why this is a phase and not a footnote:** it is the only step in the plan that cannot be undone by editing a file. A committed key is a rotated key and a rewritten history, and it lands directly on the axis this exercise grades.

#### ✅ Outcome — complete

Landed as the baseline commit on branch `feat/ai-query-assistant`, which was branched from `main` — `main` still sits at the create-turbo initial commit, so fast-forward or merge whenever you like. Phase outcomes in this document reference branches and phases rather than commit SHAs, since a squash or rebase invalidates a pinned SHA and the document travels in the same commit it would be pinning.

All three gates passed, and gate 3 was strengthened during execution: beyond the generic `AIza`/`sk-`/PEM pattern scan, every sensitive-looking value in the real `.env` (`JWT_SECRET`, `DATABASE_URL`) was grepped against the git index by exact value, confirming neither reached staged content. The check reports key names and match/no-match only, never the values — so it is safe to re-run and to paste into a PR.

**Unplanned finding — stale lockfile.** The boilerplate `apps/docs`, `apps/web`, *and* `packages/ui` were all deleted from the worktree but never committed, and `bun.lock` still carried workspace entries plus a `@repo/ui` resolution for all three. This would have failed `bun install --frozen-lockfile` inside the Phase 7 Dockerfile, where the error would have looked like a Docker-context problem rather than a lockfile problem. Regenerated the lockfile (`bun install` pruned 2 packages); it now resolves exactly `apps/backend`, `packages/eslint-config`, `packages/typescript-config`.

`bun install --frozen-lockfile` was then run explicitly and passes — **Phase 7's lockfile constraint (§11) is pre-validated**, ahead of the phase that depends on it.

**Note for Phase 6:** the deleted boilerplate `apps/web` occupied the same path the new Vite app will use (§4). Git history will therefore show that path deleted here and recreated in Phase 6. Intentional, not a mistake.

---

### Phase 1 — Workspace foundation and the env contract · ~20m

**Goal:** the repo installs, type-checks as one unit, and fails loudly on bad configuration.

**Deliverables:** `src/env.ts` retargeted (remove `DATABASE_URL`, add the Gemini and JWT vars per §10) · `.env.example` updated · `packages/shared` created with schemas, `ErrorCode`, and types (§5) · `build` / `start` / `lint` / `check-types` scripts added to `apps/backend` (C3, C4) · stale `apps/backend/CLAUDE.md` deleted (C5) · honest `/health` (C2).

**Gate:**

```sh
bun install

# 1. Type-checking actually covers the workspaces — output must name BOTH
#    `backend` and `@repo/shared`, not report "no tasks to run".
bun run check-types

# 2. Backend boots and /health is truthful.
cd apps/backend && bun run dev
curl -i http://localhost:3000/health          # → 200, no DB claim in the body

# 3. Fail-fast works: remove GEMINI_API_KEY from .env, then
cd apps/backend && bun run dev
# → process exits NON-ZERO with a readable message naming GEMINI_API_KEY.
#   Restore the key afterwards.
```

✅ Pass when check 1 lists both workspaces, `/health` returns 200 without referencing a database, and check 3 exits non-zero with a legible error.

**Deliberately not working yet:** no auth, no LLM, no frontend. `/health` is the only route.

**Note:** check 1 is the real content of this gate. Before this phase `turbo run check-types` is a silent no-op across the whole repo (C4) — a pipeline that appears to enforce types and does not. "No tasks to run" is a failed gate, not a pass.

#### ✅ Outcome — complete

All five gates pass: `bun install --frozen-lockfile` clean, `check-types` and `lint` each running **2 tasks across `backend` and `@repo/shared`**, `/health` returning `{"status":"ok","uptimeSeconds":1,"stage":"dev"}` with no database claim, and a missing `GEMINI_API_KEY` exiting 1 with a message naming the variable and pointing at `.env.example`.

`src/env.ts` imports `PROMPT_MAX_CHARS` from `@repo/shared` for its `LLM_MAX_PROMPT_CHARS` default, so the shared contract is load-bearing from the first phase — if the workspace wiring broke, `check-types` would fail rather than the problem surfacing in Phase 6.

**Finding — `lint` was a no-op inside a no-op.** C4 identified the missing scripts. Adding them exposed a second, quieter problem: ESLint's default file set is `js/mjs/cjs`, and the inherited `@repo/eslint-config/base` never names `**/*.ts`. A TypeScript package therefore lints "clean" because its source is never read. `files: ["**/*.{js,mjs,cjs,ts,tsx}"]` fixes it. Verified by linting a temporary `.ts` file containing a duplicate key and a `debugger` statement and confirming both were reported — "clean" is indistinguishable from "not looking", so the probe is the only honest check.

**Finding — Babel presets resolved from the wrong package.** The base config passed `presets: ["@babel/preset-typescript"]` as a bare string, which Babel resolves relative to the *linted* file. Any consumer that does not itself depend on Babel fails with `Cannot find package '@babel/preset-typescript'`. Fixed with `createRequire(import.meta.url)` so the preset resolves from `packages/eslint-config`, where it is actually a dependency — no duplicated Babel deps in consumers.

**Finding — C9 is real, not advisory.** ESLint 10 uses import attributes and will not parse on the system Node (v18.19.1): `SyntaxError: Unexpected token 'with'`. Running it under Bun instead fails differently, in `@babel/eslint-parser`'s worker setup. nvm already has v24.15.0 installed, matching the root `engines: node >=24`, so the fix is to use it; added `.nvmrc` to make that constraint actionable rather than merely declared. **`lint` requires Node ≥ 24; `check-types`, `dev` and `start` run fine under Bun alone.**

**Decision — no type-aware linting.** `typescript-eslint` would normally replace the core rules that need type information, but no release supports TypeScript 7 (every version's peer range caps at `<6.1.0`, and the repo pins 7.0.2). So `no-undef` and `no-unused-vars` are disabled for `.ts`: without type information, every `import type` reads as an unused variable, which is precisely what the three initial false positives were. Consequence worth stating plainly: **TypeScript linting here is syntax and core-JS rules only**, with `tsc --noEmit` and `strict` carrying the real weight.

**Decision — the backend has no `build` script.** A bundling build was written and then removed. `bun build --target bun --outdir dist --external '*'` treats `'*'` as *every* specifier including relative ones, so the emitted `dist/index.js` still imported `./env` and `./server` and died with `Cannot find module './env'`. Narrowing the externals would mean enumerating third-party packages by hand to keep `bcrypt`'s native addon out of the bundle — cost with no benefit, because Bun executes TypeScript directly. The backend therefore has `start: bun src/index.ts` and no build. `turbo run build` stays a no-op until Phase 6, when the Vite app gives it something real to do; **`turbo.json`'s `build` outputs are still the starter's Next-specific `.next/**` globs and need updating to Vite's `dist/**` then.**

**Deferred.** `DEMO_USER_EMAIL` and `DEMO_USER_PASSWORD_HASH` move to Phase 3, which is where the hash script that generates the value lives — requiring a bcrypt hash at boot before anything can produce one would have been circular. `GEMINI_API_KEY` currently holds a placeholder so the server boots; **Phase 4 must replace it with the real key**, and `.env` carries a `TODO(Phase 4)` marker saying so.

---

### Phase 2 — Error and middleware spine · ~20m

**Goal:** one error envelope, produced by one translation point, for every failure in the app.

**Deliverables:** `lib/errors.ts` (`AppError` hierarchy) · `lib/logger.ts` (structured, redacting) · `middleware/requestId.ts` · `middleware/errorHandler.ts` · `middleware/rateLimit.ts` · a 404 fallback handler · the Phase 2 test from §15.

**Gate:**

```sh
# 1. Unknown route returns the §9 envelope, not Express's HTML page.
curl -s http://localhost:3000/api/nope
# → {"error":{"code":"NOT_FOUND","message":...,"requestId":"..."}}

# 2. Oversized body is caught as a validation error, NOT an HTML error page.
#    (This resolves §17 item 5.)
python3 -c "print('{\"prompt\":\"' + 'x'*5000000 + '\"}')" > /tmp/big.json
curl -s -X POST http://localhost:3000/api/echo \
  -H 'Content-Type: application/json' --data @/tmp/big.json
# → 400 VALIDATION_FAILED in envelope shape

# 3. Rate limiter trips.
for i in (seq 1 40); curl -s -o /dev/null -w "%{http_code} " http://localhost:3000/api/echo; end
# → 200s then 429s

# 4. The request id in an error body appears in the logs for that request.

bun test
```

✅ Pass when all four produce the envelope shape from §9, the request id correlates to a log line, and the Phase 2 test is green.

**Deliberately not working yet:** no auth, no LLM.

**Scaffolding note:** these checks need *some* POST route to exist. Phase 2 adds a temporary `POST /api/echo` that validates a body and echoes it back. It is removed in Phase 5, when `/api/query` takes over as the real subject of these same checks. It is listed here explicitly so it does not survive to submission by accident.

#### ✅ Outcome — complete

All four gates pass, plus `bun test` green at **20 tests across 3 files**. `/api/nope` returns `NOT_FOUND` in the envelope with a `X-Request-Id` header matching the body's `requestId`; a 5,000,014-byte body returns `400 VALIDATION_FAILED` as JSON; 40 requests against a capacity-20 bucket produce exactly 20 × `200` then `429` with `Retry-After: 3`; and the request id from an error body resolves to two log lines (`request rejected` at `warn`, `request completed` at `info`).

**§17 item 5 — answered.** `express.json({ limit })` rejects an oversized body *before* any application code runs, as an `http-errors` instance carrying `type: 'entity.too.large'` — never as a `ZodError`, so the prompt cap is never consulted. Express's default handler answers those with an HTML page, which was the one hole through which a non-envelope error response could escape. `errorHandler` therefore maps the seven `type` discriminants body-parser can raise (`entity.too.large`, `entity.parse.failed`, `entity.verify.failed`, `encoding.unsupported`, `charset.unsupported`, `request.aborted`, `request.size.did.not.match`) onto `VALIDATION_FAILED`. Verified by curl *and* by two assertions in `tests/errorHandler.test.ts`, since this is a default-behaviour regression that a refactor could silently reintroduce.

**Decision — the transport limit is derived from the domain limit.** `express.json`'s 100 kb default would buffer a body 25× the prompt cap before zod rejected it. The prompt cap counts characters and a JSON body counts bytes, and a UTF-8 character is at most four bytes, so `LLM_MAX_PROMPT_CHARS * 4 + 1024` is the tightest limit that cannot reject a legal prompt. Stating the reasoning matters more than the number: a hardcoded `'20kb'` would drift silently the moment the cap changed.

**Decision — the code → status table is exhaustive by construction.** `HTTP_STATUS_BY_ERROR_CODE` is declared `as const satisfies Record<ErrorCode, number>`, so adding a code to the shared union without giving it a status is a compile error rather than a 500 found in production. This is the second place the shared package is load-bearing rather than decorative.

**Decision — `express.urlencoded` removed.** Nothing in this API accepts a form body, and a JSON endpoint that also accepts `application/x-www-form-urlencoded` is reachable from a cross-origin HTML form *without* a preflight — so the CORS allowlist, which is the actual control, would not be consulted. One deleted line, one fewer bypass.

**Decision — the inbound `X-Request-Id` is not adopted.** A client-supplied id lands verbatim in the logs, which is a log-injection vector; honouring it would need a format allowlist first. The id is always generated server-side. Noted in `requestId.ts` that the right production move is to adopt the infrastructure's trace header (`X-Amzn-Trace-Id`), which is not attacker-controlled.

**Decision — the rate limiter is a factory, not a singleton, and sweeps inline.** A factory lets each route set its own budget and each test start from an empty bucket. The sweep matters more: a `Map` keyed on client-controlled input is a slow memory-exhaustion vector, so buckets that have refilled to capacity are dropped once the map exceeds 10,000 keys — a full bucket is indistinguishable from one that never existed, so forgetting it changes no decision. Swept inline rather than on a `setInterval`, which would hold the event loop open and leak a timer into every test. `req.ip` reflects the socket peer, so a deployment behind the ALB in §12 must set `trust proxy` or every client shares one bucket; trusting `X-Forwarded-For` unconditionally is the opposite mistake, since the header is forgeable.

**Finding — the test suite needed its own environment, or it would not run on a clean clone.** `src/env.ts` exits non-zero without `JWT_SECRET` and `GEMINI_API_KEY`, so `bun test` depended on a developer's local, gitignored `.env` — meaning the README's "run the tests" step would fail for a reviewer. Added a committed `apps/backend/.env.test`, which Bun loads when `NODE_ENV=test` (`bun test` sets it) *after* `.env`, so its placeholders win. Verified by probe: under `bun test` the suite sees `SALT_ROUNDS=4` and the placeholder key, not the local values. Safe to commit because every value in it is a placeholder, and it lowers the bcrypt cost from 10 to 4 — the right number in production, the wrong one multiplied across a suite.

**Finding — the logger is silent under test, and redaction is tested directly instead.** The suite's job is to provoke the failures the logger exists to record, so a run logged 42 kB of expected stack traces over thirteen assertions. `MIN_LEVEL` is now `silent` when `NODE_ENV=test`. Since that makes stdout capture useless, the pure redaction function is exported and unit-tested directly: nested secrets, prompt truncation, the `Error` + `cause` chain that `JSON.stringify` renders as `{}`, and cyclic/BigInt/function values that must not make the logger throw while reporting a failure. A security claim that exists only as a comment is not a guarantee.

**Finding — `NODE_ENV` was an undeclared turbo input.** `turbo/no-undeclared-env-vars` flagged `logger.ts` reading `process.env.NODE_ENV` directly (it must, since the logger needs a level before the zod schema has validated anything). Added `globalEnv: ["NODE_ENV"]`, so turbo no longer serves a cached result across a mode change, and registered a `test` task with `.env*` in its inputs.

**Tests are run through a real socket on port 0.** The app is exported separately from `listen()`, and the test helper binds an OS-assigned loopback port — so the suite never collides with a dev server on `APP_PORT` or with a parallel file. Going through HTTP rather than calling handlers directly is the point: `express.json` rejecting an oversized body and Express's HTML fallback for an unmatched route both live in the transport layer and are invisible to a handler-level double.

**Beyond the planned gate.** The most valuable assertion in `errorHandler.test.ts` is not in §16: a route throws an error whose message contains a fake internal endpoint and a fake credential, and the test asserts the *entire serialised response* — not just `message` — contains neither. That is the §9 rule ("upstream provider errors never reach the client verbatim") as an executable check rather than a convention, and it is what will catch a future handler that helpfully forwards `error.message`.

**Finding — the leak-canary fixtures had to stop looking like real keys.** The first version used `AIzaFAKEKEY…`, which made Phase 0's gate 3 (`git grep -E "AIza[0-9A-Za-z_-]{10,}"`) match tracked content from then on. A secret scan with a permanent known-good match is a scan everyone learns to ignore, which costs more than the fixture's realism was worth. The canaries are now `CANARY-NOT-A-REAL-CREDENTIAL` and `internal.provider.invalid` (a reserved TLD), and gate 3 is clean again. The assertion needs a *distinctive* string, not a plausible one.

---

### Phase 3 — Authentication · ~25m

**Goal:** a real sign → verify → expire cycle, with each failure cause distinguishable.

**Deliverables:** `scripts/hash-password.ts` · `routes/auth.ts` (`POST /api/auth/login`) · `middleware/requireAuth.ts` (algorithm-pinned, iss/aud asserted) · `routes/me.ts` (`GET /api/me`, protected) · the Phase 3 tests from §15.

**Gate:**

```sh
# 0. Generate the demo hash and put it in .env as DEMO_USER_PASSWORD_HASH.
cd apps/backend && bun run scripts/hash-password.ts 'demo-password'

# 1. Correct credentials mint a token.
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password"}'
# → {"token":"eyJ...","tokenType":"Bearer","expiresIn":900}

# 2. Wrong password → 401 AUTH_INVALID_CREDENTIALS (NOT 500, NOT a zod error).

# 3. The claims are real. Decode the payload and confirm iss, aud, sub, exp:
echo '<token>' | cut -d. -f2 | base64 -d 2>/dev/null

# 4. The protected route enforces each failure distinctly:
curl -s http://localhost:3000/api/me                               # AUTH_MISSING_TOKEN
curl -s -H 'Authorization: Bearer garbage' .../api/me              # AUTH_INVALID_TOKEN
curl -s -H 'Authorization: Bearer <valid>' .../api/me              # 200 {sub,email,exp}
# expired: set JWT_EXPIRES_IN=2s, mint a token, wait, retry       # AUTH_EXPIRED_TOKEN

bun test    # includes the alg-confusion case
```

✅ Pass when every row of the §9 auth block returns its own code — four distinguishable 401s, not one generic one — and the alg-confusion test is green.

**Deliberately not working yet:** no LLM, no frontend. `/api/me` is the only protected route.

**Why `/api/me` exists:** Phase 3 must be verifiable before `/api/query` exists, so it needs a protected route of its own. `/api/me` is five lines, is genuinely useful in the README's curl walkthrough, and — unlike the Phase 2 echo route — is worth keeping. The alternative, deferring all auth verification to Phase 5, would merge two gates into one and make a failure ambiguous between the auth and LLM layers.

#### ✅ Outcome — complete

All four gates pass; `bun test` green at **37 tests across 4 files**, 17 of them in `requireAuth.test.ts`. Login mints `{"token":"eyJ…","tokenType":"Bearer","expiresIn":900}`; the decoded payload carries `sub=demo-user`, `iss=ai-query-assistant`, `aud=ai-query-assistant-web`, `email`, and a 900-second `exp - iat`; and the protected route returns a **distinct code for each of six causes** — missing header, non-Bearer scheme, empty bearer value, garbage token, wrong-secret token, wrong issuer, wrong audience and shapeless-but-valid payload all resolve correctly, with `AUTH_EXPIRED_TOKEN` confirmed against a live server running `JWT_EXPIRES_IN=2s`.

**Finding — §7's stated rationale for algorithm pinning was wrong, and the real one is better.** The plan claimed that without `algorithms: ['HS256']`, `jsonwebtoken` "honours the algorithm named in the token's own header — the classic `alg` confusion attack". Measured against the installed v9:

| Token | Unpinned | Pinned `['HS256']` |
| --- | --- | --- |
| `alg: none`, unsigned | **rejected** — `jwt signature is required` | rejected |
| `alg: HS512`, same secret | **ACCEPTED** | rejected — `invalid algorithm` |

So two corrections. First, `alg: none` is already blocked by the library, pin or no pin — the textbook attack this library was once vulnerable to has been fixed upstream, and repeating the claim would have been parroting. Second, the dangerous asymmetric→symmetric confusion (RS256 verify key replayed as an HMAC secret) **is not reachable in this configuration at all**, because the key is a symmetric string: there is no public key for an attacker to re-sign with.

What pinning genuinely buys here is narrower and still worth the line: unspecified, `jsonwebtoken` derives the acceptable set from the *key type*, which for a string secret is the whole HMAC family — so the server accepts tokens it would never issue, and the moment the secret moves to an asymmetric keypair (or the library's default set changes) that latitude becomes the real attack. Pinning is defence against configuration drift, not against a live exploit in the current shape. **This is now an executable claim rather than an assertion:** `tests/requireAuth.test.ts` asserts both that the HS512 token is rejected through the API *and* that `jwt.verify` accepts the very same token when the pin is removed — so the test fails if the line ever stops doing work.

**Finding — Bun's dotenv loader silently corrupts any value containing `$`.** The env schema's bcrypt-shape regex failed at boot on a hash that was demonstrably correct. Cause: Bun expands `$VAR` references in `.env`, and a bcrypt hash is `$2b$10$…` — so `$2b`, `$10` and `$KLcJJ09iXl2Hx` were each consumed as undefined variables and a 60-character hash arrived 40 characters long. Probed systematically rather than guessed at:

| Form in `.env` | Result |
| --- | --- |
| `$2b$10$KLcJ…` | truncated |
| `'$2b$10$KLcJ…'` (single-quoted) | truncated |
| `"$2b$10$KLcJ…"` (double-quoted) | truncated |
| `$$2b$$10$$KLcJ…` | empty string |
| `\$2b\$10\$KLcJ…` | **correct** |

Quoting does not disable expansion, which is a real deviation from conventional dotenv semantics — and the one form Bun honours is the one that breaks everywhere else, because Docker's `--env-file` (which Phase 7's gate uses on this very file) passes escapes through literally. **Resolution: the variable is now `DEMO_USER_PASSWORD_HASH_B64`, holding the base64-encoded hash** — the only encoding that is byte-identical through Bun's loader, through `bun --env-file`, through Docker's `--env-file`, and through an injected secret where nothing parses the value at all. `scripts/hash-password.ts` emits that form directly, so nobody has to know any of this; `src/env.ts` validates by decoding and matching the bcrypt shape, and exposes the decoded value under the separate name `DEMO_USER_PASSWORD_HASH` so no call site can confuse the two.

Worth noting *why this surfaced at boot instead of in production*: the regex in the env schema was written to catch someone pasting a plaintext password, and it caught a loader bug instead. Without it, the only symptom would have been "login always rejects the correct password" — a failure with no error, no log line, and nothing pointing at the configuration. That is the concrete argument for validating the *shape* of a secret and not merely its presence.

**Decision — the login endpoint spends a bcrypt compare even when the email does not match.** Short-circuiting on an unknown email makes the endpoint a timing oracle for account existence: a wrong email answers in well under a millisecond while a right one spends ~100ms in bcrypt, which is comfortably measurable across a network. The compare now runs unconditionally and the result is combined afterwards. Both failures also return the *same* code and the *same* message, asserted by a test that compares the two responses field by field — one demo user makes this close to theoretical, and it costs two lines.

**Decision — four distinguishable 401s, and one deliberately indistinguishable pair.** `AUTH_MISSING_TOKEN` / `AUTH_INVALID_TOKEN` / `AUTH_EXPIRED_TOKEN` / `AUTH_INVALID_CREDENTIALS` are separated because the client acts on each differently and because "401" alone tells the logs nothing about whether a client is broken, a token is stale, or someone is probing. The pair that is *not* separated is which half of a credential pair was wrong — see above. Distinguishing causes is good; distinguishing them for an unauthenticated caller is not.

**Decision — a verified signature is not a trusted payload.** `verifyAccessToken` parses the decoded claims through a zod schema after the signature checks out. A valid signature proves this service issued the token; it says nothing about the payload's shape, and a token signed with the right secret but missing `email` would otherwise reach the handler with `req.auth.email` undefined. Covered by a test that signs exactly such a token.

**Decision — `expiresIn` is derived from the signed token, not from `JWT_EXPIRES_IN`.** Re-parsing the configured duration string to report a lifetime would be a second implementation of the same arithmetic, free to disagree with the `exp` claim it describes. The route decodes the token it just signed and reports `exp - iat`.

**Decision — `sub` is an opaque id, not the email.** `sub` is the claim most likely to end up in a log line or as a rate-limit key (Phase 5 does exactly that), so it must not carry PII. The email travels as its own claim. Asserted by a test.

**Decision — the login route is rate-limited more tightly than the query route.** Capacity 10/minute by IP, against the query route's 20. A password guess is cheap for an attacker and expensive for this process — bcrypt at cost 10 is ~100ms of CPU *by design* — so an unthrottled login is simultaneously a credential risk and a self-inflicted denial of service. Keyed by IP because there is no authenticated identity yet, which is precisely why the limiter belongs here and not only on protected routes.

**Note — `.env.example` ships a real, working hash.** It is a genuine bcrypt hash of the documented demo password `demo-password`, so a reviewer can copy the file, add a Gemini key, and log in with no extra step. That is safe because the password is public: what the design demonstrates is that configuration holds a hash and login performs a bcrypt compare, and a published demo credential does not weaken either. `scripts/hash-password.ts` remains the documented way to generate your own, and it warns when the password is read from argv, since that lands in shell history.

**Note — `SALT_ROUNDS` added to `turbo.json`'s `globalEnv`.** `scripts/hash-password.ts` reads it directly, because it deliberately cannot import `src/env.ts` — that schema *requires* the hash the script exists to produce, so importing it would be circular. The narrow, documented exception to validating configuration in one place.

---

### Phase 4 — LLM provider seam and the Gemini adapter · ~30m

**Goal:** prove the real provider call works, and that every documented failure mode is handled, *before* any HTTP plumbing is involved.

**Deliverables:** `services/llm/provider.ts` (interface) · `services/llm/gemini.ts` · `services/llm/fake.ts` · `services/llm/index.ts` (env-driven selection) · `scripts/smoke-llm.ts` · the Phase 4 tests from §15 · **§17 items 1–4 resolved and their answers recorded in the spec.**

**Gate:**

```sh
# 1. A real round-trip, outside Express entirely.
cd apps/backend && bun run scripts/smoke-llm.ts "Why is the sky blue?"
# → prints the answer text, the resolved model id, and the finishReason

# 2. Timeout path against the real provider.
LLM_TIMEOUT_MS=1 bun run scripts/smoke-llm.ts "hello"
# → a typed LLM_TIMEOUT error, not an unhandled rejection or a hang

# 3. The no-content path cannot silently succeed.
bun test tests/gemini.adapter.test.ts
# → the fake's empty response surfaces as LLM_NO_CONTENT; an input-side
#   block surfaces as LLM_CONTENT_BLOCKED; neither returns "" as a success

# 4. §17 answered in writing: does httpOptions carry a timeout/abortSignal;
#    what are the real finishReason/blockReason enum names; what does the
#    SDK's bundled p-retry already do; is response.text a property or method.
```

✅ Pass when the smoke script returns real model output, the forced timeout produces a typed error, the no-content tests are green, and §17 items 1–4 have written answers rather than assumptions.

**Deliberately not working yet:** `/api/query` does not exist. The LLM is reachable only from the script and the tests.

**Why the smoke script is the gate:** it isolates "does the SDK work the way §8 assumes" from "is the route wired correctly". If the first real query fails only at Phase 5, the cause is ambiguous across two layers. This is also the phase where §8's central claim — Gemini returning HTTP 200 with no usable text — is confirmed against the actual SDK types instead of taken on trust.

#### ⚠️ Outcome — complete except gate 1, which needs a real API key

Gates 2, 3 and 4 pass. **Gate 1 (a real round-trip returning model output) is unverified**: `GEMINI_API_KEY` in `apps/backend/.env` is still the Phase 1 placeholder, and the project owner chose to continue rather than pause for it. Everything up to the provider's front door is confirmed against the real SDK over the real network — see below — and the one remaining step is a single command, recorded at the end of this section.

`bun test` green at **70 tests across 5 files**, 33 of them in `tests/gemini.adapter.test.ts`.

**Gate 2 — the timeout path, against the real SDK.** `LLM_TIMEOUT_MS=1 bun run scripts/smoke-llm.ts "hello"` produces `LLM_TIMEOUT` / 504 in 6ms with `context: {"timeoutMs":1}`, and exits 1. Not a hang and not an unhandled rejection.

**Partial gate 1 — the error path is confirmed end to end against the live API.** Run with the placeholder key, the smoke script reaches `generativelanguage.googleapis.com`, receives a genuine HTTP 400 `API_KEY_INVALID`, and returns `LLM_UNAVAILABLE` / 502 with the client-facing message *"The model is temporarily unavailable. Please try again."* The provider's own text — `"API key not valid"`, the project metadata, the service name — appears **only** in `cause`, which only the logger reads. So the §9 rule is verified against a real provider error rather than a fabricated one, which is the harder half of the claim; what remains unverified is only the success path.

### §17 items 1–4 — answered against the installed SDK

Read out of `@google/genai@2.31.0`'s type definitions and shipped JavaScript, not its README.

**1. `httpOptions` timeout and abort-signal support — both exist, but ⚠️ they do NOT compose into a reliable total deadline.** `HttpOptions.timeout` is milliseconds, and `GenerateContentConfig.abortSignal` is a real `AbortSignal`. Reading `createAttemptSignal` in the shipped code showed the two mean *different* things:

- `httpOptions.timeout` bounds **each attempt**; the SDK builds a fresh signal per attempt from it.
- `abortSignal` is the **same object across every attempt**, so it *appears* to bound the whole sequence, backoff included. `onFailedAttempt` also re-throws immediately if it has aborted.

**That second conclusion was wrong, and live traffic disproved it.** See "Finding — the total deadline was not actually enforced" below. The adapter no longer relies on it: the deadline is enforced by racing the call against it in `complete()`. The plan's original fallback instinct — an `AbortSignal.timeout()` wrapper at the adapter boundary — turned out to be the right one after all, just for a different reason than anticipated.

**2. `FinishReason` and `BlockedReason` enum members — the plan guessed the type name wrong.** It is `BlockedReason`, not `BlockReason`. `FinishReason` has **19** members and `BlockedReason` has **8**:

| | Members |
| --- | --- |
| `FinishReason` | `FINISH_REASON_UNSPECIFIED`, `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `MALFORMED_FUNCTION_CALL`, `IMAGE_SAFETY`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `IMAGE_PROHIBITED_CONTENT`, `NO_IMAGE`, `IMAGE_RECITATION`, `IMAGE_OTHER`, `CONTINUATION` |
| `BlockedReason` | `BLOCKED_REASON_UNSPECIFIED`, `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`, `MODEL_ARMOR`, `JAILBREAK` |

Most are image- or tool-specific and irrelevant here. The eight that mean "the model declined" are enumerated in the adapter as `CONTENT_BLOCKED_FINISH_REASONS`, declared `as const satisfies readonly FinishReason[]` so an SDK upgrade that renames one is a compile error rather than a case silently falling through to `LLM_NO_CONTENT`.

**3. The SDK's `p-retry` behaviour — retry is OFF by default, which inverts the plan's concern.** §8 worried that stacking a hand-rolled backoff on an SDK that already retries would multiply worst-case latency. The shipped `apiCall` says otherwise:

```js
if (!retryOptions) {
  return runFetch();   // no retry at all
}
```

Nothing retries until `httpOptions.retryOptions` is supplied — the documented defaults (5 attempts, 1s initial delay, 60s max, base 2, jitter, on 408/429/5xx) apply only *once you opt in*. So the risk was never double-retrying; it was **not retrying at all** while believing the SDK had it covered.

Opted in, but not with those defaults, which are lifted from a Cloud Storage retry strategy: inside a request with a human waiting, a single 503 would spend 1+2+4+8 = 15 seconds in `setTimeout` alone. The adapter uses `attempts: 2`, `initialDelay: 0.5`, `maxDelay: 2` — one extra attempt recovers a transient blip and costs little — and restricts `httpStatusCodes` to `[408, 500, 502, 503, 504]`. **429 is excluded on purpose:** retrying a rate limit inside the request burns the caller's deadline and adds load to the service that just asked for less. It belongs in the client's hands, which is exactly why `LLM_RATE_LIMITED` is a retryable code in the shared contract and carries `Retry-After`.

**4. `response.text` is a property, not a method.** `get text(): string | undefined` — a getter, so the README's property access is right, and the `| undefined` is the whole point of §8. This detail also changed the tests: a plain object literal with a `text` field would not reproduce a getter, so the fixtures use `Object.defineProperty(response, 'text', { get })` to be faithful rather than approximately right.

### Decisions

**Output-side safety stops map to `LLM_CONTENT_BLOCKED` (422), not `LLM_NO_CONTENT` (502) — a deliberate refinement of §9's matrix.** The matrix split "200 with no content" into *input blocked* → 422 and *other* → 502. But a `finishReason` of `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `SPII` is not an outage: the provider answered, and its answer was a refusal. A 502 would claim the upstream is broken, send an operator hunting a non-existent incident, and — because `LLM_UNAVAILABLE`-class codes are the retryable ones — invite the UI to offer a retry for a prompt that will fail identically every time. `LLM_NO_CONTENT` is now reserved for genuinely inexplicable emptiness.

**Truncation is surfaced with the text, never discarded.** `MAX_TOKENS` with text returns `truncated: true` alongside a usable partial answer — a third outcome that is neither success nor failure, which the UI can say out loud. `MAX_TOKENS` with *no* text is still `LLM_NO_CONTENT`: the limit can be consumed entirely by reasoning tokens, and truncated-and-empty is still empty. Both covered by tests.

**The adapter reports the resolved model, not the requested alias.** `gemini-flash-latest` is an alias; `response.modelVersion` is what actually answered. Reporting the resolved value is what makes a log line reproducible months later, when the alias points somewhere else.

**The interesting logic is pure and exported, so it is tested directly rather than mocked.** `interpretGeminiResponse` and `mapGeminiError` are pure functions, and `createGeminiProvider` takes an injectable `generate`. No mocking library, no network, and the SDK's own `ApiError` and `FinishReason` are used in the fixtures — so the tests fail if the SDK's shapes change, which a hand-rolled mock would not.

**The fake provider is reachable at runtime, and refused in production.** `LLM_PROVIDER=fake` serves deterministic answers, and prompt prefixes (`!empty`, `!blocked`, `!timeout`, `!ratelimit`, `!unavailable`, `!truncated`, `!hang`) make every row of the error matrix reachable from the UI with no token spend — which is what makes Phase 6's "each error state actually triggered" gate achievable rather than aspirational. `env.ts` refuses `fake` when `APP_STAGE=prod` via a `superRefine`, and `services/llm/index.ts` refuses it again, because a production deployment silently serving canned answers is a worse outcome than one that will not start. The smoke script also prints a loud warning when it is running against the fake: a smoke check that cannot fail is not a smoke check.

**The smoke script exits non-zero**, distinguishing 1 (a typed `AppError`, i.e. the adapter did its job) from 2 (an unmapped throw, i.e. it did not). That makes it usable as a deployment smoke check rather than something read by eye.

### 🔧 Post-Phase-6 corrections, found by running against the real API

Both of these were invisible to the fake provider and to the whole test suite. They appeared within minutes of the first real `GEMINI_API_KEY` being configured, which is the argument for Phase 4's gate 1 existing at all.

**Finding — the total deadline was not actually enforced.** §17 item 1 concluded that a shared `abortSignal` bounds the whole retry sequence. Measured against the live API, one call took **37,598 ms against `LLM_TIMEOUT_MS=20000`** and returned `LLM_UNAVAILABLE` rather than `LLM_TIMEOUT`.

Diagnosed by instrumenting the SDK's `httpOptions.fetch` hook rather than by reading minified source:

```
     3ms  attempt 1 START   deadlineAborted=false
 19211ms  attempt 1 END     status=504
 20000ms  DEADLINE fired
 20003ms  attempt 2 START   signalAborted=true
 20003ms  attempt 2 THREW   AbortError        <- correct, bounded at 20s
```

That run behaved correctly. The failing shape is the other one: when attempt 1 fails slightly *earlier*, attempt 2's fetch is already in flight when the deadline fires, and the abort does not reach it — so the call runs to roughly `attempts × timeout`. The SDK honours `abortSignal` in isolation (verified independently: a 2 s signal aborts a request at 2001 ms), so this is a race, not a missing feature. **A guarantee that holds only when the timing is favourable is not a guarantee.**

Fixed by enforcing the deadline in `complete()`: the `generate()` call is raced against a promise that rejects on the deadline signal, so the adapter cannot exceed `LLM_TIMEOUT_MS` whatever the SDK or the runtime does. Two details worth recording:

- **The abandoned promise keeps a handler attached** (`call.catch(() => undefined)`). Without it, a provider rejecting *after* the deadline has won produces an unhandled rejection, which under Bun takes the process down — converting a handled timeout into a crash.
- **The per-attempt timeout is deliberately NOT sliced** into `timeoutMs / attempts`. Slicing bounds each attempt tidily but fails a call that legitimately takes longer than one slice while still finishing inside the budget — trading a real success for a neater number. The race already provides the hard total bound.

The regression test is the important artefact: a provider that **ignores its abort signal entirely** and takes 5 s must still fail with `LLM_TIMEOUT` inside a 120 ms deadline. The earlier hanging-provider test could not catch this, because that fake aborted politely — it tested the happy path of cancellation. Verified the test fails against the old implementation (5001 ms) and passes against the new one.

**Finding — the logger over-redacted its own cost data.** A real query logged `usage: {promptTokens: '[redacted]', responseTokens: '[redacted]'}`. The redaction pattern includes `/token/i`, which matches `promptTokens`, `candidatesTokenCount` and `maxOutputTokens` — so the only cost data the query log carries was being scrubbed, protecting nothing.

Fixed by requiring **two** signals rather than one: a key is redacted when its name looks sensitive **and** its value is not a number or boolean. Every credential this application handles is a string — a JWT, an API key, a bcrypt hash, a password, an `Authorization` header, a cookie — while a token *count* is a number. Strings, objects and arrays under a sensitive key are all still redacted, so `{ authorization: { raw: '…' } }` cannot slip through by nesting.

The residual gap, stated rather than hidden: a secret stored as a *number* would now be logged. No such value exists here, and the alternative — maintaining an allowlist of safe field names — rots the moment someone adds a metric.

**Note — the model id had to change, and that it was a config change is the point.** `gemini-flash-latest` and `gemini-2.5-flash` both returned `503 "This model is currently experiencing high demand"`, and `gemini-2.5-flash-lite` returned 404 for this key. `GEMINI_MODEL=gemini-3.5-flash` answers. Because the model is env-configurable (§10), working around a provider-side capacity problem required no code change and no redeploy — which is exactly why it is a variable and not a constant.

This also confirmed the Phase 4 decision to report the *resolved* model rather than the requested alias: the request asks for `gemini-3.5-flash` and the response reports `gemini-3.6-flash`.

### ⬜ Remaining step for gate 1

✅ **Closed.** A real key is configured and the gate passes:

```
provider    : gemini
resolved model : gemini-3.6-flash
finishReason   : STOP
usage          : {"promptTokens":10,"responseTokens":29}
elapsed        : 3538ms
answer         : "Sunlight reaches Earth's atmosphere and is scattered in all
                  directions by the gases and particles in the air…"
```

Verified both through `scripts/smoke-llm.ts` (no HTTP layer) and through `POST /api/query` end to end, with the server log confirming `provider: gemini` and no fake-provider warning at boot. The two defects this immediately exposed are recorded above.

---

### Phase 5 — `POST /api/query` · ~20m

**Goal:** compose the three verified layers into the endpoint the brief actually asks for.

**Deliverables:** `routes/query.ts` · shared schema wired into validation · rate limiter keyed on JWT subject · temporary `/api/echo` removed · the Phase 5 tests from §15.

**Gate:**

```sh
# 1. The full happy path, end to end.
set TOKEN (curl -s -X POST localhost:3000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password"}' | jq -r .token)
curl -s -X POST localhost:3000/api/query -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"Why is the sky blue?"}'
# → 200 {answer, model, finishReason, requestId}

# 2. Unprotected → 401. Same call with no Authorization header.
# 3. Empty prompt → 400 VALIDATION_FAILED with field details.
# 4. Over LLM_MAX_PROMPT_CHARS → 400, rejected before any provider call
#    (confirm in the logs that no outbound request was made).
# 5. Timeout → 504. Restart with LLM_TIMEOUT_MS=1 and repeat check 1.
# 6. Echo route is gone: curl -s localhost:3000/api/echo → NOT_FOUND

bun test      # all suites
```

✅ Pass when every §9 row reachable without the frontend returns its documented code and status, the oversized prompt is rejected *before* spending a token, and the full suite is green.

**Deliberately not working yet:** no UI — the API is complete and curl-verifiable.

**Backend is feature-complete at this gate.** Everything after this phase is presentation, packaging, and documentation. If the budget overruns, this is the point at which what exists is already a coherent, defensible submission.

#### ✅ Outcome — complete

All six gates pass; `bun test` green at **88 tests across 6 files**. The happy path returns `{answer, model, finishReason, truncated, requestId, usage}` with `requestId` equal to the `X-Request-Id` header; unauthenticated → `AUTH_MISSING_TOKEN`; empty prompt → `VALIDATION_FAILED` with `details[0].path === "prompt"`; a 4001-character prompt → 400 **with zero provider calls** (asserted both by log-line count against the running server and by a `spyOn` assertion of `toHaveBeenCalledTimes(0)`); `LLM_TIMEOUT_MS=1` against the real Gemini adapter → 504 `LLM_TIMEOUT`; and `/api/echo` is gone, answering `NOT_FOUND`.

Verified through `LLM_PROVIDER=fake`, so every row of the error matrix was exercised end to end over HTTP — `!timeout` → 504, `!ratelimit` → 429 with `Retry-After`, `!unavailable` → 502, `!blocked` → 422, `!empty` → 502 — with no network and no token spend. This is the payoff of the Phase 4 seam: these are the rows that are nearly impossible to trigger against a live provider on demand.

**Finding — the planned client-disconnect cancellation is not implementable on this stack, and was removed rather than shipped.** The route originally aborted the upstream call when the browser went away, so an abandoned request would stop costing tokens. It was wired the conventional way, on `res.on('close')`. A test asserting the provider's signal actually aborted failed — and four probes against Bun 1.3.13 + Express 5 explain why:

| Event | POST, client disconnects | POST, completes normally |
| --- | --- | --- |
| `req` `close` | **+0ms** (body consumed) | **+0ms** (body consumed) |
| `req.destroyed` | **true at +102ms**, before the 300ms abort | true early, same reason |
| `req` `aborted` | never | never |
| `res` `close` | **never** | +2001ms |
| `res` `finish` | **never** | +2000ms |
| `socket` `close` / `socket.destroyed` | never / stays false | — |

So under Bun's `node:http` compatibility layer the events are the reverse of Node's: `res.on('close')` fires exactly when it is *not* needed and stays silent when it is, while `req`'s signals describe the request *body* stream rather than the connection and so fire identically whether the client is there or not. There is no usable server-side disconnect signal for a POST.

Three consequences, all now reflected in the code:

1. **The route no longer pretends to cancel.** Shipping the wiring would have looked like working cancellation while doing nothing — strictly worse than not having it, because it would be believed. The measurement is recorded in `routes/query.ts` so the next person does not re-derive it.
2. **An intermediate "fix" was itself a bug, caught by the same measurement.** Having found that `req.on('close')` fires on disconnect for a GET, the access logger was changed to log `abandoned` from it. Because `req` `close` fires at +0ms for *every* POST, that would have labelled every single POST abandoned. Reverted to `res.on('finish')` alone. The lesson is the generalisable one: the first probe used a GET, and the behaviour that mattered only differs on a request *with a body*.
3. **The honest limitation is stated rather than hidden.** A request whose client goes away mid-flight produces no access line, and its upstream call runs to completion or to `LLM_TIMEOUT_MS`. The adapter's own deadline still bounds every call, so nothing can pin a request open indefinitely. The capability arrives free by running on Node, or by serving with `Bun.serve`, whose `Request.signal` aborts on disconnect — recorded for the README's known-limitations section.

The `LlmCompleteInput.signal` seam stays, and stays unit-tested: the adapter honours a caller signal and composes it with its own deadline. Only the HTTP-layer *source* of that signal is unavailable, which is a different thing from the seam being wrong.

**Decision — `requireAuth` runs before validation, and before the rate limiter.** The order on the route is not interchangeable. Auth first, so an unauthenticated caller gets `AUTH_MISSING_TOKEN` rather than a description of the request shape they have no access to — asserted by a test that sends an invalid body with no token and expects 401, not 400. Rate limiter second, because it keys on `req.auth.subject`, which only exists after auth.

**Decision — the rate limiter keys on the JWT subject, and the test proves it.** An IP key puts an entire office behind a shared NAT into one bucket while handing an attacker with a handful of addresses a fresh budget per address; the limit should follow the account. The test demonstrates this from the inverse direction, which is the only way to actually prove the key: two different subjects calling from the *same* loopback address get independent budgets — exhaust subject A at capacity 20, and subject B's next call still returns 200. An IP-keyed limiter would have rejected it.

Worth recording what the first version of that test got wrong: it signed two tokens for the same subject and asserted they differed. They were byte-identical, because identical claims signed within the same second produce the same JWT. The assertion was not just failing, it was meaningless — and replacing it forced the better test above.

**Decision — validation precedes everything that costs money, and that is asserted rather than assumed.** A test that only checked for a 400 on an oversized prompt would pass just as happily with the provider call left in front of it. The `spyOn(...).toHaveBeenCalledTimes(0)` assertion is what makes the ordering a guarantee. A boundary test (`exactly LLM_MAX_PROMPT_CHARS` → 200) guards the off-by-one on the limit the UI mirrors.

**Decision — the route has no `try`/`catch`.** Every provider failure is already a typed `AppError` and the single translation middleware owns the response, so a catch here could only make the envelope inconsistent. A test confirms the other half: when the provider throws something *untyped*, the route does not dress it up — it collapses to `INTERNAL_ERROR` with the provider's message, endpoint and credential fragment absent from the serialised response.

**Note — the transport-layer error tests moved from `/api/echo` to `/api/query`.** With the scaffolding gone they now exercise the real endpoint. Two of the three need no token, which is itself the point: `express.json` is mounted app-wide and fails before the router runs, which is exactly why that hole had to be closed in Phase 2.

---

### Phase 6 — Frontend · ~50m

**Goal:** the UI the brief asks for, with every error state actually reachable.

**Deliverables:** Vite scaffold on port 3020 (C8) · `lib/api.ts` with `AbortController` · `useAuth.ts` (in-memory token) · `LoginForm` · `QueryForm` · `ResponsePanel` · `ErrorNotice`.

**Gate:**

```sh
cd apps/web && bun run dev     # must serve on :3020 to match CORS_ORIGINS
```

1. **Happy path** — log in, submit a query, the answer renders. No CORS error in the console.
2. **Distinct error states, each actually triggered:**
   - stop the backend → connection error, not a blank screen
   - submit an empty prompt → the validation message
   - paste over the character cap → blocked client-side, mirroring the server
   - `JWT_EXPIRES_IN=10s`, wait, resubmit → session-expired message and a return to login
   - restart with `LLM_TIMEOUT_MS=1` → the timeout message, distinct from the above
3. **Abort works** — submit, then immediately resubmit a different prompt. Exactly one answer renders, and it is the second one. Network tab shows the first request cancelled.
4. **No secret in the client bundle:**

```sh
cd apps/web && bun run build
grep -rniE "gemini|AIza[0-9A-Za-z_-]{10,}|JWT_SECRET" dist/   # → no matches
```

5. **Output is not rendered as markup** — ask the model to return `<img src=x onerror=alert(1)>` and confirm it displays as visible text and does not execute.

✅ Pass when all five hold. Checks 4 and 5 are the security gates and are not optional: check 4 verifies the architecture's central claim, and check 5 verifies that model output is treated as untrusted data (§6).

**Deliberately not working yet:** no container, docs not written.

#### ✅ Outcome — complete

All five gates pass, verified in a **real headless Chrome** rather than by inspection: **43 browser checks** across three passes (31 on the main flow, 7 on session expiry against a backend running `JWT_EXPIRES_IN=3s`, 5 on a real provider timeout with `LLM_PROVIDER=gemini LLM_TIMEOUT_MS=1`). Plus `bun test` at **99 tests** repo-wide — 88 backend, 11 web — and `lint` and `check-types` clean across all three workspaces.

Every error state in gate 2 was *actually triggered*, not reasoned about, which is what the Phase 4 fake provider was built for:

| Trigger | Code shown | Retry offered? |
| --- | --- | --- |
| backend stopped | `NETWORK_ERROR` | yes |
| empty prompt | submit disabled client-side | — |
| 4001 chars | submit disabled, *"1 character over the 4000 limit"* | — |
| `!blocked` | `LLM_CONTENT_BLOCKED` | **no** |
| `!timeout` / real `LLM_TIMEOUT_MS=1` | `LLM_TIMEOUT` | yes |
| `!ratelimit` | `LLM_RATE_LIMITED` | yes |
| `!unavailable` | `LLM_UNAVAILABLE` | yes |
| `!empty` | `LLM_NO_CONTENT` | **no** |
| token expired | `AUTH_EXPIRED_TOKEN`, returned to login | — |

The retry column is the part worth noting: it is driven by `isRetryableErrorCode` from the shared contract, so the *backend* decides what is worth retrying. A blocked prompt and an empty response get no retry button, because retrying either fails identically and a button that never works teaches the user to distrust the button.

**Gate 4 — no secret in the client bundle.** Exact counts in `dist/`: `gemini` 0, `JWT_SECRET` 0, `DEMO_USER_PASSWORD` 0, `AIza`-shaped keys 0. The only environment value present is `http://localhost:3000`, the API base URL.

One honest clarification: the literal string `demo-password` **is** in the bundle, because `LoginForm` prefills the public demo credential. That is the same reasoning that lets `.env.example` ship a working hash — the password is documented, so publishing it weakens nothing, and what the architecture actually protects is the provider key and the signing secret, neither of which appears. Worth stating rather than quietly scoping the grep to hide it.

**Gate 5 — model output is not rendered as markup.** The fake provider echoes the prompt into its answer, so `<img src=x onerror=alert(1)>` returns through the real response path exactly as a model's output would. In the browser: the payload rendered as **visible text**, the DOM contained `&lt;img`, **no `<img>` element was created**, and an `alert()` trap installed before page load never fired.

That verification lived in a throwaway driver, so it is now also a **committed test** (`apps/web/tests/rendering.test.tsx`): the payload is asserted escaped through the answer body, the model name *and* an error message — every field from the server is untrusted, not just the answer — alongside a structural check that no `dangerouslySetInnerHTML`, `innerHTML =` or `insertAdjacentHTML` exists anywhere in `src/`.

React escapes by default, so these pass today for free, which is exactly why they are worth having: the regression is one `dangerouslySetInnerHTML` added by someone wanting to render markdown, and nothing else in the suite would notice. **Verified that the gate can fail** by temporarily injecting that sink into `ResponsePanel` — 6 tests went red, both behavioural and structural — then reverting. Same discipline as the Phase 1 lint probe: "clean" is indistinguishable from "not looking".

**Gate 3 — abort.** Submitting a second prompt before the first returns leaves exactly one answer panel, containing the second prompt's answer, with the first absent. Without the `AbortController` the two responses race and whichever lands last wins, which is not necessarily the one the user asked for second.

### Findings

**C9 is now definitively not advisory — but the fix removed the Node dependency instead of documenting it.** `bun run dev` failed with `TypeError: crypto.hash is not a function`: Vite 7 requires Node ≥ 20.19 and resolves through its own shebang to the system Node 18. Rather than requiring nvm for the web app the way `lint` does, the scripts now run `bun --bun vite`, which forces Bun to execute Vite's binary itself. `dev`, `build` and `preview` all work with no Node present. **`lint` remains the only task that needs Node ≥ 24.**

**The web app was linting "clean" by not being read at all.** Every `.tsx` file failed with `Parsing error: Unexpected token`, because the shared Babel parser config loads only `@babel/preset-typescript`, which does not enable JSX parsing. ESLint reports that as an error, but it is really the linter being unable to open the file — so a whole app can appear to pass. Fixed with `@babel/plugin-syntax-jsx` in a `**/*.{tsx,jsx}` block: a linter only needs to *parse* JSX, never transform it, so the syntax plugin is smaller and more honest than pulling in `@babel/preset-react`. (The `isTSX`/`allExtensions` options that used to serve this purpose were **removed in Babel 8**, which the first attempt discovered.) This is the third variation of the same Phase 1 finding, and the probe is again the only trustworthy check: a deliberate `.tsx` violation now reports `react-hooks/exhaustive-deps`, `no-dupe-keys` and `no-debugger`.

**`apps/web` uses `@repo/eslint-config/react-internal`, not `base`.** It supplies the browser globals the app actually runs in, and `eslint-plugin-react-hooks` — whose `exhaustive-deps` rule catches the stale-closure bugs that are easy to write in `useCallback` and hard to see in review. The config existed in the repo from create-turbo and was previously unused by anything.

**A console 404 failed the gate, and the cause was a missing favicon.** Browsers request `/favicon.ico` unprompted; `index.html` declared no icon. The gate asserts zero console errors, which is the right strictness — but the failure was noise, and noise is what trains a reviewer to ignore the console, the one place real problems surface. Fixed with an inline SVG `data:` URI, so there is no binary file and no extra request. Found by instrumenting Playwright's `response` and `requestfailed` events rather than by guessing, after a first guess-free check of a plain page load came back empty (the request only happens once the tab renders).

### Decisions

**Direct cross-origin calls, not a Vite proxy.** A dev proxy would make the browser see one origin and CORS would never be exercised — which would leave the backend's explicit allowlist (and the comment explaining why no wildcard) as untested decoration. Calling `http://localhost:3000` from `http://localhost:3020` exercises the real preflight, and the gate's "no CORS errors in the console" check therefore means something. Production collapses to one origin anyway via CloudFront routing `/api/*` to the ALB (§12), which narrows CORS further rather than relying on it.

**`strictPort: true` on 3020.** Without it Vite silently moves to 3021 when 3020 is taken, and every API call then fails a preflight — a confusing console error whose actual cause is a port number. Failing to start is the better outcome, and widening `CORS_ORIGINS` to make the error go away would be the wrong fix.

**The prompt cap comes from `@repo/shared`, not a second hardcoded number.** `PROMPT_MAX_CHARS` is imported by both `QueryForm` and `src/env.ts`'s default, so the client-side mirror cannot drift into permitting a prompt the server rejects — the usual failure being two constants that agree until one is changed. It remains a convenience and never a control: `LLM_MAX_PROMPT_CHARS` is authoritative and enforced regardless.

**No client-side expiry timer.** The token's lifetime is known, so the app *could* pre-emptively sign the user out. It does not: the server is the authority on validity, and a client clock running fast would end a working session while one running slow would keep a dead one. Acting on the server's `AUTH_EXPIRED_TOKEN` is simpler, correct, and means the expiry path is genuinely exercised rather than hidden behind a guess — which is what the 7-check expiry pass confirms, including that signing in again recovers the session.

**The API client validates responses against the shared schemas.** A 2xx body that does not match the contract raises `MALFORMED_RESPONSE` rather than being read as `undefined` — the client-side twin of the Gemini adapter's no-content rule. This matters in practice: a 502 from a load balancer or a 404 from a wrong base URL arrives as HTML, and reading `body.error.code` off HTML is precisely the class of bug the shared contract exists to prevent.

**Client-origin failures are a separate union, not added to `ErrorCode`.** `NETWORK_ERROR` and `MALFORMED_RESPONSE` live in the web app. `ErrorCode` is the wire contract and every member of it has an HTTP status in the backend's translation table; a fetch that never reached the server has no status, so adding it there would force a meaningless one and weaken the exhaustiveness check that makes the table trustworthy.

**A superseded request renders nothing.** `RequestAbortedError` is distinct from `ApiError` so the UI can tell "cancelled" from "failed" — showing "request cancelled" where the new answer is about to appear would be noise. This is what makes gate 3's "exactly one answer, and it is the second" true rather than incidental.

**Memory-only token, stated in the UI itself.** The footer says a refresh signs you out and that this is deliberate, so the trade-off is visible to whoever is demoing rather than looking like a bug. A token in `localStorage` is readable by any script on the page, so one XSS — in the app or any dependency — exfiltrates it, and it outlives the tab to be stolen later.

**Accessibility treated as correctness, not polish.** Labelled controls, `:focus-visible` rings on every interactive element (never `outline: none`), `aria-live="polite"` on the answer so it is announced without interrupting, `aria-live="assertive"` on errors because an error interrupts the task, and the character counter announced only when it is over the limit so a screen reader is not read a running count on every keystroke.

**`turbo.json` build outputs corrected** from the starter's Next-specific `.next/**` globs to `dist/**`, which is the first time `turbo run build` has had real work to cache.

---

### Phase 7 — Containerisation · ~20m

**Goal:** a Dockerfile that demonstrably works, since "working" is checkable (§11).

**Deliverables:** `apps/backend/Dockerfile` (multi-stage) · `.dockerignore`.

**Gate:**

```sh
# 1. Builds from the REPOSITORY ROOT as context — the workspace lockfile
#    constraint from §11. (`--frozen-lockfile` itself was already verified
#    in Phase 0, so a failure here is a context/COPY bug, not a lockfile one.)
#    Run from the repo root:
docker build -f apps/backend/Dockerfile -t ai-query-assistant-api .

# 2. Runs, and is reachable from the host.
docker run --rm -p 3000:3000 --env-file apps/backend/.env ai-query-assistant-api
curl -i http://localhost:3000/health        # → 200

# 3. A real query works through the container (repeat Phase 5 check 1).

# 4. Non-root.
docker run --rm --entrypoint id ai-query-assistant-api -u    # → NOT 0

# 5. No secret baked into the image. Run with NO env file:
docker run --rm --entrypoint sh ai-query-assistant-api -c 'env | grep -i -e gemini -e jwt'
docker run --rm --entrypoint sh ai-query-assistant-api -c 'ls -a /app | grep -F ".env"'
# → both produce no output

# 6. Healthcheck is wired: docker inspect reports a Health status, not "none".
```

✅ Pass when the image builds from root context, serves a real query, runs as non-root, and checks 5 and 6 both come back clean.

**Deliberately not working yet:** docs.

**Check 5 is the one that matters.** A build that works while leaking `.env` into a layer is worse than no Dockerfile, because the image looks correct and ships the credential. `docker history` will show it even if `ls` does not.

---

### Phase 8 — Documentation · ~40m

**Goal:** the two deliverables carrying two of the five grading axes.

**Deliverables:** root `README.md` rewritten per §13 (C6) · `DEPLOYMENT.md` per §12 · `.env.example` final.

**Gate:**

```sh
# 1. The setup instructions actually work from a clean clone. Do it for real:
git clone . /tmp/clean-clone && cd /tmp/clean-clone
# follow the README verbatim, with nothing but the key from your own .env.
# Any step you have to improvise is a README bug — fix it, don't narrate it.

# 2. .env.example matches the env schema exactly, with no drift in either
#    direction. Compare the two key lists:
grep -oE '^[A-Z_]+' apps/backend/.env.example | sort -u
# ...against the keys in the zod object in src/env.ts. Diff must be empty.

# 3. .env.example contains placeholders only — no real key, no real secret.
```

4. **`DEPLOYMENT.md` covers every §12 bullet**, including the two that carry the most weight: Secrets Manager injected as task `secrets` rather than plaintext `environment`, and GitHub Actions via OIDC rather than long-lived keys.
5. **`README.md` includes the "known limitations" section (§13 item 6)** naming streaming, Redis rate limiting, no persistence, memory-only token, and the single demo user — since a limitation named reads as judgment and the same gap unmentioned reads as an oversight.
6. **No Turborepo starter text survives** — `grep -n "create-turbo\|@repo/ui" README.md` finds nothing (C6).

✅ Pass when a clean clone runs by following the README alone, `.env.example` and the schema agree exactly, and checks 4–6 hold.

---

### Budget

| Phase | Est. | Cumulative |
| --- | --- | --- |
| 0 — Secret safety | 10m | 0:10 |
| 1 — Workspace foundation | 20m | 0:30 |
| 2 — Error spine | 20m | 0:50 |
| 3 — Auth | 25m | 1:15 |
| 4 — LLM adapter | 30m | 1:45 |
| 5 — `/api/query` | 20m | 2:05 |
| 6 — Frontend | 50m | 2:55 |
| 7 — Docker | 20m | 3:15 |
| 8 — Docs | 40m | 3:55 |

**≈ 3h 55m**, inside the stated 3–4 hours.

Ordering is deliberate: Phase 0 prevents the unrecoverable mistake, Phase 1 unblocks everything, Phases 2–4 each verify one layer in isolation so a Phase 5 failure is never ambiguous across layers, and documentation comes last so it describes what was built rather than what was planned.

**If the budget overruns**, compress in this order: the number of tests beyond the alg-confusion and no-content cases, then the frontend's visual polish, then `packages/shared` (see Review notes). **Do not compress Phase 8** — it carries the engineering-communication and security-awareness axes, and it is the only deliverable the reviewer reads before running anything.

---

## 17. To verify at implementation time

Assumptions this plan has **not** confirmed. Items 1–4 are resolved in **Phase 4** and item 5 in **Phase 2**; each is checked against the installed SDK rather than trusted, and the answers are written back into this document.

1. ~~**`httpOptions` timeout / `abortSignal` support**~~ — **resolved in Phase 4.** Both exist. `httpOptions.timeout` (ms) bounds each attempt; `config.abortSignal` is reused across attempts and so bounds the whole sequence. The adapter uses both; no wrapper fallback needed.
2. ~~**Exact `finishReason` and `blockReason` enum values and their TypeScript names**~~ — **resolved in Phase 4.** The type is `BlockedReason`, not `BlockReason`. 19 `FinishReason` members and 8 `BlockedReason` members, both listed in the Phase 4 outcome.
3. ~~**The SDK's native `p-retry` behaviour**~~ — **resolved in Phase 4.** Retry is OFF unless `retryOptions` is passed. Opted in with 2 attempts / 0.5s initial delay, 429 excluded.
4. ~~**Whether `response.text` is a property or a method**~~ — **resolved in Phase 4.** A getter: `get text(): string | undefined`. The `| undefined` is the failure mode §8 is built around.
5. ~~**`express.json({ limit })` interaction with the prompt cap**~~ — **resolved in Phase 2.** An oversized body is rejected by body-parser as an `http-errors` instance with `type: 'entity.too.large'` before application code runs, so the prompt cap is never consulted and the default handler would answer with HTML. `errorHandler` maps all seven body-parser `type` values to `VALIDATION_FAILED`; covered by two tests.

---

## Review notes

Points where a different call is reasonable, flagged for the reviewer:

- **`packages/shared` (§5)** is the one piece of scope not traceable to a stated requirement. It is justified by the monorepo question and end-to-end type safety, but it could be cut from Phase 1 to buy ~20 minutes.
- **Memory-only token storage (§6)** means a page refresh logs the user out. Correct for security, mildly annoying to demo. Worth a conscious yes/no.
- **The login endpoint (§2)** exceeds what the brief requires, since a hardcoded token is explicitly acceptable. The bet is that it pays for itself on the security axis and in the debrief.
- **AWS over Azure (§12)** is an arbitrary pick between two options the brief treats as equivalent. Say so if Azure is the better fit for the audience.
- **`lint` can never fail the build.** `eslint-plugin-only-warn`, inherited from create-turbo, downgrades every rule to a warning, so `turbo run lint` exits 0 regardless of findings. That is a reasonable DX default and a poor CI gate. Removing the plugin from `packages/eslint-config/base.js` is a one-line change if you would rather lint be able to fail — worth deciding before Phase 8 documents the commands.
- **Two throwaway routes** are introduced for gate isolation: `/api/echo` (Phase 2, removed in Phase 5) and `/api/me` (Phase 3, kept). If you would rather not add scaffolding that does not ship, the alternative is to merge Phases 2–5 into one gate — at the cost of a failure that could originate in any of four layers.
