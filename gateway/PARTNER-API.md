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
30 requests per minute each. Replacement keys retain the app identity; update
your backend before revoking the previous key.

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

`external_user_id` is 1–128 characters with no whitespace or control characters.
The optional display `name` is 1–64 characters. A pending connection returns
HTTP 202, including:

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

Creation is scoped to `(app_id, external_user_id)`: repeating it returns that
connection, rather than another worker. An already linked connection returns
HTTP 200. Store `id` on your server. It is the partner connection ID, not the
worker's slug. The optional `onboarding_url` is unnecessary for the embedded flow.

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
dependencies and run `npm run build:sdk`. Serve `sdk/dist/browser.js` from your
own assets. This SDK is not yet a published npm package; do not assume an npm
package/version is available. See [the SDK guide](../sdk/README.md).

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

`settings.name` must be 1–24 characters; `strategy` is `steady-basket` or
`llm-strategist`; `basket_symbols` contains 1–10 supported stock symbols;
`live_trading_enabled` must be an explicit boolean. Use clean, unique symbols and
an already trimmed name so the server's normalized settings match what you show
and sign. Supported enrollment chains are Robinhood mainnet `4663` and testnet
`46630`; fund and use the same chain selected for the grant.

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
Activation is not a claim that the worker is already running. After an ambiguous
timeout, inspect the connection before retrying; an enrollment retry may need a
fresh challenge and owner signature because the original nonce is single-use.

## Runtime status, funding and chat

`GET /agents` returns `{data: [...]}` for up to 100 of your app's connections.
There is no pagination contract yet. This list is a connection summary: a status
of `connected` does not prove worker health. Use `GET /agents/{id}` for current
worker state; only your app's authorized connection can resolve its tenant.

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

Messages are 1–2000 characters. `request_id` is 8–128 letters, digits, underscores
or hyphens. Generate one per logical message and reuse it for transport retries.
The same ID and text returns the saved response; a different text with that ID
returns HTTP 409 `idempotency_conflict`.

Chat uses the actual tenant's portfolio, positions, recent trades, settings and
worker state, with persisted conversation context. If an LLM is unavailable,
the response falls back to a factual status response. A non-null `proposal`
describes a suggested command; it **does not execute** a trade or change settings.

`GET /agents/{id}/messages` returns `{agent_id, messages}` in chronological order.
Each message has `role`, `content`, `requestId` and `createdAt`; assistant messages
may also have `command`. These history fields are camelCase. The store retains
the latest **40 exchanges** (80 messages); idempotency protection lasts only
while the corresponding exchange is retained. Do not reuse old request IDs.

`DELETE /agents/{id}/connection` revokes this app's access. It does not stop the
worker, revoke the owner's trading grant or withdraw funds. Expose those actions
as separate owner controls if your product needs them; they are not partner API
routes in this version.

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

Preserve `request_id` when reporting failures. Missing, unrecognized-format and
holder credentials return 404; a correctly formatted partner key with an unknown
ID or incorrect secret returns 401. Revoked keys return 401 `key_revoked`, and
missing scopes return 403 `forbidden_scope`.
Other expected cases include invalid input (400/422), unavailable authorization
or conflicting identities (403/409), rate limits (429), and an unavailable
hosted runtime or storage (503). Check the code rather than matching prose.

Default quotas are 120 requests per key per minute and 240 per IP per minute; a
key can have a custom quota reported by `/meta`. Poll with a modest interval and
back off with jitter on 429/503. Do not blindly retry wallet authorization,
change the body under a message request ID, or treat `/health` as worker health.

`GET /partner/v1` discovers the surface and `GET /partner/v1/health` checks gateway
liveness without authentication. `GET /healthz` is also process liveness. Neither
proves a valid grant, a running worker, configured chat or a reachable bridge.

## Operator configuration and key rotation

Run the key CLI on the gateway's configured registry/volume with
`MERRYMEN_GATEWAY_SECRET` available. Keys are printed once; no HTTP endpoint issues
them. Use a stable 12–64 character application ID:

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
that exact value for their first rotation. Keep the gateway HMAC secret stable,
since it also underlies stored partner key hashes.

The gateway forwards authenticated requests to hosted web using a dedicated
`MERRYMEN_PARTNER_BRIDGE_SECRET` (at least 32 bytes), configured identically on
both services. `MERRYMEN_PARTNER_APP_ORIGIN` on the gateway defaults to
`https://app.merrymen.dev`. Never distribute the bridge secret to partners.
Hosted web also needs its normal Postgres and grant-encryption configuration;
the orchestrator needs the same grant store and its worker configuration. Web
needs an LLM credential for conversational replies beyond the factual fallback.
See [hosted deployment](../docs/hosted-deploy.md#5c-partner-agent-api).

This version does not provide public market/thesis resources, arbitrary trade
execution, agent deletion, funding transfers or a partner-wide view of other
tenants. Only the routes documented above are implemented.
