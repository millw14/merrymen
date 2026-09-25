---
name: week
description: A week-in-review of the user's Merrymen agent — what changed in value and why, the trades that landed, notable refusals and holds, and anything the owner has to do. Use when the user asks for a weekly review or recap of their Merrymen agent.
argument-hint: "[agent id]"
---

Give the owner a week-in-review with the Merrymen tools (the one that does this ends in `get_summary`).

1. Call `get_summary` for the week (and the agent named in "$ARGUMENTS", if any).
2. Present: what changed in value and why; the trades that landed (confirmed on chain only; a proposal is not a trade); notable refusals and holds; and anything the owner must do, such as re-signing the trading permission, funding gas or approving a waiting proposal.
3. Keep paper (practice) and live results apart.

If no Merrymen tools are available in this session, Merrymen is not connected yet: follow `/merrymen:connect` instead of guessing.
