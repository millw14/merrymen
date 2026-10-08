import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, act } from "react";
import type { ChartEntry, ChartResponse } from "../lib/perps-chart-data";
import { PerpsScreen, PerpsScreenPreview, type PerpsScreenProps } from "./PerpsScreen";
import { testDom, json } from "./test-dom";
import { forgetAudioForTest } from "./chime";

const NOW = Math.floor(1_790_697_060_000 / 300_000) * 300_000;
const entry = (id: string, timeMs: number): ChartEntry => ({ id, timeMs, price: 100, priceExact: "100.00", size: "1", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "open" });
const answer = (entries: ChartEntry[] = [], generatedAtMs = NOW): ChartResponse => ({ state: "ok", market: "BTC-PERP", book: "paper", window: "24h", generatedAtMs, entries: [...entries].sort((a, b) => a.timeMs - b.timeMs), unknownFills: 0, truncated: false, candles: { state: "ok", bars: [{ timeMs: NOW - 300_000, open: 99, high: 101, low: 98, close: 100 }], gaps: [], stale: false, asOfMs: NOW } });
const props: PerpsScreenProps = { perps: undefined, ownerKey: "owner-a", hasAgent: true, onSpot() {}, onSettings() {} };

function audioMock() {
  let tones = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  class AudioContextMock {
    state = "running";
    currentTime = 0;
    destination = {};
    resume = async () => {};
    createOscillator() { return { type: "sine", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { tones++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: AudioContextMock });
  forgetAudioForTest();
  return { get tones() { return tones; }, close() { forgetAudioForTest(); if (original) Object.defineProperty(globalThis, "AudioContext", original); else Reflect.deleteProperty(globalThis, "AudioContext"); } };
}

describe("private perps screen", () => {
  it("keeps the last truthful frame when a refresh mixes books or contains malformed chart fields", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    let payload: unknown = answer([entry("verified", NOW - 1000)]);
    globalThis.fetch = async () => json(payload);
    try {
      await dom.render(createElement(PerpsScreen, props));
      payload = { ...answer(), entries: [{ ...entry("wrong-book", NOW - 500), book: "live", price: 150, priceExact: "150.00" }] };
      await dom.click("Refresh");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      assert.match(dom.container.textContent ?? "", /Showing the last successful read/);
      assert.doesNotMatch(dom.container.textContent ?? "", /150\.00/);
      payload = { ...answer(), candles: { ...answer().candles, gaps: null } };
      await dom.click("Refresh");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      assert.match(dom.container.textContent ?? "", /chart response could not be read/);
    } finally { globalThis.fetch = original; await dom.close(); }
  });
  it("keeps historical and duplicate entries silent; animates and chimes only new executions after opt-in", async () => {
    const dom = testDom();
    const sound = audioMock();
    const fetchOriginal = globalThis.fetch;
    let payload = answer([entry("old", NOW - 1000)]);
    globalThis.fetch = async () => json(payload);
    try {
      await dom.render(createElement(PerpsScreen, props));
      assert.equal(dom.container.querySelectorAll(".is-fresh").length, 0);
      assert.equal(sound.tones, 0);
      await dom.click("♩ Sound off");
      assert.equal(sound.tones, 0, "enabling sound does not play the historical batch");
      payload = answer([entry("old", NOW - 1000), entry("new", NOW + 1000)], NOW + 2000);
      await dom.click("Refresh");
      assert.equal(sound.tones, 1);
      assert.equal(dom.container.querySelectorAll(".perps-entry-marker.is-fresh").length, 1);
      await dom.click("Refresh");
      assert.equal(sound.tones, 1, "the same fill must never chime twice");
      payload = answer([entry("old", NOW - 1000), entry("new", NOW + 1000), entry("backfill", NOW - 500)], NOW + 3000);
      await dom.click("Refresh");
      assert.equal(sound.tones, 1, "late historical data is not a new execution");
      payload = { ...answer([entry("other-book", NOW + 5000)], NOW + 6000), book: "live", entries: [{ ...entry("other-book", NOW + 5000), book: "live" }] };
      await dom.click("Live");
      assert.equal(sound.tones, 1, "switching books establishes a silent baseline");
      assert.equal(dom.container.querySelectorAll(".perps-entry-marker.is-fresh").length, 0);
    } finally { globalThis.fetch = fetchOriginal; await dom.close(); sound.close(); }
  });

  it("clears private history on auth failure and sends only bounded chart parameters", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    const urls: string[] = [];
    let status = 200;
    globalThis.fetch = async (url) => { urls.push(String(url)); return json(answer([entry("private", NOW - 1000)]), status); };
    try {
      await dom.render(createElement(PerpsScreen, props));
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      assert.equal(urls[0], "/api/perps/chart?market=BTC-PERP&book=paper&window=24h");
      status = 401;
      await dom.click("Refresh");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 0);
      assert.match(dom.container.textContent ?? "", /Sign in again/);
      await dom.render(createElement(PerpsScreen, { ...props, ownerKey: null }));
      assert.equal(urls.filter(url => url.startsWith("/api/perps/chart?")).length, 2, "signed-out screen performs no private chart read");
      assert.ok(urls.at(-1)?.startsWith("/api/perps/market?"));
      assert.doesNotMatch(dom.container.textContent ?? "", /100\.00/);
    } finally { globalThis.fetch = original; await dom.close(); }
  });

  it("keeps last known history visibly stale after refresh failure and obeys 429 cooldown", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    let status = 200;
    let calls = 0;
    globalThis.fetch = async (url) => { if(String(url).startsWith("/api/perps/chart?")) calls++; return json(answer([entry("known", NOW - 1000)]), status); };
    try {
      await dom.render(createElement(PerpsScreen, props));
      status = 500;
      await dom.click("Refresh");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      assert.match(dom.container.textContent ?? "", /Showing the last successful read/);
      status = 429;
      await dom.click("Refresh");
      assert.match(dom.container.textContent ?? "", /Waiting before trying again/);
      await dom.click("Refresh");
      assert.equal(calls, 3, "manual refresh must also respect rate limit cooldown");
    } finally { globalThis.fetch = original; await dom.close(); }
  });

  it("drops old owner data immediately while the next owner's read is pending", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    globalThis.fetch = async () => json(answer([entry("private", NOW - 1000)]));
    try {
      await dom.render(createElement(PerpsScreen, props));
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); });
      await act(async () => { await dom.render(createElement(PerpsScreen, { ...props, ownerKey: "owner-b" })); });
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 0);
      assert.match(dom.container.textContent ?? "", /Reading your chart/);
    } finally { globalThis.fetch = original; await dom.close(); }
  });
});


