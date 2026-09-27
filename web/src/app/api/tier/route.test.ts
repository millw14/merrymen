/**
 * ONE STANDING, THREE ROUTES: THE OWNER'S WALLET AND THE AGENT'S ACCOUNT.
 *
 * The worker's Circle gate and its energy count $MERRYMEN in both places. These
 * routes used to count only the owner's wallet — so "send $MERRYMEN to my
 * account" would have cleared the worker's gate while the Circle banner, the
 * create and settings standing, the Android banner and the iOS screens all went
 * on saying "isn't running — you hold 0". Two surfaces, two confident answers.
 *
 * What must hold, and what this runs:
 *   - the two balances are SUMMED, in one multicall;
 *   - an agent account that IS the holder wallet is counted once;
 *   - an agent on any other chain is not counted at all;
 *   - either read failing fails the whole standing — never half a sum;
 *   - the holder's own part is exposed (a new agent starts with only that);
 *   - the tier comes from the combined figure.
 *
 * The routes need a session, the grant store and a chain, so the reader they
 * share is run against a stub client, and each route's use of it is pinned in
 * its source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CIRCLE_TIERS, MERRYMEN_TOKEN, tierForBalance } from "@merrymen/core";
import {
  AGENT_BALANCE_TTL_MS,
  HOLDER_BALANCE_TTL_MS,
  countedAgent,
  energyGateOn,
  readStanding,
  standingTokens,
  type BalanceCache,
  type StandingClient,
} from "../../../lib/merrymen-standing";
import { UNREADABLE_TIER } from "../../../terminal/tier";

const WHOLE = 10n ** BigInt(MERRYMEN_TOKEN.decimals);
const HOLDER = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as const;
const AGENT = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb" as const;
const MAINNET = MERRYMEN_TOKEN.chainId;
const NEED = CIRCLE_TIERS.find((t) => t.bonusStrategies)!.minTokens;

type Answer = bigint | "fail" | "empty";

/** A chain that answers balanceOf per address, and records every multicall. */
function chain(answers: Record<string, Answer>, opts: { reject?: boolean } = {}) {
  const calls: { token: string; fn: string; who: string }[][] = [];
  const client: StandingClient = {
    async multicall({ contracts }) {
      calls.push(contracts.map((c) => ({ token: c.address, fn: c.functionName, who: c.args[0].toLowerCase() })));
      if (opts.reject) throw new Error("HTTP request failed. Status: 429 Too Many Requests");
      return contracts.map((c) => {
        const a = answers[c.args[0].toLowerCase()];
        if (a === "fail" || a === undefined) return { status: "failure" as const };
        if (a === "empty") return { status: "success" as const, result: undefined };
        return { status: "success" as const, result: a };
      });
    },
  };
  return { client, calls };
}

const h = HOLDER.toLowerCase();
const a = AGENT.toLowerCase();

