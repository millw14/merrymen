import assert from "node:assert/strict";
import { test } from "node:test";
import { addReplyPrivacy, emptyRecoveryReplyState, eraseLegacyReplyMemory, openRecoveryReplyState, parseRecoveryReplyState, privacyScope, REPLY_STATE_MAX_BYTES, sealRecoveryReplyState, type RecoveryReplyState, type ReplyPrivacyOp } from "./recovery-reply-state";
import { openSecret, sealSecret } from "./store-crypto";

const TENANT = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const DEK = Buffer.alloc(32, 7);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const chatOp = (extra: Partial<ReplyPrivacyOp> = {}): ReplyPrivacyOp => ({ id: uuid(1), atMs: 100, kind: "personal-chat", chatId: 11, ...extra });
const sealLegacy = (kind: "personal" | "group", value: unknown) => sealSecret(`${kind === "personal" ? "personal-memory/v1" : "tg-groups/v1"} ${TENANT}\n${JSON.stringify(value)}`, DEK);
const openLegacy = <T>(kind: "personal" | "group", row: { sealed: string; bytes: number }): T => {
  const head = `${kind === "personal" ? "personal-memory/v1" : "tg-groups/v1"} ${TENANT}\n`;
  const plain = openSecret(row.sealed, DEK);
  assert.ok(plain.startsWith(head));
  assert.equal(row.bytes, Buffer.byteLength(plain.slice(head.length)));
  return JSON.parse(plain.slice(head.length)) as T;
};
function personal() {
  return { version: 1, soul: { "IDENTITY.md": "agent identity", "OWNER.md": "old owner facts", "NOTES.md": "general notes", "JOURNAL.md": "agent journal", "ARCHIVE.md": "mixed owner archive" }, chats: [
    { chatId: 11, turns: [{ role: "user", content: "erase this old conversation", at: 90 }] },
    { chatId: 22, turns: [{ role: "assistant", content: "another owner's linked chat remains", at: 80 }] },
  ], forgets: [] as Array<{ id: string; atMs: number; kind: "chat" | "owner"; chatId?: number; completed: boolean }>, applied: {} as Record<string, string> };
}
function tgRoom(chatId: number) {
  return { chatId, title: "approved public room", status: "approved", kind: "supergroup", statusAtMs: 5,
    lines: [
      { messageId: 1, fromId: 7, name: "Alice", text: "old Alice line", atMs: 90 },
      { messageId: 2, fromId: 7, name: "Alice", text: "equal-cutoff Alice line", atMs: 100 },
      { messageId: 3, fromId: 7, name: "Alice", text: "new Alice line", atMs: 110 },
      { messageId: 4, fromId: 8, name: "Bob", text: "old unrelated line", atMs: 80 },
      { messageId: 5, fromId: 8, name: "Bob", text: "new unrelated line", atMs: 120 },
    ], people: [
      { id: 7, name: "Alice", note: "old person note", lastSeenMs: 90 },
      { id: 9, name: "Newperson", note: "new person note", lastSeenMs: 110 },
      { id: 8, name: "Bob", note: "unrelated person note", lastSeenMs: 80 },
    ], coins: [
      { address: `0x${"3".repeat(40)}`, byId: 7, byName: "Alice", messageId: 1, atMs: 90, verdict: "bought", decisionId: "durable-outcome-ref", paper: true },
      { address: `0x${"4".repeat(40)}`, byId: 7, byName: "Alice", messageId: 3, atMs: 110, verdict: "passed" },
      { address: `0x${"5".repeat(40)}`, byId: 8, byName: "Bob", messageId: 4, atMs: 80, verdict: "skipped" },
    ], claims: { "1:public-address": 90, "3:public-address": 110 },
    sinceSummary: 2, summary: "old summary", lastSummaryAtMs: 90,
    ambient: { day: "2026-10-04", n: 2 }, welcomes: { day: "2026-10-04", n: 1 }, llmHour: { hour: "2026-10-04T12", n: 3 },
  };
}
function groups() { return { version: 1, rooms: { "-11": tgRoom(-11), "-22": tgRoom(-22) }, llm: { day: "2026-10-04", used: 17, pausedUntilMs: 1000 }, nominations: { day: "2026-10-04", n: 4, entries: 2 } }; }

