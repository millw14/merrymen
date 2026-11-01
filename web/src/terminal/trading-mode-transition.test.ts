import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h, useRef, StrictMode } from "react";
import { readFileSync } from "node:fs";
import * as visuals from "./PerpsEntrance";
import { TradingModeToggle } from "./TradingModeToggle";
import { MODE_LOAD_TIMEOUT, MODE_TRANSITION_TIMEOUT, useTradingModeTransition } from "./use-trading-mode-transition";
import { deferred, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
let controller: ReturnType<typeof useTradingModeTransition>;
let load: () => Promise<typeof visuals>, loads: number, destinations: string[], network: number;
const realFetch = globalThis.fetch;
const navigate = (path: string) => { destinations.push(path); };
const loader = () => { loads++; return load(); };
function Harness({ identity = "0:local", route = "/home", offered = true }: { identity?: string; route?: string; offered?: boolean }) {
  const source = useRef<HTMLDivElement>(null);
  const mode = route.startsWith("/perps") || route.includes("wallet=perps") ? "perps" : "spot";
  controller = useTradingModeTransition({ identity, route, mode, offered, source, load: loader, navigate });
  const scene = controller.transition, Entrance = scene?.Entrance;
  return h("div", { className: "terminal-host" },
    h("div", { ref: source, className: "app" },
      h("section", { className: mode === "perps" ? "perps-desk" : undefined }, h("h1", {}, mode === "perps" ? "Paper Perps" : "Your Spot view")),
      h("p", {}, "Private position"),
      offered ? h(TradingModeToggle, { mode, pending: controller.pending, onChange: controller.change }) : null),
    scene && Entrance ? h(Entrance, { scene: scene.scene, direction: scene.direction, ready: controller.ready, onDone: scene.finish, background: source.current }) : null);
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  ui.dom.window.history.replaceState(null, "", props.route ?? "/home");
  await ui.render(h(Harness, props));
}
beforeEach(() => {
  ui = testDom(); loads = 0; destinations = []; network = 0;
  load = async () => visuals;
  ui.dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  Object.defineProperty(ui.dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
  globalThis.fetch = async () => { network++; throw new Error("The visual switch must not fetch account/intro/permission data"); };
});
afterEach(async () => { await ui.close(); globalThis.fetch = realFetch; });

test("no autoplay or preload; one deliberate press loads visuals and navigates once without account I/O", async () => {
  const pending = deferred<typeof visuals>(); load = () => pending.promise;
  await render();
  assert.equal(loads, 0); assert.equal(ui.container.querySelector("canvas"), null);
  await ui.click("Perps"); await ui.click("Perps");
  assert.equal(loads, 1); assert.equal(controller.pending, true); assert.deepEqual(destinations, []);
  await act(async () => pending.resolve(visuals));
  assert.deepEqual(destinations, ["/perps"]); assert.equal(network, 0);
  assert.equal(controller.ready, false);
  const frozen = controller.transition!.scene!;
  assert.match(frozen.element.textContent!, /Your Spot view/);
  await render({ route: "/perps" });
  assert.equal(controller.ready, true);
  assert.match(frozen.element.textContent!, /Your Spot view/, "the outgoing screen remains frozen while the live destination commits");
  await act(async () => controller.cancel());
  assert.equal(frozen.element.childElementCount, 0); assert.equal(controller.transition, null);
});

test("Spot returns to canonical /home; selecting the current mode is a no-op", async () => {
  await render({ route: "/perps" });
  await ui.click("Perps"); assert.equal(loads, 0);
  await ui.click("Spot"); assert.deepEqual(destinations, ["/home"]);
  assert.equal(controller.transition?.direction, "spot"); assert.equal(network, 0);
});

test("offered is visibility only: signed-out visitors can switch, while off disables transition", async () => {
  await render({ identity: "0:true:signed-out" });
  await ui.click("Perps"); assert.deepEqual(destinations, ["/perps"]);
  const scene = controller.transition!.scene!;
  await render({ identity: "0:true:signed-out", offered: false });
  assert.equal(scene.element.childElementCount, 0);
  await act(async () => controller.change("perps"));
  assert.equal(destinations.length, 1); assert.equal(ui.container.querySelector("button"), null);
});

for (const kind of ["owner", "route", "wallet query", "offered", "unmount", "explicit session invalidation"] as const) {
  test(`late chunk resolution is fenced after ${kind}`, async () => {
    const pending = deferred<typeof visuals>(); load = () => pending.promise;
    await render({ identity: "0:owner-a" }); await ui.click("Perps");
    if (kind === "owner") { await render({ identity: "1:owner-b" }); await render({ identity: "2:owner-a" }); }
    if (kind === "route") await render({ identity: "0:owner-a", route: "/feed" });
    if (kind === "wallet query") await render({ identity: "0:owner-a", route: "/home?wallet=perps" });
    if (kind === "offered") await render({ identity: "0:owner-a", offered: false });
    if (kind === "unmount") await ui.render(null);
    if (kind === "explicit session invalidation") await act(async () => controller.cancel());
    await act(async () => pending.resolve(visuals));
    assert.deepEqual(destinations, []); assert.equal(ui.container.querySelector(".perps-entrance"), null); assert.equal(network, 0);
  });
}

test("loader timeout navigates once; late code cannot replay the animation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<typeof visuals>(); load = () => pending.promise;
  await render(); await ui.click("Perps");
  await act(async () => context.mock.timers.tick(MODE_LOAD_TIMEOUT));
  assert.deepEqual(destinations, ["/perps"]); assert.equal(controller.pending, false);
  await act(async () => pending.resolve(visuals));
  assert.deepEqual(destinations, ["/perps"]); assert.equal(controller.transition, null);
});

test("a URL change before React commits wins over a late loader or its timeout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<typeof visuals>(); load = () => pending.promise;
  await render(); await ui.click("Perps");
  ui.dom.window.history.replaceState(null, "", "/grant?wallet=perps");
  await act(async () => context.mock.timers.tick(MODE_LOAD_TIMEOUT));
  await act(async () => pending.resolve(visuals));
  assert.deepEqual(destinations, []); assert.equal(controller.pending, false);
});

