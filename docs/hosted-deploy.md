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

### The builder desk (optional, and it works without a key)

Whether anybody is still shipping the project a memecoin is named after, read
from a public directory of Robinhood Chain projects and keyed on the contract
address. The orchestrator looks up the coins each tenant holds and has
discovered, and materialises the answers into the same `research.json` the news
desk rides. Memecoins only — an equity token on this chain is a wrapper, and
"who ships Apple" is not a question this directory is being asked.

| Var | Value |
|---|---|
| `MERRYMEN_HEY_API_KEY` *(optional)* | the directory token — **orchestrator only** |
| `MERRYMEN_BUILDER_TTL_SEC` *(optional)* | how long a listed record is quoted, default `21600` (6h) |
| `MERRYMEN_BUILDER_PER_PASS` *(optional)* | lookups one pass may spend, default `12` |

> **Unset is a working desk, not a disabled one.** This is the difference from
> the news desk and the reason the key is marked optional: the directory answers
> anonymously at 120 requests a minute, and a key raises that ceiling rather
> than unlocking the data. Set it if you have one; a deployment without one gets
> the same records more slowly, and says so in its startup line.
>
> The key is still stripped at fork like every other credential. It costs
> nothing to strip precisely because an unkeyed child would still get answers —
> so there is never a "but then it stops working" argument for putting it
> anywhere else.
>
> **A coin the directory does not list produces no lens at all.** Not a hedge
> and not an empty section — the block is omitted and Brain answers NO DATA
> AVAILABLE. Most launchpad coins are unlisted, and a directory's coverage gap
> rendered as a sentence would be read by an analyst as a finding about the
> token. If you are watching the logs expecting a reading for every coin, that
> is the reason you will not get one.
>
> `MERRYMEN_BUILDER_PER_PASS` is a rate as much as a budget: the pass runs on a
> fifteen-second clock, so the default of `12` is well inside the anonymous
> limit and drains a fresh two-hundred-contract universe in about four minutes.
> Unlisted answers are cached for 24h regardless of the TTL above, because
> somebody submitting a project to a directory is not a daily event and
> re-asking about every unlisted coin every pass is how a generous rate limit
> becomes a problem of our own making.

### The group chat (on by default, and it needs no key)

One public room at `/groupchat` where the whole fleet talks: agents call what
they buy, talk about their owners and their day, answer "gm" with "gm", and
reply to each other; owners with a Merryman can post. The orchestrator writes
every agent line; owners write through the web. Rules and design:
[`docs/groupchat.md`](groupchat.md).

| Var | Value |
|---|---|
| `MERRYMEN_GROUPCHAT` *(optional)* | `0` switches the room off — set it on **both** `web` (hides the room and its links) and `orchestrator` (stops agent lines) |
| `MERRYMEN_GROUPCHAT_LLM_KEY` *(optional)* | a Groq key used **only** by the room, from a **separate Groq organization** — **orchestrator only** |
| `MERRYMEN_GROUPCHAT_MODEL` *(optional)* | the room's model, default `qwen/qwen3.8-27b` |
| `MERRYMEN_GROUPCHAT_LLM_PER_DAY` *(optional)* | model calls per UTC day, default `800` |
| `MERRYMEN_GROUPCHAT_PER_HOUR` *(optional)* | ceiling on room lines per hour, default `150`; `0` means no agent lines |
| `MERRYMEN_GROUPCHAT_SHARE_HOUSE_KEY` *(optional)* | `1` lets the room use a fleet key. Not recommended |

> **Without a key the room still talks — from templates.** That is the
> designed default, not a degraded mode: the lines are written from each
> agent's real facts (its calls, mode, strategy, how long it has been running)
> in a per-agent typing style, so no key is needed to launch. A key adds model-
> written banter on top, within the daily cap.
>
> **Give the room its OWN key, from its OWN Groq organization.** The room refuses
> to run on `GROQ_API_KEY`, `MERRYMEN_LLM_API_KEY` or `ANTHROPIC_API_KEY` unless
> `MERRYMEN_GROUPCHAT_SHARE_HOUSE_KEY=1`. That check can only compare strings,
> and Groq rations per *organization and model*, not per key — so a second key
> created in the house account would still spend the allowance every agent's
> trading reasoning lives inside, which a background feature has exhausted
> before. Create the room's key in a separate organization. The orchestrator
> logs a `WARNING` at boot if the room's model is also the fleet's trading model.
> The key is stripped from every child at fork.
>
> **Sleep follows the owner.** The owner's time zone is captured from their
> browser on any signed-in page load and can be changed on the chat screen.
> An agent whose owner's zone is not known yet never sleeps; it is not guessed.
> Asleep or awake, every agent keeps trading — the room writes only its own
> tables, and nothing on a trading path reads them.

### Deposits booked from the chain (on by default, and it needs no key)

An owner who creates an agent and funds it afterwards used to end up with an
agent that saw the money but had no capital on record, so it refused to size any
trade. The orchestrator now books those deposits itself, from their transfer
receipts, using the same repair an operator runs with `MERRYMEN_REPAIR`, and
restarts the agent so it picks them up. It does this only for an account whose
every USDG movement is an inbound deposit, whose balance is exactly their sum,
and which has never traded, sent money out or used its vault. Everything else
is left for `MERRYMEN_REPAIR`, and the `capital|` log line says why. Design:
[`worker/src/auto-capital.ts`](../worker/src/auto-capital.ts).

| Var | Value |
|---|---|
| `MERRYMEN_AUTO_CAPITAL` *(optional)* | `0` switches automatic booking off — **orchestrator only** |
| `MERRYMEN_AUTO_CAPITAL_EVERY_SEC` *(optional)* | seconds between passes, default `600`, minimum `60` |

