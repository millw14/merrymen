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

## Two ways to run it

The security logic lives once in `lib/core.mjs`; two thin runtimes wrap it:
`server.mjs` (a long-lived process) and `api/*.js` (Vercel serverless functions).
Point the client's domain — `https://ai.merrymen.dev` in the shipped provider
(`packages/core/src/llm-providers.ts` → the `merrymen` entry) — at whichever you pick.

### A) Persistent process (Railway / Fly / Render / VPS / Docker)

```bash
cd gateway
cp .env.example .env      # fill in UPSTREAM_KEY, SECRET, RPC
npm install
npm run check             # offline self-test (token scheme + single-use nonce + replay protection)
npm start                 # listens on :8787
```

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
4. **Deploy.** Then add the custom domain `ai.merrymen.dev` (the DNS is already on
   Vercel) and confirm: `curl https://ai.merrymen.dev/healthz` → `{"ok":true}`.

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
