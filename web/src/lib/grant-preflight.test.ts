import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex, type LocalAccount } from "viem";
import { buildCallPermissions, firstEnableEnvelope, wallShape } from "@merrymen/core";
import {
  CLASS_FACTORY, CLASS_VAULT, TRENCHER_FACTORY, TRENCHER_VAULT,
  TEST_CAPS, withStubChain, type KernelState,
} from "./canonical-wall-fixture";

const ACCOUNT = "0x000000000000000000000000000000000000a110" as const;
const V4_ADAPTER = "0xe0ce6bd81a472f021a9e85392a8008b8786f9218" as const;
const ownerKey = `0x${"17".repeat(32)}` as Hex;
const options = { caps: TEST_CAPS, chainId: 4663, expectAccount: ACCOUNT, onStatus: () => {} };

function ownerThatMustNotSign() {
  let calls = 0;
  const refuse = async (): Promise<never> => { calls++; throw new Error("preflight requested an owner signature"); };
  const owner: LocalAccount = {
    ...privateKeyToAccount(ownerKey),
    signMessage: refuse,
    signTypedData: refuse,
    signTransaction: refuse,
  };
  return { owner, calls: () => calls };
}

describe("read-only grant renewal preflight", () => {
  it("checks the real SDK wall without signing, storage, auth, handoff or a nonce read", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let storageCalls = 0;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() {
      storageCalls++;
      throw new Error("preflight touched browser storage");
    } });
    try {
      // All app fetches are rejected by the fixture. An unreadable nonce must
      // not matter: preflight is not allowed to prepare an enable signature.
      const result = await withStubChain(ACCOUNT, () => preflightAgentGrant(signer.owner, options), {
        currentNonce: "unreadable", installedNonce: "unreadable",
      });
      assert.equal(result, undefined, "no cached grant or signature crosses revocation");
      assert.equal(signer.calls(), 0);
      assert.equal(storageCalls, 0);
    } finally {
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("admits the 27-permission wall with v4 added — the owner who could not have all of it", async () => {
    // Class + Trencher + three coins, plus the v4 adapter: 15,749,392 bounded
    // unscoped, and this test used to pin the refusal ("Remove at least 3
    // custom tokens"). Each spender is now named only on the tokens it pulls
    // (WallOptions.scopedSpenders), and the same wall fits.
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const extraTokens = Array.from({ length: 3 }, (_, i) => ({
      symbol: `TEST${i}`, address: `0x${(100 + i).toString(16).padStart(40, "0")}` as Hex, decimals: 18,
    }));
    const wall = (scopedSpenders: boolean) => wallShape(buildCallPermissions(TEST_CAPS, ACCOUNT, {
      extraTokens, ponsClassVaultAddress: CLASS_VAULT, ponsClassVaultFactoryAddress: CLASS_FACTORY,
      trencherVaultAddress: TRENCHER_VAULT, trencherFactoryAddress: TRENCHER_FACTORY,
      v4AdapterAddress: V4_ADAPTER, scopedSpenders,
    }));
    assert.equal(wall(false).permissions, 28);
    assert.equal(firstEnableEnvelope(wall(false), { deploying: false }).expectedBounded, 15_749_392n, "refused before");
    assert.equal(firstEnableEnvelope(wall(true), { deploying: false }).expectedBounded, 13_110_586n, "fits now");
    await withStubChain(ACCOUNT, async () => {
      const result = await preflightAgentGrant(signer.owner, {
        ...options, extraTokens, trencherFactory: TRENCHER_FACTORY, v4AdapterAddress: V4_ADAPTER,
      });
      assert.equal(result, undefined);
    }, { currentNonce: 8 });
    assert.equal(signer.calls(), 0);
  });

  it("still refuses a wall past the maximum, and says how many coins fit", async () => {
    // The 14M ceiling did not move; the wall got smaller. Six coins beside
    // class + Trencher + v4 is still over it, and the owner is told the number.
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const extraTokens = Array.from({ length: 6 }, (_, i) => ({
      symbol: `TEST${i}`, address: `0x${(100 + i).toString(16).padStart(40, "0")}` as Hex, decimals: 18,
    }));
    await withStubChain(ACCOUNT, async () => {
      await assert.rejects(preflightAgentGrant(signer.owner, {
        ...options, extraTokens, trencherFactory: TRENCHER_FACTORY, v4AdapterAddress: V4_ADAPTER,
      }), error => {
        assert.ok(error instanceof Error);
        // The 14,000,000 maximum, less room for the operation that installs
        // the key (core first-enable-gas.ts KEY_INSTALL_RESERVE_BOUNDED).
        assert.match(error.message, /against a limit of 13,850,000 \(14,000,000, less room for the operation that installs it\)/);
        assert.match(error.message, /the most that fits with the features you have enabled is 4\. Remove at least 2 custom tokens/);
        return true;
      });
    }, { currentNonce: 8 });
    assert.equal(signer.calls(), 0);
  });

  it("refuses a different derived owner account before asking for a signature", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    await withStubChain(ACCOUNT, () => assert.rejects(preflightAgentGrant(signer.owner, {
      ...options, expectAccount: "0x000000000000000000000000000000000000b110",
    }), /refusing to sign: this owner derives/));
    assert.equal(signer.calls(), 0);
  });

  it("refuses a missing or mismatched v4 deployment before any owner signature", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    for (const state of [
      { currentNonce: 8, v4Code: "0x" },
      { currentNonce: 8, v4Code: "unreadable" },
      { currentNonce: 8, v4PoolManager: ACCOUNT },
      { currentNonce: 8, v4PoolManager: "unreadable" },
    ] satisfies KernelState[]) {
      await withStubChain(ACCOUNT, () => assert.rejects(preflightAgentGrant(signer.owner, {
        ...options, v4AdapterAddress: V4_ADAPTER,
      }), /Could not check Uniswap v4.*Nothing was signed/s), state);
    }
    assert.equal(signer.calls(), 0);
  });

  it("signs only the fresh generation after preflight and confirmed revocation", async () => {
    const { preflightAgentGrant, prepareAgentGrant } = await import("./session");
    const original = privateKeyToAccount(ownerKey);
    const signed: { nonce: number; signature: Hex }[] = [];
    const owner: LocalAccount = { ...original, async signTypedData(data) {
      const signature = await original.signTypedData(data);
      signed.push({ nonce: (data.message as { nonce: number }).nonce, signature });
      return signature;
    } };
    const kernel: KernelState = { currentNonce: 8, installedNonce: 0 };
    await withStubChain(ACCOUNT, async () => {
      await preflightAgentGrant(owner, options);
      assert.equal(signed.length, 0);
      // Model the already-confirmed invalidateNonce receipt, then invoke the
      // real signer afresh. No account/signature from preflight is reused.
      kernel.currentNonce = 9;
      const grant = await prepareAgentGrant(owner, options);
      assert.equal(signed.length, 1);
      assert.equal(signed[0]!.nonce, 9);
      const serialized = JSON.parse(Buffer.from(grant.serialized, "base64").toString("utf8"));
      assert.equal(serialized.enableSignature, signed[0]!.signature);
    }, kernel);
  });
});
