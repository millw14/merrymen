# Merrymen partner API

Build agent creation, status and chat into your own application. The user can
complete setup inside your app: their wallet signs a capped session grant and an
authorization for your app; Merrymen hosts the worker. An optional Merrymen-hosted
setup page is also available.

**Base URL:** `https://ai.merrymen.dev/partner/v1`

The clean hostname serves the Railway gateway with a valid certificate. The
`merrymen-gateway-production.up.railway.app` hostname remains an alternate host.
The embedded enrollment routes and browser SDK require deployment of this
revision to both the gateway and hosted web service; a healthy gateway alone
does not prove the hosted runtime is configured.

## Credentials and application identity

All partner API requests run **from your backend**, with:

```http
Authorization: Bearer mmp_<keyId>_<secret>
Content-Type: application/json
```

Keep this key in your server's secret storage. Never send it to a browser, mobile
bundle or wallet. The API does not enable browser CORS. The public browser SDK is
separate: it prepares and signs permissions locally, then calls your backend.
Holder `mmk_` keys for `/v1/chat/completions` cannot authorize partner requests.

Visit [Merrymen Developers](https://merrymen.dev/api), sign in with a wallet,
create your developer account (the portal asks for one before your first key),
and create a key for your application. Copy the key immediately: it is shown
only once. The portal includes an SDK download, integration tutorial, and a
real authenticated key test. Each developer can have five active keys and may
request at most ten new keys an hour. How many requests those keys may make, a
minute and per 30 days, depends on whether partner billing is on and on your
account's plan: see [Plans and billing](#plans-and-billing). Replacement keys
retain the app identity; update your backend before revoking the previous key.

Sign-in is a free message signature from a standard wallet (an EOA). The
signature is checked on the gateway itself, with no chain lookup, so
smart-contract wallets (a Safe, a passkey or ERC-4337 account) cannot sign in;
use an ordinary wallet's key. A portal session lasts up to eight hours. Signing
out clears it in your browser and asks the gateway to revoke it; if that
request fails, the session stays valid until it expires. A gateway restart can
end a session early: sign in again. Your keys are unaffected either way.

Operators can also issue keys with the gateway CLI (see
[Operator configuration](#operator-configuration-and-key-rotation)). Such a key
may carry different scopes or a different rate; `/meta` reports what it has.
It belongs to no developer account and is never counted against a plan.

Self-service keys include these scopes:

| Scope | Capability |
| --- | --- |
| `read:agents` | List and inspect your app's agent connections |
| `write:agents` | Request setup, create authorization challenges, activate and disconnect |
| `chat:agents` | Send messages and read the connection's conversation |

The owner separately approves `read:agents` and, when requested, `chat:agents`.
Possessing a partner key does not authorize a wallet or create trading permission.
Chat can use the owner's private portfolio, positions and recent trades to answer;
disclose this before asking for consent.

Verify your key and record its stable `app_id`:

```bash
curl https://ai.merrymen.dev/partner/v1/meta \
  -H "Authorization: Bearer $MERRYMEN_PARTNER_KEY"
```

The response contains `key_id`, `app_id`, `name`, `scopes`, `rate_per_min`,
`api_version` and `billing`. `rate_per_min` is the per-minute rate this key
gets now. `billing` is your plan and usage while partner billing is on, and
`null` otherwise (see [Plans and billing](#plans-and-billing)). The current
contract version is `2026-10-08`; what changed from `2026-09-18`, and the plans
and billing added since under the same version string, are listed under
[Contract changes](#contract-changes). Use your trusted application
configuration for `app_id`; do not accept it from a browser request.

## Setup entirely inside your app

Your backend must authenticate its own user, derive their `external_user_id`,
and enforce ownership of each connection before forwarding requests. Never let
a client choose another user's identifier or an arbitrary Merrymen connection.
Use an opaque internal ID, not an email address or other unnecessary personal data.

1. Your backend requests a connection with `POST /agents`.
2. In your app, explain the strategy, basket, spend/expiry limits, live-trading
   choice and data access. Obtain the owner's explicit agreement and wallet signer.
3. The browser SDK prepares a session grant with the owner's signed permission
   limits. It does not start a worker or transfer funds.
4. Your backend requests a challenge for that exact grant hash and settings.
5. The browser SDK checks the app, user, connection, scopes, wallet, grant and
   settings against the choices already approved, then asks the owner to sign.
6. Your backend submits the grant and signature to `/activate`. Poll detail status
   and show the returned smart account for funding.

### 1. Request a connection

```http
POST /agents

{"external_user_id":"usr_123","name":"Robin"}
```

`external_user_id` is 1–128 characters with no whitespace, C0 control character
(U+0000–U+001F) or DEL. The optional display `name` is 1–64 characters with no
C0 control character or DEL. Both must be well-formed Unicode: a lone UTF-16
surrogate (a `\ud800` escape with no pair) is refused with 400 `bad_request`;
emoji and other surrogate pairs are fine. A pending connection returns HTTP
202, including:

```json
{
  "id": "pa_0123456789abcdef",
  "external_user_id": "usr_123",
  "name": "Robin",
  "status": "pending_authorization",
  "created_at": 1789747200,
  "onboarding_url": "https://app.merrymen.dev/connect#token=...",
  "onboarding_expires_at": 1789749000
}
```

Creation is scoped to `(app_id, external_user_id)`, so it is safe to retry:
repeating it returns the same connection rather than another worker. A pending
one comes back as HTTP 202 with the same `id`, and with a fresh
`onboarding_url` once the previous link's 30 minutes have passed. A linked one
returns HTTP 200. Store `id` on your server. It is the partner connection ID,
not the worker's slug. The optional `onboarding_url` is unnecessary for the
embedded flow.

**After a disconnect** (your `DELETE /agents/{id}/connection`, or the owner
disconnecting your app on Merrymen), `POST /agents` for the same
`external_user_id` starts a fresh authorization under a **new** `id`: HTTP 202,
`pending_authorization`, a new `onboarding_url`. Replace the stored ID. The
owner must authorize again (a new challenge, signature and activation, or the
hosted page). The old ID keeps answering `GET /agents/{id}` with `disconnected`
and can never be used again: challenge, activate and both message routes
return 409, and `DELETE` stays a 200 no-op. Its conversation is not carried
over to the new ID.

### 2. Prepare permissions and sign the challenge

Once this revision is deployed, load the browser ESM module:

```js
import {
  prepareMerryman,
  partnerGrantDigest,
  signMerrymanAuthorization,
} from "https://app.merrymen.dev/sdk/merrymen-browser.js";
```

For a pinned build, check out a reviewed repository revision, install its
dependencies (the build uses the repository's pinned `esbuild` devDependency)
and run `npm run build:sdk`. Serve `sdk/dist/browser.js` from your own assets.
A copy built from a revision between 2026-09-19 and 2026-10-08 fails on import
with `ReferenceError: process is not defined`; rebuild it. This SDK is not yet a
published npm package; do not assume an npm package/version is available. The
module exports `SDK_VERSION`, which names the build; quote it in support
requests. See [the SDK guide](../sdk/README.md).

The following illustrates browser orchestration. `backend` is your authenticated
same-origin backend adapter; it adds the partner key on the server. `owner` is a
viem-compatible `LocalAccount` signer supplied by your external or embedded
wallet integration. The SDK never asks you to export the owner's private key.

```js
const settings = {
  name: "Robin",
  strategy: "steady-basket",
  basket_symbols: ["AAPL", "MSFT"],
  live_trading_enabled: false,
};
const approvedScopes = ["read:agents", "chat:agents"];

// Show these limits to the owner and obtain consent before requesting signatures.
const grant = await prepareMerryman({
  owner,
  chainId: 4663,
  caps: {
    perTradeUsdg: 10,
    dailyUsdg: 50,
    expiryDays: 7,
    maxDrawdownPct: 5,
    maxOpsPerDay: 24,
  },
  onStatus: (text) => showSetupStatus(text),
});

const challenge = await backend.challenge(connection.id, {
  owner: grant.owner,
  smart_account: grant.smartAccount,
  chain_id: grant.chainId,
  grant_hash: partnerGrantDigest(grant),
  settings,
});

const authorization = await signMerrymanAuthorization({
  owner,
  grant,
  challenge,
  settings,
  expectedAppId: YOUR_CONFIGURED_APP_ID,
  expectedAgentId: connection.id,
  expectedExternalUserId: YOUR_AUTHENTICATED_USER_ID,
  expectedScopes: approvedScopes,
});
const activated = await backend.activate(connection.id, authorization);
showFundingAddress(activated.wallet.smart_account, activated.wallet.chain_id);
```

The expected IDs and scopes must come from your established application state and
the user's choices, **not** copied from the challenge you are trying to verify.
This version derives requested owner access from the key used to create the
connection: a key with `chat:agents` requests both scopes. For a read-only setup,
use a key without `chat:agents` and expect only `read:agents`. If an owner declines
the requested access, do not sign or activate that challenge.

`prepareMerryman` takes only `owner`, `caps`, `chainId` and `onStatus`, and
refuses anything else (`trencherFactory`, adapter addresses, `extraTokens` and
the like) before any chain read or signature. `chainId` is `4663` or `46630`;
leaving it out means `4663`, real funds, and `null` is refused. It refuses
`caps` that activation would refuse. A grant made by the hosted module, passed on
unmodified, is never refused as `unsupported_permission` (see below). A copy you
serve yourself carries the platform constants of the revision it was built from
(the class-vault factory, the listed coins), so rebuild it whenever hosted web
deploys; its `SDK_VERSION` should match the hosted module's. The owner signs twice in
all: one typed-data signature for the permission inside `prepareMerryman`, and
one message signature in `signMerrymanAuthorization`.

`settings.name` is 1–24 characters: letters, digits, combining marks, spaces,
apostrophes (`'`), periods and hyphens (and the zero-width joiners some scripts
need), starting with a letter or digit and containing at least one letter, so
`Bot_1`, `Robin!` or a name with an emoji is refused. `strategy` is
`steady-basket` or `llm-strategist`; `basket_symbols` contains 1–10 supported
stock symbols; `live_trading_enabled` must be an explicit boolean. A value
outside these rules is 400 `invalid_settings`. The challenge carries the
settings as the server will store them: the name NFC-normalized, trimmed and
with each run of whitespace made one space, and repeated symbols dropped.
`signMerrymanAuthorization` refuses a challenge whose settings differ from
yours, so normalize the name the same way
(`name.normalize("NFC").trim().replace(/\s+/g, " ")`) and send unique symbols
before you show them to the owner. Supported enrollment chains are Robinhood
mainnet `4663` and testnet `46630`; fund and use the same chain selected for
the grant.

The signed session grant contains a **session private key**, which Merrymen needs
to run only the delegated permissions. Treat the activation payload as a secret:
send it over HTTPS, exclude it from logs/analytics/error captures, and do not
retain it in your backend unless you have a specific secured need. An owner
private key is forbidden. Preserve the wallet provider's recovery/backup flow
before enabling the agent; this SDK does not back up the owner's wallet.

### 3. Challenge and activation endpoints

```http
POST /agents/{id}/challenge

{
  "owner": "0x...",
  "smart_account": "0x...",
  "chain_id": 4663,
  "grant_hash": "0x...",
  "settings": {
    "name": "Robin",
    "strategy": "steady-basket",
    "basket_symbols": ["AAPL", "MSFT"],
    "live_trading_enabled": false
  }
}
```

HTTP 200 returns `{claim, message, challenge_token}`. The owner signs the exact
verified message, which binds the app and external user, connection, wallet,
grant hash, settings, scopes, expiry and nonce. Challenges expire after five
minutes and can be used once.

```http
POST /agents/{id}/activate

{"grant": {"...": "the unmodified SDK grant"}, "challenge_token": "...", "signature": "0x..."}
```

HTTP 200 returns the same connection detail shape as `GET /agents/{id}`, plus
`wallet: {smart_account, chain_id}`. Authorization is checked against the owner
signature, grant and derived smart account before the grant/settings are stored.
Activation is not a claim that the worker is already running. If activation
committed but the worker's state could not then be read, the answer is still
HTTP 200, with `status: "connected"`, no `agent` object and
`runtime_available: false`; poll `GET /agents/{id}`.

A partner grant may seal only what `prepareMerryman` seals from owner, caps and
chain. Activation refuses with HTTP 422 `unsupported_permission`, before the
challenge is spent, a grant that seals a v4 or Pons adapter address, a grant
feature beyond `tradeable-v2`, `energy-buy-v1`, `scoped-spenders` and
`pons-class`, any `grantTokens` that are not the chain's official coin listings
(there are none today, so leave it empty), or a class vault from any factory
but the platform's own (the testnet has none). The vault must also be the one
that factory answers for this smart account, read on chain at activation; if
the chain cannot be read, the answer is 503 `class_vault_unavailable`. A grant
field outside the grant's shape, such as the `trencherFactoryAddress` a
dashboard grant can seal, is refused earlier with 400 `bad_request`.

Retrying an activation:

- **Lost response** (a timeout, a dropped connection): resend the exact same
  body within the challenge's five minutes. If the first attempt never
  arrived, this one activates. If it completed, you get HTTP 200 with the
  connection as it is now, and nothing is applied again: no grant reinstall,
  no settings change, live trading not re-enabled.
- **409 `enrollment_busy`** (an activation for the same owner wallet is still
  running, or the hosted runtime is at its limit of activations and chats in
  progress, across all apps), **503 `class_vault_unavailable`** or **503
  `derivation_unavailable`**: this request did not spend the challenge. Resend
  the same body unchanged after `retry_after` seconds or a short back-off,
  within the five minutes; the owner does not sign again. If the activation
  still running was your own earlier attempt, that one may have spent it: the
  resend then gets its result as a lost response, or `challenge_used`.
- **503 `enrollment_storage_failed`**: the challenge was spent and activation
  stopped part-way. The connection may still be pending, or linked in paper
  mode with the grant installed and live trading off. Even while it is still
  pending, the owner's agent may already have been switched to paper mode
  (live trading off) with these settings, and its grant replaced: an owner who
  already ran a Merrymen agent should be told before you go on. Inspect
  `GET /agents/{id}`, then request a fresh challenge and owner signature.
- **409 `challenge_used`**: this authorization was already spent, by an
  attempt that was refused or stopped after spending it, by an activation a
  later one has since replaced, or (rarely) by one that completed but could not
  record itself for retries. Inspect `GET /agents/{id}`; changing anything
  needs a fresh challenge.
- **401 `challenge_expired`**: the five minutes are over, for a retry too.
  Inspect the connection, and request and sign a fresh challenge if needed.

## Runtime status, funding and chat

`GET /agents` returns `{data: [...]}` for up to 100 of your app's connections,
newest first (by `created_at`, then `id`). There is no pagination contract yet.
Each external user appears once: a connection that was disconnected and then
replaced by a new `POST /agents` drops out of the list, though its ID still
answers `GET /agents/{id}`; one that was disconnected and not replaced is still
listed. This list is a connection summary with no `agent` object, and its only
statuses are `pending_authorization`, `connected` and `disconnected`:
`connected` means the owner authorized your app, not that a worker is healthy.
Use `GET /agents/{id}` for current worker state; only your app's authorized
connection can resolve its tenant.

| Detail status | Meaning |
| --- | --- |
| `pending_authorization` | The owner has not completed authorization |
| `awaiting_grant` | The connection needs a valid owner grant |
| `starting` | A grant exists, but there is no fresh heartbeat from that grant |
| `running` | The worker has a recent heartbeat |
| `stale` | The worker's heartbeat is too old |
| `disconnected` | Your app's access was revoked |

When available, `agent` contains `id` (worker slug), `mode`, `worker_alive_at`
(milliseconds), `heartbeat_fresh`, `live_blocker`, `live_trading_enabled` and
`ledger_available`. `created_at` fields are Unix seconds. Read the explicit
freshness/mode/blocker fields: `running` alone does not mean live trades are
enabled, funded or being executed. An unavailable ledger is not a zero balance.

The owner's smart account needs trading assets and gas on the grant's chain.
Activation does not deposit funds. Gas sponsorship depends on the hosted worker
configuration; do not promise free gas from activation alone. Display the
returned address and chain clearly and let the owner fund it from their wallet.

Send a natural-language message:

```http
POST /agents/{id}/messages

{"message":"How is my portfolio doing?","request_id":"msg_4f3c7b1029"}
```

```json
{
  "agent_id": "pa_0123456789abcdef",
  "request_id": "msg_4f3c7b1029",
  "reply": "...",
  "proposal": null,
  "created_at": 1789747300
}
```

Messages are 1–2000 characters of well-formed text (no lone UTF-16 surrogate)
and may contain tab, LF and CR but no other C0 control character
(U+0000–U+001F); leading and trailing whitespace is trimmed. Anything else is
refused with 400 `bad_request` before a reply is generated. `request_id` is
8–128 letters, digits, underscores or hyphens. Generate one per logical message
and reuse it for transport retries. The same ID and text returns the saved
response; a different text with that ID returns HTTP 409
`idempotency_conflict`. After a 503 or a timeout, resend the same ID and text:
if the first request finished, you get its saved reply.

A connection answers one message at a time. A request that arrives while
another is generating waits, up to about 20 seconds; a reply's model call is
held to 18 seconds, so a retry of the request being generated normally gets its
saved reply. The hosted runtime also generates
only a few replies and activations at once, across all apps, so a request can
wait when nothing else is running for its connection. Still waiting after
that, the answer is 409 `conversation_busy` with a `Retry-After` header and
`error.retry_after` (seconds, currently 2): resend the same request unchanged.

Chat uses the actual tenant's portfolio, positions, recent trades, settings and
worker state, with persisted conversation context. If an LLM is unavailable,
the response falls back to a factual status response. Replies are cleaned
rather than refused: C0 control characters other than tab, LF and CR are
removed (DEL and U+0080–U+009F are not, so escape them if your display needs
to), a lone surrogate becomes U+FFFD, a reply over 16,000 characters is cut
and ends with `…`, and an empty one is replaced by a statement that no action
was executed. A non-null `proposal` describes a suggested command; it **does
not execute** a trade or change settings. A proposal too large to store (over
8,000 characters as JSON) is dropped and comes back as `null`.

`GET /agents/{id}/messages` returns `{agent_id, messages}` in chronological order.
Each message has `role`, `content`, `requestId` and `createdAt`; assistant messages
may also have `command`. These history fields are camelCase. The store retains
the latest **40 exchanges** (80 messages); idempotency protection lasts only
while the corresponding exchange is retained. Do not reuse old request IDs.

`DELETE /agents/{id}/connection` revokes this app's access and returns
`{id, status: "disconnected"}`; repeating it is a 200 no-op. It does not stop
the worker, revoke the owner's trading grant or withdraw funds. Expose those
actions as separate owner controls if your product needs them; they are not
partner API routes in this version. To connect the same user again, see
[after a disconnect](#1-request-a-connection).

## Optional hosted setup

Instead of embedding wallet setup, open the `onboarding_url` returned on a pending
connection. It expires after 30 minutes. The opaque token is in the URL fragment
and is consumed client-side; do not move it into a query string or log it. The
owner signs in, completes the normal grant/backup flow and explicitly approves
app access. Your backend polls `GET /agents/{id}`. There is no arbitrary return
URL or automatic redirect; the user returns to your application themselves.

## Plans and billing

Requests made with a key from the developer portal count against its
developer account's plan. Merrymen switches this on in stages, and `/meta`
says which one is running (`billing.mode`, or `billing: null` while it is off):

| Partner billing | What your keys see |
| --- | --- |
| `off` | Nothing is counted or refused for quota, there are no quota headers, and `/meta` reports `billing: null`. Each key keeps its own per-minute rate. |
| `observe` | Every request is counted, and answers carry the quota headers with `x-merrymen-quota-enforced: false`, but no request is refused for quota. Each key keeps its own per-minute rate, raised to its plan's when that is higher. |
| `enforce` | A request past the plan's quota is refused with 402 `quota_exhausted`, and all of an account's keys share one per-minute rate: the plan's. |

Treat `observe` as a dry run: if `x-merrymen-quota-remaining` reaches `0`
there, the same requests would be refused under `enforce`. Keys an operator
issued with the gateway CLI belong to no account and are never counted.

### Plans

| Plan | Cost per 30 days | Requests per 30 days | Requests a minute, per account |
| --- | --- | --- | --- |
| Free | nothing | 1,000 | 30 |
| Crumbs | 100,000 MERRYMEN | 50,000 | 60 |
| Loaf | 400,000 MERRYMEN | 250,000 | 120 |
| Feast | 1,000,000 MERRYMEN | 1,000,000 | 300 |

The live table is at [merrymen.dev/api#plans](https://merrymen.dev/api#plans).
It can change, and a change applies from your next charge: a period already
paid for keeps the requests and rate it started with until it ends.

### Paying for a plan

1. Sign in at [merrymen.dev/api](https://merrymen.dev/api) with a standard
   wallet (an EOA). Only payments sent **from that wallet** are credited to its
   account.
2. Create your developer account: a name of 1–48 characters, one account per
   wallet. Creating it is free and sends no transaction. The portal asks for
   it before it creates a new key (and while billing is on, the gateway
   refuses a new key without one). Keys made without an account, such as
   those from before accounts existed, keep working, and count against Free
   until their wallet creates an account.
3. Choose a plan. Before you confirm, the console shows what confirming will
   do: start the plan now, upgrade the running period now, change plan at the
   next renewal, cancel renewal, or wait for a payment. It names every amount
   taken from credit and what it buys, and for an upgrade the request quota
   the rest of the period gets (see **Upgrade** below).
4. Send $MERRYMEN (token `0xa15cd06dd305269a0f48bebeb30aa3588fba7b32`) on
   Robinhood Chain (chain `4663`) from your signed-in wallet to the Merrymen
   payments wallet the console shows. The console shows what is due rounded up
   to a whole token; anything sent over that stays on the account as credit.
   **Pay with wallet** sends the transfer for you when your browser wallet is
   on the signed-in address and on Robinhood Chain. Otherwise send it from your
   wallet app and paste the transaction hash under **Already sent?**.
5. The gateway reads the transfer from the chain and credits it once it is
   both deep enough and old enough: by default 64 blocks and two minutes, so
   expect about two minutes. The console shows it as confirming until then. As
   soon as the account's credit covers the plan, the plan starts and runs for
   30 days.

The gateway credits a transfer only when its hash is submitted. The console
submits it and keeps checking, but there is no lookup by wallet: keep the hash
of any payment until it shows as credited.

What is credited:

- $MERRYMEN transfers on Robinhood Chain, from the signed-in wallet, to the
  payments wallet (or to an address it replaced recently), in blocks after
  payments opened. A transfer from any other wallet, an exchange, a smart
  account or a swap is not credited to this account, even if it reached the
  payments wallet; a transfer from another wallet of yours can only be credited
  to that wallet's own account, by signing in with it and submitting the hash
  there.
- Every such transfer in one transaction adds up to one payment, which must be
  at least 1 MERRYMEN. A transaction is credited once, however its hash is
  written.
- Payments are not refunded or paid back. Credit stays on the account and is
  used for later charges.

When a transfer is not credited, the console says why:

| Code | Meaning |
| --- | --- |
| `payment_pending` (202) | `stage: "not_found_yet"`: not on Robinhood Chain yet. `stage: "confirming"`: found, with `confirmations`, `needed` and `ready_in_sec`. The console keeps checking. |
| `payment_not_found` (422) | `reason` is `wrong_token` (no $MERRYMEN transfer in it), `wrong_sender` (not sent from the signed-in wallet), `wrong_recipient` (not sent to the payments wallet) or `before_start_block` (sent before payments opened). |
| `payment_failed` (422) | The transaction failed on chain, so nothing was sent. |
| `payment_too_small` (422) | Less than 1 MERRYMEN in all. |
| `payment_unsupported` (422) | More than 256 matching transfers in one transaction. Send one transfer. |
| `chain_unavailable`, `payments_unavailable`, `billing_unavailable` (503) | The chain could not be read, payments are closed for now, or billing could not record the payment just now. Check again later. |

If a chain reorganization undoes a credited transfer (the gateway checks each
payment again for 30 minutes after crediting it, and acts only when two checks
five minutes apart agree), its amount is taken off the credit and the history
shows the reversal. The running period goes on, and nothing new is charged
while credit is below zero. If the transfer lands again in a later block,
submit its hash again: the console's history offers **Check this transaction
again** on the reversal. Do that before sending a new payment; once the
transfer is final again, it is credited again.

### Periods, renewals and plan changes

- **A paid period** lasts 30 days from its charge, and its requests are
  counted for that period.
- **Renewal.** When a period ends, the account renews at its next counted
  request, payment or plan change, starting from that moment: time with no
  requests is never charged. It renews the plan you selected if credit covers
  it; if not, the plan that just ended, if you paid for it and credit covers
  it; otherwise the account is on Free, keeps its credit, and the console
  shows what is due. A period Merrymen gave at no charge renews only into the
  plan you selected. `renews_on_next_request: true` (in `/meta` and the
  console) means a charge is waiting for your next counted request.
- **Paying ahead.** Right after a plan starts, the console shows the next
  period's cost, less any credit left over, as due for renewal ("Pay ahead for
  the next period").
  Nothing is owed before the period ends; credit sent early is used at
  renewal.
- **Upgrade.** Choosing a plan that costs more while a period runs charges,
  at once, the difference in cost for the time left, rounded down, and adds
  the difference in requests for the same time left, rounded down. The period
  keeps its end date and the requests already used; the new plan's per-minute
  rate applies at once. For example, on Crumbs with 2 days left, moving to
  Feast costs 60,000 MERRYMEN and raises that period's quota from 50,000 to
  113,333 requests. Each upgrade costs the difference from the plan the period
  was last moved to: Crumbs at the start, Loaf with 20 days left and Feast with
  10 days left cost 100,000 + 200,000 + 200,000 MERRYMEN, and the next period
  on Feast costs 1,000,000. Without enough credit an upgrade waits for a
  payment; the amount due only falls as the period runs.
- **Downgrade.** A plan that costs less takes effect at the next renewal. The
  running period is unchanged.
- **Free.** Choosing Free cancels renewal: the running period lasts to its
  end, then the account is on Free. Credit stays on the account.

### What is counted

- Every request a portal key makes under `/partner/v1` counts one request
  against its account once it is past the key, scope and rate checks,
  whatever the answer: a 4xx caused by the request itself counts, and so does
  an unknown route.
- Not counted: `GET /partner/v1` (discovery), `GET /partner/v1/health` and
  `GET /partner/v1/meta`; requests refused before counting (401, 403
  `forbidden_scope`, 429 `rate_limited`, 413); and a 402 `quota_exhausted`.
  `/meta` still counts toward the per-minute rate.
- Given back when the platform failed: any 5xx, any `upstream_*` code, 409
  `conversation_busy` or `enrollment_busy`, and a request cut off because the
  gateway was restarting. Retrying these costs no quota.
- A request is counted when it starts, so concurrent requests cannot go past
  the limit.
- The quota belongs to the wallet's account and is shared by all its keys. On a paid
  plan the window is the period. On Free, windows are 30 days long and start
  at the earlier of the wallet's first API key (revoked keys included) and its
  account's creation, so revoking keys or creating the account later does not
  start a fresh window.
- If the gateway crashes, up to about the last 10 seconds of counts can be
  lost, in your favour.

Every counted answer, and `/meta`, carries these headers:

| Header | Value |
| --- | --- |
| `x-merrymen-quota-limit` | Requests in the current window |
| `x-merrymen-quota-remaining` | Requests left; never below `0` |
| `x-merrymen-quota-reset` | When the window ends, in Unix seconds |
| `x-merrymen-quota-enforced` | `true` when a spent quota is refused (`enforce`), `false` under `observe` |

They are absent while billing is off, for operator keys, on discovery and
`/health`, and on refusals made before counting (401, 403, 429, 413). An answer
whose request was given back still carries them, with that request returned
to `remaining`.

A spent quota under `enforce` is HTTP 402, with `Retry-After` (seconds until
the window ends), the quota headers and:

```json
{
  "error": {
    "code": "quota_exhausted",
    "message": "This account has used its 1000 requests on Free until 2026-11-08T09:00:00.000Z. Choose a larger plan at https://merrymen.dev/api#plans.",
    "request_id": "req_0123456789ab",
    "plan": "free",
    "limit": 1000,
    "used": 1000,
    "resets_at": "2026-11-08T09:00:00.000Z",
    "upgrade_url": "https://merrymen.dev/api#plans"
  }
}
```

Read the fields, not the message. A 402 is not counted, the same request is
refused again until `resets_at` unless the plan changes, and the gateway does
not log it. On the largest plan (Feast) there is no larger plan to move to,
and a running period is not renewed early: the quota comes back at
`resets_at`, and the message says so. `upgrade_url` is still present there,
as on every 402.

`/meta` reports the plan in `billing`:

```json
"billing": {
  "mode": "enforce",
  "enforced": true,
  "plan": "crumbs",
  "requests_limit": 50000,
  "requests_used": 1234,
  "resets_at": "2026-11-08T09:00:00.000Z",
  "plan_ends_at": "2026-11-08T09:00:00.000Z",
  "renews_on_next_request": false
}
```

`billing` is `null` while billing is off and for operator keys.
`plan_ends_at` is `null` on Free. `/meta` never makes a charge: while
`renews_on_next_request` is `true`, `plan` still names the plan as it stands,
and `rate_per_min` already gives the rate the next request will get.

### Per-minute rates

- **Billing off:** each key has its own rate: 30 a minute for portal keys.
  Operator keys keep their own rate in every mode (120 unless set otherwise).
- **Observe:** each portal key keeps its own bucket, at its own rate or its
  account's plan rate, whichever is higher.
- **Enforce:** one bucket per account, at its plan's rate, shared by all its
  keys. On Free that is 30 a minute for all of a developer's keys together.
  The 429 message then reads `… requests/minute for this account`.
- When a renewal or a newly paid plan is waiting, the rate is that of the plan
  the next request will be served on.
- Each caller IP may also make 240 requests a minute while billing is off,
  and 600 under `observe` and `enforce`, where every plan's rate fits under
  it.
- `rate_per_min`, in `/meta` and in the portal's key list, is the rate a key
  gets now.

## Errors and retries

Errors use one envelope:

```json
{"error":{"code":"forbidden_scope","message":"...","request_id":"req_..."}}
```

Preserve `request_id` when reporting failures. For a request the hosted runtime
refused or could not answer, the gateway logs a line with this ID. Refusals the
gateway makes itself (key, scope, rate limit, spent quota, body size, unknown
route) are not logged; report those with their code and time. Missing,
unrecognized-format and holder credentials return 404; a correctly formatted
partner key with an unknown ID or incorrect secret returns 401. Revoked keys return 401
`key_revoked`, and missing scopes return 403 `forbidden_scope`. Other expected
cases include invalid input (400/422), unavailable authorization or conflicting
identities (403/409), rate limits (429), a spent plan quota (402
`quota_exhausted`, see [Plans and billing](#plans-and-billing)), and an
unavailable hosted runtime or storage (503). Check the code rather than
matching prose.

A body over 32 KiB (256 KiB for `/activate`) is refused with HTTP 413
`bad_request`, which carries a `request_id` like any other error. Past 4 MiB
the gateway drops the connection, so expect a reset rather than an answer. The
gateway waits up to 45 seconds for the hosted runtime; give your own HTTP
client a longer timeout than that.

The codes that call for a retry, and how:

| Code | Status | What to do |
| --- | --- | --- |
| `rate_limited` | 429 | Back off with jitter. |
| `quota_exhausted` | 402 | Your account's plan quota is spent. The same request is refused until `error.resets_at` (`Retry-After` gives the seconds), unless the plan changes; a larger plan, if there is one, is at `error.upgrade_url` (on Feast, the largest, wait for `resets_at`). |
| `upstream_unavailable` | 503 | No complete answer from the hosted runtime (unreachable, timed out, or misconfigured). Back off and retry; writes are safe to resend as described above. |
| `upstream_invalid_response` | 503 | The runtime answered, but not with its JSON envelope (a proxy or error page). Back off as for `upstream_unavailable`, and report the `request_id` if it persists. |
| `runtime_unavailable` | 503 | The worker's state could not be read. Retry later. |
| `conversation_busy`, `enrollment_busy` | 409 | The same connection or owner is busy, or the runtime is at its concurrency limit. Resend the same request unchanged after `Retry-After` / `error.retry_after` seconds. |
| `class_vault_unavailable`, `derivation_unavailable` | 503 | A chain read failed before the authorization was spent. Resend the same activation within the challenge's five minutes. |
| `enrollment_storage_failed` | 503 | Inspect the connection, then start a fresh challenge. |

Each key's per-minute rate is `rate_per_min` from `/meta`. While partner
billing is off that is 30 for self-service keys; with billing on it follows the
account's plan ([Per-minute rates](#per-minute-rates)). Operator-issued keys
have 120 unless set otherwise. Each caller IP also has 240 per minute (600
while billing is on). Poll
with a modest interval. Do not retry a wallet authorization except as
described under [activation](#3-challenge-and-activation-endpoints), change
the body under a message request ID, or treat `/health` as worker health.

`GET /partner/v1` discovers the surface and `GET /partner/v1/health` checks gateway
liveness without authentication; neither is counted against a plan. `GET /healthz`
is also process liveness. None of them proves a valid grant, a running worker,
configured chat or a reachable bridge.

## Contract changes

Plans and billing, added after `2026-10-08` without a new version string
(`/meta` still reports `api_version: "2026-10-08"`). None of this applies
until Merrymen turns partner billing on; `/meta`'s `billing` says when it
has:

- Requests made with portal keys are counted against the developer account's
  plan ([Plans and billing](#plans-and-billing)). Counted answers carry
  `x-merrymen-quota-limit`, `-remaining`, `-reset` and `-enforced`, and `/meta`
  carries them too.
- `/meta` has a new `billing` object (`null` while billing is off and for
  operator keys), and its `rate_per_min` is the rate the key actually gets.
- Under `enforce`, a spent quota is HTTP 402 `quota_exhausted` with `plan`,
  `limit`, `used`, `resets_at` and `upgrade_url` in the error and a
  `Retry-After` header, and a portal key's per-minute rate is its account's
  plan rate, shared by all the account's keys (a 429 then says
  `for this account`).
- Requests the platform failed (5xx, `upstream_*`, `conversation_busy`,
  `enrollment_busy`) are not counted, so retrying them costs no quota.
- New portal keys need a developer account while billing is on.
- The per-caller-IP limit is 600 requests a minute, up from 240, while
  billing is on; with billing off it stays 240.

`2026-10-08`, from `2026-09-18`:

- Every write route (create, challenge, activate, message, disconnect) answers
  again. Before this version they returned 503 in production, because the hosted
  runtime refused the gateway's forwarded requests.
- `POST /agents` for an external user whose connection was disconnected starts a
  fresh authorization with a **new** `id` (HTTP 202). The old `id` keeps
  answering `disconnected`, and nothing from it carries over.
- `GET /agents` lists newest first, and leaves out connections that a reconnect
  replaced.
- Activation refuses grants that seal more than `prepareMerryman` does with 422
  `unsupported_permission`, may answer 503 `class_vault_unavailable` (resend the
  same authorization), answers a retry after a lost response with the current
  detail instead of `challenge_used`, and succeeds with `runtime_available: false`
  when only the status read failed.
- A busy connection or owner waits before answering 409 `conversation_busy` or
  `enrollment_busy`, now with `Retry-After`; resending a message's `request_id`
  while it is still being answered returns the saved reply.
- Runtime errors keep their own codes (such as `runtime_unavailable`) instead of
  arriving as `upstream_unavailable`; `upstream_invalid_response` is new; a 413
  carries `request_id`.
- Messages that are not well-formed text or carry control characters are refused
  before any reply is generated; replies are cleaned and capped instead of
  failing, and a model that does not answer within 18 seconds (or within what
  is left of the request's 40 seconds, after any wait) yields the status
  reply.
- The SDK's `prepareMerryman` takes only `owner`, `caps`, `chainId` and
  `onStatus`, refuses a `null` chain, and exports `PARTNER_API_VERSION` and
  `SDK_VERSION`. The hosted module loads in browsers again.

## Operator configuration and key rotation

Developers issue their own keys at [merrymen.dev/api](https://merrymen.dev/api).
The site reaches the gateway's `/developer/v1` routes with
`MERRYMEN_DEVELOPER_PORTAL_SECRET`, and the wallet's signed-in session decides
which keys it may see, create or revoke. Portal and CLI keys live in the same
registry on the gateway's volume.

The key CLI remains for operator-issued keys: other scopes, a custom rate
(`--rpm`), or a key no developer wallet owns. Such a key does not appear in the
portal, is never counted against a plan, and is rotated and revoked with the
CLI. Run it on the gateway's
configured registry/volume with `MERRYMEN_GATEWAY_SECRET` available. Keys are
printed once. Pass `--scopes` explicitly: without it the CLI issues
`read:agents,read:theses,read:market`, which cannot create agents or chat. Use
a stable 12–64 character application ID:

```bash
cd gateway
node partners-cli.mjs issue --name prism --app-id prism-production \
  --scopes read:agents,write:agents,chat:agents
node partners-cli.mjs list
node partners-cli.mjs revoke OLD_KEY_ID
```

When rotating, issue the replacement with the **same `--app-id`**, deploy it to the
partner backend, verify `/meta` and an existing connection, then revoke the old
key. A different app ID is a different application and cannot access existing
connections. Older keys without `appId` use their `keyId` as their app ID; preserve
that exact value for their first rotation. A CLI revocation reaches the running
gateway within 30 seconds. Keep `MERRYMEN_GATEWAY_SECRET` stable: it also
underlies stored partner key hashes and the developer portal's session key, so
rotating it invalidates every partner key and signs every developer out. To sign
every developer out without touching partner keys (a leaked session cookie),
rotate `MERRYMEN_DEVELOPER_PORTAL_SECRET` on the gateway and the site together.
A rotation ends sessions; it does not undo what a stolen session already did.
After rotating, list each affected developer's keys (`GET /keys` in the portal,
or `node partners-cli.mjs list` on the gateway), revoke any created while the
cookie was exposed, and reissue any legitimate key it revoked.

The gateway forwards authenticated requests to hosted web using a dedicated
`MERRYMEN_PARTNER_BRIDGE_SECRET` (at least 32 bytes), configured identically on
both services. `MERRYMEN_PARTNER_APP_ORIGIN` on the gateway defaults to
`https://app.merrymen.dev`. Never distribute the bridge secret to partners.
Hosted web also needs its normal Postgres and grant-encryption configuration;
the orchestrator needs the same grant store and its worker configuration. Web
needs an LLM credential for conversational replies beyond the factual fallback.
See [hosted deployment](../docs/hosted-deploy.md#5c-partner-agent-api), which
also covers the developer portal's settings and what the gateway logs when the
bridge fails.

Partner billing (plans, payment checks and metering) is configured on the
gateway alone and is off by default. Its settings, the files it keeps on the
volume, the operator CLI (`billing-cli.mjs`) and the steps for turning it on
are in [the gateway README](README.md#partner-billing) and
[hosted deployment](../docs/hosted-deploy.md#5d-partner-api-billing).

This version does not provide public market/thesis resources, arbitrary trade
execution, agent deletion, funding transfers or a partner-wide view of other
tenants. Only the routes documented above are implemented.