test("an unavailable visual chunk falls back to navigation with no overlay", async () => {
  load = async () => { throw new Error("chunk unavailable"); };
  await render(); await ui.click("Perps");
  assert.deepEqual(destinations, ["/perps"]); assert.equal(controller.transition, null);
});

test("renderer initialization failure restores focus and background interaction", async () => {
  await render(); await ui.click("Perps");
  const frozen = controller.transition!.scene!;
  Object.defineProperty(ui.dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({
    createRadialGradient() { throw new Error("GPU context became unavailable"); },
  }) });
  await render({ route: "/perps" });
  assert.equal(controller.transition, null);
  assert.equal(frozen.element.childElementCount, 0);
  assert.equal(ui.container.querySelector(".perps-entrance"), null);
  assert.equal(ui.container.querySelector(".app")!.hasAttribute("inert"), false);
  assert.equal(ui.container.querySelector(".app")!.hasAttribute("aria-hidden"), false);
  assert.equal(ui.dom.window.document.activeElement?.tagName, "H1");
  assert.equal(network, 0);
});

test("reduced motion skips the loader, canvas and overlay in both directions", async () => {
  ui.dom.window.matchMedia = () => ({ matches: true }) as MediaQueryList;
  await render(); await ui.click("Perps");
  await render({ route: "/perps" }); await ui.click("Spot");
  assert.deepEqual(destinations, ["/perps", "/home"]); assert.equal(loads, 0); assert.equal(network, 0);
  assert.equal(ui.container.querySelector(".perps-entrance"), null);
});

for (const route of ["/grant", "/create", "/withdraw?wallet=perps", "/settings", "/chat"]) {
  test(`never snapshots sensitive or draft-bearing ${route} content`, async () => {
    await render({ route }); await ui.click(route.includes("wallet=perps") ? "Spot" : "Perps");
    assert.ok(controller.transition); assert.equal(controller.transition.scene, null);
    assert.equal(ui.container.querySelector("[data-mode-snapshot]"), null);
  });
}

test("an unrelated route and browser Back destroy the private scene and release the background", async () => {
  await render(); await ui.click("Perps");
  const first = controller.transition!.scene!;
  await render({ route: "/feed" });
  assert.equal(first.element.childElementCount, 0); assert.equal(ui.container.querySelector(".app")?.hasAttribute("inert"), false);
  await render(); await ui.click("Perps");
  const second = controller.transition!.scene!;
  await act(async () => window.dispatchEvent(new ui.dom.window.PopStateEvent("popstate")));
  assert.equal(second.element.childElementCount, 0); assert.equal(controller.transition, null);
});

