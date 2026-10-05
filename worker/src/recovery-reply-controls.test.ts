import assert from "node:assert/strict";
import { test } from "node:test";
import { recoveryControlOf, recoveryControlsEnabled, recordRecoveryControl, RECOVERY_KILL_CONFIRMED, RECOVERY_KILL_PROMPT, RECOVERY_PAUSE_RECORDED } from "./recovery-reply-controls";
import type { ReplyQuery, ReplySnapshot } from "./recovery-reply-store";
import type { TgMessage } from "./telegram/api";
import { CONFIRM_TTL_SEC } from "./telegram/kill-confirm";

const snapshot: ReplySnapshot = { grant: { tenant: "0x" + "1".repeat(40) as `0x${string}`, account: "0x" + "2".repeat(40), chainId: 4663, receipt: "current-authority" },
    botId: "801", token: "never_used", tokenTag: "a".repeat(16), ownerId: 701, allowlist: [701, -901, 777], claimStamp: 200,
    rooms: [-901], groupCoinsEnabled: true, receipt: "current-snapshot" };
const msg = (text: string, extra: Partial<TgMessage> = {}): TgMessage => ({ updateId: 20, messageId: 120, chatId: 701, fromId: 701, date: 1000, text, ...extra });
const parse = (message: TgMessage, s = snapshot, groupsEnabled = true) => recoveryControlOf(message, s, "bot_801", { armedAt: 900, nowSec: 1000, groupsEnabled });

test("restrictive control parser accepts exact commands from the current owner only", () => {
    for (const kind of ["pause", "kill", "confirm", "cancel"] as const) {
        assert.equal(parse(msg(`/${kind}`)), kind);
        assert.equal(parse(msg(`/${kind}@BOT_801`)), kind);
        assert.equal(parse(msg(`/${kind}`, { fromId: 777, chatId: 777 })), null, "allowlisting another user is not owner authority");
    }
    for (const text of ["/resume", "pause", "/pause now", "@bot_801 /pause", "/pause@otherbot", "Robin /kill", "/confirm-buy", "/yes"])
        assert.equal(parse(msg(text)), null);
});

test("approved groups need an exact bot target or reply, current owner and enabled group routing", () => {
    assert.equal(parse(msg("/pause@bot_801", { chatId: -901 })), "pause");
    assert.equal(parse(msg("/kill", { chatId: -901, replyTo: { messageId: 1, fromId: 801 } })), "kill");
    for (const extra of [ { chatId: -901 }, { chatId: -901, fromId: 777 }, { chatId: -902 }, { chatId: -901, senderChatId: -901 }, { chatId: -901, fromIsBot: true } ])
        assert.equal(parse(msg("/pause@bot_801", extra)), extra.fromId || extra.senderChatId || extra.fromIsBot || extra.chatId === -902 ? null : "pause");
    assert.equal(parse(msg("/pause", { chatId: -901 })), null);
    assert.equal(parse(msg("/pause", { chatId: -901, replyTo: { messageId: 1, fromId: 802 } })), null);
    assert.equal(parse(msg("/pause@bot_801", { chatId: -901 }), snapshot, false), null);
    assert.equal(parse(msg("/pause"), { ...snapshot, allowlist: [-901] }), null);
});

test("prearm and future controls are ignored; delayed postarm restrictive messages remain eligible", () => {
    assert.equal(parse(msg("/pause", { date: 899 })), null);
    assert.equal(parse(msg("/pause", { date: 1001 })), null);
    assert.equal(parse(msg("/pause", { date: 900 })), "pause", "reply deadline does not erase an owner's restrictive request");
    for (const extra of [{ updateId: -1 }, { updateId: Number.MAX_SAFE_INTEGER }, { date: NaN }, { chatId: 0 }, { fromId: -1 }])
        assert.equal(parse(msg("/pause", extra)), null);
});

