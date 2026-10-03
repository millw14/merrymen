/**
 * The Telegram groups store: one JSON file per agent, `<home>/tg-groups.json`.
 *
 * What these pin, in the order it matters:
 *   - a coin claim is ON DISK before `claim` returns true, and a claim that
 *     could not be written returns false (at-most-once, AGENTS.md);
 *   - the per-agent group caps (nominations, group-sourced entries) are durable
 *     the same way, never hand a stale day a fresh allowance, and a refund
 *     never goes below zero;
 *   - a damaged file is read field by field, and one that is not JSON at all is
 *     moved aside rather than overwritten;
 *   - the caps, ages and the 512 KB bound hold.
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  TG_FORGET_LIMITS,
  TG_GROUPS_FILE,
  TG_GROUPS_FORGET_FILE,
  TG_LIMITS,
  TgGroupsStore,
  applyForgets,
  emptyTgGroupsState,
  parseTgForgets,
  parseTgGroupsState,
  utcDay,
  utcHour,
  type TgForgetOp,
} from "./store";
import type { TgCoinMemo, TgGroupsState, TgLine, TgRoom } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const CHAT = -1001234567890;
const OTHER = -1009876543210;

let home: string;
let clock: number;
let opened: TgGroupsStore[];
const now = () => clock;

function open(opts: { debounceMs?: number } = {}): TgGroupsStore {
  const s = TgGroupsStore.open(home, { now, debounceMs: 60_000, ...opts });
  opened.push(s);
  return s;
}

function make(file: string, initial: TgGroupsState = emptyTgGroupsState()): TgGroupsStore {
  const s = new TgGroupsStore(file, initial, { now, debounceMs: 60_000 });
  opened.push(s);
  return s;
}

const filePath = () => path.join(home, TG_GROUPS_FILE);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onDisk = (): any => JSON.parse(readFileSync(filePath(), "utf8"));
const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const line = (messageId: number, over: Partial<TgLine> = {}): TgLine => ({
  messageId,
  fromId: 7,
  name: "ann",
  text: `hi ${messageId}`,
  atMs: clock,
  ...over,
});
const memo = (address: string, over: Partial<TgCoinMemo> = {}): TgCoinMemo => ({
  address,
  byId: 7,
  byName: "ann",
  messageId: 1,
  atMs: clock,
  verdict: "passed",
  ...over,
});
const approvedRoom = (s: TgGroupsStore, chatId = CHAT, title = "frogs"): TgRoom => {
  const r = s.ensureRoom(chatId, { title, kind: "supergroup" })!;
  s.setStatus(chatId, "approved");
  return r;
};

/** Capture console.warn for one test. */
function captureWarn(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const m = mock.method(console, "warn", (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  });
  return { calls, restore: () => m.mock.restore() };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "tg-groups-store-"));
  clock = T0;
  opened = [];
});

afterEach(() => {
  mock.timers.reset();
  for (const s of opened) s.close();
  rmSync(home, { recursive: true, force: true });
});

// ─── Day and hour keys ────────────────────────────────────────────────────

describe("utcDay / utcHour", () => {
  it("keys by UTC, rolling over exactly at midnight and on the hour", () => {
    const lastMs = Date.UTC(2026, 8, 28, 23, 59, 59, 999);
    assert.equal(utcDay(lastMs), "2026-09-28");
    assert.equal(utcHour(lastMs), "2026-09-28T23");
    assert.equal(utcDay(lastMs + 1), "2026-09-29");
    assert.equal(utcHour(lastMs + 1), "2026-09-29T00");
  });

  it("never throws on a clock outside Date's range", () => {
    assert.equal(utcDay(Number.NaN), "1970-01-01");
    assert.equal(utcDay(Infinity), "1970-01-01");
    assert.equal(utcHour(1e20), "1970-01-01T00");
  });
});

describe("emptyTgGroupsState", () => {
  it("is version 1 with no rooms and zeroed counters, fresh each call", () => {
    const a = emptyTgGroupsState();
    assert.deepEqual(a, { version: 1, rooms: {}, llm: { day: "", used: 0 }, nominations: { day: "", n: 0, entries: 0 } });
    a.llm.used = 5;
    assert.equal(emptyTgGroupsState().llm.used, 0);
  });
});

// ─── Parsing ──────────────────────────────────────────────────────────────

function validRoom(over: Partial<TgRoom> = {}): TgRoom {
  return {
    chatId: CHAT,
    title: "frogs",
    status: "approved",
    kind: "supergroup",
    isForum: true,
    addedById: 42,
    addedAtMs: T0 - HOUR,
    statusAtMs: T0 - HOUR,
    askedOwnerAtMs: T0 - 2 * HOUR,
    privacyHintSent: true,
    helloSaid: true,
    ownerName: "milla",
    shushedUntilMs: T0 + MIN,
    lastOwnAtMs: T0 - MIN,
    lastAmbientAtMs: T0 - 5 * MIN,
    ambient: { day: "2026-09-28", n: 1.5 },
    lastReadyAskAtMs: T0 - 3 * HOUR,
    lastReadyNudgeAtMs: T0 - 3 * HOUR,
    lastReadyDmAtMs: T0 - 3 * HOUR,
    lastCapLineAtMs: T0 - 4 * HOUR,
    lastDropCaAtMs: T0 - 4 * HOUR,
    lastCoinUnknownAtMs: T0 - 5 * MIN,
    welcomes: { day: "2026-09-28", n: 1 },
    llmHour: { hour: "2026-09-28T12", n: 3 },
    lines: [
      { messageId: 10, fromId: 7, name: "ann", text: "gm", atMs: T0 - 2 * MIN },
      { messageId: 11, fromId: 99, name: "pine", text: "gm ann", atMs: T0 - MIN, replyTo: 10, own: true },
    ],
    sinceSummary: 1,
    lastSummaryAtMs: T0 - HOUR,
    summary: "frog people",
    people: [
      {
        id: 7,
        name: "ann",
        note: "shills frogs",
        lastSeenMs: T0 - 2 * MIN,
        roasts: { count: 1, sinceMs: T0 - 10 * MIN },
        answers: { count: 2, sinceMs: T0 - MIN },
        greetedDay: "2026-09-28",
      },
    ],
    coins: [
      {
        address: addr(1),
        name: "FROG",
        byId: 7,
        byName: "ann",
        messageId: 9,
        atMs: T0 - 3 * MIN,
        verdict: "bought",
        decisionId: "d-1",
        paper: true,
        exitSaid: true,
      },
    ],
    claims: { [`9:${addr(1)}`]: T0 - 3 * MIN },
    ...over,
  };
}

function validState(): TgGroupsState {
  return {
    version: 1,
    rooms: { [String(CHAT)]: validRoom() },
    llm: { day: "2026-09-28", used: 12, pausedUntilMs: T0 + 10 * MIN },
    nominations: { day: "2026-09-28", n: 2, entries: 1 },
  };
}

