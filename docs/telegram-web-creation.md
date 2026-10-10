# Telegram bot creation from the web

Hosted Settings → Telegram has a **Create Telegram bot** button (Home has the
same flow as **Set up Telegram**). It opens a private chat with the Merrymen
manager. The user starts that chat, taps its creation button and approves the
bot name in Telegram. The manager then answers in the same chat:

> ✅ @their_bot is ready.
> Connect it to your Merrymen agent?
>
> [Connect @their_bot] [Not this bot]

**Connect** saves the bot right there; the page in Merrymen, which keeps
checking, shows it saved without another click. The page also still offers
**Connect this bot**, so either place works, and whichever comes second finds
it already done. Merrymen retrieves and seals the token on the server; users
never copy it. **Open your bot** then uses the existing private `/start` link to
finish linking their agent. Saving a token does not prove a listener is running,
and it does not enable trading or change a wallet permission.

The whole setup, from the button to choosing the bot, has **30 minutes**.

Existing bots keep their current connection. Manual BotFather token entry remains
under **Connect an existing bot**. Creating a new bot refuses to replace a saved
token. Telegram requires user confirmation; creation is not silent.

## What the operator sets up

The feature is off by default. Turning it on needs a manager bot, five
variables on the web service and a deploy. No SQL is applied by hand and no
webhook is set by hand.

1. **Create a dedicated manager bot** with [@BotFather](https://t.me/BotFather)
   (`/newbot`), then open the BotFather Mini App, pick that bot and turn on
   **Bot Management Mode**. Do not reuse an agent's bot: the manager receives a
   separate update stream and must never be assigned to a tenant. Use a
   different manager bot for each environment (staging, production): a bot has
   one webhook, and this service will not take one that points elsewhere (see
   below).
2. **Set these variables on the web service only** (never on the orchestrator
   or workers, never as `NEXT_PUBLIC_*`):

   | Variable | Value |
   | --- | --- |
   | `MERRYMEN_TELEGRAM_MANAGER_TOKEN` | The manager's Bot API token from BotFather |
   | `MERRYMEN_TELEGRAM_MANAGER_USERNAME` | Its username, without `@` (must end in `bot`) |
   | `MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET` | Independent random 32–256 character secret of letters, digits, `_` and `-`, e.g. `openssl rand -hex 32` |
   | `MERRYMEN_TELEGRAM_CREATE_ENABLED` | `true` to offer creation; anything else turns it off |
   | `MERRYMEN_PUBLIC_ORIGIN` | Already required hosted. Must be the `https://` origin Telegram can reach, with no path |

   The hosted service already requires `DATABASE_URL` and `MERRYMEN_STORE_DEK`;
   without either, creation stays off. Keep these values out of client
   variables, shell arguments, request logs, screenshots and source control.
3. **Deploy.** Start with a disposable operator account and bot; verify private
   linking and actual listening before announcing it to users.

Turn creation off by clearing `MERRYMEN_TELEGRAM_CREATE_ENABLED`. Existing
tenant bots continue through their current worker path. A setup already waiting
for confirmation can still be confirmed or cancelled while the readiness probe
below fails, but not once the flag or variables are cleared: Settings then
re-reads the saved settings, forgets the setup and leaves Save usable.

## What the service does by itself

**Tables.** The first request that needs them creates
`telegram_managed_intents`, `telegram_managed_users` and
`telegram_managed_updates` (and `telegram_bot_claims`, if nothing else has yet)
with `CREATE TABLE IF NOT EXISTS`, inside a transaction holding a Postgres
advisory lock so replicas starting together make them once. They hold only
onboarding intents, Telegram-user leases and callback receipts; nothing here
touches trading records, wallets, tenant settings or existing Telegram links.
`docs/migrations/2026-10-05-telegram-managed.sql` is the same schema in its
Postgres spelling, kept for review; applying it is harmless but not needed.

**The manager's webhook.** Before Settings shows **Create Telegram bot**, the
web service runs a readiness probe:

1. the tables exist (or are made);
2. `getMe` with the manager token answers for the configured username with
   `can_manage_bots: true` (Bot Management Mode is on);
3. `getWebhookInfo` reports the manager's webhook URL, and:
   - **empty**: the service sets it to
     `${MERRYMEN_PUBLIC_ORIGIN}/api/telegram/manager/webhook` with the webhook
     secret and `allowed_updates: ["message", "managed_bot", "callback_query"]`,
     then reads it back;
   - **already this URL**: it is set again once per process with the current
     secret (Telegram never reports the secret, so a rotated or hand-set one
     cannot be detected otherwise), and again at any probe whose
     `getWebhookInfo` lists fewer update types than those three. A webhook set
     before the Connect button existed (`["message", "managed_bot"]`) is
     therefore refreshed by itself after the deploy, including if a replica
     still running the old code sets the old list back; nobody sets it by hand;
   - **any other URL**: it is **left untouched** and creation stays unavailable
     here. This protects another environment sharing the token. To move it,
     clear it yourself (`deleteWebhook`) or give this environment its own
     manager bot.

A passed probe is reused for five minutes, a failed one for thirty seconds.
Each change of readiness logs one line on the web service prefixed
`[telegram-create] one-click Telegram unavailable:` with a fixed reason (no
public origin, tables, `getMe`/Bot Management Mode, webhook elsewhere, webhook
not readable); tokens, secrets and URLs are never logged. The availability
endpoint answers only `available: true|false`. When it is false, Settings
opens **Connect an existing bot** instead of showing a Create button.

Keep a single delivery method for the manager: do not also poll it with
`getUpdates`. Pending intents expire after thirty minutes; creation messages
must be fresh and belong to the privately bound human sender. Keep update
receipts at least through the provider's retry window. The tables contain
private account associations and are not public analytics data.

The bot username Telegram suggests in its creation dialog is
`merrymen_<8 random hex>_bot`; it never contains the owner's Telegram id. If
Telegram rejects it, the owner chooses another in the same dialog.

## What the manager says in Telegram

| When | The manager says | Buttons |
| --- | --- | --- |
| A bot is made for a setup underway | ✅ @bot is ready. Connect it to your Merrymen agent? | Connect @bot · Not this bot |
| A bot is made with no setup underway (it expired, was cancelled or replaced, or never began) | Your bot @bot was created, but this Merrymen setup had expired, so it wasn't connected. Start again from Merrymen and create the bot within 30 minutes. | Back to Merrymen |
| **Connect** saved it, or the page did | ✅ Connected @bot to your Merrymen agent. @bot replies once your agent is running. Merrymen then shows "Open my bot" to link your chat with it. If your agent is paused for recovery, that waits until it resumes. | Back to Merrymen |
| **Not this bot** | Cancelled. Start again from Merrymen when you're ready. (The bot itself stays in Telegram; it can be deleted in @BotFather.) | Back to Merrymen |
| **Connect** on an expired setup | This setup expired. Start again from Merrymen. | Back to Merrymen |
| **Connect** when the agent already has a bot | …already has a Telegram bot… replace the bot in Settings. | Back to Merrymen |
| **Connect** on a bot another agent holds | …already connected to another Merrymen agent… (never whose) | Back to Merrymen |
| **Connect** fails for any other reason | Couldn't connect right now. Try again, or connect from Merrymen. | The same two buttons |

Connected means saved, not running. Only the agent's worker (or its hold
process) starts the bot and mints the code "Open my bot" carries; an agent the
fleet holds (not yet admitted, an expired session key, a recovery or
accounting hold) runs neither, and the web cannot see which. So the message
says what the bot waits for and never promises when it will answer.

