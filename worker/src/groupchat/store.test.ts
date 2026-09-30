/**
 * The room's storage, against a real (in-memory) sqlite, plus the Postgres
 * translation of every statement the store issues.
 *
 * SQLITE CANNOT SEE A POSTGRES-ONLY FAILURE, so the last block records each
 * statement and its parameters as the store really sends them and checks what
 * Postgres would receive: placeholders renumbered with none left over, the
 * parameter count matching, and every parameter a value pg can bind to a
 * BIGINT or TEXT column. The live Postgres round-trip is run separately
 * (PGlite, outside the repo) because the repo has no Postgres server.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { translateQuery, translateSchema, wrapSqlite, type Db, type Stmt } from "../db";
import {
  GROUPCHAT_SCHEMA,
  agentActivity,
  allMembers,
  appendMessage,
  countOwnerLinesSince,
  ensureGroupchatSchema,
  getMember,
  hideOwnMessage,
  joinMember,
  messageById,
  pruneMessages,
  readMessages,
  readRoom,
  recentMessages,
  setMemberPrefs,
  toPublic,
  writeRoom,
} from "./store";
import type { NewMessage, RoomState, StoredMessage } from "./types";

const OWNER_A = `0x${"aa".repeat(20)}`;
const OWNER_B = `0x${"bb".repeat(20)}`;
const AGENT_A = `0x${"a1".repeat(20)}`;
const AGENT_B = `0x${"b1".repeat(20)}`;

function line(over: Partial<NewMessage> = {}): NewMessage {
  return {
    createdAtMs: 1_000,
    authorKind: "agent",
    tenant: OWNER_A,
    agentId: AGENT_A,
    speakerSlug: "abcdefghjkmnpqrs",
    speakerName: "Tuck",
    body: "gm",
    replyTo: null,
    kind: "chat",
    call: null,
    callDecisionId: null,
    dedupeKey: null,
    ...over,
  };
}

const ownerLine = (tenant: string, over: Partial<NewMessage> = {}) =>
  line({ authorKind: "owner", tenant, agentId: null, speakerName: "Tuck's owner", body: "hello room", ...over });

/** A fresh in-memory room. Closed by the test's own cleanup hook. */
async function openRoom(t: { after(fn: () => void): void }): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  t.after(() => raw.close());
  const db = wrapSqlite(raw);
  await ensureGroupchatSchema(db, "sqlite");
  return { db, raw };
}

async function ids(db: Db, q: Parameters<typeof readMessages>[1]) {
  const page = await readMessages(db, q);
  return { ids: page.messages.map((m) => m.id), start: page.start };
}

// ── schema ──────────────────────────────────────────────────────────────────

test("the schema is idempotent and created once per Db", async (t) => {
  const { db, raw } = await openRoom(t);
  assert.equal(ensureGroupchatSchema(db, "sqlite"), ensureGroupchatSchema(db, "sqlite"), "memoised: the same promise");
  await ensureGroupchatSchema(db, "sqlite");
  // Another process (or a second boot) running the DDL on an existing database is a no-op.
  raw.exec(GROUPCHAT_SCHEMA);
  await db.exec(GROUPCHAT_SCHEMA);
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'groupchat_%' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
  assert.deepEqual(tables, ["groupchat_members", "groupchat_messages", "groupchat_messages_tenant", "groupchat_room"]);
});

test("a failed schema run is retried on the next call instead of cached for ever", async () => {
  let attempts = 0;
  const flaky: Db = {
    prepare: () => {
      throw new Error("unused");
    },
    exec: async () => {
      attempts++;
      if (attempts === 1) throw new Error("database briefly unreachable");
    },
    tx: async (fn) => fn(flaky),
  };
  await assert.rejects(ensureGroupchatSchema(flaky, "sqlite"), /briefly unreachable/);
  await ensureGroupchatSchema(flaky, "sqlite");
  await ensureGroupchatSchema(flaky, "sqlite");
  assert.equal(attempts, 2, "one failure, one success, then memoised");
});

