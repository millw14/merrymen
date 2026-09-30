/**
 * A BALANCE WE COULD NOT READ IS NOT A BALANCE OF ZERO.
 *
 * `readHolderStatus` returned the outsider floor for BOTH "this wallet holds
 * nothing" and "the chain would not answer", and the tick took `.tier` straight
 * off it. On a fleet whose mainnet reads are refused routinely — one egress IP,
 * retryCount 0, a shared circuit breaker — two things then happened on the same
 * tick:
 *
 *   the owner was told "no $MERRYMEN at your holder wallet", a confident claim
 *   about an address nobody had managed to read; and
 *
 *   effectivePerfFeeBps took the UNDISCOUNTED rate, so a tick that also set a
 *   new high-water mark accrued the full performance fee to the ledger —
 *   permanently, against a holder who had paid for the discount.
 *
 * That second one is money, which is why this file exists.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// AN UNREACHABLE CHAIN, NOT AN UNREACHABLE URL. Reads now fail over from the
// configured endpoint to the chain's public one (rpc-failover.ts), so a bogus
// URL alone no longer models "the chain would not answer" — the real public RPC
// would answer from inside a test. These cases are about what a FAILED read
// renders as, so failover is off for this file.
process.env.MERRYMEN_RPC_FAILOVER = "off";

describe("the read says whether it read", () => {
  it("NO ADDRESS AND NO ANSWER ARE DIFFERENT ARMS", async () => {
    const { readHolderStatusResult } = await import("./circle");
    // No wallet configured is a real, knowable answer — there is nothing to
    // hold anything, so the floor is the truth rather than a fallback.
    const none = await readHolderStatusResult(undefined, undefined);
    assert.equal(none.ok, true);
    assert.equal(none.status.tier.id, "outsider");
  });

  it("and a failed read is ok:false with the floor beside it", async () => {
    const { readHolderStatusResult } = await import("./circle");
    // An unroutable endpoint: the call cannot succeed, and the result must say
    // so rather than describing the wallet.
    const failed = await readHolderStatusResult(
      "http://127.0.0.1:9/none",
      `0x${"a".repeat(40)}` as `0x${string}`,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.status.tier.id, "outsider", "still fails closed as a permission");
  });
});

describe("the tick charges nobody for our outage", () => {
  it("A FAILED READ KEEPS THE LAST KNOWN-GOOD TIER", () => {
    // Not "assume they qualify" — that would grant a discount never verified.
    // Keeping the last read grants nothing new and stops an outage silently
    // repricing somebody mid-session.
    const src = read("./index.ts");
    assert.match(src, /const holderRead = await readHolderStatusResult\(/);
    assert.match(src, /if \(holderRead\.ok\) holderTier = holderRead\.status\.tier;/);
  });

  it("AND SAYS NOTHING ABOUT THE WALLET IT COULD NOT READ", () => {
    // The tier-change event is a claim about their holdings. It may only fire
    // on a read that happened.
    const src = read("./index.ts");
    assert.match(src, /if \(holderRead\.ok && holderTier\.id !== lastTierId\)/);
  });

  it("and the fee is derived from that tier, which is why this matters", () => {
    // The line this protects: a wrong tier here is a wrong number in the
    // ledger, not a wrong word on a screen.
    const src = read("./index.ts");
    assert.match(src, /const effFeeBps = effectivePerfFeeBps\(cfg\.perfFeeBps, holderTier\);/);
  });

  it("AND THE IDLE NOTICE NAMES WHICH NO IT IS", async () => {
    // Telling a holder to go and hold $MERRYMEN because our read failed is
    // advice they cannot act on — they already did it. The note is written in
    // circle-gate.ts (circleNote) and chosen by whether the read answered.
    const src = read("./index.ts");
    // Chosen by whether the shortfall rests on a reading — this tick's, or
    // the durable last good (circle-gate.ts circleStanding).
    assert.match(src, /circleNoteStep\(circleNoted, \{ short: circleShort, readOk: circle\.known \}\)/);
    const { circleNote } = await import("./circle-gate");
    const unread = circleNote("unread", { strategyName: "even-keel", accountCounts: true });
    assert.match(unread, /could not read your \$MERRYMEN balance this tick/);
    assert.match(unread, /our read failing, not your wallet/);
    assert.doesNotMatch(unread, /hold 100,000/);
  });
});

describe("the old shape survives for callers that only want a floor", () => {
  it("but it is documented as unable to answer the question that matters", () => {
    const src = read("./circle.ts");
    assert.match(src, /export async function readHolderStatus\(/);
    assert.match(src, /cannot tell you whether the\s*\*\s*answer was read or assumed/);
  });
});

/**
 * ── THE COMBINED BALANCE: THE OWNER'S WALLET PLUS THE AGENT'S ACCOUNT ──────
 *
 * $MERRYMEN an agent buys, or is sent, lands in its own account — so the tier
 * and energy both count holder + account (core energy.ts, D1). Two reads, one
 * client, one metered transport; and the tier is still EXACT: a sum with a
 * missing term is not a balance, so either read failing is ok:false, with the
 * half that did answer reported beside it for the energy gate's lower bound.
 *
 * Driven against a local JSON-RPC stand-in so the arithmetic, the failure arms
 * and the batching are all observed rather than assumed.
 */
