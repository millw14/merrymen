/**
 * POSTING ON X, ON THE SETTINGS SCREEN: the real section, in a DOM, against a
 * scripted network — and the warning's words, read from the source.
 *
 * The properties are the ones an owner cannot see go wrong:
 *
 *   - pressing the switch ON sends NOTHING; only the warning's own button
 *     writes, and it sends the X user id of the account the warning named;
 *   - the warning names the connected handle and says the Merryman posts from
 *     "whichever X account is connected";
 *   - the switch shows only what the server confirmed;
 *   - a status that could not be read — a 404, a 500, no network, a body of
 *     the wrong shape — never reads as "not connected" (no Connect button).
 *
 * The render tests pass on a branch that never fired; the source scan below
 * pins the prose itself (the honesty.test.ts idiom), and mounted.test.ts
 * checks this file is on a live screen.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import { X_COPY, type XAccountBody } from "@/lib/x-connect";
import { EN, type MessageKey } from "@/lib/messages/en";
import { json, testDom } from "./test-dom";
import { XPosting } from "./XPosting";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HANDLE = "merry_poster";
const X_ID = "1234567890";
/** What this process's Intl says, which is what the section sends. */
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let calls: { method: string; url: string; body: Record<string, unknown> | null }[];
let went: string[];

const CONNECTED: XAccountBody = {
  available: true,
  connected: true,
  username: HANDLE,
  xUserId: X_ID,
  status: "ok",
  postingEnabled: false,
  prefs: { buys: true, casual: true, perDay: null },
  perDayMax: 3,
  replyEnabled: false,
  repliesAvailable: false,
  upcoming: [],
  recent: [],
};

beforeEach(() => {
  ui = testDom();
  calls = [];
  went = [];
  routes = { "GET /api/x/account": () => json(CONNECTED) };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const handler = routes[`${method} ${url.split("?")[0]}`];
    // Unscripted routes answer 404, as the chat harness does: an old server,
    // a self-hosted one, a route that moved.
    return handler ? handler(url, init) : json({ error: "not scripted" }, 404);
  }) as typeof fetch;
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

const text = () => ui.container.textContent ?? "";
const buttons = (label: string) => Array.from(ui.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);
const theSwitch = () => ui.container.querySelector<HTMLButtonElement>('button[role="switch"]');
const writes = () => calls.filter((c) => c.method !== "GET");

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}

