# Merrymen AI gateway

The holder perk, done safely: a tiny server that lets **verified $MERRYMEN holders**
run their agent's brain with **no API key and no signup** — while your upstream key
stays server-side and never ships in the (open-source) client.

## Why a gateway (and not "just ship our key")

merrymen is open source and self-hosted. Any key baked into the package is readable
by everyone who installs it — it would be scraped and abused within hours, blow your
rate limits, and get banned. So the client never holds the key. Instead:

```
holder ──GET /nonce──▶ single-use challenge ──sign──▶ /claim ──balanceOf──▶ token ──▶ paste into merrymen
merrymen ──Bearer token──▶ /v1/chat/completions ──your key──▶ upstream LLM ──▶ reply
```

- The upstream key lives only in `MERRYMEN_GATEWAY_UPSTREAM_KEY` (env). Never logged, never sent to the client.
- Access tokens are **HMAC-signed and expiring** (stateless — no database).
- The claim uses a **server-issued, single-use, domain-bound nonce** (5-min TTL): the message a holder signs names the domain + a one-time nonce, so a captured signature **can't be replayed** or pre-collected, and responses carry **no wildcard CORS** so a phishing page can't read a minted token.
- Every request **re-checks the wallet's on-chain $MERRYMEN balance** (cached 10 min, bounded size), so a holder who sells loses access.
- **Per-address rate limit** on `/v1`, **per-IP rate limit** on `/nonce` + `/claim`, a hard completion clamp (`max_tokens` + `max_completion_tokens`, `n`/`best_of` pinned), and a body-size cap bound cost and abuse.
- The gateway **forces its own model** server-side — the client can't run up an expensive one and never even learns which model it is (it's branded `merrymen-fast`).

Signing is **read-only proof of control** — no transaction, no private key ever leaves the holder's wallet. Fully in keeping with merrymen's non-custodial stance.

## Discovery too: `POST /bitquery`

Same perk, same claimed token, second upstream. Set `MERRYMEN_GATEWAY_BITQUERY_KEY`
and holders get Bitquery — which indexes Robinhood Chain from genesis and decodes
**Uniswap v4**, where new pairs actually launch — without a Bitquery account of
their own. Leave it unset and the route returns 503; nothing else changes.

**This route does not proxy GraphQL, and that is the whole point.** Bitquery bills
by query cost and GraphQL is unbounded by construction: one caller asking for
every event since genesis, unfiltered, is a five-figure invoice against *your*
account. `max_tokens` was enough to bound the LLM route; there is no equivalent
knob here, because the expensive part *is* the query.

So the client sends a **name**, not a query:

```bash
curl -s https://ai.merrymen.dev/bitquery \
  -H "authorization: Bearer mmk_…" \
  -H 'content-type: application/json' -d '{"query":"recentPools","variables":{"sinceMinutes":60,"limit":25}}'
```

- The catalogue in `lib/core.mjs` (`BITQUERY_QUERIES`) **is** the attack surface.
  Every query is written there, every variable is clamped there, and a caller can
  ask for nothing that isn't in it. `GET /bitquery` lists the names.
- Adding a capability is a deliberate edit by whoever runs the gateway.
- Discovery has its **own, tighter rate bucket** (`BITQUERY_RATE_PER_MIN`, 6/min
  per wallet) — it's polled by a worker on a timer, not driven by a human typing,
  so sharing the chat allowance would let a background feed starve the brain.
- Upstream error bodies are **not** relayed; they can quote the request, and the
  request carries your key on the way out.

`node selftest.mjs` asserts all of it offline: unsigned tokens rejected, raw and
hostile queries (including `__proto__`, `constructor`) rejected by name lookup,
503 when no key is configured, and the rate bucket biting.

## Which host is live right now

**`https://ai.merrymen.dev`** serves the Railway gateway. TLS and
`GET /healthz` were verified on 2026-09-18; Railway reports the existing custom
domain verified with a valid certificate. The alternate
`https://merrymen-gateway-production.up.railway.app` hostname also remains usable.

