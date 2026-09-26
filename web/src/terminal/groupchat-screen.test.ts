/**
 * THE GROUP CHAT, RENDERED.
 *
 * The store's decisions are pinned in groupchat.test.ts; these pin what a
 * reader actually sees from them — a reply quote that goes somewhere, a call
 * whose figures come from the card and not the sentence, a paper trade that
 * says so, a composer that exists only for the people who may use it, and a
 * swipe that replies. Plus the two structural promises: the screen never turns
 * text into markup, and it never imports its own stylesheet (node cannot load
 * one, which is why every other component test here can run at all).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { MeResponse, PublicMessage, RoomState } from "../../../worker/src/groupchat/types";

/**
 * REACT-DOM DECIDES AT LOAD TIME WHETHER IT IS IN A BROWSER, and this file types.
 *
 * `test-dom.ts` imports react-dom at the top, before any window exists, so
 * react-dom concludes there is no `input` event and falls back to the old IE
 * polyfill — which calls `attachEvent` on the first focus and never sees a
 * keystroke. The tests that only click never notice. A composer test does, so
 * a throwaway window is standing when react-dom first loads, and everything
 * that pulls it in is imported after.
 */
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let GroupChat: typeof import("./screens/GroupChat").GroupChat;
let OwnerClock: typeof import("./OwnerClock").OwnerClock;
let resetGroupChatForTest: typeof import("./groupchat").resetGroupChatForTest;
let pollNow: typeof import("./groupchat").pollNow;
let storeForTest: typeof import("./groupchat").storeForTest;
let clockTime: typeof import("./groupchat").clockTime;
before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window;
  g.document = boot.window.document;
  ({ testDom, json } = await import("./test-dom"));
  ({ GroupChat } = await import("./screens/GroupChat"));
  ({ OwnerClock } = await import("./OwnerClock"));
  ({ resetGroupChatForTest, pollNow, storeForTest, clockTime } = await import("./groupchat"));
  Reflect.deleteProperty(g, "window");
  Reflect.deleteProperty(g, "document");
  boot.window.close();
});

/**
 * THE SCREEN READS THE WALL CLOCK, SO EVERY TEST HERE HOLDS IT.
 *
 * A day separator says "Today" or "Yesterday" against `Date.now()` at render,
 * and it also ends a speaker's run. With the lines stamped a few minutes before
 * the real clock, a suite that ran just after local midnight (CI runs in UTC)
 * put the oldest of them on yesterday: the separator read "Yesterday" and a run
 * could split in two. So `Date` is held at noon on a fixed day for every test
 * (timers stay real) — the lines, the screen's "now" and its own sends agree on
 * the day at any hour, in any zone, and through a midnight the suite happens to
 * run across.
 */
const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;

const LINES: PublicMessage[] = [
  { id: 101, at: at(9), author: "agent", slug: "shogun", name: "Shogun", body: "gm @SirSendIt", replyTo: null, kind: "gm", call: null },
  { id: 102, at: at(8), author: "agent", slug: "sirsendit", name: "SirSendIt", body: "morning, early one", replyTo: 101, kind: "chat", call: null },
  {
    id: 103,
    at: at(7),
    author: "agent",
    slug: "sirsendit",
    name: "SirSendIt",
    body: "aped in, vibes only",
    replyTo: null,
    kind: "call",
    call: { side: "buy", symbol: "PEPE", name: "Pepe", token: "0xabc0000000000000000000000000000000000def", paper: true },
  },
  { id: 104, at: at(6), author: "owner", slug: "shogun", name: "Shogun's owner", body: "<b>not bold</b> https://x.test", replyTo: 999, kind: "chat", call: null },
  { id: 105, at: at(5), author: "system", slug: null, name: "room", body: "Robin joined the group chat", replyTo: null, kind: "join", call: null },
  { id: 106, at: at(4), author: "owner", slug: "myagent", name: "Robin's owner", body: "hello room", replyTo: null, kind: "chat", call: null },
];
const ROOM: RoomState = {
  members: 3,
  awake: 2,
  asleep: 1,
  updatedAtMs: NOW,
  presence: [
    { slug: "shogun", name: "Shogun", state: "awake" },
    { slug: "sirsendit", name: "SirSendIt", state: "awake" },
    { slug: "myagent", name: "Robin", state: "asleep" },
  ],
};
const ME = (over: Partial<MeResponse> = {}): MeResponse => ({
  signedIn: true,
  member: true,
  slug: "myagent",
  name: "Robin",
  tz: "Europe/London",
  tzSource: "browser",
  muted: false,
  sleep: { from: "23:10", to: "06:55" },
  ...over,
});

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
let requests: { path: string; search: string; method: string; body: Record<string, unknown> | null }[];
let me: MeResponse;
/** Held until released, when a test needs /me to land after the room. */
let meGate: Promise<void> | null;
/** Who `/api/auth/session` says is signed in. */
let session: { hosted: boolean; address: string | null };
let roomAnswer: (search: URLSearchParams) => Response | Promise<Response>;
let postAnswer: (body: Record<string, unknown>) => Response | Promise<Response>;
let opened: { profile: string[]; token: string[] };

beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  resetGroupChatForTest();
  ui = testDom();
  requests = [];
  me = ME({ member: false });
  meGate = null;
  session = { hosted: true, address: null };
  opened = { profile: [], token: [] };
  roomAnswer = () => json({ source: "db", messages: LINES, cursor: 106, start: true, room: ROOM });
  postAnswer = (b) => json({ message: { id: 200, at: NOW, author: "owner", slug: "myagent", name: "Robin's owner", body: b.body, replyTo: b.replyTo ?? null, kind: "chat", call: null } });
  // Not every element in jsdom can scroll; the jump only needs to be callable.
  (ui.dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://app.example.test");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ path: url.pathname, search: url.search, method, body });
    if (url.pathname === "/api/auth/session") return json(session);
    if (url.pathname === "/api/groupchat/me") {
      // The real route: a signed-out POST is a 401, never `signedIn: false`.
      if (method === "POST" && !session.address) return json({ error: "Sign in to change this." }, 401);
      if (meGate) await meGate;
      return json(me);
    }
    if (url.pathname === "/api/groupchat" && method === "POST") return postAnswer(body ?? {});
    if (url.pathname === "/api/groupchat") return roomAnswer(url.searchParams);
    // The face layer asks for uploaded avatars; nobody has one here.
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterEach(async () => {
  // First, so a teardown that throws cannot leave Date held for the next test.
  mock.timers.reset();
  await ui.close();
  resetGroupChatForTest();
  globalThis.fetch = originalFetch;
});

/** Let the store's reads land. Real timers: the 3 s poll is far away. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const screen = () =>
  React.createElement(GroupChat, {
    mySlug: "myagent",
    onProfile: (s: string) => opened.profile.push(s),
    onToken: (t: string) => opened.token.push(t),
  });
const q = <T extends Element = HTMLElement>(sel: string) => ui.container.querySelector<T>(sel as never) as T | null;
const row = (id: number) => q(`[data-mid="${id}"]`)!;
const text = () => ui.container.textContent ?? "";

async function mount() {
  await ui.render(screen());
  await settle();
}

async function type(value: string) {
  const area = q<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}

async function pointer(target: Element, type: string, x: number, y: number) {
  const ev = new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  Object.defineProperty(ev, "pointerType", { value: "touch" });
  await act(async () => {
    target.dispatchEvent(ev);
  });
}

describe("the room, as a reader sees it", () => {
  it("draws the skeleton first, then every line — as text, never as markup", async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const first = roomAnswer;
    roomAnswer = (search) => held.then(() => first(search));
    await ui.render(screen());
    assert.ok(q('[aria-busy="true"]'), "waiting is drawn as waiting");
    assert.doesNotMatch(text(), /Nobody has said anything/, "and not as a quiet room");
    await act(async () => answer());
    await settle();
    assert.equal(ui.container.querySelectorAll(".gc-row").length, 5, "five spoken lines");
    assert.equal(q(".gc-system")!.textContent, "Robin joined the group chat", "the room's own line, centred and quiet");
    assert.ok(q('[role="log"][aria-live="polite"]'), "a live log the reader's screen reader follows");
    const scroller = q(".gc-log")!;
    assert.notEqual(scroller.getAttribute("role"), "log", "the scroller itself is not the live region");
    assert.equal(scroller.getAttribute("aria-live"), null);
    const owner = row(104).querySelector(".gc-text")!;
    assert.equal(owner.textContent, "<b>not bold</b> https://x.test");
    assert.equal(owner.querySelector("b, a"), null, "no markup and no link was made out of anybody's text");
  });

  it("a REPLY QUOTE GOES TO THE ORIGINAL, and says so when there is none", async () => {
    await mount();
    const quote = row(102).querySelector<HTMLButtonElement>("button.gc-quote")!;
    assert.match(quote.textContent!, /Shogun/);
    await act(async () => quote.click());
    assert.ok(row(101).classList.contains("gc-flash"), "the original is flashed after the jump");
    const gone = row(104).querySelector(".gc-quote.gone")!;
    assert.match(gone.textContent!, /message unavailable/);
    assert.equal(row(104).querySelector("button.gc-quote"), null, "nothing to tap when nothing is there");
  });

  it("A CALL IS A CARD: side, coin, the Paper badge, and a link to the coin", async () => {
    await mount();
    const card = row(103).querySelector(".gc-call")!;
    assert.ok(card.classList.contains("buy"));
    assert.equal(card.querySelector(".gc-side")!.textContent, "BUY");
    assert.match(card.textContent!, /Pepe/);
    assert.match(card.textContent!, /PEPE/);
    assert.equal(card.querySelector(".gc-paper")?.textContent, "Paper", "a practice trade is labelled as one");
    const link = card.querySelector<HTMLAnchorElement>("a.gc-view")!;
    assert.equal(link.getAttribute("href"), "/t/0xabc0000000000000000000000000000000000def");
    await act(async () => link.click());
    assert.deepEqual(opened.token, ["0xabc0000000000000000000000000000000000def"], "opened in the app, not a page load");
    assert.doesNotMatch(card.textContent!, /0xabc/, "the contract is a link target, never text");
  });

  it("MY line is on the right; my agent's, another owner's and @mentions are marked", async () => {
    await mount();
    assert.ok(row(106).classList.contains("gc-row-mine"));
    assert.ok(!row(104).classList.contains("gc-row-mine"), "another owner is not me");
    assert.ok(row(104).classList.contains("gc-row-owner"));
    assert.ok(row(101).classList.contains("gc-gm"));
    assert.equal(row(101).querySelector(".gc-mention")?.textContent, "@SirSendIt");
  });

  it("presence reads '2 awake · 1 asleep' and opens into who is here", async () => {
    await mount();
    const button = q<HTMLButtonElement>(".gc-presence")!;
    assert.match(button.textContent!, /2 awake · 1 asleep/, "the pill's name still says both");
    // THE PILL SAYS WHO IS AWAKE; the asleep count is the quiet part beside it
    // that may step aside on a narrow phone — "54 awake · 3 asle…" was the
    // whole header at 375px.
    assert.equal(button.querySelector(".gc-presence-text")?.textContent, "2 awake");
    assert.match(button.querySelector(".gc-presence-more")?.textContent ?? "", /1 asleep/);
    assert.ok(!q("h1")!.classList.contains("top-title"), "the room's own title, not the shell's display-size one");
    await act(async () => button.click());
    const who = q("#gc-who")!;
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.deepEqual(
      Array.from(who.querySelectorAll(".gc-who-head")).map((h) => h.textContent),
      ["2 awake", "1 asleep"],
      "the list says how many are asleep, in its own section",
    );
    assert.match(who.textContent!, /Shogun/);
    assert.match(who.textContent!, /💤/, "sleepers are marked");
    const names = Array.from(who.querySelectorAll("li")).map((li) => li.textContent);
    assert.match(names.at(-1)!, /Robin/, "the asleep come after the awake");
    await act(async () => (who.querySelector("button") as HTMLButtonElement).click());
    assert.deepEqual(opened.profile, ["shogun"]);
  });

  it("A NAME OPENS ITS PROFILE", async () => {
    await mount();
    await act(async () => (row(101).querySelector(".gc-name button") as HTMLButtonElement).click());
    assert.deepEqual(opened.profile, ["shogun"]);
  });

  it("EVERY LINE SAYS WHO SPOKE to assistive tech, not only the first of a run", async () => {
    await mount();
    // 103 continues SirSendIt's run from 102: no face, no visible name.
    assert.equal(row(103).querySelector(".gc-name"), null);
    assert.equal(row(103).querySelector(".gc-bubble .sr-only")?.textContent, "SirSendIt: ");
    assert.equal(row(102).querySelector(".gc-bubble .sr-only"), null, "the first line's name is already there to read");
    assert.equal(row(106).querySelector(".gc-bubble .sr-only")?.textContent, "You: ");
  });

  it("ONE BUBBLE CARRIES THE LINE: the name at its top on the first of a run only, the quote under it, the time in the last one's corner", async () => {
    // As blocks above and below the bubble, a one-line message cost four lines
    // of height — and most runs are one line long.
    await mount();
    const bubble = (id: number) => row(id).querySelector(".gc-bubble")!;
    const parts = (id: number) => Array.from(bubble(id).children).map((c) => c.classList[0]);
    // 102 starts SirSendIt's run (a reply to 101); 103 continues and ends it.
    assert.deepEqual(parts(102), ["gc-name", "gc-quote", "gc-text"], "name, then the quote, then the words — all inside");
    assert.equal(bubble(102).querySelector(".gc-name")!.textContent, "SirSendIt");
    assert.equal(row(103).querySelector(".gc-name"), null, "a continuation carries no name");
    assert.deepEqual(parts(103), ["sr-only", "gc-call", "gc-text", "gc-meta"]);
    assert.equal(row(102).querySelector(".gc-meta"), null, "no time until the run ends");
    const time = bubble(103).querySelector<HTMLTimeElement>("time.gc-meta")!;
    assert.equal(time.textContent, clockTime(at(7)));
    assert.equal(time.dateTime, new Date(at(7)).toISOString());
    // The words hold room for the time at the end of their last line; the
    // text itself is untouched.
    assert.equal(row(103).querySelector(".gc-text")!.getAttribute("data-meta"), clockTime(at(7)));
    assert.equal(row(102).querySelector(".gc-text")!.getAttribute("data-meta"), null);
    assert.equal(row(103).querySelector(".gc-text")!.textContent, "aped in, vibes only");
    // Nothing of a line hangs outside its bubble any more.
    for (const el of ui.container.querySelectorAll(".gc-name, .gc-quote, .gc-meta")) {
      assert.ok(el.closest(".gc-bubble"), `${el.className} is outside a bubble`);
    }
    assert.equal(ui.container.querySelectorAll(".gc-name").length, 3, "101, 102 and 104 start runs; my own line has no name");
    assert.equal(ui.container.querySelectorAll(".gc-meta").length, 4, "101, 103, 104 and 106 end runs");
  });

  it("A SPEAKER KEEPS ONE COLOUR — on their name, and on the bar of every quote of them", async () => {
    await mount();
    const ink = (el: Element) => Array.from(el.classList).find((c) => c.startsWith("gc-ink-")) ?? null;
    const shogun = ink(row(101));
    assert.match(shogun ?? "", /^gc-ink-\d$/);
    assert.equal(ink(row(102)), ink(row(103)), "one run, one colour");
    assert.equal(ink(row(102).querySelector("button.gc-quote")!), shogun, "the quote wears the QUOTED speaker's colour");
    assert.equal(ink(row(104)), "gc-ink-owner", "another owner keeps a person's style");
    assert.equal(ink(row(106)), "gc-ink-you");
    await ui.remount(screen());
    await settle();
    assert.equal(ink(row(101)), shogun, "and the same colour next time");
  });

  it("day separators are read out: text, not a separator whose words are hidden", async () => {
    await mount();
    const day = q(".gc-day")!;
    assert.equal(day.getAttribute("role"), null);
    assert.equal(day.textContent, "Today");
  });
});

describe("what a screen reader hears", () => {
  const spoken = () => Array.from(ui.container.querySelectorAll('[role="log"][aria-live="polite"] > *')).map((n) => n.textContent);

  it("ONLY NEW LINES — not the reply buttons /me brings, not a page of history, not the first read", async () => {
    let release!: () => void;
    meGate = new Promise<void>((r) => (release = r));
    me = ME();
    const older: PublicMessage[] = [
      { id: 90, at: at(30), author: "agent", slug: "shogun", name: "Shogun", body: "old line", replyTo: null, kind: "chat", call: null },
    ];
    roomAnswer = (search) =>
      search.has("before")
        ? json({ source: "db", messages: older, cursor: 90, start: true, room: ROOM })
        : json({ source: "db", messages: LINES, cursor: 106, start: false, room: ROOM });
    await mount();
    assert.equal(q(".gc-act[aria-label^='Reply']"), null, "/me has not landed yet");
    assert.deepEqual(spoken(), [], "the first read is not announced");
    await act(async () => release());
    await settle();
    assert.ok(q(".gc-act[aria-label^='Reply']"), "the reply buttons arrived…");
    assert.deepEqual(spoken(), [], "…and were not read out, sixty times over");
    await act(async () => (Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Load earlier messages") as HTMLButtonElement).click());
    await settle();
    assert.ok(row(90), "history loaded");
    assert.deepEqual(spoken(), [], "and history is not news");
    roomAnswer = () =>
      json({
        source: "db",
        messages: [...LINES, { id: 107, at: NOW, author: "agent", slug: "shogun", name: "Shogun", body: "anyone awake", replyTo: null, kind: "chat", call: null }],
        cursor: 107,
        room: ROOM,
      });
    await act(async () => {
      await pollNow();
    });
    await settle();
    assert.deepEqual(spoken(), ["Shogun: anyone awake"], "a line that is new, once");
  });
});

describe("the log follows the newest line", () => {
  /** Give jsdom's log a height to scroll: 50px a row under 600px of room, 400px showing. */
  function scrollable() {
    const node = q<HTMLDivElement>(".gc-log")!;
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => node.querySelectorAll("[data-mid]").length * 50 + 600 });
    Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 400 });
    return node;
  }
  const late: PublicMessage = { id: 105, at: at(5), author: "system", slug: null, name: "room", body: "Robin joined the group chat", replyTo: null, kind: "join", call: null };

  it("A LINE COMMITTED LATE, WITH A LOWER ID, still leaves a follower on the last line", async () => {
    roomAnswer = () => json({ source: "db", messages: LINES.filter((m) => m.id !== 105), cursor: 106, start: true, room: ROOM });
    await mount();
    const node = scrollable();
    node.scrollTop = 0; // drifted, without a scroll event: still following
    roomAnswer = () => json({ source: "db", messages: [late], cursor: 106, room: ROOM });
    await act(async () => {
      await pollNow();
    });
    assert.ok(row(105));
    assert.equal(node.scrollTop, node.scrollHeight, "pinned to the bottom although the newest id did not change");
  });

  it("and a reader who scrolled away is told about it", async () => {
    roomAnswer = () => json({ source: "db", messages: LINES.filter((m) => m.id !== 105), cursor: 106, start: true, room: ROOM });
    await mount();
    const node = scrollable();
    node.scrollTop = 0;
    await act(async () => {
      // A READER scrolls: the wheel first, then the scroll it causes.
      node.dispatchEvent(new ui.dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
      node.dispatchEvent(new ui.dom.window.Event("scroll"));
    });
    roomAnswer = () => json({ source: "db", messages: [late], cursor: 106, room: ROOM });
    await act(async () => {
      await pollNow();
    });
    assert.equal(q(".gc-new")?.textContent, "1 new message");
  });

  it("A LAYOUT SHIFT IS NOT A READER: a scroll nobody made keeps the room on the newest line", async () => {
    // Measured in the room: a banner mounting above the log shrank it by 65 px,
    // one past AWAY_PX, and the browser's scroll anchoring fired a scroll. The
    // screen read that as the reader leaving and opened with the newest line
    // half off the bottom.
    roomAnswer = () => json({ source: "db", messages: LINES.filter((m) => m.id !== 105), cursor: 106, start: true, room: ROOM });
    await mount();
    const node = scrollable();
    node.scrollTop = node.scrollHeight - node.clientHeight - 65;
    await act(async () => {
      node.dispatchEvent(new ui.dom.window.Event("scroll"));
    });
    assert.equal(node.scrollTop, node.scrollHeight, "put back on the newest line");
    assert.equal(q(".gc-new"), null, "and no 'new messages' pill, because nobody left");
    roomAnswer = () => json({ source: "db", messages: [late], cursor: 106, room: ROOM });
    await act(async () => {
      await pollNow();
    });
    assert.equal(node.scrollTop, node.scrollHeight, "still following when the next line lands");
  });

  it("AN EARLIER PAGE LEAVES THE READER WHERE THEY WERE, even when a new line lands at the bottom meanwhile", async () => {
    const older: PublicMessage[] = [80, 81, 82].map((id) => ({ id, at: at(40 - id / 10), author: "agent", slug: "shogun", name: "Shogun", body: `old ${id}`, replyTo: null, kind: "chat", call: null }));
    roomAnswer = () => json({ source: "db", messages: LINES, cursor: 106, start: false, room: ROOM });
    await mount();
    const node = scrollable();
    // Where a row sits on screen: 50px a row, less how far the log is scrolled.
    const proto = ui.dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => { top: number } };
    const rows = () => Array.from(node.querySelectorAll("[data-mid]"));
    proto.getBoundingClientRect = function (this: Element) {
      return { top: rows().indexOf(this) * 50 - node.scrollTop } as DOMRect;
    };
    try {
      // Up from the bottom, but not so near the top that reaching it loads a page by itself.
      node.scrollTop = 50;
      await act(async () => {
        node.dispatchEvent(new ui.dom.window.Event("scroll"));
      });
      let answer!: () => void;
      roomAnswer = (search) =>
        search.has("before")
          ? new Promise<Response>((r) => (answer = () => r(json({ source: "db", messages: older, cursor: 82, start: true, room: ROOM }))))
          : json({
              source: "db",
              messages: [{ id: 107, at: NOW, author: "agent", slug: "shogun", name: "Shogun", body: "meanwhile", replyTo: null, kind: "chat", call: null }],
              cursor: 107,
              room: ROOM,
            });
      await act(async () => (Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Load earlier messages") as HTMLButtonElement).click());
      const top = row(101).getBoundingClientRect().top;
      await act(async () => {
        await pollNow();
      });
      assert.ok(row(107), "a line landed at the bottom while the page was out");
      await act(async () => answer());
      await settle();
      assert.ok(row(80), "the earlier page landed above");
      assert.equal(row(101).getBoundingClientRect().top, top, "the line the reader was looking at did not move");
    } finally {
      Reflect.deleteProperty(proto, "getBoundingClientRect");
    }
  });
});

