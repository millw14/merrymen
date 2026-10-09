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

## Operator activation plan

The feature is off by default. This code does not create tables, configure a
webhook, or provision a production manager automatically. Do not activate it
until the database backup and deployment plan have been reviewed.

1. Use a dedicated operator bot and enable **Bot Management Mode** in the
   BotFather Mini App. Do not reuse an agent's bot: the manager receives a
   separate update stream and must never be assigned to a tenant.
2. Back up Postgres and verify the backup. Review and apply
   `docs/migrations/2026-10-05-telegram-managed.sql` explicitly. It adds only
   onboarding intents, Telegram-user leases and callback receipts; it does not
   modify trading records, tenant settings or existing Telegram links.
3. Configure these secrets **on the web service only**, with creation still off:

   | Variable | Value |
   | --- | --- |
   | `MERRYMEN_TELEGRAM_MANAGER_TOKEN` | Dedicated manager's Bot API token |
   | `MERRYMEN_TELEGRAM_MANAGER_USERNAME` | Its username, without `@` |
   | `MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET` | Independent random 32–256 character secret using letters, digits, `_` and `-` |

   The hosted service already requires `DATABASE_URL` and `MERRYMEN_STORE_DEK`.
   Keep these values out of client variables, shell arguments, request logs,
   screenshots and source control. Do not hand manager credentials to workers.
4. Configure the manager's HTTPS webhook to
   `https://<web-host>/api/telegram/manager/webhook`, using the same `secret_token`
   and explicit `allowed_updates: ["message", "managed_bot"]`. Keep a single
   delivery method for the manager; do not also poll it. This step is an
   operator action, not performed by the application.
5. Deploy the reviewed main commit, then set
   `MERRYMEN_TELEGRAM_CREATE_ENABLED=true` through the reviewed activation plan.
   Announce production rollout before triggering it. Start with a disposable
   operator test account and bot; verify private linking and actual listening
   before opening creation to users. If Telegram rejects a suggested username,
   choose another in its dialog.

Turn creation off by clearing the enabled flag. Existing tenant bots continue
through their current worker path. Pending intents expire after ten minutes;
creation messages must be fresh and belong to the privately bound human sender.
Keep callback receipts at least through the provider's retry window. The tables
contain private account associations and are not public analytics data.

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
store suite against its disposable database, including the exact SQL migration.
Hosted activation is read at the API boundary; browser code obtains availability
from the authenticated endpoint.

Official contracts: [Managed Bots](https://core.telegram.org/bots/features#managed-bots),
[request keyboard](https://core.telegram.org/bots/api#keyboardbuttonrequestmanagedbot),
[creation service message](https://core.telegram.org/bots/api#managedbotcreated),
[managed token retrieval](https://core.telegram.org/bots/api#getmanagedbottoken),
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).