async function until(cond: () => boolean, what: string, rounds = 100) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await settle(1);
  }
  assert.fail(`never happened: ${what}\n--- screen ---\n${text()}`);
}

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `missing: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

type Props = Partial<{ owner: string | null; hosted: boolean | null; timing: { pollMs: number; afterEnableMs: number } }>;

const section = (props: Props = {}) =>
  createElement(
    "details",
    { className: "settings-group", id: "x-posting" },
    createElement("summary", null, "Posting on X"),
    createElement(XPosting, { owner: OWNER, hosted: true, navigate: (url: string) => went.push(url), ...props }),
  );

async function shown(props: Props = {}) {
  await ui.render(section(props));
  await until(() => !text().includes("Checking your X connection"), "the first read");
}

/** Open or close the Settings group, as the owner clicking its summary would. */
async function setOpen(open: boolean) {
  const details = ui.container.querySelector("details")!;
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new ui.dom.window.Event("toggle"));
  });
  await settle();
}

const reads = () => calls.filter((c) => c.method === "GET").length;
/** A wall-clock wait for the re-read clocks, which tests shrink to a few milliseconds. */
async function settleFor(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) await settle(1);
}
const FAST = { pollMs: 25, afterEnableMs: 60 };
/** A draft as the planner writes one now: at least ten minutes before it is due. */
const DUE_SOON = () => Date.now() + 20 * 60_000;

describe("comment reply consent", () => {
  const replySwitch = () => ui.container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Reply to comments"]');
  it("sends nothing until the separate warning is confirmed for the named X account", async () => {
    let enabled = false;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, repliesAvailable: true, replyEnabled: enabled });
    routes["POST /api/x/account"] = () => { enabled = true; return json({ ok: true, replyEnabled: true }); };
    await shown();
    await press(replySwitch(), "reply switch");
    assert.equal(writes().length, 0);
    assert.match(text(), new RegExp(`Reply to comments as @${HANDLE}`));
    assert.match(text(), /selected comments on its coin posts/);
    assert.match(text(), /same daily limit/);
    assert.match(text(), /at least ten minutes/);
    await press(buttons(`Let it reply as @${HANDLE}`)[0], "reply confirm");
    assert.deepEqual(writes()[0]?.body, { action: "enable-replies", owner: OWNER, xUserId: X_ID });
    assert.equal(replySwitch()?.getAttribute("aria-checked"), "true");
  });

  it("keeps replies off when the server refuses the named account", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, repliesAvailable: true });
    routes["POST /api/x/account"] = () => json({ error: X_COPY.accountChanged }, 409);
    await shown();
    await press(replySwitch(), "reply switch");
    await press(buttons(`Let it reply as @${HANDLE}`)[0], "reply confirm");
    assert.equal(replySwitch()?.getAttribute("aria-checked"), "false");
    assert.match(text(), /connected X account changed/);
  });

  it("the confirmation keeps the owner who read it when another wallet signs in", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, repliesAvailable: true });
    routes["POST /api/x/account"] = () => json({ error: "Your account changed." }, 409);
    await shown();
    await press(replySwitch(), "reply switch");
    await ui.render(section({ owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
    await press(buttons(`Let it reply as @${HANDLE}`)[0], "reply confirm");
    assert.equal(writes()[0]?.body?.owner, OWNER, "the server must compare the session to the owner who saw the warning");
  });

  it("defaults unavailable on older responses and says so without offering enable", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, replyEnabled: undefined, repliesAvailable: undefined });
    await shown();
    assert.match(text(), /Comment replies aren’t available yet/);
    assert.equal(replySwitch(), null);
  });

  it("turns enabled replies off immediately even when availability disappears", async () => {
    let enabled = true;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, replyEnabled: enabled });
    routes["POST /api/x/account"] = () => { enabled = false; return json({ ok: true, replyEnabled: false }); };
    await shown();
    await press(replySwitch(), "stop replies");
    assert.deepEqual(writes()[0]?.body, { action: "disable-replies", owner: OWNER, xUserId: X_ID });
    assert.equal(ui.container.querySelector("dialog"), null);
  });

  it("labels replies and links only numeric comment IDs in queue and history", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true,
      upcoming: [{ id: 1, kind: "reply", body: "A thoughtful answer", dueAt: DUE_SOON(), replyToTweetId: "123" },
        { id: 2, kind: "reply", body: "A second answer", dueAt: DUE_SOON(), replyToTweetId: "javascript:alert(1)" }],
      recent: [{ id: 3, kind: "reply", body: "Already answered", sentAt: Date.now(), url: `https://x.com/${HANDLE}/status/456`, replyToTweetId: "789" }],
    });
    await shown();
    const links = Array.from(ui.container.querySelectorAll("a")).filter((a) => a.textContent === "View comment").map((a) => a.getAttribute("href"));
    assert.deepEqual(links, ["https://x.com/i/status/123", "https://x.com/i/status/789"]);
    assert.match(text(), /Comment reply/);
    assert.ok(!ui.container.innerHTML.includes('href="javascript:'));
  });
});

