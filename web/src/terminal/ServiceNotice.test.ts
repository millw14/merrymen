/**
 * THE BANNER DRAWS THE OPERATOR'S TEXT AS TEXT, AND FORGETS A DISMISSAL ON ANY EDIT.
 *
 * Rendered, so what is tested is what a visitor is shown: markup in a notice
 * is shown as its characters, a link the shared check refuses never becomes an
 * anchor even if the route sent it, `tradingPaused` changes one label and
 * nothing else, and a dismissal holds only for the exact notice dismissed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as React from "react";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServiceNotice as Notice } from "@/lib/service-notice";
import { DISMISSED_KEY, ServiceNotice, ServiceNoticeView } from "./ServiceNotice";
import { json, testDom } from "./test-dom";

(globalThis as unknown as { React: typeof React }).React = React;

const NOTICE: Notice = {
  title: "Trading is paused",
  body: "We are finishing a recovery.\nWe will update this notice when trading resumes.",
  updatedAt: "2026-10-05T18:00:00.000Z",
  tradingPaused: false,
  links: [{ label: "Your account", href: "https://app.merrymen.dev/you" }],
};
const SCRIPT = "<script>alert(1)</script>";
const view = (notice: Notice) => renderToStaticMarkup(createElement(ServiceNoticeView, { notice, onDismiss: () => {} }));

describe("what the banner draws", () => {
  it("draws <script> as text, wherever the operator put it", () => {
    const html = view({ ...NOTICE, title: SCRIPT, body: SCRIPT, links: [{ label: SCRIPT, href: "https://merrymen.dev/" }] });
    assert.doesNotMatch(html, /<script/i);
    assert.equal(html.split("&lt;script&gt;alert(1)&lt;/script&gt;").length - 1, 3, "title, body and link label are all escaped");
  });

  it("says when the notice was last updated, as a machine-readable time", () => {
    const html = view(NOTICE);
    assert.match(html, /<time dateTime="2026-10-05T18:00:00.000Z"[^>]*>Updated [^<]*\d[^<]*<\/time>/);
  });

  it("links only to the validated href, in the same tab", () => {
    const html = view(NOTICE);
    assert.match(html, /<a href="https:\/\/app\.merrymen\.dev\/you" rel="noopener noreferrer">Your account<\/a>/);
    assert.doesNotMatch(html, /target=/);
    assert.doesNotMatch(view({ ...NOTICE, links: [] }), /<ul|<a /);
  });

  it("tradingPaused changes the label's words and nothing else", () => {
    const open = view(NOTICE);
    const paused = view({ ...NOTICE, tradingPaused: true });
    assert.match(open, />Service notice</);
    assert.match(paused, />Trading paused</);
    assert.equal(paused.replaceAll("Trading paused", "Service notice"), open, "same markup, same classes, same role");
  });

  it("never sets HTML from a string", () => {
    const code = readFileSync(new URL("./ServiceNotice.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("the banner in the shell", () => {
  let ui: ReturnType<typeof testDom>;
  const originalFetch = globalThis.fetch;
  let answer: () => Promise<Response>;
  let requests: string[];

  /** Let the read resolve and React apply it. */
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const mount = async () => { await ui.remount(createElement(ServiceNotice)); await settle(); };
  const shown = () => ui.container.querySelector(".service-notice");

  beforeEach(() => {
    ui = testDom();
    requests = [];
    answer = async () => json({ notice: NOTICE });
    globalThis.fetch = async (input) => { requests.push(String(input)); return answer(); };
  });
  afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });

  it("renders nothing when there is no notice", async () => {
    answer = async () => json({ notice: null });
    await mount();
    assert.deepEqual(requests, ["/api/service-notice"]);
    assert.equal(ui.container.innerHTML, "");
  });

  it("renders the route's notice, with <script> left as text in the DOM", async () => {
    answer = async () => json({ notice: { ...NOTICE, title: SCRIPT } });
    await mount();
    assert.ok(shown());
    assert.equal(ui.container.querySelector("script"), null);
    assert.equal(ui.container.querySelector("strong")?.textContent, SCRIPT);
  });

  it("re-checks the answer: a refused link hides the notice even if the route sent it", async () => {
    for (const href of ["javascript:alert(1)", "http://app.merrymen.dev/you", "https://evil.example/"]) {
      answer = async () => json({ notice: { ...NOTICE, links: [{ label: "Claim", href }] } });
      await mount();
      assert.equal(shown(), null, href);
      assert.equal(ui.container.querySelector("a"), null, href);
    }
    answer = async () => json({ notice: { ...NOTICE, extra: "field" } });
    await mount();
    assert.equal(shown(), null, "an unknown field is refused here as it is at the env var");
  });

  it("renders nothing when the read fails, rather than an error", async () => {
    answer = async () => { throw new TypeError("fetch failed"); };
    await mount();
    assert.equal(ui.container.innerHTML, "");
  });

  it("stays dismissed for the same notice, and comes back after ANY edit", async () => {
    await mount();
    assert.ok(shown());
    await ui.click("Dismiss");
    assert.equal(shown(), null);
    assert.ok(localStorage.getItem(DISMISSED_KEY), "the dismissal is remembered");

    await mount();
    assert.equal(shown(), null, "the same notice stays dismissed after a reload");

    const edits: Partial<Notice>[] = [
      { body: "We are finishing a recovery." },
      { updatedAt: "2026-10-05T19:00:00.000Z" },
      { tradingPaused: true },
      { links: [] },
    ];
    for (const edit of edits) {
      answer = async () => json({ notice: { ...NOTICE, ...edit } });
      await mount();
      assert.ok(shown(), `an edit brings it back: ${JSON.stringify(edit)}`);
    }
  });

  it("dismisses for the page when storage is unavailable", async () => {
    const storage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      await mount();
      assert.ok(shown());
      await ui.click("Dismiss");
      assert.equal(shown(), null);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
    }
  });
});
