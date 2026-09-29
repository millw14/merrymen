/**
 * PROVABLY FLAT, OR NOT (docs/perps.md rule 5).
 *
 * Driven through a fake fetch answering real `Response`s built from the
 * captured venue fixtures, and a fake contract reader. What must hold:
 *   - a zero account index is flat without a single venue request;
 *   - every account under the address is read, and any holding is `false`;
 *   - anything unread is `null` — never `true` — and a definite finding
 *     outranks an unread one;
 *   - only public, unauthenticated GETs are sent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { clearLighterCooldown, resetLighterApiState, type LighterFetch } from "./api";
import { venueFlatness, type LighterChainRead, type LighterReadCall } from "./flatness";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const fixture = (f: string) => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Record<string, unknown>;
const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-flat-"));
after(() => rmSync(HOME, { recursive: true, force: true }));
beforeEach(() => {
  // The 429 case below trips the fleet cooldown (in process AND in the file);
  // every other case starts outside it.
  resetLighterApiState();
  clearLighterCooldown(HOME);
});

const SELF = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176";
const MASTER = 22149;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An empty account read in the venue's shape (every field parseAccount requires, all zero). */
function emptyAccount(index: number, l1 = SELF) {
  return {
    code: 200,
    total: 1,
    accounts: [
      {
        code: 0,
        account_type: 0,
        index,
        account_index: index,
        l1_address: l1,
        cancel_all_time: 0,
        total_order_count: 0,
        total_isolated_order_count: 0,
        pending_order_count: 0,
        available_balance: "0.000000",
        status: 1,
        collateral: "0.000000",
        transaction_time: 1_790_694_641_487_929,
        positions: [],
        assets: [{ symbol: "USDG", asset_id: 3, balance: "0.000000", locked_balance: "0.000000" }],
        total_asset_value: "0",
        cross_asset_value: "0",
        shares: [],
        pending_unlocks: [],
      },
    ],
  };
}

function list(accounts: Array<{ index: number; collateral: string }>, nextCursor?: string) {
  return {
    code: 200,
    l1_address: SELF,
    sub_accounts: accounts.map((a) => ({ code: 0, account_type: a.index === MASTER ? 0 : 1, index: a.index, l1_address: SELF, collateral: a.collateral })),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

interface Venue {
  list?: () => Response;
  account?: (index: number) => Response;
}

function venue(v: Venue) {
  const calls: Array<{ url: URL; init: Parameters<LighterFetch>[1] }> = [];
  const fetch: LighterFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.pathname === "/api/v1/orderBookDetails") return json(200, fixture("orderBookDetails.perp.json"));
    if (u.pathname === "/api/v1/accountsByL1Address") return (v.list ?? (() => json(200, list([{ index: MASTER, collateral: "0.000000" }]))))();
    if (u.pathname === "/api/v1/account") return (v.account ?? ((i) => json(200, emptyAccount(i))))(Number(u.searchParams.get("value")));
    return json(404, { code: 404, message: "unexpected path in test" });
  };
  return { fetch, calls };
}

function chain(answers: { index?: unknown; pending?: unknown; throws?: "index" | "pending" }) {
  const calls: LighterReadCall[] = [];
  const read: LighterChainRead = async (call) => {
    calls.push(call);
    if (call.functionName === "addressToAccountIndex") {
      if (answers.throws === "index") throw new Error("rpc down");
      return answers.index ?? BigInt(MASTER);
    }
    if (answers.throws === "pending") throw new Error("rpc down");
    return answers.pending ?? 0n;
  };
  return { read, calls };
}

const run = (c: ReturnType<typeof chain>, v: ReturnType<typeof venue>, chainId = 4663) =>
  venueFlatness({ smartAccount: SELF.toUpperCase().replace("0X", "0x"), chainId, read: c.read, home: HOME, fetch: v.fetch });

test("NO VENUE ACCOUNT EVER: flat, and Lighter is never asked", async () => {
  const c = chain({ index: 0n });
  const v = venue({});
  const r = await run(c, v);
  assert.equal(r.flat, true);
  assert.equal(v.calls.length, 0);
  assert.deepEqual(c.calls.map((x) => x.functionName), ["addressToAccountIndex"]);
  assert.equal(c.calls[0]!.args[0], SELF, "the address is read lowercased");
});

