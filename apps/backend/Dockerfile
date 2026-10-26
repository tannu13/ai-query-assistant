# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build from the REPOSITORY ROOT, not from this directory:
#
#   docker build -f apps/backend/Dockerfile -t ai-query-assistant-api .
#
# That is not a stylistic preference. This is a Bun workspace, so a
# `--frozen-lockfile` install needs the root `package.json`, the root
# `bun.lock` and *every* workspace manifest in the lockfile — verified: with
# `apps/web/package.json` or `packages/eslint-config/package.json` missing,
# bun resolves those workspace specifiers against npm, 404s, and fails with
# "lockfile had changes, but lockfile is frozen". A Dockerfile that assumed
# `apps/backend` as its context could not reach any of those files.
#
# Pinned to the version in the root package.json's `devEngines`, so the
# container and a developer's machine run the same runtime.
# ---------------------------------------------------------------------------
ARG BUN_VERSION=1.3.13

# --- Stage 1: dependencies -------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps

WORKDIR /app

# Manifests and the lockfile only, ahead of any source. This layer is then
# invalidated by a dependency change and not by an edit to a handler, which is
# the whole reason for the split.
COPY package.json bun.lock ./
COPY apps/backend/package.json             apps/backend/
COPY apps/web/package.json                 apps/web/
COPY packages/shared/package.json          packages/shared/
COPY packages/eslint-config/package.json   packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/

# `--frozen-lockfile` so the image can never resolve a version the committed
# lockfile does not name; `--production` to drop devDependencies; `--filter`
# so the API image does not carry the web app's React tree. Together these
# install 240 packages instead of the full graph.
#
# No native-build toolchain is installed, and none is needed: `bcrypt` is the
# only dependency with a binding, and it ships a musl prebuild
# (`prebuilds/linux-x64/bcrypt.musl.node`) that Alpine uses directly.
RUN bun install --frozen-lockfile --production \
      --filter backend \
      --filter @repo/shared

# --- Stage 2: runtime ------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime

# Express reads this, and so does the env schema. APP_STAGE is deliberately
# left to the deployment: `production` here describes the runtime, not the
# environment the container happens to be running in.
ENV NODE_ENV=production

WORKDIR /app

# Dependencies, carried over as a tree rather than reinstalled. bun 1.3's
# isolated linker puts the package store in `node_modules/.bun` at the root
# and gives each workspace a symlink farm pointing into it, so all three
# directories are needed and their relative positions are load-bearing.
COPY --from=deps /app/node_modules                     ./node_modules
COPY --from=deps /app/apps/backend/node_modules        ./apps/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules     ./packages/shared/node_modules

# Source. Named paths, never `COPY . .` — combined with `.dockerignore`, a
# `.env` would have to defeat two independent controls to reach a layer, and
# `docker history` would show it if it did.
#
# There is no build step. Bun executes TypeScript directly, so `src` *is* the
# artifact; see the Phase 1 outcome in specs/implementation-plan.md for why a
# bundling step was tried and removed.
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/src          ./packages/shared/src
COPY apps/backend/package.json    ./apps/backend/
COPY apps/backend/src             ./apps/backend/src

# Everything above is owned by root and the process below is not, so the
# service cannot rewrite its own code at runtime. `bun` (uid 1000) ships with
# the base image; the default user is root, so this line is what makes the
# container non-root.
USER bun

WORKDIR /app/apps/backend

EXPOSE 3000

# Busybox `wget` — the base image has no curl, and adding one for a liveness
# probe is 4MB spent to repeat what is already installed. `--spider` issues a
# request without writing the body to disk.
#
# `/health` is unauthenticated and does not call the LLM provider on purpose:
# a probe that spent a token per run would make this a recurring cost and
# would turn a provider outage into a restart loop. See routes/health.ts.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${APP_PORT:-3000}/health" || exit 1

# Exec form, so bun is PID 1 and receives SIGTERM directly rather than through
# a shell that would swallow it.
CMD ["bun", "src/index.ts"]
