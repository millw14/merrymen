/**
 * THE ROOM'S CLIENT STATE, driven without a browser.
 *
 * Each of these is a way a chat quietly lies to its reader: a line that never
 * arrives because two writers committed out of order, a bubble drawn twice, a
 * message that looks sent and was refused, an outage rendered as "nobody has
 * said anything", a screen that polls behind a closed tab for ever. None of
 * them throws. They are pinned here because a click-through finds none.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { PublicMessage, RoomState } from "../../../worker/src/groupchat/types";
import {
  ANNOUNCE_MAX,
  COMPOSER_MAX,
  HIDDEN_MS,
  KEEP_LINES,
  OVERLAP,
  PAGE,
  POLL_LIMIT,
  RESUME_AFTER_MS,
  ROOM_STALE_MS,
  VISIBLE_MS,
  announcements,
  chatItems,
  excerpt,
  hideLine,
  isMine,
  isTakenBack,
  labelDays,
  loadEarlier,
  loadUntil,
  mentionParts,
  noteMe,
  pollNow,
  postError,
  postLine,
  presenceLine,
  pullMe,
  replyTarget,
  resetGroupChatForTest,
  roomIsFresh,
  setFollowing,
  storeForTest,
} from "./groupchat";

const BASE = Date.UTC(2026, 8, 23, 12, 0, 0);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function msg(id: number, extra: Partial<PublicMessage> = {}): PublicMessage {
  return { id, at: BASE + id * 1000, author: "agent", slug: `a${id % 3}`, name: `Agent${id % 3}`, body: `line ${id}`, replyTo: null, kind: "chat", call: null, ...extra };
}
const ROOM: RoomState = { members: 3, awake: 2, asleep: 1, presence: [], updatedAtMs: BASE };
function page(messages: PublicMessage[], extra: Record<string, unknown> = {}) {
  return { source: "db", messages, cursor: messages.reduce((m, x) => Math.max(m, x.id), 0), room: ROOM, ...extra };
}
const ME = { signedIn: true, member: true, slug: "mine", name: "Robin", tz: "Europe/London", tzSource: "browser", muted: false, sleep: { from: "23:10", to: "06:55" } };

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
let calls: Call[];
let route: (call: Call) => Response | Promise<Response>;
const originalFetch = globalThis.fetch;
const reads = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/groupchat?"));
let unsubscribe: (() => void) | null = null;
const open = () => {
  unsubscribe = storeForTest.subscribe(() => {});
};

beforeEach(() => {
  resetGroupChatForTest();
  calls = [];
  route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([])));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetGroupChatForTest();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "document");
});

const ids = () => storeForTest.get().messages.map((m) => m.id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * A room that answers the way the route does — newest page, `since`, `before`
 * — over whatever lines `all()` holds right now, so a poll the scheduler fires
 * on its own gets a true answer too.
 */
function serve(all: () => PublicMessage[], extra: () => Record<string, unknown> = () => ({})) {
  return (c: Call): Response => {
    if (c.url.startsWith("/api/groupchat/me")) return json(ME);
    const q = new URL(c.url, "https://room.test").searchParams;
    const limit = Number(q.get("limit") ?? 50);
    const rows = [...all()].sort((a, b) => a.id - b.id);
    if (q.has("since")) return json(page(rows.filter((m) => m.id > Number(q.get("since"))).slice(0, limit), extra()));
    if (q.has("before")) {
      const older = rows.filter((m) => m.id < Number(q.get("before")));
      return json(page(older.slice(-limit), { start: older.length <= limit, ...extra() }));
    }
    return json(page(rows.slice(-limit), extra()));
  };
}

/** A stand-in for the page's visibility — the only part of `document` the store reads. */
function pageVisibility(state: "visible" | "hidden") {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { visibilityState: state, addEventListener() {}, removeEventListener() {} },
  });
}

