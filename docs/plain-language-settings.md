# Plain-language settings

An owner tells their agent how it should work, in their own words, and approves
the resulting changes with one button: in Telegram, in Chat, or at the top of
Settings. It covers every owner setting the dashboard has.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Settings catalog | `packages/core/src/settings-catalog.ts` | Every owner setting: plain names, the words owners use, stored unit and bounds (the same bounds `PUT /api/settings` enforces), where it lives on the page, and how a change to it may be approved. Parses values ("$20", "8%", "once an hour", "8pm"), builds before/after proposals, and reads simple sentences without a model. |
| Telegram | `worker/src/telegram/{interpreter,settings-chat,service,executor}.ts` | The classifier may return several `key=value` changes in one `set` command. `proposeManyChanges` decides who approves them. |
| Settings page | `web/src/terminal/SettingsProposal.tsx` | "Tell your agent how to work": a box, an at-a-glance summary, and the proposal panel with Approve. Also where `?propose=…#proposal` links land. |
| Chat | `web/src/lib/chat-commands.ts` (`change-settings`) | Any settings request becomes a card that opens Settings with the changes filled in. |

## Who approves what

Each catalog entry has a `route`:

- **chat**: approved with ✅ in Telegram. Exactly the keys the chat could
  already change: `SETTING_SPECS` plus the agent's name. The list is pinned
  against `CHAT_SETTABLE` (`worker/src/telegram/settings-catalog.test.ts`). It
  is a security boundary, because a linked chat is reached by a bearer link
  code, and this feature does not widen it.
- **dashboard**: the agent prepares the exact change and sends a "Review &
  approve" button. The button opens Settings with the change filled in, and
  nothing changes until the owner taps Approve there, signed in. This covers
  real money, safety floors, and Telegram's and X's own switches.
- **sealed**: per-trade and daily limits, the loss breaker and expiry. Only a
  new signature changes these, so the reply carries the sign button.
- **secret**: API keys and the bot token. They are never taken from a message
  or carried in a link; the owner is sent to the field.

When one message asks for several changes, they are approved together. If
every change is chat-route, the owner gets one ✅, and the changes are applied
all-or-none after every one is re-validated. If any change is
dashboard-route, the owner gets one dashboard button carrying all of them.

## The link is a suggestion, not an instruction

`?propose=` carries base64url JSON `{v:1, changes:[[key, value], …]}`. It is
unsigned. Agent processes hold no secret the web shares, because the
orchestrator strips the session secret from them on purpose. So anyone could
write such a link. The page therefore:

- decodes and re-validates every change against the catalog, and drops
  secrets, unknown keys, duplicates and out-of-range values;
- says plainly that anyone can make such a link;
- shows each change before and after, with the real-money and safety warnings;
- applies only on the owner's tap, through the same authenticated
  `PUT /api/settings`, bound to the signed-in owner.

## Tests

- `packages/core/src/settings-catalog.test.ts`: parsing, sentences, proposals,
  and the link round trip and tampering.
- `web/src/app/api/settings/catalog-coverage.test.ts`: every proposable entry
  is saved by the real route at its bounds and refused one step outside them.
- `worker/src/telegram/settings-many.test.ts`: who approves what, and the
  service wiring.
- `web/src/terminal/settings-proposal.test.ts`: the panel on the real page,
  covering typing, the agent's link, forged links, dismiss and a refused save.
