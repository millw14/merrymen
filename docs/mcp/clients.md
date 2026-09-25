# Connecting clients

**Server address:** `https://app.merrymen.dev/mcp` (Streamable HTTP, OAuth 2.1).

Every client below uses the same server and the same tools. There is no
client-specific business logic: Claude, Codex and everything else see exactly
the tools their granted scopes allow.

The first connection opens Merrymen in your browser. Sign in as usual, choose
which of your agents the assistant may see and what it may do (every
permission is listed; the sensitive ones, proposing trades, drafts and posts,
start unticked), and approve. You can disconnect it any time on
[Connected apps](https://app.merrymen.dev/connect/apps).

To give a connected assistant a permission you left unticked, disconnect it on
Connected apps and connect it again (in Claude Code, `/mcp` then
re-authenticate), ticking that permission. A tool the connection has no
permission for is not listed at all.

## Claude (claude.ai, Claude Desktop, Claude mobile)

1. Settings → **Connectors** → **Add custom connector**.
2. Name: `Merrymen`. URL: `https://app.merrymen.dev/mcp`.
3. Click **Connect**. Claude opens Merrymen; sign in, choose access, approve.

Claude identifies itself with its Client ID Metadata Document, so the consent
screen shows "Verified at claude.ai". Callback: `https://claude.ai/api/mcp/auth_callback`.

On Team and Enterprise plans an owner may need to add custom connectors for the
organisation first.

## Claude Code

```bash
claude mcp add --transport http merrymen https://app.merrymen.dev/mcp
claude mcp login merrymen
```

`claude mcp login` needs an interactive terminal: it prints a link, you approve
in the browser, and Claude Code finishes on its own loopback callback. Inside a
session, `/mcp` shows the connection and lets you re-authenticate.

## Codex (CLI, IDE extension, desktop app)

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.merrymen]
url = "https://app.merrymen.dev/mcp"
```

then sign in:

```bash
codex mcp login merrymen
```

Codex uses Client ID Metadata Documents (or dynamic registration) and a
loopback callback on `127.0.0.1`. To choose which tools need your approval,
set `default_tools_approval_mode` (for example `"writes"` asks before every tool
that is not read-only).

### Codex without a browser (personal access token)

Create a personal access token on [Connected apps](https://app.merrymen.dev/connect/apps)
(name it, tick the permissions, choose 7/30/90 days), then:

```toml
[mcp_servers.merrymen]
url = "https://app.merrymen.dev/mcp"
bearer_token_env_var = "MERRYMEN_MCP_TOKEN"
```

```bash
export MERRYMEN_MCP_TOKEN="mcp_pat_…"
```

The token is shown once, stored only as a hash, limited to your own agents and
the permissions you ticked, and revocable on Connected apps.

## ChatGPT (developer mode) and other MCP clients

Any client that supports remote MCP servers over Streamable HTTP with OAuth can
connect with the server address. Clients that do not use Client ID Metadata
Documents register themselves dynamically; the consent screen then says the app
is "not verified by Merrymen" and shows where it will send you back, so only
continue if you just started the connection yourself.

For quick testing, the MCP Inspector works too:

```bash
npx @modelcontextprotocol/inspector
```

(transport "Streamable HTTP", URL as above, then "Open Auth Settings" → quick OAuth flow).

## Protocol versions

The server speaks MCP **2026-07-28** (stateless, `server/discover`) and the
2025 revisions (**2025-11-25**, **2025-06-18**, **2025-03-26**) through a
stateless fallback, on the same endpoint.

## What was verified, and how

| Client | Verified |
|---|---|
| Official MCP TypeScript SDK client v2.1.0 | Full OAuth flow against a local deployment backed by real Postgres, then tool, resource and prompt calls on both **2026-07-28** (pinned) and **2025-11-25**; refresh rotation, refresh-reuse revocation, owner disconnect. |
| Claude Code 2.1.281 | Discovery, Client ID Metadata Document (`https://claude.ai/oauth/claude-code-client-metadata`), PKCE S256, loopback redirect, `resource` parameter and scope request observed from the real CLI against the local deployment; the consent page verified Claude Code's real published metadata document; the code exchange and tool calls were completed with the same client id and a test verifier. The last interactive step (`claude mcp login` pasting back in a TTY) was not automated. |
| claude.ai / Claude Desktop | Not verified end to end (requires the owner's Claude account). The server meets the documented requirements: CIMD with `none` auth advertised, S256, exact `resource`, form-encoded token endpoint, refresh on 401. |
| Codex | Not verified (the Codex CLI is not installed on the build machine). Configuration follows OpenAI's Codex MCP documentation. |
| ChatGPT developer mode | Not verified. |
