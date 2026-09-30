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
import { formatUnits } from "viem";
import { classSweepCandidates, findClassVault, findClassVaults, planClassSweep, readClassHoldings } from "./class-recovery";
import { PONS_CLASS_VAULT_FACTORY, PONS_CLASS_VAULT_FACTORY_V2 } from "../../packages/core/src/index";

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
    //
    // TESTNET, not 4663, and the switch is the point rather than a workaround.
    // This asked 4663 and passed only because PONS_CLASS_VAULT_FACTORY[4663]
    // was null — so it was pinning a DEPLOYMENT STATE, and it broke the moment
    // the factory was deployed, which is not a regression in anything. The
    // property under test is "no marker AND no factory for this chain yields
    // none", and expressing it needs a chain that genuinely has no factory.
    // 46630 is that chain today; if it is ever deployed there, this should move
    // again rather than be loosened.
    const v = await findClassVault({
      client: client({}) as never,
      chainId: 46630,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["tradeable-v2"] },
    });
    assert.equal(v.kind, "none");
  });

  it("uses the deployed factory on a chain that HAS one, rather than saying none", async () => {
    // The other side of the switch above, and the reason it is safe to make.
    // With a factory constant present, a grant carrying no class marker must
    // still resolve through the factory — that is what lets `merrymen recover`
    // reach a vault when the grant is archived or absent. Saying "none" here
    // would strand a real position.
    const v = await findClassVault({
      client: client({ vaultFor: VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["tradeable-v2"] },
    });
    assert.equal(v.kind, "found");
    assert.equal(v.kind === "found" ? v.vault : null, VAULT);
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

/**
 * THE ASSET THE LOGS CANNOT NAME.
 *
 * `ClassBuy`/`ClassSell`/`Swept` carry the class token and the quote only as an
 * AMOUNT — the quote asset's address is in no event this contract emits. So a
 * candidate list built from logs alone can never contain USDG, and a vault
 * holding stranded quote enumerates as holding only its class tokens. That is
 * what an owner is shown, and the sweep moves exactly what was shown.
 *
 * Measured on mainnet: Shogun's vault holds 1,063,408.141815 DOGGOS and
 * 5.785344 USDG. Only the DOGGOS was ever disclosed.
 */
describe("what to ask the vault about", () => {
  const REGISTRY = [
    { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG" },
    { address: "0x0000000000000000000000000000000000000ee1", symbol: "WIF" },
  ];

  it("INCLUDES THE QUOTE ASSET, which appears in no log event", () => {
    const out = classSweepCandidates([PEPE], REGISTRY);
    const usdg = out.find((c) => c.symbol === "USDG");
    assert.ok(usdg, "a vault holding stranded USDG would otherwise enumerate as holding none");
    assert.equal(usdg.token, "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  it("keeps the log-derived token, which the registry cannot name", () => {
    const out = classSweepCandidates([PEPE], REGISTRY);
    const pepe = out.find((c) => c.token === PEPE);
    assert.ok(pepe, "the class token is the one the vault was built to hold");
    // A launch token is not in the registry, so the short address is the only
    // name available — better than omitting it.
    assert.match(pepe.symbol, /^0x[0-9a-f]{8}…$/);
  });

  it("and log tokens come first, so a registry entry cannot rename one", () => {
    const out = classSweepCandidates([WIF], REGISTRY);
    const wif = out.filter((c) => c.token.toLowerCase() === WIF.toLowerCase());
    assert.equal(wif.length, 1, "a token in both lists is asked about once");
    assert.match(wif[0]!.symbol, /…$/, "the log entry wins");
  });

  it("dedupes case-insensitively, because addresses arrive in both cases", () => {
    const out = classSweepCandidates(
      [PEPE, PEPE.toUpperCase() as `0x${string}`],
      [{ address: PEPE.toUpperCase(), symbol: "PEPE" }],
    );
    assert.equal(out.filter((c) => c.token.toLowerCase() === PEPE.toLowerCase()).length, 1);
  });

  it("and an empty vault history still asks about the registry", () => {
    // The case that matters after a rebuild: no logs in the window, but the
    // vault may still hold quote. An empty answer here would be a false "empty".
    const out = classSweepCandidates([], REGISTRY);
    assert.equal(out.length, 2);
  });
});

/**
 * THE AMOUNT AN OWNER READS BEFORE THEY SIGN.
 *
 * `planRecovery` formatted every class holding at 18dp — correct while a vault
 * could only hold Pons launch tokens, and wrong the moment the enumeration also
 * asked about the quote asset. USDG is 6dp, so Shogun's real 5.785344 USDG was
 * shown as 0.000000000005785344 USDG: the right money, misstated by twelve
 * orders of magnitude, on the screen where the decision is made.
 *
 * The sweep was never affected — `sweep(token)` takes no amount and moves the
 * whole balance — which is precisely what made it dangerous. A disclosure
 * defect with no execution symptom is one nothing downstream can catch.
 */
describe("a holding is formatted at its own decimals", () => {
  const USDG_ADDR = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

  it("CARRIES THE REGISTRY'S DECIMALS, not the launchpad's", () => {
    const out = classSweepCandidates([PEPE], [{ address: USDG_ADDR, symbol: "USDG", decimals: 6 }]);
    const usdg = out.find((c) => c.symbol === "USDG");
    assert.equal(usdg?.decimals, 6, "6dp, or 5.785344 USDG reads as 0.000000000005785344");
  });

  it("and a log-derived launch token stays 18dp", () => {
    // Every Pons launch is 18 decimals, and a log-derived token is a launch by
    // construction — readClassLog reads the vault's own events and nothing else
    // writes them.
    const out = classSweepCandidates([PEPE], []);
    assert.equal(out.find((c) => c.token === PEPE)?.decimals, 18);
  });

  it("formats the real Shogun figures correctly", () => {
    // The exact numbers from the vault, so this test fails if either side of
    // the pairing regresses.
    assert.equal(formatUnits(5_785_344n, 6), "5.785344");
    assert.equal(
      formatUnits(1_063_408_141_815_259_059_579_834n, 18),
      "1063408.141815259059579834",
    );
  });

  it("and the sweep does not require decimals at all", () => {
    // planClassSweep builds calls; decimals are a display concern. Requiring
    // them there would make every caller carry a number the sweep never reads —
    // and that pressure is what produced the hard-coded 18 in the first place.
    const kept = planClassSweep([{ token: PEPE, symbol: "PEPE", raw: 5n }]);
    assert.equal(kept.length, 1);
  });
});

/**
 * TWO VAULT VERSIONS, AND RECOVERY IS THE ONLY PATH THAT MUST SEE BOTH.
 *
 * `findClassVault` answers with ONE address, grant first, which is right for
 * signing and for the executor: there is one sealed vault and one wall. Recovery
 * is the opposite problem. It runs from a pasted owner key with no grant at all,
 * and the moment two factory versions exist, one address is a guess.
 *
 * The timing is what makes it urgent rather than tidy. When an owner re-signs
 * onto v2, their v1 vault stops being reachable by the session key — recovery
 * becomes the only way left to whatever is still sitting in it. A recovery that
 * looks in one place reports "nothing found" over a real balance, and that false
 * negative is the failure this whole module exists to prevent.
 */
describe("finding every vault an account could have, not the best one", () => {
  /**
   * THE FACTORIES THIS CHAIN ACTUALLY PINS, read from the constants rather than
   * pasted.
   *
   * These tests used to hard-code v1's address and script only that, which was
   * correct exactly while v2 was null — and it broke the moment the v2 factory
   * was deployed and pinned, because the finder then asked an address the fake
   * client had never been told about. A test that encodes a snapshot of a
   * constant fails when the constant does its job.
   *
   * Reading the table instead means these stay true on the day a testnet factory
   * appears too, and it makes the point of the suite literal: whatever this chain
   * pins, recovery must ask ALL of it.
   */
  const PINNED = [PONS_CLASS_VAULT_FACTORY_V2[4663], PONS_CLASS_VAULT_FACTORY[4663]].filter(
    (f): f is string => typeof f === "string",
  );
  const V1_FACTORY = PONS_CLASS_VAULT_FACTORY[4663]!;
  const V1_VAULT = "0x00000000000000000000000000000000000000d1" as const;
  const V2_VAULT = "0x00000000000000000000000000000000000000d2" as const;
  /** One scripted answer per pinned factory, so nothing is an unscripted read. */
  const allPinned = (answers: Record<string, unknown>) =>
    client({ ...Object.fromEntries(PINNED.map((f, i) => [`vaultFor:${f}`, i === 0 ? V2_VAULT : V1_VAULT])), ...answers });

  it("with no grant, EVERY pinned factory is asked", async () => {
    // The regression guard for every owner recovering today, and the reason the
    // plural finder exists: with no grant there is nothing to prefer, so asking
    // one factory is a guess and a guess is a false negative waiting to happen.
    const { candidates, unreadable } = await findClassVaults({
      client: allPinned({}) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: null,
    });
    assert.equal(candidates.length, PINNED.length, "every factory this chain pins must be asked");
    assert.deepEqual(unreadable, []);
    // v1 is deployed on mainnet and may still hold a position. It must be in
    // the list whatever else is, and it must be labelled.
    const v1 = candidates.find((c) => c.factory?.toLowerCase() === V1_FACTORY.toLowerCase());
    assert.ok(v1, "the deployed v1 factory must still be asked");
    assert.equal(v1!.vault, V1_VAULT.toLowerCase());
    assert.equal(v1!.version, 1, "and labelled, so a report can say which is which");
    for (const c of candidates) {
      assert.notEqual(c.version, null, "a pinned factory's version is known, never guessed");
    }
  });

  it("the grant's sealed vault is first and is never derived away", async () => {
    const { candidates } = await findClassVaults({
      client: allPinned({ [`vaultFor:${FACTORY}`]: VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: classGrant,
    });
    assert.equal(candidates[0]!.vault, VAULT.toLowerCase(), "the address the wall actually pinned leads");
    assert.equal(candidates[0]!.source, "grant");
    // And the chain's own factory is still asked, because a grant sealing one
    // vault says nothing about what a different factory holds for this account.
    assert.ok(
      candidates.some((c) => c.vault === V1_VAULT.toLowerCase()),
      "sealing a vault must not stop the search",
    );
  });

  it("A FAILED READ IS PER FACTORY — one blinking must not hide the other", async () => {
    // The collapse that would reintroduce the false negative: treating any
    // failure as "we could not ask" and reporting nothing.
    const { candidates, unreadable } = await findClassVaults({
      client: allPinned({ [`vaultFor:${FACTORY}`]: new Error("node refused") }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["pons-class"], ponsClassVaultAddress: undefined, ponsClassVaultFactoryAddress: FACTORY },
    });
    assert.equal(candidates.length, PINNED.length, "every factory that DID answer still yields its vault");
    assert.ok(
      candidates.some((c) => c.vault === V1_VAULT.toLowerCase()),
      "including v1, which is the one that may still hold a balance",
    );
    assert.equal(unreadable.length, 1, "and the one that refused is named rather than forgotten");
    assert.equal(unreadable[0]!.factory.toLowerCase(), FACTORY.toLowerCase());
  });

  it("one vault is listed once however many sources point at it", async () => {
    // A grant sealing exactly what its factory derives is the ordinary case, and
    // it must not produce two sweeps of one address.
    const { candidates } = await findClassVaults({
      client: client({ [`vaultFor:${FACTORY}`]: VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { ...classGrant, ponsClassVaultAddress: VAULT },
    });
    assert.equal(candidates.filter((c) => c.vault === VAULT.toLowerCase()).length, 1);
  });

  it("a factory answering the zero address yields NO candidate, never an address of nothing", async () => {
    const { candidates } = await findClassVaults({
      client: client(
        Object.fromEntries(PINNED.map((f) => [`vaultFor:${f}`, "0x0000000000000000000000000000000000000000"])),
      ) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: null,
    });
    assert.deepEqual(candidates, [], "sweeping a zero address reports success over an untouched book");
  });

  it("a vault from a factory in neither table is listed with an UNKNOWN version, not a guessed one", async () => {
    const { candidates } = await findClassVaults({
      client: client({ [`vaultFor:${FACTORY}`]: V2_VAULT }) as never,
      chainId: 4663,
      smartAccount: ACCOUNT,
      grant: { grantFeatures: ["pons-class"], ponsClassVaultAddress: undefined, ponsClassVaultFactoryAddress: FACTORY },
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.version, null, "we know the address, not the family");
  });

  it("no grant and no pinned factory for the chain finds nothing, and says nothing is not an error", async () => {
    const { candidates, unreadable } = await findClassVaults({
      client: client({}) as never,
      chainId: 46630,
      smartAccount: ACCOUNT,
      grant: null,
    });
    assert.deepEqual(candidates, []);
    assert.deepEqual(unreadable, [], "nothing to ask is not a failed ask");
  });
});