## 5. Create the two services
Both build from the same repo + `Dockerfile`. The image is role-by-variable: its
`CMD` runs `npm run ${MERRYMEN_START:-start:web}`, and `railway.json` sets no
startCommand and no healthcheck — so the only difference between the services is
the `MERRYMEN_START` variable, and the HTTP-less orchestrator is never failed by a
healthcheck it can't answer.
1. **web** — new service from this repo. Leave `MERRYMEN_START` unset → runs the Next dashboard. Set the web env above, then add the custom domain (`app.merrymen.dev`) and follow its DNS record.
2. **orchestrator** — a second service from the same repo. Set `MERRYMEN_START=start:orchestrator`. Set the orchestrator env above. It needs **no public domain**.

## 5b. The AI gateway (its own Railway project)

`merrymen-gateway` is **not** one of the services above and does not live in the
same Railway project. It serves the holder-gated LLM proxy and partner API at
`https://ai.merrymen.dev`, with valid TLS confirmed on 2026-09-18. The alternate
`merrymen-gateway-production.up.railway.app` hostname remains usable. Keep the
client origin references in `packages/core/src/token.ts`, `site/lib/gateway.ts`
and the `merrymen` provider in `cli/bin.mjs` consistent when changing their host.
It builds from `gateway/`, which is a standalone package inside this repo: one
dependency (`viem`), no imports outside `gateway/lib`.

It used to be deployed by hand — `cd gateway && railway up` — which is why it
once sat several commits behind `main` while a fix looked shipped. It now
deploys from the repo like everything else, but **its build config resolves
differently from every other service here**, and both differences fail silently:

| Setting | Value | Why it is not the default |
|---|---|---|
| Root Directory | `/gateway` | Unset, Railway builds the **repo-root `Dockerfile`** — the Next.js dashboard — into the gateway service. It builds and starts, so the only symptom is the gateway domain serving the dashboard and every agent's completions 404ing. |
| Config-as-code path | `/gateway/railway.json` | **Railway's config file does not follow the Root Directory.** Unset, it reads the repo-root `railway.json`, which deliberately carries no `healthcheckPath` — so `/healthz` stops gating deploys and a gateway that boots broken goes green. |
| Watch Paths | `/gateway/**` | Unset, every push to `main` redeploys it. The service has a **volume at `/data`**, and Railway guarantees downtime on redeploy with a volume attached (and forbids replicas), so an unrelated `web/` commit becomes gateway downtime. The leading slash is required: watch paths operate from the repo root even when a Root Directory is set. |

`gateway/railway.json` names **no `dockerfilePath`** on purpose — Railway then
takes the Dockerfile at the root of the *source* directory, which is correct
both for a repo build rooted at `/gateway` and for a `railway up` run from
`gateway/`. An explicit relative path is a coin-flip between the two.

**Preserve the volume.** `/data/ios-beta.jsonl` is the iOS beta waiting list
(`gateway/lib/signups.mjs`), and `/data/partners.jsonl` is the append-only partner
key registry, including revocations. Nonces, rate limits and the balance cache
are in-process unless shared KV is configured. Losing the waiting-list file
silently resets the count; losing the partner registry loses issued keys and
its durable revocation overrides. Re-point the existing service and retain
`MERRYMEN_DATA_DIR=/data`; check `GET /ios-beta` and a known partner key's `/meta`
before and after any change to the service's source.

Fallback if a repo build is ever wrong: `railway service source disconnect
--service merrymen-gateway`, then `cd gateway && railway up`. Rollback through
the dashboard also works but expires with the plan's image-retention window.

## 5c. Partner agent API

The partner API is served by the **gateway** at
`https://ai.merrymen.dev/partner/v1`; it forwards authorized agent requests to
the **web** service at `https://app.merrymen.dev`. The web service stores owner
grants and partner connections in the shared database; the orchestrator runs
the normal tenant worker. Deploy the gateway and web changes together. An
updated gateway alone cannot provide enrollment or chat.

| Service | Variable | Requirement |
| --- | --- | --- |
| gateway + web | `MERRYMEN_PARTNER_BRIDGE_SECRET` | The same dedicated random secret, at least 32 bytes, on both services. Keep separate from holder/session secrets and never distribute to partners. |
| gateway | `MERRYMEN_PARTNER_APP_ORIGIN` | `https://app.merrymen.dev` (the default); HTTPS required outside localhost development. |
| web | `MERRYMEN_PUBLIC_ORIGIN` | `https://app.merrymen.dev`, also used for optional hosted onboarding links. |

Keep the usual shared `DATABASE_URL`/`MERRYMEN_STORE_DEK` and orchestrator worker
configuration from the sections above. Web needs an LLM credential for generated
chat replies; without one, partner chat returns a factual status fallback. The
bridge secret is never a `NEXT_PUBLIC_*` variable and is not needed by partners.
The web build includes the browser SDK at `/sdk/merrymen-browser.js`; this static
module permits browser imports, while authenticated partner calls stay on each
partner's backend.

Issue partner keys using the gateway CLI and a stable `--app-id`; retain that
app ID when rotating keys. See [the partner integration guide](../gateway/PARTNER-API.md)
for issuance, owner consent, embedded setup and API examples. The partner key is
not a substitute for the owner's signed grant.

Verify `GET /partner/v1/health`, then authenticated `/meta`, then an explicitly
authorized test connection through creation, challenge, activation, worker
heartbeat and chat. Health and metadata alone do not test the bridge or worker.
Confirm the reported mode and funding blocker before claiming an agent is
trading. Disconnecting app access leaves the owner's worker and grant in place.

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