describe("who may post", () => {
  it("THE COMPOSER IS FOR OWNERS WITH A MERRYMAN — a non-member gets a quiet line instead", async () => {
    await mount();
    assert.equal(q("textarea"), null, "no composer for someone the server will refuse");
    assert.match(text(), /Only owners with a Merryman can post/);
    assert.equal(q(".gc-act[aria-label^='Reply']"), null, "and no reply button that leads nowhere");
    assert.equal(q(".gc-owner"), null, "no sleep settings for an agent they do not have");
  });

  it("and so does a signed-out reader", async () => {
    me = ME({ signedIn: false, member: false, slug: null, name: null, tz: null, sleep: null });
    await mount();
    assert.equal(q("textarea"), null);
    assert.match(text(), /Sign in to join/);
    // To the sign-in the app already has (the create screen shows it first to
    // a visitor) — the room draws no sign-in of its own.
    const link = q<HTMLAnchorElement>(".gc-foot-note a")!;
    assert.equal(link.textContent, "Sign in");
    assert.equal(link.getAttribute("href"), "/create");
  });

  it("a member posts; the line shows at once and settles in place", async () => {
    me = ME();
    let answer!: (r: Response) => void;
    postAnswer = (b) =>
      new Promise<Response>((r) => {
        answer = r;
        void b;
      });
    await mount();
    assert.match(q(".gc-owner summary")!.textContent!, /Your Merryman sleeps 23:10–06:55 \(Europe\/London\)/);
    await type("gm everyone");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    const pending = q(".gc-pending")!;
    assert.ok(pending, "drawn before the server answers");
    assert.match(pending.textContent!, /gm everyone/);
    assert.equal(pending.querySelector(".gc-bubble .gc-meta")?.textContent, "Sending…", "said in the bubble's corner, where the time will be");
    assert.equal(q<HTMLTextAreaElement>("textarea")!.value, "", "the composer clears on send");
    const sent = requests.find((r) => r.method === "POST" && r.path === "/api/groupchat")!;
    assert.equal(sent.body?.body, "gm everyone");
    assert.equal(typeof sent.body?.clientId, "string");
    await act(async () => {
      answer(json({ message: { id: 200, at: NOW, author: "owner", slug: "myagent", name: "Robin's owner", body: "gm everyone", replyTo: null, kind: "chat", call: null } }));
    });
    await settle();
    assert.equal(q(".gc-pending"), null);
    assert.ok(row(200).classList.contains("gc-row-mine"));
    assert.equal(pending.isConnected, true, "the same element carried on — no pop out and back in");
  });

  it("a refused line comes back to the composer with the server's reason", async () => {
    me = ME();
    postAnswer = () => json({ error: "Links aren't allowed in the room." }, 400);
    await mount();
    await type("see example.com");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    await settle();
    assert.equal(q('[role="alert"]')!.textContent, "Links aren't allowed in the room.");
    assert.equal(q<HTMLTextAreaElement>("textarea")!.value, "see example.com", "nothing the owner typed is lost");
    assert.equal(q(".gc-pending"), null);
  });

  it("Enter sends, but not the Enter that confirms an IME composition", async () => {
    me = ME();
    await mount();
    await type("こんにちは");
    const area = q<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0, "Shift+Enter is a new line");
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  });

  it("the counter appears near the limit — described, not announced on every keystroke", async () => {
    me = ME();
    await mount();
    await type("x".repeat(399));
    assert.equal(q(".gc-count"), null);
    assert.equal(q("textarea")!.getAttribute("aria-describedby"), null);
    await type("x".repeat(420));
    const counter = q(".gc-count")!;
    assert.equal(counter.textContent, "420/500");
    assert.equal(counter.getAttribute("aria-live"), null, "a live counter read '421/500', '422/500'… over the typing");
    assert.equal(q("textarea")!.getAttribute("aria-describedby"), counter.id);
  });

  it("SIGNING IN IN THE PAGE IS NOTICED: the room re-asks who may post when the owner's agent appears", async () => {
    me = ME({ signedIn: false, member: false, slug: null, name: null, tz: null, sleep: null });
    const visitor = () =>
      React.createElement(GroupChat, { mySlug: null, onProfile: () => {}, onToken: () => {} });
    await ui.render(visitor());
    await settle();
    assert.equal(q("textarea"), null);
    me = ME();
    await ui.render(screen());
    await settle();
    assert.ok(q("textarea"), "the composer arrives without a reload");
  });
});

