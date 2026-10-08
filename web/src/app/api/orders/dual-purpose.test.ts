import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, it } from "node:test";
import { purposeHome } from "@merrymen/home";
import { resetSettingsStoreForTest } from "@merrymen/settings-store";
import { claimCommandFile, openCommands, writeCommandResult } from "../../../../../worker/src/command-files";
import { POST, GET } from "./route";
import { GET as ceiling } from "./ceiling/route";
import { POST as reset } from "../paper-reset/route";
import { POST as recover, GET as recoveryContext } from "../recover/route";
import { GET as challenge, POST as ticket } from "../recover/ticket/route";

const keys = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SETTINGS_FILE", "DATABASE_URL", "MERRYMEN_SESSION_SECRET"] as const;
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const spot = `0x${"11".repeat(20)}`, perps = `0x${"22".repeat(20)}`;
const dirs: string[] = [];
let home: string;
const req = (route: string, body?: unknown) => new Request(`https://app.example.test/api/${route}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const close = { purpose: "close-perp", side: "sell", symbol: "BTC-PERP", usdgAmount: 0, book: "paper", expectedAccount: perps };
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "mm-dual-wallet-orders-")); dirs.push(home);
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED; delete process.env.DATABASE_URL;
  process.env.MERRYMEN_SETTINGS_FILE = path.join(home, "settings.json");
  process.env.MERRYMEN_SESSION_SECRET = "a".repeat(64);
  resetSettingsStoreForTest();
  mkdirSync(purposeHome("perps"), { recursive: true });
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: spot, demoOwnerPrivateKey: `0x${"33".repeat(32)}` }));
  writeFileSync(path.join(purposeHome("perps"), "grant.json"), JSON.stringify({ smartAccount: perps, purpose: "perps" }));
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ telegramMaxActionUsdg: 71 }));
  writeFileSync(path.join(purposeHome("perps"), "settings.json"), JSON.stringify({ telegramMaxActionUsdg: 9 }));
});
after(() => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetSettingsStoreForTest(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("a Perps close reaches only its own command queue and lookup cannot cross to Spot", async () => {
  const result = await POST(req("orders?purpose=perps", close)); assert.equal(result.status, 200);
  const { id } = await result.json();
  assert.equal(openCommands(home).length, 0);
  assert.equal(openCommands(purposeHome("perps")).length, 1);
  assert.equal((await (await GET(req(`orders?purpose=perps&id=${id}`))).json()).state, "queued");
  assert.equal((await (await GET(req(`orders?id=${id}`))).json()).state, "running", "an absent local command remains indeterminate; it cannot see the other wallet queue");
  const command = claimCommandFile(purposeHome("perps"));
  assert.equal(command?.args?.purpose, "close-perp"); assert.equal(command?.args?.book, "paper");
  writeCommandResult(purposeHome("perps"), { id, ok: true, line: "perps-only-receipt", at: Date.now() });
  const ownReceipt = await (await GET(req(`orders?purpose=perps&id=${id}`))).json();
  const otherReceipt = await (await GET(req(`orders?id=${id}`))).json();
  assert.match(JSON.stringify(ownReceipt), /perps-only-receipt/);
  assert.doesNotMatch(JSON.stringify(otherReceipt), /perps-only-receipt/);
  assert.equal(command?.args?.expectedAccount, undefined, "review identity is checked before writing, never an execution override");
  const spotResult = await POST(req("orders", { side: "buy", symbol: "TSLA", usdgAmount: 5, expectedAccount: spot }));
  assert.equal(spotResult.status, 200);
  assert.equal(claimCommandFile(home)?.args?.symbol, "TSLA");
  assert.equal(claimCommandFile(purposeHome("perps")), null);
});

it("reviewed account mismatch, malformed account and Spot orders cannot write a Perps command", async () => {
  for (const [body, status] of [
    [{ ...close, expectedAccount: spot }, 409], [{ ...close, expectedAccount: "invalid" }, 400],
    [{ side: "buy", symbol: "TSLA", usdgAmount: 1 }, 400],
  ] as const) assert.equal((await POST(req("orders?purpose=perps", body))).status, status);
  assert.equal(openCommands(home).length, 0); assert.equal(openCommands(purposeHome("perps")).length, 0);
});

it("paper reset is delivered only to the chosen wallet", async () => {
  assert.equal((await reset(req("paper-reset?purpose=perps", {}))).status, 200);
  assert.equal(claimCommandFile(purposeHome("perps"))?.kind, "paper-reset");
  assert.equal(claimCommandFile(home), null);
});

it("recovery rejects account changes before key use and never borrows a Spot stored key", async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("recovery must fail before RPC"); };
  try {
    const mismatch = await recover(req("recover?purpose=perps", { mode: "sweep", expectedAccount: spot, to: spot }));
    assert.equal(mismatch.status, 409);
    const absent = await recover(req("recover?purpose=perps", { mode: "plan", expectedAccount: perps }));
    assert.equal(absent.status, 400); assert.match((await absent.json()).error, /no owner key/);
    assert.equal((await (await recoveryContext(req("recover?purpose=perps"))).json()).hasStoredKey, false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

it("all generic money and recovery endpoints reject invalid or duplicate purpose selectors", async () => {
  for (const selector of ["purpose=other", "purpose=perps&purpose=spot", "purpose="]) {
    for (const [handler, route] of [[POST, "orders"], [GET, "orders"], [ceiling, "orders/ceiling"], [reset, "paper-reset"],
      [recover, "recover"], [recoveryContext, "recover"], [challenge, "recover/ticket"], [ticket, "recover/ticket"]] as const) {
      assert.equal((await handler(req(`${route}?${selector}`, {}))).status, 400, route);
    }
  }
  assert.equal(openCommands(home).length, 0); assert.equal(openCommands(purposeHome("perps")).length, 0);
});

it("recovery proof explicitly binds the dedicated account purpose", async () => {
  const spotChallenge = await (await challenge(req("recover/ticket"))).json();
  const perpChallenge = await (await challenge(req("recover/ticket?purpose=perps"))).json();
  assert.doesNotMatch(spotChallenge.message, /Perps wallet/);
  assert.match(perpChallenge.message, /Perps wallet \(Kernel index 1\)/);
});


it("the same login keeps each wallet's order ceiling independent", async () => {
  assert.equal((await (await ceiling(req("orders/ceiling"))).json()).ceilingUsdg, 71);
  assert.equal((await (await ceiling(req("orders/ceiling?purpose=perps"))).json()).ceilingUsdg, 9);
});