const HOLDER = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const tok = (n: number) => BigInt(n) * 10n ** 18n;

async function chainStub(balances: Record<string, bigint | "revert">) {
  let requests = 0;
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests++;
    const one = (m: { id: number; method: string; params?: { data?: string }[] }) => {
      if (m.method !== "eth_call") return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } };
      const data = String(m.params?.[0]?.data ?? "");
      const who = `0x${data.slice(34, 74)}`.toLowerCase();
      calls.push(who);
      const b = balances[who];
      if (b === undefined || b === "revert") return { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } };
      return { jsonrpc: "2.0", id: m.id, result: `0x${b.toString(16).padStart(64, "0")}` };
    };
    const parsed = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, calls, requests: () => requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("the combined read", () => {
  it("HOLDER + ACCOUNT, SUMMED, through one client — and batched into one request", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await chainStub({ [HOLDER]: tok(60_000), [ACCOUNT]: tok(40_000) });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, ACCOUNT);
      assert.equal(r.ok, true);
      assert.equal(r.status.rawBalance, tok(100_000));
      assert.equal(r.status.tier.id, "merryman", "neither half alone reaches the Merry Man tier; together they do");
      assert.deepEqual(r.parts, { holder: tok(60_000), account: tok(40_000) });
      assert.deepEqual([...chain.calls].sort(), [HOLDER, ACCOUNT].sort());
      assert.equal(chain.requests(), 1, "two balanceOf calls, one HTTP request");
    } finally {
      await chain.close();
    }
  });

  it("EITHER READ FAILING IS ok:false — and parts say which one", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await chainStub({ [HOLDER]: tok(150_000), [ACCOUNT]: "revert" });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, ACCOUNT);
      assert.equal(r.ok, false, "a sum with a missing term is not a balance");
      assert.equal(r.status.tier.id, "outsider", "still fails closed as a permission");
      assert.deepEqual(r.parts, { holder: tok(150_000), account: null });
    } finally {
      await chain.close();
    }
    const other = await chainStub({ [HOLDER]: "revert", [ACCOUNT]: tok(5) });
    try {
      const r = await readHolderStatusResult(other.url, HOLDER, ACCOUNT);
      assert.equal(r.ok, false);
      assert.deepEqual(r.parts, { holder: null, account: tok(5) });
    } finally {
      await other.close();
    }
  });

  it("THE SAME ADDRESS IS READ ONCE and counted once", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await chainStub({ [HOLDER]: tok(70_000) });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, HOLDER.toUpperCase().replace("0X", "0x") as `0x${string}`);
      assert.equal(r.ok, true);
      assert.equal(r.status.rawBalance, tok(70_000), "not 140,000");
      assert.deepEqual(r.parts, { holder: tok(70_000), account: undefined });
      assert.equal(chain.calls.length, 1);
    } finally {
      await chain.close();
    }
  });

  it("an account alone (no wallet linked) is read and counted", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await chainStub({ [ACCOUNT]: tok(1_000_000) });
    try {
      const r = await readHolderStatusResult(chain.url, undefined, ACCOUNT);
      assert.equal(r.ok, true);
      assert.equal(r.status.tier.id, "lord");
      assert.deepEqual(r.parts, { holder: undefined, account: tok(1_000_000) });
    } finally {
      await chain.close();
    }
  });

  it("NO ADDRESS AT ALL IS STILL THE KNOWABLE FLOOR, with nothing read", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const none = await readHolderStatusResult(undefined, undefined);
    assert.equal(none.ok, true);
    assert.equal(none.status.tier.id, "outsider");
    assert.deepEqual(none.parts, { holder: undefined, account: undefined });
  });

  it("an unreachable chain fails both halves, as null — never 0", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const r = await readHolderStatusResult("http://127.0.0.1:9/none", HOLDER, ACCOUNT);
    assert.equal(r.ok, false);
    assert.deepEqual(r.parts, { holder: null, account: null });
  });

});

