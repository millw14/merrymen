# Merrymen MCP: operations, deployment and rollback

## Where it runs

The MCP server is part of the **web** service (the Next.js app), not a separate
service. It adds these routes: `/mcp`, `/.well-known/oauth-protected-resource[/mcp]`,
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
missing: then under an advisory lock, with a 5 s `lock_timeout`, so a boot
never queues behind a long writer while holding other tables' locks (it fails
and retries on the next request or tick instead). MCP never writes ledger
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
| `MERRYMEN_MCP_RESOURCE_URL` | web | `<origin>/mcp` | The canonical resource URL tokens are bound to, e.g. `https://mcp.merrymen.dev/mcp`. Changing it invalidates every existing token (audience changes); clients simply reconnect. |
| `MERRYMEN_MCP_ALLOWED_ORIGINS` | web | — | Extra browser origins allowed to call `/mcp` (comma separated). Server-side clients send no Origin and are unaffected. |
| `MERRYMEN_MCP_STAFF_TENANTS` | web | — | Comma-separated owner addresses that may grant themselves `staff:diagnostics`. Re-checked on every call. |
| `MERRYMEN_MCP_ACCESS_TTL_SEC`, `_REFRESH_TTL_SEC`, `_REFRESH_FAMILY_MAX_SEC` | web | 3600, 30 d, 90 d | Token lifetimes (bounded). |
| `MERRYMEN_RPC_MAINNET` | web | chain default | RPC for quotes (already used elsewhere). |

`GET /api/mcp/health` reports `enabled`, the reason when disabled, database
latency and the deployed commit. It returns `503` with `Retry-After` when not
ready.

## Deploying

MCP ships with the normal pipeline: PR → CI (`app`, `contracts`, `gateway`,
`kaka-policy`) → merge to `main` → Railway rebuilds **web** and
**orchestrator** from the same image. No new service, secret or migration step
is needed; tables are created on first request.

After a deploy, verify:

```bash
curl -s https://app.merrymen.dev/api/mcp/health
curl -s https://app.merrymen.dev/.well-known/oauth-protected-resource/mcp
curl -s https://app.merrymen.dev/.well-known/oauth-authorization-server
curl -si -X POST https://app.merrymen.dev/mcp -H 'content-type: application/json' -d '{}' | head -5   # expect 401 + WWW-Authenticate
```

### A dedicated hostname (optional)

To serve the endpoint at `https://mcp.merrymen.dev/mcp`:

1. Add a custom domain `mcp.merrymen.dev` to the **web** service in Railway and
   set its target port (8080) — the CLI leaves it unset.
2. At the DNS provider (Vercel DNS for merrymen.dev): a `CNAME mcp → <railway target>`
   and the `_railway-verify.mcp` TXT record Railway shows in its dashboard.
3. Wait for Railway to issue the certificate.
4. Set `MERRYMEN_MCP_RESOURCE_URL=https://mcp.merrymen.dev/mcp` on web. The
   OAuth issuer stays `https://app.merrymen.dev` (the owner's sign-in cookie
   lives there). Existing connections must reconnect once (new audience).

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
permissions → 'discard & start over') or with Telegram `/kill` then `/confirm`
(when Telegram control commands are allowed).

## Rollback

MCP is additive. Rolling back is redeploying the previous web (and orchestrator)
deployment in Railway (`railway redeploy` of the prior deployment, or revert the
merge commit on `main`). The `mcp_*`/`notify_*` tables can stay; older code
ignores them. Nothing in the rollback touches trading state. If a rollback
happens while approvals are pending, their orders (if any were queued) remain
normal owner orders as above.

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