describe("parseTgGroupsState", () => {
  it("reads garbage and unknown versions as empty, never throwing", () => {
    for (const raw of [null, undefined, 42, "x", [], {}, true, { version: 2, rooms: validState().rooms }, { version: "1" }]) {
      assert.deepEqual(parseTgGroupsState(raw), emptyTgGroupsState(), JSON.stringify(raw) ?? "undefined");
    }
    const hostile = { version: 1 };
    Object.defineProperty(hostile, "rooms", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    assert.deepEqual(parseTgGroupsState(hostile), emptyTgGroupsState());
  });

  it("keeps a well-formed state exactly, and is idempotent", () => {
    const s = validState();
    assert.deepEqual(parseTgGroupsState(s), s);
    assert.deepEqual(parseTgGroupsState(JSON.parse(JSON.stringify(s))), s);
    assert.deepEqual(parseTgGroupsState(parseTgGroupsState(s)), s);
  });

  it("drops malformed records one by one and keeps the rest", () => {
    const room = validRoom() as unknown as Record<string, unknown>;
    room.lines = [
      null,
      5,
      "gm",
      { messageId: "1", fromId: 7, text: "x", atMs: T0 },
      { messageId: 1.5, fromId: 7, text: "x", atMs: T0 },
      { messageId: 2, fromId: 7, text: 3, atMs: T0 },
      { messageId: 3, fromId: 7, text: "x", atMs: "now" },
      { messageId: 4, fromId: 7, name: 12, text: "ok", atMs: T0, replyTo: "x", own: "yes" },
    ];
    room.people = [{ id: "7", name: "ann" }, { name: "no id" }, { id: 8, name: "bo", note: 5, lastSeenMs: "x", roasts: { count: "1" } }];
    room.coins = [
      memo("0xnothex"),
      memo(addr(2), { verdict: "rugged" as never }),
      memo(addr(3), { byId: "7" as never }),
      memo(addr(4).toUpperCase().replace("0X", "0x"), { name: `see ${addr(9)}` }),
    ];
    room.claims = { "1:0xabc": T0, [`2:${addr(2)}`]: "yesterday", [`3:${addr(3).toUpperCase().replace("0X", "0x")}`]: T0, "x:y": T0 };
    room.status = "admin";
    room.kind = 5;
    room.shushedUntilMs = "soon";
    room.ambient = { day: "today", n: 1 };
    room.isForum = "true";

    const out = parseTgGroupsState({ version: 1, rooms: { [String(CHAT)]: room } }).rooms[String(CHAT)]!;
    assert.deepEqual(out.lines, [{ messageId: 4, fromId: 7, name: "", text: "ok", atMs: T0 }]);
    assert.deepEqual(out.people, [{ id: 8, name: "bo", note: "", lastSeenMs: 0 }]);
    assert.equal(out.coins.length, 1);
    assert.equal(out.coins[0]!.address, addr(4), "lowercased");
    assert.equal(out.coins[0]!.name, undefined, "an address-shaped display name is dropped");
    assert.deepEqual(out.claims, { [`3:${addr(3)}`]: T0 });
    assert.equal(out.status, "pending", "an unreadable status is the silent one");
    assert.equal(out.kind, "group");
    assert.equal(out.shushedUntilMs, undefined);
    assert.equal(out.ambient, undefined);
    assert.equal(out.isForum, undefined);
  });

  it("clips every string to its limit without splitting a surrogate pair", () => {
    const huge = "x".repeat(1_000_000);
    const emoji = "🐸".repeat(1000); // two UTF-16 units each
    const room = validRoom({
      title: huge,
      summary: huge,
      ownerName: huge,
      lines: [{ messageId: 1, fromId: 7, name: `a\nb\u0000c${huge}`, text: `line\none${huge}`, atMs: T0 }],
      people: [{ id: 7, name: huge, note: emoji, lastSeenMs: T0 }],
      coins: [memo(addr(1), { name: huge, byName: huge, decisionId: huge })],
    });
    const out = parseTgGroupsState({ version: 1, rooms: { a: room } }).rooms[String(CHAT)]!;
    assert.equal(out.title.length, 128);
    assert.equal(out.summary.length, TG_LIMITS.summaryChars);
    assert.equal(out.ownerName!.length, TG_LIMITS.nameChars);
    assert.equal(out.lines[0]!.text.length, TG_LIMITS.lineChars);
    assert.ok(out.lines[0]!.text.startsWith("line\none"), "prose keeps its newlines");
    assert.ok(out.lines[0]!.name.startsWith("a b c"), "a name is one line with no control characters");
    assert.equal(out.lines[0]!.name.length, TG_LIMITS.nameChars);
    assert.equal(out.people[0]!.name.length, TG_LIMITS.nameChars);
    assert.equal(out.people[0]!.note, "🐸".repeat(TG_LIMITS.noteChars / 2));
    assert.equal(out.coins[0]!.byName.length, TG_LIMITS.nameChars);
    assert.equal(out.coins[0]!.decisionId!.length, 128);

    const odd = parseTgGroupsState({
      version: 1,
      rooms: { a: validRoom({ people: [{ id: 1, name: "b", note: "a" + emoji, lastSeenMs: 0 }] }) },
    }).rooms[String(CHAT)]!.people[0]!.note;
    assert.equal(odd.length, TG_LIMITS.noteChars - 1, "the half pair at the edge is cut, not kept");
    assert.ok(!/[\uD800-\uDBFF]$/.test(odd));
  });

  it("applies the list caps: newest lines, most recently seen people, newest coins", () => {
    const lines = Array.from({ length: 100 }, (_, i) => line(i + 1, { atMs: T0 + i }));
    lines.push(line(100, { atMs: T0 + 1000, text: "the later copy" }));
    const people = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `p${i}`, note: "", lastSeenMs: T0 + i }));
    const coins = Array.from({ length: 80 }, (_, i) => memo(addr(i + 1), { atMs: T0 + i }));
    const out = parseTgGroupsState({ version: 1, rooms: { a: validRoom({ lines, people, coins }) } }).rooms[String(CHAT)]!;
    assert.equal(out.lines.length, TG_LIMITS.lines);
    assert.equal(out.lines.filter((l) => l.messageId === 100).length, 1, "one line per message id");
    assert.equal(out.lines[out.lines.length - 1]!.text, "the later copy");
    assert.equal(out.lines[0]!.messageId, 41);
    assert.equal(out.people.length, TG_LIMITS.people);
    assert.equal(Math.min(...out.people.map((p) => p.id)), 11);
    assert.equal(out.coins.length, TG_LIMITS.coins);
    assert.equal(out.coins[0]!.address, addr(21));
  });

  it("caps rooms at 30, evicting left/blocked rooms before active ones", () => {
    const rooms: Record<string, TgRoom> = {};
    for (let i = 1; i <= 34; i++) {
      rooms[String(-i)] = validRoom({ chatId: -i, lines: [], coins: [], claims: {}, statusAtMs: T0 + i, addedAtMs: T0 + i });
    }
    rooms["-33"]!.status = "left";
    rooms["-34"]!.status = "blocked";
    const out = parseTgGroupsState({ version: 1, rooms });
    assert.equal(Object.keys(out.rooms).length, TG_LIMITS.chats);
    for (const gone of ["-33", "-34", "-1", "-2"]) assert.equal(out.rooms[gone], undefined, gone);
    assert.ok(out.rooms["-3"]);
  });

  it("takes the chat id from the key when the room lacks one, and re-keys by chat id", () => {
    const noId = validRoom() as unknown as Record<string, unknown>;
    delete noId.chatId;
    const out = parseTgGroupsState({ version: 1, rooms: { "-55": noId, junk: { ...noId }, "-77": validRoom({ chatId: -66 }) } });
    assert.deepEqual(Object.keys(out.rooms).sort(), ["-55", "-66"]);
    assert.equal(out.rooms["-55"]!.chatId, -55);
  });

  it("reads an unreadable counter under a readable day as used up, never as a fresh allowance", () => {
    const out = parseTgGroupsState({
      version: 1,
      rooms: { a: validRoom({ llmHour: { hour: "2026-09-28T12", n: "x" as never } }) },
      llm: { day: "2026-09-28", used: "lots", pausedUntilMs: T0 },
      nominations: { day: "2026-09-28", n: -1, entries: null },
    });
    assert.equal(out.llm.used, Number.MAX_SAFE_INTEGER);
    assert.equal(out.llm.pausedUntilMs, T0);
    assert.equal(out.nominations.n, Number.MAX_SAFE_INTEGER);
    assert.equal(out.nominations.entries, Number.MAX_SAFE_INTEGER);
    assert.equal(out.rooms[String(CHAT)]!.llmHour!.n, Number.MAX_SAFE_INTEGER);

    const noDay = parseTgGroupsState({ version: 1, llm: { day: "yesterday", used: 5 }, nominations: { day: 3, n: 1, entries: 1 } });
    assert.deepEqual(noDay.llm, { day: "", used: 0 });
    assert.deepEqual(noDay.nominations, { day: "", n: 0, entries: 0 });
  });
});

// ─── Open, round trip, corrupt files ─────────────────────────────────────

