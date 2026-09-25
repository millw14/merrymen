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
   The challenge's `scope` lists every scope a client can be granted (the
   same list as `scopes_supported`; never the staff scope). MCP clients
   request exactly that scope, and the consent page can only offer what was
   requested, so a narrower challenge would put the write and sensitive
   scopes out of reach of every OAuth client. Asking grants nothing by itself:
   the owner ticks what the app gets, and the sensitive scopes start unticked
   (a decision that names no scopes gets only the scopes that start ticked).
   An `/oauth/authorize` request with no `scope` at all is treated as asking
   for read access plus chat.
2. It reads the protected-resource metadata (which names the authorization
   server) and the authorization-server metadata.
3. **Client identification**, in the order the MCP spec prefers:
   - **Client ID Metadata Documents** (advertised with
     `client_id_metadata_document_supported: true` and `none` in
     `token_endpoint_auth_methods_supported`). The `client_id` is an https URL
     that must be written in canonical form with a path and **no query
     string, fragment, credentials or dot segments** (`.`, `..`, `%2e`), and
     whose host is **not one of Merrymen's own hosts** (the issuer, the MCP
     resource, or any host the MCP endpoints answer on): the consent page says
     "Verified at *host*", and a document served through one of our own routes
     would borrow our name. Merrymen fetches it through an SSRF-guarded
     transport (public addresses only, pinned DNS, https, no redirects, 64 KB,
     5 s), accepts only a `200` answer with an `application/json` (or
     `application/*+json`) `Content-Type`, requires the document's
     `client_id` to equal the URL exactly, accepts only public clients, and
     validates every redirect URI: at most 10, kept in canonical form
     (`URL.href`: ASCII, percent-encoded, IDNA host), and at most 2 KB
     together, counted in UTF-8 bytes as stored. The document's own spelling
     of a redirect still matches at `/oauth/authorize`, because the canonical
     form is exactly where the code is sent. The steps that start or complete
     a consent (`/oauth/authorize` and the consent page) cache a document, for
     up to 24 h. `/oauth/token` and `/oauth/revoke` use a fetched document for
     that one request, refresh a copy that is already cached, and **restore
     the cached copy of a client that some owner has an active connection
     with** (retention may have dropped it, and without it one failed fetch at
     the next refresh would disconnect the app). They never store a row for a
     client no owner is connected to, so a caller with no code or token can
     make Merrymen store at most one bounded row per client an owner already
     connected. The cache keeps only the name (up to 100 characters) and the
     redirect URIs, each once, never the fetched body: at most about 3 KB per
     client including its URL.

     When the client's host cannot answer (a network failure, a `5xx`, `408`
     or `429`, or any other non-`200` answer that is not JSON, such as a CDN
     challenge page — `404` and `410` excepted), a copy verified within the
     last 24 h is used; without
     one the answer is the retryable `temporarily_unavailable` (HTTP 503 at
     `/oauth/token` and `/oauth/revoke`, a 503 page at `/oauth/authorize`),
     never `invalid_client`, which clients treat as fatal. A `404` or `410`
     (whatever its content type), any other JSON `4xx`, or a `200` that is
     not a valid JSON document is the host's definite answer and stays
     `invalid_client`.
   - **Dynamic Client Registration** (`POST /oauth/register`), for clients that
     do not use CIMD. Open but rate limited per IP. Public (`none`) or
     confidential (`client_secret_basic` / `client_secret_post`) clients.
4. The client sends the browser to `/oauth/authorize` with
   `response_type=code`, `code_challenge` + `code_challenge_method=S256`
   (required; `plain` is refused), `redirect_uri` (must match a registered one
   exactly; loopback redirects may use any port per RFC 8252), `state`,
   `scope`, and `resource=https://app.merrymen.dev/mcp` (RFC 8707; any other
   resource is refused with `invalid_target`).

   **Errors before consent are shown on a Merrymen page, not redirected.**
   Registration is open, so a registered https redirect proves nothing, and
   bouncing errors to it would make every Merrymen authorize link an open
   redirector (RFC 9700 §4.11.2). The one exception: a CIMD client whose
   `redirect_uri` is loopback (a program on the owner's own computer, such as
   Claude Code or Codex CLI, waiting on that port) receives the error
   (`error`, `error_description`, `state`, `iss`) at its redirect. An unknown
   client, an unregistered `redirect_uri`, or a `state` containing a control
   character (which is never stored or echoed) is always a page.