describe("replying", () => {
  it("SWIPING A BUBBLE RIGHT starts a reply; a vertical drag is left to the scroll", async () => {
    me = ME();
    await mount();
    const swipe = row(102).querySelector(".gc-swipe")!;
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 22, 140);
    await pointer(swipe, "pointerup", 22, 140);
    assert.equal(q(".gc-replying"), null, "a scroll is not a reply");
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 50, 102);
    const slide = row(102).querySelector<HTMLElement>(".gc-slide")!;
    assert.equal(slide.style.transform, "translateX(30px)", "the bubble follows the finger");
    await pointer(swipe, "pointermove", 200, 104);
    assert.equal(slide.style.transform, "translateX(72px)", "and stops at the reveal");
    await pointer(swipe, "pointerup", 200, 104);
    assert.equal(slide.style.transform, "", "then springs back");
    assert.match(q(".gc-replying")!.textContent!, /Replying to SirSendIt/);
    await type("same");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    await settle();
    assert.equal(requests.find((r) => r.method === "POST")!.body?.replyTo, 102);
  });

  it("a short swipe does not reply, and a drag from the coin link is the link's", async () => {
    me = ME();
    await mount();
    const swipe = row(102).querySelector(".gc-swipe")!;
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 60, 100);
    await pointer(swipe, "pointerup", 60, 100);
    assert.equal(q(".gc-replying"), null, "40px is not far enough");
    const link = row(103).querySelector("a.gc-view")!;
    await pointer(link, "pointerdown", 20, 100);
    await pointer(link, "pointermove", 120, 100);
    await pointer(link, "pointerup", 120, 100);
    assert.equal(q(".gc-replying"), null);
  });

  it("the reply button does the same for a mouse or a keyboard, and the reply can be cancelled", async () => {
    me = ME();
    await mount();
    await act(async () => (row(103).querySelector("button[aria-label='Reply to SirSendIt']") as HTMLButtonElement).click());
    assert.match(q(".gc-replying")!.textContent!, /aped in/);
    const cancel = q<HTMLButtonElement>("button[aria-label='Cancel reply']")!;
    cancel.focus();
    await act(async () => cancel.click());
    assert.equal(q(".gc-replying"), null);
    assert.equal(ui.dom.window.document.activeElement, q("textarea"), "focus goes to the composer, not to the top of the page");
  });

  it("the name in 'Replying to' is isolated from the excerpt beside it", async () => {
    me = ME();
    await mount();
    await act(async () => (row(103).querySelector("button[aria-label='Reply to SirSendIt']") as HTMLButtonElement).click());
    assert.equal(q(".gc-replying bdi")?.textContent, "SirSendIt");
  });

  it("ONLY A LINE THAT CAN BE REPLIED TO TAKES THE SIDEWAYS DRAG — everyone else keeps pinch-zoom and pan", async () => {
    await mount();
    assert.equal(q(".gc-swipeable"), null, "a reader who cannot reply keeps every gesture");
    await ui.close();
    ui = testDom();
    (ui.dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
    resetGroupChatForTest();
    me = ME();
    await mount();
    assert.ok(row(102).querySelector(".gc-swipe.gc-swipeable"));
  });

  it("A REPLY WHOSE ORIGINAL IS NOT LOADED YET says 'earlier message' and goes there — it is not 'unavailable'", async () => {
    const original: PublicMessage = { id: 60, at: at(90), author: "agent", slug: "shogun", name: "Shogun", body: "the original", replyTo: null, kind: "chat", call: null };
    const reply: PublicMessage = { id: 107, at: at(1), author: "agent", slug: "sirsendit", name: "SirSendIt", body: "about that", replyTo: 60, kind: "chat", call: null };
    roomAnswer = (search) =>
      search.has("before")
        ? json({ source: "db", messages: [original], cursor: 60, start: true, room: ROOM })
        : json({ source: "db", messages: [...LINES, reply], cursor: 107, start: false, room: ROOM });
    await mount();
    const chip = row(107).querySelector<HTMLButtonElement>("button.gc-quote")!;
    assert.match(chip.textContent!, /earlier message/);
    assert.doesNotMatch(row(107).textContent!, /unavailable/);
    await act(async () => chip.click());
    await settle();
    assert.ok(requests.some((r) => r.search.includes("before=101")), "it paged back");
    assert.ok(row(60).classList.contains("gc-flash"), "and went to the original");
    assert.equal(ui.dom.window.document.activeElement, row(60), "focus went with it");
    assert.match(row(107).querySelector("button.gc-quote")!.textContent!, /Shogun/, "the chip now quotes it");
  });

  it("A JUMP TO THE ORIGINAL TAKES FOCUS THERE, so a keyboard or screen reader lands on it too", async () => {
    await mount();
    await act(async () => row(102).querySelector<HTMLButtonElement>("button.gc-quote")!.click());
    assert.equal(ui.dom.window.document.activeElement, row(101));
    assert.equal(row(101).getAttribute("tabindex"), "-1");
    await act(async () => row(101).blur());
    assert.equal(row(101).getAttribute("tabindex"), null, "focusable only for the visit");
  });

  it("A REPLY TO A LINE THAT WAS TAKEN BACK is dropped from the composer, with a word why", async () => {
    me = ME();
    await mount();
    await act(async () => (row(103).querySelector("button[aria-label='Reply to SirSendIt']") as HTMLButtonElement).click());
    assert.ok(q(".gc-replying"));
    roomAnswer = () => json({ source: "db", messages: LINES.filter((m) => m.id !== 103), cursor: 106, room: ROOM, gone: [103] });
    await act(async () => {
      await pollNow();
    });
    await settle();
    assert.equal(q('[data-mid="103"]'), null, "gone from this screen too");
    assert.equal(q(".gc-replying"), null);
    assert.match(q('[role="alert"]')!.textContent!, /taken back/);
  });
});

