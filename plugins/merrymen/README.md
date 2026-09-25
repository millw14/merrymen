# Merrymen for Claude Code

Your Merrymen trading agent in any Claude Code session: its status, why it has
or hasn't traded, your portfolio, a weekly review and token research.

## Install

Inside Claude Code, run these one at a time:

```text
/plugin marketplace add millw14/merrymen
/plugin install merrymen@merrymen
```

Or from a terminal:

```bash
claude plugin marketplace add millw14/merrymen
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
| `/merrymen:status` | Is the agent running, paper or live, anything blocking it, when its permission expires |
| `/merrymen:why` | Why it has or hasn't traded, from its recorded state and decisions |
| `/merrymen:portfolio` | Cash, positions, profit and loss, paper and live kept apart |
| `/merrymen:week` | A week-in-review, and anything you need to do |
| `/merrymen:token <address or symbol>` | Research a token and whether your agent could trade it |
| `/merrymen:connect` | Sign in, or fix a connection that isn't working |

You can also just ask ("how's my Merryman doing?"); Claude picks the right one.

## What it can and cannot do

The connection sees only the agent and the permissions you allow when you sign
in, and you can disconnect it any time on
[Connected apps](https://app.merrymen.dev/connect/apps). It can suggest trades
or setting changes only if you allowed that, and nothing happens until you
approve each one in Merrymen. It can never move your funds, see your keys, turn
on live trading or loosen your limits.

Server: `https://mcp.merrymen.dev/mcp`. More ways to connect:
<https://app.merrymen.dev/connect/mcp>.
