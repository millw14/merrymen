import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { deleteAgent, stopAgentForReplacement } from "./stop-agent";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
it("rejects every failed response and network error instead of claiming a stop", async () => {
  for (const status of [401, 409, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "stop refused" }), { status });
    await assert.rejects(deleteAgent(), /stop refused/);
  }
  globalThis.fetch = async () => { throw new Error("network"); };
  await assert.rejects(deleteAgent(), /did not confirm/);
});
it("binds the stop to the account the caller confirmed", async () => {
  globalThis.fetch = async (url, init) => {
    // A KILL NAMES NO WALLET: it stops every one, and the route refuses a
    // kill that names one (killNamesWallet).
    assert.equal(url, "/api/grants");
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), { purpose: "delete-agent", expectedTenant: "0xowner" });
    return new Response(JSON.stringify({ ok: true }));
  };
  await deleteAgent("0xowner");
});

it("permission replacement explicitly preserves memory and binds the outgoing grant", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/grants");
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      purpose: "permission-replacement", expectedTenant: "0xowner",
      expectedAccount: "0xaccount", expectedSession: "0xsession",
    });
    return new Response(JSON.stringify({ ok: true }));
  };
  await stopAgentForReplacement("spot", "0xowner", "0xaccount", "0xsession");
});

it("a replacement names its wallet: Spot's request is the one it always was, Perps' says wallet=perps", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.method, "DELETE");
    assert.equal(JSON.parse(String(init?.body)).purpose, "permission-replacement");
    return new Response(JSON.stringify({ ok: true }));
  };
  await stopAgentForReplacement("spot", "0xowner", "0xaccount");
  await stopAgentForReplacement("perps", "0xowner", "0xperpsaccount", "0xsession");
  assert.deepEqual(urls, ["/api/grants", "/api/grants?wallet=perps"]);
  // A wallet this build does not know sends nothing: never read as Spot.
  await assert.rejects(stopAgentForReplacement("solana" as never, "0xowner", "0xaccount"), /Unrecognised wallet/);
  assert.equal(urls.length, 2);
});

it("replacement failures never fall back to the destructive stop", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).purpose, "permission-replacement");
    return new Response(JSON.stringify({ error: "permission changed" }), { status: 409 });
  };
  await assert.rejects(stopAgentForReplacement("spot", "0xowner", "0xaccount"), /permission changed/);
  assert.equal(calls, 1);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(stopAgentForReplacement("spot", "0xowner", "0xaccount"), /did not confirm/);
});
