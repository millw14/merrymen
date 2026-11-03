import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { guardPerpsSigner, perpsMoney, samePerpsIdentity, submitPerpsAction } from "./perps-client";
import { terminalWallet } from "./perps-navigation";
import { fetchAccountForSession } from "./account-session";
import { screenForPath, pathForScreen } from "./nav";
import type { AccountState } from "./HostedControls";

const owner = `0x${"a".repeat(40)}`, smartAccount = `0x${"b".repeat(40)}`;
const account = { session: { hosted: true, address: owner }, status: { exists: true, tenant: owner, grant: { purpose: "perps", smartAccount, chainId: 4663, caps: { perTradeUsdg: 25, dailyUsdg: 100 } } } } satisfies AccountState;
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("Perps navigation is gated, explicit, and never defaults a malformed wallet to Spot", () => {
  assert.deepEqual(screenForPath("/perps", true, true), { kind: "perps" });
  assert.deepEqual(screenForPath("/perps", true, false), { kind: "tab", tab: "home" });
  assert.equal(pathForScreen({ kind: "perps" }), "/perps");
  for (const page of ["/grant", "/settings", "/withdraw", "/deposit"]) {
    assert.equal(terminalWallet(page, "wallet=perps"), "perps");
    for (const query of ["Wallet=perps", "wallet=spot&wallet=perps", "wallet=oops", "wallet="]) assert.equal(terminalWallet(page, query), "invalid");
  }
  assert.equal(terminalWallet("/create", "for=perps"), "perps");
  assert.equal(terminalWallet("/create", "for=spot&for=perps"), "invalid");
  assert.equal(terminalWallet("/create", "For=perps"), "invalid");
  assert.equal(terminalWallet("/solana", "wallet=perps"), "spot");
  assert.equal(terminalWallet("/profile", "wallet=perps"), "spot");
});

test("private response identity requires both the login and dedicated account", () => {
  assert.equal(samePerpsIdentity({ owner, account: { smartAccount, chainId: 4663 } }, account), true);
  assert.equal(samePerpsIdentity({ owner: smartAccount, account: { smartAccount, chainId: 4663 } }, account), false);
  assert.equal(samePerpsIdentity({ owner, account: { smartAccount: owner, chainId: 4663 } }, account), false);
  assert.equal(samePerpsIdentity({ owner, account: { smartAccount, chainId: 46630 } }, account), false);
  assert.equal(samePerpsIdentity({ owner, account: null }, account), false);
});

test("amounts preserve exact large micro balances and distinguish unknown from zero", () => {
  assert.equal(perpsMoney(null), "Not reported");
  assert.equal(perpsMoney("0"), "0.000000 USDG");
  assert.equal(perpsMoney("9007199254740993123456"), "9007199254740993.123456 USDG");
  assert.equal(perpsMoney("-1234567"), "−1.234567 USDG");
});

test("wallet-scoped account fetch keeps auth session at the shared login endpoint", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async input => {
    const url = String(input); urls.push(url);
    return json(url === "/api/grants?wallet=perps" ? account.status : account.session);
  }) as typeof fetch;
  assert.equal((await fetchAccountForSession(null, "perps")).kind, "ready");
  assert.deepEqual(urls, ["/api/auth/session", "/api/grants?wallet=perps", "/api/auth/session"]);
});

test("close and reset target the reviewed account and tenant; no write is auto-retried", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input, init) => { calls.push({ url: String(input), body: JSON.parse(String(init?.body)) }); return json({ id: "receipt", queued: true }); }) as typeof fetch;
  await submitPerpsAction(account, { kind: "close", market: "BTC-PERP" });
  await submitPerpsAction(account, { kind: "close-all", unread: true });
  await submitPerpsAction(account, { kind: "reset" });
  assert.equal(calls[0]!.url, "/api/orders?wallet=perps");
  assert.deepEqual(calls[0]!.body, { owner, expectedTenant: owner, expectedAccount: smartAccount, side: "sell", usdgAmount: 0, purpose: "close-perp", symbol: "BTC-PERP", book: "paper" });
  assert.equal("book" in calls[1]!.body, false, "unread close all must not pretend to have seen a book");
  assert.equal(calls[2]!.url, "/api/paper-reset?wallet=perps");
  assert.deepEqual(calls[2]!.body, { owner, expectedTenant: owner, expectedAccount: smartAccount });
  let sent = 0;
  globalThis.fetch = (async () => { sent++; throw new Error("lost reply after send"); }) as typeof fetch;
  await assert.rejects(submitPerpsAction(account, { kind: "close", market: "BTC-PERP" }), /may still run.*not sent again/);
  assert.equal(sent, 1);
});

test("a Spot grant cannot drive any Perps write", async () => {
  let sent = 0; globalThis.fetch = (async () => { sent++; return json({}); }) as typeof fetch;
  await assert.rejects(submitPerpsAction({ ...account, status: { ...account.status, grant: { ...account.status.grant, purpose: undefined } } }, { kind: "reset" }), /Nothing was sent/);
  assert.equal(sent, 0);
});


test("the signer refuses a stale prompt before signing and discards a late signature", async () => {
  let current = true, signed = 0;
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const owner = { address: "fixed-owner", signMessage: async () => { signed++; return pending; }, signTypedData: async () => "typed" };
  const guarded = guardPerpsSigner(owner, () => { if (!current) throw new Error("stale authority"); });
  assert.equal(guarded.address, "fixed-owner");
  const signature = guarded.signMessage(); current = false; finish("late-signature");
  await assert.rejects(signature, /stale authority/);
  await assert.rejects(guarded.signTypedData(), /stale authority/);
  await assert.rejects(guarded.signMessage(), /stale authority/);
  assert.equal(signed, 1);
});
