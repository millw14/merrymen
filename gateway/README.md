# Merrymen AI gateway

The holder perk, done safely: a tiny server that lets **verified $MERRYMEN holders**
run their agent's brain with **no API key and no signup** — while your upstream key
stays server-side and never ships in the (open-source) client.

## Why a gateway (and not "just ship our key")

merrymen is open source and self-hosted. Any key baked into the package is readable
by everyone who installs it — it would be scraped and abused within hours, blow your
rate limits, and get banned. So the client never holds the key. Instead:

```
holder ──GET /nonce──▶ single-use challenge ──sign──▶ /claim ──balanceOf──▶ token ──▶ paste into merrymen
merrymen ──Bearer token──▶ /v1/chat/completions ──your key──▶ upstream LLM ──▶ reply
```

- The upstream key lives only in `MERRYMEN_GATEWAY_UPSTREAM_KEY` (env). Never logged, never sent to the client.
- Access tokens are **HMAC-signed and expiring** (stateless — no database).
- The claim uses a **server-issued, single-use, domain-bound nonce** (5-min TTL): the message a holder signs names the domain + a one-time nonce, so a captured signature **can't be replayed** or pre-collected, and responses carry **no wildcard CORS** so a phishing page can't read a minted token.
- Every request **re-checks the wallet's on-chain $MERRYMEN balance** (cached 10 min, bounded size), so a holder who sells loses access.
- **Per-address rate limit** on `/v1`, **per-IP rate limit** on `/nonce` + `/claim`, a hard completion clamp (`max_tokens` + `max_completion_tokens`, `n`/`best_of` pinned), and a body-size cap bound cost and abuse.
- The gateway **forces its own model** server-side — the client can't run up an expensive one and never even learns which model it is (it's branded `merrymen-fast`).

Signing is **read-only proof of control** — no transaction, no private key ever leaves the holder's wallet. Fully in keeping with merrymen's non-custodial stance.

## Discovery too: `POST /bitquery`

Same perk, same claimed token, second upstream. Set `MERRYMEN_GATEWAY_BITQUERY_KEY`
and holders get Bitquery — which indexes Robinhood Chain from genesis and decodes
**Uniswap v4**, where new pairs actually launch — without a Bitquery account of
their own. Leave it unset and the route returns 503; nothing else changes.

**This route does not proxy GraphQL, and that is the whole point.** Bitquery bills
by query cost and GraphQL is unbounded by construction: one caller asking for
every event since genesis, unfiltered, is a five-figure invoice against *your*
account. `max_tokens` was enough to bound the LLM route; there is no equivalent
knob here, because the expensive part *is* the query.

So the client sends a **name**, not a query:

```bash
curl -s https://merrymen-gateway-production.up.railway.app/bitquery \
  -H "authorization: Bearer mmk_…" \
  -H 'content-type: application/json' -d '{"query":"recentPools","variables":{"sinceMinutes":60,"limit":25}}'
```

- The catalogue in `lib/core.mjs` (`BITQUERY_QUERIES`) **is** the attack surface.
  Every query is written there, every variable is clamped there, and a caller can
  ask for nothing that isn't in it. `GET /bitquery` lists the names.
- Adding a capability is a deliberate edit by whoever runs the gateway.
- Discovery has its **own, tighter rate bucket** (`BITQUERY_RATE_PER_MIN`, 6/min
  per wallet) — it's polled by a worker on a timer, not driven by a human typing,
  so sharing the chat allowance would let a background feed starve the brain.
- Upstream error bodies are **not** relayed; they can quote the request, and the
  request carries your key on the way out.

`node selftest.mjs` asserts all of it offline: unsigned tokens rejected, raw and
hostile queries (including `__proto__`, `constructor`) rejected by name lookup,
503 when no key is configured, and the rate bucket biting.

## Which host is live right now

**`https://merrymen-gateway-production.up.railway.app`** — this is what the client
and the website actually call, and the only host with a working certificate.

