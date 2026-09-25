---
name: portfolio
description: Review the user's Merrymen portfolio — cash, positions, profit and loss and fees, with paper and live money kept apart. Use when the user asks about their Merrymen portfolio, balance, positions or P&L.
argument-hint: "[agent id]"
---

Review the owner's Merrymen portfolio with the Merrymen tools (the one that does this ends in `get_portfolio`).

1. Call `get_portfolio` (for the agent named in "$ARGUMENTS", if any; call `list_agents` first if the owner has several).
2. Summarise cash, savings and positions, realised and unrealised profit and loss, and fees. Give paper (practice) and live figures separately and never add them together.
3. A missing price is unknown, not zero: say which positions have no price and what that does to the totals.
4. State the time the valuation was taken.

If no Merrymen tools are available in this session, Merrymen is not connected yet: follow `/merrymen:connect` instead of guessing.