describe("reading the room", () => {
  it("the first read is the newest page — and it fires even when the page says it is hidden", async () => {
    // The desktop app's Browser pane reports `hidden: true` for a page somebody
    // is looking at; gating the first read on visibility is a skeleton for ever.
    pageVisibility("hidden");
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([msg(7), msg(5), msg(6)])));
    open();
    await pollNow();
    await pullMe();
    assert.equal(reads()[0]!.url, `/api/groupchat?limit=${PAGE}`);
    const s = storeForTest.get();
    assert.equal(s.status, "ok");
    assert.deepEqual(s.messages.map((m) => m.id), [5, 6, 7], "ascending by id, whatever order they came in");
    assert.equal(s.cursor, 7);
    assert.equal(s.start, true, "a short newest page is the whole room");
    assert.deepEqual(s.room, ROOM);
    assert.equal(s.me?.member, true);
  });

  it("A POLL RE-ASKS A WINDOW BEHIND THE CURSOR, so a line committed late is not lost", async () => {
    // Ids are handed out in insert order and committed in finish order. The
    // first read saw 104 before 103 was visible; asking only for `> 104` next
    // would lose 103 for good.
    route = () => json(page([msg(100), msg(101), msg(102), msg(104)]));
    open();
    await pollNow();
    route = () => json(page([msg(100), msg(101), msg(102), msg(103), msg(104), msg(105)]));
    await pollNow();
    assert.equal(reads()[1]!.url, `/api/groupchat?since=${104 - OVERLAP}&limit=${POLL_LIMIT}`);
    const s = storeForTest.get();
    assert.deepEqual(s.messages.map((m) => m.id), [100, 101, 102, 103, 104, 105], "every line once, in order");
    assert.equal(s.cursor, 105);
  });

  it("and the cursor never moves backwards on a quiet poll", async () => {
    // A quiet overlap answers with the `since` it was sent — behind the cursor
    // by design. Taking it would re-read the window for ever, growing each time.
    route = () => json(page([msg(50)]));
    open();
    await pollNow();
    route = () => json({ source: "db", messages: [], cursor: 50 - OVERLAP, room: null });
    await pollNow();
    assert.equal(storeForTest.get().cursor, 50);
    assert.deepEqual(storeForTest.get().room, ROOM, "a missing summary keeps the last one rather than blanking the header");
  });

  it("A POLL WITH NO NEWS NOTIFIES NOBODY — the overlap is not a re-render every three seconds", async () => {
    // The window behind the cursor re-delivers the last few lines on every
    // poll. Treated as news, that re-renders every bubble on a phone forever.
    route = () => json(page([msg(40), msg(41)]));
    let heard = 0;
    unsubscribe = storeForTest.subscribe(() => heard++);
    await pollNow();
    const before = storeForTest.get();
    const count = heard;
    await pollNow();
    assert.equal(heard, count, "nothing changed, nobody told");
    assert.equal(storeForTest.get(), before, "the same state object");
    route = () => json(page([msg(40), msg(41, { body: "edited by nobody, but different" })]));
    await pollNow();
    assert.equal(heard, count + 1, "a real change is still news");
  });

  it("a full poll page means we are behind, and the next page follows at once", async () => {
    const t = mock.timers;
    t.enable({ apis: ["setTimeout"] });
    try {
      route = () => json(page([msg(1)]));
      open();
      await pollNow();
      const many = Array.from({ length: POLL_LIMIT }, (_, i) => msg(i + 2));
      route = () => json(page(many));
      await pollNow();
      const before = reads().length;
      t.tick(0);
      assert.equal(reads().length, before + 1, "caught up without waiting a whole cadence");
      await pollNow();
    } finally {
      t.reset();
    }
  });

  it("an earlier page asks before the oldest line and lands in order", async () => {
    route = () => json(page(Array.from({ length: PAGE }, (_, i) => msg(200 + i))));
    open();
    await pollNow();
    assert.equal(storeForTest.get().start, false, "a full newest page may have more behind it");
    route = () => json(page([msg(150), msg(151)], { start: true }));
    await loadEarlier();
    assert.equal(reads().at(-1)!.url, `/api/groupchat?before=200&limit=${PAGE}`);
    const s = storeForTest.get();
    assert.deepEqual(s.messages.slice(0, 3).map((m) => m.id), [150, 151, 200]);
    assert.equal(s.start, true);
    await loadEarlier();
    assert.equal(reads().at(-1)!.url, `/api/groupchat?before=200&limit=${PAGE}`, "nothing is asked for past the start");
  });

  it("leaving and coming back keeps what was read, and asks only for what is new", async () => {
    route = () => json(page([msg(30), msg(31)]));
    open();
    await pollNow();
    unsubscribe!();
    unsubscribe = null;
    assert.equal(storeForTest.scheduled(), false, "no reader, no poll");
    open();
    assert.deepEqual(storeForTest.get().messages.map((m) => m.id), [30, 31], "not blanked while the next read is in flight");
    await pollNow();
    assert.match(reads().at(-1)!.url, /since=/);
  });

  it("BACK AFTER A LONG ABSENCE, THE SCREEN STARTS FROM THE NEWEST PAGE — not hours of catch-up shown as new", async () => {
    // Paging forward from an old cursor showed lines from hours ago as the
    // newest for as long as the catch-up took, and animated every one in.
    const t = mock.timers;
    t.enable({ apis: ["setTimeout", "Date"], now: BASE });
    try {
      let all = range(1, 10).map((id) => msg(id));
      route = serve(() => all);
      open();
      await pollNow();
      unsubscribe!();
      unsubscribe = null;
      all = range(1, 300).map((id) => msg(id));
      t.tick(RESUME_AFTER_MS + 1_000);
      open();
      await pollNow();
      const s = storeForTest.get();
      assert.equal(reads().at(-1)!.url, `/api/groupchat?limit=${PAGE}`, "the newest page, not a since-poll from where it stopped");
      assert.deepEqual(ids(), range(300 - PAGE + 1, 300), "the log is replaced, not added to");
      assert.equal(s.start, false, "and the gap behind it is one 'load earlier' away");
      assert.equal(s.epoch, 1, "the screen is told it is a first read");
    } finally {
      t.reset();
    }
  });

  it("A FOLLOWING READER'S LOG IS BOUNDED — and one reading back is never trimmed", async () => {
    const t = mock.timers;
    t.enable({ apis: ["setTimeout"] });
    try {
      let all = range(1, PAGE).map((id) => msg(id));
      route = serve(() => all);
      open();
      await pollNow();
      all = range(1, KEEP_LINES + 100).map((id) => msg(id));
      for (let i = 0; i < 6; i++) await pollNow();
      let s = storeForTest.get();
      assert.equal(s.messages.length, KEEP_LINES, "an all-day tab does not hold the whole day");
      assert.equal(ids().at(-1), KEEP_LINES + 100, "the newest lines are the ones kept");
      assert.equal(s.start, false, "what was let go is one 'load earlier' away");
      setFollowing(false);
      all = range(1, KEEP_LINES + 160).map((id) => msg(id));
      await pollNow();
      s = storeForTest.get();
      assert.equal(s.messages.length, KEEP_LINES + 60, "nothing is pulled out from under a reader who scrolled up");
    } finally {
      t.reset();
    }
  });

  it("A SUMMARY REWRITTEN WITH ONLY A NEW TIMESTAMP IS NOT NEWS — but the writer going quiet is", async () => {
    // The conductor rewrites `updatedAtMs` every pass; treated as news, every
    // bubble re-rendered every fifteen seconds for nothing a reader could see.
    const t = mock.timers;
    t.enable({ apis: ["setTimeout", "Date"], now: BASE + 1_000 });
    try {
      let room: RoomState = ROOM;
      route = () => json(page([msg(1)], { room }));
      let heard = 0;
      unsubscribe = storeForTest.subscribe(() => heard++);
      await pollNow();
      const drawn = storeForTest.get().room;
      assert.equal(storeForTest.get().roomFresh, true);
      const count = heard;
      room = { ...ROOM, updatedAtMs: BASE + 15_000 };
      t.tick(15_000);
      await pollNow();
      assert.equal(heard, count, "a new timestamp alone notifies nobody");
      assert.equal(storeForTest.get().room, drawn, "the same summary object");
      assert.equal(storeForTest.get().roomFresh, true);
      // Now nobody rewrites it. Nothing else changes, and nothing would
      // re-render — so the clock turning it stale has to be news itself.
      t.tick(ROOM_STALE_MS);
      await pollNow();
      assert.equal(storeForTest.get().roomFresh, false);
      assert.equal(heard, count + 1, "the flip to stale is heard");
      assert.deepEqual(presenceLine(storeForTest.get().room, storeForTest.get().roomFresh), { text: "Presence unavailable", fresh: false });
      room = { ...ROOM, updatedAtMs: Date.now() };
      await pollNow();
      assert.equal(storeForTest.get().roomFresh, true, "and back when the writer is");
    } finally {
      t.reset();
    }
  });
});

