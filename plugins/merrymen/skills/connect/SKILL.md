---
name: connect
description: Connect Claude Code to Merrymen, prepare a new agent with owner-reviewed setup, or fix a connection that is not working. Use when the user asks to set up or sign in to Merrymen, or when a Merrymen request finds no Merrymen tools.
---

Help the owner connect this Claude Code to Merrymen.

**First check.** Look for Merrymen tools in this session (their names end in `list_agents`, `get_agent_status`, `search_tokens` and so on). Any one of them means Merrymen is connected; which ones are there shows what the owner allowed, because a tool whose permission was left unticked is not offered at all.
- None at all: go to the sign-in steps below.
- `get_merryman_setup` is there: call it first, even for a new owner. Use its reported next step; no visible agent does not prove no wallet exists. If the owner requested creation and drafting is allowed, call `create_merryman` with their name, strategy and risk choices, then show its owner review link. The owner reviews the exact setup and continues to wallet creation and trading-permission signing in Merrymen. Read setup again after signing; a draft or approval is not a running agent.
- Only `list_agents` is there: call it and report which agents are shared; use `/merrymen:status` or `/merrymen:why` for an existing agent. Do not infer that an empty result authorizes replacing a wallet.
- Some Merrymen tools but no `list_agents`: say it is connected but cannot see their agent (it was made without "See your agent's status and settings"), and list what it can do from the tools that are there.
- If the owner came here because a request needed a tool that is not there, name the permission it needs: `get_agent_status` needs "See your agent's status and settings", `explain_agent_inactivity` "See your agent's decisions", `get_portfolio` "See your portfolio and trades", `get_summary` "Create reports and exports", `search_tokens` "Research markets and public agents". They add a permission by signing in again (step 1 below) and ticking it under "Change what … can do"; a reconnect keeps what they allowed before.

For an existing agent, use `create_agent_draft` or `propose_settings_change` for requested configuration changes and return the owner review link. Never use new-agent creation to replace an existing agent. After activation, Merrymen's hosted worker runs independently of this conversation; no terminal or chat must stay open. Report permission expiry, service or funding blockers from the actual setup response.

Hosts with MCP Apps can show the interactive Merryman home for naming, strategy, risk, status, portfolio, activity, settings and alerts. Claude Code can use the same text responses and tools; an embedded view is optional. Other research, trade proposals, reports and community actions stay available in chat when their permission is granted.

If the requested work is complete, stop there; reconnect only when access is missing.

**Otherwise, tell the owner how to sign in.** You cannot do this step for them: it happens in their browser, on Merrymen's own page.

1. Type `/mcp`, choose **plugin:merrymen:merrymen**, and choose **Authenticate**. (From a terminal instead: `claude mcp login plugin:merrymen:merrymen`.) With this plugin installed, this is the entry to sign in to even if they already added Merrymen to Claude on claude.ai: the plugin's server takes the place of that connector.
2. Merrymen opens in the browser. Sign in if asked, check what Claude Code will be able to do, and click **Allow**.
3. Come back and call `get_merryman_setup`, or run `/merrymen:status` for an existing agent.

More ways to connect, for other assistants: https://app.merrymen.dev/connect/mcp.

**What the connection can and cannot do.** It sees only the agent and the permissions the owner allows on that page, and they can disconnect it at any time on Connected apps (https://app.merrymen.dev/connect/apps). With the usual permissions it can also message the agent, run backtests and manage the watchlist and alerts. It can suggest trades or setting changes only if the owner allowed that, and nothing happens until they approve each one in Merrymen. It can never move their funds, see their keys, turn on live trading or loosen their limits.