test("postgres: the DDL runs inside one transaction, behind an advisory lock no other store uses", async () => {
  const events: string[] = [];
  let lockKey: unknown;
  const scoped: Db = {
    prepare: (sql) => {
      const stmt: Stmt = {
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
        get: async (...params) => {
          events.push(`prepare:${sql}`);
          lockKey = params[0];
          return {};
        },
        all: async () => [],
      };
      return stmt;
    },
    exec: async (sql) => {
      events.push(sql === GROUPCHAT_SCHEMA ? "exec:schema" : "exec:other");
    },
    tx: () => Promise.reject(new Error("nested")),
  };
  const pg: Db = {
    prepare: () => {
      throw new Error("outside the transaction");
    },
    exec: async () => {
      throw new Error("outside the transaction");
    },
    tx: async (fn) => {
      events.push("begin");
      const out = await fn(scoped);
      events.push("commit");
      return out;
    },
  };
  await ensureGroupchatSchema(pg, "postgres");
  assert.deepEqual(events, ["begin", "prepare:SELECT pg_advisory_xact_lock(?)", "exec:schema", "commit"]);
  assert.equal(typeof lockKey, "number");
  assert.ok(Number.isSafeInteger(lockKey));
  // auth-nonce-store.ts and web/src/lib/partner-store.ts hold these; sharing one
  // would queue unrelated first boots behind each other.
  for (const taken of [1_297_691_982, 1_297_692_081, 1_297_692_082, 1_297_692_083, 1_297_692_084]) {
    assert.notEqual(lockKey, taken);
  }
});

test("the DDL translates to Postgres cleanly", () => {
  assert.equal(GROUPCHAT_SCHEMA.match(/INTEGER PRIMARY KEY AUTOINCREMENT/g)?.length, 1);
  assert.ok(!GROUPCHAT_SCHEMA.includes("`"), "no backticks in the template literal");
  assert.ok(!GROUPCHAT_SCHEMA.includes("?"), "exec never renumbers placeholders");
  assert.ok(!/\/\*/.test(GROUPCHAT_SCHEMA), "-- comments only");
  const pg = translateSchema(GROUPCHAT_SCHEMA);
  assert.match(pg, /id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,/);
  assert.ok(!/AUTOINCREMENT/.test(pg));
  assert.ok(!/\bINTEGER\b/.test(pg), "every INTEGER widened to BIGINT");
  assert.ok(!/\bREAL\b/.test(pg));
  assert.ok(!pg.includes("?"));
  assert.ok(!/IF NOT EXISTS\s+IF NOT EXISTS/.test(pg), "no doubled IF NOT EXISTS");
  assert.equal(pg.match(/IF NOT EXISTS/g)?.length, 4, "three tables and one index, each idempotent");
  assert.match(pg, /dedupe_key TEXT UNIQUE/);
  assert.match(pg, /hidden BIGINT NOT NULL DEFAULT 0/);
  assert.match(pg, /kind TEXT NOT NULL DEFAULT 'chat'/);
});

// ── messages ────────────────────────────────────────────────────────────────

test("a reused dedupe key is 'already said': null, and nothing is written", async (t) => {
  const { db } = await openRoom(t);
  const first = await appendMessage(db, line({ kind: "gm", dedupeKey: `gm:${OWNER_A}:2026-09-23` }));
  assert.equal(typeof first, "number");
  assert.equal(await appendMessage(db, line({ kind: "gm", body: "morning", dedupeKey: `gm:${OWNER_A}:2026-09-23` })), null);
  // Free chat has no key, and any number of keyless lines coexist.
  const a = await appendMessage(db, line());
  const b = await appendMessage(db, line());
  assert.ok(a !== null && b !== null && b > a);
  // An empty key is not a key: it must not swallow every later keyless line.
  assert.notEqual(await appendMessage(db, line({ dedupeKey: "" })), null);
  assert.notEqual(await appendMessage(db, line({ dedupeKey: "" })), null);
  assert.equal((await recentMessages(db, 50)).length, 5);
  assert.equal((await messageById(db, first!))?.body, "gm");
});

