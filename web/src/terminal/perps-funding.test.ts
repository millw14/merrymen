import assert from "node:assert/strict";
import { it } from "node:test";
import { FundingPreparationError } from "../lib/perps-funding-intent";
import React, { act } from "react";
import { PerpsFunding, perpsFundingMicro, type PerpsTransfer } from "./PerpsFunding";
import { testDom, deferred } from "./test-dom";
const account = `0x${"2".repeat(40)}`, owner = `0x${"1".repeat(40)}`, hash = `0x${"3".repeat(64)}`;
const base = { account, chainId: 4663, owner, source: { address: owner, kind: "owner" as const }, onClose() {} };
async function enter(ui: ReturnType<typeof testDom>, text: string) {
  const input = ui.container.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
}
it("parses exact micro USDG and rejects non-decimal or excessive precision", () => {
  assert.equal(perpsFundingMicro("9007199254.740993"), "9007199254740993");
  assert.equal(perpsFundingMicro("0.000001"), "1");
  for (const x of ["", "0", "-1", "+1", "1e2", "1,000", "0.0000001", "Infinity"]) assert.equal(perpsFundingMicro(x), null);
});
it("requires review and explicit confirmation, sends exact owner/account binding once", async () => {
  const ui = testDom(), pending = deferred<Awaited<ReturnType<PerpsTransfer>>>(), calls: unknown[] = [];
  try {
    await ui.render(React.createElement(PerpsFunding, { ...base, onTransfer: async input => { calls.push(input); return pending.promise; } }));
    await enter(ui, "12.000001"); await ui.click("Review transfer");
    assert.equal(calls.length, 0); assert.match(ui.container.textContent!, /12.000001 USDG/);
    await ui.click("Confirm USDG transfer");
    assert.deepEqual(calls, [{ amountMicro: "12000001", expectedAccount: account, expectedOwner: owner }]);
    assert.equal([...ui.container.querySelectorAll("button")].some(b => b.textContent === "Confirm USDG transfer"), false);
    await act(async () => pending.resolve({ hash, status: "submitted" }));
    assert.match(ui.container.textContent!, /Confirmation is pending/); assert.doesNotMatch(ui.container.textContent!, /Transfer confirmed/);
  } finally { await ui.close(); }
});
it("late confirmation cannot affect a changed owner and unsupported sources cannot sign", async () => {
  const ui = testDom(), pending = deferred<Awaited<ReturnType<PerpsTransfer>>>(); let confirmed = 0;
  try {
    await ui.render(React.createElement(PerpsFunding, { ...base, onTransfer: () => pending.promise, onConfirmed() { confirmed++; } }));
    await enter(ui, "1"); await ui.click("Review transfer"); await ui.click("Confirm USDG transfer");
    await ui.render(React.createElement(PerpsFunding, { ...base, owner: account, source: null }));
    await act(async () => pending.resolve({ hash, status: "confirmed" }));
    assert.equal(confirmed, 0); assert.doesNotMatch(ui.container.textContent!, /Transfer confirmed/);
    assert.equal(ui.container.querySelector("input"), null); assert.match(ui.container.textContent!, /No supported signing source/);
  } finally { await ui.close(); }
});
it("an uncertain transfer is never silently resubmitted", async () => {
  const ui = testDom(); let calls = 0;
  try {
    await ui.render(React.createElement(PerpsFunding, { ...base, onTransfer: async () => { calls++; throw new Error("receipt timed out"); } }));
    await enter(ui, "2"); await ui.click("Review transfer"); await ui.click("Confirm USDG transfer");
    assert.equal(calls, 1); assert.match(ui.container.textContent!, /outcome is not confirmed/);
    assert.equal([...ui.container.querySelectorAll("button")].some(b => /Confirm USDG|Review transfer|Change amount/.test(b.textContent ?? "")), false);
  } finally { await ui.close(); }
});

it("a known preflight refusal shows its remedy and needs another explicit confirmation", async () => {
  const ui = testDom(); let calls = 0;
  try {
    await ui.render(React.createElement(PerpsFunding, { ...base, onTransfer: async () => { calls++; throw new FundingPreparationError("The Spot wallet needs ETH for network fees."); } }));
    await enter(ui, "2"); await ui.click("Review transfer"); await ui.click("Confirm USDG transfer");
    assert.equal(calls, 1);
    assert.match(ui.container.textContent!, /needs ETH/);
    assert.match(ui.container.textContent!, /No new transfer was submitted/);
    assert.ok([...ui.container.querySelectorAll("button")].some(b => b.textContent === "Confirm USDG transfer"));
    assert.equal(calls, 1, "rendering a retry control is not another transfer");
  } finally { await ui.close(); }
});
