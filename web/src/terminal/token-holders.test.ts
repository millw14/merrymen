/**
 * THE TOKEN PAGE'S HOLDERS, BEFORE AND AFTER THEY ARE READ.
 *
 * The holders come from a fetch in an effect, and until it answered the page
 * said "Agents holding 0" and "No public agent holdings reported yet" — two
 * claims about a request that had not come back. Token.tsx itself cannot be
 * rendered here (its chart imports an ESM-only package the runner cannot
 * load), so the decision it renders from lives in token-holders.ts and is
 * executed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdersFigure, holdersList } from "./token-holders";

describe("the agents-holding figure", () => {
  it("is a dash while the read is in flight, and when it failed", () => {
    assert.equal(holdersFigure("loading", null), "—");
    assert.equal(holdersFigure("failed", null), "—");
  });

  it("is the count once read, zero included", () => {
    assert.equal(holdersFigure("ok", { published: 0, total: 0 }), "0");
    assert.equal(holdersFigure("ok", { published: 3, total: 3 }), "3");
  });
});

describe("the holders list", () => {
  it("draws as loading until the read answers — never as empty", () => {
    assert.equal(holdersList("loading", 0), "loading");
  });

  it("is empty only when a read that succeeded found nobody", () => {
    assert.equal(holdersList("ok", 0), "empty");
    assert.equal(holdersList("failed", 0), "failed", "a failed read is not an empty one");
  });

  it("is the table once there is someone to list", () => {
    assert.equal(holdersList("ok", 2), "table");
  });
});

describe("how many agents hold it", () => {
  // The figure was the count of PUBLIC holders with a profile, so a token held
  // by three agents that keep their books private read "Agents holding 0" over
  // a line saying "0 of 3 agents publish their positions".
  it("counts the agents that do not publish their book as well as those that do", async () => {
    const { coverageOf } = await import("./token-holders");
    const coverage = coverageOf({ holders: [], privateHolders: 3 });
    assert.deepEqual(coverage, { published: 0, total: 3 });
    assert.equal(holdersFigure("ok", coverage), "3");
    assert.equal(holdersFigure("ok", coverageOf({ holders: [{}, {}], privateHolders: 1 })), "3");
    assert.equal(holdersFigure("loading", coverage), "—");
  });
});

describe("the holders read itself", () => {
  it("gives up after its time limit rather than drawing a skeleton for ever", async () => {
    const { readTokenPage } = await import("./token-holders");
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    // AbortSignal.timeout does not hold the process open, and nothing else here
    // would: this timer keeps the runner waiting for the abort it is testing.
    const hold = setTimeout(() => {}, 5_000);
    try {
      assert.deepEqual(await readTokenPage("0xabc", { fetch: hang, timeoutMs: 20 }), { ok: false });
    } finally {
      clearTimeout(hold);
    }
  });

  it("a refused read is a failed one, and an answered one is data", async () => {
    const { readTokenPage } = await import("./token-holders");
    const refused = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    assert.deepEqual(await readTokenPage("0xabc", { fetch: refused }), { ok: false });
    let asked = "";
    const answered = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ ledger: { holders: [] } }), { status: 200 });
    }) as typeof fetch;
    const r = await readTokenPage("0xAbC", { fetch: answered });
    assert.equal(r.ok, true);
    assert.equal(asked, "/api/tokens/0xAbC?activity=1");
  });
});
