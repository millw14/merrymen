/**
 * TURNING GAS SPONSORSHIP ON MUST NOT BE ABLE TO MAKE THINGS WORSE.
 *
 * The whole feature already existed and was measured against chain 4663 before
 * it was written — `paymaster.ts` says so, and a live probe with the production
 * key answers `{paymaster, paymasterData, paymasterPostOpGasLimit}` today. It
 * has simply never been switched on: `sponsorGasEnabled` defaults false and
 * `MERRYMEN_SPONSOR_GAS` is unset in production, which is why twelve agents in
 * the fleet are blocked by `no-gas` while holding USDG they cannot spend.
 *
 * THE REASON THE SWITCH WAS DANGEROUS. A sponsor refusal is not a fallback.
 * index.ts books the trade `rejected` with `reject_rule: sponsor-refused` and
 * nothing is sent — so an unfunded deposit or an exhausted policy does not
 * degrade an agent to self-paying, it stops it trading. And the agents that
 * breaks are precisely the ones that currently WORK, because they are the ones
 * holding ETH. Flipped blind, the switch is strictly worse than leaving it off.
 *
 * The arm-time probe inverts that: no quote, no sponsorship, and the agent runs
 * exactly as it does today. That is what makes it operable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SponsorRefused, sponsorWillQuote, type Sponsor } from "./paymaster";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

const ARGS = {
  sender: "0x1111111111111111111111111111111111111111" as const,
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const,
  chainId: 4663,
};

/** A sponsor whose stub call does whatever the test needs. */
const sponsorThat = (stub: () => Promise<unknown>): Sponsor =>
  ({
    paymaster: { getPaymasterStubData: stub, getPaymasterData: stub },
    paymasterContext: undefined,
    estimateOnly: { getPaymasterData: stub },
  }) as unknown as Sponsor;

describe("the probe answers the one question that decides the switch", () => {
  it("A SPONSOR THAT QUOTES IS USABLE", async () => {
    const r = await sponsorWillQuote(
      sponsorThat(async () => ({ paymaster: "0xabc", paymasterData: "0x" })),
      ARGS,
    );
    assert.equal(r.ok, true);
  });

  it("A SPONSOR THAT DECLINES IS NOT, and says why", async () => {
    // The likeliest real refusal: a drained deposit or an exhausted policy.
    const r = await sponsorWillQuote(
      sponsorThat(async () => {
        throw new SponsorRefused("sponsor-refused", "the gas sponsor declined this operation");
      }),
      ARGS,
    );
    assert.equal(r.ok, false);
    assert.match(r.why ?? "", /declined/);
  });

  it("and an unreachable one is not either — a refusal to quote is not a quote", () => {
    return sponsorWillQuote(
      sponsorThat(async () => {
        throw new Error("ECONNRESET");
      }),
      ARGS,
    ).then((r) => {
      assert.equal(r.ok, false);
      assert.match(r.why ?? "", /ECONNRESET/);
    });
  });

  it("IT NEVER THROWS — the caller decides, and arming must not fail on it", async () => {
    // A sponsor problem is a reason to run unsponsored, never a reason for an
    // agent not to arm at all.
    for (const boom of [
      async () => {
        throw new SponsorRefused("sponsor-unreachable", "nope");
      },
      async () => {
        throw "not even an error";
      },
    ]) {
      const r = await sponsorWillQuote(sponsorThat(boom), ARGS);
      assert.equal(r.ok, false);
    }
  });
});

describe("what the worker does with the answer", () => {
  it("NO QUOTE MEANS NO SPONSOR, for the whole session", () => {
    // `sponsor` had to stop being a const for this. The alternative — leaving
    // it set and letting every trade discover the refusal — is the behaviour
    // this exists to prevent, once per tick, forever.
    assert.match(INDEX, /let sponsor: Sponsor \| undefined =/);
    assert.match(INDEX, /if \(!quote\.ok\) \{\s*\n\s*sponsor = undefined;/);
  });

  it("and it is probed BEFORE the executor is built", () => {
    const probe = INDEX.indexOf("sponsorWillQuote(sponsor");
    const created = INDEX.indexOf("createSponsor({");
    assert.ok(created > 0 && probe > created, "probe the sponsor we actually built");
    // Nothing may trade between building the sponsor and knowing whether it
    // will pay.
    const exec = INDEX.indexOf("const agentId = await ensureAgent(grant);", probe);
    assert.ok(exec > probe, "the probe resolves before the arm continues");
  });

  it("SAYS IT IN THE AGENT'S OWN EVENTS, not only in a log nobody reads", () => {
    // The owner's agent silently paying its own gas when the house said it
    // would cover it is exactly the kind of quiet divergence this codebase
    // refuses. And it is ours, so the sentence says so.
    assert.match(INDEX, /gas sponsor will not quote — self-paying this session/);
    assert.match(INDEX, /That is ours to fix, not yours/);
  });

  it("the switch itself still defaults OFF", () => {
    // Nothing here turns sponsorship on. The probe makes the switch SAFE to
    // turn on; whether to spend house money on gas is the operator's call.
    const settings = readFileSync(new URL("../../packages/core/src/settings.ts", import.meta.url), "utf8");
    assert.match(settings, /sponsorGasEnabled: false/);
  });
});
