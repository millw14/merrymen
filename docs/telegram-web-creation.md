# Telegram bot creation from the web

Hosted Settings → Telegram has a **Create Telegram bot** button. It opens a
private chat with the Merrymen manager. The user starts that chat, taps its
creation button, approves the bot name in Telegram, and confirms the displayed
username back in Settings. Merrymen retrieves and seals the token on the server;
users never copy it. **Open your bot** then uses the existing private `/start`
link to finish linking their agent. Saving a token does not prove a listener is
running, and it does not enable trading or change a wallet permission.

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
     secret and `allowed_updates: ["message", "managed_bot"]`, then reads it back;
   - **already this URL**: it is set again once per process with the current
     secret (Telegram never reports the secret, so a rotated or hand-set one
     cannot be detected otherwise);
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
`getUpdates`. Pending intents expire after ten minutes; creation messages must
be fresh and belong to the privately bound human sender. Keep callback receipts
at least through the provider's retry window. The tables contain private
account associations and are not public analytics data.

The bot username Telegram suggests in its creation dialog is
`merrymen_<8 random hex>_bot`; it never contains the owner's Telegram id. If
Telegram rejects it, the owner chooses another in the same dialog.

## Association and retry guarantees

A signed wallet session creates a random, tenant-bound `/start` challenge; only
its hash is stored. A private, authenticated Telegram delivery binds one active
intent per Telegram user. A fresh `managed_bot_created` service message proposes
an immutable first candidate. An explicit web confirmation checks its bot ID,
gets its managed token and verifies `getMe` before a first-wins bot claim. Claim,
encrypted settings and completion commit in one transaction under the normal
settings-save lock. Only `telegramBotToken` and `telegramEnabled` change.

The editable username is not account authority. Generic `managed_bot` events
also describe rotations and owner changes and cannot consume a creation intent.
Update receipts survive restarts. A lost confirmation response is reconciled
before the form can save an obsolete manual-token draft. Cancellation never
deletes a bot created in Telegram; its owner retains it there.

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
[managed token retrieval](https://core.telegram.org/bots/api#getmanagedbottoken),
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).
