# Deployment plan — AWS

This is a plan, not a deployed system: the brief asks for the written approach, and nothing here has been applied to a live account. It is deliberately opinionated — one target, with the alternatives named and rejected at the end rather than surveyed as equals.

**AWS over Azure** is an arbitrary pick between two the brief treats as equivalent. The Azure equivalent of every component is in [Alternatives considered](#alternatives-considered); if Azure is the house stack, that section is the real plan and the rest translates component for component.

---

## Shape

```
                     ┌──────────────────────────────────────────┐
 browser ──TLS──▶    │ CloudFront (one origin, WAF attached)    │
                     └───────────┬──────────────────┬───────────┘
                           /api/*│                  │/*
                                 ▼                  ▼
                     ┌───────────────────┐   ┌──────────────────┐
                     │ ALB (HTTPS, ACM)  │   │ S3 (private, OAC)│
                     └─────────┬─────────┘   │  apps/web/dist   │
                               ▼             └──────────────────┘
                     ┌───────────────────────────────┐
                     │ ECS Fargate service           │
                     │  task: ai-query-assistant-api │
                     │  2+ tasks, private subnets    │
                     └───────┬───────────────┬───────┘
                             ▼               ▼
                  Secrets Manager     generativelanguage.googleapis.com
                  (via NAT / VPC endpoints)
```

One browser origin, two paths. The backend is never publicly addressable — only the ALB is, and only from CloudFront.

---

## Images

**ECR**, one repository, **immutable tags by commit SHA** (`…/ai-query-assistant-api:a1b2c3d`).

Tag immutability is turned on at the repository, which makes a given tag permanently resolve to the same bytes. Without it, `:latest` or a re-pushed `:v1.2` means the artifact that passed CI and the artifact that ran in production are only *probably* the same image, and a rollback target can be overwritten by the thing you are rolling back from. A SHA tag also makes "what is running?" answerable by `git show`.

Scan on push, with the pipeline failing on HIGH/CRITICAL findings. Lifecycle policy expiring untagged images after 7 days and keeping the last 30 tagged ones.

The build is already root-context (see [`apps/backend/Dockerfile`](apps/backend/Dockerfile)), so CI runs exactly the command the README documents — no deploy-only build path that developers never exercise.

## Backend — ECS Fargate behind an ALB

**Fargate, not EC2.** At this scale the entire value of EC2 capacity is the ability to tune instances, and there is nothing here to tune: the container is a stateless, I/O-bound HTTP process. Choosing EC2 would buy AMI patching, cluster capacity management and draining semantics, in exchange for a per-vCPU saving that is irrelevant at two tasks. Fargate's weakness — per-second billing above EC2 reserved pricing — only matters at a scale this app is not at.

| Setting | Value | Why |
| --- | --- | --- |
| CPU / memory | 0.5 vCPU / 1 GB | The process idles waiting on a provider HTTP call; it is not compute-bound |
| Desired count | 2, across ≥2 AZs | One task is a single point of failure, not a deployment |
| Subnets | private, egress via NAT | Nothing needs an inbound route from the internet except the ALB |
| `stopTimeout` | 30 s | Longer than `SHUTDOWN_TIMEOUT_MS` (8 s), so the app always wins the race and exits on its own terms |
| Platform | ARM64 (Graviton) | ~20% cheaper for the same work; `oven/bun` publishes arm64 and the image has no x86-only native dependency — `bcrypt` ships an arm64 musl prebuild |

**Target group health check** → `GET /health`, 200 expected. That endpoint is unauthenticated and does **not** call the LLM provider, which is the point: a health check that spent a token per probe would make liveness a recurring cost, and a provider outage would fail every task's health check and turn a degraded dependency into a cluster-wide restart loop. Liveness and dependency health are different questions, and the ALB is only entitled to the first.

**Deregistration delay** → 35 s on the target group, just over `stopTimeout`. The ordering that matters during a rolling deploy:

1. ECS deregisters the task from the target group; the ALB stops sending it new requests.
2. ECS sends `SIGTERM`. The app stops accepting connections, drains in-flight requests, closes idle keep-alive sockets, and exits 0 — see [`apps/backend/src/index.ts`](apps/backend/src/index.ts).
3. Only if that takes longer than `stopTimeout` does ECS resort to `SIGKILL`.

Get this wrong and every deploy drops live requests, which is not academic here: a single query may legitimately run for `LLM_TIMEOUT_MS` (20 s by default), so the window in which a task is holding real user work is wide. `SHUTDOWN_TIMEOUT_MS` must stay **below** `stopTimeout` or it has no effect at all.

**Circuit breaker with rollback** enabled on the service, so a task that cannot pass its health check — the shape a bad `JWT_SECRET` takes, since the env schema exits non-zero at boot — rolls back automatically instead of draining the healthy tasks into a crash loop.

## Frontend — S3 behind CloudFront

`apps/web` builds to static assets (`bun run build` → `apps/web/dist`), uploaded to a **private** S3 bucket reached only through CloudFront with **Origin Access Control**. No public bucket policy, no website-hosting endpoint.

CloudFront has **two origins and one domain**:

- `/api/*` → the ALB
- everything else → S3, with `/index.html` as the SPA fallback for 403/404

**That single origin is a security decision, not a convenience.** The browser makes same-origin requests, so:

- CORS stops being load-bearing in production. `CORS_ORIGINS` narrows to the one CloudFront domain, and the preflight path effectively disappears rather than becoming the thing standing between the API and the open internet.
- No `Authorization` header crosses an origin boundary.
- The ALB's security group accepts only CloudFront (via the managed prefix list), so the API has no reachable public address of its own.

Cache behaviour: hashed assets (`index-27K0vUhC.js`) get a long `max-age` and are immutable by construction; `index.html` gets `no-cache`; `/api/*` is **not cached at all** — `CachePolicy: CachingDisabled`, with `Authorization` forwarded. A cached POST response here would serve one user's answer to another.

Invalidate `/index.html` only on deploy. The content-hashed files never need invalidating, which is the whole reason Vite names them that way.

---

## Secrets

**`GEMINI_API_KEY` and `JWT_SECRET` live in AWS Secrets Manager and reach the container as ECS task-definition `secrets`, never as `environment`.**

This is the single most important line in this document. The difference looks cosmetic in JSON and is not:

```jsonc
// WRONG — the value is now part of the task definition, forever
"environment": [
  { "name": "GEMINI_API_KEY", "value": "AIzaSy…" }
]

// RIGHT — the task definition holds a reference; the agent resolves it at launch
"secrets": [
  { "name": "GEMINI_API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-north-1:…:secret:aqa/gemini-api-key" },
  { "name": "JWT_SECRET",     "valueFrom": "arn:aws:secretsmanager:eu-north-1:…:secret:aqa/jwt-secret" }
]
```

A task definition is **not** a secret store. `environment` values are plaintext in the revision, readable by anyone holding `ecs:DescribeTaskDefinition` — which is a broad, often-granted, read-only-*looking* permission — visible in the console, returned by `aws ecs describe-task-definition`, and **immortal**, because task-definition revisions are immutable and cannot be deleted, only deregistered. Rotating the key afterwards does not remove it from revision 7. With `secrets`, the definition holds an ARN, the ECS agent resolves it at launch using the **execution** role, and the value exists only in the task's environment.

Consequences worth stating:

- **Two roles, not one.** The *execution* role is what pulls from ECR and reads these two secret ARNs — `secretsmanager:GetSecretValue` scoped to exactly those ARNs, not `*`. The *task* role is what application code gets, and it needs **no** AWS permissions at all, because the app talks only to Google. Collapsing them into one role is the common shortcut and it hands application code the ability to read its own secrets, which is precisely the capability an RCE wants.
- **Rotation is a task replacement**, not a live reload: the env schema reads configuration once at boot. Rotating means writing the new version and forcing a new deployment. That is a real limitation, honestly cheaper here than a secrets-caching client, and worth saying out loud rather than implying the key refreshes itself.
- **Non-secret config stays in `environment`** — `APP_STAGE=prod`, `GEMINI_MODEL`, `LLM_TIMEOUT_MS`, `CORS_ORIGINS`, `SHUTDOWN_TIMEOUT_MS`. Routing everything through Secrets Manager would make the mechanism meaningless by making it ordinary.
- **`DEMO_USER_PASSWORD_HASH_B64` is base64 for a reason that pays off here.** It is byte-identical through Bun's dotenv loader, Docker's `--env-file`, and an injected secret — the last of which does no parsing at all. See the comment on it in [`apps/backend/src/env.ts`](apps/backend/src/env.ts).

**Nothing secret exists in the image.** Verified rather than asserted: the built image was exported with `docker save`, every layer decompressed, and the live key, signing secret and password hash searched for as bytes — 0 hits, against a positive control that proved the scan was reading real content. `.dockerignore` excludes `**/.env` and `**/.env.*` at every depth, and the Dockerfile copies named paths instead of `COPY . .`, so a credential has to defeat two independent controls to reach a layer.

**The frontend holds no secret by construction.** Its only variable is `VITE_API_BASE_URL`, and in this topology it is a path prefix on the same origin. Everything in a Vite bundle is public; keeping the provider credential out of the browser is the entire reason this backend exists.

---

## Observability

**CloudWatch Logs** via the `awslogs` driver. The app already emits one JSON object per line on stdout with no pretty-printing mode, so what a developer reads locally is byte-identical to what the aggregator ingests — there is no second format that only production uses.

**`requestId` is the correlation key.** It is generated per request, returned in the `X-Request-Id` response header, embedded in every error envelope the client can see, and stamped on every log line for that request. A user reporting "it failed and said `fc25f4d7-…`" is one Logs Insights query from the full server-side story, including the upstream provider error that was deliberately *not* sent to them:

```
fields @timestamp, level, message, code, durationMs, model, finishReason
| filter requestId = 'fc25f4d7-fa5b-4abb-80ef-e0d7bc4e780d'
| sort @timestamp asc
```

Retention set explicitly (30 days) — the default is "never expire", which is an unbounded bill and, for logs that touch user prompts, an unbounded liability.

**Alarms**

| Alarm | Signal | Why this one |
| --- | --- | --- |
| 5xx rate | ALB `HTTPCode_Target_5XX_Count` / `RequestCount` > 2% for 5 min | The composite "something is broken" signal |
| p99 latency | ALB `TargetResponseTime` p99 > 15 s | Below `LLM_TIMEOUT_MS`, so it fires *before* users start seeing 504s |
| `LLM_UNAVAILABLE` / `LLM_TIMEOUT` | metric filter on the structured logs | Separates "the provider is degraded" from "we are broken" — the same 502 to a user, completely different response from us |
| Unhealthy hosts | target group `UnHealthyHostCount` ≥ 1 | Catches a boot-time config failure, the shape an env-schema exit takes |
| Task restarts | ECS service events | A crash loop otherwise hides behind a healthy-looking desired count |

Deliberately **not** built: distributed tracing and a metrics backend. Named in the README as a known limitation, because a 3–4 hour exercise that shipped an OpenTelemetry collector would be making a worse trade, not a better one.

---

## Scaling

**Target tracking on `ALBRequestCountPerTarget`**, not CPU. Min 2, max 10, 60 s scale-out cooldown, 300 s scale-in.

CPU is the reflexive choice and it is the wrong signal for this workload. The container spends almost all of a request `await`ing Gemini over HTTP, so concurrency climbs long before CPU does: tasks fill up with in-flight requests, latency rises, and CPU is still comfortable. A CPU target scales **late** — after users are already queued behind a saturated event loop. Request count per target is a direct proxy for in-flight concurrency, which is the resource actually running out.

Scale-in is deliberately slower than scale-out: removing a task mid-deploy is cheap, but removing one while 20-second requests are in flight depends on the drain sequence above working correctly every time. Asymmetric cooldowns cost a little money and avoid a lot of churn.

The ceiling to watch is **not** AWS. Google AI Studio enforces per-project rate limits, so past some point adding tasks converts 200s into `LLM_RATE_LIMITED` 429s faster. The in-process token bucket is the local defence; a real answer is a provider-side quota increase plus a shared limiter (below).

---

## CI/CD — GitHub Actions with OIDC

**No long-lived AWS access keys exist anywhere.** The workflow assumes a role via GitHub's OIDC provider:

```yaml
permissions:
  id-token: write      # request the OIDC token
  contents: read

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<account>:role/github-actions-aqa-deploy
      aws-region: eu-north-1
```

The trust policy pins the repository **and the ref**:

```jsonc
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    // Not StringLike with a wildcard: `repo:org/aqa:*` lets any branch,
    // and any pull request from a fork, assume the deploy role.
    "token.actions.githubusercontent.com:sub": "repo:<org>/ai-query-assistant:ref:refs/heads/main"
  }
}
```

A stored `AWS_SECRET_ACCESS_KEY` is a credential that never expires, cannot be scoped to a branch, is copyable by anyone who can read it once, and has to be rotated by hand. OIDC replaces it with a token minted per run, valid for minutes, that cannot be used from anywhere else. The subtlety worth knowing is the `sub` condition: a wildcard there is the difference between "main can deploy" and "a pull request from a stranger's fork can deploy".

**Pipeline**

1. `bun install --frozen-lockfile` — the lockfile is the contract; CI must not be allowed to resolve a version nobody committed.
2. `turbo run check-types test` — 105 tests across backend and web (see the README).
3. `turbo run lint` — **but see the caveat below.**
4. Build and push `ai-query-assistant-api:${{ github.sha }}` to ECR.
5. Build `apps/web`, sync to S3, invalidate `/index.html`.
6. Register a new task-definition revision pointing at the SHA tag; update the service; wait for stability.
7. On failure, the deployment circuit breaker rolls back.

Steps 4 and 5 are deliberately **not** atomic with each other, and the ordering follows from that: ship the API first. The frontend only ever calls endpoints the API already serves, so a new API with an old frontend is a working system, while the reverse is not.

> **Caveat on step 3, stated because a green check that cannot fail is worse than no check.** `eslint-plugin-only-warn` is inherited from the Turborepo starter this repo was scaffolded from, and downgrades every rule to a warning, so `turbo run lint` exits 0 regardless of what it finds. That is a reasonable developer-experience default and a useless CI gate. Before this pipeline is relied upon, remove the plugin from `packages/eslint-config/base.js` — a one-line change — or add `--max-warnings=0`.

---

## Edge — WAF

AWS WAF on the CloudFront distribution, with:

- `AWSManagedRulesCommonRuleSet` and `AWSManagedRulesKnownBadInputsRuleSet`.
- A **rate-based rule** on `/api/*` — ~300 requests per 5 minutes per IP.
- A tighter rate-based rule on `/api/auth/login`, where the thing being guessed is a password.

This **complements** the in-process limiter rather than replacing it, because the two protect against different things. WAF stops volumetric abuse at the edge, before it costs a Fargate task anything — but it keys on IP, which puts a whole office behind one bucket and gives an attacker with a /24 a fresh budget per address. The in-process bucket keys on the **JWT subject**, so the limit follows the account rather than the network path. Neither is sufficient: WAF cannot see identity, and the in-process limiter cannot stop traffic it has already paid to receive.

---

## Provider authentication

`@google/genai` supports two credential models, and the choice is not obvious from either side:

| | AI Studio API key | Vertex AI |
| --- | --- | --- |
| Credential | a string | GCP service-account credentials / ADC |
| From AWS | a secret in Secrets Manager | needs GCP identity federated from AWS |
| Enterprise features | — | VPC-SC, CMEK, data residency, GCP quotas & billing |

**Decision: AI Studio API key in Secrets Manager.** Vertex is the stronger enterprise answer when the workload already lives in GCP, but reaching it from ECS means federating a GCP identity from an AWS one — workload identity federation, an audience configuration, and a credential-source file — which is a meaningful amount of cross-cloud plumbing to end up at the same `generateContent` call. For a single-region app on AWS, a rotatable string in Secrets Manager is the right trade.

**It is a trade, not a free win.** An API key cannot be scoped as narrowly as a GCP IAM principal, and it is bearer-style: anyone holding it can spend against the project. That is what makes the `secrets`-vs-`environment` distinction above the load-bearing control rather than a detail.

The switch is adapter-local if it is ever needed. `services/llm/gemini.ts` is the only file that knows the vendor SDK exists, behind the `LlmProvider` interface — moving to Vertex changes the client constructor, not any route.

---

## Alternatives considered

**Lambda + API Gateway** — the cheapest option at this traffic, and genuinely tempting for a request/response API. Rejected on two counts. **Cold starts** land badly on top of multi-second LLM latency, in a UI where the user is already waiting. More decisively, **streaming**: the honest next step for this app is token streaming (see the README), and on Lambda that means response streaming, which works through a Function URL but not through REST API Gateway, forcing an architectural change for what should be a feature change. Fargate keeps a plain long-lived HTTP server, where SSE is a handler change and nothing else.

**App Runner** — closest to "just run my container", and it would genuinely be less YAML: it does ECR-to-URL, TLS, and autoscaling in one resource. Rejected for control rather than capability. It abstracts away the ALB, which is where the health-check and deregistration-delay tuning above lives, and its scaling knob is concurrency per instance rather than a target-tracking policy on a metric of choice. For a service whose correctness during a deploy depends on drain ordering, the abstraction hides the part that matters. A reasonable call in the other direction for a team without AWS depth.

**ECS on EC2** — covered above. Nothing to tune, so nothing to gain.

**EKS** — a Kubernetes control plane and its operational surface for one stateless container. Only defensible if the organisation already runs EKS, in which case this app is a Deployment, a Service, an Ingress and an ExternalSecret, and most of this document still applies.

**Azure, as the equivalent stack** — component for component, and a real alternative rather than a footnote:

| AWS | Azure |
| --- | --- |
| ECR | Azure Container Registry |
| ECS Fargate + ALB | **Container Apps** (or App Service for Containers) |
| S3 + CloudFront | **Static Web Apps**, or Blob Storage + Front Door |
| Secrets Manager → task `secrets` | **Key Vault**, referenced as a Container Apps secret, read with a **managed identity** |
| CloudWatch Logs + alarms | Log Analytics + Azure Monitor alerts |
| GitHub OIDC → IAM role | GitHub OIDC → **Entra ID workload identity federation** |
| WAF on CloudFront | Front Door WAF |

Azure's managed identity is arguably the nicer story than an execution role reading a secret ARN — the container authenticates to Key Vault *as itself*, with no bootstrap credential anywhere. The decision rule is simply where the rest of the estate lives; nothing in this application prefers either cloud.

---

## What this plan does not include

Stated here rather than left to be discovered:

- **No IaC in this repository.** The above would be Terraform or CDK; writing it was outside the exercise's time budget, and an unapplied template would be no more verified than this prose while looking considerably more authoritative.
- **No multi-region.** Single region, two AZs. Multi-region for a stateless API is mostly a DNS and deployment-pipeline problem, and there is no data to replicate.
- **No cost model.** Roughly, two always-on 0.5 vCPU Fargate tasks plus an ALB dominate the fixed cost; Gemini tokens dominate the variable cost, which is why `usage` is logged per query.
- **Rotation is manual** — see Secrets, above.
- **The in-process rate limiter does not coordinate across tasks.** With `n` tasks the effective limit is `n ×` the configured bucket, and a task restart resets it. Redis (ElastiCache) is the production answer; the current limiter is honest about being per-process.
