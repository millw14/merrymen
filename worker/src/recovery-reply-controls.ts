/** Restrictive owner requests only. No grant deletion, signing, execution or resume. */
import { createHash } from "node:crypto";
import { SETTINGS_DEFAULTS } from "../../packages/core/src/settings";
import type { ReplyQuery, ReplySnapshot } from "./recovery-reply-store";
import type { TgMessage } from "./telegram/api";
import { CONFIRM_TTL_SEC } from "./telegram/kill-confirm";
import { recoveryReplyRefused } from "./recovery-reply-proof";

/** Additive migration; never run by a read-only preview. Existing rows are append-only. */
export const RECOVERY_REPLY_CONTROLS_SCHEMA = `CREATE TABLE IF NOT EXISTS recovery_reply_controls (
 bot_id TEXT NOT NULL, update_id BIGINT NOT NULL CHECK(update_id>=0 AND update_id<9007199254740991),
 tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
 token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, grant_tag TEXT NOT NULL,
 owner_id BIGINT NOT NULL, chat_id BIGINT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('pause','kill-request','kill-confirm','kill-cancel')),
 request_update_id BIGINT, message_at_sec BIGINT NOT NULL CHECK(message_at_sec>0),
 recorded_at_ms BIGINT NOT NULL CHECK(recorded_at_ms>0), expires_at_ms BIGINT,
 PRIMARY KEY(bot_id,update_id),
 FOREIGN KEY(bot_id,request_update_id) REFERENCES recovery_reply_controls(bot_id,update_id),
 CHECK((kind IN ('kill-confirm','kill-cancel'))=(request_update_id IS NOT NULL)),
 CHECK((kind='kill-request')=(expires_at_ms IS NOT NULL))
); CREATE UNIQUE INDEX IF NOT EXISTS recovery_reply_control_resolution
 ON recovery_reply_controls(bot_id,request_update_id) WHERE request_update_id IS NOT NULL;`;

export type RecoveryControl = "pause" | "kill" | "confirm" | "cancel";
export const RECOVERY_PAUSE_RECORDED = "Your pause request is recorded durably. Automated trading remains paused, and this request must be checked before trading resumes.";
export const RECOVERY_KILL_PROMPT = `Your kill request is recorded. Send /confirm in this chat within ${CONFIRM_TTL_SEC} seconds of your /kill message, or /cancel. This records a stop request; your stored trading permission has not been deleted or revoked.`;
export const RECOVERY_KILL_CONFIRMED = "Your confirmed kill request is recorded durably. Automated trading remains paused. Your stored trading permission has not been deleted or revoked by this listener.";
const disabled = "Control commands are turned off in your Telegram settings. No stop request was recorded. Automated trading remains paused.";
const noPending = "There is no pending kill request for you in this chat. Automated trading remains paused.";
const expired = "That kill confirmation expired. Send /kill again to record a new request. No trading permission was changed.";
const cancelled = "Your pending kill request was cancelled. Any earlier pause or confirmed kill remains recorded; automated trading remains paused.";
const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Same resolver as settings.ts: a boolean file wins; env 1/true; shared default. */
export function recoveryControlsEnabled(s: Pick<ReplySnapshot, "telegramControlEnabled">, env?: string): boolean {
    if (typeof s.telegramControlEnabled === "boolean") return s.telegramControlEnabled;
    if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
    return SETTINGS_DEFAULTS.telegramControlEnabled;
}

/** Exact owner commands. No broad mention stripping, model interpretation or group allowlist authority. */
export function recoveryControlOf(msg: TgMessage, s: ReplySnapshot, username: string,
    options: { armedAt: number; nowSec: number; groupsEnabled: boolean }): RecoveryControl | null {
    if (!safe(msg.updateId) || msg.updateId < 0 || msg.updateId >= Number.MAX_SAFE_INTEGER
        || !safe(msg.chatId) || msg.chatId === 0 || !safe(msg.fromId) || msg.fromId !== s.ownerId
        || !s.allowlist.includes(msg.fromId) || msg.fromIsBot === true || msg.senderChatId !== undefined
        || !safe(msg.date) || msg.date <= 0 || msg.date < options.armedAt || msg.date > options.nowSec)
        return null;
    const command = /^\/(pause|kill|confirm|cancel)(?:@([A-Za-z0-9_]+))?\s*$/i.exec(msg.text.trim());
    if (!command || (command[2] && command[2].toLowerCase() !== username.toLowerCase())) return null;
    if (msg.chatId > 0) {
        if (msg.chatId !== s.ownerId) return null;
    } else if (!options.groupsEnabled || !s.rooms.includes(msg.chatId)
        || (!command[2] && String(msg.replyTo?.fromId) !== s.botId)) return null;
    return command[1]!.toLowerCase() as RecoveryControl;
}

