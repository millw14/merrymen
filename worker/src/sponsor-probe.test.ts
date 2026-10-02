/** An advisory arm probe must never turn required sponsorship into self-pay. */
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

  it("IT NEVER THROWS — the actual operation still needs its own quote", async () => {
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
  it("a declined probe keeps sponsorship attached to the executor", () => {
    const probe = INDEX.indexOf("const quote = await sponsorWillQuote(sponsor");
    const executor = INDEX.indexOf("executor = await createAgentExecutor({", probe);
    const arm = INDEX.slice(probe, executor);
    assert.ok(probe > 0 && executor > probe);
    assert.doesNotMatch(arm, /sponsor\s*=/);
    assert.match(INDEX.slice(executor, executor + 300), /\n\s*sponsor,/);
  });

  it("and it is probed BEFORE the executor is built", () => {
    const probe = INDEX.indexOf("sponsorWillQuote(sponsor");
    const created = INDEX.indexOf("const sponsorship = tradingSponsorArm(cfg, grant.chainId);");
    assert.ok(created > 0 && probe > created, "probe the sponsor we actually built");
    // Nothing may trade between building the sponsor and knowing whether it
    // will pay.
    const exec = INDEX.indexOf("executor = await createAgentExecutor({", probe);
    assert.ok(exec > probe, "the probe resolves before the arm continues");
  });

  it("SAYS IT IN THE AGENT'S OWN EVENTS, not only in a log nobody reads", () => {
    // The owner's agent silently paying its own gas when the house said it
    // would cover it is exactly the kind of quiet divergence this codebase
    // refuses. And it is ours, so the sentence says so.
    assert.match(INDEX, /sponsored operations remain required/);
    assert.match(INDEX, /will be refused if the sponsor declines; this agent will not spend your ETH/);
    assert.doesNotMatch(INDEX, /self-paying this session/);
  });

  it("restores the financial anchor before a missing sponsor configuration can stop arming", () => {
    const create = INDEX.indexOf("const sponsorship = tradingSponsorArm(cfg, grant.chainId);");
    const restored = INDEX.lastIndexOf("await restoreAnchoredHighWaterMark(agentId);", create);
    assert.ok(restored > 0 && restored < create);
    const failure = INDEX.slice(create, INDEX.indexOf("if (sponsor)", create));
    assert.match(failure, /await setAgentStatus\(agentId, "error"\);/);
    assert.match(failure, /if \(lastArmFailure !== why\)/);
    assert.match(failure, /active = null;\s*return false;/);
  });

  it("a missing-config paper arm creates no live executor and revisits the guard when consent changes", () => {
    assert.match(INDEX, /sponsorBlockedPaperOnly = sponsorship\.paperOnly;/);
    assert.match(INDEX, /if \(bundlerUrl && !sponsorBlockedPaperOnly\) \{/);
    assert.match(INDEX, /if \(unchanged && !tradingSponsorNeedsRearm\(cfg, active\)\) return true;/);
    assert.match(INDEX, /active = \{\s*sponsorBlockedPaperOnly,/);
  });

  it("the switch itself still defaults OFF", () => {
    // Nothing here turns sponsorship on. The probe makes the switch SAFE to
    // turn on; whether to spend house money on gas is the operator's call.
    const settings = readFileSync(new URL("../../packages/core/src/settings.ts", import.meta.url), "utf8");
    assert.match(settings, /sponsorGasEnabled: false/);
  });
});
