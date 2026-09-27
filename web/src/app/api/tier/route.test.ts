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
 * The reader the three routes share is run against a stub client, and each
 * route's use of it is pinned in its source. /api/tier's GET is ALSO run for
 * real (bottom of this file): a temp MERRYMEN_HOME holding settings.json and
 * grant.json, and a JSON-RPC chain stubbed at fetch — the one seam the route
 * already has, so nothing in it changes to be tested.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi, toHex } from "viem";
import { CIRCLE_TIERS, MERRYMEN_TOKEN, robinhoodChain, tierForBalance } from "@merrymen/core";
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

/**
 * THE /api/tier GET HANDLER, RUN — self-hosted first, where the branch is new.
 *
 * Self-hosted the route resolves the holder from settings.json (diskHolder),
 * the agent from grant.json (agentAccountFor(req, false)), reads through the
 * settings file's own RPC, and returns early when there is nothing to read.
 * None of that ran before: a wrong branch order or a thrown diskHolder passed.
 *
 * THE ROUTE CACHES BALANCES PER ADDRESS for the life of the module, so every
 * case below uses addresses no other case reads.
 */
describe("/api/tier GET, run", () => {
  const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_ENERGY_GATE", "DATABASE_URL"] as const;
  const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const RPC = "https://rpc.example.test/operator-own";
  const MULTICALL = robinhoodChain.contracts!.multicall3!.address.toLowerCase();
  const realFetch = globalThis.fetch;
  let dir: string;
  let GET: (req: Request) => Promise<Response>;

  /** A fresh address per use, so the route's module-level cache never answers for the chain. */
  let n = 0;
  const fresh = () => `0x${(++n).toString(16).padStart(4, "0")}${"c".repeat(36)}` as `0x${string}`;

  /** The chain, at fetch: answers the $MERRYMEN multicall per address and records who was asked, where. */
  function chainAt(balances: Record<string, bigint>, o: { status?: number } = {}) {
    const asked: { url: string; who: string[] }[] = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      if (o.status) return new Response("{}", { status: o.status });
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const one = (r: { id: number; method: string; params: unknown[] }) => {
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: toHex(robinhoodChain.id) };
        assert.equal(r.method, "eth_call", `the stub chain was asked for ${r.method}`);
        const { to, data } = r.params[0] as { to: string; data: `0x${string}` };
        assert.equal(to.toLowerCase(), MULTICALL, "one multicall");
        const calls = decodeFunctionData({ abi: multicall3Abi, data }).args[0] as readonly { target: string; callData: `0x${string}` }[];
        const who: string[] = [];
        const results = calls.map((c) => {
          assert.equal(c.target.toLowerCase(), MERRYMEN_TOKEN.address.toLowerCase(), "the $MERRYMEN contract and nothing else");
          const inner = decodeFunctionData({ abi: erc20Abi, data: c.callData });
          assert.equal(inner.functionName, "balanceOf");
          const address = String(inner.args![0]).toLowerCase();
          who.push(address);
          const raw = balances[address];
          return raw === undefined
            ? { success: false, returnData: "0x" as const }
            : { success: true, returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: raw }) };
        });
        asked.push({ url: String(url), who });
        return { jsonrpc: "2.0", id: r.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }) };
      };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    }) as typeof fetch;
    return asked;
  }

  const disk = (o: { settings?: Record<string, unknown> | string | null; grant?: { smartAccount: string; chainId: number } | null }) => {
    for (const [file, v] of [["settings.json", o.settings], ["grant.json", o.grant]] as const) {
      const at = path.join(dir, file);
      if (v === null || v === undefined) rmSync(at, { force: true });
      else writeFileSync(at, typeof v === "string" ? v : JSON.stringify(v));
    }
  };
  const tier = async (headers: Record<string, string> = {}) => {
    const res = await GET(new Request("https://app.example.test/api/tier", { headers }));
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "merrymen-tier-get-"));
    process.env.MERRYMEN_HOME = dir;
    process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
    delete process.env.MERRYMEN_HOSTED;
    delete process.env.MERRYMEN_ENERGY_GATE;
    delete process.env.DATABASE_URL;
    ({ GET } = await import("./route"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MERRYMEN_HOSTED;
  });
  after(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("SELF-HOSTED, A NAMED WALLET AND A MAINNET GRANT: both summed, through the operator's own RPC", async () => {
    const holder = fresh();
    const agent = fresh();
    disk({ settings: { holderAddress: holder, rpcMainnet: RPC }, grant: { smartAccount: agent, chainId: MAINNET } });
    const asked = chainAt({ [holder]: 60_000n * WHOLE, [agent]: 40_000n * WHOLE });
    const v = await tier();
    assert.equal(v.why, "ok");
    assert.deepEqual(
      { tokens: v.tokens, holderTokens: v.holderTokens, agentTokens: v.agentTokens, agentAccount: v.agentAccount },
      { tokens: 100_000, holderTokens: 60_000, agentTokens: 40_000, agentAccount: agent },
    );
    assert.equal(v.wallet, holder);
    assert.equal(v.source, "settings");
    assert.equal(v.bonusStrategies, true, "the tier comes from the sum");
    assert.equal(v.energyGate, false, "self-hosted is never gated");
    assert.deepEqual(asked.map((a) => a.who), [[holder, agent]], "one multicall, both halves");
    assert.ok(asked.every((a) => a.url === RPC), "read through settings.rpcMainnet, not a default endpoint");
  });

  it("SELF-HOSTED, A TESTNET GRANT: the wallet alone — the agent's address is not even read", async () => {
    const holder = fresh();
    const agent = fresh();
    disk({ settings: { holderAddress: holder, rpcMainnet: RPC }, grant: { smartAccount: agent, chainId: 46630 } });
    const asked = chainAt({ [holder]: 10n * WHOLE, [agent]: 999_999n * WHOLE });
    const v = await tier();
    assert.deepEqual(
      { why: v.why, tokens: v.tokens, holderTokens: v.holderTokens, agentTokens: v.agentTokens, agentAccount: v.agentAccount },
      { why: "ok", tokens: 10, holderTokens: 10, agentTokens: null, agentAccount: null },
    );
    assert.deepEqual(asked.map((a) => a.who), [[holder]]);
  });

  it("SELF-HOSTED, NO WALLET NAMED AND A MAINNET GRANT: the agent's account alone", async () => {
    const agent = fresh();
    disk({ settings: { rpcMainnet: RPC }, grant: { smartAccount: agent, chainId: MAINNET } });
    const asked = chainAt({ [agent]: 5n * WHOLE });
    const v = await tier();
    assert.deepEqual(
      { why: v.why, tokens: v.tokens, holderTokens: v.holderTokens, agentTokens: v.agentTokens, wallet: v.wallet, source: v.source },
      { why: "ok", tokens: 5, holderTokens: null, agentTokens: 5, wallet: null, source: null },
    );
    assert.deepEqual(asked.map((a) => a.who), [[agent]]);
  });

  it("SELF-HOSTED, NOTHING TO READ — no wallet named and only a testnet grant, or nothing on disk — asks the chain nothing", async () => {
    for (const d of [
      { settings: { rpcMainnet: RPC }, grant: { smartAccount: fresh(), chainId: 46630 } },
      { settings: null, grant: null },
      // A file that is not JSON is no wallet named, not a crash (diskHolder).
      { settings: "{ not json", grant: null },
    ]) {
      disk(d);
      const asked = chainAt({});
      const v = await tier();
      assert.equal(v.why, "ok", JSON.stringify(d));
      for (const f of ["tokens", "holderTokens", "agentTokens", "agentAccount", "tierId", "wallet", "source"]) {
        assert.equal(v[f], null, `${f} stays null: nothing read is not nothing held`);
      }
      assert.equal(asked.length, 0, "no read was made");
    }
  });

  it("SELF-HOSTED, THE CHAIN REFUSES: unreadable, the wallet still named, every count null", async () => {
    const holder = fresh();
    disk({ settings: { holderAddress: holder, rpcMainnet: RPC }, grant: { smartAccount: fresh(), chainId: MAINNET } });
    chainAt({}, { status: 429 });
    const v = await tier();
    assert.equal(v.why, "unreadable");
    assert.equal(v.wallet, holder);
    assert.equal(v.source, "settings");
    for (const f of ["tokens", "holderTokens", "agentTokens", "agentAccount", "tierId"]) assert.equal(v[f], null, f);
  });

  it("SELF-HOSTED, HALF A SUM IS NOT A SUM: the agent's balance unreadable is unreadable", async () => {
    const holder = fresh();
    disk({ settings: { holderAddress: holder, rpcMainnet: RPC }, grant: { smartAccount: fresh(), chainId: MAINNET } });
    chainAt({ [holder]: 100_000n * WHOLE }); // the agent's read fails inside the batch
    const v = await tier();
    assert.equal(v.why, "unreadable");
    assert.equal(v.tokens, null);
    assert.equal(v.holderTokens, null, "not the half that did read");
  });

  it("HOSTED, SIGNED OUT: sign-in, and nothing is read about anybody", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    disk({ settings: { holderAddress: fresh() }, grant: { smartAccount: fresh(), chainId: MAINNET } });
    const asked = chainAt({});
    const v = await tier();
    assert.equal(v.why, "sign-in");
    assert.equal(v.tokens, null);
    assert.equal(asked.length, 0, "the operator's disk is not the signed-out visitor's standing");
  });

  it("HOSTED, WHOSE WALLET COUNTS CANNOT BE READ: unreadable before any balance is asked for", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const { mintSession } = await import("@/lib/auth");
    // THROUGH require, ON PURPOSE (holder/route.test.ts): the route reaches
    // worker modules by require, and a stub on the ESM instance of the same
    // file is a stub the route never calls.
    const { getSettingsStore, resetSettingsStoreForTest } = createRequire(import.meta.url)(
      "../../../../../worker/src/settings-store.ts",
    ) as typeof import("../../../../../worker/src/settings-store");
    resetSettingsStoreForTest();
    const store = getSettingsStore();
    store.holderClaims = async () => {
      throw new Error("holder_claims unreadable");
    };
    try {
      const asked = chainAt({});
      const v = await tier({ cookie: `mm_session=${mintSession(fresh())}` });
      assert.equal(v.why, "unreadable");
      for (const f of ["tokens", "holderTokens", "agentTokens", "wallet", "source"]) assert.equal(v[f], null, f);
      assert.equal(asked.length, 0);
    } finally {
      resetSettingsStoreForTest();
    }
  });

  it("HOSTED, THE GRANT STORE CANNOT BE READ: unreadable — never 'no agent', which would drop half the sum", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const { mintSession } = await import("@/lib/auth");
    const { getGrantStore, resetGrantStoreForTest } = createRequire(import.meta.url)(
      "../../../../../worker/src/grant-store.ts",
    ) as typeof import("../../../../../worker/src/grant-store");
    resetGrantStoreForTest();
    getGrantStore().get = async () => {
      throw new Error("grant store unreadable");
    };
    try {
      const asked = chainAt({});
      const v = await tier({ cookie: `mm_session=${mintSession(fresh())}` });
      assert.equal(v.why, "unreadable");
      for (const f of ["tokens", "holderTokens", "agentTokens", "agentAccount"]) assert.equal(v[f], null, f);
      assert.equal(asked.length, 0, "nothing is read when the account to read is unknown");
    } finally {
      resetGrantStoreForTest();
    }
  });
});