test("a call's ref and decision land in the call_* columns and come back whole", async (t) => {
  const { db, raw } = await openRoom(t);
  const call = { side: "buy" as const, symbol: "T1A2B3C4D5E6F", name: "Sherwood", token: `0x${"cc".repeat(20)}`, paper: true };
  const id = await appendMessage(db, line({ kind: "call", call, callDecisionId: "dec-1", dedupeKey: "call:dec-1" }));
  const stored = await messageById(db, id!);
  assert.deepEqual(stored?.call, call);
  assert.equal(stored?.callDecisionId, "dec-1");
  assert.equal(stored?.kind, "call");
  const rawRow = raw.prepare("SELECT call_side, call_paper, call_decision_id FROM groupchat_messages WHERE id = ?").get(id!);
  assert.deepEqual({ ...rawRow }, { call_side: "buy", call_paper: 1, call_decision_id: "dec-1" });

  const live = await appendMessage(db, line({ kind: "call", call: { ...call, side: "sell", paper: false }, dedupeKey: "call:dec-2" }));
  assert.deepEqual((await messageById(db, live!))?.call, { ...call, side: "sell", paper: false });
  assert.equal((await messageById(db, live!))?.callDecisionId, null);
  // A chat line has no call at all, not an empty one.
  assert.equal((await messageById(db, (await appendMessage(db, line()))!))?.call, null);
  assert.equal(await messageById(db, 999), null);
  assert.equal(await messageById(db, 1.5), null);
});

test("tenants are stored lowercased, whatever case the caller used", async (t) => {
  const { db } = await openRoom(t);
  const id = await appendMessage(db, ownerLine(OWNER_A.toUpperCase().replace("0X", "0x")));
  assert.equal((await messageById(db, id!))?.tenant, OWNER_A);
});

test("since: only newer lines, oldest first, across gaps in the ids", async (t) => {
  const { db, raw } = await openRoom(t);
  for (let i = 1; i <= 6; i++) await appendMessage(db, line({ createdAtMs: i * 1_000, body: `line ${i}` }));
  raw.exec("DELETE FROM groupchat_messages WHERE id IN (3, 4)");
  assert.deepEqual(await ids(db, { since: 2, limit: 50 }), { ids: [5, 6], start: false });
  assert.deepEqual(await ids(db, { since: 0, limit: 2 }), { ids: [1, 2], start: false }, "a poll that falls behind catches up in order");
  assert.deepEqual(await ids(db, { since: 6, limit: 50 }), { ids: [], start: false });
  // A cursor from a query string can be anything; none of these may throw on Postgres either.
  assert.deepEqual(await ids(db, { since: 2.5, limit: 50 }), { ids: [5, 6], start: false });
  assert.deepEqual(await ids(db, { since: 1e21, limit: 50 }), { ids: [], start: false });
  assert.deepEqual(await ids(db, { since: -1e21, limit: 50 }), { ids: [1, 2, 5, 6], start: false });
  // since wins over before; a NaN since is absent.
  assert.deepEqual(await ids(db, { since: 1, before: 6, limit: 50 }), { ids: [2, 5, 6], start: false });
  assert.deepEqual(await ids(db, { since: Number.NaN, limit: 50 }), { ids: [1, 2, 5, 6], start: true });
});

test("before / first load: newest page ascending, and start marks the beginning of history", async (t) => {
  const { db } = await openRoom(t);
  for (let i = 1; i <= 5; i++) await appendMessage(db, line({ createdAtMs: i * 1_000 }));
  assert.deepEqual(await ids(db, { limit: 2 }), { ids: [4, 5], start: false });
  assert.deepEqual(await ids(db, { before: 4, limit: 2 }), { ids: [2, 3], start: false });
  assert.deepEqual(await ids(db, { before: 2, limit: 2 }), { ids: [1], start: true });
  assert.deepEqual(await ids(db, { before: 1, limit: 2 }), { ids: [], start: true });
  assert.deepEqual(await ids(db, { before: null, limit: 10 }), { ids: [1, 2, 3, 4, 5], start: true });
  assert.deepEqual(await ids(db, { before: 3.5, limit: 10 }), { ids: [1, 2, 3], start: true });
  assert.deepEqual(await recentMessages(db, 3).then((m) => m.map((x) => x.id)), [3, 4, 5]);
});

