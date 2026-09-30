import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toFunctionSelector } from "viem";

import {
  PONS_CLASS_VAULT_FACTORY_V2_ABI,
  probeClassFactory,
  type ClassFactoryReader,
} from "./classvault";

/**
 * TELLING A v1 FACTORY FROM A v2 ONE, WHICH NOTHING ELSE CAN DO.
 *
 * `vaultFor`, `deploy`, `buy`, `sell` and `sweep` have identical signatures in
 * both vault versions, so they have identical selectors. The wall a signer seals
 * is byte-identical either way. A v1 address pasted where a v2 was meant answers
 * `vaultFor` plausibly, returns a real deployed vault, pins a real target and
 * reports a successful re-sign — while the chain quietly enforces v1's single
 * global ceiling in raw units, ~250 for USDG and eight orders of magnitude wrong
 * for anything else.
 *
 * The shape that matters, and the one easy to get backwards: A REVERT IS AN
 * ANSWER. v1 declares no `FACTORY_VERSION` and has no fallback, so the read
 * throws — and that is what a v1 factory looks like, not a failure.
 */

const FACTORY = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;

/** A factory that answers exactly what it is told to, and throws for the rest. */
function fakeFactory(answers: { version?: unknown; seed?: unknown; seedThrows?: boolean }): ClassFactoryReader {
  return {
    async readContract({ functionName }) {
      if (functionName === "FACTORY_VERSION") {
        if (answers.version === undefined) throw new Error("execution reverted");
        return answers.version;
      }
      if (answers.seedThrows) throw new Error("execution reverted");
      return answers.seed;
    },
  };
}

describe("probing a class vault factory", () => {
  it("the version selector is what the contract actually exposes", () => {
    // Pinned so a rename in the .sol surfaces here rather than as every factory
    // silently reading as v1 — which is the direction that fails open.
    const item = PONS_CLASS_VAULT_FACTORY_V2_ABI.find((a) => a.name === "FACTORY_VERSION");
    assert.ok(item, "the ABI must carry the version read");
    assert.equal(toFunctionSelector(item), "0xbd382b40");
    const seed = PONS_CLASS_VAULT_FACTORY_V2_ABI.find((a) => a.name === "seedQuoteSet");
    assert.ok(seed);
    assert.equal(toFunctionSelector(seed), "0x20bdfa2f");
  });

  it("A REVERT MEANS v1, not a failure — the whole shape of the check", async () => {
    // The regression guard for every grant already signed on mainnet. v1 has no
    // such function, so treating the revert as an error would refuse to re-sign
    // the one factory that is actually deployed.
    const out = await probeClassFactory(fakeFactory({}), FACTORY);
    assert.equal(out.version, 1);
    assert.deepEqual(out.seedQuotes, []);
  });

  it("answering 2 and naming a seed is a v2 factory", async () => {
    const out = await probeClassFactory(
      fakeFactory({ version: 2, seed: [[USDG, NVDA], [250_000_000n, 10n ** 17n]] }),
      FACTORY,
    );
    assert.equal(out.version, 2);
    assert.deepEqual([...out.seedQuotes], [USDG, NVDA]);
    assert.deepEqual([...out.seedCaps], [250_000_000n, 10n ** 17n]);
  });

  it("ANYTHING THAT IS NOT 2 IS NOT v2, because a fallback answers every call", async () => {
    // A contract with a fallback does not revert — it returns empty data, which
    // decodes to zero. "It did not throw" is not the same as "it said two", and
    // reading a zero as a version would be the confident misclassification.
    for (const answered of [0, 1, 3, 255, "0x", "", null, 2.5, {}, []]) {
      const out = await probeClassFactory(fakeFactory({ version: answered }), FACTORY);
      assert.equal(out.version, 1, `${String(answered)} must not read as v2`);
    }
    // A numeric string IS the number, and refusing it would fail closed over a
    // transport quirk rather than over anything a contract said. The direction
    // that must hold is the other one: nothing that is not two may read as two.
    assert.equal((await probeClassFactory(fakeFactory({ version: "2", seed: [[], []] }), FACTORY)).version, 2);
  });

  it("a factory that says v2 and will not name its seed is refused, never guessed at", async () => {
    // The seed caps are what every vault it makes is BORN with, and a vault is
    // created inside the same operation as its first buy — so there is no
    // second transaction in which to correct them.
    await assert.rejects(
      () => probeClassFactory(fakeFactory({ version: 2, seedThrows: true }), FACTORY),
      /would not say what it seeds/,
    );
  });

  it("a seed that does not decode as a pair of equal-length arrays is refused", async () => {
    for (const seed of [null, [], [[USDG]], [[USDG], [1n, 2n]], "nonsense"]) {
      await assert.rejects(
        () => probeClassFactory(fakeFactory({ version: 2, seed }), FACTORY),
        /would not say what it seeds/,
        `seed ${JSON.stringify(seed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} must be refused`,
      );
    }
  });

  it("an empty seed decodes cleanly and is left for the caller to judge", async () => {
    // Not this function's call. The factory refuses an empty seed at its own
    // construction, and the signer's USDG check is what speaks for the wall.
    // Conflating "unreadable" with "readable and unsuitable" would put the
    // reason for a refusal in the wrong place.
    const out = await probeClassFactory(fakeFactory({ version: 2, seed: [[], []] }), FACTORY);
    assert.equal(out.version, 2);
    assert.equal(out.seedQuotes.length, 0);
  });

  it("caps come back as bigints whatever the transport handed over", async () => {
    // Different viem transports decode uint256 differently, and a cap compared
    // as a string would make `=== 0n` quietly false for a zero cap.
    const out = await probeClassFactory(
      fakeFactory({ version: 2, seed: [[USDG], ["250000000"]] }),
      FACTORY,
    );
    assert.equal(typeof out.seedCaps[0], "bigint");
    assert.equal(out.seedCaps[0], 250_000_000n);
  });
});
