# Hosted merrymen — ONE image, TWO services, THREE roles.
#
# The same image runs the Next.js dashboard (the web service), or — on the
# orchestrator service — the process-per-tenant supervisor or the recovery reply
# listener. The role is picked by the MERRYMEN_START env var per service, and it
# is scripts/container-start.sh that reads it, holds it to an allowlist and execs
# the role, under tini (the ENTRYPOINT/CMD at the bottom; docs/hosted-deploy.md).
# railway.json deliberately sets NO startCommand and NO healthcheck, so this one
# image + a single per-service variable is the only difference between them — and
# the orchestrator, which serves no HTTP, is never failed by a path healthcheck it
# can't answer. All need the whole monorepo present: the web build resolves
# packages/core + worker from source via tsconfig paths (next.config
# externalDir), and the other two run worker/src directly with tsx at runtime.
#
# node:22 (not alpine) for glibc + a node new enough for the built-in node:sqlite
# the worker uses (>= 22.12).
FROM node:22-slim

# tini, to be PID 1 (the ENTRYPOINT at the bottom). First, so this layer is
# cached across every source change. Debian's package puts it at /usr/bin/tini.
#
# AND THE BUILD RUNS IT, at the exact path the ENTRYPOINT names. Nothing else
# would notice a tini that is missing or elsewhere (a base-image change, a
# renamed package) until the container started: the build would pass, the new
# deployment would replace the live one — railway.json has no healthcheck to
# stop it — and every role would then crash-loop on `exec /usr/bin/tini: no
# such file or directory`. Failing HERE leaves the previous deployment serving.
# `--version` prints and exits 0 before tini looks at PID 1 or a child.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/bin/tini --version

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

# The start script is the CMD, so the build parses it with the image's own sh
# (dash) — for the same reason as the tini check above: a script that cannot
# parse, or is not where the CMD says, fails the build and not the deploy.
# `-n` reads without running anything; no role starts here.
RUN /bin/sh -n /app/scripts/container-start.sh

# NEXT_PUBLIC_* IS INLINED AT BUILD TIME, NOT READ AT RUNTIME.
#
# That is the whole point of the prefix: Next substitutes the literal value into
# the browser bundle during `next build`. A variable set on the Railway service
# arrives at RUNTIME, which is far too late — the bundle has already been
# written with an empty string, and the feature it gates is off with nothing in
# the logs to say so. That is exactly how the Privy login shipped, deployed
# green, and still drew "Sign in with wallet".
#
# Railway exposes service variables to a Dockerfile build only where an ARG
# declares them, so each one has to be named here. These are PUBLIC by
# definition — an app id and a boolean — and nothing secret may ever be added
# to this list: an ARG is baked into the image layer and readable by anyone who
# can pull it. Every secret stays a runtime variable (see the CMD below).
ARG NEXT_PUBLIC_PRIVY_APP_ID=""
ARG NEXT_PUBLIC_TRENCHER_FACTORY=""
ARG NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH=""
ARG NEXT_PUBLIC_MERRYMEN_PRIVY_BETA=""
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_TRENCHER_FACTORY=$NEXT_PUBLIC_TRENCHER_FACTORY
ENV NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH=$NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH
ENV NEXT_PUBLIC_MERRYMEN_PRIVY_BETA=$NEXT_PUBLIC_MERRYMEN_PRIVY_BETA

# Build the dashboard (the web service serves it; the orchestrator ignores it).
RUN npm run build

ENV NODE_ENV=production
# Which start path this image has. An image built before the roles ran this way
# does not carry it, so a start-phase check can tell an old image from this one
# by asking, rather than by guessing from the process tree.
ENV MERRYMEN_IMAGE=dockerfile-v1

# ONE image, THREE roles, selected by MERRYMEN_START (a Railway per-service var):
#   web service          → MERRYMEN_START unset → start:web (the Next dashboard)
#   orchestrator service → MERRYMEN_START=start:orchestrator (the per-tenant supervisor)
#                          or start:recovery-replies (the recovery reply listener)
# Still an npm script NAME, never a command: scripts/container-start.sh runs only
# an allowlist of them, and refuses an empty or unknown value with exit 64 —
# never an arbitrary shell command, and never the wrong role running green.
#
# NO npm AND NO `sh -c` ON THE START PATH, and tini as PID 1. The old CMD here,
# `sh -c "npm run …"`, put a shell and npm between PID 1 and node, so whether
# Railway's SIGTERM ever reached the orchestrator's stop handler rested on
# whether that shell exec'd its one command and whether npm, as PID 1, passed
# the signal on. Now tini forwards the signal to its one child, and the script
# `exec`s node in its own place, so that child IS node — by construction, not by
# a property of somebody's shell. tini runs WITHOUT -g on purpose: the signal
# goes to node alone, never to the tenant workers the orchestrator spawned,
# because the orchestrator decides how and in what order its own children are
# stopped. tini also reaps any orphan reparented to PID 1, which neither npm
# nor node would.
# worker/src/container-start.test.ts holds the shape of both lines.
#
# Every secret (MERRYMEN_SESSION_SECRET, MERRYMEN_STORE_DEK, DATABASE_URL, the
# house keys) is injected at RUNTIME by Railway, never baked into the image.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "/app/scripts/container-start.sh"]