test("limit is clamped to 1..200", async (t) => {
  const { db, raw } = await openRoom(t);
  const insert = raw.prepare(
    "INSERT INTO groupchat_messages (created_at_ms, author_kind, tenant, speaker_name, body) VALUES (?, 'agent', ?, 'Tuck', 'gm')",
  );
  for (let i = 0; i < 205; i++) insert.run(i, OWNER_A);
  assert.equal((await readMessages(db, { limit: 1_000 })).messages.length, 200);
  assert.equal((await readMessages(db, { limit: 0 })).messages.length, 1);
  assert.equal((await readMessages(db, { limit: -5 })).messages.length, 1);
  assert.equal((await readMessages(db, { limit: Number.NaN })).messages.length, 200);
  assert.equal((await readMessages(db, { limit: 2.9 })).messages.length, 2);
  assert.equal((await readMessages(db, { limit: 200 })).start, false);
});

test("hidden lines never appear in any read, but messageById still resolves them", async (t) => {
  const { db } = await openRoom(t);
  const a = await appendMessage(db, ownerLine(OWNER_A, { body: "first" }));
  const b = await appendMessage(db, ownerLine(OWNER_A, { body: "take this back" }));
  const c = await appendMessage(db, line({ body: "gm" }));
  assert.equal(await hideOwnMessage(db, b!, OWNER_A), true);
  const visible = [a, c];
  assert.deepEqual((await ids(db, { limit: 50 })).ids, visible);
  assert.deepEqual((await ids(db, { since: 0, limit: 50 })).ids, visible);
  assert.deepEqual((await ids(db, { before: 99, limit: 50 })).ids, visible);
  assert.deepEqual((await recentMessages(db, 50)).map((m) => m.id), visible);
  // A short page because of a hidden line still reached the start.
  assert.deepEqual(await ids(db, { before: c!, limit: 2 }), { ids: [a], start: true });
  const hidden = await messageById(db, b!);
  assert.equal(hidden?.hidden, true);
  assert.equal((await messageById(db, a!))?.hidden, false);
});

test("hideOwnMessage hides only the caller's own OWNER line", async (t) => {
  const { db } = await openRoom(t);
  const mine = await appendMessage(db, ownerLine(OWNER_A));
  const theirs = await appendMessage(db, ownerLine(OWNER_B));
  const myAgent = await appendMessage(db, line({ tenant: OWNER_A, agentId: AGENT_A }));
  const system = await appendMessage(db, line({ authorKind: "system", tenant: "", agentId: null, speakerSlug: null, speakerName: "room", kind: "join" }));

  assert.equal(await hideOwnMessage(db, theirs!, OWNER_A), false, "someone else's line");
  assert.equal(await hideOwnMessage(db, myAgent!, OWNER_A), false, "an agent line, even my own agent's");
  assert.equal(await hideOwnMessage(db, system!, OWNER_A), false, "a system line");
  assert.equal(await hideOwnMessage(db, system!, ""), false, "the empty tenant owns nothing");
  assert.equal(await hideOwnMessage(db, 999, OWNER_A), false, "no such line");
  assert.equal(await hideOwnMessage(db, 1.5, OWNER_A), false);
  for (const id of [theirs, myAgent, system]) assert.equal((await messageById(db, id!))?.hidden, false);

  // Checksummed case from a signed-in session is the same owner.
  assert.equal(await hideOwnMessage(db, mine!, OWNER_A.toUpperCase().replace("0X", "0x")), true);
  assert.equal((await messageById(db, mine!))?.hidden, true);
  assert.equal(await hideOwnMessage(db, mine!, OWNER_A), true, "hiding twice is still 'yours, hidden'");
});

