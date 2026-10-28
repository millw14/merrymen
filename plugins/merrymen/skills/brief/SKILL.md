---
name: brief
description: Brief the owner on what needs them across their Merrymen agents — a morning brief of everything open, or a quiet check-in that speaks up only when something new needs them. Use for "anything I need to do for my Merryman?", a morning or daily brief, or when checking on the owner's agents on a schedule or on your own (Claude Duet, a scheduled task, a loop).
argument-hint: "[morning|check] [agent id]"
---

Brief the owner with the Merrymen tool that ends in `get_attention`. "$ARGUMENTS" may say `morning` or `check`, and may name an agent id.

1. Call `get_attention`, with the agent from "$ARGUMENTS" if one is named. On a check-in, pass `seen_keys`: the item keys you already told the owner about, from earlier briefs or check-ins you remember.
2. Decide whether to speak.
   - **Morning brief** (`morning`, the owner asked, or your first look of their day): every open item, most severe first, including ones reported before. If there are none, say in one line that nothing needs them.
   - **Check-in** (`check`, or you are checking on your own): speak if an `act_now` or `today` item is new (`new_counts` says how many), or if `resolved_keys` is not empty: say in a few words that each of those is sorted. Items marked fyi wait for the morning brief. If there is no new `act_now` or `today` item and nothing resolved, say nothing at all.
3. Give each item at most two lines: the agent's name (`agent_name`), the title, then `what_to_do` and the link. When `owner_can_fix` is false there is nothing for them to do, and the item's detail says why. A tripped drawdown breaker or a reached daily cap or trade count is their own signed limit working: it clears by itself, when the book recovers or as the 24-hour window rolls, so say that and do not call it a fault. Anything else without a fix for the owner is Merrymen's to fix.
4. Update the keys you remember: drop the ones in `resolved_keys`, keep the rest (a key this call did not check, such as another agent's, is still open as far as you know), and add the key of every item this call returned. They are the `seen_keys` for the next check-in.
5. If `not_checked` names something, mention it once, in a few words from its `why`. Only an entry with a `scope` can be granted: the owner types `/mcp`, chooses `plugin:merrymen:merrymen`, authenticates again and ticks that permission. An entry without one (a read that could not cover everything) cannot be fixed by signing in again, so do not suggest it.

Bring the link; do not act on the item. Renewing a trading permission, funding the agent and approving a proposal happen in Merrymen, signed in as the owner and, for a permission, with their own wallet. Never suggest raising a signed limit, the daily cap or the drawdown breaker to get the agent trading again: those are the owner's own protections doing their job. A proposal waiting for approval is not a trade.

If Merrymen tools are available but `get_attention` is not, this connection was made without the permission "See your agent's status and settings", or the server is older: tell the owner to type `/mcp`, choose `plugin:merrymen:merrymen`, authenticate again and tick it under "Change what … can do". If no Merrymen tools are available at all, follow `/merrymen:connect` instead of guessing.
