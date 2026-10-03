import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createKernelAccount } from "@zerodev/sdk";
import { getEntryPoint, KERNEL_V3_3 } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { createPublicClient, custom, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatUserOperationRequest } from "viem/account-abstraction";
import { robinhoodChain } from "@merrymen/core";
import type { PublicIdentity } from "@merrymen/identity-store";
import type { Ticket } from "./recovery-ticket";
import { ownerSignatureValid, ownerSponsorshipStatus, paymasterResult, sponsoredOperationProblem } from "./owner-sponsorship";

const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d" as const;
const OTHER = `0x${"cd".repeat(20)}` as const;
const owner = privateKeyToAccount(`0x${"17".repeat(32)}`);
const DATA = `0x1f1b92e3${"0".repeat(63)}2` as Hex;
const envKeys = ["MERRYMEN_SPONSOR_GAS", "MERRYMEN_BUNDLER_API_KEY", "MERRYMEN_SPONSORSHIP_POLICY_ID"] as const;
let saved: Array<string | undefined>;
beforeEach(() => {
  saved = envKeys.map((key) => process.env[key]);
  process.env.MERRYMEN_SPONSOR_GAS = "1";
  process.env.MERRYMEN_BUNDLER_API_KEY = "test-key";
  process.env.MERRYMEN_SPONSORSHIP_POLICY_ID = "test-policy";
});
afterEach(() => envKeys.forEach((key, i) => {
  if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
}));

async function fixture() {
  const client = createPublicClient({ chain: robinhoodChain, transport: custom({
    async request({ method }) {
      if (method === "eth_chainId") return `0x${robinhoodChain.id.toString(16)}`;
      if (method === "eth_getCode") return "0x";
      throw new Error(`Unexpected RPC in owner signature fixture: ${method}`);
    },
  }) });
  const entryPoint = getEntryPoint("0.7");
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const account = await createKernelAccount(client, { address: ACCOUNT, entryPoint, kernelVersion: KERNEL_V3_3, plugins: { sudo } });
  const { factory, factoryData } = await account.getFactoryArgs();
  assert.ok(factory && factoryData);
  const ticket: Ticket = {
    smartAccount: ACCOUNT, chainId: robinhoodChain.id, classVaults: [], exp: Date.now() + 10000,
    sponsorship: { owner: owner.address, factory, factoryData, accounts: [ACCOUNT] },
  };
  const operation = {
    sender: ACCOUNT, nonce: 0n, factory, factoryData,
    callData: await account.encodeCalls([{ to: ACCOUNT, value: 0n, data: DATA }]),
    callGasLimit: 100_000n, verificationGasLimit: 100_000n, preVerificationGas: 50_000n,
    maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 1_000_000n,
    paymaster: OTHER, paymasterData: "0x1234" as Hex,
    paymasterVerificationGasLimit: 200_000n, paymasterPostOpGasLimit: 100_000n,
    signature: "0x" as Hex,
  };
  const signature = await account.signUserOperation(operation);
  const op = formatUserOperationRequest({ ...operation, signature });
  return { ticket, op, account };
}

describe("house sponsorship of owner operations", () => {
  it("verifies the real pinned Kernel sudo SDK signature and binds every final field", async () => {
    const { ticket, op, account } = await fixture();
    assert.equal(op.signature?.length, 132);
    assert.equal(sponsoredOperationProblem(op, ticket, true), null);
    assert.equal(await ownerSignatureValid(op, ticket), true);
    for (const patch of [
      { callData: `${DATA.slice(0, -1)}3` }, { nonce: "0x1" }, { maxFeePerGas: "0x1" },
      { paymasterData: "0x4321" }, { factoryData: "0x1234" }, { sender: OTHER },
      { signature: "0x" }, { signature: await account.getStubSignature(op as never) },
    ]) assert.equal(await ownerSignatureValid({ ...op, ...patch }, ticket), false);
    assert.equal(await ownerSignatureValid(op, { ...ticket, chainId: 46630 }), false);
    assert.equal(await ownerSignatureValid(op, { ...ticket, sponsorship: { ...ticket.sponsorship!, owner: OTHER } }), false);
  });

  it("retains killed/superseded history and allows the server-derived migration family only", async () => {
    const { ticket } = await fixture();
    const history = async () => [{ accounts: [OTHER, ACCOUNT] } as PublicIdentity];
    assert.equal((await ownerSponsorshipStatus(ticket, history)).gasSponsored, true);
    const destination = { ...ticket, smartAccount: OTHER, sponsorship: { ...ticket.sponsorship!, accounts: [OTHER, ACCOUNT] } };
    assert.equal((await ownerSponsorshipStatus(destination, history)).gasSponsored, true);
    assert.equal((await ownerSponsorshipStatus(ticket, async () => [])).gasSponsored, false);
    assert.equal((await ownerSponsorshipStatus(ticket, async () => { throw new Error("offline"); })).gasSponsored, false);
    assert.equal((await ownerSponsorshipStatus({ ...ticket, sponsorship: undefined }, history)).gasSponsored, false);
    delete process.env.MERRYMEN_SPONSORSHIP_POLICY_ID;
    const misconfigured = await ownerSponsorshipStatus(ticket, history);
    assert.equal(misconfigured.sponsorshipEnabled, true);
    assert.equal(misconfigured.gasSponsored, false);
    process.env.MERRYMEN_SPONSOR_GAS = "0";
    assert.equal((await ownerSponsorshipStatus(ticket, history)).sponsorshipEnabled, false);
  });

  it("accepts initial zero gas estimates but refuses final zeroes, changed factories and excessive spend", async () => {
    const { ticket, op } = await fixture();
    const zero = { ...op, callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0" };
    assert.equal(sponsoredOperationProblem(zero, ticket, false), null);
    assert.match(sponsoredOperationProblem(zero, ticket, true)!, /positive gas/);
    for (const patch of [
      { factory: OTHER }, { factoryData: "0x1234" }, { factoryData: undefined },
      { callGasLimit: "0x2dc6c1" }, { maxFeePerGas: "0x3b9aca01" },
      { paymasterPostOpGasLimit: "0x7a121" },
      { callGasLimit: "0x1e8480", maxFeePerGas: "0x3b9aca00" },
      { nonce: `0x01${"00".repeat(31)}` }, { authorization: {} }, { callGasLimit: "-1" },
    ]) assert.ok(sponsoredOperationProblem({ ...op, ...patch }, ticket, true), JSON.stringify(patch));
  });

  it("filters provider fields and never treats a stub as final sponsorship", () => {
    assert.deepEqual(paymasterResult({ paymaster: OTHER, paymasterData: "0x1234", callData: "0x1234", callGasLimit: "0xffff", isFinal: true }, true), {
      paymaster: OTHER, paymasterData: "0x1234", isFinal: false,
    });
    assert.equal(paymasterResult({ paymaster: OTHER, paymasterData: "0x", paymasterVerificationGasLimit: "0x7a121" }, false), null);
  });
});