test("countOwnerLinesSince counts one owner's lines in the window, hidden ones included", async (t) => {
  const { db } = await openRoom(t);
  await appendMessage(db, ownerLine(OWNER_A, { createdAtMs: 1_000 }));
  await appendMessage(db, ownerLine(OWNER_A, { createdAtMs: 2_000 }));
  const hidden = await appendMessage(db, ownerLine(OWNER_A, { createdAtMs: 3_000 }));
  await hideOwnMessage(db, hidden!, OWNER_A);
  await appendMessage(db, ownerLine(OWNER_B, { createdAtMs: 3_000 }));
  await appendMessage(db, line({ tenant: OWNER_A, createdAtMs: 3_000 }));
  assert.equal(await countOwnerLinesSince(db, OWNER_A, 2_000), 2, "post-then-hide must not reset the limit");
  assert.equal(await countOwnerLinesSince(db, OWNER_A, 0), 3);
  assert.equal(await countOwnerLinesSince(db, OWNER_A, 1_999.5), 2);
  assert.equal(await countOwnerLinesSince(db, OWNER_B, 0), 1);
  assert.equal(await countOwnerLinesSince(db, `0x${"dd".repeat(20)}`, 0), 0);
});

test("agentActivity rebuilds last line / gm / gn per agent tenant", async (t) => {
  const { db } = await openRoom(t);
  await appendMessage(db, line({ createdAtMs: 1_000 }));
  await appendMessage(db, line({ createdAtMs: 2_000, kind: "gm", dedupeKey: "gm:a:1" }));
  await appendMessage(db, line({ createdAtMs: 5_000, kind: "gn", dedupeKey: "gn:a:1" }));
  await appendMessage(db, line({ tenant: OWNER_B, agentId: AGENT_B, createdAtMs: 3_000 }));
  await appendMessage(db, ownerLine(OWNER_A, { createdAtMs: 9_000, kind: "gm" }));
  await appendMessage(db, line({ authorKind: "system", tenant: "", agentId: null, createdAtMs: 9_000, kind: "join" }));

  const since1500 = await agentActivity(db, 1_500);
  assert.deepEqual([...since1500.keys()].sort(), [OWNER_A, OWNER_B]);
  assert.deepEqual(since1500.get(OWNER_A), { lastMs: 5_000, lastGmMs: 2_000, lastGnMs: 5_000 });
  assert.deepEqual(since1500.get(OWNER_B), { lastMs: 3_000, lastGmMs: null, lastGnMs: null });

  const since2500 = await agentActivity(db, 2_500);
  assert.deepEqual(since2500.get(OWNER_A), { lastMs: 5_000, lastGmMs: null, lastGnMs: 5_000 });
  assert.equal((await agentActivity(db, 10_000)).size, 0);
});

test("pruneMessages drops old lines and never lets an id be reused", async (t) => {
  const { db } = await openRoom(t);
  await appendMessage(db, line({ createdAtMs: 1_000 }));
  await appendMessage(db, line({ createdAtMs: 2_000 }));
  const kept = await appendMessage(db, line({ createdAtMs: 3_000 }));
  assert.equal(await pruneMessages(db, 2_500), 2);
  assert.equal(await pruneMessages(db, 2_500), 0);
  assert.deepEqual((await recentMessages(db, 50)).map((m) => m.id), [kept]);
  // A client's cursor must never see an old id come back as a new line.
  await pruneMessages(db, 10_000);
  const next = await appendMessage(db, line({ createdAtMs: 11_000 }));
  assert.ok(next! > kept!);
});

// ── members ─────────────────────────────────────────────────────────────────