describe("open and the file on disk", () => {
  it("round-trips everything through close and reopen", () => {
    const s = open();
    approvedRoom(s);
    s.update(CHAT, (r) => {
      r.summary = "they like frogs";
      r.ownerName = "milla";
    });
    s.addLine(CHAT, line(1));
    s.addLine(CHAT, line(2, { fromId: 99, own: true, replyTo: 1 }));
    s.upsertPerson(CHAT, { id: 7, name: "ann", note: "shills frogs" });
    s.rememberCoin(CHAT, memo(addr(1), { decisionId: "d-1" }));
    assert.equal(s.claim(CHAT, 3, addr(1)), true);
    assert.equal(s.takeLlm(10), true);
    s.pauseLlm(T0 + 10 * MIN);
    assert.equal(s.takeNomination(utcDay(clock), 12), true);
    assert.equal(s.takeGroupEntry(utcDay(clock), 3), true);
    assert.equal(s.takeRoomLlm(CHAT, 40), true);
    const before = JSON.parse(JSON.stringify(s.state));
    s.close();

    const again = open();
    assert.deepEqual(again.state, before);
    assert.equal(again.room(CHAT)!.status, "approved");
    assert.equal(again.coin(CHAT, addr(1))!.decisionId, "d-1");
  });

  it("starts empty with no file, and writes none until something changes", () => {
    const s = open();
    assert.deepEqual(s.state, emptyTgGroupsState());
    s.flush();
    assert.equal(existsSync(filePath()), false);
  });

  it("moves a corrupt file to tg-groups.json.bad and starts empty", () => {
    const w = captureWarn();
    try {
      writeFileSync(filePath(), "{not json at all");
      const s = open();
      assert.deepEqual(s.state, emptyTgGroupsState());
      assert.equal(existsSync(filePath()), false);
      assert.equal(readFileSync(`${filePath()}.bad`, "utf8"), "{not json at all");
      approvedRoom(s);
      s.flush();
      assert.equal(readFileSync(`${filePath()}.bad`, "utf8"), "{not json at all", "the bad copy is never overwritten by a save");
      assert.equal(onDisk().rooms[String(CHAT)].status, "approved");
      assert.equal(w.calls.length, 1);
      assert.ok(!w.calls[0]!.includes("not json"), "the warning carries no content");
    } finally {
      w.restore();
    }
  });

  it("sets aside an empty file, a non-object and an unknown version the same way", () => {
    const w = captureWarn();
    try {
      for (const content of ["", "[1,2]", "null", JSON.stringify({ version: 2, rooms: {} })]) {
        rmSync(`${filePath()}.bad`, { force: true });
        writeFileSync(filePath(), content);
        const s = open();
        assert.deepEqual(s.state, emptyTgGroupsState(), content);
        assert.equal(readFileSync(`${filePath()}.bad`, "utf8"), content);
      }
    } finally {
      w.restore();
    }
  });

  it("sets aside a path that exists but cannot be read, rather than saving over it", () => {
    const w = captureWarn();
    try {
      mkdirSync(filePath()); // EISDIR on read
      const s = open();
      assert.deepEqual(s.state, emptyTgGroupsState());
      assert.ok(statSync(`${filePath()}.bad`).isDirectory());
      approvedRoom(s);
      assert.equal(onDisk().rooms[String(CHAT)].status, "approved");
      assert.equal(w.calls.length, 1);
    } finally {
      w.restore();
    }
  });

  it("reads a file with a byte-order mark", () => {
    writeFileSync(filePath(), "\uFEFF" + JSON.stringify(validState()));
    const s = open();
    assert.equal(s.room(CHAT)!.title, "frogs");
    assert.equal(existsSync(`${filePath()}.bad`), false);
  });

  it("prunes on open", () => {
    const st = validState();
    st.rooms[String(CHAT)]!.lines[0]!.atMs = T0 - 15 * DAY;
    writeFileSync(filePath(), JSON.stringify(st));
    const s = open();
    assert.deepEqual(s.room(CHAT)!.lines.map((l) => l.messageId), [11]);
  });

  it("writes atomically: mode 0600, no tmp file left behind, a stale tmp replaced", () => {
    writeFileSync(`${filePath()}.tmp`, "stale", { mode: 0o644 });
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1));
    s.flush();
    assert.deepEqual(readdirSync(home).sort(), [TG_GROUPS_FILE]);
    if (process.platform !== "win32") assert.equal(statSync(filePath()).mode & 0o777, 0o600);
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 1);
  });

  it("the constructor applies the same parse as a file does", () => {
    const st = validState();
    st.rooms[String(CHAT)]!.summary = "s".repeat(5000);
    const s = make(filePath(), st);
    assert.equal(s.room(CHAT)!.summary.length, TG_LIMITS.summaryChars);
    assert.equal(s.file, filePath());
  });
});

// ─── Debounce and write failures ─────────────────────────────────────────

describe("debounced writes", () => {
  it("coalesces ordinary changes into one write after the debounce", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const s = open({ debounceMs: 2000 });
    s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
    assert.equal(existsSync(filePath()), false, "ensureRoom is debounced");
    mock.timers.tick(1000);
    s.addLine(CHAT, line(1));
    mock.timers.tick(999);
    assert.equal(existsSync(filePath()), false);
    mock.timers.tick(1);
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 1, "both changes rode the first timer");
    s.addLine(CHAT, line(2));
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 1);
    mock.timers.tick(2000);
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 2);
  });

  it("setStatus, claim and flush write synchronously; close flushes and later changes still land", () => {
    const s = open();
    s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
    s.setStatus(CHAT, "approved");
    assert.equal(onDisk().rooms[String(CHAT)].status, "approved");
    s.addLine(CHAT, line(1));
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 0);
    s.update(CHAT, (r) => void (r.helloSaid = true), { flush: true });
    assert.equal(onDisk().rooms[String(CHAT)].helloSaid, true);
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 1);
    s.close();
    s.addLine(CHAT, line(2));
    assert.equal(onDisk().rooms[String(CHAT)].lines.length, 2, "a change after close is not left on a timer");
  });

  it("logs a failed write once, without content, and retries on the next change", () => {
    const w = captureWarn();
    try {
      const blocker = path.join(home, "blocker");
      writeFileSync(blocker, "a file where a directory should be");
      const target = path.join(blocker, TG_GROUPS_FILE);
      const s = make(target);
      s.ensureRoom(CHAT, { title: "secret title", kind: "group" });
      s.setStatus(CHAT, "approved");
      s.addLine(CHAT, line(1, { text: "private words" }));
      s.flush();
      s.flush();
      assert.equal(w.calls.length, 1, "logged once");
      assert.ok(w.calls[0]!.includes("could not save"));
      assert.ok(!/secret|private/.test(w.calls[0]!), "no content in the log");
      assert.equal(s.room(CHAT)!.lines.length, 1, "the state is kept in memory");

      rmSync(blocker);
      mkdirSync(blocker);
      s.addLine(CHAT, line(2));
      s.flush();
      const disk = JSON.parse(readFileSync(target, "utf8"));
      assert.equal(disk.rooms[String(CHAT)].lines.length, 2, "the retry carried everything");

      rmSync(blocker, { recursive: true });
      writeFileSync(blocker, "blocked again");
      s.addLine(CHAT, line(3));
      s.flush();
      assert.equal(w.calls.length, 2, "a new failure after a success is logged again");
    } finally {
      w.restore();
    }
  });

  it("update re-applies limits, keeps the chat id, and saves even when fn throws", () => {
    const s = open();
    approvedRoom(s);
    s.update(CHAT, (r) => {
      r.summary = "z".repeat(5000);
      r.chatId = 1;
      r.lines.push(...Array.from({ length: 70 }, (_, i) => line(i + 1, { atMs: T0 + i })));
    });
    const r = s.room(CHAT)!;
    assert.equal(r.summary.length, TG_LIMITS.summaryChars);
    assert.equal(r.chatId, CHAT);
    assert.equal(r.lines.length, TG_LIMITS.lines);
    assert.throws(() =>
      s.update(CHAT, (x) => {
        x.helloSaid = true;
        throw new Error("caller bug");
      }),
    );
    s.flush();
    assert.equal(onDisk().rooms[String(CHAT)].helloSaid, true);
    s.update(12345, () => assert.fail("never called for an unknown room"));
  });
});

// ─── Rooms ───────────────────────────────────────────────────────────────

