# Connecting clients

**Connect in one click:** <https://app.merrymen.dev/connect/mcp>. That page has
every link and command below, with Copy buttons, and shows which assistants
are already connected when you are signed in.

**Server address:** `https://mcp.merrymen.dev/mcp` (Streamable HTTP, OAuth 2.1).

Every client below uses the same server and the same tools. There is no
client-specific business logic: Claude, Codex and everything else see exactly
the tools their granted scopes allow.

The first connection opens Merrymen in your browser. Sign in as usual. The
page names the assistant and your agent, and says in a few plain lines what
the assistant could see and do; click **Allow**. Nothing is allowed until you
do: an install link or command only puts the server address into the
assistant. To share less (or more), open **Change what … can do** for the full
list of permissions, or untick **Share** on your agent. The sensitive ones
(suggesting trades, setting changes and posts) start unticked. Reconnecting an
assistant that is still connected starts from what that connection already
has, so a permission you ticked before is kept. You can disconnect any
assistant at any time on [Connected apps](https://app.merrymen.dev/connect/apps).

To give a connected assistant a permission you left unticked, connect it again
(in Claude, **Disconnect** then **Connect** on the Merrymen connector; in Claude Code, `/mcp` then
re-authenticate) and tick that permission under **Change what … can do**. A
tool the connection has no permission for is not listed at all.

The install links below follow each vendor's documentation as of 2026-09-25.
Only the claude.ai link was opened live; see
[What was verified](#what-was-verified-and-how).

## Claude (claude.ai, Claude Desktop, Claude mobile)

**Fastest:** open this link while signed in to Claude:

<https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp>

1. Claude opens its **Add custom connector** dialog with the name and address
   already filled in, and a note that the connector was suggested by an
   external link. Click **Continue**, then **Connect**.
2. Merrymen opens. Sign in if asked, choose access, and click **Allow**.
3. Back in Claude, ask "Why hasn't my agent traded?"

Add it once: a connector added on claude.ai also appears in Claude Desktop,
Claude mobile and Claude Code signed in to the same account. Claude's free
plan allows one custom connector.

**By hand:** Claude → **Customize** → **Connectors** → **Add custom
connector**. Name: `Merrymen`. URL: `https://mcp.merrymen.dev/mcp`. Then
**Connect** and continue as in step 2.

**Team and Enterprise plans:** an owner of the organisation adds it once for
everyone:

<https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp>

Each member then connects it and approves on Merrymen as themselves; the
organisation's owner never gets access to anyone's agent.

**Stop Claude asking before every look-up:** Claude asks before each tool call
by default. Open Claude → **Customize** → **Connectors** → **Merrymen** and set
**Read-only tools** to **Always allow**. Tools that prepare something for your
approval still ask.

Claude identifies itself with its Client ID Metadata Document, so the consent
screen shows "Verified at claude.ai". Callback: `https://claude.ai/api/mcp/auth_callback`.

## Claude Code

**Fastest: the Merrymen plugin.** Inside Claude Code, run these one at a time
(pasted together they would be sent as one message):

```text
/plugin marketplace add millw14/merrymen
/plugin install merrymen@merrymen
```

From a terminal, the same is `claude plugin marketplace add millw14/merrymen`
then `claude plugin install merrymen@merrymen`. Then sign in once: type `/mcp`,
choose `plugin:merrymen:merrymen`, choose **Authenticate**, and click
**Allow** on the Merrymen page that opens (from a terminal:
`claude mcp login plugin:merrymen:merrymen`). `/merrymen:connect` walks
through it.

The plugin adds the server and these commands, which Claude also picks by
itself when you just ask:

| Command | What it does |
|---|---|
| `/merrymen:status` | Running or not, paper or live, blockers, permission expiry |
| `/merrymen:why` | Why the agent has or hasn't traded |
| `/merrymen:portfolio` | Cash, positions, P&L; paper and live kept apart |
| `/merrymen:week` | A week-in-review and anything you need to do |
| `/merrymen:token <address or symbol>` | Research a token and whether the agent could trade it |
| `/merrymen:connect` | Sign in, or fix a connection |

The plugin lives in [`plugins/merrymen`](../../plugins/merrymen); the
marketplace that lists it is [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json).
Its server is always the production address, so the connect page offers it
only when it serves that address.

**Already added Merrymen on claude.ai?** If Claude Code is signed in to the same
Claude account, the connector is there already (`/mcp` lists it as
`claude.ai Merrymen`; in the Claude desktop app it is under **+** →
**Connectors**). Installing the plugin still adds the commands. Its server
then takes precedence over the connector (Claude Code treats two servers at the
same address as one), so you sign in once more.

**Without the plugin:**

```bash
claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp
claude mcp login merrymen
```

`--scope user` makes it available in every project, not only the current
folder. `claude mcp login` needs an interactive terminal: it prints a link,
you approve in the browser, and Claude Code finishes on its own loopback
callback. Inside a session, `/mcp` shows the connection and lets you
re-authenticate.

## Codex (CLI, IDE extension, desktop app)

```bash
codex mcp add merrymen --url https://mcp.merrymen.dev/mcp
```

Codex starts the sign-in by itself after `add`: your browser opens Merrymen,
you approve, and Codex finishes on a loopback callback on `127.0.0.1`. The
Codex app and IDE extension read the same configuration.

The command writes this to `~/.codex/config.toml`, which you can also add by
hand and then sign in with `codex mcp login merrymen`:

```toml
[mcp_servers.merrymen]
url = "https://mcp.merrymen.dev/mcp"
```

Codex uses Client ID Metadata Documents (or dynamic registration). To choose
which tools need your approval, set `default_tools_approval_mode` (for example
`"writes"` asks before every tool that is not read-only).

### Codex without a browser (personal access token)

Create a personal access token on [Connected apps](https://app.merrymen.dev/connect/apps)
(name it, tick the permissions, choose 7/30/90 days), then:

```toml
[mcp_servers.merrymen]
url = "https://mcp.merrymen.dev/mcp"
bearer_token_env_var = "MERRYMEN_MCP_TOKEN"
```

```bash
export MERRYMEN_MCP_TOKEN="mcp_pat_…"
```

The token is shown once, stored only as a hash, limited to your own agents and
the permissions you ticked, and revocable on Connected apps.

## ChatGPT (developer mode)

1. In ChatGPT, open **Settings** → **Security and login** and turn on
   **Developer mode**.
2. Open <https://chatgpt.com/plugins> and create an app: name `Merrymen`,
   server URL `https://mcp.merrymen.dev/mcp`, authentication **OAuth**.
3. ChatGPT opens Merrymen. Sign in, choose access, and click **Allow**.

If ChatGPT registers itself dynamically, the consent screen says the app is
"not verified by Merrymen" and shows where it will send you back
(chatgpt.com). Only continue if you just started the connection yourself.

## Cursor

<https://cursor.com/en/install-mcp?name=merrymen&config=eyJ1cmwiOiJodHRwczovL21jcC5tZXJyeW1lbi5kZXYvbWNwIn0%3D>

The link opens Cursor's install prompt for the server (the config is base64 of
`{"url":"https://mcp.merrymen.dev/mcp"}`). By hand, add to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "merrymen": { "url": "https://mcp.merrymen.dev/mcp" } } }
```

Cursor registers three callbacks at once:
`cursor://anysphere.cursor-mcp/oauth/callback`,
`https://www.cursor.com/agents/mcp/oauth/callback` and
`http://localhost:8787/callback`. Merrymen keeps the https and loopback ones
and ignores the `cursor://` one (it never sends a code to an app scheme), so
current Cursor signs in through `http://localhost:8787/callback`. Very old
builds that sign in only through `cursor://` cannot connect; update Cursor if
sign-in fails with an invalid redirect.

