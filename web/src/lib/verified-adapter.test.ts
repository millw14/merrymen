import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { PONS_SELF_TRADE } from "@merrymen/core";

const SUPPORTED = PONS_SELF_TRADE[4663] as `0x${string}`;
const ARBITRARY = "0x1111111111111111111111111111111111111111" as const;
let verifiedAdapter: typeof import("./verified-adapter").verifiedAdapter;
let clients: number;
let probes: number;
let statuses: string[];
let rpc: {
  getChainId(): Promise<number>;
  getCode(): Promise<string | undefined>;
  readContract(): Promise<never>;
};

before(() => {
  const modulePath = fileURLToPath(new URL("./verified-adapter.ts", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const original = loader._load;
  const intercept = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === modulePath && id === "viem") {
      return { createPublicClient: () => { clients++; return rpc; }, http: () => ({}) };
    }
    return original.call(this, id, parent, isMain);
  });
  try { ({ verifiedAdapter } = createRequire(import.meta.url)(modulePath)); }
  finally { intercept.mock.restore(); }
});

beforeEach(() => {
  clients = 0;
  probes = 0;
  statuses = [];
  rpc = {
    getChainId: async () => 4663,
    getCode: async () => "0x60006000fd",
    // The old probe accepted a contract with only a reverting fallback.
    readContract: async () => { probes++; throw new Error("execution reverted"); },
  };
});

const status = (message: string) => { statuses.push(message); };

describe("the browser's curve-adapter signing boundary", () => {
  it("keeps the optional capability absent without choosing a default spender", async () => {
    assert.equal(await verifiedAdapter(undefined, 4663, status), undefined);
    assert.equal(clients, 0);
  });

  it("refuses an arbitrary reverting fallback before it can be returned to the grant builder", async () => {
    await assert.rejects(verifiedAdapter(ARBITRARY, 4663, status), /not a supported deployment/);
    assert.equal(clients, 0, "untrusted addresses cannot earn approval through RPC-shaped evidence");
    assert.equal(probes, 0);
    assert.deepEqual(statuses, []);
  });

  it("allows only the selected supported address on its recorded network", async () => {
    assert.equal(await verifiedAdapter(SUPPORTED.toUpperCase().replace("0X", "0x") as `0x${string}`, 4663, status), SUPPORTED);
    assert.equal(clients, 1);
    assert.equal(probes, 0, "a deliberately reverted call is not used as contract identity proof");
    assert.match(statuses.at(-1)!, /deployment checked/);
    for (const chain of [46630, 1]) await assert.rejects(verifiedAdapter(SUPPORTED, chain, status), /not a supported deployment/);
  });

  it("refuses the wrong RPC network, missing code, and unreadable RPC responses", async () => {
    rpc.getChainId = async () => 46630;
    await assert.rejects(verifiedAdapter(SUPPORTED, 4663, status), /different network/);
    rpc.getChainId = async () => 4663;
    for (const code of [undefined, "0x", "invalid", "0x6"]) {
      rpc.getCode = async () => code;
      await assert.rejects(verifiedAdapter(SUPPORTED, 4663, status), /No readable contract code/);
    }
    rpc.getCode = async () => { throw new Error("RPC timeout"); };
    await assert.rejects(verifiedAdapter(SUPPORTED, 4663, status), /RPC timeout/);
    rpc.getChainId = async () => { throw new Error("RPC unavailable"); };
    await assert.rejects(verifiedAdapter(SUPPORTED, 4663, status), /RPC unavailable/);
  });
});
