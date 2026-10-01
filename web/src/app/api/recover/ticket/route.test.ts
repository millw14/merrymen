import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeErrorResult, encodeFunctionData, erc20Abi, toFunctionSelector } from "viem";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT } from "@merrymen/core";
import { readTicket } from "@/lib/recovery-ticket";
import { GET, POST } from "./route";
import { POST as relayPost } from "../../bundler/[chainId]/route";

const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d" as const;
const SOURCE = `0x${"cd".repeat(20)}` as const;
const owner = privateKeyToAccount(`0x${"17".repeat(32)}`);
const envKeys = ["MERRYMEN_SESSION_SECRET", "MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_HOSTED", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_BUNDLER_API_KEY", "MERRYMEN_SPONSOR_GAS"] as const;
let previous: Array<string | undefined>;
let home: string;
const originalFetch = globalThis.fetch;
let deployed = false;
beforeEach(async () => {
  previous = envKeys.map((key) => process.env[key]);
  home = await mkdtemp(path.join(tmpdir(), "merrymen-ticket-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = "ticket-test-secret-never-production";
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://merrymen.test";
  process.env.MERRYMEN_BUNDLER_API_KEY = "ticket-test-bundler-key";
  delete process.env.MERRYMEN_SPONSOR_GAS;
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_HOSTED;
  deployed = false;
  globalThis.fetch = async (input, init) => {
    const testnet = String(input).includes("testnet");
    const payload = JSON.parse(String(init?.body));
    const handle = (rpc: { id: number; method: string; params: Array<Record<string, string>> }) => {
      const base = { jsonrpc: "2.0", id: rpc.id };
      if (rpc.method === "eth_chainId") return { ...base, result: testnet ? "0xb626" : "0x1237" };
      if (rpc.method === "eth_getCode") return { ...base, result: deployed ? "0x6000" : "0x" };
      if (rpc.method === "eth_sendUserOperation") return { ...base, result: `0x${"ab".repeat(32)}` };
      if (rpc.method === "eth_call") {
        const call = rpc.params[0]!;
        if (call.to?.toLowerCase() === ENTRYPOINT.v07.toLowerCase() && call.data?.startsWith(toFunctionSelector("getSenderAddress(bytes)"))) {
          return { ...base, error: { code: 3, message: "execution reverted", data: encodeErrorResult({
            abi: [{ type: "error", name: "SenderAddressResult", inputs: [{ type: "address", name: "sender" }] }],
            errorName: "SenderAddressResult", args: [testnet ? SOURCE : ACCOUNT],
          }) } };
        }
        return { ...base, result: `0x${"0".repeat(64)}` };
      }
      throw new Error(`Unexpected ticket fixture RPC: ${rpc.method}`);
    };
    return Response.json(Array.isArray(payload) ? payload.map(handle) : handle(payload));
  };
});

it("preserves an installed client's default challenge, no-scope ticket and signed withdrawal submission", async () => {
  const challenge = await (await GET(new Request("https://merrymen.test/api/recover/ticket"))).json();
  assert.equal(challenge.message, [
    "https://merrymen.test — withdraw from your merrymen account.", "",
    "This proves you control the owner key so the site will relay your withdrawal.",
    "It moves no funds by itself and grants no permissions: the withdrawal itself",
    "is a separate operation you sign next.", "",
    "URI: https://merrymen.test", `Nonce: ${challenge.nonce}`,
  ].join("\n"));
  const response = await POST(new Request("https://merrymen.test/api/recover/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    nonce: challenge.nonce, signature: await owner.signMessage({ message: challenge.message }), chainId: 4663,
  }) }));
  assert.equal(response.status, 200);
  const token = response.headers.get("set-cookie")!.match(/merrymen_recovery=([^;]+)/)![1]!;
  assert.equal(readTicket(token)?.sponsorship?.owner.toLowerCase(), owner.address.toLowerCase());
  const callData = await encodeCallDataEpV07([{ to: SOURCE, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner.address, 5n] }) }]);
  const op = { sender: ACCOUNT, nonce: "0x0", callData, callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0xc350", maxFeePerGas: "0x2faf080", maxPriorityFeePerGas: "0xf4240", signature: "0x" };
  const hash = getUserOperationHash({ userOperation: formatUserOperation(op as RpcUserOperation), chainId: 4663, entryPointAddress: ENTRYPOINT.v07, entryPointVersion: "0.7" });
  op.signature = await owner.signMessage({ message: { raw: hash } });
  const sent = await relayPost(new Request("https://merrymen.test/api/bundler/4663", { method: "POST", headers: { "content-type": "application/json", cookie: `merrymen_recovery=${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendUserOperation", params: [op, ENTRYPOINT.v07] }) }), { params: Promise.resolve({ chainId: "4663" }) });
  assert.equal((await sent.json()).result, `0x${"ab".repeat(32)}`);
});

it("separates legacy and owner-actions nonces without burning the correct-scope challenge", async () => {
  for (const ownerActions of [false, true]) {
    const challenge = await (await GET(new Request(`https://merrymen.test/api/recover/ticket${ownerActions ? "?scope=owner-actions" : ""}`))).json();
    assert.equal(challenge.message.includes("permission revocations"), ownerActions);
    assert.ok(challenge.message.includes("URI: https://merrymen.test\n"));
    const signature = await owner.signMessage({ message: challenge.message });
    const request = (v2: boolean) => new Request("https://merrymen.test/api/recover/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: challenge.nonce, signature, chainId: 4663, ...(v2 ? { scope: "owner-actions" } : {}) }) });
    const mismatch = await POST(request(!ownerActions));
    assert.equal(mismatch.status, 401);
    assert.match((await mismatch.json()).error, /origin mismatch/);
    const accepted = await POST(request(ownerActions));
    assert.equal(accepted.status, 200);
    const token = accepted.headers.get("set-cookie")!.match(/merrymen_recovery=([^;]+)/)![1]!;
    assert.equal(readTicket(token)?.sponsorship?.owner.toLowerCase(), owner.address.toLowerCase());
    assert.equal((await POST(request(ownerActions))).status, 401);
  }
});

it("refuses unknown or ambiguous scope values before issuing or consuming a challenge", async () => {
  for (const query of ["?scope=", "?scope=withdraw", "?scope=owner-actions&scope=owner-actions"]) {
    assert.equal((await GET(new Request(`https://merrymen.test/api/recover/ticket${query}`))).status, 400);
  }
  for (const scope of [null, "", "withdraw", {}, ["owner-actions"]]) {
    assert.equal((await POST(new Request("https://merrymen.test/api/recover/ticket", { method: "POST", body: JSON.stringify({ scope }) }))).status, 400);
  }
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  envKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  await rm(home, { recursive: true, force: true });
});

it("mints owner and canonical deployment proof from the SDK on both deployed and undeployed accounts", async () => {
  for (deployed of [false, true]) {
    const challenge = await (await GET(new Request("https://merrymen.test/api/recover/ticket"))).json();
    const signature = await owner.signMessage({ message: challenge.message });
    const body = { nonce: challenge.nonce, signature, chainId: 4663,
      owner: SOURCE, factory: SOURCE, factoryData: "0xdeadbeef", accounts: [SOURCE] };
    const request = () => new Request("https://merrymen.test/api/recover/ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await POST(request());
    assert.equal(response.status, 200);
    const token = response.headers.get("set-cookie")?.match(/merrymen_recovery=([^;]+)/)?.[1];
    assert.ok(token);
    assert.ok(token.length < 3800, "the complete capability fits the browser cookie limit");
    const ticket = readTicket(token)!;
    assert.equal(ticket.smartAccount.toLowerCase(), ACCOUNT.toLowerCase());
    assert.equal(ticket.sponsorship?.owner.toLowerCase(), owner.address.toLowerCase());
    assert.deepEqual(ticket.sponsorship?.accounts.map((a) => a.toLowerCase()), [ACCOUNT, SOURCE].map((a) => a.toLowerCase()));
    assert.notEqual(ticket.sponsorship?.factory, SOURCE);
    assert.notEqual(ticket.sponsorship?.factoryData, "0xdeadbeef");
    assert.ok(ticket.sponsorship?.factoryData.startsWith("0x"));
    assert.equal((await POST(request())).status, 401, "a used owner challenge cannot mint another ticket");
  }
});
