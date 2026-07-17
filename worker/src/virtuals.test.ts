import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampTitle, exchangeToken, postLog, type FetchLike, type TerminalLog } from "./virtuals";

/** A scripted fetch that records calls and returns queued responses by URL substring. */
function mockFetch(routes: Record<string, { ok: boolean; status: number; body: unknown }>) {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { ok: false, status: 404, body: {} };
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return { fn, calls };
}

const LOG: TerminalLog = { framework_name: "merrymen", category_name: "general", title: "t", body: "b" };

describe("virtuals client", () => {
  it("exchanges an API key for a bearer token (nested data.token shape)", async () => {
    const { fn, calls } = mockFetch({
      "accesses/tokens": { ok: true, status: 200, body: { data: { token: "brr-123" } } },
    });
    const token = await exchangeToken("key-abc", fn);
    assert.equal(token, "brr-123");
    // Sent the key in the X-API-KEY header, not the URL.
    assert.equal(calls[0]!.init?.headers?.["X-API-KEY"], "key-abc");
    assert.equal(calls[0]!.init?.method, "POST");
    assert.ok(!calls[0]!.url.includes("key-abc"));
  });

  it("also accepts a flat token / accessToken shape", async () => {
    const a = mockFetch({ "accesses/tokens": { ok: true, status: 200, body: { token: "flat" } } });
    assert.equal(await exchangeToken("k", a.fn), "flat");
    const b = mockFetch({ "accesses/tokens": { ok: true, status: 200, body: { accessToken: "camel" } } });
    assert.equal(await exchangeToken("k", b.fn), "camel");
  });

  it("returns null (non-fatal) on a bad response or unrecognized shape", async () => {
    const bad = mockFetch({ "accesses/tokens": { ok: false, status: 401, body: {} } });
    assert.equal(await exchangeToken("k", bad.fn), null);
    const weird = mockFetch({ "accesses/tokens": { ok: true, status: 200, body: { nope: 1 } } });
    assert.equal(await exchangeToken("k", weird.fn), null);
  });

  it("posts a log with the bearer token in the Authorization header", async () => {
    const { fn, calls } = mockFetch({ "/logs": { ok: true, status: 201, body: { ok: true } } });
    const r = await postLog("brr-123", LOG, fn);
    assert.deepEqual(r, { ok: true, status: 201 });
    assert.equal(calls[0]!.init?.headers?.Authorization, "Bearer brr-123");
    assert.deepEqual(JSON.parse(calls[0]!.init?.body ?? "{}"), LOG);
  });

  it("surfaces a failed post without throwing", async () => {
    const { fn } = mockFetch({ "/logs": { ok: false, status: 500, body: {} } });
    assert.deepEqual(await postLog("t", LOG, fn), { ok: false, status: 500 });
  });

  it("clamps a title to the 255-char API limit", () => {
    assert.equal(clampTitle("short"), "short");
    const long = "x".repeat(300);
    const out = clampTitle(long);
    assert.equal(out.length, 253); // 252 + ellipsis
    assert.ok(out.endsWith("…"));
  });
});
