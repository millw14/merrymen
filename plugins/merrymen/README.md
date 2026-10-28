# Merrymen for Claude Code

Create or manage your hosted Merrymen trading agent from Claude Code: what needs you, its
status, why it has or hasn't traded, your portfolio, a weekly review and token research.

For Claude on the web, Desktop, Cowork or mobile, use the remote connector at
[Connect Merrymen](https://app.merrymen.dev/connect/mcp); no terminal is needed.
ChatGPT and dots need a supported ChatGPT plugin for this MCP server, installed,
connected and enabled. Availability depends on the host and workspace.

MCP Apps hosts also get an interactive home for name, strategy, basket, risk, readiness, portfolio, activity, editable settings, pending approvals and Telegram alerts. A focused secure handoff carries the chosen setup into wallet authorization. Other hosts use the same tools as text; owner approval and wallet signing always remain in Merrymen.

## Install

Inside Claude Code, run these one at a time:

```text
/plugin marketplace add https://github.com/millw14/merrymen.git
/plugin install merrymen@merrymen
```

Or from a terminal:

```bash
claude plugin marketplace add https://github.com/millw14/merrymen.git
claude plugin install merrymen@merrymen
```

Then sign in once: type `/mcp`, choose `plugin:merrymen:merrymen`, choose
**Authenticate**, and click **Allow** on the Merrymen page that opens (or run
`/merrymen:connect` and follow along).

Already added Merrymen to Claude on claude.ai? If Claude Code is signed in with
the same Claude account, the connector is in Claude Code already (`/mcp` lists
it as `claude.ai Merrymen`). The plugin still adds the commands below; its own
server takes over from the connector, so you sign in once more.

## Commands

| Command | What it does |
|---|---|
| `/merrymen:brief` | What needs you across your agents: a morning brief, or a quiet check-in that speaks only when something is new |
| `/merrymen:status` | Is the agent running, paper or live, anything blocking it, when its permission expires |
| `/merrymen:why` | Why it has or hasn't traded, from its recorded state and decisions |
| `/merrymen:portfolio` | Cash, positions, profit and loss, paper and live kept apart |
| `/merrymen:week` | A week-in-review, and anything you need to do |
| `/merrymen:token <address or symbol>` | Research a token and whether your agent could trade it |
| `/merrymen:connect` | Sign in, or fix a connection that isn't working |

You can also ask "set up my Merryman" or "how's my Merryman doing?". Setup
starts with `get_merryman_setup`. For a new agent, `create_merryman` prepares
your name, strategy and risk choices for review. You approve and sign the
wallet permission on Merrymen; a draft alone does not activate trading.
The hosted worker runs after activation even when the conversation closes.
Changes to an existing agent use owner-approved configuration proposals.

## What it can and cannot do

The connection sees only the agent and the permissions you allow when you sign
in, and you can disconnect it any time on
[Connected apps](https://app.merrymen.dev/connect/apps). It can suggest trades
or setting changes only if you allowed that, and nothing happens until you
approve each one in Merrymen. It can never move your funds, see your keys, turn
on live trading or loosen your limits.

Server: `https://mcp.merrymen.dev/mcp`. More ways to connect:
<https://app.merrymen.dev/connect/mcp>.

## Maintaining this plugin

Claude Code caches an installed plugin by the `version` in
`.claude-plugin/plugin.json` and delivers a change only when that version
moves. Any change to `.mcp.json` or a skill therefore needs a version bump, or
people who installed it earlier keep the old copy. `web/src/mcp/claude-plugin.test.ts`
fingerprints those files and fails until the version and the fingerprint are
updated together. Check a change with
`claude plugin validate --strict plugins/merrymen` and `claude plugin validate --strict .`.
