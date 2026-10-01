import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex, type LocalAccount } from "viem";
import { signerGrant, TEST_CAPS, withStubChain, type KernelState } from "./canonical-wall-fixture";

const ACCOUNT = "0x000000000000000000000000000000000000a110" as const;
const ownerKey = `0x${"17".repeat(32)}` as Hex;

function signingOwner() {
  const original = privateKeyToAccount(ownerKey);
  const signed: { data: Parameters<LocalAccount["signTypedData"]>[0]; signature: Hex }[] = [];
  const owner: LocalAccount = {
    ...original,
    async signTypedData(data) {
      const signature = await original.signTypedData(data);
      signed.push({ data: data as Parameters<LocalAccount["signTypedData"]>[0], signature });
      return signature;
    },
  };
  return { owner, signed };
}

describe("permission signing after nonce revocation", () => {
  it("seals the verified current generation in the real SDK owner signature", async () => {
    for (const [currentNonce, installedNonce, expected] of [[8, 0, 8], [8, 8, 9], [0, 0, 1]]) {
      const { owner, signed } = signingOwner();
      const { grant } = await signerGrant({ account: ACCOUNT, owner, kernel: { currentNonce, installedNonce } });
      assert.equal(signed.length, 1);
      assert.equal(signed[0]!.data.primaryType, "Enable");
      assert.equal((signed[0]!.data.message as { nonce: number }).nonce, expected);
      const serialized = JSON.parse(Buffer.from(grant.serialized, "base64").toString("utf8")) as { enableSignature: Hex };
      assert.equal(serialized.enableSignature, signed[0]!.signature, "serialization must not re-read a fallback nonce and replace this signature");
      assert.equal(await verifyTypedData({ ...signed[0]!.data, address: owner.address, signature: serialized.enableSignature }), true);
    }
  });

  it("refuses unreadable code, nonce, or installed generation before the owner enables anything", async () => {
    const states: KernelState[] = [
      { currentNonce: "unreadable" },
      { currentNonce: 8, installedNonce: "unreadable" },
      { currentNonce: 8, unreadableCode: true },
      { currentNonce: 8, installedNonce: 9 },
      { currentNonce: 0xffff_ffff, installedNonce: 0xffff_ffff },
    ];
    for (const kernel of states) {
      const { owner, signed } = signingOwner();
      await assert.rejects(signerGrant({ account: ACCOUNT, owner, kernel }));
      assert.equal(signed.length, 0, "network uncertainty must not silently sign the SDK's nonce-1 fallback");
    }
  });

  it("still supports a provably undeployed account's first generation", async () => {
    const { owner, signed } = signingOwner();
    await signerGrant({ account: ACCOUNT, owner });
    assert.equal(signed.length, 1);
    assert.equal((signed[0]!.data.message as { nonce: number }).nonce, 1);
  });

  it("does not replace a different wallet saved while owner approval is pending", async () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const values = new Map<string, string>([["merrymen.grant.v1", "older wallet"]]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    let approve!: () => void;
    let signing!: () => void;
    const approval = new Promise<void>(resolve => { approve = resolve; });
    const signingStarted = new Promise<void>(resolve => { signing = resolve; });
    const original = privateKeyToAccount(ownerKey);
    const owner: LocalAccount = { ...original, async signTypedData(data) {
      signing();
      await approval;
      return original.signTypedData(data);
    } };
    let posts = 0;
    try {
      const { createPrivyOwnedWallet } = await import("./session");
      await withStubChain(ACCOUNT, async () => {
        const rpcFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
          if (String(url) === "/api/grants") { posts++; throw new Error("unexpected handoff"); }
          return rpcFetch(url, init);
        };
        const pending = createPrivyOwnedWallet(owner, "did:privy:test-owner", { chainId: 4663, caps: TEST_CAPS, onStatus: () => {} });
        await signingStarted;
        const newer = JSON.stringify({ smartAccount: "newer account", opaque: "a different tab's exact grant" });
        values.set("merrymen.grant.v1", newer);
        approve();
        await assert.rejects(pending, /saved wallet changed while signing/);
        assert.equal(values.get("merrymen.grant.v1"), newer);
        assert.equal(posts, 0, "a stale signing attempt must not reach server handoff");
        assert.equal(values.size, 1, "the newer wallet must not be archived or rewritten either");
      });
    } finally {
      approve();
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
