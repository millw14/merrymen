# Merrymen AI gateway

The holder perk, done safely: a tiny server that lets **verified $MERRYMEN holders**
run their agent's brain with **no API key and no signup** — while your upstream key
stays server-side and never ships in the (open-source) client.

## Why a gateway (and not "just ship our key")

merrymen is open source and self-hosted. Any key baked into the package is readable
by everyone who installs it — it would be scraped and abused within hours, blow your
rate limits, and get banned. So the client never holds the key. Instead:

```
holder ──sign──▶ /claim ──balanceOf──▶ issues token ──▶ paste into merrymen
merrymen ──Bearer token──▶ /v1/chat/completions ──your key──▶ upstream LLM ──▶ reply
```

- The upstream key lives only in `MERRYMEN_GATEWAY_UPSTREAM_KEY` (env). Never logged, never sent to the client.
- Access tokens are **HMAC-signed and expiring** (stateless — no database).
- Every request **re-checks the wallet's on-chain $MERRYMEN balance** (cached 10 min), so a holder who sells loses access.
- **Per-address rate limit + a hard `max_tokens` clamp + body-size cap** bound cost and abuse.
- The gateway **forces its own model** server-side — the client can't run up an expensive one and never even learns which model it is (it's branded `merrymen-fast`).

Signing is **read-only proof of control** — no transaction, no private key ever leaves the holder's wallet. Fully in keeping with merrymen's non-custodial stance.

## Run it

```bash
cd gateway
cp .env.example .env      # fill in UPSTREAM_KEY, SECRET, RPC
npm install
npm run check             # offline self-test (token scheme + claim-message parity)
npm start                 # listens on :8787
```

Then host it on any always-on box (Railway, Fly, Render, a small VPS) behind HTTPS at
the domain you point the client at — `https://ai.merrymen.dev` in the shipped provider
(`packages/core/src/llm-providers.ts` → the `merrymen` entry). Change that `baseUrl`
+ `keyUrl` if you use a different domain.

### Endpoints
- `GET /` or `/claim` — the claim page (holder connects wallet, signs, gets a token).
- `POST /claim` — `{address, signature}` → `{token, expiresInDays}` after a balance check.
- `POST /v1/chat/completions` — OpenAI-compatible; `Authorization: Bearer <token>`. This is what merrymen calls.
- `GET /healthz` — liveness.

## The holder experience

1. Holder opens `https://ai.merrymen.dev/claim`, connects their wallet, signs (free).
2. Gateway checks they hold ≥ `MERRYMEN_GATEWAY_MIN_TOKENS` and returns a key.
3. In merrymen → **Settings → AI provider → Merrymen AI**, they paste the key. Done — chat + the strategist now run on your dime, no third-party signup.

## Costs & limits (read before you flip it on)

You are paying for holders' inference. Protect yourself:
- Keep `MERRYMEN_GATEWAY_MIN_TOKENS` meaningful, and `RATE_PER_MIN` / `MAX_COMPLETION_TOKENS` conservative (edit in `server.mjs`).
- Groq's **free tier is per-key rate-limited** — a shared free key will throttle fast under many holders. Use a paid plan, or expect holders to queue.
- The in-memory rate limiter is **per instance**. If you run multiple instances, back it (and the balance cache) with Redis/Upstash — otherwise limits are per-replica.
- Rotating `MERRYMEN_GATEWAY_SECRET` invalidates every issued token (your kill-switch).

## Honesty note

Call the *provider* "Merrymen AI" freely — white-labeling inference is normal. Just
don't imply you trained a model; the blurb ("powers your agent's brain") stays true.