describe("lines taken back", () => {
  const own = (id: number, body = `mine ${id}`) => msg(id, { author: "owner", slug: "mine", name: "Robin's owner", body });

  it("A LINE I TOOK BACK STAYS GONE when a poll that read before the hide answers after it", async () => {
    const lines = [msg(10), msg(11), own(12)];
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page(lines)));
    open();
    await pollNow();
    let release!: () => void;
    route = (c) => {
      if (c.method === "DELETE") return json({ hidden: true });
      if (c.url.startsWith("/api/groupchat/me")) return json(ME);
      return new Promise<Response>((r) => (release = () => r(json(page(lines)))));
    };
    const polling = pollNow();
    assert.equal(await hideLine(12), true);
    assert.deepEqual(ids(), [10, 11]);
    release();
    await polling;
    assert.deepEqual(ids(), [10, 11], "the late copy did not put it back");
    route = () => json(page([msg(10), msg(11)]));
    await pollNow();
    assert.deepEqual(ids(), [10, 11], "and it stays gone");
  });

  it("A LINE ITS OWNER TOOK BACK ELSEWHERE LEAVES THIS SCREEN TOO — the poll's `gone` list", async () => {
    // Hidden from another tab or device, or by another owner: without this, a
    // screen that had loaded it kept showing (and offering to quote) it.
    route = () => json(page([msg(1), msg(2), msg(3)]));
    open();
    await pollNow();
    route = () => json(page([msg(1), msg(3)], { gone: [2] }));
    await pollNow();
    assert.deepEqual(ids(), [1, 3]);
    assert.equal(isTakenBack(2), true);
    route = () => json(page([msg(1), msg(2), msg(3)]));
    await pollNow();
    assert.deepEqual(ids(), [1, 3], "a stale copy (a page cached from before the hide) does not bring it back");
  });

  it("an older identical owner line is not my echo — 'gm' said twice is two lines, each with its own key", async () => {
    // The overlap window re-delivers the gm of a minute ago on every poll. It
    // used to swallow the bubble just sent, and then share its key with the
    // real echo for the life of the page.
    const gm = own(50, "gm");
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([msg(49), gm])));
    open();
    await pollNow();
    await pullMe();
    let answer!: (r: Response) => void;
    route = (c) => (c.method === "POST" ? new Promise<Response>((r) => (answer = r)) : json(page([msg(49), gm])));
    const posting = postLine("gm", null);
    const clientId = storeForTest.get().pending[0]!.clientId;
    await pollNow();
    let s = storeForTest.get();
    assert.equal(s.pending.length, 1, "the bubble just sent is still on screen");
    assert.equal(s.keys[50], undefined, "the old gm keeps its own element");
    answer(json({ message: own(60, "gm") }));
    await posting;
    s = storeForTest.get();
    const keys = chatItems(s.messages, s.pending, "mine", s.keys).map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length, "no two rows share a key");
    assert.equal(s.keys[60], clientId);
  });

  it("an echo matched to the wrong line gives its key back when the POST answers", async () => {
    // The same words from the owner's other device, landing while this POST is
    // out, is newer than the cursor and can still be taken for the echo.
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([msg(49)])));
    open();
    await pollNow();
    await pullMe();
    let answer!: (r: Response) => void;
    route = (c) => (c.method === "POST" ? new Promise<Response>((r) => (answer = r)) : json(page([msg(49), own(55, "gm")])));
    const posting = postLine("gm", null);
    const clientId = storeForTest.get().pending[0]!.clientId;
    await pollNow();
    assert.equal(storeForTest.get().keys[55], clientId, "taken for the echo");
    answer(json({ message: own(60, "gm") }));
    await posting;
    const s = storeForTest.get();
    assert.equal(s.keys[60], clientId);
    assert.equal(s.keys[55], undefined, "the other line goes back to its own key");
    const keys = chatItems(s.messages, s.pending, "mine", s.keys).map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("a reply's original", () => {
  it("is loaded, EARLIER (one 'load earlier' away), or gone — and 'earlier' pages back to it", async () => {
    const all = range(1, 200).map((id) => msg(id));
    route = serve(() => all);
    open();
    await pollNow();
    const s = storeForTest.get();
    const byId = new Map(s.messages.map((m) => [m.id, m]));
    const first = s.messages[0]!.id;
    assert.equal(first, 141);
    assert.equal(replyTarget(150, byId, first, s.start), byId.get(150));
    assert.equal(replyTarget(20, byId, first, false), "earlier", "not loaded is not gone");
    assert.equal(replyTarget(20, byId, first, true), null, "older than the room keeps is gone");
    const holed = new Map(byId);
    holed.delete(160);
    assert.equal(replyTarget(160, holed, first, false), null, "missing from inside what is loaded is gone");
    let pages = 0;
    assert.equal(await loadUntil(20, () => pages++), true);
    assert.equal(pages, 3, "81–140, 21–80, then 1–20");
    assert.ok(ids().includes(20));
    assert.equal(await loadUntil(999), false, "an id past what is loaded and not in it is not there");
  });
});