describe("the combined standing", () => {
  it("SUMS THE OWNER'S WALLET AND THE AGENT'S ACCOUNT, in one multicall", async () => {
    const { client, calls } = chain({ [h]: 60_000n * WHOLE, [a]: 40_000n * WHOLE });
    const s = await readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET } });
    assert.equal(s.raw, 100_000n * WHOLE);
    assert.equal(calls.length, 1, "one multicall, not two reads");
    assert.deepEqual(calls[0]!.map((c) => c.who), [h, a]);
    for (const c of calls[0]!) {
      assert.equal(c.token, MERRYMEN_TOKEN.address, "the $MERRYMEN contract and nothing else");
      assert.equal(c.fn, "balanceOf");
    }
  });

  it("AND EXPOSES THE HOLDER'S OWN PART — a new agent starts with only that", async () => {
    const { client } = chain({ [h]: 60_000n * WHOLE, [a]: 40_000n * WHOLE });
    const s = await readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET } });
    assert.deepEqual(standingTokens(s), { tokens: 100_000, holderTokens: 60_000, agentTokens: 40_000 });
    assert.equal(s.agent, AGENT);
  });

  it("THE TIER COMES FROM THE COMBINED FIGURE — neither half alone qualifies", async () => {
    const { client } = chain({ [h]: 60_000n * WHOLE, [a]: 40_000n * WHOLE });
    const s = await readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET } });
    assert.equal(tierForBalance(60_000n * WHOLE).bonusStrategies, false, "the wallet alone is short");
    assert.equal(tierForBalance(s.raw).bonusStrategies, true, "together they are the Merry Man tier");
    assert.equal(standingTokens(s).tokens, NEED);
  });

  it("AN AGENT ACCOUNT THAT IS THE HOLDER WALLET IS COUNTED ONCE", async () => {
    // Self-hosted, an operator can name their agent's own account as their
    // holder. The same tokens are not twice the tokens.
    const { client, calls } = chain({ [h]: 70_000n * WHOLE });
    const s = await readStanding({
      client,
      holder: HOLDER,
      agent: { address: HOLDER.toLowerCase() as `0x${string}`, chainId: MAINNET },
    });
    assert.equal(s.raw, 70_000n * WHOLE);
    assert.deepEqual(calls[0]!.map((c) => c.who), [h], "read once");
    assert.equal(s.agentRaw, null);
    assert.equal(standingTokens(s).agentTokens, null);
  });

  it("AN AGENT ON ANY OTHER CHAIN IS NOT COUNTED — tokens sent there would not count", async () => {
    const { client, calls } = chain({ [h]: 10n * WHOLE, [a]: 999_999n * WHOLE });
    const s = await readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: 46630 } });
    assert.equal(s.raw, 10n * WHOLE);
    assert.deepEqual(calls[0]!.map((c) => c.who), [h], "its mainnet address is not even read");
    assert.equal(s.agent, null);
    assert.equal(countedAgent(HOLDER, { address: AGENT, chainId: 46630 }), null);
    assert.equal(countedAgent(HOLDER, { address: AGENT, chainId: MAINNET }), AGENT);
    assert.equal(countedAgent(HOLDER, null), null);
  });

  it("no agent at all is the holder alone", async () => {
    const { client } = chain({ [h]: 5n * WHOLE });
    const s = await readStanding({ client, holder: HOLDER, agent: null });
    assert.deepEqual(standingTokens(s), { tokens: 5, holderTokens: 5, agentTokens: null });
  });

  it("and no holder wallet (self-hosted, none named) is the agent alone", async () => {
    const { client } = chain({ [a]: 5n * WHOLE });
    const s = await readStanding({ client, holder: null, agent: { address: AGENT, chainId: MAINNET } });
    assert.deepEqual(standingTokens(s), { tokens: 5, holderTokens: null, agentTokens: 5 });
  });

  it("A MEASURED ZERO IS STILL ZERO — only an unread balance is null", async () => {
    const { client } = chain({ [h]: 0n, [a]: 0n });
    const s = await readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET } });
    assert.deepEqual(standingTokens(s), { tokens: 0, holderTokens: 0, agentTokens: 0 });
  });
});

describe("either read failing fails the whole standing", () => {
  const cases: [string, Record<string, Answer>, { reject?: boolean }][] = [
    ["the agent's read failed inside a batch that answered", { [h]: 100_000n * WHOLE, [a]: "fail" }, {}],
    ["the holder's read failed", { [h]: "fail", [a]: 100_000n * WHOLE }, {}],
    ["a 'success' carried no number", { [h]: 1n, [a]: "empty" }, {}],
    ["the endpoint refused the whole batch", { [h]: 1n, [a]: 1n }, { reject: true }],
  ];
  for (const [name, answers, opts] of cases) {
    it(`THROWS WHEN ${name.toUpperCase()} — half a sum is the smaller number that sends somebody to buy`, async () => {
      const { client } = chain(answers, opts);
      await assert.rejects(readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET } }));
    });
  }

  it("and a failed pair caches nothing, so the next request asks again", async () => {
    const holderCache: BalanceCache = new Map();
    const agentCache: BalanceCache = new Map();
    const { client } = chain({ [h]: 7n * WHOLE, [a]: "fail" });
    await assert.rejects(
      readStanding({ client, holder: HOLDER, agent: { address: AGENT, chainId: MAINNET }, holderCache, agentCache }),
    );
    assert.equal(holderCache.size, 0);
    assert.equal(agentCache.size, 0);
  });
});

describe("a balance is cached, never a verdict", () => {
  it("THE HOLDER KEEPS TEN MINUTES, THE AGENT'S ACCOUNT ONE", async () => {
    assert.equal(HOLDER_BALANCE_TTL_MS, 10 * 60_000);
    assert.equal(AGENT_BALANCE_TTL_MS, 60_000);
    const holderCache: BalanceCache = new Map();
    const agentCache: BalanceCache = new Map();
    const agent = { address: AGENT, chainId: MAINNET };
    const first = chain({ [h]: 1n * WHOLE, [a]: 2n * WHOLE });
    await readStanding({ client: first.client, holder: HOLDER, agent, holderCache, agentCache, now: 0 });

    // Within a minute: nothing is read.
    const soon = chain({});
    const s1 = await readStanding({ client: soon.client, holder: HOLDER, agent, holderCache, agentCache, now: 30_000 });
    assert.equal(soon.calls.length, 0);
    assert.equal(s1.raw, 3n * WHOLE);

    // After a minute, only the agent's account is read again.
    const later = chain({ [a]: 5n * WHOLE });
    const s2 = await readStanding({ client: later.client, holder: HOLDER, agent, holderCache, agentCache, now: 61_000 });
    assert.deepEqual(later.calls[0]!.map((c) => c.who), [a]);
    assert.equal(s2.raw, 6n * WHOLE, "a top-up shows within a minute");
  });
});