test("joinMember is true exactly once and never clobbers prefs set before or after", async (t) => {
  const { db } = await openRoom(t);
  // The owner's browser reported a zone before the orchestrator ever saw their agent.
  await setMemberPrefs(db, OWNER_A, { tz: "Europe/Paris", tzSource: "owner", muted: true }, 100);
  const early = await getMember(db, OWNER_A);
  assert.equal(early?.joinedAtMs, 0, "a prefs-only row is not a join");
  assert.deepEqual(await allMembers(db), [], "and it is not a member yet (so a first pass still opens the room silently)");

  assert.equal(await joinMember(db, OWNER_A, 200), true, "the first join claims it: join line + hello");
  assert.deepEqual(await getMember(db, OWNER_A), {
    tenant: OWNER_A,
    tz: "Europe/Paris",
    tzSource: "owner",
    muted: true,
    joinedAtMs: 200,
    updatedAtMs: 100,
  });
  assert.equal(await joinMember(db, OWNER_A, 300), false);
  assert.equal((await getMember(db, OWNER_A))?.joinedAtMs, 200, "a re-join does not move the join time");

  assert.equal(await joinMember(db, OWNER_B.toUpperCase().replace("0X", "0x"), 400), true);
  assert.equal(await joinMember(db, OWNER_B, 500), false, "one tenant, whatever the case");
  assert.deepEqual(await getMember(db, OWNER_B), {
    tenant: OWNER_B,
    tz: null,
    tzSource: null,
    muted: false,
    joinedAtMs: 400,
    updatedAtMs: 400,
  });
  await setMemberPrefs(db, OWNER_B, { muted: true }, 600);
  assert.equal(await joinMember(db, OWNER_B, 700), false);
  assert.equal((await getMember(db, OWNER_B))?.muted, true);
  assert.deepEqual((await allMembers(db)).map((m) => m.tenant), [OWNER_A, OWNER_B]);

  // A join stamped at the epoch must still read as joined.
  const C = `0x${"cc".repeat(20)}`;
  assert.equal(await joinMember(db, C, 0), true);
  assert.equal(await joinMember(db, C, 0), false);
  assert.equal(await getMember(db, `0x${"dd".repeat(20)}`), null);
});

test("setMemberPrefs writes only the columns it is given", async (t) => {
  const { db } = await openRoom(t);
  await joinMember(db, OWNER_A, 100);
  await setMemberPrefs(db, OWNER_A, { tz: "Asia/Tokyo", tzSource: "browser" }, 200);
  await setMemberPrefs(db, OWNER_A, { muted: true }, 300);
  assert.deepEqual(await getMember(db, OWNER_A), {
    tenant: OWNER_A,
    tz: "Asia/Tokyo",
    tzSource: "browser",
    muted: true,
    joinedAtMs: 100,
    updatedAtMs: 300,
  });
  await setMemberPrefs(db, OWNER_A, { tz: "America/New_York", tzSource: "owner" }, 400);
  assert.equal((await getMember(db, OWNER_A))?.muted, true, "a zone change does not unmute");

  // A browser capture never overwrites the owner's own choice.
  await setMemberPrefs(db, OWNER_A, { tz: "Asia/Tokyo", tzSource: "browser" }, 500);
  let m = await getMember(db, OWNER_A);
  assert.equal(m?.tz, "America/New_York");
  assert.equal(m?.tzSource, "owner");

  await setMemberPrefs(db, OWNER_A, { muted: false }, 600);
  m = await getMember(db, OWNER_A);
  assert.deepEqual([m?.tz, m?.tzSource, m?.muted, m?.joinedAtMs], ["America/New_York", "owner", false, 100]);

  // The owner can forget the zone, and then a browser capture applies again.
  await setMemberPrefs(db, OWNER_A, { tz: null, tzSource: null }, 700);
  m = await getMember(db, OWNER_A);
  assert.deepEqual([m?.tz, m?.tzSource], [null, null]);
  await setMemberPrefs(db, OWNER_A, { tz: "Asia/Tokyo", tzSource: "browser" }, 800);
  m = await getMember(db, OWNER_A);
  assert.deepEqual([m?.tz, m?.tzSource, m?.joinedAtMs], ["Asia/Tokyo", "browser", 100]);

  // Nothing to set writes nothing.
  await setMemberPrefs(db, OWNER_B, {}, 900);
  assert.equal(await getMember(db, OWNER_B), null);
});

// ── room ────────────────────────────────────────────────────────────────────