test("every account empty, nothing pending: flat — through public, unauthenticated GETs only", async () => {
  const v = venue({});
  const r = await run(chain({}), v);
  assert.deepEqual(r, { flat: true });
  assert.ok(v.calls.length >= 2);
  for (const call of v.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.headers.authorization, undefined, "the server holds no key and sends no token");
    assert.equal(call.init.redirect, "error");
  }
  assert.ok(v.calls.some((x) => x.url.pathname === "/api/v1/account" && x.url.searchParams.get("value") === String(MASTER)));
});

test("OPEN POSITIONS: not flat, and the owner is told what is there", async () => {
  const v = venue({ account: () => json(200, fixture("account.22149.isolated.json")) });
  const r = await run(chain({}), v);
  assert.equal(r.flat, false);
  assert.match(r.detail ?? "", /account 22149: .*open position/);
  assert.match(r.detail ?? "", /USDG collateral/);
});

test("A SUB-ACCOUNT holding collateral is not flat, even when the master is", async () => {
  const v = venue({ list: () => json(200, list([{ index: MASTER, collateral: "0.000000" }, { index: 30001, collateral: "12.500000" }])) });
  const r = await run(chain({}), v);
  assert.equal(r.flat, false);
  assert.match(r.detail ?? "", /account 30001: 12\.5 USDG collateral/);
});

test("MONEY WAITING ON THE CONTRACT is not flat", async () => {
  const r = await run(chain({ pending: 25_000_000n }), venue({}));
  assert.equal(r.flat, false);
  assert.match(r.detail ?? "", /25 USDG waiting to be claimed/);
});

test("UNREAD IS NEVER FLAT: the chain, the list, an account, a rate limit", async () => {
  assert.equal((await run(chain({ throws: "index" }), venue({}))).flat, null);
  assert.equal((await run(chain({ throws: "pending" }), venue({}))).flat, null);
  assert.equal((await run(chain({ index: "22149" }), venue({}))).flat, null, "an index that is not an integer is not an answer");
  assert.equal((await run(chain({ index: -1n }), venue({}))).flat, null);
  assert.equal((await run(chain({}), venue({ list: () => json(500, {}) }))).flat, null);
  assert.equal((await run(chain({}), venue({ list: () => json(200, { code: 200, sub_accounts: "nope" }) }))).flat, null);
  assert.equal((await run(chain({}), venue({ account: () => json(503, {}) }))).flat, null);
  assert.equal((await run(chain({}), venue({ account: () => new Response("{", { status: 200 }) }))).flat, null);
  resetLighterApiState();
  const limited = await run(chain({}), venue({ account: () => json(429, {}) }));
  assert.equal(limited.flat, null);
  assert.match(limited.detail, /rate-limited/);
});

test("a list that says there is more, or that leaves out the master the contract names, is not flat", async () => {
  assert.equal((await run(chain({}), venue({ list: () => json(200, list([{ index: MASTER, collateral: "0.000000" }], "cursor-2")) }))).flat, null);
  const missing = await run(chain({}), venue({ list: () => json(200, list([{ index: 30001, collateral: "0.000000" }])) }));
  assert.equal(missing.flat, null);
  assert.match(missing.detail, /does not include account 22149/);
});

test("an account read that answers for another address is not an answer", async () => {
  const r = await run(chain({}), venue({ account: (i) => json(200, emptyAccount(i, "0x00000000000000000000000000000000000000ff")) }));
  assert.equal(r.flat, null);
});

test("a definite finding outranks an unread one", async () => {
  const v = venue({
    list: () => json(200, list([{ index: MASTER, collateral: "0.000000" }, { index: 30001, collateral: "3.000000" }])),
    account: () => json(503, {}),
  });
  const r = await run(chain({}), v);
  assert.equal(r.flat, false);
  assert.match(r.detail ?? "", /account 30001/);
});

test("a reader on any chain but 4663 cannot say, and a malformed address is not flat", async () => {
  const c = chain({});
  assert.equal((await run(c, venue({}), 46630)).flat, null);
  assert.equal(c.calls.length, 0);
  assert.equal((await venueFlatness({ smartAccount: "0x1234", chainId: 4663, read: c.read, home: HOME })).flat, null);
});
