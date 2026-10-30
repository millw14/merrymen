# Deploying hosted merrymen on Railway (testnet slice)

The hosted stack is **three Railway pieces from one repo**:

| Piece | What it is | Role (`MERRYMEN_START`) |
|---|---|---|
| **web** | the Next.js dashboard + API (SIWE auth, grant/settings intake) | `start:web` (the image default: leave it unset) |
| **orchestrator** | the process-per-tenant supervisor (spawns one worker child per tenant) | `start:orchestrator` |
| **Postgres** | the shared grant + settings store | Railway's managed Postgres plugin |

Both services build from the **same `Dockerfile`** (one image, a role per service). Every secret is injected at **runtime** by Railway — nothing is baked into the image.

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
| `MERRYMEN_SOLANA` | **leave unset.** Solana stays off in production until its release gates are signed off; see [Solana (off in production)](#solana-off-in-production) |

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
>
> Its restart policy is shared the same way: `ON_FAILURE` with up to 10
> restarts, for web, orchestrator, browser and brain alike. Config-as-code
> overrides the dashboard's restart setting, so a change belongs in the file,
> not the service, and it changes all four at once, the trading orchestrator
> included. The reply listener spent those ten restarts in one day on
> 2026-10-05; it now exits non-zero only on a fleet-wide refusal, where a
> restart cannot help (docs/recovery-replies.md), so the cap is unchanged.
> Raising it is a separate decision, and Railway allows more than 10 only on
> paid plans. Railway's documentation says existing `railway.json` files keep
> working until 2026-12-01: whatever replaces this file must carry the
> restart policy and the "no `dockerfilePath`" rule above with it.

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

### CoinGecko Pro pacing (optional; unset keeps the old 3-second pace)

How fast the Pro key (`MERRYMEN_COINGECKO_PRO_API_KEY`, read by the
orchestrator's children, by the orchestrator itself for X answers' research,
whose CoinGecko and index reads share the children's fleet lane, and by web)
may spend. Both services read the same two
names; set them on each. With a monthly figure set, a spacing below the floor
that figure allows is raised to it (fleet lane 70% of the month, web 20%, 10%
headroom), and said once at startup. On web, setting either one also paces
the chart reads, which stay unpaced while both are unset. Details and the arithmetic:
[`docs/decision-research.md`](decision-research.md#coingecko-pro-pacing).

| Var | Service | Default | Production (the ~5,000,000-credit plan) |
|---|---|---|---|
| `MERRYMEN_COINGECKO_PRO_SPACING_MS` | orchestrator (children inherit it) | `3000` | `800` (floor 741 ms) |
| `MERRYMEN_COINGECKO_MONTHLY_CREDITS` | orchestrator (children inherit it) | unset: no credit floor | `5000000` |
| `MERRYMEN_COINGECKO_PRO_SPACING_MS` | web | `3000` | `2600` (floor 2,592 ms) |
| `MERRYMEN_COINGECKO_MONTHLY_CREDITS` | web | unset: no credit floor | `5000000` |

Look for one `[gecko] coingecko-pro fleet lane: 800 ms spacing …` line per
child and one `local lane: 2600 ms` line on web. A `[gecko] coingecko-pro
refused <family> … for 1h` line means that endpoint is not on the plan, or the
key is wrong; latches are per key, so a corrected key and a restart clear them.

### Decision research for chosen accounts (optional; nobody by default)

`MERRYMEN_DECISION_RESEARCH_ACCOUNTS` on the **orchestrator** (children
inherit it): complete smart-account addresses, comma- or space-separated,
default nobody. Add the account through the deploy environment; this
repository names none. For those accounts' live fast-Trencher entry reviews it
adds cost quotes, the account's own outcomes, the momentum plan, the
Trencher's terms as trusted desk policy (once the Brain service advertises
`strategy-terms`) and, with the Bitquery lane below on, the coin's indexed
flow (once the Brain lists `onchain-flow`). Research inputs only: no cap,
guard, grant or exit changes. See
[`docs/decision-research.md`](decision-research.md#opt-in-decision-evidence).
Deploy the Brain service from the same commit for the last two.

### The Bitquery lane (optional; off without its key)

DEX flow for a coin over 5, 15 and 60 minutes, the venue split, the largest
sells, and whether its launcher (as the launchpad's launch record names it)
sold. The orchestrator answers from one budgeted lane, and children on the
decision-research allowlist ask it over IPC (the channel exists only with
`MERRYMEN_FOMO_ENABLED=1`). For the rollout steps and the IDE check to run
before setting the key, see [`docs/bitquery-lane.md`](bitquery-lane.md). The
gateway spends under its own, separate cap,
`MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY` (default `12500`, set on the
gateway service; its public memescope spends only its own 10,000 of that,
enough to refresh every 45 s all day, and holders the other 2,500, at most 750
each). Neither cap sees the other's spend: when both keys are on one plan,
size both to it. Below about 12,000 the memescope runs short of its 45 s day
and serves its last rows until 00:00 UTC.

| Var | Value |
|---|---|
| `MERRYMEN_BITQUERY_API_KEY` | the plan's key. **Orchestrator only** — never on web or the Brain service. Stripped from every child, together with `BITQUERY_API_KEY` and `MERRYMEN_TOKEN`. Default unset: lane off |
| `MERRYMEN_BITQUERY_LANE` *(optional)* | `0` turns the lane off while keeping the key. Default: on when the key is set |
| `MERRYMEN_BITQUERY_POINTS_PER_DAY` *(optional)* | points per UTC day, default `25000` (750k a month), ceiling `100000`. Child evidence may use at most 80% of it |
| `MERRYMEN_BITQUERY_RPM` *(optional)* | requests per minute, default `60`, ceiling `90` |
| `MERRYMEN_FLOW_BROKER` | **do not set.** The orchestrator writes `1` into a child's environment when its lane is on and the child has the IPC channel, and removes any copy inherited from its own |

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

### Energy — the $MERRYMEN gate (off until you turn it on)

An agent whose owner's wallet and own account hold fewer than 100,000 $MERRYMEN
between them gets about a tenth of a normal day of NEW autonomous work — paid AI
reviews (paced across the UTC day) and the trades it opens on its own.
Stop-losses, take-profits and owner orders are never limited; the agent's own AI
reviews — including of its open positions, where an AI-decided exit comes from —
are paced with the rest. Contract: `packages/core/src/energy.ts`;
throttle: `worker/src/energy.ts`.

| variable | value |
|---|---|
| `MERRYMEN_ENERGY_GATE` *(optional)* | unset/`0` off · `observe` counts and logs `[energy] observe: enforce would withhold …` but limits nothing · `1` (or `enforce`) enforces. Set it on **both** `orchestrator` (the only thing that throttles) **and** `web` (copy only: the create/settings screens mention energy when it is `1`) |
| `MERRYMEN_ENERGY_EXEMPT_ACCOUNTS` *(optional)* | On `orchestrator` only: comma-separated, full smart-account addresses from verified grants. Listed accounts use `observe` while the fleet uses `enforce`; an unset, empty or malformed list exempts nobody. Names, owner wallets, prefixes and `all` are not accepted. |

An energy exemption removes only energy pacing and daily energy allowances for
the listed account. Its actual $MERRYMEN balance and holder standing remain
unchanged, and durable usage counters keep accumulating. The worker reports
`mode: observe` and `gated: false` to every status reader. Signed per-trade and
daily spending caps, drawdown limits, permissions, live-trading consent and all
execution checks still apply. To revoke, remove the address and restart the
orchestrator; enforcement resumes against the existing day's counters. This is
an operator environment setting, never a tenant settings field.

> **Roll out `observe` first**, read the logs for a day, then switch to `1` at
> **00:00 UTC** — counts taken under `observe` belong to the same UTC day and
> carry over. The gate is hosted-only by construction: a self-hosted worker
> reads it as off whatever the environment says. It reaches children through
> the ordinary child environment and must not be added to the strip list.
>
> Counters are durable across redeploys: children write `energy_days`, the
> mirror carries it to Postgres, and the supervisor seeds it back into a
> rebuilt child before it arms. The loss window is one mirror pass (~15 s).
>
> **The energy buy** (an owner asks the agent in chat to "get its $MERRYMEN")
> spends real USDG through the house bundler. If `MERRYMEN_SPONSOR_GAS=1`,
> check the Pimlico sponsorship policy admits Uniswap v2 Router02
> (`0x89e5db8b5aa49aa85ac63f691524311aeb649eba`) before telling owners it works;
> the policy is not in this repo.

### Posting on X (opt-in per owner; off until the X app is configured)

An owner can connect an X account in Settings and let their Merryman post on
it: a hello first, the odd casual thought, and now and then a coin it bought
and why — never alerts, errors, prices or amounts. Nothing posts until the
owner turns it on through a warning that names the connected account. Rules
and design: [`docs/x-posting.md`](x-posting.md). Hosted only; self-hosted, the
routes answer 404 and the section does not render.

**The X app** (developer.x.com → your project → the app → *User authentication settings*):
- **Type of App:** *Web App, Automated App or Bot* — a **confidential** client (it has a client secret).
- **App permissions:** *Read and write*.
- **Callback URI / Redirect URL:** exactly `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`, e.g. `https://app.merrymen.dev/connect/x` — byte for byte, no trailing slash. It is a page, not an `/api` route (the callback is a cross-site navigation that carries no session cookie). The iOS app finishes through the same page.
- **Scopes** requested: `tweet.read tweet.write users.read offline.access media.write` (`offline.access` is what makes X issue a refresh token; without it every connection dies in two hours). `media.write` (since 2026-10-13) uploads the P&L card an active owner's profitable sale carries ([x-posting.md](x-posting.md) "The profit card on a sale"). A connection made before that has no `media.write`: its sales post as text, exactly as before, and the orchestrator logs once per owner `… reconnect X to attach profit cards …`. **To get the cards on Alan's sales, reconnect his X account once**: the web shows Reconnect only for a connection X stopped honouring, so in Settings → X choose Disconnect (this cancels anything waiting under Coming up and resets the post choices), then Connect X account, approve on X's screen as the same account, turn posting on again through the warning, and re-check the post choices. The orchestrator re-records his reply consent once posting is on. Nothing is blocked or delayed until then: his sales simply post without the card.
- **Website URL:** the portal requires one — use your `MERRYMEN_PUBLIC_ORIGIN`.
- **Buy pay-per-use credits (or enable billing) before owners turn posting on.** Each post spends the X app's API credits; until there are some, every send answers credits-depleted and the orchestrator pauses the whole fleet for an hour at a time while drafts wait under Coming up.
- A 401 from X's token endpoint means X refused the **app's** client id or secret (rotated on one service, or mistyped): the orchestrator pauses the fleet for fifteen minutes and logs it once; no owner is disconnected.

| Var | Service | Value |
|---|---|---|
| `MERRYMEN_X_CLIENT_ID` | **web + orchestrator** | the app's OAuth 2.0 client id. Unset = the feature is unavailable (Settings says so), not broken |
| `MERRYMEN_X_CLIENT_SECRET` | **web + orchestrator** | the app's OAuth 2.0 client secret. Read in one file only, and stripped from every worker child |
| `MERRYMEN_PUBLIC_ORIGIN` | web (already set above) | builds the callback `${origin}/connect/x`; the orchestrator does not need it for X |
| `MERRYMEN_X_REDIRECT_URI` *(optional)* | web | an explicit callback instead of the one built from the origin (https, or http on loopback for local testing). It must still be this web service's own `/connect/x` page — the finish needs its session — and be registered on the X app byte for byte |
| `MERRYMEN_XPOST` *(optional)* | orchestrator | `0` stops all posting. Owners can still connect and see their drafts; drafts stay pending while posting is off, and a casual one past its day is skipped as stale when it comes back |
| `MERRYMEN_XPOST_REPLIES_APPROVED` *(optional)* | **web + orchestrator** | exactly `1` permits selective comment replies, and active owners' answers to tags, for every consenting owner. Exactly `active` permits them only for the agents in `MERRYMEN_XPOST_ACTIVE_TENANTS`, and every other owner sees replies as unavailable. Any other value is off, with a boot line naming the variable. `1` is for use only after written X approval, which has not been obtained for this deployment. On 2026-10-12 the owner (Milla) decided to set it to `active` on both services for the operator's own agent only, so Alan answers people who tag him. X's published automation rules ask for written approval for AI reply bots; an X staff answer on the developer forum says replies triggered by a mention do not need it, and Alan's request for clarification is pending. `1` (every owner) stays unset until written approval exists. Owners must also enable replies separately for their connected X account. The orchestrator records that consent itself for the operator's own agents (see `MERRYMEN_XPOST_ACTIVE_TENANTS`) |
| `MERRYMEN_XPOST_ACTIVE_TENANTS` *(optional)* | **web + orchestrator, same value** | comma-separated tenant addresses of the **operator's own** agents (the operator is their owner; never list someone else's agent). Named agents get the active cadence (every buy and completed sale, about ten posts a day, 75 minutes apart) and, when replies are in scope, answer posts that tag them, reply to them or quote one of their posts right away, with no ten-minute review, not held by the owner's night and with no opt-out line (replying or quoting is asking; a stop is still honoured). Their mentions are read every fifteen seconds. The orchestrator also records their reply consent once, while posting is on, unless the owner turned replies off in Settings. The web reads it for the reply warning, so set it on both services. Entries that are not addresses are ignored, and a boot line names them by position. See [x-posting.md](x-posting.md) "Active owners" |
| `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY` *(optional)* | orchestrator | fleet comment polls per UTC day, default `200`. `0` or an invalid value disables all polling, including the active agents'. Each poll may read up to eight pages of one hundred mentions and consume several X read requests. An active agent's fifteen-second polls use their own allowance of up to 6000 per X account per UTC day, and do not count against this one |
| `MERRYMEN_XPOST_RESEARCH` *(optional; off)* | orchestrator | exactly `1` lets an active agent's answers to tags look things up first (public index on the fleet CoinGecko lane, the creator's description, its own history); see docs/x-posting.md "Research for answers" |
| `MERRYMEN_XPOST_FOMO` *(optional)* | orchestrator | exactly `1`, with `MERRYMEN_XPOST_RESEARCH=1` and the Fomo pass on: answers may use Fomo's token activity and quick theses, paraphrased and attributed, capped by `MERRYMEN_FOMO_X_HOURLY_CREDITS` (default 3,000 per X account per hour) and a quarter of the owner's daily Fomo cap. Enterprise redistribution rights confirmed by the owner on 2026-10-12 (docs/fomo.md "Publication") |
| `MERRYMEN_XPOST_RESEARCH_PER_HOUR` *(optional)* | orchestrator | public-index lookups per hour across X accounts for answers, default `120`; `0` = none |
| `MERRYMEN_XPOST_CHECKS` *(optional; off)* | orchestrator | exactly `1`, with `MERRYMEN_XPOST_RESEARCH=1`: an active agent answers "larp check" / "is this real?" tagged under a project's post, scanning its site through the research browser's `/scan`, its GitHub and the index; see docs/x-posting.md "Larp checks" |
| `MERRYMEN_XPOST_CHECKS_PER_DAY` *(optional)* | orchestrator | larp checks per UTC day across X accounts, default `80`; `0` = none |
| `MERRYMEN_GITHUB_TOKEN` *(optional)* | orchestrator | any GitHub token with no permissions, for the larp check's repo reads (5,000 an hour instead of 60 unauthenticated); never on a child (stripped) |
| `MERRYMEN_XPOST_LLM_KEY` *(optional)* | **orchestrator only** | a key used **only** for X posts. Unset: the room's `MERRYMEN_GROUPCHAT_LLM_KEY` is used as it is — unless it is a fleet key, which X refuses. Neither: only intros are posted, from templates |
| `MERRYMEN_XPOST_LLM_PROVIDER` *(optional)* | orchestrator | `groq` (default), `anthropic` (default model `claude-opus-5`), or `openai` for any OpenAI-compatible endpoint. **A provider other than Groq receives the writer's inputs: name it in the privacy policy (`site/components/PrivacyPolicyDoc.tsx`, section 5) before deploying it** |
| `MERRYMEN_XPOST_MODEL` *(optional)* | orchestrator | the writer's model; default `qwen/qwen3.8-27b` on Groq. Required for `openai` |
| `MERRYMEN_XPOST_LLM_BASE_URL` *(optional)* | orchestrator | the `…/v1` base for `openai` (https) |
| `MERRYMEN_XPOST_TEMPERATURE` *(optional)* | orchestrator | the writer's sampling temperature, a number from 0 to 2, default `0.6`; anything else keeps the default and the boot log names the variable. OpenAI-compatible providers only (docs/x-posting.md "How the writer calls its model") |
| `MERRYMEN_XPOST_LLM_PER_DAY` *(optional)* | orchestrator | model calls per UTC day across the fleet, default `400`; `0` means template intros only |
| `MERRYMEN_XPOST_PER_DAY` *(optional)* | orchestrator | posts per X account per local day, default `3` (at most two of them buy posts); `0` switches posting off |
| `MERRYMEN_XPOST_FLEET_PER_DAY` *(optional)* | orchestrator | posts per UTC day across the fleet, default `1000` (X's app ceiling is 10,000 per 24 h, and each post costs money); `0` switches posting off |
| `MERRYMEN_XPOST_SHARE_HOUSE_KEY` *(optional)* | orchestrator | `1` lets the writer use a fleet key (`GROQ_API_KEY`, `MERRYMEN_LLM_API_KEY`, `ANTHROPIC_API_KEY`), its own or the room's. Not recommended |

> **The orchestrator also needs `DATABASE_URL` and `MERRYMEN_STORE_DEK`** (it
> has both already): the connections, sealed tokens and posts live in
> `xpost_*` tables, and the tokens are sealed under the DEK. Without either,
> the orchestrator logs `xpost: off — …` once and posts nothing.
>
> **Give the writer its own key, from its own organization**, for the room's
> reason: trading's model allowance is rationed per organization and model,
> and a background feature has exhausted it before. The boot log says
> `xpost: WARNING …` when the writer's Groq model is trading's own. A value an operator
> cannot read is said once at boot and fails closed: an unreadable fleet
> ceiling switches posting off, an unreadable model allowance is none.
>
> **Without a model only intros go out**, from a small template pool, and a
> pool is finite: X forbids substantially similar posts across accounts, so
> on a large fleet more template intros are skipped as echoes. A model key
> is what makes posting work at scale.
>
> **What the boot log says**: `xpost: on — …` with the ceilings, and one
> `xpost writer: …` line naming the provider and model (never the key). Each
> pass that did something logs counts only — `xpost: sent 1, drafted-buy 1` —
> never a post's text and never a token.

**Selective replies for every owner remain disabled.** Do not set the
approval variable to `1` while written X approval is absent. The exception is
`active`, set by the owner's decision of 2026-10-12 for the operator's own
agent only (Alan answers tags; see the variable's row above). Once approval
exists, configure the gate on both web and orchestrator; this only makes a separate
Reply to comments consent available to owners whose posting is already on.
The warning names the connected X account. Disabling replies cancels waiting
replies, and posting off, disconnect or an account switch clears reply consent.

Polling is limited to one read per thirty minutes per X account, two accounts
per orchestrator pass and the durable fleet allowance above. An active owner's
X account is read every fifteen seconds on its own allowance (6,000 a UTC day), ahead
of the fleet's turn, and a batch is drafted from on the pass that read it. The first read
starts at the earliest active owner’s reply consent for that X account; later
reads use a stored cursor. Each owner’s selection excludes comments from
before their own consent. At most one reply is drafted per owner per poll;
owners sharing an X account still share its send limits. Incomplete or
over-limit batches produce no replies and do not advance the cursor. STOP
requests are processed before selection, including when the model budget is
empty. Replies require a fresh successful poll before sending and share the
existing posting, quiet-hour and model budgets, with at least ten minutes
under Coming up. An active owner's answers to tags have their own lane
instead: due when drafted and sent on the pass that read the tag, not held by
the owner's night, twenty seconds apart, sixty a day per X account and six a
person a rolling day, and a tag that is only a greeting gets a casual line
code built (see "Answers to tags" below, "Rollout: Alan's research lanes and
X answers", and [x-posting.md](x-posting.md) "Active owners"). There is no incoming-comment archive: only consent, reply
target metadata, cursors and recipient opt-outs are persisted alongside the
outgoing drafts. See [Posting on X](x-posting.md#selective-comment-replies) for
selection, freshness and durable delivery rules.

**Answers to tags (the owner's decisions of 2026-10-12).** Alan, the only
active tenant, answers any question that passes the screens, in exactly one
lane; the full rules are in [x-posting.md](x-posting.md) "Answers to tags:
routing, voice and consent":

| | asked | answered with |
|---|---|---|
| a) market | "how's the market", "market update", "is it a green day" and the like (a strict allowlist) | code's casual words and code's figures line: bitcoin, ether and solana's day on CoinGecko, and what's moving on Robinhood Chain |
| b) coin facts | a major by name or ticker, "what's hot", a `$ticker` or a contract on the chain | the research and majors path, never confirming a buy by name |
| c) itself | what it trades, how it trades, what it has been up to | a draft from its own public facts, told its buys only for the plain questions about what it trades |
| d) chat | plain banter ("how are you", "who are you", "tell me a joke", "what do you think about ai agents") | a casual draft that states no fact it was not handed; "are you bullish?" and "wen moon" get code's non-committal line about itself |
| e) advice | "should i buy X", "is X going up", a price target | code's playful decline, never naming or judging the coin |
| f) refused | sherwood in any form, a model question off its allowlist, a steer, the house in trouble, distress, other handles, a reply under someone else's post, a quote of anyone else's post, a retweet, odd characters, links, every opt-out | nothing at all |

The voice is a friend on crypto twitter: one or two short lines, lowercase
welcome, at most one emoji, never a corporate deflection or a stock
disclaimer (the gate refuses "i don't comment on", "as an ai", "not
financial advice"). The model writes no digit; figures are only ever built
by code from CoinGecko, GeckoTerminal, Fomo and Bitquery data.

**Who counts as asking.** Whoever tags Alan, replies to him or quotes one of
his own posts is giving consent, so his answers never say "Say stop to opt
out." (the gate takes the notice off an answer and refuses any other opt-out
wording). A reply is answered anywhere in a conversation rooted at one of his
own posts or at a post he answered, when it replies to one of his own posted
tweets (his answers included) or to the same person's own earlier post he
answered; a reply under a third party's post is not. A quote is answered when
it quotes one of his own posted tweets; a quote of anyone else's post and a
retweet are not. Opt-out requests are honoured exactly as before: "stop",
"unfollow me", "leave me alone" and the rest are recorded before anything is
drafted, and that person is never answered again. Comment replies for any
other owner still end with "Say stop to opt out.", and their warnings are
unchanged.

**Limits.** Six answers a person a rolling day (from two) and sixty a day per
X account (from 24), under the per-person lock, the twenty-second gap and the
fleet's day ceiling. The answers' model allowance stays 48 calls a day (code's
own lines spend none), and the research, CoinGecko, Bitquery and Fomo budgets
are unchanged. No trading cap, limit, guard, authentication or tenant
isolation changes.

### Fomo research (read-only; works, honestly, without a key)

Research on what traders on fomo.family are doing, read from **fomoapi.io**, an
independent read-only data service that states it is not affiliated with
fomo.family. Merrymen claims no partnership with either. It answers owners'
questions (app chat, Telegram, MCP), keeps a shared cohort of up to 150
traders, and routes their activity to agents whose owners opted in. Research
proposes; it never places an order, and every trading guard still applies.
Design and stages: [`docs/fomo.md`](fomo.md).

| Var | Service | Value |
|---|---|---|
| `MERRYMEN_FOMO_API_KEY` *(alias `FOMO_API_KEY`)* | **web + orchestrator** | the provider key. The house name wins when both are set; a blank value is no key. **Stripped from every worker child under both names** |
| `MERRYMEN_FOMO_PLAN_CREDITS` *(optional)* | **web + orchestrator, the same value on both** | credits per month on the provider plan; the shared daily budget is derived from it. Default: the Free plan's `250000`. Both services draw on the same durable counters, so both must size them the same |
| `MERRYMEN_FOMO_GROUP_HOURLY_CREDITS`, `MERRYMEN_FOMO_TENANT_HOURLY_CREDITS`, `MERRYMEN_FOMO_TENANT_DAILY_CREDITS` *(optional)* | **web + orchestrator, the same value on both; redeploy both** | research-credit caps per Telegram group per hour, per owner per hour and per owner per UTC day. Unset: 2,500, 6,000 and 20,000. Whole numbers only; a bad value is logged by name (never echoed) and its default applies; each is held under the shared daily pool. Research credits only, never a trading limit (see [`docs/fomo.md`](fomo.md) "Operations") |
| `MERRYMEN_FOMO_ENABLED` | **web + orchestrator, the same value on both** | **Opt-in: Fomo is off unless this is exactly `1`.** Off, the orchestrator opens no Fomo database pool, runs no `fomo_*` DDL, writes no `fomo.json` and spawns children without the IPC channel; those children behave as they did before Fomo (no research lane in Telegram, nothing charged to the scout budget). The web builds no runtime, its chat answers as before, Settings shows no Fomo section and MCP lists no Fomo tool. The few changes that still apply with it off are listed in [`docs/fomo.md`](fomo.md) under "What still changes with hosted Fomo off" |

> **The key lives on the two services that broker reads, and nowhere else.**
> `CHILD_SECRET_STRIP` removes both names at fork, because a tenant's worker
> could otherwise put it in a prompt, a decision row or a log line. A hosted
> child still answers Fomo questions on Telegram: it asks the orchestrator.
>
> **Opt-in.** Nothing below happens until `MERRYMEN_FOMO_ENABLED=1` is set on
> both services. Deploying this code without it changes nothing in production.
>
> **The IPC channel.** While the pass is on, worker children are spawned with
> `stdio: ["ignore", "pipe", "pipe", "ipc"]`; stdin stays closed and the log
> pipes are unchanged. The orchestrator answers each child's Fomo requests on
> that channel **as the tenant it spawned that child for** — the channel is the
> identity, and nothing a child sends can name another tenant, a key, a host or
> a URL. Each child may run 4 tool calls at once and start 30 a minute; one call
> is cut off at 30 s. Hold processes (a held tenant's Telegram answerer) get no
> channel.
>
> **One stream per fleet.** The orchestrator replica that holds the
> `0xfomo-fleet-ingest` lease opens the provider's alert stream (Robinhood Chain
> only — the one network the executor reaches; lookups still cover every
> chain), recovers gaps over REST with the same filter, rebuilds the cohort every
> six hours from the four leaderboards (1,000 credits), and works the shared
> research queue (three quick dossier refreshes a pass). Every replica writes
> `fomo.json` into its own children's homes at most once a minute, and only with
> signals for owners who turned monitoring or following on; an owner with data
> access off gets a file that says so and carries nothing.
>
> **Without a key** nothing is spent and nothing pretends: the pass still writes
> each child's file with `not-configured` health, and lookups over the channel
> answer *not configured*. Without `DATABASE_URL`, or without the opt-in, the
> pass is off and says so once.
>
> **Nothing is posted.** Research and watching notes are drafted into the
> `fomo_publications` outbox only for owners with a connected X account, and
> every one is stored *blocked by policy* (`policy-review-required`): X's
> automation rules and the provider's redistribution terms need review first.
> The outbox's sender is never called in this release.
>
> **What the log says**: one boot line (`fomo: on — …`, `fomo: on without a
> provider key — …` or `fomo: off — …`), cohort lines with counts only, lease
> changes, and a health line at most every 20 minutes — never a tenant, a
> trader, a token or the stream URL's key.

### Telegram groups (on by default per owner; works without a key)

An owner can add their Merryman's Telegram bot to a Telegram group, and it
behaves like one more person there: it answers when it is called, now and then
joins in on its own, remembers each chat, and reacts to coins people post — it
looks at the coin, tags whoever sent it, and either buys a little (when its
Brain likes it and every trencher limit allows it) or says why it is passing.
It never posts trade alerts, errors, sizes, prices or P&L. This is **not** the
group chat room above, which is the public web room. Rules and design:
[`docs/tg-groups.md`](tg-groups.md). Owners turn it on or off, turn coin looks
on or off and pick how chatty it is in Settings → Telegram → Telegram groups
(and on the iOS Telegram screen).

Unlike the room and X, group lines are written **inside each child**: the
child is what long-polls the owner's bot, and the orchestrator never calls
`getUpdates`. The orchestrator's part is carrying each child's group memory
across redeploys (below). Every variable here is read by the children, so set
it on the **orchestrator** and it reaches them through the ordinary child
environment (self-hosted, it goes in the worker's own environment).

| Var | Value |
|---|---|
| `MERRYMEN_TG_GROUPS` *(optional)* | `0` turns Telegram groups off for **every** agent on the host, read by each child on every update: no group lines, no reactions, no coin looks, no memory writes. Membership changes are still recorded (so switching back on works) and `/forgetme` still deletes. Unset or anything else: on, and each owner's own setting decides |
| `MERRYMEN_TG_GROUPS_LLM_KEY` *(optional)* | a key used **only** for Telegram group lines, from a **separate organization**. Refused when it equals `GROQ_API_KEY`, `MERRYMEN_LLM_API_KEY` or `ANTHROPIC_API_KEY`, unless the share flag below is set. A refused or misconfigured key falls through to the owner's own key — never the house key — and the boot log names the variable at fault, never its value |
| `MERRYMEN_TG_GROUPS_LLM_PROVIDER` *(optional)* | `groq` (default), `anthropic` or `openai`. **A provider other than Groq receives other people's group messages: name it in the privacy policy (`site/components/PrivacyPolicyDoc.tsx`, section 5) before deploying it** |
| `MERRYMEN_TG_GROUPS_MODEL` *(optional)* | the model for group lines; unset, `qwen/qwen3.8-27b` on Groq and `claude-opus-5` on Anthropic. **Required** for `openai`, which has no default |
| `MERRYMEN_TG_GROUPS_LLM_BASE_URL` *(openai only)* | the OpenAI-compatible endpoint for `openai`: `https://…`, or `http://` on `localhost` / `127.0.0.1`, with no credentials in the URL. Without it (or the model) the `openai` key is not used. Ignored for Groq and Anthropic |
| `MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY` *(optional)* | `1` lets group lines use a fleet key — as the dedicated key, or, for a hosted agent with neither a dedicated key nor a key its owner saved, the agent's house model. Not recommended |
| `MERRYMEN_TG_GROUPS_LLM_PER_DAY` *(optional)* | model calls per agent per UTC day, default `300` hosted (`1000` self-hosted), clamped to 0–20000 (`0`: templates only), on top of a fixed 40 per chat per hour |

> **The dedicated key is forwarded to every child, on purpose.** The room's and
> X's keys are on `CHILD_SECRET_STRIP` because only the orchestrator spends
> them. Group lines are written by the child that polls the bot, so this key has
> to be in the child's environment, like the house LLM keys already are. Do
> **not** add it to the strip list: a stripped key reads as unset and every
> hosted agent falls back to templates. Its value is never printed; the boot
> line names only the provider and the model.
>
> **Without it, hosted agents use templates and never join in unprompted.**
> `worker/src/telegram/tg-groups/model.ts` resolves, in order: the dedicated
> key; else a key the owner saved in their own settings (never an env house
> key); else, only with `MERRYMEN_TG_GROUPS_SHARE_HOUSE_KEY=1`, the house
> model; else no model. With no model, answers when it is called, coin acks
> and coin outcomes come from templates, there are no ambient lines, and emoji
> reactions still happen. So a hosted agent never spends the house key on group
> chatter unless you set the share flag. Self-hosted, the owner's own
> configured model comes straight after the dedicated key.
>
> **Give it its own key, from its own organization**, for the room's reason:
> Groq rations per organization and model, every agent's trading reasoning
> lives inside the house allowance, and a background feature has exhausted it
> before. The equality check can only compare strings, so a second key created
> in the house organization passes it and still spends trading's allowance.
>
> **The allowance survives redeploys.** Calls are counted in the agent's
> durable group store (below), so a redeploy does not hand out a fresh day. A
> 429 pauses group model calls for 10 minutes; a daily-cap, rejected-key or
> unknown-model failure pauses them until UTC midnight. Each call is
> time-boxed at 20 s, at most 2 run at once per agent, and group work runs off
> the serial poll loop, so a slow model never delays an owner's DMs, buttons
> or `/kill`. None of it
> is ever said in a group: a failure there is silence or a template.
>
> **A posted coin can nominate, never order.** The only thing that crosses from
> a group into trading is a validated `0x` address with where it came from; the
> Brain decides from the same signals any tape coin gets, and every trencher
> limit applies unchanged. Group coins get extra caps on top: one under review
> at a time per agent, 4 per chat and 2 per sender an hour, 12 per agent per UTC
> day, and at most 3 group-sourced entries per agent per UTC day. No variable
> here raises any limit.

**Durable memory: `tenant_tg_groups`.** Each child keeps its groups in one
JSON file, `<child home>/tg-groups.json` (`tg-groups/store.ts`), kept under
512 KB: at most 30 chats, the last 60 lines per chat pruned at 14 days, a
rolling summary, notes on up to 40 people, the coins posted for 14 days, and a
group the bot left kept 30 days. Hosted child homes have no volume, so the
orchestrator ferries the file (`worker/src/tg-groups-ferry.ts`) through one
shared-Postgres table:

```sql
tenant_tg_groups (tenant TEXT PRIMARY KEY, sealed TEXT NOT NULL,
                  bytes INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)
```

| When | What happens |
|---|---|
| Each mirror pass (~15 s) | for tenants whose lease this replica holds, when the file's mtime or size changed: read it (read only), apply the home's forget requests (`tg-groups-forget.json`, below), seal it with the store DEK (`sealSecret`), upsert the row. When nothing is published (the child is held, or its file is absent, refused or failed), the forget requests are applied to the stored row itself, in place |
| Spawn | when the child home has no `tg-groups.json`, restore it from the row, opened with the DEK, with the home's forget requests applied. If that restore fails (or those requests cannot be read), the child runs with `MERRYMEN_TG_GROUPS=0` and nothing is published for it until a later spawn restores the row, so an empty memory never overwrites the stored one |
| The grant goes | the kill switch deletes the row with the child home; a `/kill` that removes the grant deletes it at once; and every reconcile pass deletes the row of any tenant the grant store no longer lists (a grant discarded while its child was not running here, or a delete that failed once), a bounded batch per pass, judging only rows written before that pass read the grant listing. The group files in a home no child of that tenant runs in go at the same moments (a `/kill`, a spawn that finds no grant, and each reconcile pass for every home neither wanted nor running), so a re-grant never finds the old file and seals it back |

> The orchestrator already holds `DATABASE_URL` and `MERRYMEN_STORE_DEK`;
> children get neither and never read the table. The row holds other
> people's messages — members of a Telegram group who never signed up to
> Merrymen — which is why it is sealed rather than stored as JSON, and why it
> is deleted with the grant rather than left behind. The privacy policy
> states these limits; change them together. The loss window is one mirror
> pass. Self-hosted there is no ferry: the file is the store.
>
> **Forget requests have their own file.** Each `/forget` and `/forgetme` is
> appended to `<child home>/tg-groups-forget.json` (`{chatId, userId, atMs}`)
> and fsynced before the wipe, even while the child's groups are held off. A
> held child started with an empty store, so its own wipe erases nothing the
> row holds; the mirror applies the requests to the row instead, and the
> restore that ends the hold applies them again before writing the file. The
> ferry takes the file away only after a publish of a memory file that
> already reflected every request in it. The hold process that answers a
> held tenant's bot (`telegram/hold.ts`) appends a `/forgetme` typed in a
> group to the same file, so a hold never loses one; what else it passes over
> in groups (the bot's own membership, migrations, the owner's Stay, Leave and
> Forget) it keeps in `<child home>/telegram-held-groups.json` for the child
> that ends the hold to apply at its first poll (docs/tg-groups.md "After an
> outage, and while trading is held").

**What owners must do: privacy mode.** Each owner's bot is their own, so
there is nothing to configure on Telegram as the operator — but a bot in a
group hears only commands aimed at it, replies to its own messages and service
messages until its owner changes a BotFather setting. Without it the agent
cannot join in, remember the chat or see posted coins. The steps, which the
dashboard, the iOS Telegram screen and the site docs repeat:

1. Add the bot to the group. It only talks in groups its owner added it to or
   approved: added by anyone else, it stays silent and DMs the owner **Stay** /
   **Leave**, and leaves on its own after 24 h without an answer. A group it
   was already in before it knew who added it is approved as soon as the
   owner writes there.
2. `@BotFather` → `/setprivacy` → the bot → **Disable**.
3. Remove the bot from the group and add it back — Telegram applies the change
   only when the bot re-joins. Making the bot a group admin also works.
4. `/groups` in the bot's DM lists its groups with **Stay** / **Leave** /
   **Forget**.

> `getMe`'s `can_read_all_group_messages` reports only the BotFather setting,
> not what a group the bot joined before the change delivers — hence the
> re-add. When the flag is false at the moment the bot is added as a plain
> member, the agent DMs its owner these steps once per group. Added as an
> admin it hears every line, so nothing is sent then; a later change to a
> plain member of a group it talks in sends them. Leave `/setjoingroups`
> enabled (BotFather's default) or the bot cannot be added to a group at all.

## 5. Create the two services
Both build from the same repo + `Dockerfile`. The image is role-by-variable, and
`railway.json` sets no startCommand and no healthcheck — so the only difference
between the services is the `MERRYMEN_START` variable, and the HTTP-less
orchestrator is never failed by a healthcheck it can't answer. tini is PID 1 and
runs `scripts/container-start.sh`, which `exec`s the role's package.json start
script itself: no npm and no `sh -c` on the start path.

- **The roles:** `start:web` (or the variable unset), `start:orchestrator`,
  `start:recovery-replies`, and the separate `start:solana`. Anything else — **including the variable set but
  empty** — is refused with exit 64 and nothing starts. To get the web role,
  delete the variable; do not clear it.
- **Leave each service's Start Command empty.** One set in Railway would replace
  the image's start step, and with it the role allowlist and the `exec`.
- **The first line of every start is** `[start] role=<role> commit=<sha>` — the
  quickest check of what a deploy is actually running.
- **Stopping:** Railway's SIGTERM goes to tini, which forwards it to node and to
  nothing else (the orchestrator stops its own tenant workers). The orchestrator
  logs `[orchestrator] stopping on SIGTERM — calling the whole fleet home` and
  drains: it starts nothing new, lets each mirror copy already running finish
  under its lease, sends its workers SIGTERM and waits to see each one exit
  (SIGKILL only for one still running when that wait ends), carries out pending
  Telegram kills, gives each tenant home a final mirror pass, writes
  `ops/last-shutdown.json` under `MERRYMEN_HOME`, releases the leases last and
  exits 0. Each worker drains itself on that SIGTERM: it starts nothing new,
  gives a trade already on its chain up to 18s, closes its ledger and exits; a
  trade still out is settled at the next start, as after a crash. The whole
  drain must fit in `MERRYMEN_DRAIN_BUDGET_MS` (default 50s); past it the
  orchestrator exits 1 and the receipt names the step it
  stalled in. How long it has before SIGKILL is the service's draining time, not
  anything the image sets: make it longer than the budget (75s for the default).
  Set as the variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, it also cuts the
  budget to end 5s before Railway's SIGKILL; a time set only in the service
  settings is not visible to the orchestrator. The next start logs whether the
  last stop was clean.

1. **web** — new service from this repo. Leave `MERRYMEN_START` unset → runs the Next dashboard. Set the web env above, then add the custom domain (`app.merrymen.dev`) and follow its DNS record.
2. **orchestrator** — a second service from the same repo. Set `MERRYMEN_START=start:orchestrator`. Set the orchestrator env above. It needs **no public domain**.

The optional Solana worker uses an explicit, separate `start:solana` role;
none of the RH roles starts it. Its hosted guard requires
`MERRYMEN_SOLANA_SERVICE_ID` to match `RAILWAY_SERVICE_ID`, rejects a match with
the configured RH `MERRYMEN_FLEET_SERVICE_ID`, and requires `DATABASE_URL` plus
the image's `MERRYMEN_IMAGE=dockerfile-v1` marker. The web and Solana worker must
share their Solana authority/accounting database and encryption configuration.
The direct CLI applies the same hosted checks, and starts only with
`MERRYMEN_SOLANA=1` on its own service (exit 78 otherwise, before any storage);
`--help` only prints usage.
Local development can use `npm run start:solana`, which reads an optional
ignored `.env.solana.local`. Selecting this role does not deploy the vault
program or authorize trading: each account must explicitly enable its strategy,
and live execution still requires the verified immutable program and finalized
owner-approved session. The app displays **Waiting for Solana worker** when an
enabled strategy has no recent worker heartbeat. Adding this role does not
provision or start a hosted service.

### Solana (off in production)

Merging the Solana work deploys nothing and turns nothing on. Production keeps
it off; the full plan, settings and runbooks are in
[`solana-integration.md`](solana-integration.md), and every setting is listed in
[`.env.solana.example`](../.env.solana.example).

- **`MERRYMEN_SOLANA` stays unset on the web service.** Unset, the network
  switch, the `/solana` screen and Privy's Solana wallets are not rendered, and
  every `/api/solana` route answers 404 before sign-in, body parsing or any
  database read. Set it (to `1`) only in the order of "Turning Solana on"
  below: first for paper, with `MERRYMEN_SOLANA_LIVE_TENANTS` empty, and live
  only after the release gates in `solana-integration.md` are signed off. No
  `start:solana` service exists, and none should before step 2.
- **`NEXT_PUBLIC_MERRYMEN_SOLANA_OWNER_KEY_EXPORT` is a Dockerfile build ARG,
  not a runtime variable.** Next inlines it when the web app is built, so a
  change needs a rebuild and redeploy of the web service, not a restart. The
  default is empty, which is off; only the exact value `1` shows the Solana
  "Back up your owner key" card. Set it on the Railway web service only after
  wallet export is enabled for the Privy app in its dashboard and the deployed
  vault's release entry ships in the published `merrymen` CLI. It is public by
  design, like the other `NEXT_PUBLIC_` values.
- **Settings that must match.** `MERRYMEN_SOLANA_LIVE_TENANTS`, the four
  `MERRYMEN_SOLANA_LIVE_MAX_*` caps, `MERRYMEN_SOLANA_PYTH_GENERATION`,
  `MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS`,
  `MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE` and the fee settings go on every
  service that runs the Solana runtime (web and the Solana worker) with the same
  values. Each service applies a change only once it is redeployed. The live
  list and caps are also checked: each service publishes a digest of the ones it
  runs (the worker with every heartbeat, the web as it starts, every 30 s after
  and whenever it serves Solana status, a preview or a trade), and while the
  two differ every live buy is held on both, status says so (a buys-only
  blocker; exits, revoke and withdraw continue) and
  `[alert] solana-live-rollout differs` pages the operator. Deploy a change to
  the worker first, then the web ("Turning Solana on", step 4).
  `MERRYMEN_SOLANA_RESOLVE_THIRD_RPC`
  goes on an operator's machine only, and `MERRYMEN_SOLANA_RECOVER_RPC` only on
  an owner's own computer.
- **Alert lines.** Once Solana is on, page on every line starting `[alert]` in
  the web and Solana worker services' logs (stderr), as for the orchestrator.
  From both web and worker (the runtime's status and trade paths):
  `[alert] Solana fee payer is low|cannot fund buys|cannot fund exits…`,
  `[alert] solana fee-payer-threshold misconfigured`,
  `[alert] solana-reference-price refused: reason=… generation=…`,
  `[alert] solana-reference-tolerance misconfigured`,
  `[alert] solana-jupiter-key misconfigured`,
  `[alert] solana-live-rollout misconfigured`,
  `[alert] solana-live-rollout differs`,
  `[alert] solana-live-rollout unchecked` and
  `[alert] solana-live-rollout unpublished` (the web's start or periodic
  publish, or the worker's beside its heartbeat). From the Solana worker only:
  `[alert] Solana transactions stuck pending`,
  `[alert] Solana vault below its book`,
  `[alert] Solana autonomous strategy refused: proven-expired attempts used up…`
  and the earlier warning `[warn] Solana proven-expired attempts use more than
  half…`. Each line, its cause and what to do are in `solana-integration.md`
  ("Operator runbooks"). Every Solana process installs the stdio guard before it
  prints, and URL redaction treats `helius-rpc.com`, `helius.xyz`, `rpcpool.com`
  and `syndica.io` as keyed hosts, so a provider key does not reach these logs.
- **Robinhood kills and the Solana tables.** "Kill all agents" and Telegram
  `/kill` also stop the tenant's Solana strategy. They first look
  `solana_wallet_bindings` (and its `strategy_json` column) up read-only in the
  catalog. On a database where Solana was never used, which is production today,
  the table is absent: the kill creates nothing, takes no Solana lock, runs no
  Solana DDL and reports done exactly as before. Both kills remove the Robinhood
  grant first; only where the Solana table exists can a Solana fault make the
  web answer 503 "Kill incomplete" or keep a Telegram kill pending for a retry.
  While a Telegram kill is pending (or its kill state cannot be read), the
  orchestrator keeps the tenant's home and its request but still removes the
  cached grant copy, `settings.json` (the bot token), `telegram.json` and the
  memory, as for any removed agent; only the wipe of the home waits.
- **`POST /api/grants` owner-key scan.** The Solana secret walk reads each
  string once under a grant-sized budget (32 candidates, small window budget):
  a 230 KB hostile body costs about 7 to 15 ms of CPU. The route is not paced.
- **`/api/grants` request limits** (Robinhood code, changed with this work).
  `POST /api/grants` refuses a body over 256 KiB with 413 ("That request is too
  large. Nothing was saved."), the same bound as partner activation, and a body
  that is not JSON with 400 `not a grant`. The kill switch's `DELETE` body is
  limited to 8 KiB (413). A grant whose `chainId` is not Robinhood Chain (4663)
  or its testnet (46630), or that names no chain, is refused with 400
  `unsupported_chain`; the dashboard's signers always send one of the two.

#### Turning Solana on

Like Robinhood's rollout, a few tenants at a time, and each step only after the
one before it looks right. `MERRYMEN_SOLANA_LIVE_TENANTS` names the tenants that
may go live (unset or empty: nobody), and the `MERRYMEN_SOLANA_LIVE_MAX_*` caps
bound the live limits anyone may sign (default 10 and 25 USDG, 0.1 and 0.25 SOL;
details in `solana-integration.md`, "Live rollout"). The list never stops an
owner's exits, revoke or withdrawals, and the caps stop buys before exits: the
vault program charges a sale's USDG proceeds to the same per-trade and daily
limits as a buy, so a buy is refused once it would leave too little of them to
sell the whole SOL position within the same 24 hours (a day's buys stop at
about half the USDG cap). Withdraw is never limited.

1. **Paper first.** On the web service set `MERRYMEN_SOLANA=1` with
   `MERRYMEN_SOLANA_LIVE_TENANTS` unset or empty. It needs
   `MERRYMEN_SOLANA_RPC_MAINNET`, `MERRYMEN_JUPITER_API_KEY`, `DATABASE_URL`,
   `MERRYMEN_PUBLIC_ORIGIN` and Solana embedded wallets on the production Privy
   app (enabled in place, never a new app id). Every signed-in owner can bind a
   wallet and paper trade; nobody can save live mode, register a permission or
   buy live, and the page offers no live switch. Watch the `[alert]` lines.
2. **The program deployment and fee payer.** Only after the release gates in
   `solana-integration.md` (external audit, production `declare_id` and its
   keypair check, devnet rehearsal, the `--final` deployment and its pinned
   release, the Pyth re-check): set `MERRYMEN_SOLANA_VAULT_PROGRAM`,
   `MERRYMEN_SOLANA_VAULT_SHA256`, `MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK` (a
   second provider), `MERRYMEN_STORE_DEK` and a funded
   `MERRYMEN_SOLANA_FEE_PAYER_SEED` on web and on a new `start:solana` service
   (its own Railway service id, `MERRYMEN_SOLANA=1`), with the list still empty.
   Status should show the vault program verified and the fee payer funded.
3. **The canary tenant.** Set `MERRYMEN_SOLANA_LIVE_TENANTS=0x<canary>` on web
   and worker, with the caps at the smallest amounts the canary needs, and
   deploy both, the worker first, then the web: the worker buys nothing live
   until the web has published the same settings, which it does as it starts
   and every 30 s after (until then the worker says
   `[alert] solana-live-rollout differs: the web has not published …`, or
   `… the web last published different …`). Run the canary checks in the
   release gates: a small funded trade, restart and outage, full exit, withdraw
   and revoke, expiry.
4. **Widen.** Add tenants to the list, a few at a time, and raise the caps only
   as an owner decision. Every change to the list or the caps goes on web and
   worker, **the Solana worker first, then the web**, each service applying it
   only once redeployed. The worker restarts with the new settings and compares
   them with the web's latest digest, whatever its age: while they differ it
   holds every live buy (a tenant re-added, caps raised). The web, still on the
   old ones, sees the worker's new digest and holds every live buy, for every
   tenant, until it is deployed too (above). The redeployed web publishes the
   new settings as it starts, and every 30 s after, and both buy again: no page
   needs opening. So any change, taking tenants off or adding them, lowering or
   raising the caps, needs no hold: once the worker has published the new ones
   (its first tick), no buy is made under the old ones, and paper, sales,
   revoke and withdrawals carry on throughout. Once both are deployed, check no
   `[alert] solana-live-rollout differs` or `… unpublished` follows; those
   taken off are exits-only from then on. A worker restarted with unchanged
   settings is not held. What the check cannot see: the worker trusts the
   latest digest written as the web's. While the web cannot publish (its
   `[alert] solana-live-rollout unpublished`), or for up to 30 s after an old
   web container still draining during the deploy last wrote its own, that
   digest is out of date, and where it equals the worker's settings the worker
   buys under settings the running web may no longer run. In this order the old
   web's digest is never the new worker's settings, so that overlap holds buys.
   Deployed the other way round, the web first, the old worker may buy under
   its old settings, which the new web no longer runs, whenever the old web
   container still draining wrote the digest last. For an incident, hold
   trading: `npm
   run solana:hold -- set all --reason "…"` refuses every new trade for
   everyone, paper and live, buys and sales alike (revoke, withdrawals and
   receipt recovery continue), and `set 0x<tenant>` holds one tenant the same
   way; the hold CLI takes the tenant id in lowercase only, while
   `MERRYMEN_SOLANA_LIVE_TENANTS` takes either case. Never unset the web's
   `MERRYMEN_SOLANA` alone, which also removes owners' in-app revoke and
   withdraw.

### Perpetual futures (paper intake available; rollout gated)

An owner's perpetual futures on Lighter's Robinhood Chain instance trade from a
second wallet of their login, the **Perps wallet** (Kernel index 1 of the same
owner key; contract: [docs/perps.md](perps.md)). Perps lands on main in six
slices. Slice 5 PR 1 adds `POST /api/grants?wallet=perps` for creation and
renewal only at `MERRYMEN_PERPS=paper`; otherwise it refuses with
`perps-wallet-not-offered`. The paper grant's permission wall is empty, and
funding and live execution remain unavailable. Merging a slice deploys
nothing, but the next Deploy Latest Commit for any other change ships every
slice already on main, so each
one is built to be safe alone with perps off.

- **Every kill already reaches a Perps wallet** (slice 2). "Kill all agents",
  the phone apps' Stop (both through `DELETE /api/grants`), a hosted Telegram
  /kill, `merrymen kill` and Start over revoke the tenant's Perps grant beside
  its Spot grant (and, all but Start over, its Solana strategy), and report the
  kill incomplete, never done, when the Perps half fails. A tenant with no Perps wallet costs a kill one catalog
  read of `perps_grants`, with no lock and no schema written.
- **The tables are additive.** `perps_grants` and `perps_tenant_settings` hold
  the Perps wallets' grants and settings beside `grants` and `tenant_settings`,
  which no Perps code rewrites. `perps_grants` is created by the first Perps
  grant written. Check the deployed database before assuming it is absent;
  take a backup and row counts before the deployment carrying slice 5 PR 1.
  Never drop either once it exists: it is accounting evidence. The identity
  store's claim backfill reads both grants tables.

These variables only ever **restrict** what an owner may turn on. Nothing here
switches perps on for anyone, and none of it is a setting an owner can see or
change. They limit trading, never a kill.

| variable | where | value |
|---|---|---|
| `MERRYMEN_PERPS` | **both** `web` and `orchestrator` | `off` · `paper` · `live`. **Unset means off, hosted and self-hosted**, as `MERRYMEN_SOLANA` does; anything it does not recognise reads as `off` too — a typo in a switch that takes capability away must not hand it back. Set `MERRYMEN_PERPS=off` on both services anyway before slice 1 merges. Until real-money perps land (the plan's Phase 4), `live` also reads as `off`: there is no live executor to reach, and a deployment that asked for live is never left trading practice perps its operator believes are real. `web` reads it to decide whether to offer the opt-in and mint a Lighter key; children inherit the orchestrator's value. Keep the two equal |
| `MERRYMEN_PERPS_LIVE_TENANTS` | **both** | Only read with `MERRYMEN_PERPS=live`. A comma-separated list of **Perps wallet** smart accounts (the Perps grant's `smartAccount` — never the Spot wallet's, and never the SIWE sign-in wallet, which is a different address again); an entry that is not an address is dropped. Hosted, a Perps wallet not on it stays on paper. Empty means nobody. Do not name anyone before [the mainnet checklist](perps-mainnet-checklist.md) has passed and both mobile apps show the perps banner |
| `MERRYMEN_HALT_PERP_ENTRIES` *(optional)* | `orchestrator` | `1`: no perp opens for any tenant; exits, the protective loop, stand-downs, withdrawals and claims keep running. Only an empty value, `0`, `false`, `no` or `off` means not halted — any other spelling halts. Children read it at spawn, so it takes effect when Railway restarts the service on the variable change (seconds). This is the lever to reach for first in a perps incident (section 8) |
| `MERRYMEN_LIGHTER_VENDOR_DIR` *(optional)* | `orchestrator` | A directory holding `lighter-signer.wasm` and `wasm_exec.js`. Unset, the signer is found at `worker/vendor/lighter/`, which the image carries. Both files are hash-checked before a byte runs, and a known-answer test must pass, whatever the path; an override that points at the wrong place fails closed (live perps stay unarmed). Paper never loads the signer |

**Perps workers on the orchestrator (slice 4, paper only).** With
`MERRYMEN_PERPS=paper` on the orchestrator, each login with a Perps grant gets
a second child, keyed `0x<owner>:perps` in the logs and leased under that key,
with its home at `children-perps/<owner>` beside `children/`. Nothing Perps is
started, leased or made at any other value — the Perps roster is still read
(a catalog probe while `perps_grants` does not exist), so turning perps off
never deletes a Perps book, lease or home: a running Perps worker is stood
down, its last rows mirrored, its lease given back, and its paper positions
frozen until `paper` returns. A Perps worker runs no Telegram bot (slice 6a).
The orchestrator publishes one public Lighter feed, `lighter-feed.json` in its
own `MERRYMEN_HOME`, which every hosted Perps worker reads and none opens a
socket for; it runs only at `paper`, pauses under FLEET_HALT and stops before
the drain signals children. Watch for `perps roster:` and `[perps feed]`
lines. **The fleet handover refuses while `children-perps/` holds a book**:
the handover CLI does not carry Perps books yet, so do not run a persistent-
volume handover with Perps workers on the volume. Nor replace that volume any
other way: a Perps worker whose home is lost does not start again, and there is
no recovery path for it yet (docs/perps.md, "Known limitation: a lost Perps
home"). Its mirrored rows and paper checkpoint stay in Postgres.

> **What the later slices add here** (from the branch, to be checked again as
> each lands): the Lighter key sealed under `MERRYMEN_STORE_DEK` in the Perps
> wallet's grant and written as `perp-key.json` (0600) into that wallet's
> child home, never the Spot wallet's; and the hosted kill's exits-only
> stand-down with a use deadline no more than 15 minutes later, reported as
> closing until it ends — both with the live executor. Hosted children share
> one OS user, so per-child isolation is a prerequisite for general
> availability.

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
key registry, including revocations, for portal and CLI keys alike. Nonces, rate limits and the balance cache
are in-process unless shared KV is configured. Losing the waiting-list file
silently resets the count; losing the partner registry loses issued keys and
its durable revocation overrides. Re-point the existing service and retain
`MERRYMEN_DATA_DIR=/data`; check `GET /ios-beta` and a known partner key's `/meta`
before and after any change to the service's source.

With partner billing (§5d) the same volume also holds `/data/billing.jsonl`,
the append-only ledger of developer accounts, payments and charges, and
`/data/usage.json`, the partner request counts. The ledger is the only record
of who paid: lose it and every transfer ever credited can be credited again.
Billing stays off unless `MERRYMEN_DATA_DIR` is set as a service variable (the
`/data` default alone does not count) to a directory that exists on a mounted
volume: with the volume detached, `/data` is missing or on the container's own
disk, and billing stays off and says so at boot rather than keep a ledger the
next deploy wipes. It must never run on a second replica or on a host without
a persistent disk.

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

The developer portal at `https://merrymen.dev/api` is a third piece: the
marketing site (`site/`, its own Vercel project) proxies wallet sign-in and key
management to the gateway's `/developer/v1` routes, which write keys to the
same partner registry on the gateway's volume.

| Service | Variable | Requirement |
| --- | --- | --- |
| gateway + web | `MERRYMEN_PARTNER_BRIDGE_SECRET` | The same dedicated random secret, at least 32 bytes, on both services. Keep separate from holder/session secrets and never distribute to partners. Rotating it voids outstanding enrollment challenges, and `POST /agents` for a user with an unexpired pending authorization fails until its 30 minutes pass. |
| gateway | `MERRYMEN_PARTNER_APP_ORIGIN` | `https://app.merrymen.dev` (the default); HTTPS required outside localhost development. |
| web | `MERRYMEN_PUBLIC_ORIGIN` | `https://app.merrymen.dev`, also used for optional hosted onboarding links. |
| gateway + site | `MERRYMEN_DEVELOPER_PORTAL_SECRET` | The same random secret, at least 32 bytes, on the gateway and the site. It proves a request came through the site and cannot sign anyone in on its own. A hash of it is mixed into the developer session key, so rotating it (both services together) signs every developer out while partner keys keep working: the switch for a leaked session cookie. It ends sessions, not what one did: afterwards list the affected developer's keys (portal `GET /keys` or `node partners-cli.mjs list`), revoke any minted while the cookie was exposed, and reissue any it revoked. Unset or shorter, the gateway's `/developer/v1` answers 503 `unavailable` and the site answers 503 "Developer sign-in is temporarily unavailable". The site's `/api` page also reads it when it renders (at build, then at most once a minute) to fetch the plans; without it that page shows the built-in plans table and says paid plans are coming soon. Server-only, never `NEXT_PUBLIC_*`. |
| site | `MERRYMEN_DEVELOPER_GATEWAY_ORIGIN` | Optional, server-only. Defaults to `https://ai.merrymen.dev`; set it to point a preview or local site at another gateway. Must be a bare `https://` origin (plain `http://` only for `localhost` or `127.0.0.1`); anything else makes the portal answer 503 rather than send the secret elsewhere. |
| gateway | `MERRYMEN_GATEWAY_SECRET` | Already required for holder tokens. It also peppers every partner key's stored hash and derives the key that signs developer sign-in challenges and sessions, so rotating it invalidates every partner key and signs every developer out. |
| gateway | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Optional for a single process. Without them (the in-memory store), developer sessions are bound to the process: every gateway restart or deploy signs developers out, because their logouts would not survive it. With KV, sessions and logouts survive deploys, and an unreachable KV makes session checks, logouts and sign-ins answer 503 `unavailable` rather than guess. |

Keep the usual shared `DATABASE_URL`/`MERRYMEN_STORE_DEK` and orchestrator worker
configuration from the sections above. Web needs an LLM credential for generated
chat replies; without one, partner chat returns a factual status fallback. The
bridge secret is never a `NEXT_PUBLIC_*` variable and is not needed by partners.
The web build includes the browser SDK at `/sdk/merrymen-browser.js`; this static
module permits browser imports, while authenticated partner calls stay on each
partner's backend. Its first line names the build (`SDK_VERSION`).

Developers issue their own keys at `https://merrymen.dev/api`: five active keys
per wallet, scopes `read:agents`, `write:agents` and `chat:agents`, 30 requests
a minute each while partner billing is off. The console asks for a developer
account before a new key, and with billing on (§5d) the gateway requires one;
then the account's plan sets its keys' quota and rate. Sign-in is an ordinary wallet (EOA) signature checked on the
gateway with no RPC call, so smart-contract wallets cannot sign in and no chain
endpoint can vouch for a signature. A session lasts up to eight hours; the
site's logout revokes it on the gateway (best effort, five-second timeout)
before clearing the cookie. The gateway CLI still issues operator keys, with a
stable `--app-id` retained across rotations, for other scopes, a custom quota
or a key no developer wallet owns. See
[the partner integration guide](../gateway/PARTNER-API.md) for issuance, owner
consent, embedded setup and API examples. The partner key is not a substitute
for the owner's signed grant.

Partner chat answers one message per connection at a time, and activation one
per owner wallet, through Postgres advisory locks that hold across replicas.
Each web replica holds at most six of these locks at once, four chats and two
activations, so slow chats never stop activations: a holder pins a connection
from that replica's Postgres pool (pg's default of ten) for its turn, and four
connections stay free for everything else. A chat's model call is held to 18
seconds, and to what is left of the request's 40-second budget. A waiting
request holds no connection. A chat waits up to 20 seconds and an activation
up to 10, counting queueing and connection checkout, then gets 409
`conversation_busy` or `enrollment_busy` with `Retry-After: 2`. Busy answers
under heavy chat load are this bound working, not a fault.

Verify `GET /partner/v1/health`, then authenticated `/meta`, then an explicitly
authorized test connection through creation, challenge, activation, worker
heartbeat and chat. Health and metadata alone do not test the bridge or worker:
both are answered by the gateway without calling web, so a gateway whose
bridge is broken still reports healthy. Confirm the reported mode and funding
blocker before claiming an agent is trading. Disconnecting app access leaves
the owner's worker and grant in place.

**When partner calls fail.** Partners see only the error code and a
`request_id`; the gateway logs the rest, one line per non-2xx bridge answer,
starting `[gateway] partner bridge: <METHOD> <route> <request_id> key <keyId>`.
Grep for the partner's `request_id`. No line means the runtime answered with a
2xx, or the gateway refused the request itself (an unknown or revoked key, a
missing scope, a rate limit, an oversize body), which it does not log. What the
line ends with:

| Log line ends with | Partner sees | Meaning and fix |
| --- | --- | --- |
| `not sent: MERRYMEN_PARTNER_BRIDGE_SECRET is unset or under 32 bytes` | 503 `upstream_unavailable` | Set the bridge secret on the gateway. The gateway also says so at boot. |
| `got no answer: <error name> (<cause>)`, or `answered HTTP <status>, then its body failed: ...` | 503 `upstream_unavailable` | Web unreachable, DNS, a redirect, or no complete answer within 45 seconds. Check `MERRYMEN_PARTNER_APP_ORIGIN` and the web service. |
| `answered HTTP 401 unauthorized: the runtime refused this gateway, not the partner...` | 503 `upstream_unavailable` | Web refused the bridge signature: the bridge secret differs between the services, or their clocks are more than 60 seconds apart (rarely, a replayed request). The same line with `404 not_found` means web is not in hosted mode (`MERRYMEN_HOSTED=1`). |
| `answered HTTP <status> <content-type>, not the runtime's JSON` | 503 `upstream_invalid_response` | Something in front of the partner route answered instead of it: a proxy page, or a middleware refusal such as `text/plain` 403 "blocked: cross-site request to the local API", which is what took down every partner POST and DELETE until `/api/partner/*` was exempted from that block. |
| `answered HTTP <status> <code>` | that status and code | The runtime's own answer, relayed as written; `upstream_unavailable` here means web hit an unexpected error, or lacks the bridge secret itself. |

The gateway also logs at boot when `MERRYMEN_PARTNER_BRIDGE_SECRET` or
`MERRYMEN_DEVELOPER_PORTAL_SECRET` is unset or under 32 bytes. The site logs
`[developer] ...` when its portal secret or gateway origin is unusable.

## 5d. Partner API billing

Developers pay for partner API plans (Free, then Crumbs, Loaf and Feast per 30
days, from `gateway/lib/billing-plans.mjs`) by sending $MERRYMEN from the
wallet they signed in with to a dedicated payments address, the treasury. The
gateway verifies each transfer on chain read-only (it never sends a
transaction and holds no key), keeps an append-only ledger on its volume and
counts every partner request made with a portal key. It is **off** until the
gateway's variables below say otherwise. The full operator reference
(settings and fallbacks, files and locks, log lines, shutdown,
`billing-cli.mjs`) is [the gateway README](../gateway/README.md#partner-billing);
what partners see is
[PARTNER-API.md](../gateway/PARTNER-API.md#plans-and-billing).

### Release gate: the legal pages come first

**Do not set `MERRYMEN_PAYMENTS_TREASURY` in production until the owner has
updated the site's Terms of Use and Privacy Policy.** Nothing in the code
enforces this: with billing on, setting a treasury is what opens the pay flow
on merrymen.dev/api. Today both pages conflict with paid plans:

- **Terms, introduction** (`site/app/terms/page.tsx`, lines 48–56): the scope
  is the hosted service, its MCP server, the self-hosted software and the
  website. It does not cover the developer/partner API or paid plans.
- **Terms, §6 Fees** (lines 128–147): says neither fee is collected and no
  money moves to us, and that the terms will change before any fee is. That
  passage is about trading fees, but API plans move $MERRYMEN to a Merrymen
  payments wallet, and the terms say nothing about them. They need to cover:
  30-day plans, that every request is metered, and the 402 at quota; that
  payments are not refunded; that credit stays on the account and is never
  paid out (and whether it expires); that only transfers from the signed-in
  wallet are credited, not ones from other wallets, exchanges, smart accounts
  or swaps; that plan numbers can change from the next charge; pro-rated
  upgrades, downgrades at renewal, and a renewal's cost shown as due before
  the period ends; reversals after a chain reorganization, which can leave
  credit below zero; and operator adjustments and comps.
- **Terms, §12 Limitation of liability** (line 249): liability is limited to
  "the fees you have actually paid us in the 12 months before the claim". Plan
  payments in $MERRYMEN would count as fees paid; the owner has to decide how.
- **Privacy, §10 This website** (`site/components/PrivacyPolicyDoc.tsx`, lines
  771–786, served at `/privacy` and `/privacypolicy`): says the developer page
  keeps the wallet's address and each key's name, permissions and status, and
  uses the IP briefly to limit sign-in attempts. Billing adds the developer
  account's name; plan selections; payment records (transaction hash, amount,
  block number and hash, sending wallet, the payments address it matched, log
  indexes); charges, reversals, adjustments and comps, with operator notes;
  per-key request counts (`usage.json`); the IP, for up to 24 hours, under the
  three-accounts-per-IP-per-day limit; and, in the developer's own browser,
  the signed-in wallet's address with its unanswered payment hashes in
  localStorage (`mm_developer_pending_payments`) until each is answered or
  forgotten.
- **Privacy, §4 retention table** (lines 511–549): no row for the billing
  ledger, which is append-only and kept indefinitely as the accounting record
  (it is replayed from the first line at every boot, so removing lines is not
  a routine deletion), or for request counts, dropped 30 days after their
  window ends.
- **Privacy, §5 providers** (lines 551–575): the payments RPC
  (`MERRYMEN_PAYMENTS_RPC`, else `MERRYMEN_GATEWAY_RPC`) receives every
  transaction hash being checked, and is not listed. Pay with wallet also has
  the developer's own wallet make `eth_accounts`, `eth_chainId` and
  `balanceOf` requests through that wallet's RPC.

### Settings

| Service | Variable | Requirement |
| --- | --- | --- |
| gateway | `MERRYMEN_DATA_DIR` | `/data`, set **as a service variable**, on the service's volume. Left to the default, billing stays off. |
| gateway | `MERRYMEN_BILLING` | `off` (unset), then `observe`, then `enforce`, as in the steps below. Any other value is off. |
| gateway | `MERRYMEN_PAYMENTS_TREASURY` | A new address used for API billing and nothing else: any $MERRYMEN transfer to it, at or after the start block, from a wallet that has, or later creates, a developer account can be credited to that account. A multisig or cold wallet is fine; the gateway never needs its key. Only after the release gate above. |
| gateway | `MERRYMEN_PAYMENTS_START_BLOCK` | Required with the treasury (without it the treasury is ignored and `enforce` runs as `observe`). Robinhood Chain's current block when the treasury is first set; earlier transfers are never credited. Leave it unchanged when rotating. |
| gateway | `MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES` | Optional, comma-separated: old treasuries still accepted after a rotation. |
| gateway | `MERRYMEN_PAYMENTS_RPC` | Optional; defaults to `MERRYMEN_GATEWAY_RPC`. Must answer chain 4663 (checked at boot, before each credit and before each reconciliation), or payments are unavailable. Trusted to report receipts. |
| gateway | `MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS` / `MERRYMEN_PAYMENTS_MIN_AGE_SEC` | Optional: `64` blocks and `120` seconds by default, both required before a transfer is credited. |
| gateway | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `12` or more. A shutdown lets requests in flight finish, saves the units it gives back, and exits within 10 s; a shorter wait before SIGKILL can charge partners for requests the deploy cut off. Counts of served requests are already on disk. |
| site | `MERRYMEN_DEVELOPER_PORTAL_SECRET` | As in §5c; the `/api` page also reads it to show the plans. |
| site | (Vercel function duration) | The `/api/developer/[action]` route sets `maxDuration = 60` and gives a payment check 45 s upstream, since each check reads the chain. The site's Vercel plan must allow a 60-second function. |

Billing runs on **one gateway instance only**. Railway already forbids
replicas on a service with a volume; keep it that way, and never enable billing
from `gateway/render.yaml`, which has no disk.

The site may deploy before the gateway. Against a gateway without billing it
shows the built-in plans table with paid plans coming soon, and keeps the key
flow it has today.

### Turning it on

1. **Deploy with billing off** (`MERRYMEN_BILLING` unset). Boot logs
   `[gateway] partner billing: off, nothing is metered`. Partners see no
   change beyond a new `billing: null` field in `/meta` (the per-IP limit
   stays 240 a minute; observe and enforce raise it to 600). Developers can
   already create accounts, and the console asks for one before a new key.
   Confirm `MERRYMEN_DATA_DIR=/data` is a service variable and set
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`.
   **Deploy the site (Vercel) before step 2.** The gateway deploys on its own,
   and once billing is on it refuses a new key without an account (409
   `account_required`); a merrymen.dev build from before accounts cannot
   create one, so its developers could not mint keys. Check that, signed in,
   `GET https://merrymen.dev/api/developer/account` answers 404
   `account_missing` (or the account), not a bare `Not found`.
2. **Observe** (`MERRYMEN_BILLING=observe`, no treasury yet). Boot logs, on
   stderr, `[gateway] partner billing: observe, metered, no quota refused, each
   key at its own rate or its plan's if higher; payments UNAVAILABLE`, which is
   expected without a treasury. Every portal-key request is now counted and
   carries the quota headers, `/meta` shows `billing`, and new keys need an
   account (the console offers to create one). Nothing is refused for quota and
   no rate limit goes down (the per-IP limit rises to 600, and a paid plan can
   raise a key's rate). Keep it on for a
   while; a full 30-day window shows every Free window turning over. Watch
   `node billing-cli.mjs list` and `show <wallet>` (usage by key) on the
   gateway (`railway ssh`), and the `[billing]` log lines. Wallets that have
   keys but no account appear only in `/data/usage.json` (keys
   `<wallet>|<window start>`).
3. **Open payments**, once the release gate is met: set the treasury and the
   start block and redeploy. Boot logs `[billing] PAYMENTS CONFIG RECORDED:
   treasury 0x…, previous [], start block N`, and the billing line moves to
   stdout ending `payments to 0x…`. The Plans section at
   `merrymen.dev/api#plans` stops saying "coming soon" within a minute.
   Optionally, check one payment end to end from an account you control (at
   least 1 MERRYMEN).
4. **Comp existing partners**, if needed, before quotas bite. A developer
   creates an account in the console first; then
   `node billing-cli.mjs comp <wallet> <tier> <days> --note "…"` (refused while
   a period they paid for is running), or `adjust` to add credit.
5. **Enforce** (`MERRYMEN_BILLING=enforce`). Boot logs `[gateway] partner
   billing: enforce, quotas enforced; payments to 0x…` on stdout. If it says
   `observe (MERRYMEN_BILLING="enforce"…)`, the treasury or start block is
   missing; if it says `payments UNAVAILABLE`, the payments RPC is missing or
   answers a chain other than 4663 (a `[billing]` line above says which
   chain); quotas are then enforced while nobody can pay, so go back to
   observe until it is fixed. From now on a spent quota is a 402, and each
   account's keys share one per-minute bucket at its plan's rate: a developer
   with several keys on Free drops from 30 a minute per key to 30 a minute
   for all of them.
6. **Watch** for `[billing] PAYMENT REVERSED`, `LEDGER CORRUPT`, `ANOTHER
   PROCESS APPENDED`, `CLOCK` and `ledger append failed` (what each means is
   in the gateway README). `node billing-cli.mjs reconcile` re-checks recent
   payments without writing anything.

**Going back.** Set `MERRYMEN_BILLING` to `observe` or `off` and redeploy.
The ledger and the counts stay on the volume and are read again when billing
comes back. While off, nothing is metered, charged or renewed, choosing a plan
and paying answer 503 `billing_off`, and paid periods still end on their
dates.

**Rotating the treasury.** Set the new address, move the old one into
`MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES`, keep the start block, redeploy, and
keep the old address listed for a while: the console checks the address again
before paying, but someone who copied it by hand does not. Each change is
recorded in the ledger (`PAYMENTS CONFIG RECORDED`).

## 6. Deploy & verify
- Web comes up at `MERRYMEN_PUBLIC_ORIGIN`; `GET /api/version` returns 200.
- Open the dashboard, **sign in** (SIWE — your wallet signs a free challenge), create/**sign a testnet grant** (session-key-only; the owner key never leaves your browser).
- The orchestrator logs `... spawned (pid …)` for your tenant within ~15s and writes `children/<you>/grant.json` (session key only) + `settings.json`.
- **Fund** the smart account on testnet (ETH for gas). The child arms and trades on 46630.

## 6b. Rollout: Alan's research lanes and X answers

Everything this release adds, in the order to turn it on for Alan Al Dale,
the operator's own agent. Unset is the default and changes nothing, except
for an account already on `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` (step 1). This table is the same in [`hosted-deploy.md`](hosted-deploy.md) and [`x-posting.md`](x-posting.md); change both together.

| Step | Variable | Service | Value for Alan's rollout | What it does, and what to look for |
|---|---|---|---|---|
| 1 | *(deploy)* | Brain service, orchestrator, web; the gateway (its own project) first or with them | this commit | The worker sends the Trencher terms and the flow lens only once Brain's `/health` lists `strategy-terms` and `onchain-flow`, so either order is safe. The worker's Bearer fix starts gateway spending, under the gateway's own cap (below). **An account already on `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` changes at deploy, with nothing else set:** its live fast-Trencher entry reviews get the new momentum plan at once, the Trencher terms once Brain lists `strategy-terms`, and, with Fomo already on and the owner's monitoring or follow setting on, Fomo research on its review candidates. To stage those, take the account out of the variable before deploying and put it back at step 3 |
| 2 | `MERRYMEN_COINGECKO_PRO_SPACING_MS` | orchestrator (children inherit it) | `800` | One `[gecko] coingecko-pro fleet lane: 800 ms` line per child |
| 2 | `MERRYMEN_COINGECKO_PRO_SPACING_MS` | web | `2600` | One `local lane: 2600 ms` line on web. From here web's chart reads are paced too (unset, they stay unpaced as before), so two cold token pages opened within about 2.6 s may show the second one's chart as unreachable until it is read again |
| 2 | `MERRYMEN_COINGECKO_MONTHLY_CREDITS` | orchestrator and web | `5000000` | The plan's month; a spacing below the floor it allows is raised to it. `MERRYMEN_COINGECKO_PRO_API_KEY` stays as it is |
| 3 | `MERRYMEN_FOMO_ENABLED` | web + orchestrator, same value | `1` | Fomo itself, and the IPC channel a child asks the flow lane over |
| 3 | `MERRYMEN_DECISION_RESEARCH_ACCOUNTS` | orchestrator (children inherit it) | Alan's smart account, from the deploy environment (this repository names no account) | Cost quotes, his own outcomes, the momentum plan, the Trencher terms and indexed flow for his live fast-Trencher entry reviews. Decision log lines end `· terms sent` |
| 4 | `MERRYMEN_BITQUERY_API_KEY` | **orchestrator only** | the plan's key, after the IDE checks in [`bitquery-lane.md`](bitquery-lane.md) step 1 | Never on web, Brain or a child (stripped). Boot line `bitquery lane: on — 25000 points/UTC day (20000 for child evidence) …`; reviews log `[trencher] flow SYMBOL: lens` |
| 4 | `MERRYMEN_BITQUERY_LANE`, `MERRYMEN_BITQUERY_POINTS_PER_DAY`, `MERRYMEN_BITQUERY_RPM` | orchestrator | unset (on, `25000`, `60`) | |
| 4 | `MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY` | gateway | `12500`, set explicitly when its key shares the plan | A separate counter from the lane's `25000`: lane plus gateway is 37,500 points a day, sized by the operator to the plan. The gateway's 12,500 includes the public memescope's own 10,000 (at most 9,605 used, one refresh per 45 s, matching the Markets page's own 45 s poll); holders get the other 2,500, at most 750 a day each |
| 4 | `MERRYMEN_FLOW_BROKER` | none | never set | The orchestrator writes it into each child that may ask, and removes an inherited copy |
| 5 | `MERRYMEN_XPOST_ACTIVE_TENANTS` | web + orchestrator, same value | Alan's tenant address, from the deploy environment | The active cadence, his reply consent recorded by the orchestrator, and answers to tags, replies and quotes of his own posts sent right away, with no opt-out line, up to sixty a day and six a person a day. The web reads it for the reply warning |
| 5 | `MERRYMEN_XPOST_REPLIES_APPROVED` | web + orchestrator, same value | `active` (the owner's decision of 2026-10-12, for the operator's own agent only; `1` stays unset until X's written approval) | Without it there are no comment replies and no answers to tags. On 2026-10-12 the owner (Milla) decided to set it to `active` on both services for the operator's own agent only, so Alan answers people who tag him. X's published automation rules ask for written approval for AI reply bots; an X staff answer on the developer forum says replies triggered by a mention do not need it, and Alan's request for clarification is pending. `1` (every owner) stays unset until written approval exists. |
| 5 | `MERRYMEN_XPOST_REPLY_POLLS_PER_DAY` | orchestrator | unset (`200` for the fleet) | Alan's fifteen-second polls spend their own 6,000 per X account per UTC day |
| 6 | `MERRYMEN_XPOST_RESEARCH` | orchestrator | `1` | Answers look things up first. Boot line `xpost: on — … answers look things up first`; with the Bitquery key also `xpost: answers may read onchain flow — up to 200 readings per UTC day …`. With the CoinGecko Pro key the orchestrator already holds, a coin asked by name or ticker (a major, ranked in CoinGecko's top 200) and "what's hot?" are answered too, with code's figures line after the words (x-posting.md "Market intel"); counts `answer-intent-major`, `answer-intent-hot`, `answer-figures` |
| 6 | `MERRYMEN_XPOST_RESEARCH_PER_HOUR` | orchestrator | unset (`120`) | Public-index lookups per hour across X accounts |
| 6 | `MERRYMEN_XPOST_FOMO` | orchestrator | `1` (Enterprise rights confirmed by the owner on 2026-10-12, [`fomo.md`](fomo.md) "Publication") | Paraphrased, attributed Fomo facts in answers |
| 6 | `MERRYMEN_FOMO_X_HOURLY_CREDITS` | orchestrator | unset (`3000`) | Per X account per hour, and at most a quarter of the owner's daily Fomo cap |
| 7 | redeploy `merrymen-browser` | browser service | this release | Adds `POST /scan` (the browser's `/read` is unchanged). Until it is deployed every larp check's scan is a 404, read as "not read" (never as the site being down), so such a check answers that it can't tell |
| 7 | `MERRYMEN_GITHUB_TOKEN` | **orchestrator only** | a fine-grained token with no permissions | Optional; without it GitHub allows 60 calls an hour, shared by everything behind Railway's egress |
| 7 | `MERRYMEN_XPOST_CHECKS` | orchestrator | `1` | Larp checks on. Boot line `xpost: on — … larp checks on, up to 80 a day`; counts `answer-intent-check`, `answer-research-check-<verdict>`, `answer-check-coded` |
| 7 | `MERRYMEN_XPOST_CHECKS_PER_DAY` | orchestrator | unset (`80`) | |

No migrations: the new state is `xpost_meta` keys only (`answer-author:…`,
`replies-off:…`, `reply-polls-active:…`, `x-answer-flow:…`). No trading cap,
risk limit, grant, wallet authority or authentication check changes. The X
gate gains one narrow exception, the name `sherwood-1` in an answer. Steps 5
and 6 change what is said publicly on X and need Milla's review; step 6's
answers need step 5's approval first. Nothing in this table is set by
merging: each value is the operator's to set on the service named.

**Rolling the orchestrator back past this release.** An older orchestrator
reads an `answer` row as a casual post, with no reply target, and would
publish a queued answer (a reply to one person) as a standalone post on
Alan's timeline the same day. So before
deploying an older orchestrator, empty the queue first. Either unset
`MERRYMEN_XPOST_REPLIES_APPROVED` (or take Alan's tenant out of
`MERRYMEN_XPOST_ACTIVE_TENANTS`) on the orchestrator and let one pass of this
release run, which cancels every waiting answer as `replies-off`; or cancel
them directly on the shared database:
`UPDATE xpost_posts SET status = 'cancelled', reason = 'rollback' WHERE kind = 'answer' AND status = 'scheduled';`
Then deploy the older build. An answer this release could not send within an
hour of drafting it is already skipped as stale, so the queue is short.

## 7. Known limits of the slice (closed in Phase B)
- **The dashboard feed now reads the shared Postgres** — the ledger→Postgres port (B2) has landed, so `/api/feed` and `/api/scoreboard` show a child's live numbers in hosted mode. (`pg` is a runtime-only dependency the `Dockerfile` installs into the image; it is deliberately absent from `package.json` so self-hosted stays lean.)
- **Telegram + `merrymen export` are still SQLite-only.** The Telegram read commands (`/status`, `/pnl`, `/trades`, `/report`), the trade-ping notifier, the Virtuals streamer, and the audit CLI still open a child's local SQLite file, so they read **empty** on a hosted deploy (blind, never another tenant's data — every content query is agent-scoped). Trading, the wall, and the dashboard are unaffected; routing these readers through the Postgres driver is A6/Telegram-multi-tenant. Watch the child logs for Telegram until then.
- **Keep web at ONE replica.** Auth nonces are in-memory; multiple web replicas would let a nonce replay across them. Multi-replica needs the KV-backed nonce store (B4/Railway hardening).
- **Single orchestrator replica.** The per-tenant Postgres advisory lease (so two orchestrators never both trade a tenant) is Phase B; run exactly one orchestrator until it lands.
- **Testnet only.** Before real funds: the mainnet re-audit + a two-funded-tenant testnet run (see `docs/hosted-platform-plan.md`).

## 8. Halting the fleet (`FLEET_HALT`) while perps are open

Nothing below applies until live perps exist (docs/perps.md, Rollout); it is
written now so the runbook is reviewed with the two-wallet model it serves.

`touch "$MERRYMEN_HOME/FLEET_HALT"` in the orchestrator container stands
every child down and spawns none until the file is removed. With live
perpetuals on the fleet that stops more than trading: it stops each Perps
wallet's protective loop, its reduce-only exits and any stand-down in
progress. What protects an open position while the fleet is halted is only the
stop resting at Lighter — which a fast gap can pass through, and which expires
after at most 28 days. Nothing tells the owners: the orchestrator logs the halt
and sends no message.

1. **If the trouble is perps opening, do not use FLEET_HALT.** Set
   `MERRYMEN_HALT_PERP_ENTRIES=1` on the orchestrator instead: no perp opens
   anywhere, while exits, the protective loop, stand-downs and withdrawals
   keep running.
2. **Before a FLEET_HALT, list the owners with open live perps**, from the
   shared Postgres. The venue's last word (the live cache, mirrored), each row
   with the Perps wallet it is on and the login that owns it:

   ```sql
   SELECT p.agent_id AS perps_wallet, c.tenant AS owner, p.market_id, p.side, p.base,
          p.stop_trigger, to_timestamp(p.updated_at) AS as_of
     FROM perp_positions p
     LEFT JOIN agent_account c ON c.smart_account = lower(p.agent_id)
    WHERE p.mode = 'live' AND p.side IS NOT NULL AND p.base <> '0'
    ORDER BY c.tenant, p.agent_id, p.market_id;
   ```

   and every wallet whose own report says something is, or may be, REAL money
   at Lighter — positions, collateral, money in transit, or figures it could
   not read (`null` is unread, never zero). The report's `mode` is the perps
   rail, not the book: a practice position held while practice perps are off
   reports `mode: "off"` with no account index, so the book is the report's
   `live` mode, an account index, or else the agent's own `agents.mode`
   (web/src/lib/perps-view.ts perpsBookOf). An unread live report can carry no
   account index, so the index is not a filter:

   ```sql
   WITH r AS (
     SELECT smart_account, mode AS book, perps::jsonb AS p
       FROM agents
      WHERE perps IS NOT NULL
        AND pg_input_is_valid(perps, 'jsonb')   -- Postgres 16+; see below
   )
   SELECT r.smart_account AS wallet, c.tenant AS owner, r.book,
          p->>'mode'            AS rail,
          p->>'accountIndex'    AS account_index,
          p->'positions'        AS positions,
          p->>'collateralMicro' AS collateral_micro,
          p->>'inTransitMicro'  AS in_transit_micro,
          p->>'stopsMissing'    AS stops_missing,
          p->>'incident'        AS incident
     FROM r
     LEFT JOIN agent_account c ON c.smart_account = lower(r.smart_account)
    WHERE p->>'mode' <> 'paper'
      AND (p->>'mode' = 'live' OR p->>'accountIndex' IS NOT NULL OR COALESCE(book, '') <> 'paper')
      AND (jsonb_array_length(p->'positions') > 0
           OR COALESCE(p->>'collateralMicro', '?') <> '0'
           OR COALESCE(p->>'inTransitMicro', '?') <> '0'
           OR COALESCE(p->>'stopsMissing', '0') <> '0'
           OR p->>'incident' = 'true');
   ```

   **The owner comes from `agent_account`, not from a grants table.** Live
   perps trade from a Perps wallet, whose grant is in `perps_grants`, never
   `grants`: the old one-wallet query (`SELECT tenant FROM grants WHERE
   lower(grant_json->>'smartAccount') = …`) finds nobody for it. And a wallet
   being stood down has had its grant removed already. `agent_account` keeps
   every account a login has held, Spot and Perps, for good. A row with no
   owner there is one to chase by hand, never one to skip; check the grants
   tables for it as well:

   ```sql
   SELECT tenant, 'perps' AS wallet FROM perps_grants WHERE lower(grant_json->>'smartAccount') = lower('<account>')
   UNION ALL
   SELECT tenant, 'spot' FROM grants WHERE lower(grant_json->>'smartAccount') = lower('<account>');
   ```

   A row whose `perps` is not valid JSON is unknown, not empty — list those
   too: `SELECT smart_account FROM agents WHERE perps IS NOT NULL AND NOT
   pg_input_is_valid(perps, 'jsonb');`. On Postgres older than 16 there is no
   `pg_input_is_valid`, and a plain `perps::jsonb` cast aborts the WHOLE query
   on the first such row, not just that row: run the second query without the
   `pg_input_is_valid` line and, if it fails on a cast, find the bad row by
   hand before trusting any list.
3. **Tell each owner on the list** through their own bot or by email, before
   the halt if you can: their agent is halted with leveraged positions open at
   Lighter on their Perps wallet, protected only by the stops resting there,
   and nothing will manage those positions until the halt lifts. **Do not tell
   them they can close positions with `merrymen recover`: they cannot.**
   Closing a position with the owner key stays off until the mainnet checklist
   proves it. Recovery can revoke the agent's Lighter key and withdraw free
   collateral, but its unwind cancels every resting order first — including the
   stops on positions it leaves open — so during a halt, running it strips the
   only protection those positions have. For almost every owner the right
   advice is to wait for the halt to lift; an owner who suspects the key itself
   is compromised is the exception, and should be told exactly that trade-off.
4. **Keep it short, and check on the way out.** When the file is removed and
   the children are back, every listed Perps wallet's report must show a fresh
   `protectAt` and `stopsMissing` of 0 within a minute or two; anything else is
   a wallet to look at by hand.
