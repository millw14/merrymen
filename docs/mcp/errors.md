# Merrymen MCP: errors

## Tool errors

A failed tool call returns an MCP result with `isError: true`, a one-line text
explanation, and this structured content:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many get_candles calls; slow down.",
    "retryable": true,
    "retry_after_s": 23,
    "trace_id": "5f1c0a9e3b2d4c11"
  }
}
```

Branch on `code`; `message` is for people and may change. Quote `trace_id` when
reporting a problem. A tool never turns an outage into an empty successful
answer: missing data sources return `upstream_unavailable`.

| Code | Retry? | Meaning |
|---|---|---|
| `unauthenticated` | no | No valid access token. Reconnect the app. |
| `insufficient_scope` | no | The connection was not granted the scope this needs (`details.required_scope`). Reconnect and allow it. |
| `forbidden` | no | This connection may not act on that object (for example no agent is shared with it). |
| `not_found` | no | No such object, **or it is not yours**. Other owners' objects are always reported as not found. |
| `invalid_input` | no | An argument is missing, malformed or out of range. |
| `conflict` | no | The object is in the wrong state (already approved, too late to cancel), or an idempotency key was reused for a different request. |
| `expired` | no | The object expired (a proposal, an export). |
| `rate_limited` | after `retry_after_s` | Too many requests in a short window. |
| `quota_exceeded` | after `retry_after_s` | An hourly or daily budget is used up (chat, quotes, backtests, exports). |
| `timeout` | yes | The work did not finish in time. |
| `upstream_unavailable` | after `retry_after_s` | A data source or dependency (ledger, chain, market provider) is unavailable. |
| `unsupported` | no | Merrymen does not support this (for example a token the owner-order path cannot address). |
| `internal` | yes | Unexpected server error. |

Input that fails the tool's JSON schema is rejected by the protocol layer
before the tool runs, with a text message starting `Input validation error`.

## HTTP errors on `/mcp`

| Status | When |
|---|---|
| `401` + `WWW-Authenticate: Bearer resource_metadata=…` | No token, or an invalid / expired / revoked token (`error="invalid_token"`). Run the OAuth flow again. |
| `403` | A browser `Origin` that is not allowed. |
| `404` | MCP is not enabled on this server (self-hosted installs, or switched off). |
| `421` | The request's `Host` is not this server. |
| `429` + `Retry-After` | Request rate per connection or per owner exceeded. |
| `503` + `Retry-After` | Too many requests in flight for this owner, or the database is unavailable. |

## OAuth errors

The authorization, token, registration and revocation endpoints return the
standard OAuth error bodies (`invalid_request`, `invalid_client`,
`invalid_grant`, `invalid_scope`, `invalid_target`, `unsupported_grant_type`,
`unsupported_response_type`, `access_denied`, `invalid_client_metadata`,
`invalid_redirect_uri`, `slow_down`). `invalid_grant` on a refresh means the
token was revoked, expired, or presented twice (reuse revokes the whole token
family); reconnect the app.
