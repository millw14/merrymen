---
name: connect
description: Connect Claude Code to the user's Merrymen trading agent, or fix a Merrymen connection that is not working. Use when the user asks to set up or sign in to Merrymen, or when a Merrymen request finds no Merrymen tools.
---

Help the owner connect this Claude Code to Merrymen.

**First check.** Look for Merrymen tools in this session (their names end in `list_agents`, `get_agent_status`, `search_tokens` and so on).
- If `list_agents` is there, it is connected: call it, tell the owner which agent Claude Code can see, and suggest `/merrymen:status` or `/merrymen:why`. Stop there.
- If some Merrymen tools are there but not the one a request needs, the owner left that permission unticked when they connected. They add it by signing in again (step 1 below) and ticking it under "Change what … can do"; a reconnect keeps what they allowed before.

**Otherwise, tell the owner how to sign in.** You cannot do this step for them: it happens in their browser, on Merrymen's own page.

1. Type `/mcp`, choose **plugin:merrymen:merrymen**, and choose **Authenticate**. (From a terminal instead: `claude mcp login plugin:merrymen:merrymen`.) With this plugin installed, this is the entry to sign in to even if they already added Merrymen to Claude on claude.ai: the plugin's server takes the place of that connector.
2. Merrymen opens in the browser. Sign in if asked, check what Claude Code will be able to do, and click **Allow**.
3. Come back and run `/merrymen:status`.

More ways to connect, for other assistants: https://app.merrymen.dev/connect/mcp.

**What the connection can and cannot do.** It sees only the agent and the permissions the owner allows on that page, and they can disconnect it at any time on Connected apps (https://app.merrymen.dev/connect/apps). With the usual permissions it can also message the agent, run backtests and manage the watchlist and alerts. It can suggest trades or setting changes only if the owner allowed that, and nothing happens until they approve each one in Merrymen. It can never move their funds, see their keys, turn on live trading or loosen their limits.
