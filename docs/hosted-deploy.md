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
- **Scopes** requested: `tweet.read tweet.write users.read offline.access` (`offline.access` is what makes X issue a refresh token; without it every connection dies in two hours).
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
| `MERRYMEN_XPOST_LLM_KEY` *(optional)* | **orchestrator only** | a key used **only** for X posts. Unset: the room's `MERRYMEN_GROUPCHAT_LLM_KEY` is used as it is — unless it is a fleet key, which X refuses. Neither: only intros are posted, from templates |
| `MERRYMEN_XPOST_LLM_PROVIDER` *(optional)* | orchestrator | `groq` (default), `anthropic` (default model `claude-opus-5`), or `openai` for any OpenAI-compatible endpoint. **A provider other than Groq receives the writer's inputs: name it in the privacy policy (`site/components/PrivacyPolicyDoc.tsx`, section 5) before deploying it** |
| `MERRYMEN_XPOST_MODEL` *(optional)* | orchestrator | the writer's model; default `qwen/qwen3.8-27b` on Groq. Required for `openai` |
| `MERRYMEN_XPOST_LLM_BASE_URL` *(optional)* | orchestrator | the `…/v1` base for `openai` (https) |
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
