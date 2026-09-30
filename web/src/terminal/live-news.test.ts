/**
 * A LANDED TRADE, AS THE SHELL ANNOUNCES IT — executed against a DOM.
 *
 * The feed arrives read by read; the hook is handed each one as the shell
 * hands it. It must count only while the tab is hidden, clear the count when
 * the reader comes back, chime only when the reader asked for sound, and do
 * none of it on the first read.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";

import { testDom } from "./test-dom";
import type { ReadState, Thesis } from "./live";
import { useLiveNews, useSoundPref } from "./live-news";

const NOW_MS = 1_800_000_000_000;
let n = 0;
/** A landed fill of its own coin: separate fills are separate agent/side/coin times (arrivals.ts). */
const fill = (action: "buy" | "sell" = "buy"): Thesis =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action,
    symbol: `COIN${n + 1}`,
    sizeUsdg: 5,
    reason: "r",
    paper: false,
    head: "",
    outcome: "landed",
    at: NOW_MS / 1000 - 20,
    postId: (++n).toString(16).padStart(32, "0"),
  }) as Thesis;

function Probe(props: { theses: Thesis[]; read: ReadState; soundOn: boolean; play: (side: "buy" | "sell") => void }) {
  const unseen = useLiveNews({ ...props, nowMs: () => NOW_MS });
  return createElement("i", null, String(unseen));
}

describe("the shell announcing landed trades", () => {
  it("counts in the title only while hidden, chimes only when asked, and never on the first read", async () => {
    const t = testDom();
    let hidden = false;
    Object.defineProperty(t.dom.window.document, "hidden", { configurable: true, get: () => hidden });
    t.dom.window.document.title = "merrymen";
    const played: string[] = [];
    const play = (side: "buy" | "sell") => played.push(side);
    const probe = (theses: Thesis[], soundOn: boolean, read: ReadState = "ok") =>
      createElement(Probe, { theses, read, soundOn, play });
    try {
      const walkedInOn = fill();
      await t.render(probe([walkedInOn], true));
      assert.deepEqual(played, [], "the first read is what the reader walked in on");
      assert.equal(t.container.textContent, "0");

      const whileLooking = fill("sell");
      await t.render(probe([whileLooking, walkedInOn], true));
      assert.deepEqual(played, ["sell"], "sound on: one tone for a new fill");
      assert.equal(t.container.textContent, "0", "the tab is visible, so nothing to count");

      hidden = true;
      const away1 = fill();
      const away2 = fill();
      await t.render(probe([away1, away2, whileLooking, walkedInOn], false));
      assert.deepEqual(played, ["sell"], "sound off: silence");
      assert.equal(t.container.textContent, "2");
      assert.equal(t.dom.window.document.title, "(2) merrymen");

      await t.render(probe([], true, "unreadable"));
      assert.equal(t.container.textContent, "2", "a failed read is not news");

      hidden = false;
      await act(async () => {
        t.dom.window.document.dispatchEvent(new t.dom.window.Event("visibilitychange"));
      });
      assert.equal(t.container.textContent, "0");
      assert.equal(t.dom.window.document.title, "merrymen", "the page's own title, given back");
    } finally {
      await t.close();
    }
  });

  it("A NEW FILL WHILE AWAY IS COUNTED IN THE TITLE — one tone for the read, and nothing it did not see land", async () => {
    // The count is by newest time only (arrivals.ts): two fills of one row
    // between two reads are one, and an older order landing late under the
    // same newest time is not counted. Undercounting is the price of a title
    // that never counts a fill nobody made.
    const t = testDom();
    Object.defineProperty(t.dom.window.document, "hidden", { configurable: true, get: () => true });
    t.dom.window.document.title = "merrymen";
    const played: string[] = [];
    const probe = (theses: Thesis[]) =>
      createElement(Probe, { theses, read: "ok", soundOn: true, play: (s) => played.push(s) });
    try {
      const leg = { ...fill(), at: NOW_MS / 1000 - 3000, said: 1 };
      await t.render(probe([leg]));
      await t.render(probe([{ ...leg, at: NOW_MS / 1000 - 5, said: 3 }]));
      assert.equal(t.dom.window.document.title, "(1) merrymen");
      assert.deepEqual(played, ["buy"]);
      await t.render(probe([{ ...leg, at: NOW_MS / 1000 - 5, said: 4 }]));
      assert.equal(t.dom.window.document.title, "(1) merrymen", "a count that grew under the same time is not evidence of a fill");
      await t.render(probe([{ ...leg, at: NOW_MS / 1000 - 2, said: 5 }]));
      assert.equal(t.dom.window.document.title, "(2) merrymen", "a newer time is");
    } finally {
      await t.close();
    }
  });

  it("the sound toggle: off by default, remembered when turned on, and a broken storage is simply off", async () => {
    const t = testDom();
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    let toggle: () => void = () => {};
    function Sound({ source }: { source: () => Storage | null }) {
      const [on, flip] = useSoundPref(source);
      toggle = flip;
      return createElement("b", null, on ? "on" : "off");
    }
    try {
      await t.render(createElement(Sound, { source: () => storage }));
      assert.equal(t.container.textContent, "off");
      await act(async () => toggle());
      assert.equal(t.container.textContent, "on");
      assert.equal(store.get("merrymen.sound"), "on");
      await t.remount(createElement(Sound, { source: () => storage }));
      assert.equal(t.container.textContent, "on", "remembered on the next visit");
      await t.remount(
        createElement(Sound, {
          source: () => {
            throw new Error("storage disabled");
          },
        }),
      );
      assert.equal(t.container.textContent, "off");
      await act(async () => toggle());
      assert.equal(t.container.textContent, "on", "and still works for this visit");
    } finally {
      await t.close();
    }
  });

  it("an unreadable first answer does not seed: the first READ answer still stays quiet", async () => {
    const t = testDom();
    const played: string[] = [];
    try {
      const rows = [fill()];
      await t.render(createElement(Probe, { theses: [], read: "unreadable", soundOn: true, play: (s) => played.push(s) }));
      await t.render(createElement(Probe, { theses: rows, read: "ok", soundOn: true, play: (s) => played.push(s) }));
      assert.deepEqual(played, []);
    } finally {
      await t.close();
    }
  });
});
