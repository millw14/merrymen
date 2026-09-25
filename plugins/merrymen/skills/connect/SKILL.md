---
name: connect
description: Connect Claude Code to the user's Merrymen trading agent, or fix a Merrymen connection that is not working. Use when the user asks to set up or sign in to Merrymen, or when a Merrymen request finds no Merrymen tools.
---

Help the owner connect this Claude Code to Merrymen.

**First check.** If Merrymen tools are available in this session (their names end in `list_agents`, `get_agent_status` and so on), it is already connected: call `list_agents` and tell the owner which agent Claude Code can see, then suggest `/merrymen:status` or `/merrymen:why`. Stop there.

**Otherwise, tell the owner how to sign in.** You cannot do this step for them: it happens in their browser, on Merrymen's own page.

1. Type `/mcp`, choose **plugin:merrymen:merrymen** (or **claude.ai Merrymen**, if they added Merrymen to Claude on claude.ai), and choose **Authenticate**.
   - From a terminal instead: `claude mcp login plugin:merrymen:merrymen`
   - In the Claude desktop app, Merrymen added on claude.ai is under the **+** menu → **Connectors**; switch it on.
2. Merrymen opens in the browser. Sign in if asked, check what Claude Code will be able to do, and click **Allow**.
3. Come back and run `/merrymen:status`.

Not added anywhere yet? The one-click options are at https://app.merrymen.dev/connect/mcp.

**What the connection can and cannot do.** It sees only the agent and the permissions the owner allows on that page, and they can disconnect it at any time on Connected apps (https://app.merrymen.dev/connect/apps). It can suggest trades or setting changes only if the owner allowed that, and nothing happens until they approve each one in Merrymen. It can never move their funds, see their keys, turn on live trading or loosen their limits.
