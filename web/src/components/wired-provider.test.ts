import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { WiredProvider, useWired } from "./WiredProvider";
import { deferred, json, testDom } from "../terminal/test-dom";

let ui: ReturnType<typeof testDom>;
let view: ReturnType<typeof useWired>;
const originalFetch = globalThis.fetch;
function Consumer() { view = useWired(); return React.createElement("div", null, JSON.stringify({ wired: view.wired, known: view.known })); }
const provider = (tenant: string | null) => React.createElement(WiredProvider, { tenant, children: React.createElement(Consumer) });
beforeEach(() => { ui = testDom(); });
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
it("loads after sign-in, replaces accounts, and clears immediately on logout", async () => {
  let account = "alpha"; let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ wired: [account], max: 8 }); };
  await ui.render(provider(null)); assert.equal(calls, 0); assert.equal(view.known, false);
  await ui.render(provider("0xa")); assert.deepEqual(view.wired, ["alpha"]);
  account = "beta";
  await ui.render(provider("0xb")); assert.deepEqual(view.wired, ["beta"]);
  await ui.render(provider(null)); assert.deepEqual(view.wired, []); assert.equal(view.known, false);
  await act(async () => { await view.toggle("new", true); }); assert.equal(calls, 2);
});
it("ignores an old account GET that resolves after a switch", async () => {
  const old = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? old.promise : json({ wired: ["beta"] });
  await ui.render(provider("0xa")); await ui.render(provider("0xb"));
  await act(async () => old.resolve(json({ wired: ["alpha"] })));
  assert.deepEqual(view.wired, ["beta"]);
});
it("rolls back refused and failed writes, and ignores late writes after logout", async () => {
  let mode = "get"; const old = deferred<Response>();
  globalThis.fetch = async (_, init) => {
    if (!init?.method) return json({ wired: ["alpha"], max: 8 });
    if (mode === "network") throw new Error("offline");
    if (mode === "late") return old.promise;
    return json({ error: "signed out" }, 401);
  };
  await ui.render(provider("0xa"));
  await act(async () => { await view.toggle("other", true); });
  assert.deepEqual(view.wired, ["alpha"]); assert.ok(view.error);
  mode = "network";
  await act(async () => { await view.toggle("alpha", false); });
  assert.deepEqual(view.wired, ["alpha"]);
  mode = "late";
  let saving!: Promise<void>;
  await act(async () => { saving = view.toggle("other", true); });
  assert.deepEqual(view.wired, ["other", "alpha"]);
  await ui.render(provider(null));
  await act(async () => { old.resolve(json({ wired: ["other", "alpha"] })); await saving; });
  assert.deepEqual(view.wired, []);
});
it("serializes clicks while a write is pending and reconciles with the server", async () => {
  const pending = deferred<Response>(); let writes = 0;
  globalThis.fetch = async (_, init) => { if (!init?.method) return json({ wired: [] }); writes++; return pending.promise; };
  await ui.render(provider("0xa")); let saving!: Promise<void>;
  await act(async () => { saving = view.toggle("one", true); await view.toggle("two", true); });
  assert.equal(writes, 1);
  await act(async () => { pending.resolve(json({ wired: ["one"] })); await saving; });
  assert.deepEqual(view.wired, ["one"]); assert.equal(view.busy, false);
});