`ai.merrymen.dev` is registered on the Railway service (domain `84ba7858`, edge
`edge-500b32d4`, targetPort 8080 — all correct), but **TLS fails, and this file
used to be wrong about why**. It said the DNS was correct and blamed an
unexplained Let’s Encrypt stall. The actual cause, from Railway’s own API:

```
status.verified    = false
certificateStatus  = CERTIFICATE_STATUS_TYPE_ISSUING   # since 2026-08-02, never advanced
verificationDnsHost = _railway-verify.ai               # _railway-verify.ai.merrymen.dev
```

**No certificate was ever issued, because ownership was never verified.** Railway
is waiting on a TXT record that does not exist — `_railway-verify.ai.merrymen.dev`
returns NXDOMAIN, authoritatively, from `ns1.vercel-dns.com`. With no per-domain
cert the edge falls back to `*.up.railway.app` for that SNI and every client
rejects the principal. Plain HTTP 301s, which is what made this look like a
routing success and a certificate mystery.

The sibling `app.merrymen.dev` is the control: same edge, same targetPort, and it
HAS `_railway-verify.app.merrymen.dev` — verified true, certificate VALID. The TXT
is the only difference.

**The fix is one DNS record, in Vercel (owner-only — nothing to change on
Railway):**

| name | type | value |
| --- | --- | --- |
| `_railway-verify.ai` | TXT | the `verificationToken` from Railway’s domain API |

Secondary, hygiene only: the `ai` CNAME points at `cslvpezy.up.railway.app` where
Railway now wants `aqeqwooj.up.railway.app`. Railway still reports that record
PROPAGATED and the dashboard shows it green, which is why it was never spotted —
and cert selection is edge-IP-independent, so aligning it does **not** fix TLS on
its own.

Don’t point anything at it until `curl https://ai.merrymen.dev/healthz` returns
`{"ok":true}`.

When it does land, three hand-written copies of the host have to move together:

| where | constant |
| --- | --- |
| `packages/core/src/token.ts` | `MERRYMEN_GATEWAY_ORIGIN` — the merrymen client |
| `site/lib/gateway.ts` | `GATEWAY_ORIGIN` — the memescope page |
| `cli/bin.mjs` | the `merrymen` provider's `key` hint, shown during onboarding |

There is no shared import that could enforce that: the website doesn't compile
the TS core and the CLI is plain ESM that can't import TypeScript at all. So
`worker/src/gateway-origin.test.ts` fails the suite if the three ever disagree —
run `npm test` after changing any of them.

## Two ways to run it

The security logic lives once in `lib/core.mjs`; two thin runtimes wrap it:
`server.mjs` (a long-lived process) and `api/*.js` (Vercel serverless functions).
Point the client's host at whichever you pick.

### A) Persistent process (Railway / Fly / Render / VPS / Docker) — RECOMMENDED

```bash
cd gateway
cp .env.example .env      # fill in UPSTREAM_KEY, SECRET, RPC (+ BITQUERY_KEY for discovery)
npm install
npm run check             # offline self-test (tokens, single-use nonces, replay, /bitquery)
npm start                 # listens on :8787
```

**Railway**, concretely — `railway.json` is committed, so it builds from the
Dockerfile and health-checks `/healthz`:

```bash
railway init && railway up
```

That is the path for a **fresh** install, and it is still the fallback if a repo
build ever goes wrong. The live `merrymen-gateway` service no longer uses it:
it is sourced from `millw14/merrymen` on `main` and redeploys itself when
anything under `gateway/` changes. Three service settings make that work, and
each of them fails silently if it is missing — `docs/hosted-deploy.md` §5b has
the table and the reasoning:

| | |
|---|---|
| Root Directory | `/gateway` |
| Config-as-code path | `/gateway/railway.json` |
| Watch Paths | `/gateway/**` |

Deploying by hand is what let this service sit several commits behind `main`
while a fix looked shipped, so prefer a push. If you must, `railway up` from
**this directory** — never from the repo root, which would upload the whole
monorepo and build the dashboard image into this service.

