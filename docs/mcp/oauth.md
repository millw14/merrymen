# Merrymen MCP: OAuth and developer integration

The Merrymen MCP server is an OAuth 2.1 **protected resource** with its own
**authorization server**. Any MCP client that follows the MCP authorization
spec (Claude, Claude Code, Codex, ChatGPT, the MCP Inspector, the official
TypeScript and Python SDK clients) can connect without a pre-shared secret.

| | URL (production defaults) |
|---|---|
| MCP endpoint (resource) | `https://app.merrymen.dev/mcp` |
| Protected-resource metadata (RFC 9728) | `https://app.merrymen.dev/.well-known/oauth-protected-resource/mcp` (also at the root well-known path) |
| Authorization-server metadata (RFC 8414) | `https://app.merrymen.dev/.well-known/oauth-authorization-server` |
| Authorization endpoint | `https://app.merrymen.dev/oauth/authorize` |
| Token endpoint | `https://app.merrymen.dev/oauth/token` |
| Dynamic client registration (RFC 7591) | `https://app.merrymen.dev/oauth/register` |
| Revocation (RFC 7009) | `https://app.merrymen.dev/oauth/revoke` |
| Consent screen | `https://app.merrymen.dev/connect/app` |
| Connected apps (owners) | `https://app.merrymen.dev/connect/apps` |
| Readiness | `https://app.merrymen.dev/api/mcp/health` |

The issuer and resource URLs come from configuration (`MERRYMEN_PUBLIC_ORIGIN`,
optionally `MERRYMEN_OAUTH_ISSUER` / `MERRYMEN_MCP_RESOURCE_URL`), never from a
request's `Host` header, because tokens are bound to them.

## Who is who

| Principal | What it is | What proves it |
|---|---|---|
| **Client application** | Claude, Codex, your app | Its `client_id`: a Client ID Metadata Document URL, or an id from dynamic registration. A client id is *not* authority over any owner. |
| **Owner (end user)** | A Merrymen account holder | Their own Merrymen sign-in (wallet or Privy), on the consent page. |
| **Agent** | An owner's Merryman | Owned by the signed-in tenant according to the identity store at the moment of each call. |
| **Connection** | One owner's consent for one client | A row the owner can see and revoke on **Connected apps**. Tokens belong to a connection. |

There is **no application-level key that reaches every owner**. Every token is
issued to one connection, i.e. to one owner's explicit consent for one client,
limited to the agents and scopes that owner chose.

## The flow

1. The client calls `/mcp` with no token and receives `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp", scope="…"`.
2. It reads the protected-resource metadata (which names the authorization
   server) and the authorization-server metadata.
3. **Client identification**, in the order the MCP spec prefers:
   - **Client ID Metadata Documents** (advertised with
     `client_id_metadata_document_supported: true` and `none` in
     `token_endpoint_auth_methods_supported`). The `client_id` is an https URL;
     Merrymen fetches it through an SSRF-guarded transport (public addresses
     only, pinned DNS, https, no redirects, 64 KB, 5 s), requires the
     document's `client_id` to equal the URL exactly, accepts only public
     clients, validates every redirect URI, and caches it (≤ 24 h).
   - **Dynamic Client Registration** (`POST /oauth/register`), for clients that
     do not use CIMD. Open but rate limited per IP. Public (`none`) or
     confidential (`client_secret_basic` / `client_secret_post`) clients.
4. The client sends the browser to `/oauth/authorize` with
   `response_type=code`, `code_challenge` + `code_challenge_method=S256`
   (required; `plain` is refused), `redirect_uri` (must match a registered one
   exactly; loopback redirects may use any port per RFC 8252), `state`,
   `scope`, and `resource=https://app.merrymen.dev/mcp` (RFC 8707; any other
   resource is refused with `invalid_target`).
5. Merrymen parks the request and sends the browser to the consent page. The
   request handle travels in the URL **fragment**, so it never reaches a
   server log or a `Referer`.
6. The owner signs in to Merrymen (their normal sign-in), sees who is asking
   (a verified CIMD host, or "not verified by Merrymen" plus the redirect host
   for a dynamically registered client), chooses which of their agents the
   client may see and which scopes to allow (sensitive scopes start unticked),
   and approves or declines. The decision is a same-origin POST that requires
   the owner's session; the page cannot be framed.
7. The browser returns to the client's `redirect_uri` with `code`, `state` and
   `iss` (RFC 9207).
8. The client exchanges the code at `/oauth/token` (form-encoded) with its
   `code_verifier`. Codes are single use, expire after 5 minutes, and are bound
   to the client, redirect URI, PKCE challenge and resource. **Replaying a code
   revokes every token issued from it.**

## Tokens

- **Access tokens** (`mcp_at_…`): opaque 256-bit random values, valid 1 hour,
  audience-bound to the MCP resource URL. Stored only as SHA-256 hashes and
  looked up on every request, so revocation is immediate. There is no signing
  key that could be stolen or confused with the dashboard's session secret.
- **Refresh tokens** (`mcp_rt_…`): 30 days, **rotated on every use**. A refresh
  token that is presented again after rotation is treated as stolen: the whole
  token family (and every access token in it) is revoked and the client must
  reconnect. A family cannot outlive 90 days; after that the owner re-consents.
- A refresh can narrow scope, never widen it; the effective scopes of any token
  are always intersected with the owner's **current** consent.
- Tokens are accepted **only** in the `Authorization: Bearer` header, never in a
  query string. The MCP server never forwards a token anywhere.

## Revocation

- **Client-initiated**: `POST /oauth/revoke` (RFC 7009). Revoking a refresh
  token revokes its whole family. A client cannot revoke another client's
  tokens (the call succeeds silently, as the RFC requires, and does nothing).
- **Owner-initiated**: **Connected apps** (`/connect/apps`) → Disconnect. The
  connection and every token under it stop working on the next request.
- **Server-wide emergency**: see [operations.md](operations.md#emergency-revoke-everything).

## Personal access tokens

For clients that cannot run a browser OAuth flow (for example a headless Codex
setup using `bearer_token_env_var`), an owner can create a **personal access
token** (`mcp_pat_…`) on Connected apps: named, limited to the scopes they tick
and their own agents, expiring in 7, 30 or 90 days, shown once, stored hashed,
revocable like any connection. It is still one owner's delegation, never an
application-level key.

## Scopes

See [tools.md](tools.md) for the full list and which tool needs which scope.
No scope can move funds, sign transactions or change trading permissions.
`trade:propose`, `drafts:write` and `social:write` only create **proposals**
that the owner approves on a Merrymen page with their own sign-in.

## The partner API

The older partner API (`gateway/PARTNER-API.md`) is a separate, server-to-server
integration for apps that onboard their own users. MCP does not accept partner
keys (no token passthrough), and partner keys cannot reach MCP. Both paths
require the owner's explicit consent per app.

## Standards implemented

OAuth 2.1 (authorization code + PKCE S256), RFC 8414, RFC 9728, RFC 8707,
RFC 7591, RFC 7009, RFC 9207 (`iss`), RFC 8252 (loopback redirects), Client ID
Metadata Documents (MCP authorization spec 2025-11-25 / 2026-07-28).
