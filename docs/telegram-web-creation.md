# Telegram bot creation from the web

Hosted Settings → Telegram has a **Create Telegram bot** button (Home has the
same flow as **Set up Telegram**). It opens a private chat with the Merrymen
manager. The user starts that chat and approves the bot name in Telegram.
The manager offers the usual creation button and a second **Create my bot on
iPhone or iPad** link. The link opens Telegram's create-bot screen directly;
keep its suggested username so Merrymen can associate the resulting notice
with this setup. The bot's display name can be changed. The manager then
answers in the same chat:

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
     then reads it back and requires this URL and all three update types;
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
`merrymen_<16 hex>_bot`, derived with a domain-separated hash of this setup's
random challenge hash. It stays the same when `/start` is retried and never
contains the owner's Telegram id. The native request button permits a different
username. The iPhone/iPad link requires this exact suggestion; if it is taken,
start a new setup for a new suggestion, or connect an existing bot manually.

## What the manager says in Telegram

| When | The manager says | Buttons |
| --- | --- | --- |
| A bot is made for a setup underway | ✅ @bot is ready. Connect it to your Merrymen agent? | Connect @bot · Not this bot |
| A bot is made with no setup underway (it expired, was cancelled or replaced, or never began) | Your bot @bot was created, but no Merrymen setup is waiting for it, so it wasn't connected. To connect a new bot, start again from Merrymen and create it within 30 minutes. | Back to Merrymen |
| **Connect** saved it, or the page did | ✅ Connected @bot to your Merrymen agent. @bot replies once your agent is running. Merrymen then shows "Open my bot" to link your chat with it. If your agent is paused for recovery, that waits until it resumes. | Back to Merrymen |
| **Not this bot** | Cancelled. Start again from Merrymen when you're ready. (The bot itself stays in Telegram; it can be deleted in @BotFather.) | Back to Merrymen |
| **Connect** on an expired setup | This setup expired. Start again from Merrymen. | Back to Merrymen |
| **Connect** when the agent already has a bot | …already has a Telegram bot… replace the bot in Settings. | Back to Merrymen |
| **Connect** on a bot another agent holds | …already connected to another Merrymen agent… (never whose) | Back to Merrymen |
| **Connect** fails for any other reason | A separate message: Couldn't connect right now. Try again, or connect from Merrymen. | Original proposal retains its buttons |

Connected means saved, not running. Only the agent's worker (or, when its
practice book would not restore, its hold process) starts the bot and mints the
code "Open my bot" carries; an agent the fleet holds (not yet admitted, an
expired session key, a recovery or accounting hold) runs neither, and the web
cannot see which. So the message says what the bot waits for and never
promises when it will answer.

Home and Settings do the same once the bot is saved. They cannot see the
fleet's reasons either, but `/api/grants` says what follows from them: the
session key has expired, the worker's heartbeat is stale, or no heartbeat was
ever written. With no link code and any of those, they say the bot answers once
the agent is running and that it isn't (or hasn't started, or needs its
permission renewed, with a link to renew), instead of "check back shortly", and
Home stops re-reading every few seconds until the agent runs.

A recovery hold gets the same treatment in its own words. A held tenant is one
the rollout has not admitted, so nothing runs its worker, and the recovery
listener (where it runs at all) has no `/link` and answers only an owner
already linked to that exact bot. A bot saved while held therefore has no code
and no replies until the agent resumes: Settings says "Trading is paused for
recovery, so @bot won't answer yet and has no link code; both come once your
agent resumes", Home's recovery row says "Saved. @bot answers once your agent
resumes", and neither waits or re-reads for a code.

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
`getManagedBotToken` and `getMe`, then a fresh intent read under the settings
lock and one transaction for the claim, the sealed token and the completion.
Token lookups and manager messages do not hold a settings or manager delivery
lock. Valid taps are acknowledged before token lookup. Refused attempts send
a separate message so a late failure cannot replace a concurrent success.
Pressing twice, or Telegram redelivering a press, connects nothing twice. A press from anyone else, or
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

The editable username alone is not account authority. The deep link reports a
`managed_bot` event, not a `managed_bot_created` service message. It has **no
creation timestamp or event-kind discriminator**: Telegram also uses it for
token and ownership changes. This event may propose a candidate only when all
of these match:

- The authenticated manager webhook and the human Telegram account bound by
  the private `/start` challenge.
- An unexpired intent still in `waiting_bot`.
- An update ID strictly later than the binding `/start` update.
- The exact per-intent suggested username, compared case-insensitively.

These establish setup correlation, not proof of the event's reason. A token
rotation for the same bot during that setup can match; it still cannot save a
token without the owner's explicit Connect, live credential validation, and
exclusive tenant claim. Unrelated, earlier, expired or already-decided generic
events are ignored. A delayed native creation notice for a bot already accepted
through the generic event is silent, including after connection.

Update receipts survive restarts, including a creation that matched no setup,
so its redelivery stays silent. A lost confirmation response is reconciled
before the form can save an obsolete manual-token draft. Cancellation, on the
web or with Not this bot, never deletes a bot created in Telegram; its owner
retains it there.

The page keeps checking the setup while it shows **Connect this bot**, so a
connection or cancellation made in Telegram appears there by itself, and it
checks again at once when it comes back into view (a phone's browser tab sleeps
while its owner is in Telegram). A check that fails (a deploy's 502 or 503, or
a fetch the phone killed while the tab slept) shows its error and the checks go
on, further apart each time up to 30 seconds; the first that works clears it.
Only the latest poll or wake read may update the page, so an older response
cannot restore Connect after a newer read found the connection. The local
browser deadline keeps Save held until the setup or saved Settings is read
back; Telegram may have connected the bot while the browser slept.

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
[generic managed-bot event](https://core.telegram.org/bots/api#managedbotupdated),
[managed-bot creation links](https://core.telegram.org/api/links#managed-bot-creation-request-links),
[inline buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton) and
[their presses](https://core.telegram.org/bots/api#answercallbackquery),
[managed token retrieval](https://core.telegram.org/bots/api#getmanagedbottoken),
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).