describe("the switch and the warning", () => {
  it("PRESSING THE SWITCH ON SENDS NOTHING: the warning names the account, and only its button writes", async () => {
    let enabled = false;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: enabled });
    routes["POST /api/x/account"] = () => {
      enabled = true;
      return json({ ok: true, postingEnabled: true });
    };
    await shown();
    assert.match(text(), /Connected as @merry_poster/);
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false");

    await press(theSwitch(), "the switch");
    assert.deepEqual(writes(), [], "the switch itself sent something");
    const dialog = ui.container.querySelector("dialog");
    assert.ok(dialog, "the warning opened");
    const said = dialog.textContent ?? "";
    assert.match(said, /Post on X as @merry_poster\?/);
    assert.match(said, /whichever X account is connected/);
    assert.match(said, /right now that's @merry_poster\./);
    assert.match(said, /never posts trade alerts, error messages, prices or amounts/);
    assert.match(said, /may ask an account to verify itself the first time it posts about crypto/);
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false", "still off while the owner reads");

    await press(buttons("Not now")[0], "Not now");
    assert.equal(ui.container.querySelector("dialog"), null);
    assert.deepEqual(writes(), [], "declining the warning sent something");

    await press(theSwitch(), "the switch again");
    await press(buttons("Let it post as @merry_poster")[0], "the warning's confirm");
    assert.deepEqual(writes(), [
      // The consent carries the browser's zone, for quiet hours when the room has none.
      { method: "POST", url: "/api/x/account", body: { action: "enable", xUserId: X_ID, owner: OWNER, tz: BROWSER_TZ } },
    ]);
    await until(() => theSwitch()?.getAttribute("aria-checked") === "true", "the confirmed state");
    assert.match(text(), /Posting from @merry_poster — whichever X account is connected\./);
    assert.equal(ui.container.querySelector("dialog"), null);
  });

  it("THE WARNING OPENS ON ITS LEAD SENTENCE, NOT ITS CONSENT BUTTON: a second Enter on the switch sends nothing", async () => {
    // jsdom has no showModal. This one does what a browser's does: open, and
    // focus the first thing in the dialog that Tab would reach — which, left
    // alone, is "Let it post as @h".
    const proto = ui.dom.window.HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
      this.querySelector<HTMLElement>("[autofocus], button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    await shown();
    theSwitch()!.focus();
    await press(theSwitch(), "the switch (Enter)");
    const dialog = ui.container.querySelector("dialog")!;
    const active = ui.dom.window.document.activeElement;
    assert.notEqual(active, buttons("Let it post as @merry_poster")[0], "focus landed on the consent");
    assert.equal(active?.id, "xpost-warning-lead");
    assert.match(active?.textContent ?? "", /whichever X account is connected/);
    // The warning is announced by the sentence that matters.
    assert.equal(dialog.getAttribute("aria-describedby"), "xpost-warning-lead");
    // Key repeat, or a second press: the next Enter lands on whatever has focus.
    await press(ui.dom.window.document.activeElement, "the second Enter");
    assert.deepEqual(writes(), [], "two presses of the switch consented");
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false");
  });

  it("the confirm sends the account the warning NAMED, even if a re-read changed the screen underneath", async () => {
    routes["POST /api/x/account"] = () => json({ error: "The connected X account changed — check which account is connected and try again." }, 409);
    await shown();
    await press(theSwitch(), "the switch");
    // Another tab reconnects a different account; the page re-reads.
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, username: "someone_else", xUserId: "999" });
    await act(async () => {
      ui.container.querySelector("details")!.dispatchEvent(new ui.dom.window.Event("toggle"));
    });
    await settle();
    await press(buttons("Let it post as @merry_poster")[0], "the warning's confirm");
    assert.equal(writes()[0]?.body?.xUserId, X_ID);
    // Refused: the switch stays off, the owner is told, and the account now connected is shown.
    await until(() => text().includes("Connected as @someone_else"), "the re-read after the refusal");
    assert.match(text(), /The connected X account changed/);
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false");
  });

  it("the switch shows only what the server confirmed: a failed confirm leaves it off", async () => {
    routes["POST /api/x/account"] = () => json({ error: "nope" }, 500);
    await shown();
    await press(theSwitch(), "the switch");
    await press(buttons("Let it post as @merry_poster")[0], "confirm");
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false");
    assert.match(text(), /merrymen answered with an error \(500\)/);
    assert.doesNotMatch(text(), /nope/, "an unmarked 5xx body is not an owner-facing sentence");
  });

  it("turning it OFF writes at once, with no warning", async () => {
    let enabled = true;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: enabled, upcoming: [{ id: 7, kind: "casual", body: "a thought", dueAt: DUE_SOON() }] });
    routes["POST /api/x/account"] = () => {
      enabled = false;
      return json({ ok: true, postingEnabled: false });
    };
    await shown();
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "true");
    await press(theSwitch(), "the switch");
    assert.equal(ui.container.querySelector("dialog"), null);
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/account", body: { action: "disable", owner: OWNER } }]);
    await until(() => theSwitch()?.getAttribute("aria-checked") === "false", "off");
    assert.doesNotMatch(text(), /a thought/);
  });
});