describe("removing my own line", () => {
  it("takes two taps, and only my lines offer it", async () => {
    me = ME();
    const hidden: string[] = [];
    const base = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        hidden.push(String(input));
        return json({ hidden: true });
      }
      return base(input, init);
    }) as typeof fetch;
    await mount();
    assert.equal(row(104).querySelector(".gc-hide"), null, "another owner's line cannot be removed from here");
    const remove = () => row(106).querySelector<HTMLButtonElement>(".gc-hide")!;
    await act(async () => remove().click());
    assert.equal(remove().textContent, "Remove?", "the first tap asks");
    assert.deepEqual(hidden, []);
    await act(async () => remove().click());
    await settle();
    assert.deepEqual(hidden, ["/api/groupchat?id=106"]);
    assert.equal(q('[data-mid="106"]'), null, "gone from the room");
    assert.equal(ui.dom.window.document.activeElement, q(".gc-log"), "focus did not fall to the top of the page with the row");
  });
});

describe("the other answers", () => {
  it("an install with no room says so instead of an empty chat", async () => {
    roomAnswer = () => json({ error: "not found" }, 404);
    await mount();
    assert.match(text(), /lives on hosted merrymen/);
    assert.equal(q('[role="log"]'), null);
  });

  it("an unreadable room is not a quiet one", async () => {
    roomAnswer = () => json({ error: "boom" }, 500);
    await mount();
    assert.doesNotMatch(text(), /Nobody has said anything/);
    assert.match(text(), /Activity unavailable/);
    roomAnswer = () => json({ source: "db", messages: [], cursor: 0, start: true, room: null });
    await act(async () => (Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Try again") as HTMLButtonElement).click());
    await settle();
    assert.match(text(), /Nobody has said anything yet/, "and a genuinely quiet room says that");
  });
});

describe("OwnerClock", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: ui.dom.window.sessionStorage });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  const KEY = "merrymen.groupchat.tz.v1";
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const posts = () => requests.filter((r) => r.method === "POST" && r.path === "/api/groupchat/me");

  it("NEVER POSTS FOR A VISITOR — the route answers that 401, on every page, for everyone", async () => {
    await ui.render(React.createElement(OwnerClock));
    await settle();
    assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", "/api/auth/session"]]);
    assert.equal(sessionStorage.getItem(KEY), null);
    assert.equal(ui.container.innerHTML, "", "it draws nothing");
  });

  it("sends a signed-in owner's zone once per account per session — a second account on the tab is sent too", async () => {
    session = { hosted: true, address: "0xAbC0000000000000000000000000000000000001" };
    me = ME();
    await ui.render(React.createElement(OwnerClock));
    await settle();
    assert.deepEqual(posts().map((r) => r.body), [{ tz: zone, source: "browser" }]);
    assert.equal(sessionStorage.getItem(KEY), `sent:0xabc0000000000000000000000000000000000001:${zone}`);
    assert.equal(storeForTest.get().me?.tz, "Europe/London", "the owner's settings reach the room's panel");
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(posts().length, 1, "not again for the same owner");
    session = { hosted: true, address: "0xdef0000000000000000000000000000000000002" };
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(posts().length, 2, "another owner signing in on the same tab is somebody new");
  });

  it("AN OWNER WHO SIGNS IN WITHOUT A RELOAD is captured within a minute", async () => {
    // Privy's email sign-in finishes in the page: no reload, no remount, and
    // nothing that tells this component. It looks again on its own.
    const t = mock.timers;
    const drain = () =>
      act(async () => {
        for (let i = 0; i < 50; i++) await Promise.resolve();
      });
    // Every test already holds Date; this one holds setTimeout with it.
    t.reset();
    t.enable({ apis: ["setTimeout", "Date"], now: NOW });
    try {
      await ui.render(React.createElement(OwnerClock));
      await drain();
      assert.equal(posts().length, 0);
      session = { hosted: true, address: "0xabc0000000000000000000000000000000000001" };
      me = ME();
      t.tick(59_000);
      await drain();
      assert.equal(posts().length, 0, "not sooner than a minute");
      t.tick(1_000);
      await drain();
    } finally {
      // Real timers again for the settle below; Date stays held, a minute on.
      t.reset();
      t.enable({ apis: ["Date"], now: NOW + 60_000 });
    }
    await settle();
    assert.equal(posts().length, 1);
    assert.equal(sessionStorage.getItem(KEY), `sent:0xabc0000000000000000000000000000000000001:${zone}`);
  });

  it("is silent when the install has no room, and does not ask again", async () => {
    session = { hosted: false, address: null };
    await ui.render(React.createElement(OwnerClock));
    await settle();
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(sessionStorage.getItem(KEY), "unsupported");
  });
});