describe("isolated tactical preview", () => {
  it("labels fictional data and never fetches even when changing books", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("preview must not fetch"); };
    try {
      await dom.render(createElement(PerpsScreenPreview, { ...props, data: answer([entry("fixture", NOW - 1000)]) }));
      assert.match(dom.container.textContent ?? "", /DESIGN PREVIEW · FICTIONAL DATA · NO TRADING/);
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 1);
      assert.ok(dom.container.querySelector(".perps-command-grid > .perps-position-section"));
      await dom.click("Live");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 0, "paper fixture must not appear as live history");
      assert.equal(calls, 0);
    } finally { globalThis.fetch = original; await dom.close(); }
  });
});

describe("mobile command dock", () => {
  it("shows one accessible panel, preserves chart selection and baseline, and restores the desktop layout", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    let calls = 0;
    let mobile = true;
    const listeners = new Set<() => void>();
    Object.defineProperty(dom.dom.window, "matchMedia", { configurable: true, value: (query: string) => ({
      matches: query === "(max-width: 1099px)" && mobile,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }) });
    globalThis.fetch = async (url) => { if(String(url).startsWith("/api/perps/chart?")) calls++; return json(answer([entry("retained", NOW - 1000)])); };
    const panel = (name: string) => dom.container.querySelector<HTMLElement>(`[id$="-panel-${name}"]`)!;
    const tab = (name: string) => dom.container.querySelector<HTMLButtonElement>(`[id$="-tab-${name}"]`)!;
    try {
      await dom.render(createElement(PerpsScreen, props));
      assert.equal(panel("trade").hidden, false);
      assert.equal(panel("positions").hidden, true);
      assert.equal(panel("playbook").hidden, true);
      assert.equal(tab("positions").getAttribute("aria-label"), "Positions · positions unknown");
      const originalRow = dom.container.querySelector<HTMLButtonElement>(".perps-entry-row")!;
      await act(async () => { originalRow.click(); tab("positions").click(); });
      assert.equal(panel("trade").hidden, true);
      assert.equal(panel("positions").hidden, false);
      assert.match(panel("positions").textContent ?? "", /Current positions are unknown/);
      await act(async () => { tab("positions").dispatchEvent(new dom.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
      assert.equal(panel("feed").hidden, false);
      assert.equal(tab("feed").getAttribute("aria-selected"), "true");
      assert.equal(dom.dom.window.document.activeElement, tab("feed"));
      await act(async () => { tab("trade").click(); });
      assert.equal(dom.container.querySelector(".perps-entry-row"), originalRow, "view navigation must not remount the owner chart");
      assert.equal(originalRow.getAttribute("aria-pressed"), "true");
      assert.equal(calls, 1, "view navigation must not reset the fill baseline or refetch");
      await act(async () => { mobile = false; for (const listener of listeners) listener(); });
      assert.equal(dom.container.querySelector(".perps-mobile-dock"), null);
      for (const name of ["trade", "positions"]) assert.equal(panel(name).hidden, false, "desktop keeps chart and positions beside one another");
      assert.equal(panel("playbook").hidden,true,"secondary Trade views are selected explicitly");
    } finally { globalThis.fetch = original; await dom.close(); }
  });

  it("resets mobile navigation and removes hidden private entries when the owner signs out", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    Object.defineProperty(dom.dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    globalThis.fetch = async () => json(answer([entry("private", NOW - 1000)]));
    try {
      await dom.render(createElement(PerpsScreen, props));
      await act(async () => { dom.container.querySelector<HTMLButtonElement>('[id$="-tab-feed"]')!.click(); });
      await dom.render(createElement(PerpsScreen, { ...props, ownerKey: null }));
      assert.equal(dom.container.querySelector(".perps-screen")?.getAttribute("data-mobile-view"), "trade");
      assert.equal(dom.container.querySelectorAll(".perps-entry-row").length, 0);
      assert.match(dom.container.querySelector('[id$="-panel-positions"]')?.textContent ?? "", /Only the owner can access/);
    } finally { globalThis.fetch = original; await dom.close(); }
  });
});


describe("public market access", () => {
  it("renders real candles for visitors without requesting private records", async () => {
    const dom = testDom(); const original = globalThis.fetch; const urls: string[] = [];
    globalThis.fetch = async url => { urls.push(String(url)); return json({...answer(), state:"not-configured"}); };
    try {
      await dom.render(createElement(PerpsScreen, {...props, ownerKey:null, hasAgent:false}));
      assert.equal(urls.length,1); assert.equal(urls[0], "/api/perps/market?market=BTC-PERP&window=24h");
      assert.ok(dom.container.querySelector(".perps-chart"));
      assert.equal(dom.container.querySelector(".perps-entry-history"),null);
      assert.equal(dom.container.querySelector(".perps-activity"),null);
      assert.match(dom.container.textContent ?? "",/Public market prices/);
      assert.match(dom.container.textContent ?? "",/LIVE MARKET DATA/);
      assert.doesNotMatch(dom.container.textContent ?? "",/PAPER PRACTICE|Simulated entries/);
      assert.equal(dom.container.querySelector('[aria-label="Entry book"]'),null);
    } finally {globalThis.fetch=original;await dom.close();}
  });
  it("keeps real candles visible when the private tape is unreadable", async () => {
    const dom = testDom(); const original = globalThis.fetch;
    globalThis.fetch=async()=>json({...answer(),state:"unreadable"});
    try {
      await dom.render(createElement(PerpsScreen,props));
      assert.ok(dom.container.querySelector(".perps-chart"));
      assert.match(dom.container.textContent ?? "",/Entry counts are unknown/);
      assert.doesNotMatch(dom.container.textContent ?? "",/No recorded entries in/);
    } finally {globalThis.fetch=original;await dom.close();}
  });
});

describe("doctrine intent for new agents", () => {
  it("carries the inspected profile into creation without saving and resets it for a new owner", async () => {
    const dom = testDom(); const original = globalThis.fetch;
    const methods: string[] = []; const selections: Array<string | undefined> = [];
    globalThis.fetch = async (_url, init) => { methods.push(init?.method ?? "GET"); return json({...answer(), state:"not-configured"}); };
    const setupProps = {...props, hasAgent:false, session:{hosted:false,address:null}, onCreate:(style?: string)=>selections.push(style)};
    try {
      await dom.render(createElement(PerpsScreen, setupProps));
      await dom.click("Playbook");
      await act(async()=>dom.container.querySelector<HTMLButtonElement>('[aria-label^="Inspect Razor:"]')!.click());
      await dom.click("Review controls ↗");
      // The control room is loaded on first use, not in the market's initial bundle.
      await act(async()=>{ await new Promise(resolve=>setTimeout(resolve,100)); });
      await dom.click("Create your agent ↗");
      assert.deepEqual(selections,["scalp-breakout"]);
      assert.ok(methods.every(method=>method==="GET"), "inspecting and starting setup never saves settings");
      await dom.render(createElement(PerpsScreen,{...setupProps,ownerKey:"owner-b"}));
      await dom.click("Control room ↗");
      await dom.click("Create your agent ↗");
      assert.deepEqual(selections,["scalp-breakout",undefined],"a different owner does not inherit the previous doctrine draft");
    } finally {globalThis.fetch=original;await dom.close();}
  });
});


it("opens Feed and Account slots without remounting the owner chart", async () => {
  const dom=testDom(), original=globalThis.fetch;
  globalThis.fetch=async()=>json(answer([entry("kept",NOW-1000)]));
  try {
    const slotProps={...props,feedContent:createElement("p",null,"Public fleet posts"),accountContent:createElement("p",null,"Owner account controls")};
    await dom.render(createElement(PerpsScreen,slotProps));
    assert.doesNotMatch(dom.container.textContent ?? "",/Owner account controls/,"hidden Account content must not mount");
    const row=dom.container.querySelector(".perps-entry-row");
    await dom.click("Fleet feed");
    assert.equal(dom.container.querySelector<HTMLElement>('[id$="-panel-feed"]')!.hidden,false);
    assert.equal(dom.container.querySelector<HTMLElement>(".perps-command-grid")!.hidden,true);
    await dom.click("Account");
    assert.equal(dom.container.querySelector<HTMLElement>('[id$="-panel-account"]')!.hidden,false);
    assert.match(dom.container.textContent ?? "",/Owner account controls/);
    await dom.render(createElement(PerpsScreen,{...slotProps,requestedView:{view:"feed",revision:1}}));
    assert.doesNotMatch(dom.container.textContent ?? "",/Owner account controls/,"leaving Account unmounts its snapshot");
    assert.equal(dom.container.querySelector<HTMLElement>('[id$="-panel-feed"]')!.hidden,false);
    await dom.click("Trade");
    assert.equal(dom.container.querySelector(".perps-entry-row"),row);
  } finally {globalThis.fetch=original;await dom.close();}
});