describe("ensureRoom and setStatus", () => {
  it("creates a pending room stamped with now, and refreshes an existing one's title", () => {
    const s = open();
    const r = s.ensureRoom(CHAT, { title: "  frogs\n and  toads ", kind: "group" })!;
    assert.equal(r.status, "pending");
    assert.equal(r.statusAtMs, T0);
    assert.equal(r.title, "frogs and toads");
    assert.equal(r.isForum, undefined);
    s.setStatus(CHAT, "approved");
    clock += HOUR;
    const same = s.ensureRoom(CHAT, { title: "frogs 2", kind: "supergroup", isForum: true })!;
    assert.equal(same, r);
    assert.equal(same.status, "approved");
    assert.equal(same.title, "frogs 2");
    assert.equal(same.kind, "supergroup");
    assert.equal(same.isForum, true);
    s.ensureRoom(CHAT, { title: "", kind: "supergroup", isForum: false });
    assert.equal(same.title, "frogs 2", "an empty title never blanks a known one");
    assert.equal(same.isForum, undefined);
    assert.equal(s.rooms().length, 1);
  });

  it("holds 30 chats, evicting the longest-gone left room, then the quietest pending one — never the owner's blocked room", () => {
    const s = open();
    for (let i = 1; i <= 30; i++) {
      clock = T0 + i * MIN;
      s.ensureRoom(-i, { title: `g${i}`, kind: "group" });
    }
    clock = T0 + 100 * MIN;
    s.setStatus(-20, "left");
    clock = T0 + 101 * MIN;
    s.setStatus(-10, "blocked");
    clock = T0 + 102 * MIN;
    s.addLine(-1, line(1)); // room 1 is no longer the quietest

    clock = T0 + 200 * MIN;
    s.ensureRoom(-31, { title: "g31", kind: "group" });
    assert.equal(s.room(-20), undefined, "the room left longest ago goes first");
    assert.ok(s.room(-10));
    s.ensureRoom(-32, { title: "g32", kind: "group" });
    assert.ok(s.room(-1), "a room with recent lines stays");
    assert.equal(s.room(-2), undefined, "then the pending room quiet for longest");
    assert.ok(s.room(-10), "the owner's Leave outlasts every pending room");
    assert.equal(s.rooms().length, TG_LIMITS.chats);
  });

  it("a stranger's new room never pushes out the owner's approved or blocked rooms", () => {
    // Anyone can add a bot to a group: thirty strangers' groups must not
    // evict the owner's own. Found full of decisions, nothing is created.
    const s = open();
    for (let i = 1; i <= 30; i++) {
      clock = T0 + i * MIN;
      s.ensureRoom(-i, { title: `g${i}`, kind: "group" });
      s.setStatus(-i, i === 5 ? "blocked" : "approved", 42);
    }
    clock = T0 + 10 * HOUR;
    assert.equal(s.ensureRoom(-31, { title: "stranger", kind: "group" }), undefined);
    assert.equal(s.room(-31), undefined);
    assert.equal(s.rooms().length, TG_LIMITS.chats);
    for (let i = 1; i <= 30; i++) assert.ok(s.room(-i), `room ${i} kept`);
    // A room already there is found as ever.
    assert.equal(s.ensureRoom(-7, { title: "g7", kind: "group" })?.chatId, -7);

    // The owner's own act may make room: the blocked one first, then the quietest approved.
    assert.equal(s.ensureRoom(-32, { title: "mine", kind: "group" }, { owner: true })?.status, "pending");
    assert.equal(s.room(-5), undefined);
    s.setStatus(-32, "approved", 42);
    assert.equal(s.ensureRoom(-33, { title: "mine too", kind: "group" }, { owner: true })?.status, "pending");
    assert.equal(s.room(-1), undefined, "the quietest approved room");

    // With a pending room in the store, a stranger's room takes its place, never an approved one's.
    const approved = s.rooms().filter((r) => r.status === "approved").length;
    assert.ok(s.ensureRoom(-34, { title: "stranger", kind: "group" }));
    assert.equal(s.room(-33), undefined, "the pending room made way");
    assert.equal(s.rooms().filter((r) => r.status === "approved").length, approved);
  });

  it("setStatus flushes, moves statusAtMs only on a change, and records who added it", () => {
    const s = open();
    s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
    clock += MIN;
    s.setStatus(CHAT, "pending", 55);
    assert.equal(s.room(CHAT)!.statusAtMs, T0, "pending → pending does not restart the 24 h clock");
    assert.equal(s.room(CHAT)!.addedById, undefined);
    s.setStatus(CHAT, "approved", 42);
    assert.equal(onDisk().rooms[String(CHAT)].status, "approved");
    assert.equal(s.room(CHAT)!.statusAtMs, T0 + MIN);
    assert.equal(s.room(CHAT)!.addedById, 42);
    assert.equal(s.room(CHAT)!.addedAtMs, T0 + MIN);
    clock += MIN;
    s.setStatus(CHAT, "left", 77);
    assert.equal(s.room(CHAT)!.addedById, 42, "who removed it is not who added it");
    assert.equal(onDisk().rooms[String(CHAT)].status, "left");
    s.setStatus(CHAT, "admin" as never);
    assert.equal(s.room(CHAT)!.status, "left");
    s.setStatus(OTHER, "approved");
    assert.equal(s.room(OTHER), undefined);
  });

  it("a real change clears the owner's Stay/Leave ask, so a new pending spell gets its own question and its own 24 h", () => {
    const s = open();
    s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
    s.update(CHAT, (r) => {
      r.askedOwnerAtMs = T0;
    });
    clock += MIN;
    s.setStatus(CHAT, "pending", 55);
    assert.equal(s.room(CHAT)!.askedOwnerAtMs, T0, "pending → pending is the same spell: the ask stands");
    s.setStatus(CHAT, "approved");
    assert.equal(s.room(CHAT)!.askedOwnerAtMs, undefined);
    assert.equal(onDisk().rooms[String(CHAT)].askedOwnerAtMs, undefined, "on disk at once");
    s.update(CHAT, (r) => {
      r.askedOwnerAtMs = T0;
    });
    s.setStatus(CHAT, "left");
    s.setStatus(CHAT, "pending", 77);
    assert.equal(s.room(CHAT)!.askedOwnerAtMs, undefined, "re-added: not asked yet");
  });

  it("an unblock is remembered across a reopen, and ends when the owner decides again", () => {
    const s = open();
    s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
    s.setStatus(CHAT, "left");
    s.update(CHAT, (r) => {
      r.unblockedAtMs = T0;
    }, { flush: true });
    assert.equal(onDisk().rooms[String(CHAT)].unblockedAtMs, T0, "on disk at once");
    s.close();
    const again = open();
    assert.equal(again.room(CHAT)!.unblockedAtMs, T0, "read back");
    again.setStatus(CHAT, "pending", 55);
    assert.equal(again.room(CHAT)!.unblockedAtMs, T0, "being asked is not a decision");
    again.setStatus(CHAT, "approved");
    assert.equal(again.room(CHAT)!.unblockedAtMs, undefined, "Stay, or the owner's own re-add");
    again.update(CHAT, (r) => {
      r.unblockedAtMs = T0;
    });
    again.setStatus(CHAT, "blocked");
    assert.equal(again.room(CHAT)!.unblockedAtMs, undefined, "Leave");
  });
});

// ─── Lines and people ────────────────────────────────────────────────────

describe("addLine", () => {
  it("refuses a duplicate message id and an unknown room", () => {
    const s = open();
    approvedRoom(s);
    assert.equal(s.addLine(CHAT, line(1)), true);
    assert.equal(s.addLine(CHAT, line(1, { text: "again" })), false);
    assert.equal(s.addLine(OTHER, line(2)), false);
    assert.equal(s.addLine(CHAT, { messageId: "x" } as never), false);
    assert.equal(s.room(CHAT)!.lines.length, 1);
    assert.equal(s.room(CHAT)!.lines[0]!.text, "hi 1");
  });

  it("clips text and name, counts human lines only, and keeps the newest 60", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { text: "t".repeat(1000), name: "n".repeat(100) }));
    const first = s.room(CHAT)!.lines[0]!;
    assert.equal(first.text.length, TG_LIMITS.lineChars);
    assert.equal(first.name.length, TG_LIMITS.nameChars);
    s.addLine(CHAT, line(2, { own: true, fromId: 99 }));
    assert.equal(s.room(CHAT)!.sinceSummary, 1, "its own line is not a new human line");
    for (let i = 3; i <= 72; i++) {
      clock += 1000;
      s.addLine(CHAT, line(i));
    }
    const lines = s.room(CHAT)!.lines;
    assert.equal(lines.length, TG_LIMITS.lines);
    assert.equal(lines[0]!.messageId, 13);
    assert.equal(lines[lines.length - 1]!.messageId, 72);
    assert.equal(s.room(CHAT)!.sinceSummary, 71);
  });

  it("files a late-arriving line in time order", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { atMs: T0 }));
    s.addLine(CHAT, line(3, { atMs: T0 + 2000 }));
    s.addLine(CHAT, line(2, { atMs: T0 + 1000 }));
    assert.deepEqual(s.room(CHAT)!.lines.map((l) => l.messageId), [1, 2, 3]);
  });
});

describe("upsertPerson", () => {
  it("creates, merges and clears fields, defaulting lastSeenMs to now", () => {
    const s = open();
    approvedRoom(s);
    const p = s.upsertPerson(CHAT, { id: 7, name: "ann", note: "n".repeat(500), roasts: { count: 1, sinceMs: T0 } });
    assert.equal(p.note.length, TG_LIMITS.noteChars);
    assert.equal(p.lastSeenMs, T0);
    clock += MIN;
    const q = s.upsertPerson(CHAT, { id: 7, name: "annie" });
    assert.equal(q, p, "the stored record");
    assert.equal(q.name, "annie");
    assert.equal(q.note.length, TG_LIMITS.noteChars, "a note not given is kept");
    assert.deepEqual(q.roasts, { count: 1, sinceMs: T0 });
    assert.equal(q.lastSeenMs, T0 + MIN);
    s.upsertPerson(CHAT, { id: 7, name: "", roasts: undefined, greetedDay: "2026-09-28", lastSeenMs: T0 - DAY });
    assert.equal(q.name, "annie", "an empty name keeps the known one");
    assert.equal(q.roasts, undefined, "explicit undefined clears");
    assert.equal(q.greetedDay, "2026-09-28");
    assert.equal(q.lastSeenMs, T0 - DAY);
    assert.equal(s.person(CHAT, 7), q);
    assert.equal(s.person(CHAT, 8), undefined);
  });

  it("holds 40 people per chat, making room by who was seen longest ago", () => {
    const s = open();
    approvedRoom(s);
    for (let i = 1; i <= 40; i++) s.upsertPerson(CHAT, { id: i, name: `p${i}`, lastSeenMs: T0 + i });
    s.upsertPerson(CHAT, { id: 1, name: "p1", lastSeenMs: T0 + 100 });
    s.upsertPerson(CHAT, { id: 41, name: "p41" });
    const ids = s.room(CHAT)!.people.map((p) => p.id);
    assert.equal(ids.length, TG_LIMITS.people);
    assert.ok(ids.includes(1));
    assert.ok(!ids.includes(2));
    assert.ok(ids.includes(41));
  });

  it("stores nothing for an unknown room", () => {
    const s = open();
    const p = s.upsertPerson(OTHER, { id: 7, name: "ann" });
    assert.equal(p.name, "ann");
    assert.equal(s.room(OTHER), undefined);
  });
});

// ─── Claims ──────────────────────────────────────────────────────────────