test("sealed reply state is tenant-bound, authenticated and independent from legacy memory", () => {
  const state: RecoveryReplyState = { version: 1, privacy: [chatOp()], turns: [{ chatId: 22, atMs: 110, role: "user", text: "fresh recovery-only conversation" }] };
  const row = sealRecoveryReplyState(TENANT, state, DEK);
  assert.deepEqual(openRecoveryReplyState(TENANT, row.sealed, DEK), state);
  assert.equal(row.bytes, Buffer.byteLength(JSON.stringify(state)));
  assert.doesNotMatch(row.sealed, /fresh recovery|conversation/);
  assert.throws(() => openRecoveryReplyState(OTHER, row.sealed, DEK));
  assert.throws(() => openRecoveryReplyState(TENANT, row.sealed, Buffer.alloc(32, 8)));
  assert.throws(() => sealRecoveryReplyState(TENANT.toUpperCase(), state, DEK));
  const parts = row.sealed.split(".");
  const ct = Buffer.from(parts[2]!, "base64url"); ct[0] = ct[0]! ^ 1; parts[2] = ct.toString("base64url");
  assert.throws(() => openRecoveryReplyState(TENANT, parts.join("."), DEK));
  assert.throws(() => openRecoveryReplyState(TENANT, sealLegacy("personal", personal()), DEK));
  assert.throws(() => openRecoveryReplyState(TENANT, "x".repeat(REPLY_STATE_MAX_BYTES * 2), DEK));
});

test("strict parsing refuses unknown shapes, invalid authority scopes and oversized state", () => {
  for (const bad of [null, [], {}, { ...emptyRecoveryReplyState(), version: 2 }, { ...emptyRecoveryReplyState(), signingKey: "forbidden" },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ kind: "personal-owner", chatId: 11 })] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ chatId: -11 })] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ kind: "group", chatId: 11 })] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ kind: "person", chatId: -11, userId: 0 })] },
    { ...emptyRecoveryReplyState(), privacy: [{ ...chatOp(), extra: true }] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ atMs: NaN })] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp({ id: "not-a-uuid" })] },
    { ...emptyRecoveryReplyState(), privacy: [chatOp(), chatOp({ id: uuid(2), atMs: 101 })] },
    { ...emptyRecoveryReplyState(), turns: [{ chatId: 0, atMs: 10, role: "user", text: "bad chat" }] },
    { ...emptyRecoveryReplyState(), turns: [{ chatId: 11, atMs: 1.2, role: "assistant", text: "bad time" }] },
    { ...emptyRecoveryReplyState(), turns: [{ chatId: 11, atMs: 10, role: "system", text: "bad role" }] },
    { ...emptyRecoveryReplyState(), turns: [{ chatId: 11, atMs: 10, role: "user", text: "ok", privateLedger: true }] },
    { ...emptyRecoveryReplyState(), turns: [{ chatId: 11, atMs: 10, role: "user", text: "x".repeat(2001) }] },
  ]) assert.throws(() => parseRecoveryReplyState(bad));
  const privacy = Array.from({ length: 500 }, (_, i) => chatOp({ id: uuid(i + 1), chatId: i + 1 }));
  assert.equal(parseRecoveryReplyState({ version: 1, privacy, turns: [] }).privacy.length, 500);
  assert.throws(() => parseRecoveryReplyState({ version: 1, privacy: [...privacy, chatOp({ id: uuid(501), chatId: 501 })], turns: [] }));
  const turns = Array.from({ length: 160 }, () => ({ chatId: 11, atMs: 1, role: "user", text: "x" }));
  assert.equal(parseRecoveryReplyState({ version: 1, privacy: [], turns }).turns.length, 160);
  assert.throws(() => parseRecoveryReplyState({ version: 1, privacy: [], turns: [...turns, turns[0]] }));
  assert.throws(() => parseRecoveryReplyState({ version: 1, privacy: [], turns: turns.map(t => ({ ...t, text: "界".repeat(1000) })) }));
});

test("privacy operations advance one scope monotonically and retain unrelated conversations", () => {
  const original: RecoveryReplyState = { version: 1, privacy: [chatOp({ chatId: 22, id: uuid(9) })], turns: [
    { chatId: 11, atMs: 90, role: "user", text: "target old turn" }, { chatId: 22, atMs: 90, role: "assistant", text: "unrelated old turn" },
  ] };
  const before = structuredClone(original);
  const first = addReplyPrivacy(original, chatOp());
  assert.deepEqual(original, before, "caller snapshot remains untouched");
  assert.deepEqual(first.turns, [original.turns[1]]);
  assert.equal(first.privacy.length, 2);
  assert.equal(privacyScope(chatOp()), "personal-chat:11:*");
  const later = addReplyPrivacy(first, chatOp({ id: uuid(2), atMs: 101 }));
  assert.equal(later.privacy.find(p => p.chatId === 11)?.id, uuid(2));
  assert.equal(later.privacy.find(p => p.chatId === 22)?.id, uuid(9));
  assert.throws(() => addReplyPrivacy(later, chatOp()));
  assert.throws(() => addReplyPrivacy(later, chatOp({ id: uuid(3), atMs: 101 })));
  assert.throws(() => addReplyPrivacy(later, chatOp({ id: uuid(2), atMs: 102 })), "a receipt UUID cannot be reassigned to a later request");
  assert.throws(() => addReplyPrivacy(later, chatOp({ id: uuid(2), atMs: 101, chatId: 33 })), "a receipt UUID cannot be reassigned to another scope");
});

