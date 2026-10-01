import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeErrorResult, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT } from "@merrymen/core";
import { readTicket } from "@/lib/recovery-ticket";
import { GET, POST } from "./route";

const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d" as const;
const SOURCE = `0x${"cd".repeat(20)}` as const;
const owner = privateKeyToAccount(`0x${"17".repeat(32)}`);
const envKeys = ["MERRYMEN_SESSION_SECRET", "MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_HOSTED", "MERRYMEN_PUBLIC_ORIGIN"] as const;
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
