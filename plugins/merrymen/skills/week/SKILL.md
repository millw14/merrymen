---
name: week
description: A week-in-review of the user's Merrymen agent — what changed in value and why, the trades that landed, notable refusals and holds, and anything the owner has to do. Use when the user asks for a weekly review or recap of their Merrymen agent.
argument-hint: "[agent id]"
---

Give the owner a week-in-review with the Merrymen tools (the one that does this ends in `get_summary`).

1. Call `get_summary` with period "week" (its default is one day), and with the agent named in "$ARGUMENTS", if any.
2. Present what changed in value and why, keeping paper (practice) and live apart.
3. For live trades, use `confirmed_count` for how many landed, not the length of the list (it holds at most the 20 newest). The list mixes trade fills with transfers and savings moves: call only fills trades. A proposal is not a trade, and a submitted operation is not confirmed.
4. Then notable refusals and holds, and anything the owner must do, such as re-signing the trading permission, funding gas or approving a waiting proposal.

If Merrymen tools are available but `get_summary` is not, this connection was made without the permission "Create reports and exports": tell the owner to type `/mcp`, choose `plugin:merrymen:merrymen`, authenticate again and tick it under "Change what … can do". If no Merrymen tools are available at all, follow `/merrymen:connect` instead of guessing.