test("the room summary round-trips, overwrites, and never carries a field outside RoomState", async (t) => {
  const { db, raw } = await openRoom(t);
  assert.equal(await readRoom(db), null);
  const room: RoomState = {
    members: 3,
    awake: 2,
    asleep: 1,
    presence: [
      { slug: "abcdefghjkmnpqrs", name: "Tuck", state: "awake" },
      { slug: null, name: "Marian", state: "asleep" },
    ],
    updatedAtMs: 1_000,
  };
  await writeRoom(db, room);
  assert.deepEqual(await readRoom(db), room);

  const leaky = {
    ...room,
    tenant: OWNER_A,
    presence: [{ slug: "abcdefghjkmnpqrs", name: "Tuck", state: "awake", tenant: OWNER_A, tz: "Europe/Paris" }],
    updatedAtMs: 2_000,
  } as unknown as RoomState;
  await writeRoom(db, leaky);
  const back = await readRoom(db);
  assert.deepEqual(back, { ...room, presence: [room.presence[0]], updatedAtMs: 2_000 });
  const stored = (raw.prepare("SELECT v, updated_at_ms FROM groupchat_room").all() as { v: string; updated_at_ms: number }[]);
  assert.equal(stored.length, 1, "one row, overwritten");
  assert.ok(!stored[0]!.v.includes(OWNER_A) && !stored[0]!.v.includes("Paris"));
  assert.equal(stored[0]!.updated_at_ms, 2_000);

  await assert.rejects(writeRoom(db, { members: "3" } as unknown as RoomState), /malformed/);
  raw.exec("UPDATE groupchat_room SET v = 'not json'");
  assert.equal(await readRoom(db), null, "an unreadable summary is no summary, not an error");
});

// ── public shape ────────────────────────────────────────────────────────────

test("toPublic never carries tenant, smart account, decision or dedupe key", async (t) => {
  const { db } = await openRoom(t);
  const id = await appendMessage(
    db,
    line({
      kind: "call",
      call: { side: "buy", symbol: "RBN", name: "Robin coin", token: `0x${"cc".repeat(20)}`, paper: false },
      callDecisionId: "dec-private-7",
      dedupeKey: "call:dec-private-7",
    }),
  );
  const stored = (await messageById(db, id!))!;
  const pub = toPublic(stored);
  assert.deepEqual(Object.keys(pub).sort(), ["at", "author", "body", "call", "id", "kind", "name", "replyTo", "slug"]);
  assert.deepEqual(Object.keys(pub.call!).sort(), ["name", "paper", "side", "symbol", "token"]);
  const json = JSON.stringify(pub).toLowerCase();
  for (const secret of [OWNER_A, AGENT_A, "dec-private-7", "tenant", "agentid", "dedupe", "hidden"]) {
    assert.ok(!json.includes(secret.toLowerCase()), `public line leaked ${secret}`);
  }
  assert.deepEqual(pub, {
    id,
    at: 1_000,
    author: "agent",
    slug: "abcdefghjkmnpqrs",
    name: "Tuck",
    body: "gm",
    replyTo: null,
    kind: "call",
    call: { side: "buy", symbol: "RBN", name: "Robin coin", token: `0x${"cc".repeat(20)}`, paper: false },
  });

  // A field added to StoredMessage later stays private until someone decides otherwise.
  const future = { ...stored, ownerTz: "Europe/Paris", call: { ...stored.call!, sizeUsdg: 500 } } as unknown as StoredMessage;
  const out = JSON.stringify(toPublic(future));
  assert.ok(!out.includes("Paris") && !out.includes("500"));
});

// ── what Postgres would receive ─────────────────────────────────────────────

interface Sent {
  sql: string;
  params: unknown[];
}