describe("the four answers are kept apart", () => {
  it("404 IS AN INSTALL WITH NO ROOM, and the poll stops for good", async () => {
    route = () => json({ error: "not found" }, 404);
    open();
    await pollNow();
    assert.equal(storeForTest.get().status, "unsupported");
    assert.equal(storeForTest.scheduled(), false);
    const before = calls.length;
    await pollNow();
    assert.equal(calls.length, before, "a self-hosted install is not asked again");
  });

  it("A 5xx IS UNREADABLE, NOT A QUIET ROOM — and so is `source: none`", async () => {
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json({ error: "connect ECONNREFUSED" }, 503));
    open();
    await pollNow();
    assert.equal(storeForTest.get().status, "unreadable");
    route = () => json({ source: "none", messages: [], cursor: 0, room: null });
    await pollNow();
    assert.equal(storeForTest.get().status, "unreadable", "the server saying it could not read is not an empty room");
    route = () => json(page([msg(1)]));
    await pollNow();
    assert.equal(storeForTest.get().status, "ok");
  });

  it("a failure after a good read keeps the room on screen and says it is stale", async () => {
    route = () => json(page([msg(1), msg(2)]));
    open();
    await pollNow();
    route = () => json({}, 502);
    await pollNow();
    const s = storeForTest.get();
    assert.equal(s.status, "ok");
    assert.equal(s.failing, true);
    assert.equal(s.messages.length, 2);
    route = () => json(page([msg(3)]));
    await pollNow();
    assert.equal(storeForTest.get().failing, false, "the next good read takes the warning down");
  });

  it("the entry links' probe hides them on a 404 only", async () => {
    route = () => json({}, 500);
    await storeForTest.probe();
    assert.equal(storeForTest.get().status, "unread", "an outage is not evidence the room does not exist");
    resetGroupChatForTest();
    route = () => json({}, 404);
    await storeForTest.probe();
    assert.equal(storeForTest.get().status, "unsupported");
    assert.equal(calls.at(-1)!.url, "/api/groupchat?limit=1");
  });
});

