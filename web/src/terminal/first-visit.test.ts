import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { FirstVisit, STOPS } from "./FirstVisit";
import { deferred, json, testDom } from "./test-dom";
import { visibleTourTarget } from "./tour-layout";
import { EN } from "@/lib/messages/en";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const KEY = "merrymen.tour.v3";
const A = "0xaaaa", B = "0xbbbb";
let requests: { url: string; method: string; body: Record<string, unknown> | null }[];
let response: (url: string, init?: RequestInit) => Promise<Response>;
const tour = (tenant: string | null = null, onScreen = (_: unknown) => {}, onQuestion = () => {}) => React.createElement(FirstVisit, { tenant, onScreen, onQuestion });
const result = (tenant: string, done: boolean) => ({ tenant, version: 3, signedIn: true, done });

beforeEach(() => {
  ui = testDom(); requests = [];
  response = async (url, init) => json(result(init?.method === "POST" ? JSON.parse(String(init.body)).tenant : new URL(url, "https://test").searchParams.get("tenant")!, init?.method === "POST"));
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return response(String(input), init);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });

it("signed-out visitors can finish all topics and remain dismissed after reload", async () => {
  await ui.render(tour());
  for (let step = 1; step <= STOPS.length; step++) {
    assert.equal(ui.container.querySelector(".tour-count")?.textContent, `${step} / ${STOPS.length}`);
    await ui.click(step === STOPS.length ? "Finish" : "Next");
  }
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  await ui.remount(tour());
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.equal(requests.length, 0);
});
it("claims an anonymous dismissal once on sign-in, without hiding the next account's tour", async () => {
  await ui.render(tour()); await ui.click("Skip tour"); await ui.render(tour(A));
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  assert.equal(requests.find(r => r.method === "POST")?.body?.tenant, A);
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${A}`)!).pending, false);
  await ui.render(tour(B));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  await ui.render(tour(A));
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
});
it("server dismissal does not close explicit replay, including after reload", async () => {
  response = async () => json(result(A, true));
  await ui.render(tour(A)); await ui.click("Show me around");
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  await ui.click("Next"); await ui.remount(tour(A));
  assert.equal(ui.container.querySelector(".tour-count")?.textContent, `2 / ${STOPS.length}`);
});
it("a late response cannot undo replay or affect another account", async () => {
  const late = deferred<Response>(); response = async () => late.promise;
  localStorage.setItem(`${KEY}:${A}`, JSON.stringify({ done: true, step: 0 }));
  await ui.render(tour(A)); await ui.click("Show me around");
  await act(async () => late.resolve(json(result(A, true))));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  const old = deferred<Response>();
  response = async url => url.includes(A) ? old.promise : json(result(B, false));
  await ui.remount(tour(A)); await ui.render(tour(B));
  await act(async () => old.resolve(json(result(A, true))));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${B}`)!).done, false);
});
it("failed persistence stays pending without loops and retries on reload or reconnect", async () => {
  response = async (_, init) => init?.method === "POST" ? json({ error: "down" }, 503) : json(result(A, false));
  await ui.render(tour(A)); await ui.click("Skip tour");
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.match(ui.container.textContent!, /Retry account sync/);
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  await ui.remount(tour(A));
  assert.equal(requests.filter(r => r.method === "POST").length, 2);
  response = async () => json(result(A, true));
  await act(async () => { window.dispatchEvent(new Event("online")); });
  assert.equal(requests.filter(r => r.method === "POST").length, 3);
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${A}`)!).pending, false);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  assert.equal(requests.filter(r => r.method === "POST").length, 3);
});
it("resumes navigation and prepares the example question only once", async () => {
  localStorage.setItem(KEY, JSON.stringify({ done: false, step: 3 }));
  const screens: unknown[] = []; let questions = 0;
  await ui.render(tour(null, s => screens.push(s), () => { questions++; }));
  assert.deepEqual(screens, [{ kind: "tab", tab: "agent" }]); assert.equal(questions, 1);
  await ui.click("Back"); await ui.click("Next"); assert.equal(questions, 1);
});

it("lets readers jump to a topic and navigate back without sending the example question", async () => {
  const screens: unknown[] = []; let questions = 0;
  await ui.render(tour(null, s => screens.push(s), () => { questions++; }));
  await ui.click("Topics");
  // Found through the catalogue rather than by index: a stop's words moved into
  // `en.ts` when the tour became translatable, and pinning "stop 13" here would
  // make reordering the tour break a test about jumping to a topic.
  const i = STOPS.findIndex(s => EN[s.titleKey] === "Add funds.");
  await ui.click(`${i + 1}. Add funds.`);
  assert.deepEqual(screens.at(-1), {kind: "deposit"});
  assert.equal(ui.container.querySelector('.tour-topics'), null);
  assert.equal(questions, 0);
  await ui.click("Back");
  assert.deepEqual(screens.at(-1), {kind: "grant"});
});

it("tracks late targets and layout shifts without a resize, then clears a removed target", async () => {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = handle => { frames.delete(handle); };
  const frame = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }); };
  await ui.render(tour()); await ui.click("Next"); await frame();
  assert.equal(ui.container.querySelector(".tour-spot"), null);
  const target = document.createElement("button"); target.dataset.tour = "tab-home"; document.body.append(target);
  let top = 40;
  target.getBoundingClientRect = () => ({ top, left: 30, width: 80, height: 40, right: 110, bottom: top + 40, x: 30, y: top, toJSON() {} });
  await frame();
  assert.equal((ui.container.querySelector(".tour-spot") as HTMLElement).style.top, "34px");
  top = 180; await frame();
  assert.equal((ui.container.querySelector(".tour-spot") as HTMLElement).style.top, "174px");
  target.remove(); await frame();
  assert.equal(ui.container.querySelector(".tour-spot"), null);
  await ui.click("Skip tour"); assert.equal(frames.size, 0);
});

it("ignores offscreen and invisible duplicate targets and clips partially visible ones", () => {
  const hidden = document.createElement("button"), visible = document.createElement("button");
  hidden.dataset.tour = visible.dataset.tour = "tab-home"; document.body.append(hidden, visible);
  const rect = (top: number) => ({ top, left: 10, width: 50, height: 30, right: 60, bottom: top + 30, x: 10, y: top, toJSON() {} });
  hidden.getBoundingClientRect = () => rect(-100);
  visible.getBoundingClientRect = () => rect(-10);
  const viewport = { top: 0, left: 0, width: 390, height: 844 };
  assert.deepEqual(visibleTourTarget(['[data-tour="tab-home"]'], viewport), { top: 0, left: 10, width: 50, height: 20 });
  visible.style.visibility = "hidden";
  assert.equal(visibleTourTarget(['[data-tour="tab-home"]'], viewport), null);
});

it("contains keyboard focus, closes with Escape and restores previous focus", async () => {
  const outside = document.createElement("button"); document.body.append(outside); outside.focus();
  await ui.render(tour());
  assert.equal(document.activeElement?.getAttribute("role"), "dialog");
  await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  // THE FIRST TAB STOP IS THE LANGUAGE CONTROL, and that is the point rather
  // than an accident of ordering. Somebody who cannot read this card should
  // reach the control that fixes that before anything else on it — including
  // the way out, which they also cannot read.
  const first = document.activeElement;
  assert.ok(ui.container.querySelector('[role="dialog"]')?.contains(first), "focus left the dialog");
  assert.equal(first?.closest(".lang-picker") !== null, true, "the first stop should be the picker");
  await act(async () => outside.focus());
  assert.equal(document.activeElement, first, "focus must not escape the dialog");
  await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, outside);
});
