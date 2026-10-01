import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  PAYMASTER_GAS_MAX,
  PAYMASTER_POSTOP_GAS,
  PAYMASTER_VERIFICATION_GAS,
  SponsorRefused,
  assertBoundsHeld,
  createSponsor,
} from "./paymaster";

/**
 * The sponsor is an untrusted party that picks numbers WE pay for — or rather,
 * that the house pays for, which is worse, because the account that would feel
 * an out-of-gas is not the account being charged.
 *
 * These tests are about the two things that make sponsorship safe to attach: the
 * limits we bounded survive it, and a refusal is a typed pre-broadcast event
 * rather than a free-form string in a column with a small vocabulary.
 */

describe("the bounds we signed must survive the sponsor", () => {
  const bounded = {
    callGasLimit: 200_000n,
    verificationGasLimit: 150_000n,
    preVerificationGas: 60_000n,
  };

  it("passes when the prepared operation reports our numbers back", () => {
    assert.doesNotThrow(() =>
      assertBoundsHeld(bounded, {
        callGasLimit: 200_000n,
        verificationGasLimit: 150_000n,
        preVerificationGas: 60_000n,
      }),
    );
  });

  it("passes when the fields are not reported at all", () => {
    // Absence is not contradiction. A check that treated a missing field as a
    // failure would refuse every operation on a bundler that simply echoes less.
    assert.doesNotThrow(() => assertBoundsHeld(bounded, {}));
  });

  it("REFUSES when the sponsor lowered a limit — the out-of-gas case", () => {
    // The dangerous direction. An under-provisioned operation does not bounce:
    // the EntryPoint runs it, the inner call runs out of gas, and it is charged
    // in full. Under sponsorship the payer of that is the house.
    assert.throws(
      () => assertBoundsHeld(bounded, { callGasLimit: 21_000n }),
      (e: unknown) => e instanceof SponsorRefused && e.rule === "sponsor-absurd",
    );
  });

  it("REFUSES when the sponsor raised a limit", () => {
    // Also refused, and not out of symmetry: gas-limits.ts exists so that no
    // number nobody checked is ever signed. A sponsor that raises one has
    // replaced our arithmetic with its own.
    assert.throws(
      () => assertBoundsHeld(bounded, { verificationGasLimit: 900_000n }),
      (e: unknown) => e instanceof SponsorRefused,
    );
  });

  it("reads hex, because that is what an RPC actually returns", () => {
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: "0x30d40" }));
    assert.throws(
      () => assertBoundsHeld(bounded, { callGasLimit: "0x5208" }),
      (e: unknown) => e instanceof SponsorRefused,
    );
  });

  it("ignores junk rather than treating it as a mismatch", () => {
    // A field we cannot parse is a field we cannot contradict. Refusing here
    // would turn an unfamiliar reply shape into a trading outage.
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: null }));
    assert.doesNotThrow(() => assertBoundsHeld(bounded, { callGasLimit: "not a number" }));
  });
});

