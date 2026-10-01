/**
 * One operator recovery notice in Shogun's own approved Telegram room.
 *
 * This never polls updates, changes a room approval or enters a trading path.
 * Dry run reads Shogun's sealed settings, current bot claim and room state. A real send
 * requires the campaign id twice and the exact numeric chat id, checks the
 * durable bot holder and the current bot and chat with Telegram, then writes
 * an at-most-once claim before contacting sendMessage. An interrupted or
 * uncertain attempt stays claimed for manual review; silently retrying it
 * could post a duplicate apology.
 */
import { createHash } from "node:crypto";
import type { MerrymenSettings } from "../../packages/core/src/index";
import { illegalTags, type PgClientLike } from "./announce";
import { mergeSettings } from "./settings";
import { getSettingsStore } from "./settings-store";
import { requireDek } from "./store-crypto";
import { getChat, getMe, sendMessage } from "./telegram/api";
import { botIdOf } from "./telegram/state";
import { approvedTgRoomsForTenant } from "./tg-groups-ferry";

export const SHOGUN_TENANT = "0x8e93bad5a60a266b4283855ceffa0979720aed72" as const;
export const SHOGUN_BOT_USERNAME = "Merrymanme_bot";
export const RECOVERY_ROOM_TITLE = "Merrymen";

export const TG_GROUP_NOTICE_DDL = `CREATE TABLE IF NOT EXISTS tg_group_notices (
  campaign_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at BIGINT NOT NULL,
  sent_at BIGINT,
  PRIMARY KEY (campaign_id, tenant, chat_id)
)`;

// Distinct from the ferry's schema lock (1_297_692_120). Two orchestrator
// replicas may confirm a campaign on the same deploy.
const NOTICE_SCHEMA_LOCK = 1_297_692_121;

async function ensureNoticeSchema(client: PgClientLike): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [NOTICE_SCHEMA_LOCK]);
    await client.query(TG_GROUP_NOTICE_DDL);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* the connection may already be gone */ }
    throw e;
  }
}

type Room = { chatId: number; title: string; kind: string; isForum: boolean };
type BotCheck = typeof getMe;
type ChatCheck = typeof getChat;

/** A missing, moved or unreadable claim is never permission to speak. */
async function shogunHoldsBot(client: PgClientLike, botId: string): Promise<boolean> {
  const { rows } = await client.query("SELECT tenant FROM telegram_bot_claims WHERE bot_id = $1", [botId]);
  return rows.length === 1 && String(rows[0]?.tenant ?? "").toLowerCase() === SHOGUN_TENANT;
}

async function currentShogunGrant(client: PgClientLike): Promise<boolean> {
  const account = await client.query(
    `SELECT a.name AS name FROM grants g
       JOIN agents a ON LOWER(a.smart_account) = LOWER(g.grant_json->>'smartAccount')
      WHERE LOWER(g.tenant) = $1 LIMIT 1`, [SHOGUN_TENANT],
  );
  return account.rows.length === 1 && String(account.rows[0]?.name ?? "").trim().toLowerCase() === "shogun";
}

export interface TgGroupNoticeResult {
  dryRun: boolean;
  campaignId: string;
  /** SHA-256 of the trimmed body that sendMessage would receive. */
  bodySha256: string;
  rooms: Room[];
  selectedChatId: number | null;
  status: "preview" | "sent" | "already-claimed" | "refused" | "uncertain";
  reason?: string;
  /** The operator has to review the exact message, so only the prepared body is included. */
  body: string;
}