/**
 * THE ENERGY BUY'S READ IS PINNED — both halves at one block, and never before
 * the block the last energy purchase landed in. A load-balanced node still
 * behind that block must answer with an ERROR (unread → the buy refuses), not
 * a stale balance the buy would top up a second time.
 */
async function pinnedStub(head: bigint, balances: Record<string, bigint>, knownUpTo: bigint = head) {
  const tags: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = (m: { id: number; method: string; params?: [{ data?: string }, string?] }) => {
      if (m.method === "eth_blockNumber") return { jsonrpc: "2.0", id: m.id, result: `0x${head.toString(16)}` };
      if (m.method !== "eth_call") return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } };
      const tag = String(m.params?.[1] ?? "latest");
      tags.push(tag);
      if (tag.startsWith("0x") && BigInt(tag) > knownUpTo) {
        return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "header not found" } };
      }
      const who = `0x${String(m.params?.[0]?.data ?? "").slice(34, 74)}`.toLowerCase();
      const b = balances[who];
      return b === undefined
        ? { jsonrpc: "2.0", id: m.id, error: { code: 3, message: "execution reverted" } }
        : { jsonrpc: "2.0", id: m.id, result: `0x${b.toString(16).padStart(64, "0")}` };
    };
    const parsed = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, tags, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("the pinned read (the energy buy's)", () => {
  it("reads BOTH halves at the head when the head is past the last landing", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await pinnedStub(1_000n, { [HOLDER]: tok(10), [ACCOUNT]: tok(20) });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, ACCOUNT, { atLeastBlock: 900n });
      assert.equal(r.ok, true);
      assert.deepEqual(r.parts, { holder: tok(10), account: tok(20) });
      assert.deepEqual(chain.tags, ["0x3e8", "0x3e8"], "one block for both halves: the head");
    } finally {
      await chain.close();
    }
  });

  it("never reads BEFORE the landing block — a node behind it is an error, so the buy refuses", async () => {
    const { readHolderStatusResult } = await import("./circle");
    // This node's head (1,000) is behind the block the last purchase landed in (1,005).
    const chain = await pinnedStub(1_000n, { [HOLDER]: tok(10), [ACCOUNT]: tok(20) });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, ACCOUNT, { atLeastBlock: 1_005n });
      assert.equal(r.ok, false);
      assert.deepEqual(r.parts, { holder: null, account: null }, "unread — never the stale balance");
      assert.ok(chain.tags.every((t) => t === "0x3ed"), "asked at the landing block, not at the lagging head");
    } finally {
      await chain.close();
    }
  });

  it("without a pin, nothing changes: the tick reads at latest", async () => {
    const { readHolderStatusResult } = await import("./circle");
    const chain = await pinnedStub(1_000n, { [HOLDER]: tok(10), [ACCOUNT]: tok(20) });
    try {
      const r = await readHolderStatusResult(chain.url, HOLDER, ACCOUNT);
      assert.equal(r.ok, true);
      assert.ok(chain.tags.every((t) => t === "latest"));
    } finally {
      await chain.close();
    }
  });
});