describe("claim — at most once", () => {
  it("is true once, and is on disk before it returns", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1)); // a pending debounced change rides along; irrelevant here
    assert.equal(s.claim(CHAT, 500, addr(1)), true);
    // No flush: read the file straight back.
    assert.equal(onDisk().rooms[String(CHAT)].claims[`500:${addr(1)}`], T0);
    assert.equal(s.claim(CHAT, 500, addr(1)), false);
    assert.equal(s.claim(CHAT, 500, addr(1).toUpperCase().replace("0X", "0x")), false, "the address is case-folded");
    assert.equal(s.claim(CHAT, 500, addr(2)), true, "a second address in the same message is its own claim");
    assert.equal(s.claim(OTHER, 500, addr(1)), false, "unknown room: do nothing");
  });

  it("survives a crash: a reopened store refuses the same claim", () => {
    const s = open();
    approvedRoom(s);
    assert.equal(s.claim(CHAT, 500, addr(1)), true);
    // Simulate a crash: no close(), no flush — just a new process reading the file.
    const after = TgGroupsStore.open(home, { now, debounceMs: 60_000 });
    opened.push(after);
    assert.equal(after.claim(CHAT, 500, addr(1)), false);
    assert.equal(after.claim(CHAT, 501, addr(1)), true);
  });

  it("refuses anything that is not a well-formed claim", () => {
    const s = open();
    approvedRoom(s);
    assert.equal(s.claim(CHAT, 1, "0x1234"), false);
    assert.equal(s.claim(CHAT, 1, addr(1) + "00"), false);
    assert.equal(s.claim(CHAT, 1, "0x" + "a".repeat(64)), false, "a tx hash is never a CA");
    assert.equal(s.claim(CHAT, 1.5, addr(1)), false);
    assert.equal(s.claim(CHAT, Number.NaN, addr(1)), false);
    assert.equal(s.claim(CHAT, 1, 5 as never), false);
    assert.deepEqual(s.room(CHAT)!.claims, {});
  });

  it("returns false when the claim cannot be written, and still never acts on it later", () => {
    const w = captureWarn();
    try {
      const blocker = path.join(home, "blocker");
      writeFileSync(blocker, "x");
      const s = make(path.join(blocker, TG_GROUPS_FILE));
      s.ensureRoom(CHAT, { title: "frogs", kind: "group" });
      assert.equal(s.claim(CHAT, 500, addr(1)), false, "not on disk → do nothing");
      assert.equal(s.claim(CHAT, 500, addr(1)), false, "and not later in this process either");
      assert.equal(s.claim(CHAT, 501, addr(2)), false);
      assert.equal(w.calls.length, 1);
      assert.ok(!w.calls[0]!.includes(addr(1).slice(2)), "no address in the log");
    } finally {
      w.restore();
    }
  });

  it("ages out claims after 2 days and bounds a flooded room", () => {
    const s = open();
    approvedRoom(s);
    assert.equal(s.claim(CHAT, 1, addr(1)), true);
    clock += 2 * DAY + 1;
    assert.equal(s.claim(CHAT, 2, addr(2)), true);
    assert.equal(s.room(CHAT)!.claims[`1:${addr(1)}`], undefined);

    for (let i = 3; i < 202; i++) assert.equal(s.claim(CHAT, i, addr(i)), true, `claim ${i}`);
    assert.equal(Object.keys(s.room(CHAT)!.claims).length, 200);
    assert.equal(s.claim(CHAT, 999, addr(999)), false, "200 fresh claims: a new coin is ignored, never double-handled");
    clock += 61 * MIN;
    assert.equal(s.claim(CHAT, 999, addr(999)), true, "claims past the pressure age make room");
    assert.equal(Object.keys(s.room(CHAT)!.claims).length, 200);
    assert.equal(s.claim(CHAT, 5, addr(5)), false, "a recent-enough claim is still there");
  });
});

// ─── Coins ───────────────────────────────────────────────────────────────

describe("coin memos", () => {
  it("replaces the memo for the same address and holds 60", () => {
    const s = open();
    approvedRoom(s);
    s.rememberCoin(CHAT, memo(addr(1), { verdict: "candidate" }));
    clock += MIN;
    s.rememberCoin(CHAT, memo(addr(1).toUpperCase().replace("0X", "0x"), { verdict: "passed", messageId: 2 }));
    assert.equal(s.room(CHAT)!.coins.length, 1);
    assert.equal(s.coin(CHAT, addr(1))!.verdict, "passed");
    for (let i = 2; i <= 70; i++) {
      clock += 1000;
      s.rememberCoin(CHAT, memo(addr(i)));
    }
    assert.equal(s.room(CHAT)!.coins.length, TG_LIMITS.coins);
    assert.equal(s.coin(CHAT, addr(1)), undefined);
    assert.ok(s.coin(CHAT, addr(70)));
    s.rememberCoin(CHAT, memo("0xnope"));
    s.rememberCoin(OTHER, memo(addr(1)));
    assert.equal(s.room(CHAT)!.coins.length, TG_LIMITS.coins);
  });

  it("looks up within a window, patches in place, and finds by decision across chats", () => {
    const s = open();
    approvedRoom(s);
    approvedRoom(s, OTHER, "toads");
    s.rememberCoin(CHAT, memo(addr(1), { verdict: "candidate" }));
    clock += 2 * HOUR;
    assert.equal(s.coin(CHAT, addr(1), HOUR), undefined);
    assert.ok(s.coin(CHAT, addr(1), 3 * HOUR));
    assert.ok(s.coin(CHAT, addr(1)));

    const m = s.coin(CHAT, addr(1))!;
    s.updateCoin(CHAT, addr(1), { decisionId: "d-9", verdict: "bought", paper: true, address: addr(5) });
    assert.equal(s.coin(CHAT, addr(1)), m, "patched in place");
    assert.equal(m.address, addr(1), "the address never changes");
    assert.equal(m.verdict, "bought");
    assert.equal(m.paper, true);
    s.updateCoin(CHAT, addr(1), { verdict: "mooned" as never });
    assert.equal(m.verdict, "bought", "a malformed patch is ignored whole");
    s.updateCoin(CHAT, addr(1), { paper: undefined });
    assert.equal(m.paper, undefined);

    s.rememberCoin(OTHER, memo(addr(2), { decisionId: "d-9", atMs: clock + 1 }));
    assert.deepEqual(s.findCoinByDecision("d-9"), { chatId: OTHER, memo: s.coin(OTHER, addr(2)) }, "the newest");
    assert.equal(s.findCoinByDecision("nope"), undefined);
    assert.equal(s.findCoinByDecision(""), undefined);
  });
});

// ─── Forgetting ──────────────────────────────────────────────────────────

describe("forgetChat and forgetPerson", () => {
  it("/forget wipes the memory but keeps status, title and claims — on disk at once", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1));
    s.upsertPerson(CHAT, { id: 7, name: "ann", note: "shills frogs" });
    s.rememberCoin(CHAT, memo(addr(1)));
    s.update(CHAT, (r) => {
      r.summary = "they like frogs";
      r.lastSummaryAtMs = T0;
    });
    assert.equal(s.claim(CHAT, 1, addr(1)), true);
    s.forgetChat(CHAT);
    const disk = onDisk().rooms[String(CHAT)];
    for (const r of [s.room(CHAT)!, disk]) {
      assert.deepEqual(r.lines, []);
      assert.equal(r.summary, "");
      assert.deepEqual(r.people, []);
      assert.deepEqual(r.coins, []);
      assert.equal(r.sinceSummary, 0);
      assert.equal(r.lastSummaryAtMs, undefined);
      assert.equal(r.status, "approved");
      assert.equal(r.title, "frogs");
      assert.deepEqual(Object.keys(r.claims), [`1:${addr(1)}`]);
    }
    s.forgetChat(OTHER);
  });

  it("/forgetme removes one person's lines and entry, and says how many lines went", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { fromId: 7 }));
    s.addLine(CHAT, line(2, { fromId: 8 }));
    s.addLine(CHAT, line(3, { fromId: 7 }));
    s.upsertPerson(CHAT, { id: 7, name: "ann" });
    s.upsertPerson(CHAT, { id: 8, name: "bo" });
    assert.equal(s.forgetPerson(CHAT, 7), 2);
    assert.deepEqual(s.room(CHAT)!.lines.map((l) => l.messageId), [2]);
    assert.deepEqual(s.room(CHAT)!.people.map((p) => p.id), [8]);
    const disk = onDisk().rooms[String(CHAT)];
    assert.deepEqual(disk.lines.map((l: TgLine) => l.fromId), [8], "written before returning");
    assert.equal(s.forgetPerson(CHAT, 7), 0);
    assert.equal(s.forgetPerson(OTHER, 7), 0);
  });

  it("every wipe moves the chat's forget generation, so a memory pass that read before it can tell", () => {
    const s = open();
    approvedRoom(s);
    approvedRoom(s, OTHER, "others");
    assert.equal(s.forgetGen(CHAT), 0);
    s.forgetChat(CHAT);
    assert.equal(s.forgetGen(CHAT), 1);
    s.forgetPerson(CHAT, 7);
    assert.equal(s.forgetGen(CHAT), 2, "a /forgetme counts, even with nothing of theirs left");
    assert.equal(s.forgetGen(OTHER), 0, "per chat");
    s.addLine(CHAT, line(1));
    s.update(CHAT, (r) => {
      r.summary = "new";
    });
    assert.equal(s.forgetGen(CHAT), 2, "ordinary changes do not");
  });
});

// ─── Forget requests, in their own file ──────────────────────────────────

