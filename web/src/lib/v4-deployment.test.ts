import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Address, type PublicClient } from "viem";
import { UNISWAP, V4_SELF_SWAP } from "@merrymen/core";
import { assertV4Deployment } from "./v4-deployment";

const DEPLOYED = V4_SELF_SWAP[4663] as Address;
const CUSTOM = "0x1111111111111111111111111111111111111111" as const;
const status = () => {};

function fixture() {
  const reads: string[] = [];
  const rpc = {
    async getChainId() { reads.push("chain"); return 4663; },
    async getCode({ address }: { address: Address }): Promise<string | undefined> {
      reads.push(`code:${address.toLowerCase()}`);
      return "0x60006000fd";
    },
    async readContract({ address, functionName }: { address: Address; functionName: string }): Promise<Address> {
      reads.push(`${functionName}:${address.toLowerCase()}`);
      return UNISWAP.v4PoolManager;
    },
  };
  return { rpc, client: rpc as unknown as PublicClient, reads };
}

describe("v4 deployment checks at signing", () => {
  it("leaves an unselected capability absent without selecting a platform default", async () => {
    const f = fixture();
    await assertV4Deployment(f.client, undefined, 4663, status);
    assert.deepEqual(f.reads, []);
  });

  it("checks the selected deployment and the PoolManager the worker actually quotes", async () => {
    for (const selected of [DEPLOYED, CUSTOM]) {
      const f = fixture();
      const statuses: string[] = [];
      await assertV4Deployment(f.client, selected, 4663, message => statuses.push(message));
      assert.deepEqual(f.reads, [
        "chain", `code:${selected.toLowerCase()}`, `poolManager:${selected.toLowerCase()}`,
        `code:${UNISWAP.v4PoolManager.toLowerCase()}`,
      ]);
      assert.match(statuses.at(-1)!, /deployment checked/);
    }
  });

  it("refuses unsupported networks and malformed addresses before probing", async () => {
    const f = fixture();
    for (const chain of [46630, 1]) {
      await assert.rejects(assertV4Deployment(f.client, DEPLOYED, chain, status), /not available.*Nothing was signed/);
    }
    await assert.rejects(assertV4Deployment(f.client, "not-an-address" as Address, 4663, status), /not a valid contract address/);
    assert.deepEqual(f.reads, []);
  });

  it("refuses an RPC answering for a different chain before touching the adapter", async () => {
    const f = fixture();
    f.rpc.getChainId = async () => 46630;
    await assert.rejects(assertV4Deployment(f.client, DEPLOYED, 4663, status), /different network/);
    assert.deepEqual(f.reads, []);
  });

  it("refuses missing, empty and malformed adapter code without claiming it is granted", async () => {
    for (const code of [undefined, "0x", "invalid", "0x6", "0x00gg"]) {
      const f = fixture();
      f.rpc.getCode = async () => code;
      await assert.rejects(assertV4Deployment(f.client, DEPLOYED, 4663, status), /No readable contract code.*Nothing was signed/s);
      assert.deepEqual(f.reads, ["chain"]);
    }
  });

  it("refuses a different PoolManager, a missing PoolManager and an unreadable getter", async () => {
    const wrong = fixture();
    wrong.rpc.readContract = async () => CUSTOM;
    await assert.rejects(assertV4Deployment(wrong.client, DEPLOYED, 4663, status), /different PoolManager/);
    const absent = fixture();
    absent.rpc.getCode = async ({ address }) => address.toLowerCase() === UNISWAP.v4PoolManager ? "0x" : "0x6000";
    await assert.rejects(assertV4Deployment(absent.client, DEPLOYED, 4663, status), /PoolManager has no readable contract code/);
    const unreadable = fixture();
    unreadable.rpc.readContract = async () => { throw new Error("getter reverted"); };
    await assert.rejects(assertV4Deployment(unreadable.client, DEPLOYED, 4663, status), /getter reverted.*Nothing was signed/s);
  });

  it("preserves RPC errors as retryable verification failures", async () => {
    const f = fixture();
    f.rpc.getCode = async () => { throw new Error("RPC timeout"); };
    await assert.rejects(assertV4Deployment(f.client, DEPLOYED, 4663, status), /RPC timeout.*retry when this network can be verified/s);
  });
});
