/**
 * X'S CALLBACK PAGE: what the redirect means, and what the page does with it.
 *
 * The decision (callback.ts) is executed directly; the page (XConnectClient)
 * is rendered in a DOM against a scripted fetch, because the properties that
 * matter are about ORDER and ABSENCE — the code is out of the address bar
 * before anything is sent, a web finish is one same-origin POST, an iOS state
 * sends nothing at all, and the page says posting is on only when the finish
 * answered that it is (a same-account reconnect keeps its consent).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { json, testDom } from "@/terminal/test-dom";
import { newState, stateClient } from "../../../../../worker/src/xpost/client";
import { X_DID_NOT_FINISH, callbackClient, readCallback } from "./callback";
import { XConnectClient } from "./XConnectClient";

const W = `w.${"a".repeat(32)}`;
const I = `i.${"B".repeat(32)}`;

describe("what the redirect means", () => {
  it("routes by the same state shape the server mints, and nothing else", () => {
    const samples = [newState("web"), newState("ios"), W, I, "w.short", `x.${"a".repeat(32)}`, `w.${"a".repeat(33)}`, "", null, 7, `i.${"a".repeat(31)}=`];
    for (const s of samples) assert.equal(callbackClient(s), stateClient(s), `disagrees on ${String(s)}`);
  });

  it("an approved web connect is finished here", () => {
    assert.deepEqual(readCallback(`?code=abc&state=${W}`), { kind: "finish", code: "abc", state: W });
  });

  it("a web connect the owner said no to is declined, and nothing is sent", () => {
    assert.deepEqual(readCallback(`?error=access_denied&state=${W}`), { kind: "declined" });
  });

  it("any other error from X is X failing, not the owner saying no", () => {
    for (const error of ["server_error", "temporarily_unavailable", "invalid_scope", "unauthorized_client", "invalid_request", "ACCESS_DENIED"]) {
      assert.deepEqual(readCallback(`?error=${error}&state=${W}`), { kind: "failed", message: X_DID_NOT_FINISH }, error);
      // Even alongside a code: an error answer is never finished.
      assert.equal(readCallback(`?code=abc&error=${error}&state=${W}`).kind, "failed", error);
    }
    assert.equal(X_DID_NOT_FINISH, "X couldn't finish connecting. Nothing was saved — try again in a moment.");
  });

  it("an iOS connect is handed to the app with only the keys it needs", () => {
    const r = readCallback(`?code=abc%2Bdef&state=${I}&evil=javascript:1`);
    assert.equal(r.kind, "ios");
    const href = (r as { href: string }).href;
    assert.ok(href.startsWith("merrymen://x-connect?"));
    const q = new URLSearchParams(href.slice(href.indexOf("?")));
    assert.deepEqual([...q.keys()].sort(), ["code", "state"]);
    assert.equal(q.get("code"), "abc+def");
    assert.equal(q.get("state"), I);
    assert.deepEqual(
      [...new URLSearchParams((readCallback(`?error=access_denied&state=${I}`) as { href: string }).href.split("?")[1]).entries()],
      [["state", I], ["error", "access_denied"]],
    );
  });

  it("anything without a state we could have issued is nothing", () => {
    for (const q of ["", "?code=abc", "?code=abc&state=nope", `?state=${W}`, `?state=${I}`]) {
      assert.deepEqual(readCallback(q), { kind: "nothing" }, q);
    }
  });
});

describe("the page, rendered", () => {
  let ui: ReturnType<typeof testDom>;
  const originalFetch = globalThis.fetch;
  let calls: { url: string; init?: RequestInit; searchAtSend: string }[];
  let answer: () => Response;

  beforeEach(() => {
    ui = testDom();
    calls = [];
    answer = () => json({ ok: true, username: "merry_poster" });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init, searchAtSend: ui.dom.window.location.search });
      return answer();
    }) as typeof fetch;
  });

  afterEach(async () => {
    await ui.close();
    globalThis.fetch = originalFetch;
    mock.restoreAll();
  });

  const at = (query: string) => ui.dom.reconfigure({ url: `https://app.example.test/connect/x${query}` });
  const text = () => ui.container.textContent ?? "";
  const settle = async () => {
    for (let i = 0; i < 10 && text().includes("Finishing with X"); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it("scrubs the code from the address bar BEFORE it POSTs the finish, same-origin, naming nobody", async () => {
    at(`?code=the-code&state=${W}`);
    await ui.render(createElement(XConnectClient));
    await settle();
    assert.equal(ui.dom.window.location.search, "");
    assert.equal(ui.dom.window.location.pathname, "/connect/x");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "/api/x/connect");
    assert.equal(calls[0]!.searchAtSend, "", "the code was still in the URL when the request left");
    assert.equal(calls[0]!.init?.method, "POST");
    assert.equal(calls[0]!.init?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { action: "finish", code: "the-code", state: W });
    assert.match(text(), /Connected as @merry_poster/);
    assert.match(text(), /won.t post anything yet/);
    assert.ok(ui.container.querySelector('a[href="/settings#x-posting"]'));
  });

  it("says posting is BACK ON when the finish says so — a same-account reconnect keeps the consent — never 'won't post anything yet'", async () => {
    answer = () => json({ ok: true, username: "merry_poster", postingEnabled: true });
    at(`?code=the-code&state=${W}`);
    await ui.render(createElement(XConnectClient));
    await settle();
    assert.match(text(), /Connected as @merry_poster/);
    assert.match(text(), /Posting is back on: you allowed your Merryman to post from @merry_poster before, so it posts from it again\./);
    assert.match(text(), /skip it or turn posting off/);
    assert.doesNotMatch(text(), /won.t post anything yet/);
  });

  it("an answer that does not say posting is on is 'not yet' (an older server, or anything but true)", async () => {
    for (const postingEnabled of [undefined, "true", 1, null]) {
      answer = () => json({ ok: true, username: "merry_poster", postingEnabled });
      at(`?code=the-code&state=${W}`);
      await ui.remount(createElement(XConnectClient));
      await settle();
      assert.match(text(), /won.t post anything yet/, String(postingEnabled));
      assert.doesNotMatch(text(), /back on/);
    }
  });

  it("promises only the review window the planner keeps: at least ten minutes under Coming up", async () => {
    at("");
    await ui.render(createElement(XConnectClient));
    assert.match(text(), /Each post then waits there under Coming up for at least ten minutes, and you can skip it\./);
    assert.doesNotMatch(text(), /you see every post/);
  });

  it("shows the route's own sentence when the finish is refused", async () => {
    answer = () => json({ error: "That sign-in link expired or was already used — start again." }, 400);
    at(`?code=the-code&state=${W}`);
    await ui.render(createElement(XConnectClient));
    await settle();
    assert.match(text(), /expired or was already used/);
    assert.doesNotMatch(text(), /Connected as/);
  });

  it("a declined connect sends nothing and says so", async () => {
    at(`?error=access_denied&state=${W}`);
    await ui.render(createElement(XConnectClient));
    assert.equal(calls.length, 0);
    assert.match(text(), /You didn.t connect an X account\./);
    assert.equal(ui.dom.window.location.search, "");
  });

  it("an X failure sends nothing and says X couldn't finish — never that the owner didn't connect", async () => {
    at(`?error=server_error&state=${W}`);
    await ui.render(createElement(XConnectClient));
    assert.equal(calls.length, 0);
    assert.match(text(), /X couldn.t finish connecting\. Nothing was saved — try again in a moment\./);
    assert.doesNotMatch(text(), /You didn.t connect/);
    assert.ok(ui.container.querySelector('a[href="/settings#x-posting"]'));
    assert.equal(ui.dom.window.location.search, "");
  });

  it("an iOS connect sends nothing from here and hands the code to the app", async () => {
    // jsdom cannot follow a merrymen:// navigation and says so on the console.
    mock.method(console, "error", () => {});
    at(`?code=the-code&state=${I}`);
    await ui.render(createElement(XConnectClient));
    assert.equal(calls.length, 0);
    const link = ui.container.querySelector("a[href^='merrymen://']");
    assert.ok(link, "a way into the app if the automatic hand-off is blocked");
    assert.equal(link.getAttribute("href"), `merrymen://x-connect?code=the-code&state=${encodeURIComponent(I)}`);
    assert.equal(ui.dom.window.location.search, "");
  });

  it("a page opened with nothing to finish sends nothing", async () => {
    at("");
    await ui.render(createElement(XConnectClient));
    assert.equal(calls.length, 0);
    assert.match(text(), /Nothing to finish here/);
  });
});

describe("what ships to the browser", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("the callback page imports neither node:crypto nor the X client that reads the secret", () => {
    for (const src of [read("./XConnectClient.tsx"), read("./callback.ts"), read("./page.tsx")]) {
      assert.doesNotMatch(src, /from\s+["']node:crypto["']/);
      assert.doesNotMatch(src, /from\s+["'][^"']*xpost\/client["']/);
    }
  });

  it("the callback path is sent no-referrer and may not be framed", () => {
    const config = readFileSync(new URL("../../../../next.config.mjs", import.meta.url), "utf8");
    assert.match(config, /\{\s*source:\s*"\/connect\/x",\s*headers:\s*noFrame\s*\}/);
    assert.match(config, /const noFrame = \[[\s\S]*?"Referrer-Policy", value: "no-referrer"[\s\S]*?\];/);
    assert.match(config, /const noFrame = \[[\s\S]*?"frame-ancestors 'none'"[\s\S]*?\];/);
  });
});
