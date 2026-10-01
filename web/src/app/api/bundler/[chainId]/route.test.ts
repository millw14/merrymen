import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperation, getUserOperationHash, type RpcUserOperation } from "viem/account-abstraction";
import { ENTRYPOINT } from "@merrymen/core";
import { getIdentityStore, resetIdentityStoreForTest } from "@merrymen/identity-store";
import { mintTicket, type Ticket } from "@/lib/recovery-ticket";
import { KERNEL_REVOCATION_ABI } from "@/lib/permission-revocation";
import { sdkRevocationCall } from "@/lib/permission-revocation-fixture";
import { GET, POST } from "./route";

const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d" as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const DATA = `0x1f1b92e3${"0".repeat(63)}2` as Hex;
const methods = ["eth_estimateUserOperationGas", "eth_sendUserOperation"];
const originalFetch = globalThis.fetch;
let previousSecret: string | undefined;
let previousBundler: string | undefined;
let forwarded: Array<{ method: string; params: unknown[] }>;
const envKeys = ["MERRYMEN_SPONSOR_GAS", "MERRYMEN_SPONSORSHIP_POLICY_ID", "MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_HOSTED"] as const;
let savedEnv: Array<string | undefined>;
let testHome: string;
let quote: Record<string, unknown>;

beforeEach(async () => {
  savedEnv = envKeys.map((key) => process.env[key]);
  testHome = await mkdtemp(path.join(tmpdir(), "merrymen-owner-relay-"));
  process.env.MERRYMEN_HOME = testHome;
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_SPONSOR_GAS;
  delete process.env.MERRYMEN_SPONSORSHIP_POLICY_ID;
  resetIdentityStoreForTest();
  previousSecret = process.env.MERRYMEN_SESSION_SECRET;
  previousBundler = process.env.MERRYMEN_BUNDLER_API_KEY;
  process.env.MERRYMEN_SESSION_SECRET = "relay-test-only-secret-never-production";
  process.env.MERRYMEN_BUNDLER_API_KEY = "relay-test-only-bundler";
  forwarded = [];
  quote = { paymaster: OTHER, paymasterData: "0x1234", paymasterVerificationGasLimit: "0x30d40", paymasterPostOpGasLimit: "0x186a0" };
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    forwarded.push(rpc);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: rpc.method.startsWith("pm_") ? quote : { acceptedByFixture: true } });
  };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousSecret === undefined) delete process.env.MERRYMEN_SESSION_SECRET;
  else process.env.MERRYMEN_SESSION_SECRET = previousSecret;
  if (previousBundler === undefined) delete process.env.MERRYMEN_BUNDLER_API_KEY;
  else process.env.MERRYMEN_BUNDLER_API_KEY = previousBundler;
  envKeys.forEach((key, i) => {
    if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i];
  });
  resetIdentityStoreForTest();
  await rm(testHome, { recursive: true, force: true });
});

