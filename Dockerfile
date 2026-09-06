# Hosted merrymen — ONE image, TWO services.
#
# The same image runs either the Next.js dashboard (the web service) or the
# process-per-tenant supervisor (the orchestrator service); the role is picked by
# the MERRYMEN_START env var per service (see the CMD at the bottom + docs/
# hosted-deploy.md). railway.json deliberately sets NO startCommand and NO
# healthcheck, so this one image + a single per-service variable is the only
# difference between the two — and the orchestrator, which serves no HTTP, is
# never failed by a path healthcheck it can't answer. Both need the whole monorepo
# present: the web build resolves packages/core + worker from source via tsconfig
# paths (next.config externalDir), and the orchestrator runs worker/src directly
# with tsx at runtime.
#
# node:22 (not alpine) for glibc + a node new enough for the built-in node:sqlite
# the worker uses (>= 22.12).
FROM node:22-slim

WORKDIR /app

# Deps first, for layer caching. --ignore-scripts skips the `prepare` hook
# (cli/build.mjs, an npm-package concern); the dashboard is built explicitly
# below. tsx/next/typescript are runtime dependencies, so --omit=dev keeps them.
# .npmrc TRAVELS WITH THE LOCKFILE, and must.
#
# It carries `legacy-peer-deps=true`, which is how `@privy-io/react-auth`'s
# optional smart-wallet peer stops blocking the install. Without it here the
# image runs a STRICTER resolver than the one that wrote package-lock.json, and
# `npm ci` refuses with a dozen "Missing from lock file" lines naming packages
# nobody touched — date-fns, cross-fetch, react@18.3.1. The lockfile is fine;
# the two resolvers simply disagreed, and only one of them had the config.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts

# The Postgres driver — a HOSTED-ONLY runtime dependency. Both the shared ledger
# (worker/src/db.ts) and the grant store (worker/src/grant-store.ts) reach it by
# dynamic import, and only when DATABASE_URL is set; a self-hosted install never
# sets it and never loads pg, which is why pg is deliberately NOT in package.json.
# --no-save keeps it out of the manifest/lock; it just has to exist in the image's
# node_modules so `require('pg')` resolves at runtime. Without this the first
# Postgres access on Railway throws "Cannot find module 'pg'" at boot.
RUN npm install --no-save --ignore-scripts pg@8

# Full source. .dockerignore keeps node_modules / .next / local state out.
COPY . .

# Build the dashboard (the web service serves it; the orchestrator ignores it).
RUN npm run build

ENV NODE_ENV=production

# ONE image, TWO roles, selected by MERRYMEN_START (a Railway per-service var):
#   web service          → MERRYMEN_START unset → `npm run start:web` (the Next dashboard)
#   orchestrator service → MERRYMEN_START=start:orchestrator (the per-tenant supervisor)
# Kept as an npm script name (not a full command) so the surface for a mis-set
# value is just "unknown npm script", never an arbitrary shell command. Every
# secret (MERRYMEN_SESSION_SECRET, MERRYMEN_STORE_DEK, DATABASE_URL, the house
# keys) is injected at RUNTIME by Railway, never baked into the image.
CMD ["sh", "-c", "npm run ${MERRYMEN_START:-start:web}"]
