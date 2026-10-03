import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareUserOperation } from "viem/account-abstraction";
import { toKernelPluginManager } from "@zerodev/sdk/accounts";
import { getAccountNonce } from "@zerodev/sdk/actions";
import { GasRefused, isFirstEnable, prepareCheckedUserOperation, readEnableState } from "./executor";

const ENABLE = (1n << 248n) | (2n << 240n) | (0x12345678n << 208n);
const DEFAULT = ENABLE & ~(0xffn << 248n);
const ME = "0x1111111111111111111111111111111111111111";

/** Actual viem preparation, with a local account whose on-chain mode can advance. */
function accountAt(initial: bigint) {
  let current = initial;
  let reads = 0;
  const account = {
    address: ME, type: "smart", entryPoint: { version: "0.7", address: ME },
    getNonce: async () => { reads++; return current; },
  };
  const client = { account, chain: { id: 4663 } };
  const prepare = async (nonce?: bigint) => prepareUserOperation(client as never, {
    callData: "0x", parameters: ["nonce"], ...(nonce === undefined ? {} : { nonce }),
  } as never) as Promise<{ nonce: bigint }>;
  return { account, prepare, advance: (nonce: bigint) => { current = nonce; }, reads: () => reads };
}

describe("the checked operation nonce survives preparation", () => {
  it("a prior enable landing cannot replace the checked install with a default operation", async () => {
    let installed = false;
    let nonceReads = 0;
    const entryPoint = { version: "0.7", address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" } as const;
    const chain = { readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "isInitialized") return false;
      if (functionName === "getNonce") return (args![1] as bigint) << 64n;
      throw new Error(`unexpected read: ${functionName}`);
    } };
    const manager = await toKernelPluginManager(chain as never, {
      regular: { address: "0x2222222222222222222222222222222222222222", validatorType: "PERMISSION",
        supportedKernelVersions: ">=0.3.0", getIdentifier: () => "0x12345678", getNonceKey: async () => 0n,
        isEnabled: async () => installed } as never,
      entryPoint, kernelVersion: "0.3.3", pluginEnableSignature: "0x12",
    });
    const account = { address: ME, type: "local", entryPoint, getNonce: async () => {
      nonceReads++;
      return getAccountNonce(chain as never, { address: ME, entryPointAddress: entryPoint.address,
        key: await manager.getNonceKey(ME) });
    } };
    const prepare = async (nonce?: bigint) => prepareUserOperation({ account, chain: { id: 4663 } } as never, {
      callData: "0x", parameters: ["nonce"], ...(nonce === undefined ? {} : { nonce }),
    } as never) as Promise<{ nonce: bigint }>;
    const checked = await account.getNonce();
    assert.equal(isFirstEnable(checked), true);
    assert.equal((await readEnableState({ getCode: async () => "0x", call: async () => {
      throw new Error("an undeployed account needs no permission-config read");
    } }, ME, checked)).kind, "fresh-enable");
    installed = true;
    // The real Kernel plugin manager now chooses DEFAULT. Unpinned viem
    // preparation asks it again and changes the operation after the gate.
    const unpinned = await prepare();
    assert.equal(isFirstEnable(unpinned.nonce), false);
    const pinned = await prepareCheckedUserOperation(checked, prepare);
    assert.equal(pinned.nonce, checked);
    assert.equal(isFirstEnable(pinned.nonce), true);
    assert.equal(nonceReads, 2, "pinned preparation must not ask for a newer nonce");
  });

  it("a sequence advancing while estimates run cannot silently prepare the next operation", async () => {
    const a = accountAt(DEFAULT | 4n);
    const checked = await a.account.getNonce();
    a.advance(DEFAULT | 5n);
    const pinned = await prepareCheckedUserOperation(checked, a.prepare);
    assert.equal(pinned.nonce, DEFAULT | 4n);
    assert.equal(a.reads(), 1);
  });

  it("a valid ordinary operation retains the same nonce and compatible preparation", async () => {
    const a = accountAt(DEFAULT | 9n);
    const checked = await a.account.getNonce();
    const prepared = await prepareCheckedUserOperation(checked, a.prepare);
    assert.equal(prepared.nonce, checked);
    assert.equal(isFirstEnable(prepared.nonce), false);
    assert.equal(a.reads(), 1);
  });

  it("a changed or malformed prepared nonce refuses before any signature, persistence or broadcast", async () => {
    for (const nonce of [DEFAULT, ENABLE | 1n, undefined, null, "123", 123]) {
      let signs = 0;
      let persists = 0;
      let broadcasts = 0;
      await assert.rejects(async () => {
        await prepareCheckedUserOperation(ENABLE, async (checked) => {
          assert.equal(checked, ENABLE);
          return { nonce };
        });
        signs++;
        persists++;
        broadcasts++;
      }, (error: unknown) => error instanceof GasRefused && error.rule === "nonce-changed");
      assert.equal(signs, 0);
      assert.equal(persists, 0);
      assert.equal(broadcasts, 0);
    }
  });
});