describe("what it posts: the owner's choices beside the switch", () => {
  const switches = () => Array.from(ui.container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'));
  const switchNamed = (label: string) => switches().find((b) => b.getAttribute("aria-label") === label) ?? null;
  const dayButtons = () => Array.from(ui.container.querySelectorAll<HTMLButtonElement>('[aria-label="Posts a day, at most"] button'));

  it("shows the hello note, the two kinds and the number a day, with Usual chosen when the owner picked none", async () => {
    await shown();
    assert.match(text(), /What it posts/);
    assert.match(text(), /A hello first, so people know an AI agent posts here\. You can skip it under Coming up\./);
    assert.equal(switchNamed("Coins it buys, and why")?.getAttribute("aria-checked"), "true");
    assert.equal(switchNamed("The odd passing thought")?.getAttribute("aria-checked"), "true");
    assert.deepEqual(dayButtons().map((r) => [r.textContent, r.getAttribute("aria-pressed")]), [["Usual", "true"], ["1", "false"], ["2", "false"], ["3", "false"]]);
  });

  it("says coin posts are only coins it bought, and points at Trencher mode to hunt memecoins", async () => {
    await shown();
    assert.match(text(), /Only coins it actually bought, never ones it's just watching\. To have it hunt memecoins, turn on Trencher mode\./);
    const link = Array.from(ui.container.querySelectorAll("a")).find((a) => a.textContent === "Trencher mode");
    assert.equal(link?.getAttribute("href"), "/settings#trencher-mode");
  });

  it("a switch writes that one choice with the owner, and moves only when the server confirms it", async () => {
    let buys = true;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, prefs: { buys, casual: true, perDay: null } });
    routes["POST /api/x/account"] = (_u, init) => {
      const body = JSON.parse(String(init?.body)) as { buys?: boolean };
      buys = body.buys ?? buys;
      return json({ ok: true, prefs: { buys, casual: true, perDay: null } });
    };
    await shown();
    await press(switchNamed("Coins it buys, and why"), "the buys switch");
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/account", body: { action: "prefs", owner: OWNER, buys: false } }]);
    await until(() => switchNamed("Coins it buys, and why")?.getAttribute("aria-checked") === "false", "buys off");
    assert.equal(theSwitch()?.getAttribute("aria-label"), "Let my Merryman post on X", "the posting switch is still the first one");
  });

  it("a save the server refused changes nothing on screen, and says why", async () => {
    routes["POST /api/x/account"] = () => json({ error: "Connect an X account first." }, 409);
    await shown();
    await press(switchNamed("The odd passing thought"), "the casual switch");
    assert.equal(switchNamed("The odd passing thought")?.getAttribute("aria-checked"), "true");
    assert.match(text(), /Connect an X account first\./);
  });

  it("a number a day: pressing another writes perDay, Usual writes null, and pressing the chosen one writes nothing", async () => {
    let perDay: number | null = null;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, prefs: { buys: true, casual: true, perDay } });
    routes["POST /api/x/account"] = (_u, init) => {
      perDay = (JSON.parse(String(init?.body)) as { perDay: number }).perDay;
      return json({ ok: true, prefs: { buys: true, casual: true, perDay } });
    };
    await shown();
    await press(dayButtons()[0], "Usual, already chosen");
    assert.deepEqual(writes(), []);
    await press(dayButtons()[3], "3");
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/account", body: { action: "prefs", owner: OWNER, perDay: 3 } }]);
    await until(() => dayButtons()[3]?.getAttribute("aria-pressed") === "true", "3 chosen");
    await press(dayButtons()[0], "Usual");
    assert.deepEqual(writes().at(-1), { method: "POST", url: "/api/x/account", body: { action: "prefs", owner: OWNER, perDay: null } });
    await until(() => dayButtons()[0]?.getAttribute("aria-pressed") === "true", "Usual chosen again");
  });

  it("turning a kind off reads Coming up again: its drafts are gone", async () => {
    let buys = true;
    routes["GET /api/x/account"] = () =>
      json({
        ...CONNECTED,
        postingEnabled: true,
        prefs: { buys, casual: true, perDay: null },
        upcoming: buys ? [{ id: 9, kind: "buy", body: "grabbed some frog on paper", dueAt: DUE_SOON() }] : [],
      });
    routes["POST /api/x/account"] = () => {
      buys = false;
      return json({ ok: true, prefs: { buys, casual: true, perDay: null } });
    };
    await shown();
    assert.match(text(), /grabbed some frog on paper/);
    await press(switchNamed("Coins it buys, and why"), "the buys switch");
    await until(() => !text().includes("grabbed some frog on paper"), "the buy draft gone");
  });

  it("an older server that sends no choices shows none", async () => {
    const { prefs: _p, perDayMax: _m, ...old } = CONNECTED;
    routes["GET /api/x/account"] = () => json(old);
    await shown();
    assert.doesNotMatch(text(), /What it posts/);
    assert.equal(switches().length, 1);
  });
});

