import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement, useRef } from "react";
import { MODE_SUIT_DURATION, PerpsEntrance, suitOrigin } from "./PerpsEntrance";
import { naniteTimeline } from "./nanite-suit";
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
      createElement("div", { className: "trading-mode-toggle" },
        createElement("button", { onClick: () => void controller.enter(() => navigations++) }, "Perps"),
        createElement("button", { onClick: () => controller.leave(() => navigations++) }, "Spot")));
  }
  beforeEach(() => {
    ui = testDom();
    navigations = 0;
    // jsdom has no 2D canvas; say so quietly. The nanite engine then runs on
    // timers alone, which is exactly what these tests observe.
    Object.defineProperty(ui.dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
  });
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
    await act(async () => context.mock.timers.tick(2599));
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
    await act(async () => context.mock.timers.tick(2599));
    assert.equal(finished, 0);
    await act(async () => context.mock.timers.tick(1));
    assert.equal(finished, 1);
  });
  it("finishes repeat and reverse reveals promptly without trapping the next key", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = 0;
    await ui.render(createElement(PerpsEntrance, { onDone: () => finished++, direction: "spot", dramatic: false }));
    assert.equal(ui.container.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Returning to Spot");
    await act(async () => context.mock.timers.tick(949));
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
    await act(async () => context.mock.timers.tick(950));
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

  const TOGGLE = '<div class="trading-mode-toggle"><button aria-pressed="true">Spot</button><button aria-pressed="false">Perps</button></div>';
  const frozenScene = (html = TOGGLE) => {
    const element = document.createElement("div");
    element.innerHTML = html;
    return { element, restoreScroll: () => {}, dispose: () => element.remove() };
  };
  const rect = (left: number, top: number, width: number, height: number) => () =>
    ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) });

  it("keeps the host timer in step with the engine's own timeline", () => {
    assert.equal(MODE_SUIT_DURATION.dramatic, naniteTimeline(true).nominal);
    assert.equal(MODE_SUIT_DURATION.quick, naniteTimeline(false).nominal);
  });
  for (const [dramatic, coveredAt, duration] of [[false, 430, 950], [true, 1180, 2600]] as const) {
    it(`hides the frozen screen only once the ${dramatic ? "dramatic" : "quick"} armour covers it, then ends once on the host timer`, async context => {
      context.mock.timers.enable({ apis: ["setTimeout"] });
      let finished = 0;
      const scene = frozenScene();
      await ui.render(createElement(PerpsEntrance, { onDone: () => finished++, scene, dramatic }));
      const root = ui.container.querySelector(".perps-entrance")!;
      assert.ok(root.querySelector(".perps-suit-scene-content")?.contains(scene.element));
      assert.equal(root.querySelector("canvas.perps-suit-canvas")?.getAttribute("aria-hidden"), "true");
      await act(async () => context.mock.timers.tick(coveredAt - 1));
      assert.equal(root.classList.contains("is-covered"), false, "the outgoing screen stays until the armour is opaque");
      await act(async () => context.mock.timers.tick(1));
      assert.equal(root.classList.contains("is-covered"), true);
      assert.equal(scene.element.isConnected, true, "covering only hides the copy; its owner still disposes it");
      await act(async () => context.mock.timers.tick(duration - coveredAt - 1));
      assert.equal(finished, 0);
      await act(async () => context.mock.timers.tick(1));
      assert.equal(finished, 1);
      await act(async () => context.mock.timers.tick(10_000));
      assert.equal(finished, 1, "the engine never completes the overlay a second time");
    });
  }
  it("does not start the armour while the destination is still loading", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let finished = 0;
    const onDone = () => finished++;
    const scene = frozenScene();
    await ui.render(createElement(PerpsEntrance, { onDone, scene, dramatic: false, ready: false }));
    await act(async () => context.mock.timers.tick(5000));
    const root = ui.container.querySelector(".perps-entrance")!;
    assert.equal(root.classList.contains("is-covered"), false);
    assert.equal(finished, 0);
    await ui.render(createElement(PerpsEntrance, { onDone, scene, dramatic: false, ready: true }));
    await act(async () => context.mock.timers.tick(430));
    assert.equal(root.classList.contains("is-covered"), true);
  });
  it("cancels the armour when the overlay unmounts or is skipped mid-play", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    // Count live delayed timers: once none is pending, nothing can call back into an
    // unmounted overlay. (jsdom's own zero-delay selection tasks are not ours.)
    const mockedSet = globalThis.setTimeout;
    const mockedClear = globalThis.clearTimeout;
    const pending = new Set<unknown>();
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      const id = mockedSet(() => { pending.delete(id); callback(); }, ms);
      if (ms) pending.add(id);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { pending.delete(id); mockedClear(id); }) as unknown as typeof clearTimeout;
    const errors: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      let finished = 0;
      await ui.render(createElement(PerpsEntrance, { onDone: () => finished++, scene: frozenScene(), dramatic: false }));
      assert.equal(pending.size, 3, "the host timer plus the armour's cover and end instants");
      await act(async () => context.mock.timers.tick(200));
      await ui.render(null);
      assert.equal(pending.size, 0, "unmounting cancels the armour as well as the host timer");
      await act(async () => context.mock.timers.tick(5000));
      assert.equal(finished, 0);

      await ui.render(createElement(PerpsEntrance, { onDone: () => finished++, scene: frozenScene(), dramatic: true }));
      await act(async () => context.mock.timers.tick(1179));
      await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape" })));
      assert.equal(finished, 1);
      assert.equal(pending.size, 1, "skipping stops the armour; only the spent host timer remains");
      await act(async () => context.mock.timers.tick(5000));
      assert.equal(ui.container.querySelector(".perps-entrance")?.classList.contains("is-covered"), false, "a skipped armour never reports cover");
      assert.equal(finished, 1);
      assert.deepEqual(errors, []);
    } finally {
      globalThis.setTimeout = mockedSet;
      globalThis.clearTimeout = mockedClear;
      console.error = realError;
    }
  });
  it("pours the armour from the press, else the destination in the frozen toggle, else the top centre", () => {
    assert.deepEqual(suitOrigin({ x: 12, y: 34 }, null), { x: 12, y: 34 });
    // A hidden phone toggle measures zero; the visible desktop toggle wins.
    const scene = frozenScene(TOGGLE + TOGGLE);
    ui.container.append(scene.element);
    const destinations = scene.element.querySelectorAll<HTMLElement>('button[aria-pressed="false"]');
    destinations[1].getBoundingClientRect = rect(100, 10, 80, 30);
    scene.element.querySelector<HTMLElement>('button[aria-pressed="true"]')!.getBoundingClientRect = rect(0, 0, 80, 30);
    assert.deepEqual(suitOrigin(null, scene.element), { x: 140, y: 25 });
    assert.deepEqual(suitOrigin({ x: Number.NaN, y: 4 }, scene.element), { x: 140, y: 25 }, "a non-finite press is ignored");
    assert.deepEqual(suitOrigin(null, null), { x: ui.dom.window.innerWidth / 2, y: 0 });
  });

  const press = (x: number, y: number) => act(async () => {
    ui.container.querySelector("button")!.dispatchEvent(new ui.dom.window.PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
  });
  it("remembers where a recent press asked for the switch, in both directions", async () => {
    globalThis.fetch = async () => json({ owner: "local", play: false });
    await ui.render(createElement(Harness, { owner: "local" }));
    await press(120, 40);
    await ui.click("Perps");
    assert.deepEqual(controller!.transition?.origin, { x: 120, y: 40 });
    await act(async () => controller!.finish());
    await ui.render(createElement(Harness, { owner: "local", pathname: "/perps" }));
    await press(300, 20);
    await ui.click("Spot");
    assert.equal(controller!.transition?.direction, "spot");
    assert.deepEqual(controller!.transition?.origin, { x: 300, y: 20 });
  });
  it("ignores a stale press", async context => {
    let now = 10_000;
    context.mock.method(performance, "now", () => now);
    await ui.render(createElement(Harness, { owner: null }));
    await press(50, 60);
    now += 1500;
    await ui.click("Perps");
    assert.ok(controller!.transition, "the switch itself still happens");
    assert.equal(controller!.transition.origin, null, "a press 1.5 s old did not ask for this switch");
  });
  it("takes the origin when the switch is asked for, not after the intro claim returns", async context => {
    let now = 20_000;
    context.mock.method(performance, "now", () => now);
    const claim = deferred<Response>();
    globalThis.fetch = async () => claim.promise;
    await ui.render(createElement(Harness, { owner: "local" }));
    await press(70, 15);
    now += 100;
    await ui.click("Perps");
    assert.equal(controller!.pending, true);
    now += 5000;
    await act(async () => claim.resolve(json({ owner: "local", play: true })));
    assert.equal(controller!.transition?.dramatic, true);
    assert.deepEqual(controller!.transition?.origin, { x: 70, y: 15 });
  });
  it("pours from the focused toggle button for a keyboard switch", async () => {
    await ui.render(createElement(Harness, { owner: null }));
    const perps = Array.from(ui.container.querySelectorAll("button")).find(button => button.textContent === "Perps")!;
    perps.getBoundingClientRect = rect(100, 10, 80, 30);
    perps.focus();
    await ui.click("Perps");
    assert.deepEqual(controller!.transition?.origin, { x: 140, y: 25 });
  });
});
