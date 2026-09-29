import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { LIGHTER_ROUTE_V1, perpCoi, validatePerpPubKey } from "../../../packages/core/src/index";
import {
  AUTH_TOKEN_MAX_SEC,
  LIGHTER_SIGNER_ARTIFACT,
  LIGHTER_TX,
  LIGHTER_VENDOR_DIR,
  ORDER_EXPIRY_MAX_MS,
  ORDER_EXPIRY_MIN_MS,
  SIGNER_KNOWN_ANSWERS,
  SignerArgumentError,
  SignerOutputMismatch,
  SignerRejected,
  SIGNER_RETRY_AFTER_MS,
  SignerUnavailable,
  instantiateSigner,
  loadSigner,
  signerLoader,
  runSignerKnownAnswerTest,
  type LighterSignerClient,
  type RawName,
  type SignContext,
} from "./signer";

/**
 * The signer is ~50 ms and ~70 MB to instantiate, so this file builds ONE and
 * drives it through a test seam: `tamper` rewrites a raw result when set, and
 * `calls` records what actually crossed into the WASM. The network spy is in
 * place before the first byte of Go runs.
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures");

let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("signer.test: the network is forbidden");
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

let clock = Date.UTC(2026, 8, 29, 12, 0, 0);
const now = () => clock;

type Raw = Record<string, unknown>;
let tamper: ((name: RawName, out: Raw) => Raw) | null = null;
const calls: Array<{ name: RawName; args: readonly unknown[] }> = [];

const signerP = instantiateSigner({
  now,
  interceptRaw: (name, args, call) => {
    calls.push({ name, args });
    const out = call() as Raw;
    return tamper ? tamper(name, { ...out }) : out;
  },
});

const ACCOUNT = 22149;
const KEY = LIGHTER_ROUTE_V1.apiKeyIndex;
let nonce = 1_790_700_000_000;

async function client(): Promise<LighterSignerClient> {
  const s = await signerP;
  const existing = s.client(ACCOUNT);
  if (existing) return existing;
  const k = s.generateApiKey();
  return s.createClient({ accountIndex: ACCOUNT, apiKeyIndex: KEY, privateKey: k.privateKey, apiPublicKey: k.publicKey });
}

function ctx(over: Partial<SignContext> = {}): SignContext {
  nonce += 10;
  return { accountIndex: ACCOUNT, nonce, nonceHighWater: nonce - 1, ...over };
}

const DAY = 86_400_000;
const expiry = () => clock + 28 * DAY;

function throwsArg(fn: () => unknown, field?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SignerArgumentError, `expected SignerArgumentError, got ${String(e)}`);
    if (field !== undefined) assert.equal(e.field, field);
    return true;
  });
}

function throwsMismatch(fn: () => unknown, field?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SignerOutputMismatch, `expected SignerOutputMismatch, got ${String(e)}`);
    if (field !== undefined) assert.equal(e.field, field);
    return true;
  });
}

// ── the artifact ────────────────────────────────────────────────────────────

test("the vendored files are the pinned bytes", () => {
  const sha = (f: string) => createHash("sha256").update(readFileSync(path.join(LIGHTER_VENDOR_DIR, f))).digest("hex");
  assert.equal(sha(LIGHTER_SIGNER_ARTIFACT.wasmFile), "781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b");
  assert.equal(sha(LIGHTER_SIGNER_ARTIFACT.execFile), "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14");
  assert.equal(LIGHTER_SIGNER_ARTIFACT.wasmSha256, "781ba28b5e7fca1ea816f516f28fe2adbe704b734828e0c941025f8133bd7b4b");
  assert.equal(LIGHTER_SIGNER_ARTIFACT.execSha256, "0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14");
  assert.equal(readFileSync(path.join(LIGHTER_VENDOR_DIR, LIGHTER_SIGNER_ARTIFACT.wasmFile)).length, LIGHTER_SIGNER_ARTIFACT.wasmBytes);
});

test("a tampered or missing artifact refuses to load, before any Go runs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-signer-"));
  try {
    // wasm_exec.js one byte off.
    const exec = readFileSync(path.join(LIGHTER_VENDOR_DIR, "wasm_exec.js"));
    writeFileSync(path.join(dir, "wasm_exec.js"), Buffer.concat([exec, Buffer.from(" ")]));
    writeFileSync(path.join(dir, "lighter-signer.wasm"), "not the signer");
    await assert.rejects(instantiateSigner({ vendorDir: dir }), (e: unknown) => e instanceof SignerUnavailable && e.reason === "hash-mismatch");
    // The right wasm_exec.js, the wrong wasm.
    copyFileSync(path.join(LIGHTER_VENDOR_DIR, "wasm_exec.js"), path.join(dir, "wasm_exec.js"));
    await assert.rejects(instantiateSigner({ vendorDir: dir }), (e: unknown) => e instanceof SignerUnavailable && e.reason === "hash-mismatch" && /lighter-signer\.wasm/.test(e.message));
    rmSync(path.join(dir, "lighter-signer.wasm"));
    await assert.rejects(instantiateSigner({ vendorDir: dir }), (e: unknown) => e instanceof SignerUnavailable && e.reason === "artifact-missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the known-answer test ───────────────────────────────────────────────────

test("the known-answer vectors are the live mainnet txs in the fixtures", () => {
  for (const v of SIGNER_KNOWN_ANSWERS) {
    const tx = JSON.parse(readFileSync(path.join(FIXTURES, `tx.${v.txHash.slice(0, 8)}.json`), "utf8")) as { hash: string; type: number; info: string };
    assert.equal(tx.hash, v.txHash);
    assert.equal(tx.type, LIGHTER_TX.createOrder);
    const i = JSON.parse(tx.info) as Record<string, unknown>;
    assert.equal(i.AccountIndex, v.accountIndex);
    assert.equal(i.ApiKeyIndex, v.apiKeyIndex);
    assert.equal(i.MarketIndex, v.marketIndex);
    assert.equal(i.ClientOrderIndex, v.clientOrderIndex);
    assert.equal(i.BaseAmount, v.baseAmount);
    assert.equal(i.Price, v.price);
    assert.equal(i.IsAsk, v.isAsk);
    assert.equal(i.Type, v.type);
    assert.equal(i.TimeInForce, v.timeInForce);
    assert.equal(i.ReduceOnly, v.reduceOnly);
    assert.equal(i.TriggerPrice, v.triggerPrice);
    assert.equal(i.OrderExpiry, v.orderExpiry);
    assert.equal(i.Nonce, v.nonce);
    assert.equal(i.ExpiredAt, v.expiredAt);
    assert.deepEqual(i.L2TxAttributes, v.skipNonce === 1 ? { "4": 1 } : null);
  }
});

test("the signer passes its known-answer test (live tx hashes under chain id 466324)", async () => {
  const s = await signerP;
  assert.deepEqual(runSignerKnownAnswerTest(s), { ok: true });
  assert.equal(s.alive, true);
});

test("a signer that fails the known-answer test refuses to arm", async () => {
  await assert.rejects(
    instantiateSigner({
      interceptRaw: (name, _args, call) => {
        const out = call() as Raw;
        return name === "SignCreateOrder" ? { ...out, txHash: "0".repeat(80) } : out;
      },
    }),
    (e: unknown) => e instanceof SignerUnavailable && e.reason === "kat-failed",
  );
});

test("the signer reaches nothing: no globals in this realm, no fetch, chain id 466324 on every client", async () => {
  const s = await signerP;
  await client();
  const g = globalThis as Record<string, unknown>;
  for (const name of ["GenerateAPIKey", "CreateClient", "CheckClient", "SignCreateOrder", "SignTransfer", "SignCreateSubAccount", "SignChangePubKey", "SignApproveIntegrator", "SignUpdateAccountConfig", "Go"]) {
    assert.equal(g[name], undefined, `${name} leaked into the worker's realm`);
  }
  // The typed surface is all there is: nothing signs Transfer (12), sub-accounts
  // (9), account configs (41/42), integrators (45), ChangePubKey or ModifyOrder.
  assert.equal("signTransfer" in s, false);
  assert.deepEqual(Object.keys(await client()).sort(), [
    "accountIndex",
    "apiKeyIndex",
    "apiPublicKey",
    "createAuthToken",
    "signCancelAllOrders",
    "signCancelAllOrdersAccountWide",
    "signCancelOrder",
    "signCreateGroupedOrders",
    "signCreateOrder",
    "signUpdateLeverage",
    "signWithdraw",
  ]);
  assert.ok(Object.isFrozen(await client()));
  // Only the nine wrapped functions were ever called.
  const used = new Set(calls.map((c) => c.name));
  for (const name of used) {
    assert.ok(
      ["GenerateAPIKey", "CreateClient", "CreateAuthToken", "SignCreateOrder", "SignCreateGroupedOrders", "SignCancelOrder", "SignCancelAllOrders", "SignUpdateLeverage", "SignWithdraw"].includes(name),
      name,
    );
  }
  const creates = calls.filter((c) => c.name === "CreateClient");
  assert.ok(creates.length >= 3);
  for (const c of creates) {
    assert.equal(c.args[2], 466324);
    assert.match(String(c.args[0]), /\.invalid$/);
  }
});

// ── keys and clients ────────────────────────────────────────────────────────

test("generateApiKey returns a canonical pair, fresh every time", async () => {
  const s = await signerP;
  const a = s.generateApiKey();
  const b = s.generateApiKey();
  assert.match(a.privateKey, /^0x[0-9a-f]{80}$/);
  assert.equal(validatePerpPubKey(a.publicKey), a.publicKey);
  assert.notEqual(a.privateKey, b.privateKey);
  assert.notEqual(a.publicKey, b.publicKey);
});

test("createClient: only the route's key index, a master account, a well-formed key — and the key is never echoed", async () => {
  const s = await signerP;
  const k = s.generateApiKey();
  const base = { accountIndex: 777, apiKeyIndex: KEY, privateKey: k.privateKey, apiPublicKey: k.publicKey };
  for (const apiKeyIndex of [255, 254, 0, 6, 16.5, -1, "16" as unknown as number]) {
    throwsArg(() => s.createClient({ ...base, apiKeyIndex }), "apiKeyIndex");
  }
  for (const accountIndex of [0, -1, 1.5, 2 ** 47, Number.NaN]) {
    throwsArg(() => s.createClient({ ...base, accountIndex }), "accountIndex");
  }
  const secret = `0x${"ab".repeat(39)}zz`;
  assert.throws(
    () => s.createClient({ ...base, privateKey: secret }),
    (e: unknown) => e instanceof SignerArgumentError && !e.message.includes("abab") && !e.message.includes(secret),
  );
  throwsArg(() => s.createClient({ ...base, privateKey: `0x${"0".repeat(80)}` }), "privateKey");
  throwsArg(() => s.createClient({ ...base, apiPublicKey: `0x${"ff".repeat(40)}` }), "apiPublicKey");
  const c = s.createClient(base);
  assert.equal(c.apiKeyIndex, KEY);
  assert.equal(s.client(777), c);
  // Re-creating replaces the handle; the old one refuses.
  const c2 = s.createClient(base);
  assert.throws(() => c.signCancelAllOrders({ marketId: 1 }, { accountIndex: 777, nonce: 5, nonceHighWater: 4 }), (e: unknown) => e instanceof SignerUnavailable && e.reason === "stale-client");
  assert.equal(c2.signCancelAllOrders({ marketId: 1 }, { accountIndex: 777, nonce: 5, nonceHighWater: 4 }).nonce, 5);
});

// ── guards ──────────────────────────────────────────────────────────────────

test("every nonce is ours: explicit, above the high-water, never −1, below 2^47−1", async () => {
  const c = await client();
  const close = { kind: "close" as const, marketId: 1, isAsk: true, baseAmount: 500, worstPrice: 800_000 };
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: -1, nonceHighWater: 0 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 0, nonceHighWater: 0 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 100, nonceHighWater: 100 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 99, nonceHighWater: 100 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 1.5, nonceHighWater: 0 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 2 ** 47 - 1, nonceHighWater: 0 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: "5" as unknown as number, nonceHighWater: 0 })), "ctx.nonce");
  throwsArg(() => c.signCreateOrder(close, ctx({ nonceHighWater: -1 })), "ctx.nonceHighWater");
  // Past the client-order-index ceiling: nonce × 8 + leg must stay under 2^48.
  throwsArg(() => c.signCreateOrder(close, ctx({ nonce: 2 ** 45, nonceHighWater: 0 })), "ctx.nonce");
  // A context for another account is a mixed-up handle.
  throwsArg(() => c.signCreateOrder(close, ctx({ accountIndex: ACCOUNT + 1 })), "ctx.accountIndex");
  // Bigints convert exactly.
  const n = BigInt(nonce + 1000);
  const tx = c.signCreateOrder(close, { accountIndex: BigInt(ACCOUNT), nonce: n, nonceHighWater: n - 1n });
  assert.equal(tx.nonce, Number(n));
  // Nothing refused above ever reached the WASM with a -1 nonce.
  for (const call of calls) if (call.name.startsWith("Sign")) assert.notEqual(call.args.at(-3), -1);
});

test("market, price and size guards: no floats, no wraparound, no negatives, only listed markets", async () => {
  const c = await client();
  const close = { kind: "close" as const, marketId: 1, isAsk: true, baseAmount: 500, worstPrice: 800_000 };
  for (const marketId of [1.5, -1, 65537, -65535, 57, 2048, 255, "1" as unknown as number, true as unknown as number]) {
    throwsArg(() => c.signCreateOrder({ ...close, marketId }, ctx()), "marketId");
  }
  for (const worstPrice of [0, -1, 2 ** 32, 835224.9, Number.POSITIVE_INFINITY]) {
    throwsArg(() => c.signCreateOrder({ ...close, worstPrice }, ctx()), "worstPrice");
  }
  for (const baseAmount of [0, -5, 2 ** 48, 1.5, 2n ** 60n]) {
    throwsArg(() => c.signCreateOrder({ ...close, baseAmount }, ctx()), "baseAmount");
  }
  throwsArg(() => c.signCreateOrder({ ...close, isAsk: 1 as unknown as boolean }, ctx()), "isAsk");
  throwsArg(() => c.signCreateOrder({ ...close, kind: "open" } as never, ctx()), "kind");
  // The largest legal values pass.
  const ok = c.signCreateOrder({ ...close, marketId: 56, baseAmount: 2n ** 48n - 1n, worstPrice: 2n ** 32n - 1n }, ctx());
  const info = JSON.parse(ok.txInfo) as Raw;
  assert.equal(info.MarketIndex, 56);
  assert.equal(info.BaseAmount, 2 ** 48 - 1);
  assert.equal(info.Price, 2 ** 32 - 1);
});

test("a single order is always reduce-only: a close, or a stop/take-profit (position-tied at base 0)", async () => {
  const c = await client();
  const cx = ctx();
  const close = c.signCreateOrder({ kind: "close", marketId: 1, isAsk: true, baseAmount: 500n, worstPrice: 800_000n }, cx);
  const ci = JSON.parse(close.txInfo) as Raw;
  assert.equal(close.txType, LIGHTER_TX.createOrder);
  assert.deepEqual(
    { Type: ci.Type, TimeInForce: ci.TimeInForce, ReduceOnly: ci.ReduceOnly, TriggerPrice: ci.TriggerPrice, OrderExpiry: ci.OrderExpiry, IsAsk: ci.IsAsk },
    { Type: 1, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 0, OrderExpiry: 0, IsAsk: 1 },
  );
  assert.equal(ci.ClientOrderIndex, Number(perpCoi(BigInt(cx.nonce), 3)));
  assert.deepEqual(close.clientOrderIndexes, [{ role: "close", leg: 3, clientOrderIndex: ci.ClientOrderIndex }]);
  assert.deepEqual(ci.L2TxAttributes, { "4": 1 });
  assert.equal(close.expiredAt, clock + 599_000);

  const sl = c.signCreateOrder({ kind: "stop-loss", marketId: 1, isAsk: true, triggerPrice: 800_000, price: 784_000, orderExpiry: expiry() }, ctx());
  const si = JSON.parse(sl.txInfo) as Raw;
  assert.deepEqual({ Type: si.Type, BaseAmount: si.BaseAmount, ReduceOnly: si.ReduceOnly, TriggerPrice: si.TriggerPrice, OrderExpiry: si.OrderExpiry }, { Type: 2, BaseAmount: 0, ReduceOnly: 1, TriggerPrice: 800_000, OrderExpiry: expiry() });
  const tp = c.signCreateOrder({ kind: "take-profit", marketId: 1, isAsk: false, triggerPrice: 700_000, price: 714_000, orderExpiry: expiry() }, ctx());
  assert.equal((JSON.parse(tp.txInfo) as Raw).Type, 4);
});

test("trigger orders: execution price on the right side of the trigger, inside the venue's 5% band, expiry 15 min..30 d", async () => {
  const c = await client();
  const sl = { kind: "stop-loss" as const, marketId: 1, isAsk: true, triggerPrice: 800_000, price: 784_000, orderExpiry: expiry() };
  throwsArg(() => c.signCreateOrder({ ...sl, price: 800_001 }, ctx()), "price"); // a sell above its trigger
  throwsArg(() => c.signCreateOrder({ ...sl, price: 759_999 }, ctx()), "price"); // more than 5% under
  throwsArg(() => c.signCreateOrder({ ...sl, isAsk: false, price: 784_000 }, ctx()), "price"); // a buy below its trigger
  throwsArg(() => c.signCreateOrder({ ...sl, isAsk: false, price: 840_001 }, ctx()), "price"); // a buy more than 5% over
  c.signCreateOrder({ ...sl, price: 760_000 }, ctx()); // exactly 5% passes
  throwsArg(() => c.signCreateOrder({ ...sl, triggerPrice: 0 }, ctx()), "triggerPrice");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: 0 }, ctx()), "orderExpiry");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: -1 }, ctx()), "orderExpiry"); // the WASM's "28 days from its clock"
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: clock + 5 * 60_000 }, ctx()), "orderExpiry");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: clock + ORDER_EXPIRY_MIN_MS - 1 }, ctx()), "orderExpiry");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: clock + 30 * DAY }, ctx()), "orderExpiry");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: clock + 60 * DAY }, ctx()), "orderExpiry");
  throwsArg(() => c.signCreateOrder({ ...sl, orderExpiry: expiry() + 0.5 }, ctx()), "orderExpiry");
  c.signCreateOrder({ ...sl, orderExpiry: clock + ORDER_EXPIRY_MIN_MS }, ctx());
  c.signCreateOrder({ ...sl, orderExpiry: clock + ORDER_EXPIRY_MAX_MS }, ctx());
  throwsArg(() => c.signCreateOrder({ ...sl, baseAmount: -1 }, ctx()), "baseAmount");
});

// ── grouped opens ───────────────────────────────────────────────────────────

test("an open is OTO [IOC entry, SL] — children base 0, reduce-only, opposite side, COIs nonce×8+leg", async () => {
  const c = await client();
  const cx = ctx();
  const tx = c.signCreateGroupedOrders(
    { marketId: 1, side: "long", baseAmount: 500n, worstPrice: 840_000n, stopLoss: { triggerPrice: 800_000, price: 784_000, orderExpiry: expiry() } },
    cx,
  );
  assert.equal(tx.txType, LIGHTER_TX.createGroupedOrders);
  const info = JSON.parse(tx.txInfo) as { GroupingType: number; Orders: Raw[]; Nonce: number; ExpiredAt: number; L2TxAttributes: unknown };
  assert.equal(info.GroupingType, 1);
  assert.equal(info.Nonce, cx.nonce);
  assert.equal(info.ExpiredAt, tx.expiredAt);
  assert.deepEqual(info.L2TxAttributes, { "4": 1 });
  assert.equal(info.Orders.length, 2);
  const [entry, sl] = info.Orders as [Raw, Raw];
  assert.deepEqual(entry, {
    MarketIndex: 1,
    ClientOrderIndex: Number(perpCoi(BigInt(cx.nonce), 0)),
    BaseAmount: 500,
    Price: 840_000,
    IsAsk: 0,
    Type: 1,
    TimeInForce: 0,
    ReduceOnly: 0,
    TriggerPrice: 0,
    OrderExpiry: 0,
  });
  assert.deepEqual(sl, {
    MarketIndex: 1,
    ClientOrderIndex: Number(perpCoi(BigInt(cx.nonce), 1)),
    BaseAmount: 0,
    Price: 784_000,
    IsAsk: 1,
    Type: 2,
    TimeInForce: 0,
    ReduceOnly: 1,
    TriggerPrice: 800_000,
    OrderExpiry: expiry(),
  });
  assert.deepEqual(
    tx.clientOrderIndexes.map((x) => x.role),
    ["entry", "sl"],
  );
});

test("an open with a take-profit is OTOCO [entry, SL, TP]; a short mirrors every side", async () => {
  const c = await client();
  const cx = ctx();
  const tx = c.signCreateGroupedOrders(
    {
      marketId: 0,
      side: "short",
      baseAmount: 5_000,
      worstPrice: 250_000,
      stopLoss: { triggerPrice: 262_500, price: 267_750, orderExpiry: expiry() },
      takeProfit: { triggerPrice: 225_000, price: 229_500, orderExpiry: expiry() },
    },
    cx,
  );
  const info = JSON.parse(tx.txInfo) as { GroupingType: number; Orders: Raw[] };
  assert.equal(info.GroupingType, 3);
  assert.deepEqual(
    info.Orders.map((o) => [o.Type, o.IsAsk, o.ReduceOnly, o.BaseAmount, o.ClientOrderIndex]),
    [
      [1, 1, 0, 5_000, Number(perpCoi(BigInt(cx.nonce), 0))],
      [2, 0, 1, 0, Number(perpCoi(BigInt(cx.nonce), 1))],
      [4, 0, 1, 0, Number(perpCoi(BigInt(cx.nonce), 2))],
    ],
  );
  assert.deepEqual(
    tx.clientOrderIndexes.map((x) => [x.role, x.leg]),
    [
      ["entry", 0],
      ["sl", 1],
      ["tp", 2],
    ],
  );
});

test("grouped guards: a stop is required, on the losing side; a take on the winning side, expiring with the stop", async () => {
  const c = await client();
  const open = { marketId: 1, side: "long" as const, baseAmount: 500, worstPrice: 840_000, stopLoss: { triggerPrice: 800_000, price: 784_000, orderExpiry: expiry() } };
  throwsArg(() => c.signCreateGroupedOrders({ ...open, stopLoss: undefined as never }, ctx()), "stopLoss");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, stopLoss: { ...open.stopLoss, triggerPrice: 840_000, price: 823_200 } }, ctx()), "stopLoss.triggerPrice");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, side: "flat" as never }, ctx()), "side");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, takeProfit: { triggerPrice: 830_000, price: 813_400, orderExpiry: expiry() } }, ctx()), "takeProfit.triggerPrice");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, takeProfit: { triggerPrice: 900_000, price: 882_000, orderExpiry: expiry() - 1 } }, ctx()), "takeProfit.orderExpiry");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, baseAmount: 0 }, ctx()), "baseAmount");
  throwsArg(() => c.signCreateGroupedOrders({ ...open, stopLoss: { ...open.stopLoss, price: 900_000 } }, ctx()), "stopLoss.price");
});

// ── the other tx types ──────────────────────────────────────────────────────

test("cancel-all is immediate and market-scoped; account-wide needs its literal acknowledgement", async () => {
  const c = await client();
  const scoped = c.signCancelAllOrders({ marketId: 0 }, ctx());
  const si = JSON.parse(scoped.txInfo) as Raw;
  assert.equal(scoped.txType, LIGHTER_TX.cancelAllOrders);
  assert.deepEqual({ TimeInForce: si.TimeInForce, Time: si.Time, L2TxAttributes: si.L2TxAttributes }, { TimeInForce: 0, Time: 0, L2TxAttributes: { "4": 1, "5": 0 } });
  throwsArg(() => c.signCancelAllOrders({ marketId: 255 }, ctx()), "marketId");
  throwsArg(() => c.signCancelAllOrdersAccountWide({ acknowledge: "yes" as never }, ctx()), "acknowledge");
  const wide = c.signCancelAllOrdersAccountWide({ acknowledge: "removes-every-resting-stop" }, ctx());
  assert.deepEqual((JSON.parse(wide.txInfo) as Raw).L2TxAttributes, { "4": 1 });
  assert.equal(wide.marketId, null);
});

test("cancel one order by venue index or client index", async () => {
  const c = await client();
  const tx = c.signCancelOrder({ marketId: 1, orderIndex: 7_599_824_390_440_187n }, ctx());
  assert.equal((JSON.parse(tx.txInfo) as Raw).Index, 7_599_824_390_440_187);
  throwsArg(() => c.signCancelOrder({ marketId: 1, orderIndex: 0 }, ctx()), "orderIndex");
  throwsArg(() => c.signCancelOrder({ marketId: 1, orderIndex: 2n ** 60n }, ctx()), "orderIndex");
});

test("UpdateLeverage is always isolated, never above 10x, never below the market's minimum IMF", async () => {
  const c = await client();
  const tx = c.signUpdateLeverage({ marketId: 1, imfBp: 5000, minImfBp: 200 }, ctx());
  const info = JSON.parse(tx.txInfo) as Raw;
  assert.equal(tx.txType, LIGHTER_TX.updateLeverage);
  assert.deepEqual({ MarketIndex: info.MarketIndex, InitialMarginFraction: info.InitialMarginFraction, MarginMode: info.MarginMode }, { MarketIndex: 1, InitialMarginFraction: 5000, MarginMode: 1 });
  throwsArg(() => c.signUpdateLeverage({ marketId: 1, imfBp: 999, minImfBp: 200 }, ctx()), "imfBp"); // > 10x
  throwsArg(() => c.signUpdateLeverage({ marketId: 44, imfBp: 2000, minImfBp: 3333 }, ctx()), "imfBp"); // below the market's minimum
  throwsArg(() => c.signUpdateLeverage({ marketId: 1, imfBp: 10_001, minImfBp: 200 }, ctx()), "imfBp");
  throwsArg(() => c.signUpdateLeverage({ marketId: 1, imfBp: 65_536 + 2000, minImfBp: 200 }, ctx()), "imfBp");
  throwsArg(() => c.signUpdateLeverage({ marketId: 1, imfBp: 5000.5, minImfBp: 200 }, ctx()), "imfBp");
  c.signUpdateLeverage({ marketId: 1, imfBp: 1000, minImfBp: 200 }, ctx());
  // Nothing in any UpdateLeverage call ever asked for cross margin.
  for (const call of calls) if (call.name === "SignUpdateLeverage") assert.equal(call.args[2], 1);
});

test("Withdraw: USDG on the perps route, never more than the last read free collateral", async () => {
  const c = await client();
  const tx = c.signWithdraw({ amountMicro: 25_000_000n, freeCollateralMicro: 30_000_000n }, ctx());
  const info = JSON.parse(tx.txInfo) as Raw;
  assert.equal(tx.txType, LIGHTER_TX.withdraw);
  assert.deepEqual(
    { FromAccountIndex: info.FromAccountIndex, AssetIndex: info.AssetIndex, RouteType: info.RouteType, Amount: info.Amount },
    { FromAccountIndex: ACCOUNT, AssetIndex: 3, RouteType: 0, Amount: 25_000_000 },
  );
  throwsArg(() => c.signWithdraw({ amountMicro: 30_000_001n, freeCollateralMicro: 30_000_000n }, ctx()), "amountMicro");
  throwsArg(() => c.signWithdraw({ amountMicro: 0n, freeCollateralMicro: 30_000_000n }, ctx()), "amountMicro");
  throwsArg(() => c.signWithdraw({ amountMicro: 1n, freeCollateralMicro: 0n }, ctx()), "freeCollateralMicro");
  throwsArg(() => c.signWithdraw({ amountMicro: 1n, freeCollateralMicro: 5 as unknown as bigint }, ctx()), "freeCollateralMicro");
});

test("auth tokens: a deadline we chose, at most 8 h out, naming this client", async () => {
  const c = await client();
  const nowSec = Math.floor(clock / 1000);
  const token = c.createAuthToken(nowSec + 6 * 3600);
  const [d, a, k, sig] = token.split(":");
  assert.equal(d, String(nowSec + 6 * 3600));
  assert.equal(a, String(ACCOUNT));
  assert.equal(k, String(KEY));
  assert.match(sig ?? "", /^[0-9a-f]{160}$/);
  throwsArg(() => c.createAuthToken(0), "deadlineSec"); // the WASM would pick now + 7 h itself
  throwsArg(() => c.createAuthToken(nowSec), "deadlineSec");
  throwsArg(() => c.createAuthToken(nowSec + AUTH_TOKEN_MAX_SEC + 1), "deadlineSec");
  throwsArg(() => c.createAuthToken(nowSec + 60.5), "deadlineSec");
});

// ── the post-sign bind ──────────────────────────────────────────────────────

test("any difference between the signed tx_info and the request is refused", async () => {
  const c = await client();
  const close = { kind: "close" as const, marketId: 1, isAsk: true, baseAmount: 500, worstPrice: 800_000 };
  const edit = (f: (info: Raw) => void) => (name: RawName, out: Raw): Raw => {
    if (!name.startsWith("Sign")) return out;
    const info = JSON.parse(out.txInfo as string) as Raw;
    f(info);
    return { ...out, txInfo: JSON.stringify(info) };
  };
  const cases: Array<[string, (name: RawName, out: Raw) => Raw, string]> = [
    ["a wrapped price", edit((i) => (i.Price = 4_294_967_295)), "Price"],
    ["another market", edit((i) => (i.MarketIndex = 3)), "MarketIndex"],
    ["another key index", edit((i) => (i.ApiKeyIndex = 7)), "ApiKeyIndex"],
    ["another account", edit((i) => (i.AccountIndex = 1)), "AccountIndex"],
    ["another nonce", edit((i) => (i.Nonce = (i.Nonce as number) + 1)), "Nonce"],
    ["not reduce-only", edit((i) => (i.ReduceOnly = 0)), "ReduceOnly"],
    ["the other side", edit((i) => (i.IsAsk = 0)), "IsAsk"],
    ["a trigger on a close", edit((i) => (i.TriggerPrice = 1)), "TriggerPrice"],
    ["another client order index", edit((i) => (i.ClientOrderIndex = 1)), "ClientOrderIndex"],
    ["SkipNonce missing", edit((i) => (i.L2TxAttributes = null)), "L2TxAttributes"],
    ["a cancel-all market attribute on an order", edit((i) => (i.L2TxAttributes = { "4": 1, "5": 1 })), "L2TxAttributes"],
    ["an extra field", edit((i) => (i.Extra = 1)), "txInfo"],
    ["a missing field", edit((i) => delete i.OrderExpiry), "txInfo"],
    ["a string where a number belongs", edit((i) => (i.BaseAmount = "500")), "BaseAmount"],
    ["an ExpiredAt an hour out", edit((i) => (i.ExpiredAt = (i.ExpiredAt as number) + 3_600_000)), "ExpiredAt"],
    ["a truncated signature", edit((i) => (i.Sig = "AAAA")), "Sig"],
    ["a different tx type", (name, out) => (name.startsWith("Sign") ? { ...out, txType: 15 } : out), "txType"],
    ["an uppercase hash", (name, out) => (name.startsWith("Sign") ? { ...out, txHash: String(out.txHash).toUpperCase() } : out), "txHash"],
    ["tx_info that is not JSON", (name, out) => (name.startsWith("Sign") ? { ...out, txInfo: "{" } : out), "txInfo"],
  ];
  try {
    for (const [what, t, field] of cases) {
      tamper = t;
      throwsMismatch(() => c.signCreateOrder(close, ctx()), field);
      void what;
    }
    // Grouped legs are compared one by one.
    tamper = edit((i) => {
      const orders = i.Orders as Raw[];
      (orders[1] as Raw).BaseAmount = 500;
    });
    throwsMismatch(
      () => c.signCreateGroupedOrders({ marketId: 1, side: "long", baseAmount: 500, worstPrice: 840_000, stopLoss: { triggerPrice: 800_000, price: 784_000, orderExpiry: expiry() } }, ctx()),
      "Orders[1].BaseAmount",
    );
    tamper = edit((i) => (i.MarginMode = 0));
    throwsMismatch(() => c.signUpdateLeverage({ marketId: 1, imfBp: 5000, minImfBp: 200 }, ctx()), "MarginMode");
    tamper = edit((i) => (i.L2TxAttributes = { "4": 1 }));
    throwsMismatch(() => c.signCancelAllOrders({ marketId: 2 }, ctx()), "L2TxAttributes");
    tamper = edit((i) => (i.Amount = 999_000_000));
    throwsMismatch(() => c.signWithdraw({ amountMicro: 1_000_000n, freeCollateralMicro: 2_000_000n }, ctx()), "Amount");
    tamper = (name, out) => (name === "CreateAuthToken" ? { ...out, authToken: String(out.authToken).replace(`:${ACCOUNT}:`, ":1:") } : out);
    throwsMismatch(() => c.createAuthToken(Math.floor(clock / 1000) + 3600), "authToken");
  } finally {
    tamper = null;
  }
  // And the untampered signer still works afterwards.
  assert.equal(c.signCreateOrder(close, ctx()).txType, LIGHTER_TX.createOrder);
});

test("the WASM's own refusal is a SignerRejected, with anything key-shaped redacted", async () => {
  const c = await client();
  const leak = `0x${"cd".repeat(40)}`;
  tamper = (name, out) => (name === "SignCreateOrder" ? { error: `bad things near ${leak}` } : out);
  try {
    assert.throws(
      () => c.signCreateOrder({ kind: "close", marketId: 1, isAsk: true, baseAmount: 500, worstPrice: 800_000 }, ctx()),
      (e: unknown) => e instanceof SignerRejected && !e.message.includes("cdcd") && /redacted/.test(e.message),
    );
  } finally {
    tamper = null;
  }
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test("a Go runtime that dies condemns the signer and every client handle", async () => {
  let kill = false;
  const s = await instantiateSigner({
    interceptRaw: (_name, _args, call) => {
      if (kill) throw new Error("RuntimeError: unreachable");
      return call();
    },
  });
  const k = s.generateApiKey();
  const c = s.createClient({ accountIndex: 42, apiKeyIndex: KEY, privateKey: k.privateKey, apiPublicKey: k.publicKey });
  kill = true;
  const cx = { accountIndex: 42, nonce: 10, nonceHighWater: 9 };
  assert.throws(() => c.signCancelAllOrders({ marketId: 1 }, cx), (e: unknown) => e instanceof SignerUnavailable && e.reason === "exited");
  kill = false;
  assert.equal(s.alive, false);
  assert.throws(() => c.signCancelAllOrders({ marketId: 1 }, cx), (e: unknown) => e instanceof SignerUnavailable && e.reason === "exited");
  assert.throws(() => s.generateApiKey(), SignerUnavailable);
  assert.equal(s.client(42), null);
});

test("loadSigner shares one instance per process", async () => {
  const a = await loadSigner();
  const b = await loadSigner();
  assert.equal(a, b);
  assert.equal(a.alive, true);
});

test("a transient load failure is retried after a short backoff, never cached for the life of the process", async () => {
  // An in-place upgrade (or EMFILE/EIO) makes the first lazy load fail. Every
  // exit signs through this loader, so that failure must not outlive the
  // backoff: once the files read again, the next call gets a working signer.
  const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-signer-retry-"));
  try {
    copyFileSync(path.join(LIGHTER_VENDOR_DIR, "wasm_exec.js"), path.join(dir, "wasm_exec.js"));
    let t = 1_000_000;
    const load = signerLoader({ vendorDir: dir, loaderNow: () => t });
    const missing = (e: unknown) => e instanceof SignerUnavailable && e.reason === "artifact-missing";
    await assert.rejects(load(), missing);
    copyFileSync(path.join(LIGHTER_VENDOR_DIR, LIGHTER_SIGNER_ARTIFACT.wasmFile), path.join(dir, LIGHTER_SIGNER_ARTIFACT.wasmFile));
    // Inside the backoff the cached failure is served (no 14 MB re-read per tick)…
    t += SIGNER_RETRY_AFTER_MS - 1;
    await assert.rejects(load(), missing);
    // …and after it the next call builds afresh and succeeds, then is shared.
    t += 1;
    const a = await load();
    assert.equal(a.alive, true);
    assert.deepEqual(runSignerKnownAnswerTest(a), { ok: true });
    assert.equal(await load(), a);
    // Concurrent callers after a failure share ONE retry, not one each.
    const load2 = signerLoader({ vendorDir: path.join(dir, "absent"), loaderNow: () => t });
    await assert.rejects(load2(), missing);
    t += SIGNER_RETRY_AFTER_MS;
    const [x, y] = await Promise.allSettled([load2(), load2()]);
    assert.equal(x.status, "rejected");
    assert.equal(y.status, "rejected");
    assert.equal((x as PromiseRejectedResult).reason, (y as PromiseRejectedResult).reason);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed re-instantiation after the runtime died is retried too", async () => {
  // The dead-runtime branch builds a replacement; if THAT fails transiently it
  // must not become the new permanent answer either.
  const dir = mkdtempSync(path.join(os.tmpdir(), "merrymen-signer-redo-"));
  try {
    copyFileSync(path.join(LIGHTER_VENDOR_DIR, "wasm_exec.js"), path.join(dir, "wasm_exec.js"));
    copyFileSync(path.join(LIGHTER_VENDOR_DIR, LIGHTER_SIGNER_ARTIFACT.wasmFile), path.join(dir, LIGHTER_SIGNER_ARTIFACT.wasmFile));
    let t = 5_000_000;
    let kill = false;
    const load = signerLoader({
      vendorDir: dir,
      loaderNow: () => t,
      interceptRaw: (_name, _args, call) => {
        if (kill) throw new Error("RuntimeError: unreachable");
        return call();
      },
    });
    const first = await load();
    kill = true;
    assert.throws(() => first.generateApiKey(), SignerUnavailable);
    assert.equal(first.alive, false);
    // The replacement's KAT hits a trapping runtime: that proves nothing about
    // the bytes, so it is reported as `exited`, not the final `kat-failed`.
    await assert.rejects(load(), (e: unknown) => e instanceof SignerUnavailable && e.reason === "exited");
    kill = false;
    t += SIGNER_RETRY_AFTER_MS;
    const second = await load();
    assert.notEqual(second, first);
    assert.equal(second.alive, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a known-answer failure from a live runtime is final: the loader does not retry it", async () => {
  let t = 9_000_000;
  let builds = 0;
  const load = signerLoader({
    loaderNow: () => t,
    interceptRaw: (name, _args, call) => {
      if (name === "GenerateAPIKey") builds++;
      const out = call() as Raw;
      return name === "SignCreateOrder" ? { ...out, txHash: "0".repeat(80) } : out;
    },
  });
  const katFailed = (e: unknown) => e instanceof SignerUnavailable && e.reason === "kat-failed";
  await assert.rejects(load(), katFailed);
  t += 10 * SIGNER_RETRY_AFTER_MS;
  await assert.rejects(load(), katFailed);
  assert.equal(builds, 1);
});

test("timing: signing is milliseconds, not a tick", async () => {
  const c = await client();
  const t0 = performance.now();
  const n = 50;
  for (let i = 0; i < n; i++) c.signCreateOrder({ kind: "close", marketId: 1, isAsk: true, baseAmount: 500, worstPrice: 800_000 }, ctx());
  const per = (performance.now() - t0) / n;
  // Measured 1.4–3.4 ms per signature (Node 22 and 26); 50 ms is a regression, not noise.
  assert.ok(per < 50, `${per.toFixed(2)} ms per signature`);
});

test("no network was touched by any of it", () => {
  assert.equal(fetchCalls, 0);
});
