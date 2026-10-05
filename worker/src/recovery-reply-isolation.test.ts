/** Pure: the reply listener's failure vocabulary and row-by-row roster read. No database, Telegram or home. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CONFLICT_ALARM_BOTS, CONFLICT_ALARM_WINDOW_MS, CONFLICT_PAUSE_MS, CONFLICT_STALE_MS, isTransientReplyDbError, isWebhookConflict,
  recoveryReplyExitLine, replyBackoffMs, ReplyActorStop, ReplyConflictAlarm, RecoveryReplyFleetRefusal, tenantTag,
} from "./recovery-reply-isolation";
import { recoveryReplyRefused } from "./recovery-reply-proof";
import { readReplyRoster, REPLY_ROSTER_CAP, ReplyGrantChanged, ReplyRosterCapExceeded, scanReplyRoster, type ReplyQuery } from "./recovery-reply-store";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
/** A roster row exactly as the GRANTS projection returns it. */
const row = (tenant: string, account: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant, chain_id: 4663, updated_at: "100", account, owner: addr(0x301), session: addr(0x401), grant_chain: "4663", granted: "1", expires: "2",
  stop_session: null, stop_at: null, stop_hash_valid: false,
  incarnation: `7:(0,1):${createHash("sha256").update(tenant).digest("hex")}`, ...extra,
});
const db = (rows: Record<string, unknown>[]): ReplyQuery => ({ query: async sql => { assert.match(sql, /ORDER BY tenant LIMIT 257$/); return { rows }; } });

