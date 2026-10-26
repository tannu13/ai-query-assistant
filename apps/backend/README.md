# `backend`

The Express 5 API: JWT auth, rate limiting, and the Gemini adapter. Runs on Bun, which executes the TypeScript directly — there is no build step.

```sh
bun run dev           # watch mode on APP_PORT (default 3000)
bun run start         # what the container runs
bun test
bun run check-types
```

Configuration comes from `.env`, validated by zod at boot; the process exits non-zero and names every offending variable on a problem. Start from `.env.example` — only `GEMINI_API_KEY` has no working default.

```sh
bun run scripts/hash-password.ts '<password>'   # generates DEMO_USER_PASSWORD_HASH_B64
bun run scripts/smoke-llm.ts '<prompt>'         # one real provider call, no HTTP
```

**Setup, architecture, the error contract and the decisions behind all of it are in the [root README](../../README.md).** The `Dockerfile` here builds from the *repository root* as context, not from this directory — see its header for why.
