# Merrymen MCP: operations, deployment and rollback

## Where it runs

The MCP server is part of the **web** service (the Next.js app), not a separate
service. It adds these routes: `/mcp`, `/mcp/directory` (the limited directory
profile, see [oauth.md](oauth.md#the-directory-profile-mcpdirectory)),
`/.well-known/oauth-protected-resource[/mcp[/directory]]`,
`/.well-known/oauth-authorization-server`, `/oauth/{authorize,token,register,revoke}`,
`/connect/{app,apps,approve/:id,export/:id,mcp}` pages and `/api/mcp/*`.

Three background passes run in the **orchestrator** (the only durable scheduler):
backtest jobs (`worker/src/mcp/jobs.ts`), notification evaluation and delivery
(`worker/src/mcp/notify.ts`) and table retention (`worker/src/mcp/maintenance.ts`).
Trading, protective exits and the agent's own Telegram keep running in the
worker children and never depend on an MCP connection.

The passes are started from the reconcile loop and never awaited
(`worker/src/mcp/background.ts`). Each holds its slot as a lease of 2 minutes:
a pass still running after that is presumed hung and the next tick starts
another beside it (every pass is safe to run twice, as two replicas would).
A log line `mcp: the <pass> pass started N s ago has not finished` means a
pass hung.

What is bounded, and what is not (`boundedDb` in `background.ts`):

- A pass stops **waiting** on one statement after 20 s, and on one
  transaction after 30 s in all — getting a connection from the pool (which
  has no checkout timeout of its own), its statements and COMMIT. A
  transaction the pass has stopped waiting for is abandoned: if the pool hands
  it a connection later it runs nothing and rolls back, and work that
  finishes late rolls back instead of committing. (One cut off inside COMMIT
  may still have committed; every pass is safe with that.)
- Inside a transaction Postgres itself cancels a statement after 15 s and a
  lock wait after 5 s (`SET LOCAL`, so nothing leaks onto the shared pool's
  connections). Retention runs each DELETE in its own transaction for this.
- **Not bounded:** the connection itself. A statement stuck on a half-open
  socket keeps its pooled connection checked out (and a ROLLBACK queued behind
  it) until the socket fails, because the shared pool sets no query timeout
  or TCP keepalive (`worker/src/db.ts`, shared with the mirror). A statement
  outside a transaction that the pass stopped waiting for still runs whenever
  the pool gets to it, with no server-side timeout. A cut-off wait frees the
  pass, not the connection.

State lives in shared Postgres, in tables prefixed `mcp_` and `notify_`
(`worker/src/mcp/schema.ts`). Each process checks the catalog once at start
(`to_regclass`, no table locks) and runs the DDL only if a table or index is
missing or a migration is pending: then under an advisory lock, with a 5 s
`lock_timeout`, so a boot never queues behind a long writer while holding
other tables' locks (it fails and retries on the next request or tick
instead).

**The connection-resource migration (2026-09, the directory profile).**
`mcp_connections` gained a nullable `resource` column (NULL = the canonical
`/mcp`; the directory URL for a directory connection), and the unique index
`mcp_connections_one_active` moved from `(tenant, client_id)` to
`(tenant, client_id, COALESCE(resource, ''))`, so one owner can connect the
same app to both addresses. It runs by itself on the first boot of the new
code, in one transaction under the same advisory lock and timeout. On a
database that already has every MCP table and index it touches
`mcp_connections` alone: `LOCK TABLE mcp_connections IN ACCESS EXCLUSIVE
MODE` first, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS resource TEXT`,
`DROP INDEX IF EXISTS mcp_connections_one_active` and `CREATE UNIQUE INDEX IF
NOT EXISTS mcp_connections_one_active ON mcp_connections (tenant, client_id,
COALESCE(resource, '')) WHERE status = 'active' AND kind = 'oauth'` (each
only if still needed). It does not run the whole schema DDL, which locks
every MCP table in turn and so could deadlock with a consent approval or code
exchange in flight (the boot holding `mcp_connections` and waiting on
`mcp_codes`, the request the other way round). While it waits for its one
lock it holds no MCP table, and once it has it, it waits for nothing else, so
the worst case is the 5 s timeout and a retry on the next request or tick. A
database also missing a table or index takes the full path: the same column
and index steps, then the whole schema. The same catalog query that checks
for missing objects also sees a missing column or an old index definition
(`pg_attribute`, `pg_get_indexdef`), so an already-migrated boot still runs
no DDL. Existing
rows keep NULL and mean exactly what they did; no data is rewritten. The new
index is less strict than the old one, so existing data always satisfies it.
The index keeps its name on purpose: code from before the change looks for
that name at boot and finds it (a new name would make it recreate the old
index). MCP never writes ledger
tables, with one deliberate exception: an owner-approved trade is written to
the existing owner-order queue (`agent_commands`) through the same helper the
dashboard's chat orders use.

## Configuration

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `MERRYMEN_HOSTED` | web | — | Must be `1`. MCP answers 404 on self-hosted installs. |
| `DATABASE_URL` | web, orchestrator | — | Shared Postgres. Required. |
| `MERRYMEN_PUBLIC_ORIGIN` | web | — | e.g. `https://app.merrymen.dev`. The OAuth issuer and (by default) the resource origin. Required. |
| `MERRYMEN_SESSION_SECRET` | web | — | Owner sign-in (already required by the dashboard). |
| `MERRYMEN_MCP_ENABLED` | web, orchestrator (one shared Railway variable) | on | `0` switches MCP off. On **web**: every MCP route answers 404 (tokens unused). On the **orchestrator**: no backtest runs and no Telegram alert is evaluated or sent. Each service reads only its own environment, so set it on both — see [Emergency](#emergency-revoke-everything). |
| `MERRYMEN_OAUTH_ISSUER` | web | public origin | Only if the issuer must differ from the public origin. |
| `MERRYMEN_MCP_RESOURCE_URL` | web | `<origin>/mcp` | The canonical resource URL tokens are bound to, e.g. `https://mcp.merrymen.dev/mcp`. **Only the origin may change; the path must be `/mcp`** (a trailing slash is fine), because that is the only path the endpoint is served at (see [below](#the-endpoint-path-is-always-mcp)). Any other path, the root included, switches MCP off with a reason naming this variable, exactly as an invalid URL does. Changing it invalidates every existing token (audience changes); clients simply reconnect. |
| `MERRYMEN_MCP_DIRECTORY` | web | on | `0` switches the directory profile off: `/mcp/directory` and its metadata answer 404, authorize refuses its address, and directory tokens stop working (`invalid_grant` at refresh). `/mcp` is untouched. |
| `MERRYMEN_MCP_DIRECTORY_RESOURCE_URL` | web | `/mcp/directory` on the resource's origin | The directory profile's resource URL, e.g. `https://mcp.merrymen.dev/mcp/directory`. Only the origin may change: it must be https and its path exactly `/mcp/directory`, the only path the route serves; any other path (or the canonical one) switches the directory profile off, and `/api/mcp/health` says why. Changing it disconnects every directory connection once, like the canonical one. |
| `MERRYMEN_MCP_ALLOWED_ORIGINS` | web | — | Extra browser origins allowed to call `/mcp` (comma separated). Server-side clients send no Origin and are unaffected. |
| `MERRYMEN_MCP_STAFF_TENANTS` | web | — | Comma-separated owner addresses that may grant themselves `staff:diagnostics`. Re-checked on every call. |
| `MERRYMEN_MCP_ACCESS_TTL_SEC`, `_REFRESH_TTL_SEC`, `_REFRESH_FAMILY_MAX_SEC` | web | 3600, 30 d, 90 d | Token lifetimes (bounded). |
| `MERRYMEN_RPC_MAINNET` | web | chain default | RPC for quotes (already used elsewhere). |

`GET /api/mcp/health` reports `enabled`, the reason when disabled, database
latency, the deployed commit, the canonical `endpoint` and `directory`: the
directory profile's `endpoint`, or `null` with a `why` naming the variable that
turned it off (`MERRYMEN_MCP_DIRECTORY=0`; an unusable
`MERRYMEN_MCP_DIRECTORY_RESOURCE_URL`, including one on any path but
`/mcp/directory`). It returns `503` with `Retry-After` when not ready.

### The endpoint path is always `/mcp`

The full MCP endpoint is one Next route, `web/src/app/mcp/route.ts`, and
`web/next.config.mjs` has no rewrites (on purpose: see the comment there). So
`MERRYMEN_MCP_RESOURCE_URL` may move the endpoint to another origin (that is
how `mcp.merrymen.dev` works) but never to another path. The resource URL is
not just a label: it is what `/llms.txt`, `/api/mcp/health` (`endpoint`), the
protected-resource metadata (`resource`), the `401` challenge
(`resource_metadata`) and every install link on `/connect/mcp` hand to
clients, so a URL like `https://mcp.example.com/v2/mcp`, or the bare origin,
used to be advertised everywhere while every client POST to it got `404`.
`web/src/mcp/config.ts` (`CANONICAL_ROUTE_PATH`) now refuses it: MCP stays off,
and health, `/llms.txt` and `/connect/mcp` say
`MERRYMEN_MCP_RESOURCE_URL must have the path /mcp, the only path the MCP endpoint is served at (only the origin may change)`.
The MCP-host middleware (`web/src/mcp/landing.ts`, `MCP_ROUTE_PATH`, pinned to
the same value by `web/src/middleware.test.ts`) applies the same rule, so with
such a URL there is no dedicated MCP host either.

Production's value, `https://mcp.merrymen.dev/mcp`, gives the same resource
string as before this rule, so existing tokens keep verifying and refreshing
(`web/src/mcp/oauth/oauth.test.ts` pins both). If the endpoint ever has to
live at another path, add a route there (or a deliberate rewrite, and read
next.config.mjs's warning first) and change `CANONICAL_ROUTE_PATH` and
`MCP_ROUTE_PATH` together. Changing the variable alone does not move it. A
reverse proxy that maps some other public path onto `/mcp` is not supported
for the same reason: the metadata, the challenge and the MCP-host redirects
would all name `/mcp`.

## Deploying

MCP ships with the normal pipeline: PR → CI (`app`, `contracts`, `gateway`,
`kaka-policy`) → merge to `main` → Railway rebuilds **web** and
**orchestrator** from the same image. No new service, secret or manual
migration step is needed; tables are created, and migrations applied, on first
request.

After a deploy, verify:

```bash
curl -s https://mcp.merrymen.dev/api/mcp/health          # endpoint: https://mcp.merrymen.dev/mcp, directory.endpoint: https://mcp.merrymen.dev/mcp/directory
curl -s https://mcp.merrymen.dev/.well-known/oauth-protected-resource/mcp
curl -s https://app.merrymen.dev/.well-known/oauth-authorization-server
curl -si -X POST https://mcp.merrymen.dev/mcp -H 'content-type: application/json' -d '{}' | head -5   # expect 401 + WWW-Authenticate
# the directory profile: its own metadata (no trade:propose, drafts:write, social:write) and challenge
curl -s https://mcp.merrymen.dev/.well-known/oauth-protected-resource/mcp/directory
curl -si -X POST https://mcp.merrymen.dev/mcp/directory -H 'content-type: application/json' -d '{}' | grep -i '^www-authenticate'   # resource_metadata=…/mcp/directory
```

### The dedicated hostname

The MCP endpoint's canonical address is **`https://mcp.merrymen.dev/mcp`**
(since 2026-09-25). It is the same **web** service under a second custom
domain; the OAuth issuer stays `https://app.merrymen.dev`, because the owner's
sign-in cookie (and so consent, Connected apps and approvals) lives there.

How it is set up (repeat these steps for another hostname):

1. Railway, **web** service: custom domain `mcp.merrymen.dev`, target port
   8080 (`railway domain mcp.merrymen.dev --service web --port 8080`; without
   `--port` the domain has no port and answers "Application not found").
2. Vercel DNS for merrymen.dev (the zone's wildcard would otherwise send the
   name to Vercel): `CNAME mcp → 6a8l8zfi.up.railway.app` and the TXT record
   `_railway-verify.mcp` that the domain command prints.
3. Railway verifies ownership and issues a Let's Encrypt certificate
   (`railway domain status <id> --service web`: `Verified: yes`,
   `CERTIFICATE_STATUS_TYPE_VALID`).
4. `MERRYMEN_MCP_RESOURCE_URL=https://mcp.merrymen.dev/mcp` on web. Tokens are
   bound to this URL, so changing it again disconnects every app once: their
   access tokens get `401 invalid_token` and their refresh gets
   `invalid_grant`, which makes a client start a new sign-in. The protected-resource metadata names this URL, which is what
   spec-following clients check against the address they were given: connect
   them to `https://mcp.merrymen.dev/mcp`, not the app host.

### What the MCP host does for a browser, and for the bare domain

The MCP host serves the whole web app, so without a rule a browser there got
the terminal, signed out (the sign-in cookie is on the app host), and a client
given `https://mcp.merrymen.dev` got HTML. `web/src/middleware.ts` (logic in
`web/src/mcp/landing.ts`) now answers, on the MCP host only:

- **A page load in a browser** (GET or HEAD with `Sec-Fetch-Dest: document`,
  or no Sec-Fetch headers and `Accept: text/html`; no `Authorization`, no
  `MCP-Protocol-Version`): `307` to the app host. `/` goes to
  `https://app.merrymen.dev/connect/mcp`, any other page to the same path and
  query there.
- **Anything else at `/`** (an MCP client given the bare domain): `308` to
  `https://mcp.merrymen.dev/mcp`, keeping the method and body. Lenient clients
  then connect. Spec-strict ones still refuse, because the protected-resource
  metadata names `…/mcp`, not the address they were given: give them the full
  URL.
- **Never redirected:** `/mcp` and everything under it (`/mcp/directory`), `/.well-known/*`, `/oauth/*`, `/api/*`,
  `/_next/*` and any path with a file extension (icons, `sw.js`, the manifest).

`/mcp` opened in a browser, on either host, answers `307` to the connect page
instead of the JSON `401`; clients still get `401` + `WWW-Authenticate`. The
app host, an install whose MCP URL is on the app host, and self-hosted
installs are untouched. Targets come only from `MERRYMEN_PUBLIC_ORIGIN` (or
`MERRYMEN_OAUTH_ISSUER`) and `MERRYMEN_MCP_RESOURCE_URL`, which the middleware
reads when it loads. To check after a deploy:

```bash
curl -si https://mcp.merrymen.dev/ -H 'sec-fetch-dest: document' | grep -i '^location'   # https://app.merrymen.dev/connect/mcp (307)
curl -si -X POST https://mcp.merrymen.dev/ -d '{}' | grep -i '^location'                 # https://mcp.merrymen.dev/mcp (308)
```

## Observability

- **Logs**: one JSON line per event on stdout, prefixed `{"mcp":…}`: `tool`,
  `resource`, `transport_error`, `tool_internal_error`, `output_schema_violation`,
  `audit_write_failed`. Owners and connections appear only as a 12-character
  one-way hash; no addresses, tokens, message text or balances are logged.
  Every response carries `X-Trace-Id`; tool errors carry the same `trace_id`.
- **Metrics**: per-process tool call counts, error codes and a latency
  histogram (`staff_mcp_metrics` tool, staff only).
- **Audit**: `mcp_audit` records every tool call and resource read (tool,
  capability, outcome, latency, trace id, argument *names* and short ids — not
  free text), consent grants and denials, token issue/refresh/revocation,
  refresh-token reuse, and every owner approval, decline and disconnect. Owners
  see their own recent activity per connection on Connected apps.
- **Staff diagnostics** (`staff:diagnostics`, allowlisted owners only): fleet
  health, execution failures and unreconciled operations, provider error
  patterns, deployment info and MCP metrics — all with owner data redacted.

## Limits

| Limit | Value |
|---|---|
| Requests per connection | 240 / minute |
| Requests per owner | 3,000 / hour |
| Tool calls per connection | 60 / minute per tool (lower for costly tools) |
| In-flight requests | 64 per process, 8 per owner |
| Chat (house LLM) | 6 / minute, 30 / hour, 150 / day per owner |
| Quotes | 10 / minute, 120 / hour |
| Proposals | 5 / minute, 40 / hour; 20 open per owner |
| Backtests | 10 / hour, 30 / day; 2 queued or running per owner |
| Exports | 20 / hour |
| Registration | 30 / hour per IP |
| Request body | 1 MiB |
| Tool timeout | 15 s default (quotes 20 s, chat 35 s) |

Limits are enforced in shared Postgres, so they hold across web replicas.

## Emergency: revoke everything

To take down only the directory listing's address (`/mcp/directory`) and
leave custom connectors on `/mcp` working, set `MERRYMEN_MCP_DIRECTORY=0` on
web: the endpoint and its metadata answer 404 and directory tokens stop
working; they work again when it is unset. To end those connections for good:

```sql
UPDATE mcp_tokens SET revoked_at = EXTRACT(EPOCH FROM now())::bigint
 WHERE revoked_at IS NULL AND connection_id IN (SELECT id FROM mcp_connections WHERE resource IS NOT NULL);
UPDATE mcp_connections SET status = 'revoked', revoked_at = EXTRACT(EPOCH FROM now())::bigint, revoked_why = 'operator'
 WHERE status = 'active' AND resource IS NOT NULL;
```

To cut every MCP connection at once without a deploy, either:

- set `MERRYMEN_MCP_ENABLED=0` on **both web and orchestrator** — best as one
  shared Railway variable referenced by both services, so one change reaches
  both (each service restarts to pick it up). What each one stops:
  - **web**: `/mcp`, the OAuth routes, the MCP `/.well-known/*` metadata and
    `/api/mcp/*` answer 404 (`/api/mcp/health` instead reports
    `enabled: false`); the connect pages load but every action on them fails.
    Tokens are unusable but survive, and work again when re-enabled. Owners
    also cannot list or remove alert subscriptions or disconnect apps while it
    is off.
  - **orchestrator**: the background passes stop: no backtest job runs, no
    alert subscription is evaluated and no Telegram alert is sent, and
    retention pauses. Queued backtests do not run; one past its 1-hour
    deadline when MCP is re-enabled is expired, not run. Queued alerts wait
    and go out when re-enabled, except any more than a day old, which are
    dropped as expired rather than delivered late.

  Setting it on web alone is **not** an emergency stop: the orchestrator keeps
  sending alerts to owners who hold a `notifications:manage` connection and
  keeps running queued backtests, and with web off those owners cannot turn
  the alerts off themselves. If the emergency is an alert (a misleading or
  noisy message), the orchestrator switch is the one that stops it; or
- revoke all tokens (permanent; every client must reconnect):

  ```sql
  UPDATE mcp_connections SET status = 'revoked', revoked_at = EXTRACT(EPOCH FROM now())::bigint, revoked_why = 'operator'
   WHERE status = 'active';
  UPDATE mcp_tokens SET revoked_at = EXTRACT(EPOCH FROM now())::bigint WHERE revoked_at IS NULL;
  ```

Disconnecting an app on Connected apps already cancels that connection's
proposals still waiting for approval, and the approval page re-checks the
connection before acting. To stop every pending **approval** at once (for
example after revoking all connections by SQL above), expire them:

```sql
UPDATE mcp_proposals SET status = 'expired', updated_at = EXTRACT(EPOCH FROM now())::bigint
 WHERE status = 'awaiting_approval';
```

Orders already queued by an approval are ordinary owner orders: the worker's
own expiry, one-order-at-a-time slot, caps, policy and the on-chain permission
still apply, and the owner can stop the agent from Merrymen (You → Wallet &
permissions → 'discard & start over') or with Telegram `/kill`, then `/confirm`
(needs "allow control commands" on). On hosted Merrymen the Telegram kill
stops the agent on its next tick and leaves a kill request in the agent's
home. The orchestrator carries it out within seconds, on its three-second
order-ferry clock as well as in reconcile. It removes the stored grant, the
same as the web page's DELETE, never restores the key while the request is
pending, and then sends a ✅ to the owner's Telegram chat. The request is not
durable until then: if the orchestrator is replaced in those seconds, no ✅
arrives, and the kill reply tells the owner to use the web control in that
case. A grant the owner signs more than a few seconds after the kill is kept
and arms. See
`worker/src/kill-request.ts`.

## Rollback

MCP is additive. Rolling back is redeploying the previous web (and orchestrator)
deployment in Railway (`railway redeploy` of the prior deployment, or revert the
merge commit on `main`). The `mcp_*`/`notify_*` tables can stay; older code
ignores them. Nothing in the rollback touches trading state. If a rollback
happens while approvals are pending, their orders (if any were queued) remain
normal owner orders as above.

**Rolling back past the directory profile.** Before rolling back to an image
older than the directory profile (anything without `/mcp/directory`), revoke
every directory connection and its tokens: the rows `WHERE resource IS NOT
NULL`, with the two `resource IS NOT NULL` statements under
[Emergency](#emergency-revoke-everything), run in that order (tokens, then
connections). The older code assumes one active row per `(tenant,
client_id)`: it runs on the migrated schema (it finds the index by name, and
its inserts leave `resource` NULL), but it does not know a connection's
address, so for an owner holding both a full and a directory connection with
the same app its lookups can pick the directory row, and a reconnect can
write the full server's scopes onto it. Approval still refuses any proposal
whose connection has a non-NULL `resource` (`connectionStanding` in
`web/src/lib/services/proposals.ts`), but only once the new code is back; the
older code has no such check. The column and index can stay. Rolling forward
again needs nothing: the next boot sees the index definition and rebuilds it
if the older code put its own back.

## Retention

Run hourly by the orchestrator (`runMcpMaintenancePass`): consent requests and
codes are deleted a day after expiry, tokens 30 days after expiry or
revocation, audit rows after 180 days, rate-limit windows after 3 days,
deliveries after 90 days, finished jobs after 30 days, research notes 30 days
after expiry, conversation messages after a year, exports at expiry (24 h).
Dynamically registered clients that no active connection uses go 30 days after
registration. Cached client metadata documents that no active connection uses
go as soon as their cache expires. One an active connection uses goes once it
has expired and a day has passed since it was fetched — the window in which
an expired copy may still be served when a fresh fetch fails — and is fetched
again on its next use, so no cached document is kept for ever.

Every one of these DELETEs is an index range scan on its time column (the
indexes are in `schema.ts`; `maintenance.test.ts` checks each plan), and each
runs in its own short transaction under the pass's statement and lock
timeouts. The request path never deletes: rate-limit windows are pruned only
here.
