# Merrymen AI gateway — a long-lived Node HTTP server (NOT a serverless function),
# so it needs a host that runs a persistent process: Railway, Render, Fly, a VPS.
# Vercel's default model won't run this. Build: `docker build -t merrymen-gateway .`
FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching. No lockfile is committed, so use `install`.
COPY package.json ./
RUN npm install --omit=dev

# App source (thin http server + shared core in lib/ + the offline selftest).
COPY server.mjs selftest.mjs ./
COPY lib ./lib

# Fail the image build if the security-critical logic (token scheme + single-use
# nonce + replay protection) regresses. selftest.mjs supplies its own test env.
RUN npm run check

# The three REQUIRED secrets are injected at RUNTIME by the host's env settings and
# are never baked into the image:
#   MERRYMEN_GATEWAY_UPSTREAM_KEY  MERRYMEN_GATEWAY_SECRET (>=32 bytes)  MERRYMEN_GATEWAY_RPC
# The server honors the host-provided PORT (defaults to 8787).
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
