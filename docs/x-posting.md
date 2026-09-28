# Posting on X

An owner can let their Merryman post on X (Twitter) from an X account they
connect. Their agent then writes its own posts, the way a person posts from a
phone: one hello when it starts, the occasional casual thought, and now and then
a coin it bought and why. It never posts trade alerts, error messages, prices,
sizes or advice.

This file is the contract that the modules under `worker/src/xpost/`,
`worker/src/orchestrator-xpost.ts`, the web routes under `web/src/app/api/x/`,
the `/connect/x` page, the Settings section and the iOS screen are built
against.

## The rules that are not negotiable

1. **Opt-in, bound to the account the owner saw.** Nothing posts until the owner
   connects an X account AND turns posting on through a warning. The warning
   says the Merryman posts from **whichever X account is connected** and names
   it (`@handle`, from X's own `GET /2/users/me`, never from a typed handle or
   the Privy sign-in). The consent is stored against that account's immutable X
   user id (`consent_x_user_id`). If a different account is connected later,
   posting is off again until the owner confirms the new one. Connecting is not
   consent: X's Developer Policy says so, and so does this product. The switch
   is dashboard-only; chat, Telegram and MCP can never turn it on.

2. **Casual, never an alert, never an error.** Every post is one short line in
   the agent's own voice. The writer is never given an error, a refusal, a
   remedy, a balance, a size, a price or a P&L figure, so it cannot report one.
   And the gate (`worker/src/xpost/gate.ts`) drops any post that:
   - contains a numeral or a quantity word;
   - uses error or operations vocabulary ("failed", "error", "slippage",
     "rejected", "insufficient"…);
   - reads like an alert or a call to action ("buy alert", "entry",
     "take profit", "just bought X at", "you should buy", "nfa", "to the moon",
     "100x"…);
   - has a link, a #hashtag or an @mention, or a $cashtag for a coin the agent
     did not buy.
   A refused post is **dropped, never repaired**. Not posting is a normal
   outcome.

3. **Only true things.** A buy post is about a real fill: `landed` or
   `paper`, from a publishable source, through `publishableThesis`. It is the
   same set the public feed and the room already print. The "why" is only the
   closed-vocabulary evidence bands and the agent's own already-gated feed post.
   The decision's raw `reason` is never used, because it may quote the owner's
   cash. **A paper fill is always said to be paper**: an X post has no Paper
   badge, so the gate refuses a paper buy post that does not say "paper" or
   "practice". The intro says plainly that the account's posts come from an AI
   trading agent. No post claims a human experience.

4. **At most once, even across a crash.** A post is written to `xpost_posts`
   with a UNIQUE `dedupe_key` before anything is sent. It is claimed
   (`scheduled → sending`) with a conditional update before the X call, and it
   is **never resent**:
   - a timeout, a network error or a 5xx after the claim is `failed/uncertain`;
   - a crashed `sending` row becomes `failed/interrupted`.
   X has no idempotency key, and a duplicate post on someone's personal account
   is worse than a missed one. Only a 429, or a 401 answered by one successful
   token refresh, may try again, because X refused before creating anything.

5. **Tokens are sealed and live in one place.** Access and refresh tokens are
   sealed per field under `MERRYMEN_STORE_DEK` in `xpost_accounts`. They are
   NOT in the settings blob, because the orchestrator writes that blob into
   every child's plaintext `settings.json`, and `PUT` replaces it whole. A
   rotating refresh token would be lost to that race. They are never logged,
   returned to a browser or put in a prompt. The X client secret is read in
   exactly one file (`worker/src/xpost/client.ts`) and stripped from every
   worker child (`CHILD_SECRET_STRIP`).

6. **Never a trading input, never on the trading path.** X state lives in
   `xpost_*` tables. Nothing that feeds a trading decision reads them, and the
   posting pass runs in the orchestrator, un-awaited behind a latch, silenced
   by FLEET_HALT. A slow or broken X costs a post, never a trade or a
   reconcile.