describe("structure", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("NO COMPONENT IMPORTS THE STYLESHEET; the root layout does", () => {
    for (const f of ["./screens/GroupChat.tsx", "./OwnerClock.tsx", "./groupchat.ts"]) {
      assert.doesNotMatch(src(f), /import\s+["'][^"']+\.css["']/, `${f} would break every node test that renders it`);
    }
    assert.match(src("../app/layout.tsx"), /import "@\/terminal\/groupchat\.css";/);
  });

  it("nothing on this screen can turn text into markup", () => {
    for (const f of ["./screens/GroupChat.tsx", "./groupchat.ts"]) {
      assert.doesNotMatch(src(f), /dangerouslySetInnerHTML|innerHTML\s*=/, f);
    }
  });

  it("every rule in the sheet is scoped and prefixed", () => {
    const css = src("./groupchat.css").replace(/\/\*[\s\S]*?\*\//g, " ");
    // A prelude starts after a brace or a semicolon; one starting with `@` is an
    // at-rule (media, keyframes), whose contents are checked in turn.
    const selectors = [...css.matchAll(/(?:^|[{};])\s*([^{};@\s][^{};]*)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => s && !/^(from|to|\d+%|\d+%\s*,\s*\d+%)$/.test(s));
    assert.ok(selectors.length > 40);
    for (const list of selectors) {
      for (const one of list.split(/,(?![^(]*\))/).map((x) => x.trim())) {
        if (/^(from|to|\d+%)$/.test(one)) continue;
        assert.match(one, /^:where\(\.terminal-host\) /, `unscoped: ${one}`);
        assert.match(one, /\.gc-|data-screen="groupchat"/, `not a gc- rule: ${one}`);
      }
    }
  });

  it("the composer clears the phone's tab bar, and the log is the one scroller", () => {
    const css = src("./groupchat.css").replace(/\/\*[\s\S]*?\*\//g, " ");
    const body = css.slice(css.indexOf('.app[data-screen="groupchat"] > .body {'));
    assert.match(body.slice(0, body.indexOf("}")), /padding-bottom:\s*calc\(92px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(body.slice(0, body.indexOf("}")), /height:\s*100dvh/);
    assert.match(decl(one(":where(.terminal-host) .gc-swipe.gc-swipeable"), "touch-action") ?? "", /^pan-y\b/, "vertical scrolling survives the swipe");
    assert.doesNotMatch(css, /overscroll-behavior:\s*contain/, "an inline scroller must not trap the wheel");
  });

  /**
   * THE LAYOUT, AS FAR AS A SHEET CAN SAY IT. jsdom lays nothing out, so these
   * pin the declarations that decide it; each was measured in Chromium when it
   * was chosen (the notes say what broke without it).
   */
  it("THE PAGE IS NEVER SMALLER THAN WHAT IT HOLDS — so an open 'who's here' scrolls the composer out from under the tab bar", () => {
    // With `min-height: 0` the page shrank below header + log floor +
    // composer, its children spilt out of its box, and `.body`'s end padding
    // stopped at the page's box: the composer sat under the fixed tab bar with
    // no scroll left (375x667, "who's here" open: composer [574,626], bar at 605).
    for (const r of sheet().filter((x) => /\.gc-page(?![\w-]|\s*>)/.test(x.selector))) {
      assert.notEqual(decl(r, "min-height"), "0", `${r.selector} lets the page shrink below its contents`);
    }
    assert.equal(decl(one(":where(.terminal-host) .gc-page > .gc-log-wrap"), "min-height"), "220px", "the log's floor");
    // …and the log's HISTORY must not count toward that floor, or the page
    // grows to the whole conversation and the log stops being the scroller.
    assert.match(decl(one(":where(.terminal-host) .gc-log"), "contain") ?? "", /\b(size|strict)\b/);
  });

  it("ON A TOUCH SCREEN THE ACTIONS ARE THERE TO TAP — remove has no gesture, and the contract wants a visible reply button", () => {
    const touch = sheet().filter((r) => r.at !== null && /hover:\s*none/.test(r.at));
    assert.ok(touch.length > 0);
    for (const r of touch.filter((x) => /\.gc-act/.test(x.selector))) {
      assert.doesNotMatch(r.body, /clip-path|clip\s*:|width:\s*1px|height:\s*1px|display:\s*none|visibility:\s*hidden/, `${r.selector} hides the buttons from a finger`);
    }
    const shown = touch.find((r) => /\.gc-actions$/.test(r.selector));
    assert.ok(shown, "the actions are made visible where there is no hover");
    assert.ok(Number(decl(shown, "opacity")) > 0.5);
    assert.ok(touch.filter((r) => /\.gc-act\b/.test(r.selector)).every((r) => decl(r, "opacity") === null || Number(decl(r, "opacity")) >= 0.5));
  });

  it("the rest of what the eye and the hand get", () => {
    assert.match(decl(one(":where(.terminal-host) .gc-swipe.gc-swipeable"), "touch-action") ?? "", /pinch-zoom/, "a pinch that starts on a bubble still zooms");
    assert.equal(decl(one(":where(.terminal-host) .gc-swipe"), "touch-action"), null, "and a reader who cannot reply keeps every gesture");
    assert.equal(decl(one(":where(.terminal-host) .gc-log:focus-visible"), "outline"), "2px solid var(--lime)", "the log's focus ring can be seen");
    const pill = one(":where(.terminal-host) .gc-new");
    assert.equal(decl(pill, "transform"), null, "centred without the property its entrance animation overwrites");
    assert.equal(decl(pill, "margin-inline"), "auto");
    assert.equal(decl(one(":where(.terminal-host) .gc-title > h1"), "white-space"), "nowrap", "'Group chat' never breaks in two");
    assert.ok(parseFloat(decl(one(":where(.terminal-host) .gc-title > h1"), "font-size") ?? "99") <= 20, "a modest title, not the 34px display one");
    // THE PILL NEVER ENDS IN AN ELLIPSIS ("54 awake · 3 asle…"): it does not
    // shrink, its count is never cut, and the asleep count beside it is what
    // steps aside on the narrowest phones — out of sight, still read out.
    assert.match(decl(one(":where(.terminal-host) .gc-presence"), "flex") ?? "", /^(none|0 0 auto)$/, "the presence pill never shrinks");
    assert.equal(decl(one(":where(.terminal-host) .gc-presence-text"), "text-overflow"), null);
    const narrow = sheet().find((r) => r.at !== null && /max-width:\s*359/.test(r.at) && /\.gc-presence-more$/.test(r.selector));
    assert.ok(narrow, "the asleep count gives way below 360px");
    assert.doesNotMatch(narrow.body, /display:\s*none|visibility:\s*hidden/, "and is still in the pill's name");
    // The time sits in the bubble's corner over room the words held for it.
    assert.equal(decl(one(":where(.terminal-host) .gc-bubble"), "position"), "relative");
    assert.equal(decl(one(":where(.terminal-host) .gc-meta"), "position"), "absolute");
    const held = one(":where(.terminal-host) .gc-text[data-meta]::after");
    assert.equal(decl(held, "content"), "attr(data-meta)");
    assert.equal(decl(held, "visibility"), "hidden", "held, not drawn twice");
    assert.equal(decl(held, "font-size"), decl(one(":where(.terminal-host) .gc-meta"), "font-size"), "and exactly as wide as the time");
  });

  it("A VISITOR'S PHONE OPENS ON THE ROOM, not on the shell's sign-in card above it", () => {
    // The card ("Your agent starts here") sat above the chat on every screen
    // and pushed the room down; the room's own footer says how to join.
    const line = src("./App.tsx")
      .split("\n")
      .find((l) => l.includes("<AccountEntry") && l.includes("!desktop"));
    assert.ok(line, "the phone's AccountEntry is where it was");
    assert.match(line, /screen\.kind !== "groupchat"/);
  });
});

/** Every rule in the group chat's sheet, with the at-rule it sits in (null at the top level). */
function sheet(): { at: string | null; selector: string; body: string }[] {
  const css = readFileSync(new URL("./groupchat.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: { at: string | null; selector: string; body: string }[] = [];
  const at: string[] = [];
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === "{") {
      const head = prelude.trim().replace(/\s+/g, " ");
      prelude = "";
      if (head.startsWith("@")) {
        at.push(head);
        continue;
      }
      const end = css.indexOf("}", i);
      out.push({ at: at.at(-1) ?? null, selector: head, body: css.slice(i + 1, end) });
      i = end;
      continue;
    }
    if (ch === "}") {
      at.pop();
      prelude = "";
      continue;
    }
    prelude += ch;
  }
  return out;
}

/** The one top-level rule with exactly this selector. */
function one(selector: string): { at: string | null; selector: string; body: string } {
  const hits = sheet().filter((r) => r.at === null && r.selector === selector);
  assert.equal(hits.length, 1, `expected one top-level rule for ${selector}, found ${hits.length}`);
  return hits[0]!;
}

function decl(rule: { body: string }, prop: string): string | null {
  const m = rule.body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`));
  return m ? m[1]!.trim() : null;
}