test("replaying an applied recovery privacy request preserves newer recovery conversation", () => {
  const old = addReplyPrivacy(emptyRecoveryReplyState(), chatOp());
  old.turns.push({ chatId: 11, atMs: 110, role: "user", text: "authorized conversation after forget" });
  const reapplied = addReplyPrivacy(old, chatOp());
  assert.deepEqual(reapplied, old);
});

test("personal erasure removes only the requested chat and keeps original files and other users", () => {
  const source = personal(), original = structuredClone(source);
  const first = eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", source), DEK, [chatOp()]);
  const erased = openLegacy<ReturnType<typeof personal>>("personal", first);
  assert.deepEqual(source, original);
  assert.deepEqual(erased.soul, source.soul);
  assert.deepEqual(erased.chats, [source.chats[1]]);
  assert.equal(erased.applied["chat:11"], uuid(1));
  assert.deepEqual(erased.forgets, [{ id: uuid(1), atMs: 100, kind: "chat", chatId: 11, completed: true }]);
  const owner = openLegacy<ReturnType<typeof personal>>("personal", eraseLegacyReplyMemory("personal", TENANT, first.sealed, DEK, [chatOp({ id: uuid(2), kind: "personal-owner", chatId: undefined })]));
  assert.equal(owner.soul["OWNER.md"], ""); assert.equal(owner.soul["ARCHIVE.md"], "");
  for (const file of ["IDENTITY.md", "NOTES.md", "JOURNAL.md"] as const) assert.equal(owner.soul[file], source.soul[file]);
  assert.deepEqual(owner.chats, erased.chats);
});