describe("an unread status is not 'not connected'", () => {
  for (const [what, answer] of [
    ["an unscripted route (404)", null],
    ["a 500", () => json({ error: "boom" }, 500)],
    ["no network", () => { throw new TypeError("Failed to fetch"); }],
    ["a 200 of the wrong shape", () => json({ connected: false })],
    ["a 200 that is not JSON", () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })],
  ] as const) {
    it(`${what} says it could not check, and offers a retry — never "Connect X account"`, async () => {
      if (answer) routes["GET /api/x/account"] = answer as Handler;
      else delete routes["GET /api/x/account"];
      await shown();
      assert.match(text(), /Couldn't check your X connection/);
      assert.doesNotMatch(text(), /Connect X account|Let my Merryman post on X/);
      assert.equal(theSwitch(), null);
      assert.deepEqual(writes(), []);
      routes["GET /api/x/account"] = () => json(CONNECTED);
      await press(buttons("Try again")[0], "retry");
      await until(() => text().includes("Connected as @merry_poster"), "the retried read");
    });
  }

  it("says 'checking' while the first read is out", async () => {
    let release!: () => void;
    routes["GET /api/x/account"] = () => new Promise<Response>((r) => { release = () => r(json(CONNECTED)); });
    await ui.render(section());
    assert.match(text(), /Checking your X connection/);
    assert.doesNotMatch(text(), /Connect X account/);
    release();
    await until(() => text().includes("Connected as"), "the read");
  });
});

describe("connecting", () => {
  it("offers Connect with the caption, sends start for the web with the owner, and goes only to X", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, connected: false, username: null, xUserId: null, status: null });
    routes["POST /api/x/connect"] = () => json({ url: "https://x.com/i/oauth2/authorize?response_type=code&state=w.x" });
    await shown();
    assert.match(text(), /a hello when it starts, the odd casual thought/);
    assert.match(text(), /whichever X account you approve there/);
    await press(buttons("Connect X account")[0], "Connect");
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/connect", body: { action: "start", client: "web", owner: OWNER } }]);
    assert.deepEqual(went, ["https://x.com/i/oauth2/authorize?response_type=code&state=w.x"]);
  });

  it("does not follow a start that points anywhere but X's authorize page", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, connected: false, username: null, xUserId: null, status: null });
    routes["POST /api/x/connect"] = () => json({ url: "https://evil.example/i/oauth2/authorize?" });
    await shown();
    await press(buttons("Connect X account")[0], "Connect");
    assert.deepEqual(went, []);
    assert.match(text(), /didn't send a way to X/);
  });

  it("a connection it cannot name is still a connection: no switch, no Connect, a way to disconnect", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, username: null });
    await shown();
    assert.match(text(), /An X account is connected, but merrymen can't show which one/);
    assert.equal(theSwitch(), null, "the warning must name the account, so there is nothing to turn on");
    assert.equal(buttons("Connect X account").length, 0);
    assert.equal(buttons("Disconnect").length, 1);
  });

  it("a revoked connection asks for a reconnect and offers no switch", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, status: "revoked" });
    await shown();
    assert.match(text(), /X stopped accepting this connection\. Reconnect to keep posting\./);
    assert.equal(theSwitch(), null);
    assert.equal(buttons("Reconnect X account").length, 1);
  });

  it("unavailable here with nothing connected: one line, nothing to press", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, available: false, connected: false, username: null, xUserId: null, status: null });
    await shown();
    assert.equal(ui.container.querySelector(".xpost")?.textContent, "Posting on X isn't available right now.");
    assert.doesNotMatch(text(), /yet/, "it may have worked before; 'yet' says it never did");
    assert.equal(ui.container.querySelectorAll("button").length, 0);
  });

  it("UNAVAILABLE HERE, BUT CONNECTED AND POSTING: the switch still turns it off, and Coming up still skips", async () => {
    // The web lost its X app (an origin, a secret); the orchestrator did not, and is posting.
    let enabled = true;
    let upcoming = [{ id: 7, kind: "casual", body: "a thought", dueAt: DUE_SOON() }];
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, available: false, postingEnabled: enabled, upcoming });
    routes["POST /api/x/account"] = (_u, init) => {
      const body = JSON.parse(String(init?.body)) as { action: string; id?: number };
      if (body.action === "skip") upcoming = upcoming.filter((p) => p.id !== body.id);
      if (body.action === "disable") {
        enabled = false;
        upcoming = [];
        return json({ ok: true, postingEnabled: false });
      }
      return json({ ok: true });
    };
    await shown();
    assert.match(text(), /Posting from @merry_poster — whichever X account is connected\./);
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "true");
    assert.match(text(), /Coming up/);
    assert.equal(buttons("Disconnect").length, 1);
    assert.equal(buttons("Reconnect X account").length + buttons("Connect X account").length, 0, "nothing that needs the X app");

    await press(buttons("Skip")[0], "Skip");
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/account", body: { action: "skip", id: 7, owner: OWNER } }]);
    await until(() => !text().includes("a thought"), "the skipped post gone");

    await press(theSwitch(), "the switch");
    assert.equal(ui.container.querySelector("dialog"), null);
    assert.deepEqual(writes()[1], { method: "POST", url: "/api/x/account", body: { action: "disable", owner: OWNER } });
    await until(() => theSwitch()?.getAttribute("aria-checked") === "false", "off");

    // Back on is what needs the X app: refused here, in one line, with nothing sent.
    await press(theSwitch(), "the switch, on");
    assert.equal(ui.container.querySelector("dialog"), null, "no warning for a consent that cannot be taken");
    assert.equal(writes().length, 2);
    assert.match(text(), /Turning posting on isn't available right now\./);
    assert.equal(theSwitch()?.getAttribute("aria-checked"), "false");
  });

  it("unavailable here with a revoked connection: no Reconnect, which would fail on the first press", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, available: false, status: "revoked" });
    await shown();
    assert.match(text(), /X stopped accepting this connection/);
    assert.equal(buttons("Reconnect X account").length, 0);
    assert.match(text(), /Posting on X isn't available right now\./);
    assert.equal(buttons("Disconnect").length, 1);
  });
});

