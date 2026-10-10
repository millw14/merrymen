-- The Postgres spelling of TELEGRAM_MANAGED_DDL (web/src/lib/telegram-managed-store.ts).
-- Since 2026-10-10 the web service creates these tables itself at first use
-- (ensureManagedTelegramSchema), so applying this by hand is no longer a step;
-- it is kept as the reviewed schema, and a test holds it equal to the DDL.
-- Running it anyway is harmless: every statement is IF NOT EXISTS.
-- Millisecond timestamps require BIGINT.
BEGIN;

  CREATE TABLE IF NOT EXISTS telegram_managed_intents (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    manager_bot_id TEXT NOT NULL,
    challenge_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN
      ('waiting_telegram', 'waiting_bot', 'confirm', 'connected', 'expired', 'cancelled')),
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    telegram_user_id TEXT,
    bound_at BIGINT,
    bound_message_date BIGINT,
    bound_update_id BIGINT,
    bot_id TEXT,
    bot_username TEXT,
    completed_at BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_managed_active_tenant
    ON telegram_managed_intents (tenant) WHERE status IN ('waiting_telegram', 'waiting_bot', 'confirm');
  CREATE UNIQUE INDEX IF NOT EXISTS telegram_managed_active_user
    ON telegram_managed_intents (telegram_user_id)
    WHERE telegram_user_id IS NOT NULL AND status IN ('waiting_telegram', 'waiting_bot', 'confirm');
  CREATE TABLE IF NOT EXISTS telegram_managed_users (
    telegram_user_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS telegram_managed_users_intent ON telegram_managed_users (intent_id);
  CREATE TABLE IF NOT EXISTS telegram_managed_updates (
    manager_bot_id TEXT NOT NULL,
    update_id BIGINT NOT NULL,
    payload_hash TEXT NOT NULL,
    outcome TEXT NOT NULL,
    intent_id TEXT,
    PRIMARY KEY (manager_bot_id, update_id)
  );

COMMIT;
