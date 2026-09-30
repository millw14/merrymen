/**
 * WHAT THE BUILDER DESK SPENDS, AND WHAT IT REFUSES TO REMEMBER.
 *
 * The adapter is tested where it lives. What is left here is the scheduling,
 * and two of its rules are the kind that look like tuning until the day they
 * are wrong: a failure must never be cached as a record, and a rate limit must
 * stop the whole pass rather than only the request that hit it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addressesOf, makeBuilderDesk } from "./builder-pass";

const NOW = 1_770_000_000;
const at = (n: number) => "0x" + n.toString(16).padStart(40, "0");

const scan = (address: string, over: Record<string, unknown> = {}) => ({
  found: true,
  chainId: 4663,
  contractAddress: address,
  status_label: "Shipping",
  verified_builder: true,
  activity: { commits_30d: 12, releases_30d: 1, ships_30d: 2, last_ship: "2026-09-21" },
  project: { name: "A Project", symbol: "PRJ" },
  project_url: "https://example.invalid/p",
  ...over,
});

/** A fetch stub that records every address it was asked about. */
function recorder(reply: (address: string, n: number) => Response) {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    const address = new URL(url).searchParams.get("token") ?? "";
    seen.push(address);
    return reply(address, seen.length);
  }) as unknown as typeof fetch;
  return { seen, impl };
}

const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("addressesOf", () => {
  it("lowercases, dedupes, drops malformed and keeps order", () => {
    assert.deepEqual(
      addressesOf([at(2).toUpperCase(), at(1), at(2), "nope", null, ""]),
      [at(2), at(1)],
    );
  });
});

describe("the per-pass ceiling", () => {
  it("spends no more than it is given, in the order it is given", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ perPass: 3, fetchImpl: r.impl });
    const want = [at(1), at(2), at(3), at(4), at(5)];
    const out = await desk.refresh(want, NOW);
    assert.equal(out.asked, 3);
    assert.deepEqual(r.seen, [at(1), at(2), at(3)]);
  });

  it("and the next pass picks up where the budget ran out", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ perPass: 2, fetchImpl: r.impl });
    const want = [at(1), at(2), at(3), at(4)];
    await desk.refresh(want, NOW);
    await desk.refresh(want, NOW + 15);
    assert.deepEqual(r.seen, [at(1), at(2), at(3), at(4)], "the cached two are skipped, not re-asked");
  });
});

describe("the cache", () => {
  it("a fresh record is not re-fetched", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ ttlSec: 3600, fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 60);
    assert.equal(r.seen.length, 1);
  });

  it("a stale one is", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ ttlSec: 3600, fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 3601);
    assert.equal(r.seen.length, 2);
  });

  it("AN UNLISTED ANSWER IS CACHED FOR MUCH LONGER THAN A LISTED ONE", async () => {
    // The rule that keeps a two-hundred-coin universe from spending every pass
    // re-confirming that the directory still has nothing. Somebody submitting a
    // project is not a daily event; commits are.
    const r = recorder((a) => ok({ found: false, chainId: 4663, contractAddress: a }));
    const desk = makeBuilderDesk({ ttlSec: 3600, unlistedTtlSec: 86_400, fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 7200);
    assert.equal(r.seen.length, 1, "two hours on is still a fair answer for a coverage gap");
    await desk.refresh([at(1)], NOW + 86_401);
    assert.equal(r.seen.length, 2);
  });

  it("an unlisted answer IS a record, and reaches the caller", async () => {
    const r = recorder((a) => ok({ found: false, chainId: 4663, contractAddress: a }));
    const desk = makeBuilderDesk({ fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    const [record] = desk.recordsFor([at(1)], NOW);
    assert.ok(record, "the desk answered; the renderer decides what to do with that");
    assert.equal(record.found, false);
  });
});

describe("A FAILURE IS NEVER STORED AS A RECORD", () => {
  const failing = (body: unknown, status: number) => {
    const r = recorder(() => ok(body, status));
    return { r, desk: makeBuilderDesk({ fetchImpl: r.impl }) };
  };

  it("an http error leaves no record behind", async () => {
    const { r, desk } = failing({}, 500);
    await desk.refresh([at(1)], NOW);
    assert.equal(r.seen.length, 1);
    assert.deepEqual(desk.recordsFor([at(1)], NOW), [], "an outage is not a finding about a token");
  });

  it("nor does a wrong chain", async () => {
    const r = recorder(() => ok({ found: false, chainId: 4663, reason: "chain" }));
    const desk = makeBuilderDesk({ fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    assert.deepEqual(desk.recordsFor([at(1)], NOW), []);
  });

  it("and a failure is retried next pass rather than cached as an answer", async () => {
    let n = 0;
    const impl = (async (url: string) => {
      n += 1;
      const a = new URL(url).searchParams.get("token") ?? "";
      return n === 1 ? ok({}, 500) : ok(scan(a));
    }) as unknown as typeof fetch;
    const desk = makeBuilderDesk({ fetchImpl: impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 15);
    assert.equal(n, 2);
    assert.equal(desk.recordsFor([at(1)], NOW)[0]?.found, true);
  });
});

describe("A RATE LIMIT STOPS THE WHOLE PASS", () => {
  it("the queue behind it is not attempted", async () => {
    const r = recorder((_a, n) => (n === 1 ? ok({}, 429, { "retry-after": "120" }) : ok(scan(_a))));
    const desk = makeBuilderDesk({ perPass: 10, fetchImpl: r.impl });
    await desk.refresh([at(1), at(2), at(3)], NOW);
    assert.equal(r.seen.length, 1, "the limit is per key, so the next address hits the same wall");
  });

  it("and the hold is honoured on later passes", async () => {
    const r = recorder((_a, n) => (n === 1 ? ok({}, 429, { "retry-after": "120" }) : ok(scan(_a))));
    const desk = makeBuilderDesk({ fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 60);
    assert.equal(r.seen.length, 1, "still inside the wait the directory asked for");
    await desk.refresh([at(1)], NOW + 121);
    assert.equal(r.seen.length, 2);
  });

  it("a rate limit with no header still backs off", async () => {
    const r = recorder(() => ok({}, 429));
    const desk = makeBuilderDesk({ fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    await desk.refresh([at(1)], NOW + 30);
    assert.equal(r.seen.length, 1, "a minute, which is the window the documented limit is measured over");
  });
});

describe("recordsFor", () => {
  it("fetches nothing and returns only what is cached", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    const out = desk.recordsFor([at(1), at(2)], NOW);
    assert.equal(out.length, 1);
    assert.equal(r.seen.length, 1, "a read is never a fetch");
  });

  it("STALE IS STILL AN ANSWER — the renderer states the age", async () => {
    const r = recorder((a) => ok(scan(a)));
    const desk = makeBuilderDesk({ ttlSec: 600, fetchImpl: r.impl });
    await desk.refresh([at(1)], NOW);
    assert.equal(
      desk.recordsFor([at(1)], NOW + 99_999).length,
      1,
      "a lens that goes silent on every late refresh is worse than one that dates itself",
    );
  });
});

describe("the plan line", () => {
  it("says whether it is keyed, because an anonymous desk is not a broken one", () => {
    assert.match(makeBuilderDesk({}).plan().why, /anonymous/);
    assert.match(makeBuilderDesk({ apiKey: "k" }).plan().why, /keyed/);
  });
});
