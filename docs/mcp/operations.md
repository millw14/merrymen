# Merrymen MCP: operations, deployment and rollback

## Where it runs

The MCP server is part of the **web** service (the Next.js app), not a separate
service. It adds these routes: `/mcp`, `/.well-known/oauth-protected-resource[/mcp]`,
`/.well-known/oauth-authorization-server`, `/oauth/{authorize,token,register,revoke}`,
`/connect/{app,apps,approve/:id,mcp}` pages and `/api/mcp/*`.

Two background passes run in the **orchestrator** (the only durable scheduler):
backtest jobs (`worker/src/mcp/jobs.ts`), notification evaluation and delivery
(`worker/src/mcp/notify.ts`) and table retention (`worker/src/mcp/maintenance.ts`).
Trading, protective exits and the agent's own Telegram keep running in the
worker children and never depend on an MCP connection.

State lives in shared Postgres, in tables prefixed `mcp_` and `notify_`
(`worker/src/mcp/schema.ts`), created idempotently on first use under an
advisory lock. MCP never writes ledger tables, with one deliberate exception:
an owner-approved trade is written to the existing owner-order queue
(`agent_commands`) through the same helper the dashboard's chat orders use.

## Configuration

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `MERRYMEN_HOSTED` | web | — | Must be `1`. MCP answers 404 on self-hosted installs. |
| `DATABASE_URL` | web, orchestrator | — | Shared Postgres. Required. |
| `MERRYMEN_PUBLIC_ORIGIN` | web | — | e.g. `https://app.merrymen.dev`. The OAuth issuer and (by default) the resource origin. Required. |
| `MERRYMEN_SESSION_SECRET` | web | — | Owner sign-in (already required by the dashboard). |
| `MERRYMEN_MCP_ENABLED` | web | on | `0` switches the whole MCP surface off (404s everywhere, tokens unused). |
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

- set `MERRYMEN_MCP_ENABLED=0` on web (all MCP routes 404; tokens are unusable
  but survive, and work again when re-enabled), or
- revoke all tokens (permanent; every client must reconnect):

  ```sql
  UPDATE mcp_connections SET status = 'revoked', revoked_at = EXTRACT(EPOCH FROM now())::bigint, revoked_why = 'operator'
   WHERE status = 'active';
  UPDATE mcp_tokens SET revoked_at = EXTRACT(EPOCH FROM now())::bigint WHERE revoked_at IS NULL;
  ```

To stop pending **approvals** from being acted on, expire them:

```sql
UPDATE mcp_proposals SET status = 'expired', updated_at = EXTRACT(EPOCH FROM now())::bigint
 WHERE status = 'awaiting_approval';
```

Orders already queued by an approval are ordinary owner orders: the worker's
own expiry, one-order-at-a-time slot, caps, policy and the on-chain permission
still apply, and the owner can use the dashboard's kill switch.

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
revocation, audit rows after 180 days, deliveries after 90 days, finished jobs
after 30 days, exports at expiry (24 h).
