---
name: status
description: Check on the user's Merrymen trading agent — whether it is running, paper or live, what is blocking it and when its trading permission expires. Use when the user asks how their Merrymen agent (their "Merryman") is doing.
argument-hint: "[agent id]"
---

Check on the owner's Merrymen agent with the Merrymen tools (their names end in `list_agents` and `get_agent_status`).

1. Call `list_agents`. If "$ARGUMENTS" names an agent id, use that one; otherwise use every agent it returns.
2. For each agent, call `get_agent_status`.
3. Answer in at most six short lines per agent: its name, whether it is running, paper (practice) or live, anything blocking it, and when its trading permission expires. Say "paper" or "live" every time you give a figure; never mix the two.
4. If it is blocked or has been quiet, offer `/merrymen:why` to find out why it hasn't traded.

If Merrymen tools are available but `get_agent_status` is not, this connection was made without the permission "See your agent's status and settings": tell the owner to type `/mcp`, choose `plugin:merrymen:merrymen`, authenticate again and tick it under "Change what … can do". If no Merrymen tools are available at all, follow `/merrymen:connect` instead of guessing.