test("control setting retains file over env over shared-default semantics", () => {
    assert.equal(recoveryControlsEnabled(snapshot), true);
    assert.equal(recoveryControlsEnabled(snapshot, "false"), false);
    assert.equal(recoveryControlsEnabled(snapshot, "1"), true);
    assert.equal(recoveryControlsEnabled(snapshot, "TRUE"), true);
    assert.equal(recoveryControlsEnabled({ ...snapshot, telegramControlEnabled: false }, "1"), false);
    assert.equal(recoveryControlsEnabled({ ...snapshot, telegramControlEnabled: true }, "0"), true);
});

test("journal only appends bound metadata and truthful recorded-only replies", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const db: ReplyQuery = { query: async (sql, values) => { statements.push({ sql, values });
        return { rows: /SELECT r.update_id/.test(sql) ? [{ update_id: "10", message_at_sec: "990", expires_at_ms: "1080000", resolved: false }] : [{ update_id: values![9] }] }; } };
    assert.equal(await recordRecoveryControl(db, snapshot, msg("/pause"), "pause", 1000000, true), RECOVERY_PAUSE_RECORDED);
    assert.equal(await recordRecoveryControl(db, snapshot, msg("/kill"), "kill", 1000000, true), RECOVERY_KILL_PROMPT);
    assert.equal(statements[1]!.values![14], 1000000 + CONFIRM_TTL_SEC * 1000);
    assert.equal(await recordRecoveryControl(db, snapshot, msg("/confirm"), "confirm", 1000000, true), RECOVERY_KILL_CONFIRMED);
    for (const { sql, values } of statements) {
        assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|ALTER)\b|sealed_session_key|agent_commands|\bgrants\b/i);
        assert.equal(values![0], snapshot.grant.tenant); assert.equal(values![1], snapshot.grant.account);
        assert.equal(values![2], 4663); assert.equal(values![3], snapshot.botId);
        assert.match(String(values![6]), /^[0-9a-f]{64}$/); assert.ok(!values!.includes(snapshot.token));
    }
});

test("disabled pause, kill and confirmation record nothing; cancellation cannot enable trading", async () => {
    let calls = 0; const db: ReplyQuery = { query: async () => { calls++; return { rows: [] }; } };
    for (const kind of ["pause", "kill", "confirm"] as const)
        assert.match(await recordRecoveryControl(db, snapshot, msg(`/${kind}`), kind, 1000000, false), /turned off.*No stop request was recorded/);
    assert.equal(calls, 0);
    assert.match(await recordRecoveryControl(db, snapshot, msg("/cancel"), "cancel", 1000000, false), /no pending kill request/);
    assert.equal(calls, 1);
});

test("confirmation never treats missing, expired or unreadable pending state as authorization", async () => {
    let insertions = 0;
    const db = (rows: Record<string, unknown>[]): ReplyQuery => ({ query: async sql => { if (/INSERT/.test(sql)) insertions++; return { rows }; } });
    assert.match(await recordRecoveryControl(db([]), snapshot, msg("/confirm"), "confirm", 1000000, true), /no pending kill request/);
    assert.match(await recordRecoveryControl(db([{ update_id: 10, message_at_sec: 990, expires_at_ms: 999999, resolved: false }]), snapshot, msg("/confirm"), "confirm", 1000000, true), /expired/);
    assert.match(await recordRecoveryControl(db([{ update_id: 10, message_at_sec: 990, expires_at_ms: 1080000, resolved: true }]), snapshot, msg("/confirm"), "confirm", 1000000, true), /no pending kill request/);
    await assert.rejects(recordRecoveryControl(db([{ update_id: 10, message_at_sec: 990, expires_at_ms: "unknown", resolved: false }]), snapshot, msg("/confirm"), "confirm", 1000000, true));
    await assert.rejects(recordRecoveryControl(db([{ update_id: 10, message_at_sec: 1001, expires_at_ms: 1090000, resolved: false }]), snapshot, msg("/confirm"), "confirm", 1000000, true));
    await assert.rejects(recordRecoveryControl(db([{ update_id: 10, message_at_sec: 990, expires_at_ms: 1080000 }]), snapshot, msg("/confirm"), "confirm", 1000000, true));
    assert.equal(insertions, 0);
});