/** Pass every call through to sqlite, recording each prepared statement with its parameters. */
function recording(inner: Db, sent: Sent[]): Db {
  return {
    prepare(sql) {
      const stmt = inner.prepare(sql);
      const note = (params: unknown[]) => sent.push({ sql, params });
      return {
        run: (...p) => (note(p), stmt.run(...p)),
        get: (...p) => (note(p), stmt.get(...p)),
        all: (...p) => (note(p), stmt.all(...p)),
      };
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((scoped) => fn(recording(scoped, sent))),
  };
}

test("every statement the store sends translates to Postgres with matching, bindable parameters", async (t) => {
  const { db: base } = await openRoom(t);
  const sent: Sent[] = [];
  const db = recording(base, sent);

  // Deliberately untidy inputs: fractional ms and cursors, huge cursors, a float reply pointer.
  const a = await appendMessage(db, ownerLine(OWNER_A, { createdAtMs: 1_000.7, replyTo: 2.5 }));
  await appendMessage(db, line({ createdAtMs: 2_000, kind: "gm", dedupeKey: "gm:x:1" }));
  await appendMessage(db, line({ createdAtMs: 2_000, kind: "gm", dedupeKey: "gm:x:1" }));
  await appendMessage(
    db,
    line({ kind: "call", call: { side: "buy", symbol: "RBN", name: null, token: null, paper: true }, callDecisionId: "d", dedupeKey: "call:d" }),
  );
  await readMessages(db, { since: 0.5, limit: 10 });
  await readMessages(db, { before: 1e30, limit: 10.5 });
  await readMessages(db, { limit: 10 });
  await recentMessages(db, 30);
  await messageById(db, a!);
  await agentActivity(db, 1_500.2);
  await countOwnerLinesSince(db, OWNER_A, 999.9);
  await hideOwnMessage(db, a!, OWNER_A);
  await joinMember(db, OWNER_A, 5_000.4);
  await setMemberPrefs(db, OWNER_A, { tz: "Europe/Paris", tzSource: "browser", muted: true }, 6_000.9);
  await setMemberPrefs(db, OWNER_A, { tz: "Europe/Paris", tzSource: "owner" }, 6_001);
  await setMemberPrefs(db, OWNER_A, { muted: false }, 6_002);
  await getMember(db, OWNER_A);
  await allMembers(db);
  await writeRoom(db, { members: 1, awake: 1, asleep: 0, presence: [], updatedAtMs: 7_000 });
  await readRoom(db);
  await pruneMessages(db, 1_500.5);

  assert.ok(sent.length >= 20);
  for (const { sql, params } of sent) {
    const pg = translateQuery(sql);
    const unquoted = pg.replace(/'[^']*'/g, "''");
    assert.ok(!unquoted.includes("?"), `a placeholder survived translation: ${pg}`);
    const numbers = [...unquoted.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const highest = numbers.length ? Math.max(...numbers) : 0;
    assert.equal(highest, params.length, `placeholder count vs parameters: ${pg}`);
    for (let n = 1; n <= highest; n++) assert.ok(numbers.includes(n), `$${n} missing: ${pg}`);
    assert.ok(!/INSERT\s+OR/i.test(pg), "INSERT OR IGNORE cannot carry RETURNING on Postgres");
    assert.ok(!/\bAS\s+[a-z_]*[A-Z]/.test(pg), `a camelCase alias would be folded by Postgres: ${pg}`);
    if (/ON CONFLICT/i.test(pg) && /DO UPDATE SET/i.test(pg)) {
      const assignments = pg.split(/DO UPDATE SET/i)[1]!.split(/\bWHERE\b|\bRETURNING\b/i)[0]!;
      for (const part of assignments.split(/,(?![^()]*\))/)) {
        const rhs = part.split("=").slice(1).join("=").trim();
        assert.ok(/^(excluded\.|CASE WHEN groupchat_members\.)/.test(rhs), `bare right-hand side in an upsert: ${part.trim()}`);
      }
    }
    for (const p of params) {
      const bindable = p === null || typeof p === "string" || (typeof p === "number" && Number.isSafeInteger(p));
      assert.ok(bindable, `pg cannot bind ${String(p)} (${typeof p}) in: ${pg}`);
    }
  }
  // The insert asks for its id back instead of trusting run().lastInsertRowid (always 0 on Postgres).
  const insert = sent.find((s) => s.sql.includes("INSERT INTO groupchat_messages"))!;
  assert.match(translateQuery(insert.sql), /ON CONFLICT \(dedupe_key\) DO NOTHING\s+RETURNING id$/);
});