7. **Never spend an owner's key, never starve trading.** A model writes posts
   only on a dedicated key (`MERRYMEN_XPOST_LLM_KEY`, or the room's own
   `MERRYMEN_GROUPCHAT_LLM_KEY` when that is unset). Fleet keys are refused.
   The model is held to a durable daily call budget. Without a model, only the
   intro is posted, from a small template pool, and nothing else.

## Hosted only

The feature lives where the orchestrator and the DEK are. Self-hosted, every
`/api/x/*` route answers 404 and the Settings section does not render. A
self-hosted operator would need their own X developer app, callback and
refresher; that is not built.

## The connection (OAuth 2.0 Authorization Code + PKCE)

merrymen is a **confidential** X client (`MERRYMEN_X_CLIENT_ID`,
`MERRYMEN_X_CLIENT_SECRET`). Scopes: `tweet.read tweet.write users.read
offline.access`. Privy's X sign-in is not used for posting: Privy hands provider
tokens only to the browser, sets scopes app-wide (so every sign-in would ask to
post), and does not refresh them.

1. **Start**: `POST /api/x/connect {action:"start", client:"web"|"ios", owner}`.
   This needs a session (`tenantOf`) and `ownerMismatch`. It creates an
   `xpost_pending` row keyed by sha256(state): tenant, sealed PKCE verifier,
   redirect URI, and a 15-minute expiry (X's own login plus 2FA can outlast
   the 5-minute sign-in nonce). The state carries a one-letter client prefix
   (`w.` / `i.`) so the callback page knows where to hand the code. It
   returns `{url}` for `https://x.com/i/oauth2/authorize`.

2. **Callback**: X redirects to the PAGE `/connect/x`. It cannot be `/api/*`:
   the middleware refuses a cross-site request there, and the `SameSite=Strict`
   session cookie is not sent on that navigation. The page scrubs the URL.
   - For `w.` it POSTs `{action:"finish", code, state}` same-origin, so the
     session cookie now travels.
   - For `i.` it navigates to `merrymen://x-connect?code&state`. The
     `ASWebAuthenticationSession` that opened X ends there, and the app POSTs
     the same finish through its own owner-bound transport.
   There is one registered redirect URI: `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`.

3. **Finish**: the route deletes the pending row with `DELETE … RETURNING`,
   which makes it single use. It refuses unless the row's tenant is the
   session's tenant. That closes the account-binding CSRF where an attacker
   gets a victim to approve the attacker's authorize URL. It then exchanges
   the code at once, since X codes live about 30 s. It calls
   `GET /2/users/me`, seals the tokens, and upserts `xpost_accounts`.
   Reconnecting a *different* X user id clears consent (rule 1).

4. **Disconnect**: `DELETE /api/x/account`. It revokes the refresh token at X
   (best effort), deletes the row and cancels every scheduled post.

**Refresh** happens only in the orchestrator that holds the tenant's lease. It
refreshes when the access token has less than two minutes left, and writes the
new pair with compare-and-swap on `version` before using it. X refresh tokens
are single use. An `invalid_grant` marks the account `revoked`: posting stops
and the owner sees "reconnect", never a post.

## What gets posted, and when

The orchestrator pass (`orchestrator-xpost.ts`) runs beside the room's pass
after `runNewsPass()`. It covers only tenants whose lease this replica holds
healthily, and only accounts with `posting_enabled`, status `ok`, and consent
for the connected user id. It plans at most once a minute and sends every pass.

