---
name: portfolio
description: Review the user's Merrymen portfolio — cash, positions, profit and loss and fees, with paper and live money kept apart. Use when the user asks about their Merrymen portfolio, balance, positions or P&L.
argument-hint: "[agent id]"
---

Review the owner's Merrymen portfolio with the Merrymen tools (their names end in `get_portfolio` and `get_performance`).

1. Call `get_portfolio` (for the agent named in "$ARGUMENTS", if any; call `list_agents` first if the owner has several). It gives cash, savings, positions, equity and unrealised profit and loss per holding.
2. For realised profit and loss and fees, call `get_performance` with period "run" (since the agent started) or "week", whichever the owner asked about.
3. Give paper (practice) and live figures separately and never add them together. If a book's holdings are not listed (`positions_held_here` is false, because its newest valuation is of the other book), say so instead of calling it empty.
4. A missing price is unknown, not zero: say which positions have no price and what that does to the totals.
5. State the time the valuation was taken.

If Merrymen tools are available but `get_portfolio` is not, this connection was made without the permission "See your portfolio and trades": tell the owner to type `/mcp`, choose `plugin:merrymen:merrymen`, authenticate again and tick it under "Change what … can do". If no Merrymen tools are available at all, follow `/merrymen:connect` instead of guessing.