## VS Code

<https://vscode.dev/redirect/mcp/install?name=merrymen&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.merrymen.dev%2Fmcp%22%7D>

For VS Code Insiders, add `&quality=insiders` to that link. By hand, add to
your user or workspace `mcp.json`:

```json
{ "servers": { "merrymen": { "type": "http", "url": "https://mcp.merrymen.dev/mcp" } } }
```

VS Code then asks you to sign in to Merrymen.

## Gemini CLI

```bash
gemini mcp add -s user -t http merrymen https://mcp.merrymen.dev/mcp
```

Then, inside Gemini CLI, run `/mcp auth merrymen` to sign in.

## Kiro

<https://kiro.dev/launch/mcp/add?name=merrymen&config=%7B%22url%22%3A%22https%3A%2F%2Fmcp.merrymen.dev%2Fmcp%22%7D>

## LM Studio

`lmstudio://add_mcp?name=merrymen&config=eyJ1cmwiOiJodHRwczovL21jcC5tZXJyeW1lbi5kZXYvbWNwIn0%3D`

The link opens the LM Studio app (the connect page has it as a button). By
hand, add `"merrymen": { "url": "https://mcp.merrymen.dev/mcp" }` under
`mcpServers` in LM Studio's `mcp.json`.

## Goose

`goose://extension?url=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp&type=streamable_http&id=merrymen&name=Merrymen&description=Your%20Merrymen%20trading%20agent&timeout=300`