describe("the lists", () => {
  it("shows what is coming up with a Skip that names the post and the owner, and what was posted with a link to X", async () => {
    let upcoming = [
      { id: 7, kind: "buy", body: "picked up some paper TSLA, earnings chatter looked good", dueAt: DUE_SOON() },
      { id: 8, kind: "casual", body: "quiet market today", dueAt: Date.now() + 35 * 60_000 },
    ];
    routes["GET /api/x/account"] = () =>
      json({
        ...CONNECTED,
        postingEnabled: true,
        upcoming,
        recent: [
          { id: 3, kind: "intro", body: "hello, I'm an AI trading agent", sentAt: Date.now() - 60_000, url: `https://x.com/${HANDLE}/status/1111` },
          { id: 4, kind: "casual", body: "sneaky link", sentAt: Date.now() - 60_000, url: "javascript:alert(1)" },
        ],
      });
    routes["POST /api/x/account"] = (_u, init) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      upcoming = upcoming.filter((p) => p.id !== id);
      return json({ ok: true });
    };
    await shown();
    assert.match(text(), /Coming up/);
    assert.match(text(), /picked up some paper TSLA/);
    assert.equal(buttons("Skip").length, 2);
    await press(buttons("Skip")[0], "Skip");
    assert.deepEqual(writes(), [{ method: "POST", url: "/api/x/account", body: { action: "skip", id: 7, owner: OWNER } }]);
    await until(() => !text().includes("picked up some paper TSLA"), "the skipped post gone");
    assert.match(text(), /Posted/);
    const links = Array.from(ui.container.querySelectorAll('section[aria-label="Posted"] a')).map((a) => a.getAttribute("href"));
    assert.deepEqual(links, [`https://x.com/${HANDLE}/status/1111`], "only an x.com status URL becomes a link");
  });

  it("each Skip is named, to assistive tech, by the post it skips", async () => {
    const long = "the quiet hour before the open is when the curves look most honest to me, and I like reading them then";
    routes["GET /api/x/account"] = () =>
      json({
        ...CONNECTED,
        postingEnabled: true,
        upcoming: [
          { id: 7, kind: "buy", body: "picked up some paper TSLA,\n earnings chatter looked good", dueAt: DUE_SOON() },
          { id: 8, kind: "casual", body: long, dueAt: DUE_SOON() },
        ],
      });
    await shown();
    const names = buttons("Skip").map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(names, [
      "Skip buy post: picked up some paper TSLA, earnings chatter looked good",
      "Skip casual post: the quiet hour before the open is when the curves look most…",
    ]);
  });

  it("a Skip for a post already on its way says so", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, upcoming: [{ id: 7, kind: "casual", body: "a thought", dueAt: Date.now() }] });
    routes["POST /api/x/account"] = () => json({ error: "That post is already on its way." }, 409);
    await shown();
    await press(buttons("Skip")[0], "Skip");
    assert.match(text(), /That post is already on its way\./);
  });

  it("an empty queue says nothing is waiting", async () => {
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true });
    await shown();
    assert.match(text(), /Nothing waiting to go out\./);
  });
});