test("actual personal erasure receipts preserve a newer conversation when old requests are reapplied", () => {
  const erased = openLegacy<ReturnType<typeof personal>>("personal", eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", personal()), DEK, [chatOp()]));
  erased.chats.push({ chatId: 11, turns: [{ role: "user", content: "new conversation after completed erasure", at: 110 }] });
  const replayed = openLegacy<ReturnType<typeof personal>>("personal", eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", erased), DEK, [chatOp()]));
  assert.deepEqual(replayed, erased);
});

test("a newer completed stored personal request wins; an unproved newer request refuses", () => {
  const source = personal();
  source.forgets = [{ id: uuid(2), atMs: 120, kind: "chat", chatId: 11, completed: true }];
  source.applied["chat:11"] = uuid(2);
  source.chats[0]!.turns = [{ role: "user", content: "new conversation after newer completed erasure", at: 130 }];
  const preserved = openLegacy<ReturnType<typeof personal>>("personal", eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", source), DEK, [chatOp()]));
  assert.deepEqual(preserved, source);
  delete source.applied["chat:11"];
  assert.throws(() => eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", source), DEK, [chatOp()]));
  assert.throws(() => eraseLegacyReplyMemory("personal", OTHER, sealLegacy("personal", personal()), DEK, [chatOp()]));
  for (const value of [{ version: 2 }, { ...personal(), soul: [] }, { ...personal(), applied: [] }, { ...personal(), chats: {} }, { ...personal(), forgets: null }]) assert.throws(() => eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", value), DEK, [chatOp()]));
});

test("legacy personal erasure refuses malformed envelopes, invalid operations and content caps", () => {
  const source = personal();
  const badChat = { chatId: 11, turns: [{ role: "user", content: "old conversation", at: 90 }] };
  for (const value of [
    { ...source, soul: { "SIGNING_KEY.md": "unexpected original file" } },
    { ...source, chats: [badChat, badChat] },
    { ...source, chats: Array.from({ length: 65 }, (_, i) => ({ ...badChat, chatId: i + 1 })) },
    { ...source, chats: [{ ...badChat, turns: Array.from({ length: 41 }, () => badChat.turns[0]) }] },
    { ...source, chats: [{ ...badChat, turns: [{ ...badChat.turns[0], role: "system" }] }] },
    { ...source, chats: [{ ...badChat, turns: [{ ...badChat.turns[0], at: -1 }] }] },
    { ...source, chats: [{ ...badChat, turns: [{ ...badChat.turns[0], content: "界".repeat(6000) }] }] },
    { ...source, chats: [{ ...badChat, turns: [{ ...badChat.turns[0], memoryIds: Array.from({ length: 65 }, () => "id") }] }] },
    { ...source, forgets: [{ id: uuid(1), kind: "chat", chatId: 11, atMs: 100, completed: "yes" }] },
    { ...source, applied: { "chat:11": uuid(9) } },
    { ...source, soul: { ...source.soul, "OWNER.md": "x".repeat(1024 * 1024 + 1) } },
  ]) assert.throws(() => eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", value), DEK, [chatOp()]));
  assert.throws(() => eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", source), DEK, [chatOp({ chatId: -11 })]));
  assert.throws(() => eraseLegacyReplyMemory("personal", TENANT, sealLegacy("personal", source), DEK, [chatOp({ atMs: -1 })]));
});

test("group person erasure includes equal timestamps, preserves newer/unrelated people and durable outcomes", () => {
  const source = groups(), original = structuredClone(source);
  const op: ReplyPrivacyOp = { id: uuid(1), kind: "person", chatId: -11, userId: 7, atMs: 100 };
  const out = openLegacy<ReturnType<typeof groups>>("group", eraseLegacyReplyMemory("group", TENANT, sealLegacy("group", source), DEK, [op]));
  assert.deepEqual(source, original);
  const room = out.rooms["-11"];
  assert.deepEqual(room.lines.map(l => l.messageId), [3, 4, 5]);
  assert.deepEqual(room.people.map(p => p.id), [9, 8]);
  assert.deepEqual(room.coins[0], { ...source.rooms["-11"].coins[0], byId: 0, byName: "" });
  assert.deepEqual(room.coins.slice(1), source.rooms["-11"].coins.slice(1));
  assert.deepEqual(room.claims, source.rooms["-11"].claims);
  assert.deepEqual(out.rooms["-22"], source.rooms["-22"]);
  assert.deepEqual(out.llm, source.llm); assert.deepEqual(out.nominations, source.nominations);
  assert.deepEqual(room.llmHour, source.rooms["-11"].llmHour);
  assert.deepEqual(room.ambient, source.rooms["-11"].ambient); assert.deepEqual(room.welcomes, source.rooms["-11"].welcomes);
  assert.equal(room.summary, ""); assert.equal("lastSummaryAtMs" in room, false);
});

test("group replay retains newer lines, summaries and counters while retaining original claims", () => {
  const source = groups();
  const room = source.rooms["-11"];
  room.lines = room.lines.filter(l => l.atMs > 100);
  room.people = room.people.filter(p => p.lastSeenMs > 100);
  room.coins = room.coins.filter(c => c.atMs > 100);
  room.summary = "fresh summary from newer conversation"; room.lastSummaryAtMs = 120; room.sinceSummary = 2;
  const op: ReplyPrivacyOp = { id: uuid(1), kind: "group", chatId: -11, atMs: 100 };
  const out = openLegacy<ReturnType<typeof groups>>("group", eraseLegacyReplyMemory("group", TENANT, sealLegacy("group", source), DEK, [op]));
  assert.deepEqual(out, source);
});

test("a whole-room forget erases its cutoff while preserving newer participation and claims", () => {
  const source = groups();
  const op: ReplyPrivacyOp = { id: uuid(1), kind: "group", chatId: -11, atMs: 100 };
  const out = openLegacy<ReturnType<typeof groups>>("group", eraseLegacyReplyMemory("group", TENANT, sealLegacy("group", source), DEK, [op]));
  const room = out.rooms["-11"];
  assert.deepEqual(room.lines.map(l => l.messageId), [3, 5]);
  assert.deepEqual(room.people.map(p => p.id), [9]);
  assert.deepEqual(room.coins, [source.rooms["-11"].coins[1]]);
  assert.equal(room.sinceSummary, 2);
  assert.deepEqual(room.claims, source.rooms["-11"].claims);
  assert.deepEqual(out.rooms["-22"], source.rooms["-22"]);
  assert.deepEqual(out.llm, source.llm); assert.deepEqual(out.nominations, source.nominations);
  const absent = openLegacy<ReturnType<typeof groups>>("group", eraseLegacyReplyMemory("group", TENANT, sealLegacy("group", source), DEK, [{ ...op, chatId: -33 }]));
  assert.deepEqual(absent, source);
  source.rooms["-11"].people[0]!.lastSeenMs = 110;
  const person = openLegacy<ReturnType<typeof groups>>("group", eraseLegacyReplyMemory("group", TENANT, sealLegacy("group", source), DEK, [{ ...op, kind: "person", userId: 7 }]));
  assert.ok(person.rooms["-11"].people.some(p => p.id === 7 && p.lastSeenMs === 110));
});