5. Merrymen parks the request and sends the browser to the consent page. The
   request handle travels in the URL **fragment**, so it never reaches a
   server log or a `Referer`.
6. The owner signs in to Merrymen (their normal sign-in), sees who is asking
   (a verified CIMD host; or, for a dynamically registered client, "not
   verified by Merrymen" and the host of the redirect the code will actually
   go to, which is also what **Connected apps** records for the connection),
   chooses which of their agents the client may see and which scopes to allow
   (sensitive scopes start unticked), and approves or declines. The decision
   is a same-origin POST that requires the owner's session; the page cannot be
   framed.
7. Only now does the browser go back to the client's `redirect_uri`: with
   `code`, `state` and `iss` (RFC 9207) on approval, or with
   `error=access_denied` on decline.
8. The client exchanges the code at `/oauth/token` (form-encoded) with its
   `code_verifier`. Codes are single use, expire after 5 minutes, and are bound
   to the client, redirect URI, PKCE challenge and resource. **Replaying a code
   revokes every token issued from it.**

## Tokens

- **Access tokens** (`mcp_at_…`): opaque 256-bit random values, valid 1 hour,
  audience-bound to the MCP resource URL. Stored only as SHA-256 hashes and
  looked up on every request, so revocation is immediate. There is no signing
  key that could be stolen or confused with the dashboard's session secret.
- **Refresh tokens** (`mcp_rt_…`) are **always issued** with every code
  exchange, whether or not the client asked for `offline_access`, because MCP
  clients depend on them. They are **rotated on every use**, expire after 30
  days without use, and a token family cannot outlive 90 days from consent;
  after that the owner approves again. A refresh token that is presented again
  after rotation is treated as stolen: the whole token family (and every
  access token in it) is revoked and the client must reconnect.
- **`offline_access`** is accepted for compatibility and echoed in the granted
  `scope` when the client asked for it, but it **grants nothing extra** and is
  never shown to the owner as a choice: leaving it out does not make a
  connection shorter-lived. What ends a connection is the owner pressing
  **Disconnect** on Connected apps (every access and refresh token under it
  stops working on the next request), the client revoking its refresh token,
  or the idle / family limits above.
- Rotation and family revocation are safe under concurrency: every
  transaction that mints into a family (code exchange, rotation) or revokes
  one (refresh reuse, code replay, client revocation) first locks the
  connection row (`SELECT … FOR UPDATE`) and only then reads the token state
  it decides on, so on Postgres (READ COMMITTED) a revocation can never miss a
  pair minted by a rotation running at the same moment.
- A refresh can narrow scope, never widen it; the effective scopes of any token
  are always intersected with the owner's **current** consent.
- Tokens are accepted **only** in the `Authorization: Bearer` header, never in a
  query string. The MCP server never forwards a token anywhere.
- The public endpoints read request bodies with a hard bound (16 KB for
  `/oauth/token`, `/oauth/revoke` and `/oauth/register`, 8 KB for the consent
  and Connected apps APIs): a declared `Content-Length` over the bound is
  refused unread, and a chunked body is cancelled as soon as it passes the
  bound.

## Revocation

- **Client-initiated**: `POST /oauth/revoke` (RFC 7009). Revoking a refresh
  token revokes its whole family. A client cannot revoke another client's
  tokens (the call succeeds silently, as the RFC requires, and does nothing).
- **Owner-initiated**: **Connected apps** (`/connect/apps`) → Disconnect. The
  connection and every token under it (access and refresh, every family) stop
  working on the next request.
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

A tool whose scope a connection does not hold is not listed, and calling it by
name gets JSON-RPC error `-32602` ("Tool … not found"). To add a permission
later, the owner disconnects the app on **Connected apps** and connects it
again (its next sign-in asks for every scope), ticking that permission on the
consent page; or uses a personal access token that includes it.

## The partner API

The older partner API (`gateway/PARTNER-API.md`) is a separate, server-to-server
integration for apps that onboard their own users. MCP does not accept partner
keys (no token passthrough), and partner keys cannot reach MCP. Both paths
require the owner's explicit consent per app.

## Standards implemented

OAuth 2.1 (authorization code + PKCE S256), RFC 8414, RFC 9728, RFC 8707,
RFC 7591, RFC 7009, RFC 9207 (`iss`), RFC 8252 (loopback redirects), Client ID
Metadata Documents (MCP authorization spec 2025-11-25 / 2026-07-28).