describe("keeping Coming up current (every post waits there ten minutes; the list must show it)", () => {
  it("re-reads on its own while the section is open and posting is on: a new draft appears, a sent one loses its Skip", async () => {
    let upcoming: { id: number; kind: string; body: string; dueAt: number }[] = [];
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: true, upcoming });
    await shown({ timing: FAST });
    await setOpen(true);
    assert.match(text(), /Nothing waiting to go out\./);

    // The orchestrator drafts; nobody touches the screen.
    upcoming = [{ id: 9, kind: "casual", body: "the quiet hour before the open", dueAt: DUE_SOON() }];
    await until(() => text().includes("the quiet hour before the open"), "the new draft, without an owner action");
    assert.equal(buttons("Skip").length, 1);
    // It goes out; the list stops offering to skip it.
    upcoming = [];
    await until(() => buttons("Skip").length === 0, "the sent post gone from Coming up");
    assert.deepEqual(writes(), [], "re-reading is only reading");
  });

  it("stops re-reading when the section is closed, and never re-reads while posting is off", async () => {
    let enabled = true;
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: enabled });
    await shown({ timing: FAST });
    await setOpen(true);
    await until(() => reads() >= 4, "a few re-reads while open");
    await setOpen(false);
    let before = reads();
    await settleFor(FAST.pollMs * 6);
    assert.equal(reads(), before, "a closed section kept reading");

    enabled = false;
    await setOpen(true);
    before = reads();
    await settleFor(FAST.pollMs * 6);
    assert.equal(reads(), before, "posting is off: nothing can be drafted, so nothing to re-read");
  });

  it("a re-read that fails says so quietly, keeps the list, and clears the note when the next one works", async () => {
    let down = false;
    routes["GET /api/x/account"] = () =>
      down ? json({ error: "boom" }, 500) : json({ ...CONNECTED, postingEnabled: true, upcoming: [{ id: 7, kind: "casual", body: "a thought", dueAt: DUE_SOON() }] });
    await shown({ timing: FAST });
    await setOpen(true);
    down = true;
    await until(() => text().includes("Couldn't refresh this just now."), "the quiet failure");
    assert.match(text(), /a thought/, "a failed re-read never blanks the list");
    down = false;
    await until(() => !text().includes("Couldn't refresh this just now."), "the note cleared by a read that worked");
  });

  it("reads once more after posting is turned on, so the hello drafted on the next plan pass is on screen", async () => {
    let enabled = false;
    let upcoming: { id: number; kind: string; body: string; dueAt: number }[] = [];
    routes["GET /api/x/account"] = () => json({ ...CONNECTED, postingEnabled: enabled, upcoming });
    routes["POST /api/x/account"] = () => {
      enabled = true;
      return json({ ok: true, postingEnabled: true });
    };
    // A long poll, so only the one re-read after enabling can find the hello.
    await shown({ timing: { pollMs: 60_000, afterEnableMs: FAST.afterEnableMs } });
    await press(theSwitch(), "the switch");
    await press(buttons("Let it post as @merry_poster")[0], "the warning's confirm");
    await until(() => theSwitch()?.getAttribute("aria-checked") === "true", "on");
    assert.match(text(), /Nothing waiting to go out\./, "the read right after enabling is before the plan pass");
    // The next plan pass drafts the hello, due ten minutes after the consent.
    upcoming = [{ id: 1, kind: "intro", body: "hi, I'm an AI trading agent", dueAt: Date.now() + 10 * 60_000 }];
    await until(() => text().includes("hi, I'm an AI trading agent"), "the hello, read without an owner action");
  });
});

describe("disconnecting", () => {
  it("asks first, naming the account, then DELETEs with the owner", async () => {
    let connected = true;
    routes["GET /api/x/account"] = () => json(connected ? CONNECTED : { ...CONNECTED, connected: false, username: null, xUserId: null, status: null });
    routes["DELETE /api/x/account"] = () => {
      connected = false;
      return json({ ok: true });
    };
    await shown();
    await press(buttons("Disconnect")[0], "Disconnect");
    assert.deepEqual(writes(), [], "asking is not doing");
    assert.match(text(), /Disconnect @merry_poster\? Your Merryman stops posting and anything waiting to go out is cancelled\./);
    await press(buttons("Keep it")[0], "Keep it");
    assert.deepEqual(writes(), []);
    await press(buttons("Disconnect")[0], "Disconnect");
    await press(buttons("Yes, disconnect")[0], "confirm");
    assert.deepEqual(writes(), [{ method: "DELETE", url: "/api/x/account", body: { owner: OWNER } }]);
    await until(() => buttons("Connect X account").length === 1, "the disconnected section");
  });
});

