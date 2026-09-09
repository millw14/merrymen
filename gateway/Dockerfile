# Merrymen AI gateway — a long-lived Node HTTP server (NOT a serverless function),
# so it needs a host that runs a persistent process: Railway, Render, Fly, a VPS.
# Vercel's default model won't run this. Build: `docker build -t merrymen-gateway .`
#
# THIS IMAGE IS FOUND BY POSITION, NOT BY NAME, and railway.json names no
# dockerfilePath on purpose. Railway looks for a Dockerfile at the root of the
# SOURCE directory, which is correct in both of this service's deploy modes: a
# `railway up` run from gateway/ (source root = gateway/) and a repo build with
# Root Directory = /gateway. A relative "Dockerfile" was unambiguous for the
# upload and a coin-flip for the repo build — resolved against the REPO root it
# finds ./Dockerfile, the Next.js dashboard image, which would build and start
# and serve the wrong application on the domain packages/core, the CLI provider
# list and the website all point at. Naming no path cannot pick the wrong one.
#
# The matching trap is that Railway's config file does NOT follow the root
# directory: with none set explicitly it reads the REPO-ROOT railway.json, which
# is the web app's and carries no healthcheckPath — so the /healthz gate below
# would vanish silently and a gateway that boots broken would deploy green. The
# service therefore pins railwayConfigFile to /gateway/railway.json.
FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching.
#
# `ci`, AND THE LOCKFILE IS COMMITTED FOR IT. This ran `npm install` against a
# floating `viem: ^2.28.0` with no lockfile, so two builds of identical source
# could ship different viem — and lib/core.mjs takes verifyMessage from it,
# which is the signature check the whole holder gate rests on. That was a
# once-in-a-while lottery while this image was built by hand; repo-linked, it is
# drawn on every push. `npm ci` fails loudly on a lockfile out of sync with
# package.json, which is the failure you want at build time rather than a silent
# minor bump in the signature verifier.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

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
