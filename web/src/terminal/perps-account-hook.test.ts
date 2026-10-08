import assert from "node:assert/strict";
import { it } from "node:test";
import React, { act } from "react";
import { usePerpsAccount } from "./usePerpsAccount";
import { testDom, json, deferred } from "./test-dom";
const A = `0x${"1".repeat(40)}`, B = `0x${"2".repeat(40)}`, wallet = `0x${"3".repeat(40)}`;
function View({ owner }: { owner: string | null }) { const state = usePerpsAccount({ hosted: true, address: owner }); return React.createElement("p", null, `${state.account?.status.grant?.smartAccount ?? "none"}|${state.failed ? "failed" : "ready"}`); }
const report = (owner: string, account = wallet) => ({ state: "ready", owner, generatedAtMs: Date.now(), account: { smartAccount: account, chainId: 4663 }, perps: null, perpsAccount: null });
const status = { exists: true, grant: { smartAccount: wallet, chainId: 4663 } };
it("reads only dedicated purpose and refuses another owner or a mismatched grant report", async () => {
  const ui = testDom(), original = globalThis.fetch, urls: string[] = [];
  try {
    globalThis.fetch = async url => { urls.push(String(url)); return json(String(url).includes("/grants") ? status : report(A)); };
    await ui.render(React.createElement(View, { owner: A })); assert.match(ui.container.textContent!, new RegExp(wallet));
    assert.ok(urls.every(url => new URL(url, "http://local").searchParams.get("purpose") === "perps"));
    assert.ok(urls.some(url => new URL(url, "http://local").searchParams.get("owner") === A));
    globalThis.fetch = async url => json(String(url).includes("/grants") ? status : report(A));
    await ui.render(React.createElement(View, { owner: B })); assert.equal(ui.container.textContent, "none|failed");
  } finally { globalThis.fetch = original; await ui.close(); }
});
it("an old delayed response cannot populate the next owner's dedicated account", async () => {
  const ui = testDom(), original = globalThis.fetch, pending = deferred<Response>();
  try {
    globalThis.fetch = async url => String(url).includes("/grants") ? json(status) : pending.promise;
    await ui.render(React.createElement(View, { owner: A }));
    globalThis.fetch = async url => json(String(url).includes("/grants") ? { exists: false } : { ...report(B), state: "not-configured", account: null });
    await ui.render(React.createElement(View, { owner: B }));
    await act(async () => pending.resolve(json(report(A))));
    assert.equal(ui.container.textContent, "none|ready");
    await ui.render(React.createElement(View, { owner: null })); assert.equal(ui.container.textContent, "none|ready");
  } finally { globalThis.fetch = original; await ui.close(); }
});