The partner API is at **`https://ai.merrymen.dev/partner/v1`**. It uses separate
server-only partner keys and supports agent authorization, status and chat; see
[the integration guide](PARTNER-API.md). Developers issue those keys themselves
at `https://merrymen.dev/api`, which reaches this gateway's `/developer/v1`
routes; operators can still issue keys with `partners-cli.mjs`. The browser SDK
is served by hosted web at `https://app.merrymen.dev/sdk/merrymen-browser.js`
after this revision is deployed.

DNS is managed in Vercel, while the application and certificate are served by
Railway. The domain uses the existing gateway service, target port 8080:

| name | type | value |
| --- | --- | --- |
| `ai` | CNAME | `aqeqwooj.up.railway.app` |
| `_railway-verify.ai` | TXT | the current verification token shown by Railway for this domain |

The previous TLS failure was repaired by adding the missing ownership TXT,
aligning the CNAME and requesting certificate issuance on the existing domain.
Do not delete/recreate a working domain to refresh it. After DNS or service
changes, check Railway's verification/certificate status and confirm
`curl https://ai.merrymen.dev/healthz` returns `{"ok":true}` with ordinary TLS
validation.

Three hand-written client origins must agree when changing their preferred host:

| where | constant |
| --- | --- |
| `packages/core/src/token.ts` | `MERRYMEN_GATEWAY_ORIGIN` — the merrymen client |
| `site/lib/gateway.ts` | `GATEWAY_ORIGIN` — the memescope page |
| `cli/bin.mjs` | the `merrymen` provider's `key` hint, shown during onboarding |

There is no shared import that could enforce that: the website doesn't compile
the TS core and the CLI is plain ESM that can't import TypeScript at all. So
`worker/src/gateway-origin.test.ts` fails the suite if the three ever disagree —
run `npm test` after changing any of them.

## Two ways to run it

The holder gateway security logic lives once in `lib/core.mjs`; two thin runtimes
wrap it: `server.mjs` (a long-lived process) and `api/*.js` (Vercel serverless
functions). The partner routes run in `server.mjs`; use that runtime for the full
API. Production uses Railway.

### A) Persistent process (Railway / Fly / Render / VPS / Docker) — RECOMMENDED

```bash
cd gateway
cp .env.example .env      # fill in UPSTREAM_KEY, SECRET, RPC (+ BITQUERY_KEY for discovery)
npm install
npm run check             # offline self-test (tokens, single-use nonces, replay, /bitquery)
npm start                 # listens on :8787
```

**Railway**, concretely — `railway.json` is committed, so it builds from the
Dockerfile and health-checks `/healthz`:

```bash
railway init && railway up
```

That is the path for a **fresh** install, and it is still the fallback if a repo
build ever goes wrong. The live `merrymen-gateway` service no longer uses it:
it is sourced from `millw14/merrymen` on `main` and redeploys itself when
anything under `gateway/` changes. Three service settings make that work, and
each of them fails silently if it is missing — `docs/hosted-deploy.md` §5b has
the table and the reasoning:

| | |
|---|---|
| Root Directory | `/gateway` |
| Config-as-code path | `/gateway/railway.json` |
| Watch Paths | `/gateway/**` |

Deploying by hand is what let this service sit several commits behind `main`
while a fix looked shipped, so prefer a push. If you must, `railway up` from
**this directory** — never from the repo root, which would upload the whole
monorepo and build the dashboard image into this service.

