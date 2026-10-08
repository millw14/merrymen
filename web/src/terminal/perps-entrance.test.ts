import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement, useRef } from "react";
import { PerpsEntrance } from "./PerpsEntrance";
import { perpsEntranceOwner, usePerpsEntrance } from "./use-perps-entrance";
import { deferred, json, testDom } from "./test-dom";

describe("once-per-owner, reversible mode transition", () => {
  let ui: ReturnType<typeof testDom>;
  let controller: ReturnType<typeof usePerpsEntrance>;
  let navigations: number;
  const realFetch = globalThis.fetch;
  function Harness({ owner, pathname = "/" }: { owner: string | null; pathname?: string }) {
    const source = useRef<HTMLDivElement>(null);
    controller = usePerpsEntrance(owner, pathname, source);
    return createElement("div", { ref: source },
      createElement("h1", {}, pathname === "/perps" ? "Tactical Radar" : "Merrymen feed"),
      createElement("button", { onClick: () => void controller.enter(() => navigations++) }, "Perps"),
      createElement("button", { onClick: () => controller.leave(() => navigations++) }, "Spot"));
  }
  beforeEach(() => { ui = testDom(); navigations = 0; });
  afterEach(async () => { await ui.close(); globalThis.fetch = realFetch; });
  it("uses a stable tenant identity, not the agent or wallet grant", () => {
    assert.equal(perpsEntranceOwner(null), null);
    assert.equal(perpsEntranceOwner({ hosted: true, address: null }), null);
    assert.equal(perpsEntranceOwner({ hosted: true, address: "0xABc" }), "0xabc");
    assert.equal(perpsEntranceOwner({ hosted: false, address: null }), "local");
  });
  it("uses the full sequence only for the server's first claim, including across remounts", async () => {
    let claimed = false;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/perps/intro");
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "same-origin");
      assert.deepEqual(JSON.parse(String(init?.body)), { owner: "local" });
      const play = !claimed; claimed = true;
      return json({ owner: "local", play });
    };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.transition?.dramatic, true);
    assert.equal(controller!.transition?.direction, "perps");
    assert.equal(navigations, 1);
    const first = controller!.transition!.scene;
    await ui.remount(createElement(Harness, { owner: "local" }));
    assert.equal(first.element.childElementCount, 0, "the old owner's visual copy is released on unmount");
    await ui.click("Perps");
    assert.equal(controller!.transition?.dramatic, false);
    assert.equal(controller!.transition?.direction, "perps");
    assert.equal(navigations, 2);
  });
  it("keeps the outgoing page until the requested destination actually commits", async () => {
    globalThis.fetch = async () => json({ owner: "local", play: true });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    const scene = controller!.transition!.scene;
    assert.equal(controller!.ready, false, "invoking navigation is not evidence that the new page mounted");
    assert.match(scene.element.textContent ?? "", /Merrymen feed/);
    await ui.render(createElement(Harness, { owner: "local", pathname: "/perps" }));
    assert.equal(controller!.ready, true);
    assert.equal(controller!.transition!.scene, scene);
    assert.match(scene.element.textContent ?? "", /Merrymen feed/, "the source stays frozen while the live destination changes");
    await act(async () => controller!.finish());
    assert.equal(controller!.transition, null);
    assert.equal(scene.element.childElementCount, 0);
  });
  it("reverses from Perps to Spot without consuming or requesting an intro claim", async () => {
    let claims = 0;
    globalThis.fetch = async () => { claims++; return json({ owner: "local", play: true }); };
    await ui.render(createElement(Harness, { owner: "local", pathname: "/perps" }));
    await ui.click("Spot");
    assert.equal(claims, 0);
    assert.equal(navigations, 1);
    assert.equal(controller!.pending, false);
    assert.equal(controller!.transition?.direction, "spot");
    assert.equal(controller!.transition?.dramatic, false);
    assert.match(controller!.transition!.scene.element.textContent ?? "", /Tactical Radar/);
    assert.equal(controller!.ready, false);
    await ui.render(createElement(Harness, { owner: "local", pathname: "/" }));
    assert.equal(controller!.ready, true);
  });
  it("ignores a late response after the owner changes and aborts its request", async () => {
    const claim = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    globalThis.fetch = async (_url, init) => { calls++; signal = init?.signal; return claim.promise; };
    await ui.render(createElement(Harness, { owner: "owner-a" }));
    await ui.click("Perps");
    await ui.click("Perps");
    assert.equal(calls, 1, "rapid clicks share one claim request");
    assert.equal(controller!.pending, true);
    await ui.render(createElement(Harness, { owner: "owner-b" }));
    assert.equal(signal?.aborted, true);
    await act(async () => claim.resolve(json({ owner: "owner-a", play: true })));
    assert.equal(controller!.transition, null);
    assert.equal(controller!.pending, false);
    assert.equal(navigations, 0);
  });
  it("destroys a frozen owner's screen as soon as ownership changes", async () => {
    globalThis.fetch = async () => json({ owner: "owner-a", play: true });
    await ui.render(createElement(Harness, { owner: "owner-a" }));
    await ui.click("Perps");
    const scene = controller!.transition!.scene;
    await ui.render(createElement(Harness, { owner: "owner-b" }));
    assert.equal(controller!.transition, null);
    assert.equal(scene.element.childElementCount, 0);
  });
  it("lets an unrelated route interrupt and dispose an in-flight reveal", async () => {
    globalThis.fetch = async () => json({ owner: "local", play: false });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    const scene = controller!.transition!.scene;
    await ui.render(createElement(Harness, { owner: "local", pathname: "/settings" }));
    assert.equal(controller!.transition, null);
    assert.equal(controller!.ready, false);
    assert.equal(scene.element.childElementCount, 0);
  });
  it("keeps navigation working without a session and after preference persistence fails", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("offline"); };
    await ui.render(createElement(Harness, { owner: null }));
    await ui.click("Perps");
    assert.equal(calls, 0);
    assert.equal(controller!.transition?.dramatic, false);
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(calls, 1);
    assert.equal(navigations, 2);
    assert.equal(controller!.transition?.dramatic, false, "uncertainty never replays the full sequence");
    assert.equal(controller!.pending, false);
  });
  it("does not treat another owner's claim as first-visit authorization", async () => {
    globalThis.fetch = async () => json({ owner: "someone-else", play: true });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.transition?.dramatic, false);
    assert.equal(navigations, 1);
  });
  it("navigates both directions without a frozen scene for reduced motion", async () => {
    Object.defineProperty(ui.dom.window, "matchMedia", { value: () => ({ matches: true }), configurable: true });
    globalThis.fetch = async () => json({ owner: "local", play: true });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.transition, null);
    await ui.render(createElement(Harness, { owner: "local", pathname: "/perps" }));
    await ui.click("Spot");
    assert.equal(controller!.transition, null);
    assert.equal(navigations, 2);
  });
  it("cancels pending navigation when another destination wins", async () => {
    const claim = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => { signal = init?.signal; return claim.promise; };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    await act(async () => controller!.cancelPending());
    assert.equal(signal?.aborted, true);
    await act(async () => claim.resolve(json({ owner: "local", play: true })));
    assert.equal(navigations, 0);
    assert.equal(controller!.transition, null);
    assert.equal(controller!.pending, false);
  });
  it("ignores late claims after unmount", async () => {
    const claim = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => { signal = init?.signal; return claim.promise; };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    await ui.render(null);
    assert.equal(signal?.aborted, true);
    await act(async () => claim.resolve(json({ owner: "local", play: true })));
    assert.equal(navigations, 0);
  });
  it("falls back to a short reveal when the claim request times out", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.pending, true);
    await act(async () => context.mock.timers.tick(1800));
    assert.equal(signal?.aborted, true);
    assert.equal(navigations, 1);
    assert.equal(controller!.pending, false);
    assert.equal(controller!.transition?.dramatic, false);
  });
  it("releases the visual cover if the destination fails to arrive", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = async () => json({ owner: "local", play: false });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    const scene = controller!.transition!.scene;
    await act(async () => context.mock.timers.tick(7000));
    assert.equal(controller!.transition, null);
    assert.equal(scene.element.childElementCount, 0);
  });
  it("cancels the route deadline after a late arrival so it cannot cut playback short", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    globalThis.fetch = async () => json({ owner: "local", play: true });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    const scene = controller!.transition!.scene;
    await act(async () => context.mock.timers.tick(6000));
    assert.equal(controller!.ready, false);
    await ui.render(createElement(Harness, { owner: "local", pathname: "/perps" }));
    assert.equal(controller!.ready, true);
    await act(async () => context.mock.timers.tick(2199));
    assert.equal(controller!.transition!.scene, scene, "the old 7s deadline no longer owns successful playback");
    await act(async () => controller!.finish());
    assert.equal(controller!.transition, null);
    assert.equal(scene.element.childElementCount, 0);
  });
  it("does not claim or navigate twice while a reveal is active", async () => {
    let claims = 0;
    globalThis.fetch = async () => { claims++; return json({ owner: "local", play: true }); };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    await ui.click("Perps");
    await ui.click("Spot");
    assert.equal(claims, 1);
    assert.equal(navigations, 1);
    assert.equal(controller!.transition?.direction, "perps");
  });
  it("holds the source scene until readiness, then gives the first reveal its complete duration", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = 0;
    const onDone = () => finished++;
    await ui.render(createElement(PerpsEntrance, { onDone, dramatic: true, ready: false }));
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(finished, 0, "route loading does not consume the reveal duration");
    await ui.render(createElement(PerpsEntrance, { onDone, dramatic: true, ready: true }));
    await act(async () => context.mock.timers.tick(2199));
    assert.equal(finished, 0);
    await act(async () => context.mock.timers.tick(1));
    assert.equal(finished, 1);
  });
  it("finishes repeat and reverse reveals promptly without trapping the next key", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = 0;
    await ui.render(createElement(PerpsEntrance, { onDone: () => finished++, direction: "spot", dramatic: false }));
    assert.equal(ui.container.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Returning to Spot");
    await act(async () => context.mock.timers.tick(849));
    assert.equal(finished, 0);
    await act(async () => context.mock.timers.tick(1));
    assert.equal(finished, 1);
    const tab = new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    ui.dom.window.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, false, "completion releases keys before the parent removes the overlay");
  });
  it("returns reverse focus to the live Spot heading, never the frozen copy", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = 0;
    let restored = 0;
    const frozen = document.createElement("div");
    frozen.className = "app";
    frozen.innerHTML = '<h1 tabindex="-1">Frozen Perps screen</h1>';
    const scene = { element: frozen, restoreScroll: () => restored++, dispose: () => frozen.remove() };
    const content = createElement("div", { className: "app" }, createElement("h1", {}, "Merrymen feed"));
    await ui.render(createElement("div", {}, content, createElement(PerpsEntrance, { onDone: () => finished++, direction: "spot", dramatic: false, scene })));
    assert.equal(restored, 1);
    assert.equal(frozen.isConnected, true);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(finished, 1);
    assert.equal(document.activeElement?.textContent, "Merrymen feed");
    const tab = new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    ui.dom.window.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, false);
    await act(async () => context.mock.timers.tick(850));
    assert.equal(finished, 1, "skip and timer completion cannot both dismiss the same transition");
    await ui.render(content);
    assert.equal(frozen.isConnected, false);
  });
  it("a direct preview mount with reduced motion never takes focus or traps Tab", async () => {
    let finished = 0;
    const outside = ui.dom.window.document.createElement("button");
    outside.textContent = "Continue reading";
    ui.dom.window.document.body.append(outside);
    outside.focus();
    Object.defineProperty(ui.dom.window, "matchMedia", { value: () => ({ matches: true }), configurable: true });
    await ui.render(createElement(PerpsEntrance, { onDone: () => finished++ }));
    assert.equal(finished, 1);
    assert.equal(document.activeElement, outside);
    const tab = new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    ui.dom.window.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, false);
  });
  it("releases its keyboard trap immediately when reduced motion is enabled during playback", async () => {
    let finished = 0;
    let matches = false;
    const listeners = new Set<() => void>();
    Object.defineProperty(ui.dom.window, "matchMedia", { value: () => ({
      get matches() { return matches; },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }), configurable: true });
    const content = createElement("div", { className: "perps-screen" }, createElement("h1", { tabIndex: -1 }, "Tactical Radar"));
    await ui.render(createElement("div", {}, content, createElement(PerpsEntrance, { onDone: () => finished++ })));
    assert.match(document.activeElement?.textContent ?? "", /Skip intro/);
    await act(async () => { matches = true; for (const listener of listeners) listener(); });
    assert.equal(finished, 1);
    const tab = new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    ui.dom.window.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, false, "a hidden overlay must stop trapping even before its parent unmounts it");
    await act(async () => { for (const listener of listeners) listener(); });
    assert.equal(finished, 1, "repeated preference events cannot dismiss twice");
    assert.equal(document.activeElement?.tagName, "H1", "focus leaves the now-hidden intro immediately");
    await ui.render(createElement("div", {}, content));
    assert.equal(listeners.size, 0);
    assert.equal(document.activeElement?.tagName, "H1");
  });
  it("can be skipped by keyboard and returns focus to the perps heading", async () => {
    let skipped = 0;
    const content = createElement("div", { className: "perps-screen" }, createElement("h1", { tabIndex: -1 }, "Tactical Radar"));
    await ui.render(createElement("div", {}, content, createElement(PerpsEntrance, { onDone: () => skipped++ })));
    assert.match(document.activeElement?.textContent ?? "", /Skip intro/);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
    assert.equal(skipped, 1);
    await ui.render(createElement("div", {}, content));
    assert.equal(document.activeElement?.tagName, "H1");
  });
});