describe("forget requests: recordForget, parseTgForgets and applyForgets", () => {
  const ALICE = 7;
  const BO = 8;
  const forgetPath = () => path.join(home, TG_GROUPS_FORGET_FILE);
  const onFile = (): TgForgetOp[] => parseTgForgets(readFileSync(forgetPath(), "utf8"));

  /** A room that remembers Alice and Bo: lines, notes, coin posts, and a summary naming Alice. */
  function remembered(s: TgGroupsStore): void {
    approvedRoom(s);
    s.addLine(CHAT, line(1, { fromId: ALICE, name: "alice", text: "wen lambo" }));
    s.addLine(CHAT, line(2, { fromId: BO, name: "bo", text: "never" }));
    s.upsertPerson(CHAT, { id: ALICE, name: "alice", note: "shills frogs" });
    s.upsertPerson(CHAT, { id: BO, name: "bo", note: "the skeptic" });
    s.rememberCoin(CHAT, memo(addr(1), { byId: ALICE, byName: "alice" }));
    s.rememberCoin(CHAT, memo(addr(2), { byId: BO, byName: "bo" }));
    s.update(CHAT, (r) => {
      r.summary = "Alice keeps posting frogs";
      r.lastSummaryAtMs = clock;
    });
  }

  it("on disk before it returns, one record per line, whether or not the store knows the chat", () => {
    const s = open();
    assert.equal(s.recordForget({ chatId: CHAT, userId: ALICE, atMs: T0 }), true);
    assert.deepEqual(onFile(), [{ chatId: CHAT, userId: ALICE, atMs: T0 }], "written before returning, no flush needed");
    assert.equal(statSync(forgetPath()).mode & 0o777, 0o600);
    assert.equal(s.room(OTHER), undefined);
    assert.equal(s.recordForget({ chatId: OTHER, userId: "*", atMs: T0 + 1 }), true, "a held child's empty store records it too");
    assert.deepEqual(onFile(), [
      { chatId: CHAT, userId: ALICE, atMs: T0 },
      { chatId: OTHER, userId: "*", atMs: T0 + 1 },
    ]);
    assert.equal(existsSync(filePath()), false, "the memory file is not written by a request");
  });

  it("a record torn by a crash never swallows the next, and a malformed request is refused", () => {
    const s = open();
    s.recordForget({ chatId: CHAT, userId: ALICE, atMs: T0 });
    appendFileSync(forgetPath(), '{"chatId":-1,"userId":');
    assert.equal(s.recordForget({ chatId: CHAT, userId: BO, atMs: T0 + 1 }), true);
    assert.deepEqual(onFile(), [
      { chatId: CHAT, userId: ALICE, atMs: T0 },
      { chatId: CHAT, userId: BO, atMs: T0 + 1 },
    ]);
    const before = readFileSync(forgetPath(), "utf8");
    for (const bad of [
      { chatId: 1.5, userId: ALICE, atMs: T0 },
      { chatId: CHAT, userId: "alice", atMs: T0 },
      { chatId: CHAT, userId: ALICE, atMs: Number.NaN },
      null,
    ]) {
      assert.equal(s.recordForget(bad as unknown as TgForgetOp), false);
    }
    assert.equal(readFileSync(forgetPath(), "utf8"), before);
  });

  it("past its size bound the file is compacted: one request per chat and person, the latest, none lost", () => {
    const s = open();
    const rows: string[] = [];
    for (let i = 0; rows.join("").length < TG_FORGET_LIMITS.fileBytes; i++) {
      rows.push(`\n${JSON.stringify({ chatId: CHAT, userId: 100 + (i % 5), atMs: T0 + i })}\n`);
    }
    writeFileSync(forgetPath(), rows.join(""), { mode: 0o600 });
    const n = rows.length;
    assert.equal(s.recordForget({ chatId: OTHER, userId: "*", atMs: T0 + n }), true);
    assert.ok(statSync(forgetPath()).size < TG_FORGET_LIMITS.fileBytes / 4, "compacted, not appended to");
    const ops = onFile();
    assert.equal(ops.length, 6);
    for (let p = 0; p < 5; p++) {
      const latest = Math.max(...Array.from({ length: n }, (_, i) => i).filter((i) => i % 5 === p)) + T0;
      assert.deepEqual(ops.find((o) => o.userId === 100 + p), { chatId: CHAT, userId: 100 + p, atMs: latest });
    }
    assert.deepEqual(ops.at(-1), { chatId: OTHER, userId: "*", atMs: T0 + n });
    assert.equal(readdirSync(home).filter((f) => f.startsWith(TG_GROUPS_FORGET_FILE)).length, 1, "no temp file left");
  });

  it("parseTgForgets keeps well-formed records only, the latest per chat and person, at most the cap", () => {
    const text = [
      JSON.stringify({ chatId: CHAT, userId: ALICE, atMs: T0 }),
      "not json",
      JSON.stringify({ chatId: CHAT, userId: ALICE, atMs: T0 + 5 }),
      JSON.stringify({ chatId: CHAT, userId: ALICE, atMs: T0 + 2 }),
      JSON.stringify({ chatId: CHAT, userId: "*", atMs: T0 + 1, extra: "dropped" }),
      JSON.stringify({ chatId: "x", userId: ALICE, atMs: T0 }),
      "",
    ].join("\n");
    assert.deepEqual(parseTgForgets(text), [
      { chatId: CHAT, userId: "*", atMs: T0 + 1 },
      { chatId: CHAT, userId: ALICE, atMs: T0 + 5 },
    ]);
    const many = Array.from({ length: TG_FORGET_LIMITS.ops + 10 }, (_, i) => JSON.stringify({ chatId: CHAT, userId: i + 1, atMs: T0 + i })).join("\n");
    const kept = parseTgForgets(many);
    assert.equal(kept.length, TG_FORGET_LIMITS.ops);
    assert.equal(kept[0]!.userId, 11, "the newest are kept");
  });

  it("applyForgets does exactly what forgetPerson does (coin memos and summary included), and leaves its input alone", () => {
    const s = open();
    remembered(s);
    const given = JSON.parse(JSON.stringify(s.state)) as TgGroupsState;
    const snapshot = JSON.stringify(given);
    const applied = applyForgets(given, [{ chatId: CHAT, userId: ALICE, atMs: clock }]);
    assert.equal(JSON.stringify(given), snapshot, "pure: the state handed in is unchanged");

    assert.equal(s.forgetPerson(CHAT, ALICE), 1);
    assert.deepEqual(applied.rooms[String(CHAT)], s.room(CHAT), "the same room either way");
    const r = s.room(CHAT)!;
    assert.deepEqual(r.lines.map((l) => l.fromId), [BO]);
    assert.deepEqual(r.people.map((p) => p.id), [BO]);
    assert.deepEqual(
      r.coins.map((c) => [c.address, c.byId, c.byName, c.verdict]),
      [
        [addr(1), 0, "", "passed"],
        [addr(2), BO, "bo", "passed"],
      ],
      "their coin post keeps the coin and verdict, not who posted it",
    );
    assert.equal(r.summary, "", "a summary naming them is dropped");
    assert.equal(onDisk().rooms[String(CHAT)].coins[0].byName, "", "and it is on disk before returning");
  });

  it("applyForgets does exactly what forgetChat does", () => {
    const s = open();
    remembered(s);
    assert.equal(s.claim(CHAT, 1, addr(1)), true);
    const applied = applyForgets(s.state as TgGroupsState, [{ chatId: CHAT, userId: "*", atMs: clock }]);
    s.forgetChat(CHAT);
    assert.deepEqual(applied.rooms[String(CHAT)], s.room(CHAT));
    assert.deepEqual(Object.keys(s.room(CHAT)!.claims), [`1:${addr(1)}`], "claims stay");
  });

  it("bounded by when it was asked: applied again later, it never erases what was said after it", () => {
    const s = open();
    remembered(s);
    const askedAt = clock;
    clock += 5 * MIN;
    // Alice comes back after the forget: a new line, a new note, a new coin, a new summary.
    s.addLine(CHAT, line(3, { fromId: ALICE, name: "alice", text: "back again" }));
    s.upsertPerson(CHAT, { id: ALICE, name: "alice", note: "came back" });
    s.rememberCoin(CHAT, memo(addr(3), { byId: ALICE, byName: "alice" }));
    const op: TgForgetOp = { chatId: CHAT, userId: ALICE, atMs: askedAt };
    const once = applyForgets(s.state as TgGroupsState, [op]);
    const r = once.rooms[String(CHAT)]!;
    assert.deepEqual(r.lines.map((l) => l.messageId), [2, 3], "the line from before the request goes, the later one stays");
    assert.equal(r.people.find((p) => p.id === ALICE)?.note, "came back");
    assert.deepEqual(r.coins.find((c) => c.address === addr(1))?.byId, 0);
    assert.deepEqual(r.coins.find((c) => c.address === addr(3))?.byId, ALICE);
    assert.equal(r.summary, "", "the summary from before the request named her");
    assert.deepEqual(applyForgets(once, [op]), once, "applying it again changes nothing");

    // A summary written after the request is not the request's to drop.
    const later = applyForgets(once, []);
    later.rooms[String(CHAT)]!.summary = "alice is back";
    later.rooms[String(CHAT)]!.lastSummaryAtMs = clock;
    assert.equal(applyForgets(later, [op]).rooms[String(CHAT)]!.summary, "alice is back");
    // Nor is one that does not name them.
    const s2 = make(path.join(home, "other.json"));
    remembered(s2);
    s2.update(CHAT, (x) => {
      x.summary = "bo doubts everything";
    });
    assert.equal(applyForgets(s2.state as TgGroupsState, [op]).rooms[String(CHAT)]!.summary, "bo doubts everything");
    // A chat the state does not have is skipped.
    const none = applyForgets(s.state as TgGroupsState, [{ chatId: 12345, userId: "*", atMs: clock }]);
    assert.deepEqual(none, parseTgGroupsState(s.state));
  });

  // THE FINDING, at the store: the request was written, then the process
  // died (or the memory write failed) before the memory reflected it. The
  // next open must not hand the forgotten lines back.
  it("open applies the forget file, so a memory written before the request never brings the lines back", () => {
    const s = open();
    remembered(s);
    s.flush();
    assert.equal(s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock }), true);
    // No forgetPerson: the crash came first.
    assert.ok(onDisk().rooms[String(CHAT)].lines.some((l: TgLine) => l.fromId === ALICE), "the file on disk still has her");

    const again = open();
    const r = again.room(CHAT)!;
    assert.deepEqual(r.lines.map((l) => l.fromId), [BO]);
    assert.deepEqual(r.people.map((p) => p.id), [BO]);
    assert.equal(r.coins.find((c) => c.address === addr(1))?.byName, "");
    assert.equal(r.summary, "");
    again.flush();
    assert.ok(!JSON.stringify(onDisk()).includes("wen lambo"), "and the file is rewritten without her");
  });

  it("an open with nothing left to forget writes nothing", () => {
    const s = open();
    remembered(s);
    s.forgetPerson(CHAT, ALICE);
    s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock });
    s.flush();
    // Every write is a new file renamed over the old one.
    const ino = statSync(filePath()).ino;
    const again = open();
    again.flush();
    assert.equal(statSync(filePath()).ino, ino);
  });
});