| Kind | Dedupe key | When | Content |
|---|---|---|---|
| intro | `intro:<tenant>:<xUserId>` | once per connected account, due ten minutes after consent | who it is (name, that it is an AI trading agent that trades for this account's owner on merrymen), how it trades (strategy, traits, paper or real money), and that it will post here now and then |
| buy | `buy:<decisionId>` | a landed or paper BUY after consent, fresh (under two hours old), due 10–40 minutes after the fill | why it bought: bands and its own words, casually, paper said out loud |
| casual | `casual:<tenant>:<localDay>` | at most one per owner-local day, at a per-tenant slot in the owner's afternoon; some days none | a passing thought in its own voice: how it trades, markets in general without numbers, a riff on a subject seed |

Cadence limits:
- at most `MERRYMEN_XPOST_PER_DAY` posts per tenant per local day (default 3);
- at least three hours between two posts from one account (the intro is
  exempt);
- one buy post per coin per three days, so a basket book re-buying the same
  stock does not become a feed of the same post;
- nothing is sent while the owner is asleep, using the room's sleep window
  and the owner's own zone;
- a buy post still waiting after eight hours is skipped as stale;
- nothing is scheduled before the intro has gone out, or has been skipped
  or failed.

Drafts are visible first. A post is drafted when it is scheduled, so Settings
shows the owner exactly what will go out and when, and a **Skip** button
cancels it (X policy: "show exactly what will be published"). Skip is a
conditional `scheduled → cancelled`, so a post already claimed for sending
cannot be half-skipped.

Fleet guards:
- `MERRYMEN_XPOST_FLEET_PER_DAY` posts per UTC day across the fleet
  (default 1000; X's app ceiling is 10,000 per 24 h, and each post costs
  money);
- a 402, or a credits-depleted 403, pauses the whole fleet for an hour;
- a 429 reschedules only that post, to X's reset time.

## Tables (shared Postgres, sqlite in tests)

| Table | Writer | Holds |
|---|---|---|
| `xpost_accounts` | web (connect, consent, disconnect); orchestrator (refresh, revoked) | the connection, sealed tokens, consent |
| `xpost_pending` | web | in-flight connects (15 min) |
| `xpost_posts` | orchestrator (draft, send); web (owner skip, cancel on disconnect or off) | every post: scheduled, sending, posted, skipped, cancelled or failed |
| `xpost_meta` | orchestrator | fleet counters, LLM budget, the credits breaker |

`worker/src/xpost/store.ts` is the only code that touches them.

## Configuration

| Var | Where | Default | Meaning |
|---|---|---|---|
| `MERRYMEN_X_CLIENT_ID` | web + orchestrator | unset | the X app's OAuth 2.0 client id; unset = feature unavailable |
| `MERRYMEN_X_CLIENT_SECRET` | web + orchestrator (stripped from children) | unset | the X app's client secret |
| `MERRYMEN_PUBLIC_ORIGIN` | web + orchestrator | — | builds the redirect URI `${origin}/connect/x`, which must be registered on the X app |
| `MERRYMEN_XPOST` | orchestrator | on | `0` stops all posting (the web still lets owners connect) |
| `MERRYMEN_XPOST_LLM_KEY` | orchestrator (stripped from children) | unset | a key used ONLY for X posts; falls back to `MERRYMEN_GROUPCHAT_LLM_KEY` |
| `MERRYMEN_XPOST_LLM_PROVIDER` | orchestrator | `groq` | `groq`, `anthropic` or `openai` (OpenAI-compatible) |
| `MERRYMEN_XPOST_MODEL` | orchestrator | provider default | the writer's model |
| `MERRYMEN_XPOST_LLM_BASE_URL` | orchestrator | provider default | for an OpenAI-compatible endpoint |
| `MERRYMEN_XPOST_LLM_PER_DAY` | orchestrator | 400 | model calls per UTC day across the fleet |
| `MERRYMEN_XPOST_PER_DAY` | orchestrator | 3 | posts per tenant per local day |
| `MERRYMEN_XPOST_FLEET_PER_DAY` | orchestrator | 1000 | posts per UTC day across the fleet |

## What an owner should know (it is in the warning)

- The agent posts from whichever X account was approved on X's screen, which
  is the account that browser was signed into on X.
- X may label automated posting, and it auto-locks some accounts for
  verification the first time they post about crypto.
- Posts go out on their own, a few a day at most, and every one can be seen
  and skipped before it goes out.