describe("the energy gate flag the tier route reports (copy only)", () => {
  it("IS ON ONLY WHEN ENFORCING, AND NEVER SELF-HOSTED", () => {
    assert.equal(energyGateOn("1", true), true);
    assert.equal(energyGateOn(" enforce ", true), true);
    for (const off of [undefined, "", "0", "observe", "yes"]) assert.equal(energyGateOn(off, true), false, String(off));
    assert.equal(energyGateOn("1", false), false, "self-hosted is always off");
  });
});

/** Comments stripped, so a header naming what a route refuses does not satisfy a pin. */
const code = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

describe("/api/tier uses it", () => {
  const TIER = code("./route.ts");

  it("THE HOLDER IS STILL RESOLVED BY THE ONE RESOLVER, and the agent by its grant", () => {
    assert.match(TIER, /holderWalletFor\(/, "one function decides whose wallet counts");
    assert.match(TIER, /agentAccountFor\(req, hosted\)/);
    assert.match(TIER, /readStanding\(\{/);
    assert.match(TIER, /webChainRead\(rpc\)/);
  });

  it("ANY FAILURE IS why 'unreadable', AND EVERY COUNT STAYS AT ITS NULL DEFAULT", () => {
    const defaults = TIER.slice(TIER.indexOf("const view = "), TIER.indexOf("...v,"));
    for (const f of ["tokens: null", "holderTokens: null", "agentTokens: null", "agentAccount: null"]) {
      assert.ok(defaults.includes(f), `the default view must carry ${f}`);
    }
    // From the catch to the end of its response: the object the arm returns.
    const catchArm = TIER.slice(TIER.lastIndexOf("} catch") + 1);
    const arm = catchArm.slice(0, catchArm.indexOf("));"));
    assert.match(arm, /why: "unreadable"/);
    assert.ok(!/tokens|Tokens|tierForBalance/.test(arm), "the unreadable arm may set no count and no tier");
  });

  it("the tier comes from the combined raw, and nothing is made up", () => {
    assert.match(TIER, /tierForBalance\(standing\.raw\)/);
    assert.match(TIER, /\.\.\.standingTokens\(standing\)/);
    assert.ok(!/\?\? 0\b|= 0n/.test(TIER), "no default of zero anywhere in the route");
  });

  it("THE FETCHER'S OWN FAILURE ARM carries the new fields as null", () => {
    assert.equal(UNREADABLE_TIER.tokens, null);
    assert.equal(UNREADABLE_TIER.holderTokens, null);
    assert.equal(UNREADABLE_TIER.agentTokens, null);
    assert.equal(UNREADABLE_TIER.agentAccount, null);
    assert.equal(UNREADABLE_TIER.energyGate, false);
  });
});

describe("/api/circle uses it", () => {
  const CIRCLE = code("../circle/route.ts");

  it("BALANCE IS THE COMBINED FIGURE, with both parts beside it", () => {
    assert.match(CIRCLE, /readStanding\(\{/);
    assert.match(CIRCLE, /agentAccountFor\(req, hosted\)/);
    assert.match(CIRCLE, /balance: tokens,/);
    assert.match(CIRCLE, /holderBalance: holderTokens,/);
    assert.match(CIRCLE, /agentBalance: agentTokens,/);
    assert.match(CIRCLE, /tierForBalance\(standing\.raw\)/, "fee and tier from the sum");
  });

  it("and the unreadable arm nulls all three", () => {
    const catchArm = CIRCLE.slice(CIRCLE.lastIndexOf("} catch"));
    for (const f of ["balance: null", "holderBalance: null", "agentBalance: null", "tier: null"]) {
      assert.ok(catchArm.includes(f), `the unreadable arm must carry ${f}`);
    }
  });
});

describe("/api/alpha uses it", () => {
  const ALPHA = code("../alpha/route.ts");

  it("THE DESK OPENS ON THE SAME TOKENS THE WORKER COUNTS", () => {
    assert.match(ALPHA, /readStanding\(\{/);
    assert.match(ALPHA, /agent: await agentAccountFor\(req, true\)/);
    assert.match(ALPHA, /raw = standing\.raw;/);
  });
});
