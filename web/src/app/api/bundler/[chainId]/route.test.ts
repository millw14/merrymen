import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeCallDataEpV07 } from "@zerodev/sdk";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { ENTRYPOINT } from "@merrymen/core";
import { mintTicket } from "@/lib/recovery-ticket";
import { KERNEL_REVOCATION_ABI } from "@/lib/permission-revocation";
import { sdkRevocationCall } from "@/lib/permission-revocation-fixture";
import { POST } from "./route";

const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d" as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const DATA = `0x1f1b92e3${"0".repeat(63)}2` as Hex;
const methods = ["eth_estimateUserOperationGas", "eth_sendUserOperation"];
const originalFetch = globalThis.fetch;
let previousSecret: string | undefined;
let previousBundler: string | undefined;
let forwarded: Array<{ method: string; params: unknown[] }>;

beforeEach(() => {
  previousSecret = process.env.MERRYMEN_SESSION_SECRET;
  previousBundler = process.env.MERRYMEN_BUNDLER_API_KEY;
  process.env.MERRYMEN_SESSION_SECRET = "relay-test-only-secret-never-production";
  process.env.MERRYMEN_BUNDLER_API_KEY = "relay-test-only-bundler";
  forwarded = [];
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body));
    forwarded.push(rpc);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { acceptedByFixture: true } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousSecret === undefined) delete process.env.MERRYMEN_SESSION_SECRET;
  else process.env.MERRYMEN_SESSION_SECRET = previousSecret;
  if (previousBundler === undefined) delete process.env.MERRYMEN_BUNDLER_API_KEY;
  else process.env.MERRYMEN_BUNDLER_API_KEY = previousBundler;
});

const ticket = (account: Address = ACCOUNT, chainId = 4663) => mintTicket({ smartAccount: account, chainId, classVaults: [] });
async function request(method: string, callData: Hex, opts: {
  sender?: string; cookie?: string | null; entryPoint?: string; op?: Record<string, unknown>;
} = {}) {
  const cookie = opts.cookie === undefined ? ticket() : opts.cookie;
  return POST(new Request("https://merrymen.test/api/bundler/4663", {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie: `merrymen_recovery=${cookie}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [{
      sender: opts.sender ?? ACCOUNT, nonce: "0x0", callData,
      callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0",
      maxFeePerGas: "0x18ebe44", maxPriorityFeePerGas: "0x1fe3e", signature: "0x",
      ...opts.op,
    }, opts.entryPoint ?? ENTRYPOINT.v07] }),
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