describe("where it appears", () => {
  it("renders nothing and reads nothing off hosted", async () => {
    await ui.render(section({ hosted: false }));
    await settle();
    assert.equal(ui.container.querySelector(".xpost"), null);
    assert.deepEqual(calls, []);
    await ui.render(section({ hosted: null }));
    await settle();
    assert.deepEqual(calls, []);
  });

  it("signed out, it says so and offers nothing to press", async () => {
    routes["GET /api/x/account"] = () => json({ error: "Sign in to change this." }, 401);
    await shown({ owner: "" });
    assert.match(text(), /Sign in to connect an X account/);
    assert.equal(ui.container.querySelectorAll(".xpost button").length, 0);
  });

  it("opens itself when the page is /settings#x-posting, where /connect/x sends an owner back", async () => {
    ui.dom.reconfigure({ url: "https://app.example.test/settings#x-posting" });
    await shown();
    assert.equal(ui.container.querySelector("details")?.open, true);
  });
});

// ── the words ───────────────────────────────────────────────────────────────

const SRC = readFileSync(new URL("./XPosting.tsx", import.meta.url), "utf8");
const SETTINGS = readFileSync(new URL("./screens/Settings.tsx", import.meta.url), "utf8");

describe("the warning keeps its words", () => {
  it("every sentence of the warning is in the source, verbatim", () => {
    for (const said of [
      "Post on X as ${handle}?",
      "Your Merryman will post from whichever X account is connected — right now that's ${handle}.",
      "It writes its own posts: a hello first, then the odd casual thought and now and then a coin it bought and why. It never posts trade alerts, error messages, prices or amounts.",
      "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
      "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto.",
      "Let it post as ${handle}",
      "Not now",
    ]) {
      assert.ok(SRC.includes(said), `the warning lost: "${said}"`);
    }
  });

  it("the lead sentence is bold, and the warning is the only place that sends 'enable'", () => {
    assert.match(SRC, /<strong>\{asking\.replies \? replyWarningLead\(asking\.handle\) : warningLead\(asking\.handle\)\}<\/strong>/);
    assert.equal(SRC.split('action: "enable"').length - 1, 1, "one write turns posting on");
    const at = SRC.indexOf('action: "enable"');
    // Bounded by the next declaration at the component's own indentation, so
    // the write must sit inside confirmWarning's body and nowhere after it.
    const inside = SRC.lastIndexOf("\n  const confirmWarning", at);
    const next = SRC.indexOf("\n  const ", inside + 1);
    assert.ok(inside > 0 && at < next, "the enable write lives in the warning's confirm");
  });

  it("says 'unavailable' in the routes' own words (X_COPY.unavailable), as iOS does", () => {
    assert.ok(SRC.includes(`unavailable: "${X_COPY.unavailable}"`));
  });

  it("re-reads well inside the ten minutes every post waits, and once more past the first plan pass after enabling", () => {
    assert.match(SRC, /const POLL_MS = 45_000;/);
    assert.match(SRC, /const AFTER_ENABLE_MS = 70_000;/);
  });

  it("the caption and the 'on' line both say whichever account is connected", () => {
    assert.ok(SRC.includes("Your Merryman will post from whichever X account you approve there, so check which account you're signed into on X first."));
    assert.ok(SRC.includes("Posting from ${handle} — whichever X account is connected."));
    assert.ok(SRC.includes("No trade alerts, no error messages, no numbers."));
  });

  it("is mounted on Settings as its own section, hosted only, with the form's owner", () => {
    // The heading renders through the catalogue like the rest of the screen —
    // the mount (hosted-only, form's owner) is what this pins.
    assert.match(SETTINGS, /\{hosted === true && \(\s*<details className="settings-group" id="x-posting"><summary>\{t\("settings\.text\.postingOnX"\)\}<\/summary>\s*<XPosting owner=\{view\.owner\} hosted=\{hosted\} \/>/);
    assert.equal(EN["settings.text.postingOnX" as MessageKey] as string, "Posting on X");
  });
});