test("the overlay inerts only the app, traps focus, and Escape restores exact attributes/focus", async () => {
  await render();
  const app = ui.container.querySelector<HTMLElement>(".app")!;
  app.setAttribute("aria-hidden", "false");
  await ui.click("Perps");
  const scene = controller.transition!.scene!;
  assert.equal(app.hasAttribute("inert"), true); assert.equal(app.getAttribute("aria-hidden"), "true");
  assert.equal(document.body.hasAttribute("inert"), false);
  assert.equal(document.activeElement?.textContent, "Skip intro ↗");
  await render({ route: "/perps" });
  let backgroundShortcut = 0;
  window.addEventListener("keydown", () => backgroundShortcut++);
  await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "/", bubbles: true })));
  assert.equal(backgroundShortcut, 0);
  await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(app.hasAttribute("inert"), false); assert.equal(app.getAttribute("aria-hidden"), "false");
  const heading = document.activeElement!;
  assert.equal(heading.tagName, "H1"); assert.equal(heading.getAttribute("tabindex"), "-1", "keep the destination focusable until the reader moves on");
  (ui.container.querySelector(".app .trading-mode-toggle button") as HTMLButtonElement).focus();
  assert.equal(heading.hasAttribute("tabindex"), false, "restore the original heading attribute on blur");
  assert.equal(scene.element.childElementCount, 0); assert.deepEqual(destinations, ["/perps"]);
});

test("Skip and unmount restore an already-inert background without removing its original state", async () => {
  await render(); const app = ui.container.querySelector<HTMLElement>(".app")!;
  app.setAttribute("inert", "original"); app.setAttribute("aria-hidden", "true");
  await ui.click("Perps"); await ui.click("Skip intro ↗");
  assert.equal(app.getAttribute("inert"), "original"); assert.equal(app.getAttribute("aria-hidden"), "true");
  await ui.click("Perps"); const scene = controller.transition!.scene!;
  await ui.render(null);
  assert.equal(scene.element.childElementCount, 0); assert.equal(app.getAttribute("inert"), "original");
});

test("stalled destination has a hard deadline and can never retain a frozen account screen", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await render(); await ui.click("Perps");
  const scene = controller.transition!.scene!;
  await act(async () => context.mock.timers.tick(MODE_TRANSITION_TIMEOUT));
  assert.equal(controller.transition, null); assert.equal(scene.element.childElementCount, 0);
  assert.equal(ui.container.querySelector(".app")?.hasAttribute("inert"), false);
});

test("StrictMode setup/cleanup/setup keeps one playback and returns the destination focus", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  ui.dom.window.history.replaceState(null, "", "/home");
  await ui.render(h(StrictMode, {}, h(Harness)));
  await ui.click("Perps");
  assert.equal(loads, 1); assert.deepEqual(destinations, ["/perps"]);
  const scene = controller.transition!.scene!;
  ui.dom.window.history.replaceState(null, "", "/perps");
  await ui.render(h(StrictMode, {}, h(Harness, { route: "/perps" })));
  await act(async () => context.mock.timers.tick(visuals.MODE_SUIT_DURATION.dramatic));
  assert.equal(controller.transition, null); assert.equal(scene.element.childElementCount, 0);
  assert.equal(ui.container.querySelector(".app")?.hasAttribute("inert"), false);
  assert.equal(document.activeElement?.textContent, "Paper Perps");
});

test("ready-route loss and synchronous same-owner invalidation release the active scene", async () => {
  await render(); await ui.click("Perps"); await render({ route: "/perps" });
  const first = controller.transition!.scene!;
  await render({ route: "/grant?wallet=perps" });
  assert.equal(first.element.childElementCount, 0); assert.equal(controller.transition, null);
  await render(); await ui.click("Perps"); const second = controller.transition!.scene!;
  await act(async () => {
    controller.cancel();
    assert.equal(second.element.childElementCount, 0, "private pixels are destroyed before owner state is cleared");
  });
  assert.equal(ui.container.querySelector(".app")?.hasAttribute("inert"), false);
  assert.equal(ui.container.querySelector(".perps-entrance"), null);
});

test("a late old completion cannot cancel a newer animation", async () => {
  await render(); await ui.click("Perps"); const old = controller.transition!;
  await act(async () => controller.cancel());
  await ui.click("Perps"); const current = controller.transition!;
  await act(async () => old.finish());
  assert.equal(controller.transition, current); assert.ok(current.scene!.element.childElementCount > 0);
});

test("App places the offered switch in the desktop search row and visible mobile header, outside Solana", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const header = readFileSync(new URL("./Desktop.tsx", import.meta.url), "utf8");
  assert.match(app, /modeOffered = perps && screen\.kind !== "solana" && selectedWallet !== "invalid"/);
  assert.match(app, /DesktopHeader tradingMode=\{tradingMode\}/);
  assert.match(app, /!desktop && tradingMode && <div className="mobile-mode-bar"/);
  assert.match(header, /className="desktop-mode-controls">\{searchButton\}\{tradingMode\}/);
  assert.match(app, /const invalidateOwnerView = \(\) => \{\s*modeTransition\.cancel\(\);\s*clockShell\.invalidate\(\)/);
  assert.match(app, /identity: `\$\{epoch\}:/, "same-owner signout/signin must advance the visual generation too");
});
