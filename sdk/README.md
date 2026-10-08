# Merrymen browser SDK

Create and authorize a hosted Merryman from inside another application. The SDK
prepares a capped session grant and verifies/signs an enrollment challenge using
the owner's wallet. Your backend calls the partner API with its private key.

## Load the module

After the SDK revision is deployed to hosted web:

```js
import {
  prepareMerryman,
  partnerGrantDigest,
  signMerrymanAuthorization,
} from "https://app.merrymen.dev/sdk/merrymen-browser.js";
```

This is an ESM browser bundle. The static module supports cross-origin loading;
the authenticated partner API remains server-to-server. For a pinned copy,
check out a reviewed repository commit, install dependencies at the repository
root (the build imports `esbuild`, a pinned devDependency) and run:

```bash
npm run build:sdk    # sdk/dist/browser.js, plus the copy hosted web serves
node sdk/build.mjs --outfile ../my-app/public/merrymen-browser.js    # that file only
```

Serve the result from your application's own assets. Without `--outfile` the
build also copies it to `web/public/sdk/merrymen-browser.js`; the normal web
build includes this step. The SDK has not been published as an npm package.

The bundle needs no Node globals. A copy built from a revision between
2026-09-19 and 2026-10-08 fails on import with
`ReferenceError: process is not defined`; rebuild it.

The module exports two version strings. `PARTNER_API_VERSION` is the partner
API contract it speaks (`2026-09-18`), the `api_version` that
`GET /partner/v1/meta` reports. `SDK_VERSION` adds the build:
`2026-09-18+<12 hex characters>`, a fingerprint of the bundle's own bytes, so
the same sources always give the same version and any bundled change gives a
new one (`+source` when running unbundled). The build prints it and writes it on
the bundle's first line, `/* merrymen-browser <SDK_VERSION> */`. Log it, and
quote it in support requests.

## Browser and backend responsibilities

Your backend first requests `POST https://ai.merrymen.dev/partner/v1/agents` with
`{external_user_id, name}`, authenticating with a server-only `mmp_` partner key.
It must derive the external user ID from its authenticated session and enforce
connection ownership on every subsequent operation.

The browser receives that connection ID and uses a viem-compatible `LocalAccount`
from your wallet integration. Show the owner the grant limits, settings and app
access, and require explicit consent before signing. An ordinary address or a
JSON-RPC wallet client alone is not this signer interface; adapt your wallet
provider's signing methods. Never construct the signer by asking the user to
paste or send an owner private key.

```js
const settings = {
  name: "Robin",
  strategy: "steady-basket",
  basket_symbols: ["AAPL", "MSFT"],
  live_trading_enabled: false,
};
const expectedScopes = ["read:agents", "chat:agents"];
const grant = await prepareMerryman({
  owner,
  chainId: 4663,
  caps: {
    perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7,
    maxDrawdownPct: 5, maxOpsPerDay: 24,
  },
  onStatus: (text) => renderStatus(text),
});

// These backend helpers are yours: they authenticate the user, verify ownership
// and call the corresponding partner endpoint with your server-only key.
const challenge = await backend.challenge(connection.id, {
  owner: grant.owner,
  smart_account: grant.smartAccount,
  chain_id: grant.chainId,
  grant_hash: partnerGrantDigest(grant),
  settings,
});
const payload = await signMerrymanAuthorization({
  owner, grant, challenge, settings,
  expectedAppId: YOUR_CONFIGURED_APP_ID,
  expectedAgentId: connection.id,
  expectedExternalUserId: YOUR_AUTHENTICATED_USER_ID,
  expectedScopes,
});
const result = await backend.activate(connection.id, payload);
```

`prepareMerryman` performs wallet/chain setup and returns a signed `StoredGrant`.
It does not call the partner API, start a worker, fund an account, persist the
grant or perform wallet backups. It takes exactly these options:

- `owner`: the signer, with `signTypedData` and `signMessage`. Here it is asked
  for exactly one EIP-712 typed-data signature, the permission itself;
  `signMerrymanAuthorization` later asks for one message signature. Nothing
  else is ever requested.
- `caps`: exactly `perTradeUsdg`, `dailyUsdg`, `expiryDays`, `maxDrawdownPct`
  and `maxOpsPerDay`, each a finite number of at least 1. `perTradeUsdg` must
  not exceed `dailyUsdg`, `maxDrawdownPct` must not exceed 100, `expiryDays` is
  a whole number up to 365 and `maxOpsPerDay` a whole number. Fractional USDG
  amounts and drawdowns are fine.
- `chainId`: `4663` (Robinhood Chain, real funds) or `46630` (its testnet).
  Omitted or `undefined` means `4663`. Anything else, `null` and the string
  `"46630"` included, is refused rather than signed for mainnet.
- `onStatus` (optional): progress text, starting with
  `deriving your smart account…`; the last status arrives just before the
  signature request.

Any other option set to a value other than `undefined` is refused,
`trencherFactory`, adapter addresses, `ponsClassVaultFactory`, `extraTokens`
and renewal options included: partner enrollment seals only the platform's own
routes and listed coins, and grants no Trencher permission. Every refusal (an
unknown option, a chain, limits activation would refuse, an owner that is not
a signer) is thrown before any chain read, `onStatus` call or signature
request; the first three say "Nothing was signed." A grant it returns
activates unmodified, while activation refuses one that seals anything more.

`partnerGrantDigest` hashes the canonical grant. `signMerrymanAuthorization`
checks the exact app, connection, user, access scopes, owner, smart account,
chain, grant, settings, expiry and message before signing. The expected values
must come from the user's choices and your established application state, not
from the untrusted challenge itself.

The activation payload includes a session private key for the delegated capped
permissions. Send it only over HTTPS and exclude it from logs, analytics and
error reporting. The owner's private key stays in their wallet. Finish your
wallet provider's recovery/backup flow before enabling the agent.

Activation returns a connection status and `wallet: {smart_account, chain_id}`.
If its response is lost, your backend may resend the same payload within the
challenge's five minutes and gets the completed result, with nothing applied
twice. The account still needs funds; poll connection detail for a fresh worker
heartbeat. A chat reply may include a proposal, but chat does not execute it.
App disconnection removes app access and leaves the owner's worker running;
connecting that user again creates a new connection ID and needs the owner's
authorization again.

See the [complete partner API contract](../gateway/PARTNER-API.md) for endpoint
bodies, status semantics, scopes, challenge expiry, funding and retry behavior.