const ticket = (account: Address = ACCOUNT, chainId = 4663) => mintTicket({ smartAccount: account, chainId, classVaults: [] });
async function request(method: string, callData: Hex, opts: {
  sender?: string; cookie?: string | null; entryPoint?: string; op?: Record<string, unknown>;
  chain?: string; context?: unknown;
} = {}) {
  const cookie = opts.cookie === undefined ? ticket() : opts.cookie;
  return POST(new Request("https://merrymen.test/api/bundler/4663", {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie: `merrymen_recovery=${cookie}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [{
      sender: opts.sender ?? ACCOUNT, nonce: "0x0", callData,
      callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0",
      maxFeePerGas: "0x18ebe44", maxPriorityFeePerGas: "0x1fe3e", signature: "0x",
      ...opts.op,
    }, opts.entryPoint ?? ENTRYPOINT.v07, ...(method.startsWith("pm_") ? [opts.chain ?? "0x1237", opts.context ?? null] : [])] }),
  }), { params: Promise.resolve({ chainId: "4663" }) });
}

describe("owner revocation through the real relay handler", () => {
  it("forwards the exact SDK raw self-call from SirSendIt's screenshot for estimation and submission", async () => {
    const encoded = await sdkRevocationCall(ACCOUNT);
    assert.equal(encoded, DATA, "exercise account.encodeCalls, not the SDK's lower-level execute encoder");
    for (const method of methods) {
      const response = await request(method, encoded);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).result.acceptedByFixture, true);
      const sent = forwarded.at(-1)!;
      assert.equal(sent.method, method);
      assert.equal((sent.params[0] as { callData: string }).callData, DATA);
    }
    assert.equal(forwarded.length, 2);
  });

  it("preserves the wrapped self-call used by existing pending revocations", async () => {
    const encoded = await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data: DATA }]);
    assert.equal((await (await request(methods[0]!, encoded)).json()).result.acceptedByFixture, true);
    assert.equal(forwarded.length, 1);
  });

  it("requires a valid account-bound ticket before forwarding any raw self-call", async () => {
    for (const opts of [
      { cookie: null }, { cookie: `${ticket()}tampered` }, { cookie: ticket(ACCOUNT, 46630) },
      { cookie: ticket(OTHER) }, { sender: OTHER },
    ]) {
      const response = await request(methods[0]!, DATA, opts);
      const body = await response.json();
      assert.ok(body.error, "a missing, invalid or misbound ticket is refused");
    }
    assert.equal(forwarded.length, 0);
  });

  it("refuses unrelated selectors, malformed uint32 arguments and trailing calldata", async () => {
    const wrapped = await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data: DATA }]);
    const forbidden = [
      `${DATA}00`, DATA.slice(0, -2), `${DATA.slice(0, -1)}g`,
      `0x1f1b92e3${"0".repeat(64)}`, `0x1f1b92e3${"0".repeat(55)}100000000`,
      `0x095ea7b3${"0".repeat(63)}2`,
      encodeFunctionData({ abi: KERNEL_REVOCATION_ABI, functionName: "currentNonce" }),
      `${wrapped}00`,
      await encodeCallDataEpV07([{ to: ACCOUNT, value: 1n, data: DATA }]),
      await encodeCallDataEpV07([{ to: OTHER, value: 0n, data: DATA }]),
      await encodeCallDataEpV07([{ to: ACCOUNT, value: 0n, data: DATA }, { to: ACCOUNT, value: 0n, data: DATA }]),
      `${wrapped.slice(0, 12)}01${wrapped.slice(14)}`,
    ];
    for (const method of methods) for (const encoded of forbidden) {
      const body = await (await request(method, encoded as Hex)).json();
      assert.ok(body.error, `must refuse ${encoded}`);
    }
    assert.equal(forwarded.length, 0);
  });

  it("retains the EntryPoint and no-paymaster restrictions for the newly accepted encoding", async () => {
    for (const opts of [
      { entryPoint: OTHER },
      { op: { paymaster: OTHER } },
      { op: { paymasterData: "0x01" } },
      { op: { paymasterVerificationGasLimit: "0x1" } },
    ]) assert.ok((await (await request(methods[0]!, DATA, opts)).json()).error);
    assert.equal(forwarded.length, 0);
  });
});

describe("sponsored owner operations through the real relay", () => {
  const owner = privateKeyToAccount(`0x${"17".repeat(32)}`);
  const proof: NonNullable<Ticket["sponsorship"]> = { owner: owner.address, factory: OTHER, factoryData: "0x1234", accounts: [ACCOUNT] };
  const sponsoredCookie = () => mintTicket({ smartAccount: ACCOUNT, chainId: 4663, classVaults: [], sponsorship: proof });
  async function enabled(known = true) {
    process.env.MERRYMEN_SPONSOR_GAS = "1";
    process.env.MERRYMEN_SPONSORSHIP_POLICY_ID = "house-policy";
    if (known) await getIdentityStore().ensure(owner.address, ACCOUNT);
  }
  async function signed(callData: Hex = DATA) {
    const op = { sender: ACCOUNT, nonce: "0x0", callData, factory: OTHER, factoryData: "0x1234",
      callGasLimit: "0x186a0", verificationGasLimit: "0x186a0", preVerificationGas: "0xc350",
      maxFeePerGas: "0x2faf080", maxPriorityFeePerGas: "0xf4240", ...quote, signature: "0x" };
    const hash = getUserOperationHash({ userOperation: formatUserOperation(op as RpcUserOperation), chainId: 4663, entryPointAddress: ENTRYPOINT.v07, entryPointVersion: "0.7" });
    return { ...op, signature: await owner.signMessage({ message: { raw: hash } }) };
  }

  it("reports setup separately from eligibility and never sponsors a fresh stranger", async () => {
    const status = () => GET(new Request("https://merrymen.test/api/bundler/4663", { headers: { cookie: `merrymen_recovery=${sponsoredCookie()}` } }), { params: Promise.resolve({ chainId: "4663" }) });
    assert.equal((await (await status()).json()).sponsorshipEnabled, false);
    await enabled(false);
    assert.equal((await (await status()).json()).gasSponsored, false);
    assert.ok((await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie() })).json()).error);
    assert.equal(forwarded.length, 0);
    await getIdentityStore().ensure(owner.address, ACCOUNT);
    assert.equal((await (await status()).json()).gasSponsored, true);
    delete process.env.MERRYMEN_SPONSORSHIP_POLICY_ID;
    assert.equal((await (await status()).json()).sponsorshipEnabled, true);
    assert.equal((await (await status()).json()).gasSponsored, false);
  });

  it("quotes only the house policy, strips provider overrides and checks ticket/chain/calldata/factory", async () => {
    await enabled();
    quote.callData = "0x1234";
    quote.callGasLimit = "0xffffff";
    quote.isFinal = true;
    for (const method of ["pm_getPaymasterStubData", "pm_getPaymasterData"]) {
      const body = await (await request(method, DATA, { cookie: sponsoredCookie(), context: { sponsorshipPolicyId: "attacker-policy", token: OTHER } })).json();
      assert.equal(body.result.paymaster, OTHER);
      assert.equal(body.result.callData, undefined);
      assert.equal(body.result.callGasLimit, undefined);
      assert.notEqual(body.result.isFinal, true);
      assert.deepEqual(forwarded.at(-1)!.params[3], { sponsorshipPolicyId: "house-policy" });
    }
    const count = forwarded.length;
    for (const options of [
      { cookie: ticket() }, { sender: OTHER }, { chain: "0xb626" }, { entryPoint: OTHER },
      { op: { factory: OTHER, factoryData: "0x4321" } }, { op: { callData: "0xdeadbeef" } },
      { op: { callGasLimit: "0x2dc6c1" } }, { op: { authorization: {} } },
    ]) assert.ok((await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie(), ...options })).json()).error);
    assert.equal(forwarded.length, count);
  });

  it("requires the owner's final signature and accepts both self-revocation and withdrawal", async () => {
    await enabled();
    const withdrawal = await encodeCallDataEpV07([{ to: OTHER, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner.address, 5n] }) }]);
    for (const callData of [DATA, withdrawal]) {
      const op = await signed(callData);
      assert.ok((await (await request("eth_sendUserOperation", callData, { cookie: sponsoredCookie(), op })).json()).result);
      const count = forwarded.length;
      for (const patch of [{ signature: "0x" }, { paymasterData: "0xabcd" }, { maxFeePerGas: "0x1" }, { callGasLimit: "0x0" }]) {
        assert.ok((await (await request("eth_sendUserOperation", callData, { cookie: sponsoredCookie(), op: { ...op, ...patch } })).json()).error);
      }
      assert.equal(forwarded.length, count);
    }
  });

  it("reserves before final quotes, keeps uncertain outcomes charged, and refuses final stubs after exhaustion", async () => {
    await enabled();
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network timeout after request"); };
    assert.equal((await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie() })).status, 502);
    globalThis.fetch = savedFetch;
    for (let nonce = 0; nonce < 10; nonce++) {
      assert.ok((await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie(), op: { nonce: `0x${nonce.toString(16)}` } })).json()).result);
    }
    assert.ok((await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie() })).json()).result, "an exact retry reuses its first durable reservation");
    const count = forwarded.length;
    assert.match((await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie(), op: { nonce: "0xa" } })).json()).error.message, /allowance is exhausted/);
    assert.equal(forwarded.length, count, "quota refusal happens before any upstream final authorization");
    quote.isFinal = true;
    assert.match((await (await request("pm_getPaymasterStubData", DATA, { cookie: sponsoredCookie(), op: { nonce: "0xa" } })).json()).error.message, /allowance is exhausted/);
  });

  it("refuses final sponsorship before upstream when hosted shared storage is unavailable", async () => {
    await enabled();
    process.env.MERRYMEN_HOSTED = "1";
    const result = await (await request("pm_getPaymasterData", DATA, { cookie: sponsoredCookie() })).json();
    assert.match(result.error.message, /budget could not be reserved/);
    assert.equal(forwarded.length, 0);
  });
});
