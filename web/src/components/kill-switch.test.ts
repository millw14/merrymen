import assert from "node:assert/strict";
import React from "react";
import { afterEach, beforeEach, it, mock } from "node:test";
import { testDom } from "../terminal/test-dom";
import { KillSwitch } from "./KillSwitch";

const originalFetch = globalThis.fetch;
let ui: ReturnType<typeof testDom>;
beforeEach(() => {
  ui = testDom();
  mock.timers.enable({ apis: ["setTimeout"] });
  localStorage.setItem("merrymen.grant.v1", "recoverable wallet fixture");
  localStorage.setItem("merrymen.grant.perps.v1", "recoverable perps wallet fixture");
});
afterEach(async () => {
  await ui.close();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
});

for (const failure of ["network", 400, 500] as const) {
  it(`keeps recovery and refuses a success claim when explicit deletion fails (${failure})`, async () => {
    globalThis.fetch = async (_url, init) => {
      assert.equal(init?.method, "DELETE");
      assert.deepEqual(JSON.parse(String(init?.body)), { purpose: "delete-agent", expectedTenant: "0xowner" });
      if (failure === "network") throw new Error("offline");
      return new Response(JSON.stringify({ error: "deletion refused" }), { status: failure });
    };
    await ui.render(React.createElement(KillSwitch, { expectedTenant: "0xowner" }));
    await ui.click("◉ kill all agents");
    await ui.click("◉ press again to confirm");
    assert.match(ui.container.textContent!, /try the kill again/);
    assert.doesNotMatch(ui.container.textContent!, /permission deleted|all agents killed/);
    assert.equal(localStorage.getItem("merrymen.grant.v1"), "recoverable wallet fixture");
    assert.equal(localStorage.getItem("merrymen.grant.perps.v1"), "recoverable perps wallet fixture");
  });
}

// The kill names no wallet, so it stopped both: each browser slot is archived (its owner key kept) and cleared,
// so neither the Spot nor the Perps screen offers to re-arm a permission the kill just removed.
it("a confirmed kill archives and clears BOTH wallets' browser slots, Spot and Perps", async () => {
  const spot = JSON.stringify({ smartAccount: `0x${"aa".repeat(20)}`, demoOwnerPrivateKey: `0x${"01".repeat(32)}` });
  const perps = JSON.stringify({ smartAccount: `0x${"bb".repeat(20)}`, demoOwnerPrivateKey: `0x${"01".repeat(32)}` });
  localStorage.setItem("merrymen.grant.v1", spot);
  localStorage.setItem("merrymen.grant.perps.v1", perps);
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, "DELETE");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await ui.render(React.createElement(KillSwitch, { expectedTenant: "0xowner" }));
  await ui.click("◉ kill all agents");
  await ui.click("◉ press again to confirm");
  assert.match(ui.container.textContent!, /permission deleted/);
  assert.equal(localStorage.getItem("merrymen.grant.v1"), null);
  assert.equal(localStorage.getItem("merrymen.grant.perps.v1"), null);
  assert.equal(localStorage.getItem(`merrymen.grant.archive.0x${"aa".repeat(20)}`), spot);
  assert.equal(localStorage.getItem(`merrymen.grant.archive.0x${"bb".repeat(20)}`), perps);
});

it("cannot delete before the signed-in tenant is known", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected request"); };
  await ui.render(React.createElement(KillSwitch, { ready: false }));
  await ui.click("◉ kill all agents");
  assert.equal(calls, 0);
  assert.equal(ui.container.querySelector("button")?.disabled, true);
});