The link opens the Goose app with the extension filled in.

## Windsurf and Devin

```bash
devin mcp add -s user merrymen https://mcp.merrymen.dev/mcp
devin mcp login merrymen
```

## Zed

No install link. Add the server under `context_servers` in Zed's
`settings.json`:

```json
{ "context_servers": { "merrymen": { "url": "https://mcp.merrymen.dev/mcp" } } }
```

If your Zed version cannot sign in with OAuth, create a personal access token
on Connected apps and send it as `"headers": { "Authorization": "Bearer mcp_pat_…" }`.

## Other MCP clients

Any client that supports remote MCP servers over Streamable HTTP with OAuth can
connect with the server address. Clients that do not use Client ID Metadata
Documents register themselves dynamically; the consent screen then says the app
is "not verified by Merrymen" and shows where it will send you back, so only
continue if you just started the connection yourself. A client that cannot sign
in through a browser can use a personal access token as a Bearer token.

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

The install-link formats follow each vendor's documentation as of 2026-09-25.
Only the claude.ai link was opened live; the others are pinned byte for byte
by `web/src/mcp/install-links.test.ts` but were not clicked through.

| Client | Verified |
|---|---|
| claude.ai | **End to end on 2026-09-25, against the production server before the one-click consent screen shipped.** The connector was added by hand (Customize → Connectors → Add custom connector); it registered through claude.ai's Client ID Metadata Document and the consent screen showed "Verified at claude.ai"; consent with the default permissions; the tool list was filtered to the granted scopes (46 tools with the defaults); `list_agents`, `get_agent_status` and `explain_agent_inactivity` ran from a chat, and `explain_agent_inactivity`'s MCP App view rendered inline. Separately, the pre-filled install link was opened and showed the Add custom connector dialog with the name and address filled in (then cancelled). |
| Claude Desktop / Claude mobile | Not verified separately. A connector added on claude.ai appears in them for the same account. |
| Official MCP TypeScript SDK client v2.1.0 | Full OAuth flow against a local deployment backed by real Postgres, then tool, resource and prompt calls on both **2026-07-28** (pinned) and **2025-11-25**; refresh rotation, refresh-reuse revocation, owner disconnect. |
| Claude Code 2.1.281 | Discovery, Client ID Metadata Document (`https://claude.ai/oauth/claude-code-client-metadata`), PKCE S256, loopback redirect, `resource` parameter and scope request observed from the real CLI against the local deployment; the consent page verified Claude Code's real published metadata document; the code exchange and tool calls were completed with the same client id and a test verifier. The last interactive step (`claude mcp login` pasting back in a TTY) was not automated. |
| Claude Code plugin (2.1.281) | 2026-09-25, in a throwaway `CLAUDE_CONFIG_DIR`: `claude plugin validate` passed for the plugin and the marketplace; `claude plugin marketplace add` (local checkout) and `claude plugin install merrymen@merrymen` installed 6 skills and the server; `claude mcp list` showed `plugin:merrymen:merrymen` pointing at production as "Needs authentication"; `claude mcp login plugin:merrymen:merrymen --no-browser` produced an authorization URL with Claude Code's metadata-document client and the production `resource`, and that URL reached Merrymen's consent page. Adding the marketplace from GitHub (`millw14/merrymen`) was not tested before merge, because the plugin is not on `main` until then. |
| Codex | Not verified (the Codex CLI is not installed on the build machine). Commands and configuration follow OpenAI's Codex MCP documentation. |
| ChatGPT developer mode | Not verified. |
| Cursor, VS Code, Gemini CLI, Kiro, LM Studio, Goose, Windsurf / Devin, Zed | Not verified. Links, commands and configuration follow each vendor's documentation as of 2026-09-25. |