Back to Merrymen opens `MERRYMEN_PUBLIC_ORIGIN`. Each creation is answered
once: Telegram's redelivery of the same update says nothing again. A message
Telegram refuses to deliver is logged with a fixed line
(`[telegram-create] the manager's … message could not be sent`) and not retried;
the page in Merrymen still offers the bot.

**Who may press Connect.** Only the Telegram user that the setup's `/start`
challenge bound, in their private chat with the manager. That challenge came
from the signed-in owner's own Merrymen page, so the bound user stands for that
owner for this one setup; pressing connects exactly the bot the creation
message proposed, nothing else. A button carries `mc:` or `mx:`, the setup's
random id and the public bot id (at most 60 bytes). It never carries the
challenge, the wallet address or a token. The server finds the setup only
through the presser's Telegram id. Connect runs exactly the web confirmation:
the settings lock, `getManagedBotToken` and `getMe`, then one transaction for
the claim, the sealed token and the completion. Pressing twice, or Telegram
redelivering a press, connects nothing twice. A press from anyone else, or
anywhere else, is answered and changes nothing.

## Association and retry guarantees

A signed wallet session creates a random, tenant-bound `/start` challenge; only
its hash is stored. A private, authenticated Telegram delivery binds one active
intent per Telegram user. A fresh `managed_bot_created` service message proposes
an immutable first candidate. An explicit confirmation (the signed-in owner's on
the web, or the bound Telegram user's Connect button) checks its bot ID, gets
its managed token and verifies `getMe` before a first-wins bot claim. Claim,
encrypted settings and completion commit in one transaction under the normal
settings-save lock. Only `telegramBotToken` and `telegramEnabled` change.

The editable username is not account authority. Generic `managed_bot` events
also describe rotations and owner changes and cannot consume a creation intent.
Update receipts survive restarts, including a creation that matched no setup,
so its redelivery stays silent. A lost confirmation response is reconciled
before the form can save an obsolete manual-token draft. Cancellation, on the
web or with Not this bot, never deletes a bot created in Telegram; its owner
retains it there.

The page keeps checking the setup while it shows **Connect this bot**, so a
connection or cancellation made in Telegram appears there by itself, and it
checks again at once when it comes back into view (a phone's browser tab sleeps
while its owner is in Telegram).

Save is held until a connected bot reads back in Settings only for a
connection that page itself confirmed. A browser can still hold the id of a
setup connected in Telegram that it never saw finish (its tab was closed), and
by its next visit the bot may have been switched off, removed or replaced from
elsewhere. Such a setup is settled by reading Settings back as it is now,
without requiring that bot; then the id is forgotten and Save released. Only a
failed readback keeps the hold, with Refresh Settings to try again.

Local tests use synthetic tokens and disposable SQLite/Postgres databases. Real
Telegram creation, manager capability and webhook delivery need the operator
pilot above; mocked API tests are not evidence of a production connection.
The required CI Postgres job runs the managed-bot suite alongside the partner
store suite against its disposable database, starting from no tables (two
pools provisioning at once) and applying the documented SQL over the result. A
unit test holds that SQL equal to the store's schema.
Hosted activation is read at the API boundary; browser code obtains availability
from the authenticated endpoint.

Official contracts: [Managed Bots](https://core.telegram.org/bots/features#managed-bots),
[request keyboard](https://core.telegram.org/bots/api#keyboardbuttonrequestmanagedbot),
[creation service message](https://core.telegram.org/bots/api#managedbotcreated),
[inline buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton) and
[their presses](https://core.telegram.org/bots/api#answercallbackquery),
[managed token retrieval](https://core.telegram.org/bots/api#getmanagedbottoken),
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).
