/**
 * THE ESCAPE HATCH FOR ASSETS THAT LIVE IN A CONTRACT.
 *
 * `PonsClassVault.sweep` says it "is what `merrymen recover` uses". Until this
 * module that was a claim about code which did not exist. These tests are the
 * three ways that claim can quietly stay false: the vault is not found, the
 * contents are not found, or a failed read is reported as an empty account.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findClassVault, planClassSweep, readClassHoldings } from "./class-recovery";

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const VAULT = "0x00000000000000000000000000000000000000c0" as const;
const OTHER_VAULT = "0x00000000000000000000000000000000000000c1" as const;
const FACTORY = "0x00000000000000000000000000000000000000fa" as const;
const PEPE = "0x0000000000000000000000000000000000000ee0" as const;
const WIF = "0x0000000000000000000000000000000000000ee1" as const;

const classGrant = {
  grantFeatures: ["pons-class"],
  ponsClassVaultAddress: VAULT,
  ponsClassVaultFactoryAddress: FACTORY,
};

/** A client whose reads are scripted per (address, functionName). */
const client = (answers: Record<string, unknown | Error>) => ({
  readContract: async (p: { address: string; functionName: string; args?: readonly unknown[] }) => {
    const key = `${p.functionName}:${p.address.toLowerCase()}`;
    const a = answers[key] ?? answers[p.functionName];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`unscripted read ${key}`);
    return a;
  },
});

describe("finding the vault", () => {
  it("uses the sealed address when a grant is in hand", async () => {
    const v = await findClassVault({
      client: client({ vaultFor: VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: classGrant,
    });
    assert.deepEqual(v, { kind: "found", vault: VAULT, source: "grant" });
  });

  it("says NONE when there is no marker and no factory for the chain", async () => {
    // The ordinary case, and it must cost nothing: no read, no warning, no
    // "unreadable" that would hold up a perfectly good recovery.
    const v = await findClassVault({
      client: client({}) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["tradeable-v2"] },
    });
    assert.equal(v.kind, "none");
  });

  it("REFUSES when the grant and the factory disagree", async () => {
    // One of them holds the position. Sweeping the other is a no-op reported as
    // a success — the exact shape of failure this whole path exists to prevent.
    const v = await findClassVault({
      client: client({ vaultFor: OTHER_VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: classGrant,
    });
    assert.equal(v.kind, "conflict");
    assert.match(v.kind === "conflict" ? v.why : "", /refuses rather than guessing/);
  });

  it("a failed factory read with NO grant is unreadable, never `none`", async () => {
    // An owner whose RPC blinked must not be told their class book is empty.
    const v = await findClassVault({
      client: client({ vaultFor: new Error("rpc down") }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["pons-class"], ponsClassVaultFactoryAddress: FACTORY },
    });
    assert.equal(v.kind, "unreadable");
  });

  it("but a failed factory read with a SEALED vault still recovers", async () => {
    // The grant is the authority; the derivation is a cross-check. Losing the
    // cross-check must not lose the recovery.
    const v = await findClassVault({
      client: client({ vaultFor: new Error("rpc down") }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: classGrant,
    });
    assert.deepEqual(v, { kind: "found", vault: VAULT, source: "grant" });
  });

  it("a zero answer from the factory is not an address", async () => {
    // What a call to a contract that isn't there decodes to on some transports.
    const v = await findClassVault({
      client: client({ vaultFor: "0x0000000000000000000000000000000000000000" }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["pons-class"], ponsClassVaultFactoryAddress: FACTORY },
    });
    assert.equal(v.kind, "none");
  });
});

describe("finding the contents", () => {
  const candidates = [
    { token: PEPE, symbol: "PEPE" },
    { token: WIF, symbol: "WIF" },
  ] as const;

  it("only a non-zero on-chain balance is a holding", async () => {
    // A local row is a token to ASK about. It may have been sold, swept, or
    // written by a worker whose database was since rebuilt.
    const c = await readClassHoldings({
      client: client({ [`balanceOf:${PEPE}`]: 5n, [`balanceOf:${WIF}`]: 0n }) as never,
      vault: VAULT,
      candidates,
    });
    assert.equal(c.kind, "read");
    assert.deepEqual(c.holdings.map((h) => h.symbol), ["PEPE"]);
  });

  it("a failed balance read makes the list PARTIAL, not shorter", async () => {
    const c = await readClassHoldings({
      client: client({ [`balanceOf:${PEPE}`]: 5n, [`balanceOf:${WIF}`]: new Error("rpc") }) as never,
      vault: VAULT,
      candidates,
    });
    assert.equal(c.kind, "partial");
    assert.deepEqual(c.holdings.map((h) => h.symbol), ["PEPE"]);
    assert.match(c.kind === "partial" ? c.why : "", /more here than this list shows/);
  });

  it("no candidates is an honest empty, not a gap", async () => {
    const c = await readClassHoldings({ client: client({}) as never, vault: VAULT, candidates: [] });
    assert.deepEqual(c, { kind: "read", holdings: [] });
  });
});

describe("planning the sweep", () => {
  it("drops zero balances BEFORE the batch is built", async () => {
    // `sweep` reverts ZeroAmount() on an empty balance and the sweep batch is
    // atomic, so one empty token would revert the whole thing. Unlike
    // recover.ts's per-token simulation, failing open here fails the batch
    // rather than one leg — which is why the filter is upstream of the build.
    const plan = planClassSweep([
      { token: PEPE, symbol: "PEPE", raw: 5n },
      { token: WIF, symbol: "WIF", raw: 0n },
    ]);
    assert.deepEqual(plan.map((h) => h.symbol), ["PEPE"]);
  });

  it("an all-empty vault plans nothing rather than an empty batch", async () => {
    assert.deepEqual(planClassSweep([{ token: PEPE, symbol: "PEPE", raw: 0n }]), []);
  });
});
