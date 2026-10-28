/**
 * THE PERPS WALLET IS KERNEL INDEX 1 OF THE SAME OWNER KEY, AND SPOT DID NOT MOVE.
 *
 * deriveKernelAccountAddress asks the EntryPoint where the account would be
 * (getSenderAddress, an eth_call). Here `fetch` answers instead of a node, so
 * nothing leaves the machine: the address it gives is a hash of the init code
 * it was asked about, so one question always gets one answer and a different
 * question a different one. Spot's question is compared with the one Kernel's
 * default asks (no index given at all), which is how every existing account
 * was derived.
 */
import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { createPublicClient, decodeFunctionData, encodeErrorResult, getAddress, keccak256, parseAbi, type Hex } from "viem";
import { toAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { chainForId } from "@merrymen/core";
import { webChainRead } from "./chain-read";
import { deriveKernelAccountAddress } from "./derive-account";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ENTRY_POINT = parseAbi(["function getSenderAddress(bytes initCode)", "error SenderAddressResult(address sender)"]);
const META_FACTORY = parseAbi(["function deployWithFactory(address factory, bytes createData, bytes32 salt)"]);

/** Every getSenderAddress init code asked about, in order. */
const asked: Hex[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    const answer = (req: { id: number; method: string; params?: Array<{ data?: Hex }> }) => {
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1237" };
      if (req.method !== "eth_call" || !req.params?.[0]?.data) return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "not stubbed" } };
      const { args } = decodeFunctionData({ abi: ENTRY_POINT, data: req.params[0].data });
      const initCode = args[0];
      asked.push(initCode);
      const sender = getAddress(`0x${keccak256(initCode).slice(-40)}`);
      return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted",
        data: encodeErrorResult({ abi: ENTRY_POINT, errorName: "SenderAddressResult", args: [sender] }) } };
    };
    const out = Array.isArray(body) ? body.map(answer) : answer(body as never);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Kernel's own default: the derivation exactly as it was before wallets had a purpose. */
async function defaultInitCode(): Promise<Hex> {
  const client = createPublicClient({ chain: chainForId(4663), transport: webChainRead() });
  const signer = toAccount({
    address: OWNER,
    signMessage: async () => { throw new Error("view only"); },
    signTransaction: async () => { throw new Error("view only"); },
    signTypedData: async () => { throw new Error("view only"); },
  });
  const sudo = await signerToEcdsaValidator(client, { signer, entryPoint: getEntryPoint("0.7"), kernelVersion: KERNEL_V3_3 });
  asked.length = 0;
  await createKernelAccount(client, { entryPoint: getEntryPoint("0.7"), kernelVersion: KERNEL_V3_3, plugins: { sudo } });
  return asked[0]!;
}

const saltOf = (initCode: Hex) => decodeFunctionData({ abi: META_FACTORY, data: `0x${initCode.slice(42)}` }).args;

it("Spot asks exactly what Kernel's default asks, so no existing address moves", async () => {
  const before = await defaultInitCode();
  asked.length = 0;
  const spot = await deriveKernelAccountAddress(OWNER, 4663, "spot");
  assert.equal(spot.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0], before);
  assert.equal(BigInt(saltOf(asked[0]!)[2]), 0n);
});

it("Perps is the same owner at index 1: another address, and nothing else in the question differs", async () => {
  asked.length = 0;
  const spot = await deriveKernelAccountAddress(OWNER, 4663, "spot");
  const perps = await deriveKernelAccountAddress(OWNER, 4663, "perps");
  assert.ok(spot.ok && perps.ok);
  assert.notEqual(spot.address.toLowerCase(), perps.address.toLowerCase());
  const [spotFactory, spotData, spotSalt] = saltOf(asked[0]!);
  const [perpsFactory, perpsData, perpsSalt] = saltOf(asked[1]!);
  assert.equal(perpsFactory, spotFactory);
  assert.equal(perpsData, spotData, "the same owner validator: only the index moves the address");
  assert.equal(BigInt(spotSalt), 0n);
  assert.equal(BigInt(perpsSalt), 1n);
});
