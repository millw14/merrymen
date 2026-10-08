import assert from "node:assert/strict";
import { it } from "node:test";
import React, { act } from "react";
import { PerpsExitDialog } from "./PerpsExitDialog";
import { testDom, json, deferred } from "./test-dom";
const owner = `0x${"1".repeat(40)}`, account = `0x${"2".repeat(40)}`;
const props = { owner, account, book: "live" as const, market: "BTC-PERP", onClose() {}, onChanged() {} };
it("explicit confirmation queues only the named Perps account/book and never claims a queued fill", async () => {
  const ui = testDom(), original = globalThis.fetch, calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) }); return json(init?.method === "POST" ? { id: "exit-id", expiresInMs: 300000 } : { state: "queued" }); };
  try {
    await ui.render(React.createElement(PerpsExitDialog, props)); assert.equal(calls.length, 0);
    await ui.click("Confirm real-money exit");
    assert.deepEqual(calls[0], { url: "/api/orders?purpose=perps", body: { owner, expectedAccount: account, purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "live" } });
    assert.equal(new URL(calls[1].url, "http://local").searchParams.get("owner"), owner);
    assert.equal(new URL(calls[1].url, "http://local").searchParams.get("purpose"), "perps");
    assert.match(ui.container.textContent!, /positions may still be open/); assert.doesNotMatch(ui.container.textContent!, /Recorded outcome: filled/);
  } finally { globalThis.fetch = original; await ui.close(); }
});
it("flatten names its paper book and reports only the worker's completed outcome", async () => {
  const ui = testDom(), original = globalThis.fetch; let body: Record<string, unknown> | undefined, changed = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") { body = JSON.parse(String(init.body)); return json({ id: "flatten", expiresInMs: 300000 }); }
    return json({ state: "done", result: "Paper book flattened and entries halted.", receipt: { status: "filled", side: null, symbol: null, token: null, usdgActual: null, txHash: null, rejectRule: null } });
  };
  try {
    await ui.render(React.createElement(PerpsExitDialog, { ...props, market: undefined, book: "paper", onChanged() { changed++; } }));
    await ui.click("Confirm paper exit");
    assert.equal(body?.purpose, "flatten-perps"); assert.equal(body?.symbol, "ALL-PERPS"); assert.equal(body?.book, "paper");
    assert.match(ui.container.textContent!, /Worker result: Paper book flattened/); assert.match(ui.container.textContent!, /Recorded outcome: filled/); assert.equal(changed, 1);
  } finally { globalThis.fetch = original; await ui.close(); }
});
it("lost responses are not retried and a changed owner ignores a prior submission result", async () => {
  const ui = testDom(), original = globalThis.fetch, pending = deferred<Response>(); let calls = 0;
  globalThis.fetch = async () => { calls++; return pending.promise; };
  try {
    await ui.render(React.createElement(PerpsExitDialog, props)); await ui.click("Confirm real-money exit");
    await ui.render(React.createElement(PerpsExitDialog, { ...props, owner: account }));
    await act(async () => pending.resolve(json({ id: "old", expiresInMs: 300000 })));
    assert.equal(calls, 1); assert.doesNotMatch(ui.container.textContent!, /Exit queued/);
    globalThis.fetch = async () => { calls++; throw new Error("lost"); };
    await ui.click("Confirm real-money exit");
    assert.match(ui.container.textContent!, /response was lost/);
    assert.equal([...ui.container.querySelectorAll("button")].some(b => /Confirm.*exit/.test(b.textContent ?? "")), false);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; await ui.close(); }
});