describe("the cadence", () => {
  it("every 3 s while visible, 15 s while hidden, and nothing once the last reader leaves", async () => {
    const t = mock.timers;
    t.enable({ apis: ["setTimeout"] });
    try {
      pageVisibility("visible");
      route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([msg(1)])));
      open();
      await pollNow();
      const after = () => reads().length;
      const first = after();
      t.tick(VISIBLE_MS - 1);
      assert.equal(after(), first);
      t.tick(1);
      assert.equal(after(), first + 1, "three seconds while somebody is looking");
      pageVisibility("hidden");
      await pollNow();
      t.tick(HIDDEN_MS - 1);
      assert.equal(after(), first + 1);
      t.tick(1);
      assert.equal(after(), first + 2, "fifteen while the tab is hidden");
      await pollNow();
      unsubscribe!();
      unsubscribe = null;
      t.tick(10 * HIDDEN_MS);
      assert.equal(after(), first + 2, "and none at all once the screen is gone");
    } finally {
      t.reset();
    }
  });
});

describe("an owner's line", () => {
  async function member() {
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(ME) : json(page([msg(10)])));
    open();
    await pollNow();
    await pullMe();
  }

  it("IS DRAWN AT ONCE, AND SETTLES ON THE SERVER'S ECHO under the same key", async () => {
    await member();
    let answer!: (r: Response) => void;
    route = (c) => (c.method === "POST" ? new Promise<Response>((r) => (answer = r)) : json(page([])));
    const posting = postLine("  gm room  ", null);
    const pending = storeForTest.get().pending;
    assert.equal(pending.length, 1, "on screen before the server answers");
    assert.equal(pending[0]!.body, "gm room");
    const sent = calls.find((c) => c.method === "POST")!;
    assert.equal(sent.body?.clientId, pending[0]!.clientId);
    assert.equal(sent.body?.body, "gm room");
    assert.ok(!("replyTo" in (sent.body ?? {})), "no reply target is sent as absent, not as null");
    answer(json({ message: msg(11, { author: "owner", slug: "mine", name: "Robin's owner", body: "gm room" }) }));
    const result = await posting;
    assert.equal(result.ok, true);
    const s = storeForTest.get();
    assert.equal(s.pending.length, 0);
    assert.deepEqual(s.messages.map((m) => m.id), [10, 11]);
    assert.equal(s.keys[11], pending[0]!.clientId, "the settled line keeps the element the optimistic one had");
  });

  it("AND IS NOT DRAWN TWICE when the poll brings the echo before the POST answers", async () => {
    await member();
    let answer!: (r: Response) => void;
    const echo = msg(12, { author: "owner", slug: "mine", name: "Robin's owner", body: "hello  there" });
    route = (c) => (c.method === "POST" ? new Promise<Response>((r) => (answer = r)) : json(page([echo])));
    const posting = postLine("hello there", 10);
    const clientId = storeForTest.get().pending[0]!.clientId;
    await pollNow();
    let s = storeForTest.get();
    assert.equal(s.pending.length, 0, "the polled echo replaced the optimistic line");
    assert.equal(s.messages.filter((m) => m.id === 12).length, 1);
    assert.equal(s.keys[12], clientId);
    answer(json({ message: echo }));
    await posting;
    s = storeForTest.get();
    assert.equal(s.messages.filter((m) => m.id === 12).length, 1, "and the POST's answer did not add a second");
    assert.equal(calls.find((c) => c.method === "POST")!.body?.replyTo, 10);
  });

  it("AN ANSWER LOST AFTER THE ROOM TOOK THE LINE is not reported as a failure", async () => {
    // The poll already showed the line; "wasn't sent" plus the draft back
    // would have had the owner post it twice.
    await member();
    let drop!: () => void;
    const echo = msg(12, { author: "owner", slug: "mine", name: "Robin's owner", body: "hello there" });
    route = (c) => (c.method === "POST" ? new Promise<Response>((_, reject) => (drop = () => reject(new TypeError("network")))) : json(page([echo])));
    const posting = postLine("hello there", null);
    await pollNow();
    drop();
    const result = await posting;
    assert.equal(result.ok, true);
    assert.equal(storeForTest.get().messages.filter((m) => m.id === 12).length, 1);
  });

  it("silence with no echo is said as unconfirmed, not as 'wasn't sent'", async () => {
    await member();
    route = (c) => (c.method === "POST" ? Promise.reject(new TypeError("network")) : json(page([])));
    const result = await postLine("anyone here", null);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /couldn't confirm/);
    assert.doesNotMatch(!result.ok ? result.error : "", /wasn't sent/);
    assert.equal(storeForTest.get().pending.length, 0);
  });

  it("/me IS RE-ASKED EVERY TIME THE SCREEN OPENS — sign-in happens in the page, with no reload", async () => {
    let answer: Record<string, unknown> = { ...ME, signedIn: false, member: false, slug: null, name: null };
    route = (c) => (c.url.startsWith("/api/groupchat/me") ? json(answer) : json(page([])));
    open();
    await pollNow();
    await pullMe();
    assert.equal(storeForTest.get().me?.signedIn, false);
    unsubscribe!();
    unsubscribe = null;
    answer = ME;
    open();
    await pullMe();
    assert.equal(storeForTest.get().me?.member, true, "the signed-out answer from a moment ago was not reused");
  });

  it("an owner's settings answered elsewhere on the page are taken — a signed-out one is not", () => {
    noteMe({ ...ME, tz: "Asia/Tokyo" });
    assert.equal(storeForTest.get().me?.tz, "Asia/Tokyo");
    noteMe({ signedIn: false, member: false });
    assert.equal(storeForTest.get().me?.tz, "Asia/Tokyo");
    noteMe("nonsense");
    assert.equal(storeForTest.get().meState, "ok");
  });

  it("a refusal takes the line back down and says the server's words", async () => {
    await member();
    route = (c) => (c.method === "POST" ? json({ error: "Links aren't allowed in the room." }, 400) : json(page([])));
    const result = await postLine("see example.com", null);
    assert.deepEqual(result, { ok: false, error: "Links aren't allowed in the room." });
    assert.equal(storeForTest.get().pending.length, 0, "no bubble for a message nobody else can see");
  });

  it("the refusal words: the server's for a 4xx, ours for a 5xx or silence", () => {
    assert.equal(postError(429, {}), "Slow down a little — try again in a minute.");
    assert.equal(postError(429, { error: "Easy — six a minute." }), "Easy — six a minute.");
    assert.equal(postError(401, null), "Sign in again to post.");
    assert.equal(postError(403, null), "Only owners with a Merryman can post.");
    assert.doesNotMatch(postError(500, { error: "connect ECONNREFUSED 127.0.0.1:5432" }), /ECONNREFUSED/, "a driver's error never reaches an owner");
    assert.match(postError(0, null), /Can't reach/);
  });

  it("THE COMPOSER'S CEILING IS THE GATE'S — a copy, so it is pinned to the original", () => {
    // Read as text rather than imported: the policy module pulls in the social
    // gate, which the browser bundle has no business carrying for one number.
    const policy = readFileSync(new URL("../../../worker/src/groupchat/policy.ts", import.meta.url), "utf8");
    const max = policy.match(/export const OWNER_LINE_MAX\s*=\s*(\d+)/);
    assert.ok(max, "policy.ts no longer exports OWNER_LINE_MAX as a literal");
    assert.equal(COMPOSER_MAX, Number(max[1]));
  });

  it("nothing is sent for an empty or over-long line", async () => {
    await member();
    const before = calls.length;
    assert.equal((await postLine("   ", null)).ok, false);
    assert.equal((await postLine("x".repeat(501), null)).ok, false);
    assert.equal(calls.length, before);
  });
});

describe("drawing the log", () => {
  it("runs, day separators, system lines — and only an owner line of MY slug is mine", () => {
    const day1 = BASE;
    const lines: PublicMessage[] = [
      msg(1, { at: day1, slug: "a", name: "A" }),
      msg(2, { at: day1 + 60_000, slug: "a", name: "A" }),
      msg(3, { at: day1 + 120_000, author: "system", slug: null, name: "room", kind: "join" }),
      msg(4, { at: day1 + 180_000, slug: "a", name: "A" }),
      msg(5, { at: day1 + 190_000, author: "agent", slug: "mine", name: "Robin" }),
      msg(6, { at: day1 + 200_000, author: "owner", slug: "mine", name: "Robin's owner" }),
      msg(7, { at: day1 + 86_400_000 * 2, slug: "a", name: "A" }),
    ];
    const items = chatItems(lines, [{ clientId: "c1", body: "hi", replyTo: null, at: day1 + 86_400_000 * 2 + 1, after: 7 }], "mine", {});
    const shape = items.map((i) => (i.type === "line" ? `${i.message.id}${i.first ? "F" : ""}${i.last ? "L" : ""}${i.mine ? "M" : ""}${i.pending ? "P" : ""}` : i.type));
    assert.deepEqual(shape, ["day", "1F", "2L", "system", "4FL", "5FL", "6FLM", "day", "7FL", "-1FLMP"]);
    assert.equal(isMine({ author: "agent", slug: "mine" }, "mine"), false, "my agent's words are not mine");
    assert.equal(isMine({ author: "owner", slug: "mine" }, null), false);
    const labelled = labelDays(items, day1 + 86_400_000 * 2 + 5_000);
    const today = labelled.filter((i) => i.type === "day").map((i) => (i.type === "day" ? i.label : ""));
    assert.equal(today[1], "Today");
  });

  it("@mentions of known speakers only, longest name first, as plain text parts", () => {
    const parts = mentionParts("gm @Robin Hood and @robin, not @nobody or me@Robin", ["Robin", "Robin Hood"]);
    assert.deepEqual(
      parts.filter((p) => p.mention).map((p) => [p.text, p.mention]),
      [["@Robin Hood", "Robin Hood"], ["@robin", "Robin"]],
      "an address-shaped me@Robin is not a mention",
    );
    assert.equal(parts.map((p) => p.text).join(""), "gm @Robin Hood and @robin, not @nobody or me@Robin", "nothing lost or added");
    assert.deepEqual(mentionParts("no names here", []), [{ text: "no names here", mention: null }]);
    assert.equal(mentionParts("@Robinson", ["Robin"]).some((p) => p.mention), false, "a longer word is not the name");
  });

  it("MY OWN LINES ARE ONE RUN WHATEVER THEY ARE CALLED — a line still sending joins the one before it", () => {
    // Drawn as "You" while sending and "<agent>'s owner" once settled; a run
    // broken by the name alone jumped the owner's own bubbles twice per send.
    const said = msg(1, { at: BASE, author: "owner", slug: "mine", name: "Robin's owner" });
    const items = chatItems([said], [{ clientId: "c1", body: "and another", replyTo: null, at: BASE + 20_000, after: 1 }], "mine", {});
    const shape = items.map((i) => (i.type === "line" ? `${i.message.id}${i.first ? "F" : ""}${i.last ? "L" : ""}` : i.type));
    assert.deepEqual(shape, ["day", "1F", "-1L"]);
    const other = chatItems([msg(1, { at: BASE, name: "A" }), msg(2, { at: BASE + 1, slug: "a1", name: "B" })], [], "mine", {});
    assert.equal(other.filter((i) => i.type === "line" && i.first).length, 2, "somebody else's name still starts a run");
  });

  it("DAY SEPARATORS NEVER SHARE A KEY, even when stamps go back and forth across midnight", () => {
    // A pass stamps its lines when it starts and inserts them after its model
    // calls, so a web line in between has a lower id and a later stamp.
    const midnight = new Date(2026, 8, 24, 0, 0, 0).getTime();
    const lines = [msg(1, { at: midnight - 5_000 }), msg(2, { at: midnight + 5_000 }), msg(3, { at: midnight - 2_000 }), msg(4, { at: midnight + 9_000 })];
    const keys = chatItems(lines, [], null, {}).map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length, keys.join(" "));
  });

  it("presence is said only while the summary is fresh", () => {
    assert.equal(presenceLine(ROOM, true)?.text, "2 awake · 1 asleep");
    assert.equal(presenceLine({ ...ROOM, asleep: 0 }, true)?.text, "2 awake");
    assert.deepEqual(presenceLine(ROOM, false), { text: "Presence unavailable", fresh: false });
    assert.equal(presenceLine(null, true), null);
    assert.equal(roomIsFresh(ROOM, BASE, BASE + 1000), true);
    assert.equal(roomIsFresh(ROOM, BASE, BASE + ROOM_STALE_MS + 1), false);
    assert.equal(roomIsFresh(null, BASE, BASE), false);
  });

  it("new lines are announced one by one, or as a count when many land at once", () => {
    const call = msg(3, { name: "Shogun", body: "aped", kind: "call", call: { side: "buy", symbol: "PEPE", name: "Pepe", token: null, paper: true } });
    assert.deepEqual(announcements([call]), ["Shogun (bought Pepe, paper trade): aped"]);
    assert.deepEqual(announcements([msg(4, { author: "system", body: "Robin joined the group chat" })]), ["Robin joined the group chat"]);
    assert.deepEqual(announcements(range(1, ANNOUNCE_MAX + 1).map((id) => msg(id))), [`${ANNOUNCE_MAX + 1} new messages`]);
    assert.deepEqual(announcements([]), []);
  });

  it("an excerpt is one line and ends in an ellipsis when cut", () => {
    assert.equal(excerpt("a\n\nb   c"), "a b c");
    assert.equal(excerpt("x".repeat(100), 10), `${"x".repeat(9)}…`);
  });
});
