# merrymen — self-hosted trading agent, as a Docker image.
#
# Built from source (no registry): the installer clones this repo and runs
#   docker build -t merrymen:latest .
#
# The image holds the CLI, the dashboard (Next.js production build) and the
# worker. ALL persistent state lives in /app/.merrymen — settings, the grant
# (private keys), the SQLite ledger, the heartbeat — so the container itself
# stays disposable. Run with a bind mount:
#
#   docker run -d --name merrymen --restart unless-stopped \
#     -p 3100:3100 \
#     -v "$HOME/.merrymen:/app/.merrymen" \
#     -e MERRYMEN_HOST=0.0.0.0 -e MERRYMEN_HOME=/app/.merrymen \
#     merrymen:latest
#
# One-shot commands (onboard, doctor, status, recover, …) run with --rm and
# the same volume. bookworm-slim over alpine: safer for the native bits esbuild
# and the web build pull in.
FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first for layer caching. `--ignore-scripts` skips the prepare
# hook (which runs `node cli/build.mjs`); cli/ isn't copied yet, and the web
# build is done explicitly once after the source lands — keeping the huge .next
# output out of the layer it would otherwise invalidate.
COPY package.json package-lock.json tsconfig.json ./
COPY packages packages
RUN npm ci --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm /root/.cache

# Source, then the one-time production build of the dashboard.
COPY cli cli
COPY web web
COPY worker worker
COPY strategies strategies
RUN node cli/build.mjs

# The wrapper runs the container with `--user $(id -u):$(id -g)` so files it
# writes into the /app/.merrymen volume belong to the host user. Everything
# else in /app is read-only except Next's runtime cache, which must stay
# writable by that same unprivileged user — loosen only the build output.
RUN chmod -R a+rwX /app/web/.next

# The dashboard has no login and holds trading controls, so it must be reachable
# only where the owner chooses. Inside the container it binds 0.0.0.0; exposure
# to the world is decided by the `-p` flag on the host, not by the image.
ENV NODE_ENV=production
ENV MERRYMEN_HOST=0.0.0.0
ENV MERRYMEN_HOME=/app/.merrymen
# The container runs as the host user (see the wrapper's --user); give Node a
# home it can always write to instead of /root.
ENV HOME=/tmp

EXPOSE 3100
VOLUME ["/app/.merrymen"]

# `merrymen start` = dashboard + supervised worker.
CMD ["node", "cli/bin.mjs", "start"]
