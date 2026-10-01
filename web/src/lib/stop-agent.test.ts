import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { stopAgent } from "./stop-agent";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
it("rejects every failed response and network error instead of claiming a stop", async () => {
  for (const status of [401, 409, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "stop refused" }), { status });
    await assert.rejects(stopAgent(), /stop refused/);
  }
  globalThis.fetch = async () => { throw new Error("network"); };
  await assert.rejects(stopAgent(), /did not confirm/);
});
it("binds the stop to the account the caller confirmed", async () => {
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), { expectedTenant: "0xowner" });
    return new Response(JSON.stringify({ ok: true }));
  };
  await stopAgent("0xowner");
});
