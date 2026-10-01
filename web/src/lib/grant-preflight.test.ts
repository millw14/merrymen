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

  it("rejects the exact synthetic 27-permission wall after adding v4", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const extraTokens = Array.from({ length: 3 }, (_, i) => ({
      symbol: `TEST${i}`, address: `0x${(100 + i).toString(16).padStart(40, "0")}` as Hex, decimals: 18,
    }));
    const original = wallShape(buildCallPermissions(TEST_CAPS, ACCOUNT, {
      extraTokens, ponsClassVaultAddress: CLASS_VAULT, ponsClassVaultFactoryAddress: CLASS_FACTORY,
      trencherVaultAddress: TRENCHER_VAULT, trencherFactoryAddress: TRENCHER_FACTORY,
    }));
    assert.equal(original.permissions, 27);
    assert.equal(firstEnableEnvelope(original, { deploying: false }).expectedBounded, 13_734_820n);
    await withStubChain(ACCOUNT, async () => {
      await assert.rejects(preflightAgentGrant(signer.owner, {
        ...options, extraTokens, trencherFactory: TRENCHER_FACTORY, v4AdapterAddress: V4_ADAPTER,
      }), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /15,749,392 gas against a limit of 14,000,000/);
        assert.match(error.message, /Remove at least 3 custom tokens/);
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