// ─── Migration ───────────────────────────────────────────────────────────

describe("migrate", () => {
  const OLD = -4001;
  const NEW = -1004001;

  it("moves the room to the supergroup id, keeping its status", () => {
    const s = open();
    approvedRoom(s, OLD);
    s.addLine(OLD, line(5));
    s.addLine(OLD, line(6, { replyTo: 5 }));
    assert.equal(s.claim(OLD, 6, addr(1)), true);
    s.migrate(OLD, NEW);
    assert.equal(s.room(OLD), undefined);
    const r = s.room(NEW)!;
    assert.equal(r.chatId, NEW);
    assert.equal(r.status, "approved");
    assert.equal(r.kind, "supergroup");
    assert.deepEqual(r.lines.map((l) => [l.messageId, l.replyTo]), [[-5, undefined], [-6, -5]]);
    assert.ok(r.claims[`6:${addr(1)}`]);
    assert.equal(onDisk().rooms[String(NEW)].status, "approved", "written before returning");
    assert.equal(onDisk().rooms[String(OLD)], undefined);
    assert.equal(s.addLine(NEW, line(5)), true, "a new message with an old id is not a duplicate");
  });

  it("merges into a room the new chat's first message already created", () => {
    const s = open();
    approvedRoom(s, OLD, "frogs");
    s.addLine(OLD, line(5, { atMs: T0 }));
    s.upsertPerson(OLD, { id: 7, name: "ann", note: "shills frogs", lastSeenMs: T0 });
    s.rememberCoin(OLD, memo(addr(1)));
    s.update(OLD, (r) => void (r.summary = "old summary"));
    clock += MIN;
    s.ensureRoom(NEW, { title: "frogs (super)", kind: "supergroup" });
    s.addLine(NEW, line(1, { atMs: clock }));
    s.upsertPerson(NEW, { id: 7, name: "ann" });
    s.migrate(OLD, NEW);
    const r = s.room(NEW)!;
    assert.equal(r.status, "approved", "the migrated room's status wins over the fresh pending one");
    assert.equal(r.title, "frogs (super)");
    assert.deepEqual(r.lines.map((l) => l.messageId), [-5, 1]);
    assert.equal(r.people.length, 1);
    assert.equal(r.people[0]!.note, "shills frogs", "the note survives the merge");
    assert.equal(r.people[0]!.lastSeenMs, clock);
    assert.ok(s.coin(NEW, addr(1)));
    assert.equal(r.summary, "old summary");
    assert.equal(s.rooms().length, 1);
  });

  it("is a no-op for an unknown source or the same id", () => {
    const s = open();
    approvedRoom(s, OLD);
    s.migrate(-1, NEW);
    s.migrate(OLD, OLD);
    assert.equal(s.room(OLD)!.status, "approved");
    assert.equal(s.room(NEW), undefined);
  });
});

// ─── Allowances ──────────────────────────────────────────────────────────

describe("allowances", () => {
  it("takeLlm: a per-UTC-day count that resets on a new day, never on a clock going back", () => {
    const s = open();
    for (let i = 0; i < 3; i++) assert.equal(s.takeLlm(3), true);
    assert.equal(s.takeLlm(3), false);
    assert.equal(s.state.llm.used, 3);
    clock = Date.UTC(2026, 8, 29, 0, 0, 0);
    assert.equal(s.takeLlm(3), true);
    assert.deepEqual(s.state.llm, { day: "2026-09-29", used: 1 });
    clock = T0;
    assert.equal(s.takeLlm(3), false, "yesterday gets no fresh allowance");
    assert.equal(s.takeLlm(0), false);
    assert.equal(s.takeLlm(Number.NaN), false);
  });

  it("the llm allowance survives a reopen", () => {
    const s = open();
    s.takeLlm(2);
    s.takeLlm(2);
    s.close();
    assert.equal(open().takeLlm(2), false);
  });

  it("pauseLlm / llmPausedUntil: a pause is never shortened, and reads 0 once over", () => {
    const s = open();
    assert.equal(s.llmPausedUntil(), 0);
    const midnight = Date.UTC(2026, 8, 29);
    s.pauseLlm(midnight);
    s.pauseLlm(T0 + 10 * MIN);
    assert.equal(s.llmPausedUntil(), midnight);
    s.pauseLlm(Number.NaN);
    assert.equal(s.llmPausedUntil(), midnight);
    clock = midnight;
    assert.equal(s.llmPausedUntil(), 0);
  });

  it("takeRoomLlm: per chat, per UTC hour", () => {
    const s = open();
    approvedRoom(s);
    approvedRoom(s, OTHER, "toads");
    assert.equal(s.takeRoomLlm(CHAT, 2), true);
    assert.equal(s.takeRoomLlm(CHAT, 2), true);
    assert.equal(s.takeRoomLlm(CHAT, 2), false);
    assert.equal(s.takeRoomLlm(OTHER, 2), true, "chats do not share an hour");
    clock = T0 + HOUR;
    assert.equal(s.takeRoomLlm(CHAT, 2), true);
    assert.deepEqual(s.room(CHAT)!.llmHour, { hour: "2026-09-28T13", n: 1 });
    clock = T0;
    assert.equal(s.takeRoomLlm(CHAT, 2), false, "an earlier hour gets nothing");
    assert.equal(s.takeRoomLlm(12345, 2), false);
    assert.equal(s.takeRoomLlm(CHAT, 0), false);
  });

  it("nominations and group entries: separate counts, one day key, durable before true", () => {
    const s = open();
    const today = utcDay(clock);
    assert.equal(s.takeNomination(today, 2), true);
    assert.equal(onDisk().nominations.n, 1, "on disk before returning");
    assert.equal(s.takeNomination(today, 2), true);
    assert.equal(s.takeNomination(today, 2), false);
    for (let i = 0; i < 3; i++) assert.equal(s.takeGroupEntry(today, 3), true);
    assert.equal(onDisk().nominations.entries, 3);
    assert.equal(s.takeGroupEntry(today, 3), false);
    assert.deepEqual(s.state.nominations, { day: today, n: 2, entries: 3 });

    // A crash after the take: the count is still there.
    const after = TgGroupsStore.open(home, { now, debounceMs: 60_000 });
    opened.push(after);
    assert.equal(after.takeGroupEntry(today, 3), false);
    assert.equal(after.takeNomination(today, 2), false);

    const tomorrow = "2026-09-29";
    assert.equal(s.takeGroupEntry(tomorrow, 3), true);
    assert.deepEqual(s.state.nominations, { day: tomorrow, n: 0, entries: 1 }, "a new day resets both");
    assert.equal(s.takeNomination(today, 2), false, "a stale day never gets a fresh allowance");
    assert.equal(s.takeGroupEntry(today, 3), false);
    assert.deepEqual(s.state.nominations, { day: tomorrow, n: 0, entries: 1 }, "and never wipes today's count");
    assert.equal(s.takeNomination("not a day", 2), false);
    assert.equal(s.takeGroupEntry(tomorrow, 0), false);
  });

  it("refundGroupEntry gives one back, never below zero, never across days", () => {
    const s = open();
    const today = utcDay(clock);
    assert.equal(s.takeGroupEntry(today, 1), true);
    assert.equal(s.takeGroupEntry(today, 1), false);
    s.refundGroupEntry(today);
    assert.equal(s.state.nominations.entries, 0);
    s.refundGroupEntry(today);
    assert.equal(s.state.nominations.entries, 0, "floor at zero");
    assert.equal(s.takeGroupEntry(today, 1), true);
    s.refundGroupEntry("2026-09-27");
    assert.equal(s.state.nominations.entries, 1, "yesterday's refund returns nothing today");
    assert.equal(s.takeGroupEntry(today, 1), false);
  });

  it("a cap take that cannot be written refuses and consumes nothing", () => {
    const w = captureWarn();
    try {
      const blocker = path.join(home, "blocker");
      writeFileSync(blocker, "x");
      const s = make(path.join(blocker, TG_GROUPS_FILE));
      const today = utcDay(clock);
      assert.equal(s.takeGroupEntry(today, 3), false);
      assert.equal(s.takeNomination(today, 12), false);
      assert.deepEqual(s.state.nominations, { day: "", n: 0, entries: 0 });
      rmSync(blocker);
      assert.equal(s.takeGroupEntry(today, 3), true);
      assert.deepEqual(s.state.nominations, { day: today, n: 0, entries: 1 });
    } finally {
      w.restore();
    }
  });
});

