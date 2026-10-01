# One-time Telegram group recovery notice

This operator path can speak only through Shogun's own bot (`@Merrymanme_bot`)
in a room Shogun's owner approved and Telegram currently calls `Merrymen`.
It reads the sealed room state inside the orchestrator. It never polls updates,
reads chat history into logs, or touches a trading path.

Use it only after the account page, signup, worker and Telegram replies have
been checked live. The prepared text is
[`docs/announcements/tg-group-recovery-2026-10-01.html`](announcements/tg-group-recovery-2026-10-01.html).
Review its claims immediately before a real send.

1. Set `MERRYMEN_TG_RECOVERY_ID=recovery-2026-10-01` on the orchestrator and
   deploy. This is a dry run. The first healthy mirror pass prints only approved
   Shogun rooms titled `Merrymen`, each numeric chat ID, the prepared body, and
   its SHA-256 digest. The digest is of the trimmed text that will be sent.
   It contacts no Telegram API and sends nothing.
2. Confirm the intended public beta room's numeric ID independently from a
   Telegram message permalink or group administration screen. A matching title
   alone is insufficient if several rooms have the same title. Stop if the dry
   run prints no candidate, more than one plausible candidate, or an unexpected
   Shogun/room state.
3. Set `MERRYMEN_TG_RECOVERY_CHAT_ID` to **exactly** that negative numeric ID
   `MERRYMEN_TG_RECOVERY_CONFIRM=recovery-2026-10-01`, and
   `MERRYMEN_TG_RECOVERY_BODY_SHA256` to the **exact digest printed by the
   reviewed dry run**, then deploy. If the message file changes, the digest
   differs and the send is refused until a new dry run is reviewed. A real
   send verifies the tenant's current grant/account name, durable bot claim,
   Telegram settings, bot ID and username, current chat identity, and owner
   approval again. Settings and bot ownership are checked again after the
   Telegram lookups and at the database notice claim. All three confirmations
   are required; the campaign ID alone remains a dry run.
4. Check the log outcome. `sent` means Telegram acknowledged the message.
   `already-claimed` means this campaign targeted the room before; it will not
   repeat. `uncertain` means the request may have landed, so **inspect the room
   manually before any new campaign**. A claim is persisted before the external
   send to make interrupted attempts at most once. Never delete a claim merely
   to force a retry.
5. Remove all four environment variables after the outcome is known.

The receipt table is `tg_group_notices`, keyed by campaign, tenant and chat ID.
It contains a body hash and delivery status, never a token or chat content.
This path does not affect owner DM notices, which use `worker/src/announce.ts`.
