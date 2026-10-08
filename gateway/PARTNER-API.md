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
and create a key for your application. Copy the key immediately: it is shown
only once. The portal includes an SDK download, integration tutorial, and a
real authenticated key test. Each developer can have five active keys at
30 requests per minute each, and may request at most ten new keys an hour.
Replacement keys retain the app identity; update your backend before revoking
the previous key.

Sign-in is a free message signature from a standard wallet (an EOA). The
signature is checked on the gateway itself, with no chain lookup, so
smart-contract wallets (a Safe, a passkey or ERC-4337 account) cannot sign in;
use an ordinary wallet's key. A portal session lasts up to eight hours. Signing
out clears it in your browser and asks the gateway to revoke it; if that
request fails, the session stays valid until it expires. A gateway restart can
end a session early: sign in again. Your keys are unaffected either way.

Operators can also issue keys with the gateway CLI (see
[Operator configuration](#operator-configuration-and-key-rotation)). Such a key
may carry different scopes or a different quota; `/meta` reports what it has.

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

The response contains `key_id`, `app_id`, `name`, `scopes`, `rate_per_min` and
`api_version`. The current contract version is `2026-09-18`. Use your trusted
application configuration for `app_id`; do not accept it from a browser request.

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
`caps` that activation would refuse. A grant it makes, passed on unmodified, is
never refused as `unsupported_permission` (see below). The owner signs twice in
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
another is generating waits, up to about 20 seconds; a retry of the request
being generated then gets its saved reply. The hosted runtime also generates
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

## Errors and retries

Errors use one envelope:

```json
{"error":{"code":"forbidden_scope","message":"...","request_id":"req_..."}}
```

Preserve `request_id` when reporting failures. For a request the hosted runtime
refused or could not answer, the gateway logs a line with this ID. Refusals the
gateway makes itself (key, scope, rate limit, body size, unknown route) are not
logged; report those with their code and time. Missing, unrecognized-format
and holder credentials return 404; a correctly formatted partner key with an
unknown ID or incorrect secret returns 401. Revoked keys return 401
`key_revoked`, and missing scopes return 403 `forbidden_scope`. Other expected
cases include invalid input (400/422), unavailable authorization or conflicting
identities (403/409), rate limits (429), and an unavailable hosted runtime or
storage (503). Check the code rather than matching prose.

A body over 32 KiB (256 KiB for `/activate`) is refused with HTTP 413
`bad_request`, which carries a `request_id` like any other error. Past 4 MiB
the gateway drops the connection, so expect a reset rather than an answer. The
gateway waits up to 45 seconds for the hosted runtime; give your own HTTP
client a longer timeout than that.

The codes that call for a retry, and how:

| Code | Status | What to do |
| --- | --- | --- |
| `rate_limited` | 429 | Back off with jitter. |
| `upstream_unavailable` | 503 | No complete answer from the hosted runtime (unreachable, timed out, or misconfigured). Back off and retry; writes are safe to resend as described above. |
| `upstream_invalid_response` | 503 | The runtime answered, but not with its JSON envelope (a proxy or error page). Back off as for `upstream_unavailable`, and report the `request_id` if it persists. |
| `runtime_unavailable` | 503 | The worker's state could not be read. Retry later. |
| `conversation_busy`, `enrollment_busy` | 409 | The same connection or owner is busy, or the runtime is at its concurrency limit. Resend the same request unchanged after `Retry-After` / `error.retry_after` seconds. |
| `class_vault_unavailable`, `derivation_unavailable` | 503 | A chain read failed before the authorization was spent. Resend the same activation within the challenge's five minutes. |
| `enrollment_storage_failed` | 503 | Inspect the connection, then start a fresh challenge. |

Each key's quota is `rate_per_min` from `/meta`: 30 for self-service keys, and
120 unless set otherwise for operator-issued ones. Each caller IP also has 240
per minute. Poll with a modest interval. Do not retry a wallet authorization
except as described under [activation](#3-challenge-and-activation-endpoints),
change the body under a message request ID, or treat `/health` as worker
health.

`GET /partner/v1` discovers the surface and `GET /partner/v1/health` checks gateway
liveness without authentication. `GET /healthz` is also process liveness. Neither
proves a valid grant, a running worker, configured chat or a reachable bridge.

## Operator configuration and key rotation

Developers issue their own keys at [merrymen.dev/api](https://merrymen.dev/api).
The site reaches the gateway's `/developer/v1` routes with
`MERRYMEN_DEVELOPER_PORTAL_SECRET`, and the wallet's signed-in session decides
which keys it may see, create or revoke. Portal and CLI keys live in the same
registry on the gateway's volume.

The key CLI remains for operator-issued keys: other scopes, a custom quota
(`--rpm`), or a key no developer wallet owns. Such a key does not appear in the
portal and is rotated and revoked with the CLI. Run it on the gateway's
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

This version does not provide public market/thesis resources, arbitrary trade
execution, agent deletion, funding transfers or a partner-wide view of other
tenants. Only the routes documented above are implemented.
