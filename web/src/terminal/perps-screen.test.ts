import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, act } from "react";
import type { ChartEntry, ChartResponse } from "../lib/perps-chart-data";
import { PerpsScreen, type PerpsScreenProps } from "./PerpsScreen";
import { testDom, json } from "./test-dom";
import { forgetAudioForTest } from "./chime";

const NOW = 1_790_697_060_000;
const entry = (id: string, timeMs: number): ChartEntry => ({ id, timeMs, price: 100, priceExact: "100.00", size: "1", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "open" });
const answer = (entries: ChartEntry[] = [], generatedAtMs = NOW): ChartResponse => ({ state: "ok", market: "BTC-PERP", book: "paper", window: "24h", generatedAtMs, entries, unknownFills: 0, truncated: false, candles: { state: "ok", bars: [{ timeMs: NOW - 300_000, open: 99, high: 101, low: 98, close: 100 }], gaps: [], stale: false, asOfMs: NOW } });
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
      assert.equal(urls.length, 2, "signed-out screen performs no private chart read");
      assert.doesNotMatch(dom.container.textContent ?? "", /100\.00/);
    } finally { globalThis.fetch = original; await dom.close(); }
  });

  it("keeps last known history visibly stale after refresh failure and obeys 429 cooldown", async () => {
    const dom = testDom();
    const original = globalThis.fetch;
    let status = 200;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(answer([entry("known", NOW - 1000)]), status); };
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