interface PendingKill { update_id: unknown; message_at_sec: unknown; expires_at_ms: unknown; resolved: unknown }
const integer = (v: unknown): number => {
    if (typeof v !== "number" && (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v))) throw recoveryReplyRefused();
    const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw recoveryReplyRefused(); return n;
};

/** Caller holds current grant/settings/claim/link row locks, root and exclusive tenant/bot leases.
 * Append and offset advancement MUST share one transaction. A refusal must roll both back.
 */
export async function recordRecoveryControl(db: ReplyQuery, s: ReplySnapshot, msg: TgMessage,
    command: RecoveryControl, atMs: number, enabled: boolean): Promise<string> {
    if (!safe(atMs) || atMs <= 0 || !safe(msg.date) || msg.date <= 0 || !safe(msg.date * 1000) || msg.date * 1000 > atMs
        || !safe(msg.updateId) || msg.updateId < 0 || msg.updateId >= Number.MAX_SAFE_INTEGER || !safe(msg.chatId) || msg.chatId === 0
        || msg.fromId !== s.ownerId || !s.allowlist.includes(s.ownerId)) throw recoveryReplyRefused();
    if (command !== "cancel" && !enabled) return disabled;
    const grantTag = digest(s.grant.receipt);
    const bound = [s.grant.tenant, s.grant.account, s.grant.chainId, s.botId, s.tokenTag, s.claimStamp, grantTag, s.ownerId, msg.chatId];
    let request: number | null = null;
    if (command === "confirm" || command === "cancel") {
        // The newest request supersedes older unconfirmed requests in this exact authority/chat scope.
        // Select it BEFORE checking resolution: cancel/confirm must never resurrect an older request.
        const rows = (await db.query(`SELECT r.update_id,r.message_at_sec,r.expires_at_ms,
            EXISTS(SELECT 1 FROM recovery_reply_controls d WHERE d.bot_id=r.bot_id AND d.request_update_id=r.update_id) AS resolved
          FROM recovery_reply_controls r
          WHERE r.tenant=$1 AND r.smart_account=$2 AND r.chain_id=$3 AND r.bot_id=$4
            AND r.token_tag=$5 AND r.claim_stamp=$6 AND r.grant_tag=$7 AND r.owner_id=$8 AND r.chat_id=$9
            AND r.kind='kill-request' AND r.update_id<$10
          ORDER BY r.update_id DESC LIMIT 1`, [...bound, msg.updateId])).rows as unknown as PendingKill[];
        if (!rows.length) return noPending;
        if (rows.length !== 1) throw recoveryReplyRefused();
        if (rows[0]!.resolved === true) return noPending;
        if (rows[0]!.resolved !== false) throw recoveryReplyRefused();
        request = integer(rows[0]!.update_id);
        const askedAt = integer(rows[0]!.message_at_sec), expiresAt = integer(rows[0]!.expires_at_ms);
        if (msg.date < askedAt || request >= msg.updateId || !safe(askedAt * 1000)
            || expiresAt < askedAt * 1000 || expiresAt > askedAt * 1000 + CONFIRM_TTL_SEC * 1000) throw recoveryReplyRefused();
        if (command === "confirm" && (atMs > expiresAt || msg.date * 1000 > expiresAt)) return expired;
    }
    const kind = command === "kill" ? "kill-request" : command === "confirm" ? "kill-confirm" : command === "cancel" ? "kill-cancel" : "pause";
    // Processing a delayed batch cannot give an old request a new confirmation window.
    const expiresAt = command === "kill" ? Math.min(atMs, msg.date * 1000) + CONFIRM_TTL_SEC * 1000 : null;
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) throw recoveryReplyRefused();
    const result = await db.query(`INSERT INTO recovery_reply_controls
      (tenant,smart_account,chain_id,bot_id,token_tag,claim_stamp,grant_tag,owner_id,chat_id,update_id,
       kind,request_update_id,message_at_sec,recorded_at_ms,expires_at_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING update_id`,
        [...bound, msg.updateId, kind, request, msg.date, atMs, expiresAt]);
    if (result.rows.length !== 1 || integer(result.rows[0]!.update_id) !== msg.updateId) throw recoveryReplyRefused();
    return command === "pause" ? RECOVERY_PAUSE_RECORDED : command === "kill" ? RECOVERY_KILL_PROMPT
        : command === "confirm" ? RECOVERY_KILL_CONFIRMED : cancelled;
}