export async function runTgGroupRecoveryNotice(opts: {
  client: PgClientLike;
  campaignId: string;
  body: string;
  /** A real send needs this exact id, confirmCampaignId and confirmBodySha256. */
  selectedChatId?: number | null;
  confirmCampaignId?: string | null;
  confirmBodySha256?: string | null;
  settings?: { get(tenant: `0x${string}`): Promise<MerrymenSettings | null> };
  dek?: Buffer;
  env?: Record<string, string | undefined>;
  inspectBot?: BotCheck;
  inspectChat?: ChatCheck;
  send?: typeof sendMessage;
  now?: () => number;
}): Promise<TgGroupNoticeResult> {
  const id = opts.campaignId.trim();
  const body = opts.body.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("campaign id must be 1–64 lowercase letters, digits or hyphens");
  if (!body || body.length > 3600 || illegalTags(body).length > 0) {
    throw new Error("notice body must be 1–3600 characters with Telegram-supported HTML tags only");
  }
  const selected = opts.selectedChatId ?? null;
  if (selected !== null && (!Number.isSafeInteger(selected) || selected >= 0)) {
    throw new Error("selected chat id must be an exact negative Telegram group id");
  }
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const campaignAndChatConfirmed = opts.confirmCampaignId === id && selected !== null;
  const confirmed = campaignAndChatConfirmed && opts.confirmBodySha256 === bodyHash;
  const out: TgGroupNoticeResult = {
    dryRun: !confirmed, campaignId: id, bodySha256: bodyHash, rooms: [], selectedChatId: selected,
    status: "preview", body,
  };
  const refuse = (reason: string): TgGroupNoticeResult => ({ ...out, status: "refused", reason });
  if (campaignAndChatConfirmed && !confirmed) return refuse("body SHA-256 does not match the reviewed dry run");
  const env = opts.env ?? process.env;
  if (env.MERRYMEN_TG_GROUPS?.trim() === "0") return refuse("operator group switch is off");

  const settingsReader = opts.settings ?? getSettingsStore();
  const settings = await settingsReader.get(SHOGUN_TENANT);
  if (!settings?.telegramBotToken) return refuse("Shogun has no stored bot token");
  const resolved = mergeSettings(settings, env);
  if (!resolved.telegramEnabled || !resolved.telegramGroupsEnabled) return refuse("Shogun has Telegram groups switched off");
  const token = settings.telegramBotToken;
  const botId = botIdOf(token);
  if (!botId) return refuse("Shogun's stored bot token is invalid");
  if (!await shogunHoldsBot(opts.client, botId)) return refuse("Shogun does not hold the durable bot claim");

  if (!await currentShogunGrant(opts.client)) {
    return refuse("tenant has no current Shogun grant/account match");
  }

  const rooms = await approvedTgRoomsForTenant(opts.client, SHOGUN_TENANT, opts.dek ?? requireDek());
  if (rooms === null) return refuse("Shogun has no readable durable group state");
  out.rooms = rooms.filter((room) => room.title === RECOVERY_ROOM_TITLE &&
    (room.kind === "group" || room.kind === "supergroup"));
  if (out.rooms.length === 0) return refuse("no approved Merrymen room in Shogun's state");

  if (!confirmed) return out;
  const room = out.rooms.find((r) => r.chatId === selected);
  if (!room) return refuse("selected chat id is not an approved Merrymen room");
  if (room.isForum) return refuse("forum room needs an explicit topic; this notice has none");

  // The dry run above is read-only, including no receipt table creation.
  // Concurrent first sends serialize schema creation behind an advisory lock.
  await ensureNoticeSchema(opts.client);

  const prior = await opts.client.query(
    `SELECT status FROM tg_group_notices WHERE campaign_id = $1 AND tenant = $2 AND chat_id = $3`,
    [id, SHOGUN_TENANT, selected],
  );
  if (prior.rows.length > 0) return { ...out, status: "already-claimed" };

  // These lookups never read updates, so they cannot steal the child's poll.
  const bot = await (opts.inspectBot ?? getMe)({ token });
  if (!bot.bot?.isBot || String(bot.bot.id) !== botId ||
      bot.bot.username.toLowerCase() !== SHOGUN_BOT_USERNAME.toLowerCase()) {
    return refuse("stored token does not identify Shogun's expected bot");
  }
  const chat = await (opts.inspectChat ?? getChat)({ token }, selected!);
  if (!chat.chat || chat.chat.id !== selected || chat.chat.title !== RECOVERY_ROOM_TITLE ||
      (chat.chat.type !== "group" && chat.chat.type !== "supergroup") || chat.chat.isForum) {
    return refuse("Telegram's current chat identity does not match the approved room");
  }

  // Re-read the owner-approved state after the network checks: an owner could
  // have removed approval while Telegram was answering. Fail closed.
  const stillApproved = await approvedTgRoomsForTenant(opts.client, SHOGUN_TENANT, opts.dek ?? requireDek());
  if (!stillApproved?.some((r) => r.chatId === selected && r.title === RECOVERY_ROOM_TITLE && !r.isForum &&
    (r.kind === "group" || r.kind === "supergroup"))) return refuse("room approval changed before send");

  // The network checks can take seconds. Settings and bot ownership are live
  // owner decisions: do not send with a token or consent captured before them.
  const freshSettings = await settingsReader.get(SHOGUN_TENANT);
  if (!freshSettings?.telegramBotToken || freshSettings.telegramBotToken !== token) {
    return refuse("Shogun's bot token changed before send");
  }
  if (env.MERRYMEN_TG_GROUPS?.trim() === "0") return refuse("operator group switch changed before send");
  const freshResolved = mergeSettings(freshSettings, env);
  if (!freshResolved.telegramEnabled || !freshResolved.telegramGroupsEnabled) {
    return refuse("Shogun switched Telegram groups off before send");
  }
  if (!await currentShogunGrant(opts.client)) return refuse("Shogun's grant/account changed before send");
  if (!await shogunHoldsBot(opts.client, botId)) return refuse("Shogun's bot claim changed before send");

  const now = opts.now ?? Date.now;
  const claim = await opts.client.query(
    `INSERT INTO tg_group_notices (campaign_id, tenant, chat_id, body_sha256, status, claimed_at)
     SELECT $1, $2, $3, $4, 'claimed', $5
       WHERE EXISTS (SELECT 1 FROM telegram_bot_claims WHERE bot_id = $6 AND LOWER(tenant) = $2)
     ON CONFLICT DO NOTHING RETURNING status`,
    [id, SHOGUN_TENANT, selected, bodyHash, Math.floor(now() / 1000), botId],
  );
  if (claim.rows.length !== 1) {
    if (!await shogunHoldsBot(opts.client, botId)) return refuse("Shogun's bot claim changed during notice claim");
    return { ...out, status: "already-claimed" };
  }

  try {
    const sent = await (opts.send ?? sendMessage)({ token }, selected!, body, { disablePreview: true });
    const status = sent.ok ? "sent" : "uncertain";
    try {
      await opts.client.query(
        `UPDATE tg_group_notices SET status = $1, sent_at = $2
          WHERE campaign_id = $3 AND tenant = $4 AND chat_id = $5 AND status = 'claimed'`,
        [status, sent.ok ? Math.floor(now() / 1000) : null, id, SHOGUN_TENANT, selected],
      );
    } catch {
      // The durable pre-send claim still prevents a duplicate. Operators can
      // inspect the claimed row manually; never retry automatically.
      return { ...out, status: "uncertain", reason: "send attempted; receipt update failed" };
    }
    return { ...out, status, ...(!sent.ok ? { reason: "Telegram did not confirm delivery; claim retained" } : {}) };
  } catch {
    return { ...out, status: "uncertain", reason: "send result unknown; claim retained" };
  }
}