test("transient database failures are recognized; refusals and other SQLSTATEs are not", () => {
  const coded = (code: string, message = "x") => Object.assign(new Error(message), { code });
  // The two production triggers, and their relatives.
  for (const code of ["57014", "55P03", "08006", "08003", "57P01", "53300", "40001", "40P01", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"])
    assert.equal(isTransientReplyDbError(coded(code)), true, code);
  for (const message of ["Connection terminated unexpectedly", "Connection terminated due to connection timeout", "timeout exceeded when trying to connect", "Query read timeout", "Client has encountered a connection error and is not queryable"])
    assert.equal(isTransientReplyDbError(new Error(message)), true, message);
  for (const e of [coded("42P01"), coded("23505"), coded("22P02"), recoveryReplyRefused(), new ReplyGrantChanged(), new ReplyActorStop("lease-lost"),
    new RecoveryReplyFleetRefusal("root-proof"), new Error("something else"), "57014", null, { code: "57014" }])
    assert.equal(isTransientReplyDbError(e), false, String(e));
});

test("back-off schedules double from their base to their cap and honour a longer retry_after", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(n => replyBackoffMs("telegram-409", n)), [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  assert.deepEqual([1, 2, 3, 6, 7, 30].map(n => replyBackoffMs("telegram-network", n)), [2_000, 4_000, 8_000, 60_000, 60_000, 60_000]);
  assert.deepEqual([1, 2, 7].map(n => replyBackoffMs("db-transient", n)), [2_000, 4_000, 60_000]);
  assert.deepEqual([1, 2, 7].map(n => replyBackoffMs("admission", n)), [5_000, 10_000, 300_000]);
  assert.deepEqual([1, 5].map(n => replyBackoffMs("actor-error", n)), [60_000, 600_000]);
  assert.equal(replyBackoffMs("telegram-network", 1, 30), 30_000, "Telegram's retry_after wins when it is longer");
  assert.equal(replyBackoffMs("telegram-network", 6, 5), 60_000, "and never shortens the schedule");
  assert.equal(replyBackoffMs("telegram-network", 1, 1e9), 3_600_000, "an absurd retry_after is capped at an hour");
  for (const odd of [0, -3, NaN, Infinity]) assert.equal(replyBackoffMs("db-transient", odd), 2_000, String(odd));
});

test("the multi-bot 409 alarm trips only on three or more NEW conflicts that are a majority of the serving bots", () => {
  assert.equal(CONFLICT_ALARM_BOTS, 3); assert.equal(CONFLICT_ALARM_WINDOW_MS, 120_000); assert.equal(CONFLICT_PAUSE_MS, 600_000);
  const alarm = new ReplyConflictAlarm();
  assert.equal(alarm.conflict("801", 0, 4), false); assert.equal(alarm.conflict("801", 1_000, 4), false, "the same bot twice is one bot");
  assert.equal(alarm.conflict("802", 2_000, 4), false); assert.equal(alarm.size, 2);
  alarm.clear("801");
  assert.equal(alarm.conflict("803", 3_000, 4), false, "a bot that polled cleanly again no longer counts");
  assert.equal(alarm.conflict("804", 4_000, 4), true, "three new conflicts out of four serving bots");
  // Those three are SPENT: seen again right away (a short pause, a resume),
  // they cannot trip it a second time. A clean poll ends one; a new conflict
  // on that bot is new again, but one new conflict is not three.
  for (const id of ["802", "803", "804"]) assert.equal(alarm.conflict(id, 5_000, 4), false, `${id} again`);
  alarm.clear("802");
  assert.equal(alarm.conflict("802", 6_000, 4), false); assert.equal(alarm.conflict("801", 6_000, 4), false);
  assert.equal(alarm.conflict("805", 6_000, 4), true, "three conflicts new since the trip");

  // A MINORITY never trips it, however many: three owners with their own
  // pollers among seven served bots stay three per-bot back-offs.
  const minority = new ReplyConflictAlarm();
  for (const [i, id] of ["801", "802", "803"].entries()) assert.equal(minority.conflict(id, i, 7), false);
  assert.equal(minority.conflict("804", 10, 7), true, "four of seven is a majority");

  // A REFRESHED conflict keeps its first time: standing conflicts that are
  // merely seen again after their back-off never line up into a new event.
  const standing = new ReplyConflictAlarm();
  standing.conflict("801", 0, 3); standing.conflict("802", 0, 3);
  assert.equal(standing.conflict("801", 600_000, 3), false); assert.equal(standing.conflict("802", 600_000, 3), false);
  assert.equal(standing.conflict("803", 600_000, 3), false, "two old conflicts and one new one are one new conflict");
  assert.equal(standing.size, 3);

  // Spread out: a conflict first seen before the window does not count.
  const spread = new ReplyConflictAlarm();
  spread.conflict("801", 0, 3); spread.conflict("802", 60_000, 3);
  assert.equal(spread.conflict("803", 121_000, 3), false);

  // Forgotten only when not seen for longer than the 409 back-off's cap:
  // after that a conflict is genuinely new again.
  const stale = new ReplyConflictAlarm();
  stale.conflict("801", 0, 3); stale.conflict("802", 0, 3);
  assert.ok(CONFLICT_STALE_MS > replyBackoffMs("telegram-409", 99));
  const later = CONFLICT_STALE_MS + 1;
  assert.equal(stale.conflict("803", later, 3), false); assert.equal(stale.size, 1, "the two unseen conflicts were forgotten");
  assert.equal(stale.conflict("801", later, 3), false); assert.equal(stale.conflict("802", later, 3), true);
});

test("a webhook 409 is told apart from another poller's", () => {
  assert.equal(isWebhookConflict("Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"), true);
  assert.equal(isWebhookConflict("Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"), false);
  for (const odd of [undefined, null, 409, ""]) assert.equal(isWebhookConflict(odd), false, String(odd));
});

test("log tags are at most eight characters of a validated address", () => {
  assert.equal(tenantTag(`0x${"AB".repeat(20)}`), "0xababab");
  for (const value of ["0x123", `0x${"g".repeat(40)}`, "801:secret-token", 701, null, undefined]) assert.equal(tenantTag(value), "?", String(value));
});

test("the exit line tells a clean stop (exit 0) from a refusal (exit 1) and names only a fixed reason", () => {
  const stopped = recoveryReplyExitLine({ stopped: true });
  assert.equal(stopped.code, 0); assert.match(stopped.line, /^\[recovery-replies\] stopped on signal; leases released\./);
  const refused = recoveryReplyExitLine({ error: new RecoveryReplyFleetRefusal("roster-cap") });
  assert.equal(refused.code, 1);
  assert.equal(refused.line, "[recovery-replies] refused reason=roster-cap. Reply-only listener stopped or refused; trading and original-source holds remain intact.");
  const other = recoveryReplyExitLine({ error: new Error(`secret ${addr(5)} 801:private-token`) });
  assert.equal(other.code, 1); assert.match(other.line, /reason=startup\./); assert.doesNotMatch(other.line, /secret|0x0|private-token/);
  // Every error keeps the one shared refusal message: nothing about the cause rides in it.
  for (const e of [new RecoveryReplyFleetRefusal("root-proof"), new ReplyActorStop("roster-changed"), new ReplyGrantChanged(), new ReplyRosterCapExceeded()])
    assert.equal(e.message, recoveryReplyRefused().message);
});

test("the row-by-row roster fences every addressable tenant, admits only clean unambiguous rows, and refuses only past the cap", async () => {
  const good = row(addr(0xa1), addr(0x201)), bad = row(addr(0xa2), addr(0x202), { granted: "0" });
  const twinA = row(addr(0xa3), addr(0x203)), twinB = row(addr(0xa4), addr(0x203));
  const upper = row(`0x${"A5".padEnd(40, "0")}`, addr(0x205)), junk = row("not-an-address", addr(0x206));
  const scan = await scanReplyRoster(db([good, bad, twinA, twinB, upper, junk]));
  // A checksummed tenant column is fenced under its lowercase address (the
  // lease key is computed from it), and skipped: the strict read refuses it.
  const upperTenant = `0x${"a5".padEnd(40, "0")}`;
  assert.deepEqual(scan.tenants, [addr(0xa1), addr(0xa2), addr(0xa3), addr(0xa4), upperTenant]);
  assert.deepEqual(scan.grants.map(g => g.tenant), [addr(0xa1)]);
  assert.deepEqual(scan.skipped, [addr(0xa2), addr(0xa3), addr(0xa4), upperTenant], "a malformed row, both rows claiming one smart account, and a mixed-case tenant");
  assert.equal(scan.unnamed, 1, "only a row whose tenant column is not an address at all cannot be fenced or named");
  // One tenant written twice, in two cases, is ambiguous: fenced once, skipped.
  const twice = await scanReplyRoster(db([good, row(`0x${addr(0xa1).slice(2).toUpperCase()}`, addr(0x207))]));
  assert.deepEqual(twice.tenants, [addr(0xa1)]); assert.deepEqual(twice.skipped, [addr(0xa1)]); assert.equal(twice.grants.length, 0);
  assert.equal(scan.grants[0]!.receipt, JSON.stringify(good));
  // The strict read keeps its all-or-nothing contract for coverage.
  await assert.rejects(readReplyRoster(db([good, bad])));
  assert.deepEqual((await readReplyRoster(db([good]))).map(g => g.tenant), [addr(0xa1)]);
  const many = Array.from({ length: REPLY_ROSTER_CAP + 1 }, (_, i) => row(addr(0x1000 + i), addr(0x5000 + i)));
  await assert.rejects(scanReplyRoster(db(many)), ReplyRosterCapExceeded);
  assert.equal((await scanReplyRoster(db(many.slice(0, REPLY_ROSTER_CAP)))).grants.length, REPLY_ROSTER_CAP);
});