Then set the variables in the Railway dashboard (**not** in the repo):
`MERRYMEN_GATEWAY_UPSTREAM_KEY`, `MERRYMEN_GATEWAY_SECRET` (32+ random bytes),
`MERRYMEN_GATEWAY_RPC`, `MERRYMEN_GATEWAY_BITQUERY_KEY`, and
`MERRYMEN_GATEWAY_DOMAIN` set to the host you actually serve on. The partner API
and developer portal also need `MERRYMEN_PARTNER_BRIDGE_SECRET` and
`MERRYMEN_DEVELOPER_PORTAL_SECRET`, each shared with one other service; the
gateway logs at boot when either is unset or under 32 bytes, and
`docs/hosted-deploy.md` §5c has the table. Point `ai.merrymen.dev` at the
Railway service. Partner billing has its own variables, all optional and off
by default: see [Partner billing](#partner-billing) below.

A single process needs no Redis — the in-memory store is correct and atomic for
one instance. **If you scale past one replica, set `KV_REST_API_URL`/`TOKEN`**,
or nonce single-use and rate limits become per-instance and stop meaning what
they say. One cost of memory: developer portal sessions are bound to the
process, so every restart or deploy signs developers out (signing in again
takes one wallet signature). With KV, sessions and their logouts survive.
**Partner billing is the exception: it runs on exactly one instance, KV or
not** (see [Partner billing](#partner-billing)).

A `Dockerfile` (universal) and `render.yaml` (Render Blueprint) are included for a
connect-the-repo deploy. In-memory state is fine here (one process); set
`KV_REST_API_URL`/`KV_REST_API_TOKEN` if you run multiple instances, or to keep
developer portal sessions across deploys. `render.yaml` gives the service no
persistent disk and does not set `MERRYMEN_DATA_DIR`: never turn partner
billing on there.

### B) Vercel serverless (optional holder gateway runtime)

This option serves the holder claim/inference endpoints. The `api/*.js`
functions do not implement `/partner/v1`. Production `ai.merrymen.dev` uses
Railway; managing its DNS in Vercel does not make it a Vercel deployment.

Serverless isolates don't share memory, so the nonce/rate-limit/balance state MUST
live in a KV store — this is a hard requirement (the functions refuse to start
without it). `vercel.json` maps the clean URLs (`/nonce`, `/claim`, `/v1/…`) to the
functions in `api/`.

1. Vercel → **New Project** → import `millw14/merrymen`, set **Root Directory = `gateway`**.
2. Add a KV store: Vercel dashboard → **Storage → Upstash Redis** (or KV). It sets
   `KV_REST_API_URL` + `KV_REST_API_TOKEN` on the project automatically.
3. Add the three secrets as env vars: `MERRYMEN_GATEWAY_UPSTREAM_KEY`,
   `MERRYMEN_GATEWAY_SECRET` (≥32 bytes), `MERRYMEN_GATEWAY_RPC` (+ optional
   `MERRYMEN_GATEWAY_DOMAIN=ai.merrymen.dev`).
4. **Deploy.** Confirm against the host Vercel gives you:
   `curl https://<your-deployment>/healthz` → `{"ok":true}`. Configure a separate
   custom hostname if needed. Moving the production hostname away from Railway
   would also require migrating the partner runtime.

### Endpoints
- `GET /` or `/claim` — the claim page (holder connects wallet, signs, gets a token).
- `GET /nonce?address=0x…` — mint a single-use, domain-bound challenge → `{nonce, message}` (sign `message` verbatim).
- `POST /claim` — `{address, signature, nonce}` → `{token, expiresInDays}` after nonce + signature + balance checks.
- `POST /v1/chat/completions` — OpenAI-compatible; `Authorization: Bearer <token>`. This is what merrymen calls.
- `GET /healthz` — liveness.
- `/partner/v1/*` — the partner API ([PARTNER-API.md](PARTNER-API.md)); `GET /partner/v1/health` is the gateway's own liveness and never calls hosted web.
- `/developer/v1/*` — key management, developer accounts, plans and payment checks for the merrymen.dev portal, callable only with the portal's secret.

The last two run only in `server.mjs`.

## Partner billing

Developers pay for partner API plans in $MERRYMEN. They create a developer
account at merrymen.dev/api, choose a plan (`lib/billing-plans.mjs`: Free, then
Crumbs, Loaf and Feast per 30 days) and send $MERRYMEN **from the wallet they
signed in with** to a dedicated payments address, the treasury. The gateway
checks each transfer on chain **read-only**: it never sends a transaction and
holds no key. It keeps accounts, payments and charges in an append-only
ledger, and counts every partner request made with a portal key against its
account's plan. What partners see (quotas, headers, the 402, renewals and
upgrades) is in [PARTNER-API.md](PARTNER-API.md#plans-and-billing); the
hosted rollout is in
[`docs/hosted-deploy.md` §5d](../docs/hosted-deploy.md#5d-partner-api-billing).

**Before a production treasury is set, the owner must update the site's Terms
of Use and Privacy Policy.** Setting the treasury opens the pay flow on
merrymen.dev/api, and today both pages contradict it (Terms §6 says no money
moves to us). §5d lists every conflict.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `MERRYMEN_BILLING` | `off` | `off`, `observe` or `enforce`. Any other value is off, and is logged. |
| `MERRYMEN_DATA_DIR` | `/data` | Billing (observe or enforce) needs it **set explicitly** to a persistent, writable volume that is already there. Left to the default, missing, or on the container's own disk, billing is off. |
| `MERRYMEN_DATA_DIR_PERSISTENT` | unset | `1` lets billing use a `MERRYMEN_DATA_DIR` on the same disk as `/` (a VM whose own disk survives a redeploy, or local development). Never set it on a container host: there that disk is wiped on every deploy. |
| `MERRYMEN_PAYMENTS_TREASURY` | unset | The address payments go to. A **new address used for API billing and nothing else**: any $MERRYMEN transfer to it from a wallet that has, or later creates, a developer account, at or after the start block, can be credited to that account. The gateway never needs its key, so a multisig or cold wallet is fine. Not the zero address or the token contract (either is ignored, and logged). Unset: payments answer 503 `payments_unavailable` and `GET /developer/v1/plans` shows `treasury: null`. |
| `MERRYMEN_PAYMENTS_START_BLOCK` | unset | Required with a treasury; without it (or with something that is not a block number) the treasury is ignored. Transfers in earlier blocks are never credited, so nothing that reached the address before payments opened can be claimed. Use the chain's current block when you first set the treasury. |
| `MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES` | empty | Comma-separated addresses still accepted as recipients after a rotation. Unusable entries are ignored (logged); duplicates and the current treasury are dropped; the list is ignored without a treasury. Each payment records the address it matched. |
| `MERRYMEN_PAYMENTS_RPC` | `MERRYMEN_GATEWAY_RPC` | The RPC payment checks read: the receipt, the latest block and the receipt's block. |
| `MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS` | `64` | How many blocks deep a transfer must be (at least 1). |
| `MERRYMEN_PAYMENTS_MIN_AGE_SEC` | `120` | How many seconds old a transfer must be, on this host's clock (at least 0). A transfer is credited only when both hold; Robinhood Chain makes about ten blocks a second, so the age usually decides. |

A number that does not parse falls back to its default, and boot logs it.

What each mode does, and what it falls back to:

- **off**: nothing is metered, every key keeps its own per-key rate, and
  this gateway mints keys without an account, as before billing (the site's
  console still asks a developer to create an account before a new key, since
  this gateway answers `account_missing`). Developers can still create
  accounts and read `GET /developer/v1/plans`; choosing a plan and submitting
  a payment answer 503 `billing_off`.
- **observe**: accounts, plans, payments and metering all work, and partners
  get the quota headers and `/meta`'s `billing`, but no quota is refused, and
  each key keeps its own per-minute bucket at its own rate or its plan's,
  whichever is higher. New keys need an account (409 `account_required`), so
  turn observe on only once the merrymen.dev build that creates accounts is
  live: `GET https://merrymen.dev/api/developer/account`, signed in, must
  answer 404 `account_missing` (or the account), not a bare `Not found`. An
  older site has no way to create one, and its developers could not mint a
  key. Without a treasury, payments answer 503 `payments_unavailable`.
- **enforce**: a spent quota answers 402 `quota_exhausted`, and an account's
  keys share one per-minute bucket at its plan's rate (Free: 30 a minute for
  all of a developer's keys together). Without a treasury and start block it
  runs as observe, and boot says so.
- The partner per-IP limit is 600 a minute under observe and enforce, above
  every plan's rate; with billing off it stays 240, as before billing.

### One instance, on a persistent disk

`billing.jsonl` is the only record of who paid. On a disk a deploy wipes (the
default `/data` with no volume, `render.yaml`'s service), every transfer ever
credited could be credited again. So observe and enforce need
`MERRYMEN_DATA_DIR` set explicitly, to a directory that already exists (billing
never creates it), on another filesystem than `/` (a mounted volume, or a
directory inside one) unless `MERRYMEN_DATA_DIR_PERSISTENT=1`, and writable
(boot writes a probe file); otherwise billing is off and boot says why. So
`MERRYMEN_DATA_DIR=/data` copied onto a service whose volume is detached, or
onto a host with no disk, leaves billing off rather than writing a ledger the
next deploy wipes; account creation is refused too (503 `billing_unavailable`)
while billing was asked for and the storage refused it. Back the file up with
the volume.

Run billing on **one instance only**: never replicas, and never a host without
a persistent disk. Two processes on one ledger keep two indexes and would each
credit the same transfer; shared KV does not change that. A second gateway
appending to the same ledger is noticed within 10 s (it writes record types
the operator CLI never writes): its records are kept out of the index and
billing writes stop until restart.

### Files in `MERRYMEN_DATA_DIR`

| File | What it is |
| --- | --- |
| `billing.jsonl` | The ledger: one JSON record a line (`account`, `select`, `payment`, `charge`, `reversal`, `adjustment`, `config`), each flushed by the append that wrote it and at most 4 KiB. Replayed once at boot. Replay enforces the money rules itself: a transfer is credited once per (chain, transaction, sender), and a repeated record or charge id is ignored. A charge records the cost, quota and rate it was charged at, so editing `lib/billing-plans.mjs` never changes a period already paid for. A torn last line is cut before the next append. |
| `usage.json` | Request counts per usage window, written whole and renamed into place. Under enforce, a counted request is served only once a write covering its count has landed (requests arriving together share one write), so a crash forgets no served request; a count that has not landed within 2 s is given back and refused with 503 `billing_unavailable`. Observe writes soon after, without waiting. Give-backs for platform failures are saved by the next write, the 10 s timer or shutdown. Windows that ended more than 30 days ago are dropped. If it is unreadable, counts start empty and boot says so. |
| `partners.jsonl` | The key registry, as before. Its torn tail is now cut before each append too. |
| `billing.jsonl.lock`, `partners.jsonl.lock` | Held for each repair-and-append, by the gateway and by both CLIs, so one never cuts a line the other is still writing. A lock older than 10 s (a writer that died mid-append) is removed. An append that cannot take the lock within 5 s is refused with nothing written: the developer API answers 503 `billing_unavailable` for `billing.jsonl` and 503 `unavailable` for `partners.jsonl` (key create or revoke), and the CLI says to run the command again. |

When the ledger cannot be trusted, billing **writes** stop (503
`billing_unavailable`) while reads and metering carry on from the records
before the problem:

- A complete line that cannot be read, or a charge larger than everything the
  account paid or was granted, logs `[billing] LEDGER CORRUPT at billing.jsonl
  line N: …`. Back the file up, repair it by hand, then restart: nothing
  else clears this, and the CLI refuses to write to it meanwhile.
- A failed append logs `[billing] ledger append failed (…)`. The torn line is
  cut and writes resume; if that repair fails, it is retried on the next write
  and every 10 s.

Billing time is this host's clock, or the ledger's newest record when that is
at most 5 minutes ahead (a clock step back does not reopen ended periods). A
record further ahead logs `[billing] CLOCK: …` and billing time is held at
most 5 minutes ahead of the clock: check the host's clock.

### Payments: the treasury and the RPC

- **Dedicated treasury.** Never reuse an address that receives anything else.
- **Rotation.** Set `MERRYMEN_PAYMENTS_TREASURY` to the new address, move the
  old one into `MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES`, and leave the start
  block alone: it applies to every accepted address, and raising it would make
  transfers already sent to the old address uncreditable. Each boot where the
  treasury, the previous list or the start block changed appends a `config`
  record to the ledger and logs `[billing] PAYMENTS CONFIG RECORDED: …`. If the
  ledger cannot take it at boot (say a lock left by the old process, killed
  mid-append), boot logs `could not record the payments config` and the record
  is written within 10 s; until it is, every other ledger write is refused
  (503 `billing_unavailable`), so nothing lands under an unrecorded treasury. The
  console reads the treasury again before each wallet payment, but someone who
  copied the old address by hand is not protected: keep it in the previous
  list for a while. A transfer to an address no longer accepted can be
  credited by hand with `billing-cli adjust`, after checking it on the
  explorer.
- **The RPC** is a separate client from the holder gate's, with no retries, no
  cache and 10 s a read. It must answer `eth_chainId` 4663, checked at boot,
  before each credit and before each reconciliation. On any other chain,
  payments are unavailable, but the mode is not changed: under `enforce`,
  quotas are still refused while nobody can pay. Check the boot line.
  If it cannot be reached at boot, that is logged, and the check happens
  before each credit. It is trusted to report receipts truthfully: one that
  lies can give away API usage, never move anyone's tokens. Its URL is never
  logged and its error text is never relayed. Developer sign-in never uses it.
- **Reconciliation.** Every 5 minutes, payments credited in the last 30
  minutes are read again. One whose receipt is gone while the block that held
  it has been replaced, that sits in a different block (one the RPC confirms
  on its own), that now reverts or that moved a different amount is suspect,
  logged `[billing] … looks <why>: checking it again before reversing`. Only
  when the next run, five minutes on, finds the same does it get a
  `reversal`, logged `[billing] PAYMENT REVERSED: …`; a suspect is checked
  again even past its half hour. A read where the RPC disagrees with itself
  (no receipt but the same block, or a receipt whose block reads back with
  another hash: a lagging receipt index, or a load balancer's other node)
  decides nothing. A reversed amount leaves the credit, possibly below zero;
  the running plan goes on, and nothing is charged until the shortfall is
  covered. A transfer that lands again in a later block is credited again
  when its hash is submitted again: the console offers that on the reversal.

### What the log says

At boot, one `[billing] <reason>` line per setting that is missing or
unusable, then one of:

```
[gateway] partner billing: off, nothing is metered
[gateway] partner billing: observe, metered, no quota refused, each key at its own rate or its plan's if higher; payments to 0x…
[gateway] partner billing: enforce, quotas enforced; payments to 0x…
```

These go to stdout. The line goes to stderr instead, and says more, when the
mode is not what `MERRYMEN_BILLING` asked for (`(MERRYMEN_BILLING="enforce";
see the [billing] lines above)`), when payments are `UNAVAILABLE`, or when
ledger writes are `REFUSED (<why>)`. Boot waits up to 10 s for the payments
RPC's chain id; `railway.json`'s 30 s health-check timeout covers it.

While running: `[billing] <wallet> paid N MERRYMEN in 0x…`, `[billing]
<wallet> activate|renew|upgrade <tier>: N MERRYMEN of credit used`, and the
warnings above (`LEDGER CORRUPT`, `ANOTHER PROCESS APPENDED`, `PAYMENT
REVERSED`, `CLOCK`, `ledger append failed`).

### Shutdown

On SIGTERM or SIGINT the gateway logs `[gateway] SIGTERM: saving usage counts,
then exiting`, stops taking connections and gives requests in flight up to
3 s. A partner request still running then is cut off and its unit given back
(the partner never gets that answer, so it should resend), and the log says
how many. Queued billing writes then finish (5 s at most), `usage.json` is
saved, and the process exits 0. A second signal exits 1 at once, and a
shutdown still going after 10 s exits 1. Give the process that long before
SIGKILL (on Railway, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` of 12 or more), or
a deploy can charge partners for the requests it cut off (served counts are
already on disk under enforce). The ledger needs nothing at shutdown: every
record is flushed by the append that wrote it.

### Operator CLI: `billing-cli.mjs`

It ships in the image (the Dockerfile's `COPY` line; `image.test.mjs` fails
if it is left off). Run it where the gateway runs, on its volume and with its
environment, so it reads the same `$MERRYMEN_DATA_DIR/billing.jsonl` (on
Railway, `railway ssh` into the gateway service; the image's directory is
`/app`):

```bash
node billing-cli.mjs list                                      # every account: plan, period end, credit, selection
node billing-cli.mjs show <wallet>                             # one account: plan, credit, due, usage by key, history
node billing-cli.mjs adjust <wallet> <±tokens> --note "why"    # correct API credit, e.g. +25000 or -100.5
node billing-cli.mjs comp <wallet> <tier> <days> --note "why"  # a paid tier at no charge, 1–365 days
node billing-cli.mjs reconcile [--all]                         # dry run of the payment re-check; writes nothing
```

- Every write needs `--note` (one line, at most 500 characters). It stays in
  the ledger; the developer never sees it.
- `adjust` and `comp` need the developer to have created an account at
  merrymen.dev/api. Neither moves any tokens: an adjustment changes API
  credit only.
- `comp` starts now and is refused while a period the developer paid for is
  running (it prints the tier and end date and writes nothing): comp after
  that date, or credit tokens with `adjust` instead. A comp longer than 30
  days gets one plan quota for its whole length. When a comp ends, its tier
  renews only if the developer selects it and has the credit.
- `reconcile` needs `MERRYMEN_PAYMENTS_RPC` or `MERRYMEN_GATEWAY_RPC`; `--all`
  re-checks every payment, not only the last 30 minutes'. The gateway makes
  any reversal itself.
- Writes go through the gateway's own ledger writer, under the same lock. The
  running gateway picks up an adjustment or a comp within 10 s, and before
  any charge it makes for that account.

## The holder experience

1. Holder opens `https://ai.merrymen.dev/claim`, connects their wallet, signs (free).
2. Gateway checks they hold ≥ `MERRYMEN_GATEWAY_MIN_TOKENS` and returns a key.
3. In merrymen → **Settings → AI provider → Merrymen AI**, they paste the key. Done — chat + the strategist now run on your dime, no third-party signup.

## Costs & limits (read before you flip it on)

You are paying for holders' inference. Protect yourself:
- Keep `MERRYMEN_GATEWAY_MIN_TOKENS` meaningful, and `RATE_PER_MIN` / `MAX_COMPLETION_TOKENS` conservative (defaults in `lib/core.mjs`).
- Groq's **free tier is per-key rate-limited** — a shared free key will throttle fast under many holders. Use a paid plan, or expect holders to queue.
- State (nonces, rate limits, balance cache) lives in `lib/store.mjs`: in-memory for a single process, or a shared KV (Upstash/Vercel KV) when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are set. On serverless the KV is **required** (isolates don't share memory), so rate limits and single-use nonces hold across invocations.
- Rotating `MERRYMEN_GATEWAY_SECRET` invalidates every issued token (your kill-switch). It also invalidates every partner key, whose stored hash it peppers, and signs every developer out of the portal.

## Honesty note

Call the *provider* "Merrymen AI" freely — white-labeling inference is normal. Just
don't imply you trained a model; the blurb ("powers your agent's brain") stays true.