// ─── Pruning and the size bound ──────────────────────────────────────────

describe("prune", () => {
  it("ages out lines and coins at 14 days, gone rooms at 30, claims at 2", () => {
    const s = open();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { atMs: T0 - 14 * DAY - 1 }));
    s.addLine(CHAT, line(2, { atMs: T0 - 14 * DAY }));
    s.rememberCoin(CHAT, memo(addr(1), { atMs: T0 - 15 * DAY }));
    s.rememberCoin(CHAT, memo(addr(2), { atMs: T0 - DAY }));
    clock = T0 - 3 * DAY;
    assert.equal(s.claim(CHAT, 1, addr(1)), true);
    clock = T0 - DAY;
    assert.equal(s.claim(CHAT, 2, addr(2)), true);

    clock = T0 - 31 * DAY;
    s.ensureRoom(-1, { title: "left long ago", kind: "group" });
    s.setStatus(-1, "left");
    s.ensureRoom(-2, { title: "approved long ago", kind: "group" });
    s.setStatus(-2, "approved");
    clock = T0 - 29 * DAY;
    s.ensureRoom(-3, { title: "blocked recently", kind: "group" });
    s.setStatus(-3, "blocked");

    clock = T0;
    s.prune();
    const r = s.room(CHAT)!;
    assert.deepEqual(r.lines.map((l) => l.messageId), [2], "exactly 14 days is kept");
    assert.deepEqual(r.coins.map((c) => c.address), [addr(2)]);
    assert.deepEqual(Object.keys(r.claims), [`2:${addr(2)}`]);
    assert.equal(s.room(-1), undefined);
    assert.ok(s.room(-2), "an approved room is not aged out");
    assert.ok(s.room(-3));
  });

  it("keeps the file under 512 KB by dropping the oldest lines across rooms first", () => {
    const s = open();
    const text = "ü".repeat(TG_LIMITS.lineChars); // 2 bytes each in UTF-8
    let t = T0 - DAY;
    for (let c = 1; c <= 30; c++) approvedRoom(s, -c, `room ${c}`);
    // Claimed before the lines: a claim is a write, and every write enforces
    // the bound, which would trim the fixture before prune() is reached.
    assert.equal(s.claim(-1, 1, addr(1)), true);
    for (let i = 1; i <= 60; i++) {
      for (let c = 1; c <= 30; c++) s.addLine(-c, line(i, { atMs: t++, text }));
    }
    s.upsertPerson(-1, { id: 7, name: "ann", note: "keeps" });
    const bytes = () => Buffer.byteLength(JSON.stringify(s.state), "utf8");
    assert.ok(bytes() >= TG_LIMITS.fileBytes, "the fixture really is over the bound");

    s.prune();
    assert.ok(bytes() < TG_LIMITS.fileBytes);
    const kept = s.rooms().flatMap((r) => r.lines.map((l) => l.atMs));
    const dropped = 30 * 60 - kept.length;
    assert.ok(dropped > 0);
    assert.equal(Math.min(...kept), T0 - DAY + dropped, "exactly the oldest lines went");
    assert.equal(s.person(-1, 7)!.note, "keeps", "people are untouched while lines suffice");
    assert.ok(s.room(-1)!.claims[`1:${addr(1)}`]);
    s.flush();
    assert.ok(statSync(filePath()).size < TG_LIMITS.fileBytes);
  });

  it("enforces the bound on every write, even without an explicit prune", () => {
    const s = open();
    const text = "ü".repeat(TG_LIMITS.lineChars);
    for (let c = 1; c <= 30; c++) approvedRoom(s, -c);
    for (let i = 1; i <= 60; i++) for (let c = 1; c <= 30; c++) s.addLine(-c, line(i, { atMs: T0 + i, text }));
    s.flush();
    assert.ok(statSync(filePath()).size < TG_LIMITS.fileBytes);
  });

  it("past the lines, drops coin memos and people — but never a claim younger than an hour", () => {
    // Built directly (no writes on the way): every write enforces the bound,
    // so a fixture built through claim() would never get over it.
    const st = emptyTgGroupsState();
    const emoji = "🐸".repeat(TG_LIMITS.noteChars / 2); // 4 bytes per 2 units
    for (let c = 1; c <= 30; c++) {
      const people = Array.from({ length: 40 }, (_, p) => ({ id: p + 1, name: "n".repeat(40), note: emoji, lastSeenMs: T0 - p }));
      const coins = Array.from({ length: 60 }, (_, k) =>
        memo(addr(c * 1000 + k), { atMs: T0 - k, name: "c".repeat(40), byName: "b".repeat(40), decisionId: "d".repeat(64) }),
      );
      const claims: Record<string, number> = {};
      for (let k = 1; k <= 20; k++) claims[`${k}:${addr(k)}`] = T0 - k * MIN; // all younger than an hour
      st.rooms[String(-c)] = validRoom({ chatId: -c, title: "t".repeat(128), lines: [], people, coins, claims });
    }
    const s = make(filePath(), st);
    const bytes = () => Buffer.byteLength(JSON.stringify(s.state), "utf8");
    assert.ok(bytes() >= TG_LIMITS.fileBytes, "over the bound with no lines at all");
    s.prune();
    assert.ok(bytes() < TG_LIMITS.fileBytes);
    const coinsLeft = s.rooms().reduce((n, r) => n + r.coins.length, 0);
    assert.ok(coinsLeft < 30 * 60, "coin memos went");
    for (let c = 1; c <= 30; c++) assert.equal(Object.keys(s.room(-c)!.claims).length, 20, "every fresh claim kept");
    s.flush();
    assert.ok(statSync(filePath()).size < TG_LIMITS.fileBytes);
  });
});

describe("self-hosted: the store clears its own forget file (ownsForgets)", () => {
  const ALICE = 7;
  const forgetPath = () => path.join(home, TG_GROUPS_FORGET_FILE);
  const owned = () => TgGroupsStore.open(home, { now, debounceMs: 60_000, ownsForgets: true });

  it("once the memory file reflects the request, the request is gone from disk", () => {
    const s = owned();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { fromId: ALICE, name: "alice", text: "wen lambo" }));
    s.upsertPerson(CHAT, { id: ALICE, name: "alice", note: "shills frogs" });
    s.flush();
    assert.equal(s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock }), true);
    assert.equal(existsSync(forgetPath()), true, "recorded before the wipe");
    s.forgetPerson(CHAT, ALICE);
    s.flush();
    assert.equal(existsSync(forgetPath()), false, "nobody's id is kept once their memory is gone");
    assert.equal(onDisk().rooms[String(CHAT)].people.length, 0);
    s.close();
  });

  it("a request the memory does not reflect yet keeps the file", () => {
    const s = owned();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { fromId: ALICE, name: "alice", text: "wen lambo" }));
    s.flush();
    s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock });
    // A write that happens before the wipe (another room changed) must not drop it.
    s.ensureRoom(OTHER, { title: "other", kind: "supergroup" });
    s.flush();
    assert.equal(existsSync(forgetPath()), true);
    s.forgetPerson(CHAT, ALICE);
    s.flush();
    assert.equal(existsSync(forgetPath()), false);
    s.close();
  });

  it("a crash between the request and the wipe: the next open applies it, writes, then clears it", () => {
    const s = owned();
    approvedRoom(s);
    s.addLine(CHAT, line(1, { fromId: ALICE, name: "alice", text: "wen lambo" }));
    s.flush();
    s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock });
    // No forgetPerson: the process died here.
    const again = owned();
    again.flush();
    assert.equal(again.room(CHAT)?.lines.some((l) => l.fromId === ALICE), false);
    assert.equal(existsSync(forgetPath()), false);
    again.close();
  });

  it("hosted (the default): the store never clears it; the ferry must see it first", () => {
    const s = open();
    approvedRoom(s);
    s.recordForget({ chatId: CHAT, userId: ALICE, atMs: clock });
    s.forgetPerson(CHAT, ALICE);
    s.flush();
    assert.equal(existsSync(forgetPath()), true);
    s.close();
  });
});
