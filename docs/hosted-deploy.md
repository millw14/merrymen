# Deploying hosted merrymen on Railway (testnet slice)

The hosted stack is **three Railway pieces from one repo**:

| Piece | What it is | Start command |
|---|---|---|
| **web** | the Next.js dashboard + API (SIWE auth, grant/settings intake) | `npm run start:web` (the image default) |
| **orchestrator** | the process-per-tenant supervisor (spawns one worker child per tenant) | `npm run start:orchestrator` |
| **Postgres** | the shared grant + settings store | Railway's managed Postgres plugin |

Both services build from the **same `Dockerfile`** (one image, two start commands). Every secret is injected at **runtime** by Railway — nothing is baked into the image.

---

## 1. Provision Postgres
Add Railway's **Postgres** plugin to the project. It exposes `DATABASE_URL`; reference it from both services (Railway's `${{Postgres.DATABASE_URL}}`). The grant/settings tables are created on first use — no migration step for the slice.

## 2. Generate the two server secrets
Run locally and keep the output safe (a password manager, not a file in the repo):

```bash
# MERRYMEN_SESSION_SECRET — signs session cookies + auth nonces (>= 32 chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# MERRYMEN_STORE_DEK — the 32-byte data-encryption key that seals session keys
# and settings at rest (base64). web SEALS with it, the orchestrator UNSEALS.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 3. House keys (testnet)
The orchestrator injects these into each child; a tenant never sets them (they are stripped server-side). For the testnet slice:
- **Bundler** — `MERRYMEN_BUNDLER_API_KEY` (a **Pimlico** key). The worker builds the URL per chain as `https://api.pimlico.io/v2/<chainId>/rpc?apikey=…`; Pimlico supports Robinhood testnet **46630** (listed as `robinhood-testnet`). Get a key at <https://dashboard.pimlico.io> (free tier is fine for the slice). Alternatively set `MERRYMEN_BUNDLER_URL` to a full 4337 RPC from any bundler that supports 46630.
- **RPC** — `MERRYMEN_RPC_TESTNET`. The public endpoint is **`https://rpc.testnet.chain.robinhood.com`** (already the chain's built-in default in `packages/core/src/chain.ts`; set it explicitly, or point at a private endpoint for reliability). `MERRYMEN_RPC_MAINNET` = `https://rpc.mainnet.chain.robinhood.com` for 4663 later.
- **LLM** (optional, for the strategist) — `GROQ_API_KEY` (free tier) or `ANTHROPIC_API_KEY`.
- **Gas** — by default the smart account self-pays, so each armed tenant's smart account needs testnet ETH on 46630 from the Robinhood Chain faucet (see <https://docs.robinhood.com/chain/>). Set `MERRYMEN_SPONSOR_GAS=1` on the **orchestrator** and the house pays instead, out of the same Pimlico account as the bundler — tenants then fund USDG only. Two things to know before flipping it:
  - **Nothing in this repo caps cumulative spend.** The clamps bound a single operation (`PAYMASTER_GAS_MAX`, `GAS_BOUNDS.absoluteMax`), not a month. The **Pimlico sponsorship policy is the only real limit**, so create one scoped to the chain with per-sender and monthly caps and put its id in `MERRYMEN_SPONSORSHIP_POLICY_ID`. Without a policy id `paymasterContext` is undefined and sponsorship is unpoliced.
  - **Withdrawal is never sponsored.** The recovery path pays its own fee out of the balance it is sweeping, so an account still needs a little ETH to get money back OUT. Every screen that mentions sponsorship says so; do not remove that caveat.

## 4. Environment, per service

**Shared (both web and orchestrator):**
| Var | Value |
|---|---|
| `MERRYMEN_HOSTED` | `1` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `MERRYMEN_STORE_DEK` | the base64 DEK from step 2 |

**web only:**
| Var | Value |
|---|---|
| `MERRYMEN_SESSION_SECRET` | the secret from step 2 |
| `MERRYMEN_PUBLIC_ORIGIN` | the web service's public URL, e.g. `https://merrymen.up.railway.app` — auth binds signatures to it |
| `PORT` | set by Railway automatically; `start:web` honours it |
| `GROQ_API_KEY` *(or `ANTHROPIC_API_KEY`)* | **the dashboard chat's brain.** Not optional if you want the chat to think — see below |

> **The chat needs a key on the WEB service, not just the orchestrator.**
> `/api/chat` resolves a model from the web container's own environment, so
> without one the agent can only answer the exact commands (`/status`,
> `/positions`, `/pnl`) and says so. This is easy to get wrong because it looks
> like an unbuilt feature rather than a missing variable: the route is real, the
> prompt is real, and the only thing absent is the key. The same key may be used
> on both services.

**orchestrator only** (the house keys from step 3):
| Var | Value |
|---|---|
| `MERRYMEN_START` | `start:orchestrator` — selects the supervisor role of the shared image (web leaves this unset) |
| `MERRYMEN_BUNDLER_API_KEY` *(or `MERRYMEN_BUNDLER_URL`)* | Pimlico key / full bundler URL |
| `MERRYMEN_RPC_TESTNET` | `https://rpc.testnet.chain.robinhood.com` (or a private endpoint) |
| `MERRYMEN_SPONSOR_GAS` *(optional)* | `1` to pay tenants' trading gas from the house Pimlico account. Off by default. |
| `MERRYMEN_SPONSORSHIP_POLICY_ID` *(with the above)* | Pimlico policy id (`sp_…`) — where the real spend limits live |
| `GROQ_API_KEY` *(optional)* | strategist brain |

> The orchestrator must NOT get `MERRYMEN_SESSION_SECRET`. The web service needs no BUNDLER or RPC key — it signs nothing — but it does need its own LLM key for the dashboard chat, as above. The DEK is the one secret both hold. Children get the house keys but never the DEK / session secret / `DATABASE_URL` (the supervisor strips them at fork).
>
> `MERRYMEN_SPONSOR_GAS` goes on the **orchestrator only**, and deliberately so. The dashboard does not read it: the worker reports whether it is sponsoring on its heartbeat, and the web service believes that report. Setting it on web would do nothing, and an earlier design where web resolved it for itself could have shown "fees are covered" while the child refused every trade — the two services have separate environments.

## 4b. The research browser (optional, but it is what makes an agent read)

A THIRD service, from the same repo, built from `Dockerfile.browser` — a real
Chromium in its own image. It is separate on purpose: Chromium adds ~400MB to
whatever image carries it, and the orchestrator spawns one worker per tenant, so
a browser inside the worker would be a browser per tenant.

| Var | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.browser` |
| `PORT` | `8080` — pinned so the private address below is stable |
| `MERRYMEN_BROWSER_TOKEN` | a fresh 32-byte secret, shared with the orchestrator |

> **`railway.json` must NOT pin `dockerfilePath`.** It is shared by every
> service, and an explicit path there beats the per-service
> `RAILWAY_DOCKERFILE_PATH` — so the browser service silently builds the main
> image and comes up running the DASHBOARD. The symptom is a browser service
> whose logs say `next start`. With no path in `railway.json` the builder
> defaults to `./Dockerfile`, which is what web and the orchestrator want.

**Give it no public domain.** It is a URL-fetching machine; exposed, it is an
open proxy anyone could point at `*.railway.internal`. It binds the private
network and requires the shared token, and the SSRF guard runs on both sides.

Then on the **orchestrator**:

| Var | Value |
|---|---|
| `MERRYMEN_BROWSER_URL` | `http://merrymen-browser.railway.internal:8080` |
| `MERRYMEN_BROWSER_TOKEN` | the same secret |
| `MERRYMEN_DESK` *(optional)* | `1` — let the strategist research before deciding |
| `MERRYMEN_DESK_MAX_STEPS` *(with the above)* | model calls per window, default 4 |

> `MERRYMEN_DESK` costs several model calls per decision window instead of one.
> Raise `MERRYMEN_LLM_INTERVAL_MIN` with it — the scout consumed an entire
> day's shared token allowance on 2026-08-31 and took user chat down with it.

### The news desk (optional)

External news for the equity instruments the fleet holds and watches. The
orchestrator fetches, caches and materialises it into each child's home; a child
never calls the provider and never holds the token.

| Var | Value |
|---|---|
| `MERRYMEN_MARKETAUX_API_KEY` | the provider token — **orchestrator only** |
| `MERRYMEN_MARKETAUX_DAILY_LIMIT` *(optional)* | requests the plan allows per day, default `100` |
| `MERRYMEN_MARKETAUX_LIMIT` *(optional)* | articles one request may return, default `3` (the free tier's ceiling) |
| `MERRYMEN_MARKETAUX_WINDOW_SEC` *(optional)* | refresh interval; derived from the allowance when unset |

> **Put the key on the orchestrator and nowhere else.** `CHILD_SECRET_STRIP`
> removes it at fork, alongside the DEK, the session secret and `DATABASE_URL`,
> so no tenant worker and no Brain prompt can contain it. Setting it on `web` or
> on the Brain service does nothing except create a credential that did not need
> to exist.
>
> The refresh window is DERIVED from the allowance so it lasts a whole day —
> at `100`/day that is roughly a sixteen-minute desk. Setting
> `MERRYMEN_MARKETAUX_WINDOW_SEC` overrides that and is the one way to spend the
> allowance before the day ends; the desk then reports `budget-exhausted` rather
> than quietly reporting no news.
>
> `MERRYMEN_MARKETAUX_LIMIT` also caps how many symbols one request may name,
> and that is deliberate: asking about eight symbols on a tier that returns three
> stories means five symbols come back empty, and a symbol we could not hear
> about must be reported as *not asked*, never as *quiet*.

## 5. Create the two services
Both build from the same repo + `Dockerfile`. The image is role-by-variable: its
`CMD` runs `npm run ${MERRYMEN_START:-start:web}`, and `railway.json` sets no
startCommand and no healthcheck — so the only difference between the services is
the `MERRYMEN_START` variable, and the HTTP-less orchestrator is never failed by a
healthcheck it can't answer.
1. **web** — new service from this repo. Leave `MERRYMEN_START` unset → runs the Next dashboard. Set the web env above, then add the custom domain (`app.merrymen.dev`) and follow its DNS record.
2. **orchestrator** — a second service from the same repo. Set `MERRYMEN_START=start:orchestrator`. Set the orchestrator env above. It needs **no public domain**.

## 6. Deploy & verify
- Web comes up at `MERRYMEN_PUBLIC_ORIGIN`; `GET /api/version` returns 200.
- Open the dashboard, **sign in** (SIWE — your wallet signs a free challenge), create/**sign a testnet grant** (session-key-only; the owner key never leaves your browser).
- The orchestrator logs `... spawned (pid …)` for your tenant within ~15s and writes `children/<you>/grant.json` (session key only) + `settings.json`.
- **Fund** the smart account on testnet (ETH for gas). The child arms and trades on 46630.

## 7. Known limits of the slice (closed in Phase B)
- **The dashboard feed now reads the shared Postgres** — the ledger→Postgres port (B2) has landed, so `/api/feed` and `/api/scoreboard` show a child's live numbers in hosted mode. (`pg` is a runtime-only dependency the `Dockerfile` installs into the image; it is deliberately absent from `package.json` so self-hosted stays lean.)
- **Telegram + `merrymen export` are still SQLite-only.** The Telegram read commands (`/status`, `/pnl`, `/trades`, `/report`), the trade-ping notifier, the Virtuals streamer, and the audit CLI still open a child's local SQLite file, so they read **empty** on a hosted deploy (blind, never another tenant's data — every content query is agent-scoped). Trading, the wall, and the dashboard are unaffected; routing these readers through the Postgres driver is A6/Telegram-multi-tenant. Watch the child logs for Telegram until then.
- **Keep web at ONE replica.** Auth nonces are in-memory; multiple web replicas would let a nonce replay across them. Multi-replica needs the KV-backed nonce store (B4/Railway hardening).
- **Single orchestrator replica.** The per-tenant Postgres advisory lease (so two orchestrators never both trade a tenant) is Phase B; run exactly one orchestrator until it lands.
- **Testnet only.** Before real funds: the mainnet re-audit + a two-funded-tenant testnet run (see `docs/hosted-platform-plan.md`).