describe("a configured sponsor cannot turn into self-paid gas", () => {
  const paymaster = "0x3333333333333333333333333333333333333333";
  const args = {
    sender: "0x1111111111111111111111111111111111111111" as const,
    nonce: 0n,
    callData: "0x" as const,
    chainId: 4663,
    entryPointAddress: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const,
  };

  async function withReply(reply: Record<string, unknown>, test: (sponsor: ReturnType<typeof createSponsor>) => Promise<void>, credentials?: RequestCredentials) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        const { id } = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: reply }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await test(createSponsor({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credentials }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("refuses absent, zero, or malformed paymasters at both stages", async () => {
    for (const invalid of [undefined, null, "0x", "0x0", "0x" + "00".repeat(20), "0x" + "gg".repeat(20)]) {
      await withReply({ paymaster: invalid, paymasterData: "0x1234" }, async (sponsor) => {
        await assert.rejects(sponsor.paymaster.getPaymasterStubData(args), SponsorRefused);
        await assert.rejects(sponsor.paymaster.getPaymasterData(args), SponsorRefused);
      });
    }
  });

  it("refuses empty final data and malformed data without dropping sponsorship", async () => {
    for (const invalid of [undefined, null, "0x", "0x1", "0xzz", "signature"]) {
      await withReply({ paymaster, paymasterData: invalid }, async (sponsor) => {
        await assert.rejects(sponsor.paymaster.getPaymasterData(args), SponsorRefused);
      });
    }
  });

  it("allows an empty estimation stub, but never a final stub without authorisation", async () => {
    await withReply({ paymaster, paymasterData: "0x" }, async (sponsor) => {
      const stub = await sponsor.paymaster.getPaymasterStubData(args);
      assert.equal(stub.paymaster, paymaster);
      assert.equal(stub.paymasterData, "0x");
      assert.equal(stub.paymasterVerificationGasLimit, PAYMASTER_VERIFICATION_GAS);
      assert.equal(stub.paymasterPostOpGasLimit, PAYMASTER_POSTOP_GAS);
    });
    await withReply({ paymaster, paymasterData: "0x", isFinal: true }, async (sponsor) => {
      await assert.rejects(sponsor.paymaster.getPaymasterStubData(args), SponsorRefused);
    });
  });

  it("keeps the existing ceiling and filters unrelated operation limits", async () => {
    await withReply({ paymaster, paymasterData: "0x1234", callGasLimit: "0x1", preVerificationGas: "0x1" }, async (sponsor) => {
      const data = await sponsor.paymaster.getPaymasterData(args);
      assert.equal(data.paymaster, paymaster);
      assert.equal((data as Record<string, unknown>).callGasLimit, undefined);
      assert.equal((data as Record<string, unknown>).preVerificationGas, undefined);
    });
    await withReply({ paymaster, paymasterData: "0x1234", paymasterVerificationGasLimit: `0x${(PAYMASTER_GAS_MAX + 1n).toString(16)}` }, async (sponsor) => {
      await assert.rejects(sponsor.paymaster.getPaymasterData(args), (e: unknown) => e instanceof SponsorRefused && e.rule === "sponsor-absurd");
    });
  });

  it("includes application relay credentials only when the caller requests them", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<RequestCredentials | undefined> = [];
    globalThis.fetch = (input, init) => {
      seen.push(init?.credentials ?? (input instanceof Request ? input.credentials : undefined));
      return originalFetch(input, init);
    };
    try {
      await withReply({ paymaster, paymasterData: "0x1234" }, async (sponsor) => {
        await sponsor.paymaster.getPaymasterData(args);
      }, "include");
      assert.equal(seen.at(-1), "include");
      await withReply({ paymaster, paymasterData: "0x1234" }, async (sponsor) => {
        await sponsor.paymaster.getPaymasterData(args);
      });
      assert.notEqual(seen.at(-1), "include");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("SponsorRefused carries a rule from a fixed vocabulary", () => {
  it("names the three ways a sponsor says no", () => {
    // The whole point of the type: without it these land in the generic submit
    // catch as `status: "reverted"` with a free-form reject_rule — a ledger row
    // asserting the chain refused a trade the chain never saw.
    for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd"] as const) {
      const e = new SponsorRefused(rule, "because");
      assert.equal(e.rule, rule);
      assert.equal(e.name, "SponsorRefused");
      assert.ok(e instanceof Error);
    }
  });
});

describe("the paymaster gas ceiling", () => {
  it("leaves room for a real approve+swap and refuses well below absurd", () => {
    // Sized against gas-limits.ts's 3,000,000 total ceiling: the two paymaster
    // fields together must not be able to eat it.
    assert.ok(PAYMASTER_VERIFICATION_GAS < PAYMASTER_GAS_MAX);
    assert.ok(PAYMASTER_POSTOP_GAS < PAYMASTER_GAS_MAX);
    assert.ok(PAYMASTER_GAS_MAX * 2n < 3_000_000n, "two paymaster fields must not exhaust the op ceiling");
  });
});
