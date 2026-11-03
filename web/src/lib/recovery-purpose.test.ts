import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeFunctionData, encodeErrorResult, getAddress, keccak256, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ownerFromPrivateKey, planRecovery, recoverFunds } from "../../../worker/src/recover";
import { chainForId } from "@merrymen/core";
import { GET as ticketGet, POST as ticketPost } from "../app/api/recover/ticket/route";
import { GET as recoverGet, POST as recoverPost } from "../app/api/recover/route";
import { mintTicket, readTicket, recoveryChallengeMessage } from "./recovery-ticket";
import { relayUrl } from "./recover-client";
const ENTRY = parseAbi(["function getSenderAddress(bytes initCode)", "error SenderAddressResult(address sender)"]);
const FACTORY = parseAbi(["function deployWithFactory(address factory, bytes createData, bytes32 salt)"]);
const KEY = `0x${"11".repeat(32)}` as Hex, owner = privateKeyToAccount(KEY), ACCOUNT = `0x${"22".repeat(20)}` as Hex;
const asked: Hex[] = [];
const old = { ...process.env }, oldFetch = globalThis.fetch;
let home: string;
before(() => {
  home = mkdtempSync(path.join(tmpdir(), "perps-recovery-purpose-"));
  process.env.MERRYMEN_HOME = home; process.env.MERRYMEN_SESSION_SECRET = "test-only-secret".repeat(4);
  delete process.env.MERRYMEN_HOSTED; delete process.env.MERRYMEN_PERPS; delete process.env.DATABASE_URL;
  globalThis.fetch = async (_url, init) => {
    const value = JSON.parse(String(init?.body));
    const answer = (req: { id: number; method: string; params: {data: Hex}[] }) => {
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0xb626" };
      assert.equal(req.method, "eth_call", "no sends or balance reads occur before expected-account guard");
      const code = decodeFunctionData({ abi: ENTRY, data: req.params[0].data }).args[0]; asked.push(code);
      return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: ENTRY, errorName: "SenderAddressResult", args: [getAddress(`0x${keccak256(code).slice(-40)}`)] }) } };
    };
    return Response.json(Array.isArray(value) ? value.map(answer) : answer(value));
  };
});
after(() => { globalThis.fetch = oldFetch; for (const k of ["MERRYMEN_HOME", "MERRYMEN_SESSION_SECRET", "MERRYMEN_HOSTED", "MERRYMEN_PERPS", "DATABASE_URL"]) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } rmSync(home, { recursive: true, force: true }); });
const salt = (code: Hex) => BigInt(decodeFunctionData({ abi: FACTORY, data: `0x${code.slice(42)}` }).args[2]);
it("plan and sweep derive Spot at index 0 and Perps at index 1, then enforce expected account before money reads", async () => {
  const codes: Hex[] = [];
  for (const purpose of ["spot", "perps"] as const) {
    const options = { purpose, chain: chainForId(46630), owner: ownerFromPrivateKey(KEY), expectedSmartAccount: ACCOUNT };
    asked.length = 0; await assert.rejects(planRecovery(options), /not the expected/); assert.equal(asked.length, 1); assert.equal(salt(asked[0]), purpose === "spot" ? 0n : 1n); codes.push(asked[0]);
    asked.length = 0; await assert.rejects(recoverFunds({ ...options, bundlerUrl: "http://unused.invalid", to: owner.address }), /not the expected/); assert.equal(asked[0], codes.at(-1));
  }
  const [spotFactory, spotData] = decodeFunctionData({ abi: FACTORY, data: `0x${codes[0].slice(42)}` }).args;
  const [perpsFactory, perpsData] = decodeFunctionData({ abi: FACTORY, data: `0x${codes[1].slice(42)}` }).args;
  assert.equal(spotFactory, perpsFactory); assert.equal(spotData, perpsData); assert.notEqual(codes[0], codes[1]);
});
it("invalid purpose is refused before network calls", async () => {
  asked.length = 0; await assert.rejects(planRecovery({ purpose: "typo" as never, chain: chainForId(46630), owner: ownerFromPrivateKey(KEY) }), /purpose/i); assert.equal(asked.length, 0);
});
it("legacy Spot tickets remain Spot, and Perps purpose cannot be removed or tampered", () => {
  const legacy = mintTicket({ smartAccount: ACCOUNT, chainId: 46630, classVaults: [] });
  assert.equal(readTicket(legacy)?.purpose ?? "spot", "spot");
  const perps = mintTicket({ smartAccount: ACCOUNT, chainId: 46630, classVaults: [], purpose: "perps" });
  assert.equal(readTicket(perps)?.purpose, "perps");
  assert.equal(readTicket(perps.replace(".perps.", ".spot.")), null);
  assert.equal(readTicket(perps.replace(".perps.", ".")), null);
  const parts = legacy.split("."); parts.splice(-1, 0, "perps"); assert.equal(readTicket(parts.join(".")), null);
  assert.equal(recoveryChallengeMessage("http://localhost", "nonce"), recoveryChallengeMessage("http://localhost", "nonce", "spot"));
  assert.notEqual(recoveryChallengeMessage("http://localhost", "nonce", "perps"), recoveryChallengeMessage("http://localhost", "nonce", "spot"));
  assert.equal(relayUrl(46630), "/api/bundler/46630"); assert.equal(relayUrl(46630, "perps"), "/api/bundler/46630?wallet=perps");
});
it("Perps recovery challenges and tickets work paper-off, but cannot replay a Spot challenge or reverse", async () => {
  for (const wallet of ["spot", "perps"] as const) {
    const req = (selected: string, init?: RequestInit) => new Request(`http://localhost/api/recover/ticket?wallet=${selected}`, init);
    const challenge = await ticketGet(req(wallet)); assert.equal(challenge.status, 200);
    const body = await challenge.json(); const signature = await owner.signMessage({ message: body.message });
    const payload = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: body.nonce, signature, chainId: 46630 }) };
    asked.length = 0;
    assert.equal((await ticketPost(req(wallet === "spot" ? "perps" : "spot", payload))).status, 401); assert.equal(asked.length, 0);
    const minted = await ticketPost(req(wallet, payload)); assert.equal(minted.status, 200); assert.equal(salt(asked[0]), wallet === "spot" ? 0n : 1n);
    const token = minted.headers.get("set-cookie")!.match(/merrymen_recovery=([^;]+)/)![1]; assert.equal(readTicket(token)?.purpose ?? "spot", wallet);
    assert.equal((await ticketPost(req(wallet, payload))).status, 401, "single use after successful mint");
  }
});
it("paper-off local recovery uses Perps home and never the Spot owner key; hosted refuses keys before parsing", async () => {
  mkdirSync(path.join(home, "accounts/perps"), { recursive: true });
  writeFileSync(path.join(home, "grant.json"), JSON.stringify({ smartAccount: ACCOUNT, chainId: 46630, demoOwnerPrivateKey: KEY }));
  const req = (method = "GET", body?: string) => new Request("http://localhost/api/recover?wallet=perps", { method, ...(body ? { body } : {}) });
  asked.length = 0;
  const absent = await (await recoverGet(req())).json(); assert.equal(absent.hasStoredKey, false); assert.equal(asked.length, 0);
  writeFileSync(path.join(home, "accounts/perps/grant.json"), JSON.stringify({ purpose: "perps", smartAccount: ACCOUNT, chainId: 46630, demoOwnerPrivateKey: KEY }));
  const own = await (await recoverGet(req())).json(); assert.equal(own.hasStoredKey, true); assert.match(own.error, /not the expected/); assert.equal(salt(asked[0]), 1n);
  process.env.MERRYMEN_HOSTED = "1";
  assert.equal((await recoverPost(req("POST", "not-json"))).status, 403); assert.equal((await (await recoverGet(req())).json()).clientSide, true);
  delete process.env.MERRYMEN_HOSTED;
});
