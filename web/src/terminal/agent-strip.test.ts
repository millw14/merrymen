/**
 * THE TRENCHER LINE, AS HOME AND THE DESKTOP RAIL DRAW IT (TW-2).
 *
 * The strip read "let trencher trade for real" and nothing else, so a PAPER
 * agent with the box ticked showed "Trencher: on, trading real money" in green
 * under its PAPER chip. The row now takes the rail from /api/grants — the mode
 * App.tsx hands both screens — and the worker's rule decides the words:
 * `!paperActive() && !cfg.trencherLiveEnabled` empties trencher's feed.
 *
 * The real component, in a DOM, reading its settings over a scripted network.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import { AgentStrip } from "./AgentStrip";
import type { AgentMode } from "./agent-status";
import { json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
/** The stored box, or undefined when it was never saved. */
let allowed: boolean | undefined;
/** What /api/settings says of the tenant: an address hosted, null self-hosted. */
let owner: string | null;

beforeEach(() => {
  ui = testDom();
  owner = "0x" + "a".repeat(40);
  // A Next <Link> on the strip schedules its prefetch through `self`.
  (globalThis as { self?: unknown }).self = ui.dom.window;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/settings") {
      return json({ values: { strategy: "trencher", assetMode: "crypto", trencherLiveEnabled: allowed }, owner });
    }
    return json({ error: "not scripted" }, 404);
  }) as typeof fetch;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "self");
});

/** The Trencher row once its settings have landed: what it says, and in which tone. */
async function trencherLine(mode: AgentMode, permission: boolean | undefined) {
  allowed = permission;
  await ui.render(createElement(AgentStrip, { hasAgent: true, mode }));
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
  }
  const row = Array.from(ui.container.querySelectorAll(".agent-strip-row")).find(
    (r) => r.querySelector(".agent-strip-label")?.textContent === "Trencher",
  );
  assert.ok(row, "the strip draws a Trencher row");
  const value = row.querySelector(".agent-strip-value")?.textContent ?? "";
  assert.notEqual(value, "checking…", "the settings landed");
  return { value, tone: row.className.replace("agent-strip-row", "").trim() };
}

describe("the strip's Trencher line says whose money", () => {
  it("A PAPER AGENT WITH THE BOX TICKED IS PRACTICE MONEY, not real money", async () => {
    const line = await trencherLine("paper", true);
    assert.equal(line.value, "on, practice money only");
    assert.doesNotMatch(line.value, /real money/);
    assert.notEqual(line.tone, "is-ok", "not the green of a live rail");
  });

  it("a live agent allowed to trench for real says real money", async () => {
    assert.deepEqual(await trencherLine("live", true), { value: "on, trading real money", tone: "is-ok" });
  });

  it("A LIVE AGENT WITHOUT THE PERMISSION IS TOLD IT BUYS NOTHING, as a warning", async () => {
    const line = await trencherLine("live", false);
    assert.equal(line.tone, "is-warn");
    assert.match(line.value, /buys nothing/);
    assert.doesNotMatch(line.value, /practice/, "the worker practises nothing on the live rail");
  });

  it("while the rail is unread, it says what the permission allows and claims no trading", async () => {
    const line = await trencherLine(null, true);
    assert.equal(line.value, "on, allowed to trade for real when your agent is live");
    assert.doesNotMatch(line.value, /trading real money|practice/);
  });

  it("A SELF-HOSTED BOX NEVER SAVED IS NOT TOLD IT BUYS NOTHING — MERRYMEN_TRENCHER_LIVE may be trading for real", async () => {
    owner = null;
    const line = await trencherLine("live", undefined);
    assert.match(line.value, /environment decides/);
    assert.doesNotMatch(line.value, /buys nothing|trading real money/);
    assert.equal(line.tone, "is-quiet");
  });

  it("a hosted tenant's box never saved is the default, off — and a live agent is warned", async () => {
    const line = await trencherLine("live", undefined);
    assert.equal(line.tone, "is-warn");
    assert.match(line.value, /buys nothing/);
  });
});
