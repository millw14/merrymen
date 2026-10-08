import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import { PerpsEntrance } from "./PerpsEntrance";
import { perpsEntranceOwner, usePerpsEntrance } from "./use-perps-entrance";
import { deferred, json, testDom } from "./test-dom";

describe("once-per-owner perpetual entrance", () => {
  let ui: ReturnType<typeof testDom>;
  let controller: ReturnType<typeof usePerpsEntrance>;
  let navigations: number;
  const realFetch = globalThis.fetch;
  function Harness({ owner }: { owner: string | null }) {
    controller = usePerpsEntrance(owner);
    return createElement("button", { onClick: () => void controller.enter(() => navigations++) }, "Perps");
  }
  beforeEach(() => { ui = testDom(); navigations = 0; });
  afterEach(async () => { await ui.close(); globalThis.fetch = realFetch; });
  it("uses a stable tenant identity, not the agent or wallet grant", () => {
    assert.equal(perpsEntranceOwner(null), null);
    assert.equal(perpsEntranceOwner({ hosted: true, address: null }), null);
    assert.equal(perpsEntranceOwner({ hosted: true, address: "0xABc" }), "0xabc");
    assert.equal(perpsEntranceOwner({ hosted: false, address: null }), "local");
  });
  it("plays only when the server atomically grants the owner claim, including after remount", async () => {
    let claimed = false;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/perps/intro");
      assert.deepEqual(JSON.parse(String(init?.body)), { owner: "local" });
      const play = !claimed; claimed = true;
      return json({ owner: "local", play });
    };
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.playing, true);
    assert.equal(navigations, 1);
    await act(async () => controller!.finish());
    await ui.remount(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.playing, false);
    assert.equal(navigations, 2);
  });
  it("ignores a late response after the owner changes and aborts its request", async () => {
    const claim = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => { signal = init?.signal; return claim.promise; };
    await ui.render(createElement(Harness, { owner: "owner-a" }));
    await ui.click("Perps");
    await ui.click("Perps");
    assert.equal(controller!.pending, true);
    await ui.render(createElement(Harness, { owner: "owner-b" }));
    assert.equal(signal?.aborted, true);
    await act(async () => claim.resolve(json({ owner: "owner-a", play: true })));
    assert.equal(controller!.playing, false);
    assert.equal(controller!.pending, false);
    assert.equal(navigations, 0);
  });
  it("allows navigation without a session or after persistence fails, never replaying on uncertainty", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("offline"); };
    await ui.render(createElement(Harness, { owner: null }));
    await ui.click("Perps");
    assert.equal(calls, 0);
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(navigations, 2);
    assert.equal(controller!.playing, false);
    assert.equal(controller!.pending, false);
  });
  it("does not animate mismatched claims or reduced-motion preferences", async () => {
    globalThis.fetch = async () => json({ owner: "someone-else", play: true });
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    assert.equal(controller!.playing, false);
    Object.defineProperty(ui.dom.window, "matchMedia", { value: () => ({ matches: true }), configurable: true });
    globalThis.fetch = async () => json({ owner: "local", play: true });
    await ui.click("Perps");
    assert.equal(controller!.playing, false);
    assert.equal(navigations, 2);
  });
  it("cancels pending navigation when another destination wins", async () => {
    const claim = deferred<Response>();
    globalThis.fetch = async () => claim.promise;
    await ui.render(createElement(Harness, { owner: "local" }));
    await ui.click("Perps");
    await act(async () => controller!.cancelPending());
    await act(async () => claim.resolve(json({ owner: "local", play: true })));
    assert.equal(navigations, 0);
    assert.equal(controller!.playing, false);
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