Then set the variables in the Railway dashboard (**not** in the repo):
`MERRYMEN_GATEWAY_UPSTREAM_KEY`, `MERRYMEN_GATEWAY_SECRET` (32+ random bytes),
`MERRYMEN_GATEWAY_RPC`, `MERRYMEN_GATEWAY_BITQUERY_KEY`, and
`MERRYMEN_GATEWAY_DOMAIN` set to the host you actually serve on. Point
`ai.merrymen.dev` at the Railway service.

A single process needs no Redis — the in-memory store is correct and atomic for
one instance. **If you scale past one replica, set `KV_REST_API_URL`/`TOKEN`**,
or nonce single-use and rate limits become per-instance and stop meaning what
they say.

A `Dockerfile` (universal) and `render.yaml` (Render Blueprint) are included for a
connect-the-repo deploy. In-memory state is fine here (one process); set
`KV_REST_API_URL`/`KV_REST_API_TOKEN` only if you run multiple instances.

### B) Vercel serverless (the `ai.merrymen.dev` domain already points at Vercel)

Serverless isolates don't share memory, so the nonce/rate-limit/balance state MUST
live in a KV store — this is a hard requirement (the functions refuse to start
without it). `vercel.json` maps the clean URLs (`/nonce`, `/claim`, `/v1/…`) to the
functions in `api/`.

1. Vercel → **New Project** → import `millw14/merrymen`, set **Root Directory = `gateway`**.
2. Add a KV store: Vercel dashboard → **Storage → Upstash Redis** (or KV). It sets
   `KV_REST_API_URL` + `KV_REST_API_TOKEN` on the project automatically.
3. Add the three secrets as env vars: `MERRYMEN_GATEWAY_UPSTREAM_KEY`,
   `MERRYMEN_GATEWAY_SECRET` (≥32 bytes), `MERRYMEN_GATEWAY_RPC` (+ optional
   `MERRYMEN_GATEWAY_DOMAIN=ai.merrymen.dev`).
4. **Deploy.** Confirm against the host Vercel gives you:
   `curl https://<your-deployment>/healthz` → `{"ok":true}`. Only add
   `ai.merrymen.dev` once its certificate actually issues — see the status note
   above; today that domain fails TLS and would take the gateway down with it.

### Endpoints
- `GET /` or `/claim` — the claim page (holder connects wallet, signs, gets a token).
- `GET /nonce?address=0x…` — mint a single-use, domain-bound challenge → `{nonce, message}` (sign `message` verbatim).
- `POST /claim` — `{address, signature, nonce}` → `{token, expiresInDays}` after nonce + signature + balance checks.
- `POST /v1/chat/completions` — OpenAI-compatible; `Authorization: Bearer <token>`. This is what merrymen calls.
- `GET /healthz` — liveness.

## The holder experience

1. Holder opens `https://ai.merrymen.dev/claim`, connects their wallet, signs (free).
2. Gateway checks they hold ≥ `MERRYMEN_GATEWAY_MIN_TOKENS` and returns a key.
3. In merrymen → **Settings → AI provider → Merrymen AI**, they paste the key. Done — chat + the strategist now run on your dime, no third-party signup.

## Costs & limits (read before you flip it on)

You are paying for holders' inference. Protect yourself:
- Keep `MERRYMEN_GATEWAY_MIN_TOKENS` meaningful, and `RATE_PER_MIN` / `MAX_COMPLETION_TOKENS` conservative (defaults in `lib/core.mjs`).
- Groq's **free tier is per-key rate-limited** — a shared free key will throttle fast under many holders. Use a paid plan, or expect holders to queue.
- State (nonces, rate limits, balance cache) lives in `lib/store.mjs`: in-memory for a single process, or a shared KV (Upstash/Vercel KV) when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are set. On serverless the KV is **required** (isolates don't share memory), so rate limits and single-use nonces hold across invocations.
- Rotating `MERRYMEN_GATEWAY_SECRET` invalidates every issued token (your kill-switch).

## Honesty note

Call the *provider* "Merrymen AI" freely — white-labeling inference is normal. Just
don't imply you trained a model; the blurb ("powers your agent's brain") stays true.
