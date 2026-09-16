/**
 * THE FIRST TEST THE MILESTONE ASKS FOR: two Merrymen, ONE trending snapshot,
 * and everything each of them would have done — shown, not executed.
 *
 *   npx tsx tools/brain-trending-shadow.mts --out <dir> [--no-brain] [--top-n 24]
 *       [--repeat N --every SEC]      take N snapshots SEC apart, one subdir each, plus rollup.md
 *       [--replay <snapshot.json>]    run the agents on a SAVED snapshot instead of reading the chain
 *
 * Environment: RPC_URL (defaults to the chain's public RPC),
 * MERRYMEN_BRAIN_URL + MERRYMEN_BRAIN_TOKEN (or --brain-url/--brain-token;
 * without them the run is a deterministic dry run and says so).
 *
 * RESEARCH IS WIDER THAN EXECUTION. Since 2026-09-16 the snapshot covers EVERY
 * Pons quote asset (ETH-native, stock and ETF tokens, USDG); the Brain researches
 * all of them in shadow, and the report names the best opportunity separately
 * from the action — which can only ever be a buy of a USDG-quoted candidate,
 * because that is all the live route can execute today.
 *
 * READ-ONLY, BY CONSTRUCTION. This script holds no key, builds no UserOp and
 * imports nothing from the executor. The "simulation" stage is `eth_simulateV1`
 * — a node-side rehearsal that changes nothing. A buy that passes every stage
 * here is a buy the tick WOULD have sent, and that is the whole output.
 *
 * WHAT IS REAL AND WHAT IS ASSERTED. The snapshot, reserves, tape, ages, prices,
 * cash and vault balances are read from the chain now. Two things are NOT read:
 *
 *   - the grant's limits (perTradeUsdg etc.) live sealed in Postgres; the
 *     harness uses the class-route presets and says "preset" in the report
 *   - the ledger's quality flags (contributions, auditability) live in the
 *     child's sqlite; the harness asserts a clean book so the Brain's gate
 *     opens and the SELECTION can be observed — which is what shadow mode is
 *     for. The report prints this in a banner. A gate-forced hold on both
 *     agents would prove nothing about selection.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { robinhoodChain } from "../packages/core/src/chain";
import { CASH, CASH_FEEDS } from "../packages/core/src/tokens";
import { buildPortfolioSnapshot, type PortfolioSnapshot, type SnapshotPosition } from "../packages/core/src/portfolio-snapshot";
import { STEADY_SWAP_GAS_UNITS, expectedTradeGasUsdg } from "../worker/src/execution-cost";
import { researchForAgent, type AgentShadowRun, type ClassRouteConfig, type TrendingAgent } from "../worker/src/brain-trending";
import { parseProfile, type TradingProfile } from "../worker/src/trading-profile";
import { buildTrendingSnapshot, type TrendingSnapshot } from "../worker/src/trending-snapshot";
import { buildClassBuyCalls } from "../worker/src/venues/pons-class";
import { simulateClassBuy, type ClassSimResult } from "../worker/src/venues/pons-class-simulate";
import { readCurveReserves, readCurveThreshold } from "../worker/src/venues/pons";
import { curveSellOut } from "../worker/src/venues/pons-price";
import type { AgentLimits, AgentState } from "../worker/src/policy";

// ── the two agents ──────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  /** The tenant — what the worker calls the agent id. */
  agentId: `0x${string}`;
  smartAccount: `0x${string}`;
  vault: `0x${string}`;
  /** Class positions known to be in the vault: token + curve + what they cost. */
  held: { token: `0x${string}`; curve: `0x${string}`; costUsdg: number; symbol: string }[];
  cfg: ClassRouteConfig;
  profile: Partial<TradingProfile>;
  /** Preset, not the sealed grant. */
  perTradeUsdg: number;
}

const HELD_LAUNCH = {
  token: "0x5b87957b9de0817994175faa089697d85f176983" as `0x${string}`,
  curve: "0xc7c85958080e574734e8bb14fb545ec3986ac2ba" as `0x${string}`,
  costUsdg: 5,
  symbol: "HELD1",
};

const DEFAULT_AGENTS: AgentConfig[] = [
  {
    name: "Shogun",
    agentId: "0x8e93bad5a60a266b4283855ceffa0979720aed72",
    smartAccount: "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487",
    vault: "0x3fcdde6e011769ca05f0115f1543290862473216",
    held: [HELD_LAUNCH],
    // The canary preset (enable-class.ts CANARY) over the settings defaults.
    cfg: {
      classMinDepthUsdg: 250,
      maxImpactBps: 300,
      slippageBps: 100,
      classExitAtGraduationPct: 85,
      classPerEntryUsdg: 5,
      scoutEnabled: true,
      scoutBudgetUsdg: 15,
      scoutPerTokenUsdg: 25,
    },
    // Harness-assigned starting profile until the settings fields exist.
    profile: { riskAppetite: "balanced", momentum: "confirming", liquidity: "prefer-deep", turnover: "medium", hold: "ride", convictionMin: 0.6, researchTopN: 3 },
    perTradeUsdg: 25,
  },
  {
    name: "SirSendIt",
    agentId: "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5",
    smartAccount: "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d",
    vault: "0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F",
    held: [HELD_LAUNCH],
    // DAVE_CLASS over the owner's own looser impact/slippage.
    cfg: {
      classMinDepthUsdg: 250,
      maxImpactBps: 500,
      slippageBps: 200,
      classExitAtGraduationPct: 85,
      classPerEntryUsdg: 5,
      scoutEnabled: true,
      scoutBudgetUsdg: 10,
      scoutPerTokenUsdg: 25,
    },
    profile: { riskAppetite: "aggressive", momentum: "early", liquidity: "thin-ok", turnover: "high", hold: "quick", convictionMin: 0.55, researchTopN: 3 },
    perTradeUsdg: 25,
  },
];

// ── args ────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const OUT = arg("out", path.join(process.cwd(), ".shadow-runs", String(Math.floor(Date.now() / 1000))))!;
const RPC = arg("rpc", process.env.RPC_URL ?? robinhoodChain.rpcUrls.default.http[0])!;
const BRAIN_URL = arg("brain-url", process.env.MERRYMEN_BRAIN_URL);
const BRAIN_TOKEN = arg("brain-token", process.env.MERRYMEN_BRAIN_TOKEN);
const TOP_N = Number(arg("top-n", "24"));
const NO_BRAIN = flag("no-brain");
const REPEAT = Math.max(1, Number(arg("repeat", "1")));
const EVERY_SEC = Math.max(30, Number(arg("every", "300")));
const REPLAY = arg("replay");
const AGENTS: AgentConfig[] = arg("agents") ? (JSON.parse(readFileSync(arg("agents")!, "utf8")) as AgentConfig[]) : DEFAULT_AGENTS;

const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) }) as PublicClient;
const USDG = CASH.USDG as `0x${string}`;

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** Bigints travel tagged so a saved snapshot replays byte-for-byte. */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x), 2);
const parse = <T,>(text: string): T =>
  JSON.parse(text, (_k, x) => (x && typeof x === "object" && typeof x.$bigint === "string" ? BigInt(x.$bigint) : x)) as T;
const usdg = (micro: number) => (micro / 1e6).toFixed(2);
const log = (m: string) => console.log(m);

// ── portfolio from the chain ────────────────────────────────────────────────

async function readPortfolio(a: AgentConfig, asOf: number): Promise<{ snapshot: PortfolioSnapshot; heldCostUsdg: bigint; notes: string[] }> {
  const notes: string[] = [];
  const cash = (await client.readContract({ address: USDG, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [a.smartAccount] })) as bigint;
  const positions: SnapshotPosition[] = [];
  let heldCost = 0n;
  for (const h of a.held) {
    const bal = (await client.readContract({ address: h.token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [a.vault] })) as bigint;
    if (bal <= 0n) {
      notes.push(`${h.symbol}: vault holds none now — treated as closed`);
      continue;
    }
    heldCost += BigInt(Math.round(h.costUsdg * 1e6));
    let value = 0;
    try {
      const threshold = await readCurveThreshold(client, h.curve);
      const r = threshold ? await readCurveReserves(client, { curve: h.curve, graduationThresholdRaw: threshold }, { quote: 6, token: 18 }) : null;
      const out = r ? curveSellOut(r, bal) : null;
      value = out === null ? 0 : Number(out);
      if (out === null) notes.push(`${h.symbol}: curve would not quote a sell — valued at zero`);
    } catch (e) {
      notes.push(`${h.symbol}: could not value (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    }
    positions.push({
      instrumentId: `pons:held:${h.symbol.toLowerCase()}`,
      symbol: h.symbol,
      qtyRaw: bal.toString(),
      valueUsdg: value,
      costBasisUsdg: Math.round(h.costUsdg * 1e6),
      priceSource: "pool",
      quarantined: false,
    });
  }
  const cashMicro = Number(cash);
  const equity = cashMicro + positions.reduce((s, p) => s + p.valueUsdg, 0);
  const snapshot = buildPortfolioSnapshot({
    agentId: a.agentId,
    asOf,
    epoch: 1,
    cashUsdg: cashMicro,
    // SHADOW ASSERTION: the book is treated as freshly contributed at today's
    // equity. Not read from the ledger — see the file header and the banner.
    netContributionsUsdg: equity,
    gasUsdg: null,
    positions,
    quality: {
      auditPassed: null,
      epoch: 1,
      currentAccountingHistoryAuditable: true,
      contributionsKnown: true,
      equityComplete: true,
      gasBasis: "net",
      positionHistoryAvailable: true,
      quarantinedAssetsPresent: false,
      assessedAt: asOf,
    },
    snapshotId: `shadow_${a.agentId.slice(2, 10)}_${asOf}`,
  });
  return { snapshot, heldCostUsdg: heldCost, notes };
}

async function marginalGasUsdg(): Promise<{ micro: number | null; note: string }> {
  try {
    const [gasPrice, round] = await Promise.all([
      client.getGasPrice(),
      client.readContract({ address: CASH_FEEDS.ETH_USD as `0x${string}`, abi: FEED_ABI, functionName: "latestRoundData" }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    ]);
    const eth8 = round[1];
    const v = expectedTradeGasUsdg({ gasUnits: STEADY_SWAP_GAS_UNITS, gasPriceWei: gasPrice, ethPrice8: eth8 });
    return {
      micro: v === null ? null : Number(v),
      note: `gas ${gasPrice} wei × ${STEADY_SWAP_GAS_UNITS} units at ETH ${(Number(eth8) / 1e8).toFixed(2)} USD`,
    };
  } catch (e) {
    return { micro: null, note: `could not price gas: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}` };
  }
}

// ── report ──────────────────────────────────────────────────────────────────

function candidateTable(s: TrendingSnapshot): string {
  const rows = s.candidates.map((c) => {
    const [w5, w15, w60] = [c.trend.windows[0]!, c.trend.windows[1]!, c.trend.windows[2]!];
    const age = c.ageSec === null ? "?" : `${Math.floor(c.ageSec / 60)}m`;
    const f = (x: number | null, dp = 2) => (x === null ? "?" : x.toFixed(dp));
    const quote = `${c.quote.symbol}${c.quotePriceStale ? " (stale)" : ""}`;
    return (
      `| ${c.id} | ${c.symbol} | ${quote} | ${c.quote.executable ? "yes" : "no"} | ${age} | ${c.depthUsd === null ? "?" : c.depthUsd.toFixed(0)} | ` +
      `${c.graduationBps === null ? "?" : (c.graduationBps / 100).toFixed(1)}% | ` +
      `${w5.trades}/${w15.trades}/${w60.trades} | ${w5.traders}/${w60.traders} | ` +
      `${f(c.trend.tradeAcceleration)}x | ${f(c.trend.volumeAcceleration)}x | ` +
      `${(Number(w60.volume) / 10 ** c.quoteDecimals).toPrecision(3)} | ${w5.imbalanceQuote === null ? "?" : ((w5.imbalanceQuote + 1) / 2 * 100).toFixed(0) + "%"} | ` +
      `${w15.momentum === null ? "?" : f(w15.momentum * 100, 1) + "%"} | ${c.trendingScore} |`
    );
  });
  return [
    "| id | symbol | quote | exec | age | depth USD | grad | trades 5m/15m/1h | traders 5m/1h | trade accel | vol accel | vol 1h (quote units) | buy share 5m | mom 15m | trend score |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function agentSection(run: AgentShadowRun, sim: ClassSimResult | null, portfolioNotes: string[]): string {
  const t = run.thresholds;
  const lines: string[] = [];
  lines.push(`## ${run.name}`);
  lines.push("");
  lines.push(
    `Profile: risk ${run.profile.riskAppetite}, momentum ${run.profile.momentum}, liquidity ${run.profile.liquidity}, ` +
      `turnover ${run.profile.turnover}, hold ${run.profile.hold}, conviction ≥ ${run.profile.convictionMin}, researches top ${run.profile.researchTopN}.`,
  );
  lines.push(
    `Deterministic prefilter (the owner's numbers, unchanged): depth ≥ ${usdg(Number(t.minRealDepthRaw))} USDG, ` +
      `round trip ≤ ${t.maxCostBps} bps, graduation ≤ ${(t.maxGraduationBps / 100).toFixed(0)}%, ` +
      `≥ ${t.minRecentTrades} trades in 15m. Entry size ${run.spendUsdg} USDG.`,
  );
  if (portfolioNotes.length) lines.push(`Portfolio notes: ${portfolioNotes.join("; ")}.`);
  lines.push("");
  lines.push("### Prefilter");
  lines.push("");
  lines.push("| id | symbol | verdict | reason / score |");
  lines.push("|---|---|---|---|");
  for (const l of run.legs) {
    lines.push(`| ${l.candidate.id} | ${l.candidate.symbol} (${l.candidate.quote.symbol}${l.executable ? "" : ", not executable"}) | ${l.ok ? "eligible" : `refused: ${l.refusal!.kind}`} | ${l.ok ? `score ${l.score}` : l.refusal!.reason} |`);
  }
  lines.push("");
  lines.push(
    `**Deterministic pick (\`chooseEntry\`, the existing path):** ` +
      (run.deterministicPick ? `${run.deterministicPick.symbol} (${run.deterministicPick.candidateId}), score ${run.deterministicPick.score}` : "none — nothing qualified"),
  );
  lines.push("");
  lines.push("### Profile ranking of the survivors");
  lines.push("");
  if (run.ranked.length === 0) lines.push("_no survivors to rank_");
  for (const [i, r] of run.ranked.entries()) lines.push(`${i + 1}. **${r.symbol}** (${r.key}) score ${r.score} — ${r.reasoning}`);
  lines.push("");
  lines.push("### Brain research");
  lines.push("");
  if (run.researched.length === 0) lines.push("_nothing researched_");
  for (const r of run.researched) {
    lines.push(`#### ${r.symbol} (${r.candidateId}), quoted in ${r.quoteSymbol}${r.executable ? "" : " — NOT executable on the live route"}, profile rank ${r.profileRank}`);
    lines.push("");
    if (r.result.ok) {
      const d = r.result.decision;
      lines.push(
        `- **${d.action.toUpperCase()}** · confidence ${d.confidence.toFixed(2)} · suggested ${usdg(d.suggested_delta_usdg)} USDG · ` +
          `gate ${d.gate_verdict ?? "?"}${d.hold_kind ? ` · ${d.hold_kind}` : ""} · depth ${d.depth_used} · ` +
          `${d.cost.model_calls} calls, $${d.cost.usd.toFixed(4)}, ${r.result.seconds.toFixed(1)}s`,
      );
      lines.push(`- Thesis: ${d.thesis}`);
      if (d.catalysts?.length) lines.push(`- Catalysts: ${d.catalysts.join(" · ")}`);
      if (d.risks.length) lines.push(`- Risks: ${d.risks.join(" · ")}`);
      if (d.invalidation.length) lines.push(`- Invalidation: ${d.invalidation.join(" · ")}`);
      if (d.analyst_views?.length) lines.push(`- Lenses: ${d.analyst_views.map((v) => `${v.lens} ${v.direction}/${v.confidence.toFixed(2)}`).join(", ")}`);
    } else {
      lines.push(`- **no decision** — ${r.result.kind}${"reason" in r.result ? ` ${r.result.reason}` : ""}: ${"detail" in r.result ? r.result.detail : ""}`);
    }
    lines.push("");
  }
  lines.push("### BrainDecision");
  lines.push("");
  const d = run.decision;
  if (d.action === "buy") {
    lines.push(`**BUY ${d.symbol}** (${d.candidateId}) · confidence ${d.confidence.toFixed(2)} · size ${d.sizeUsdg} USDG (deterministic; Brain suggested ${d.brainSuggestedUsdg ?? "?"}) · decision ${d.decisionId}`);
    lines.push("");
    lines.push(`> ${d.thesis}`);
    if (d.catalysts.length) lines.push(`> Catalysts: ${d.catalysts.join("; ")}`);
    if (d.invalidation.length) lines.push(`> Invalidated by: ${d.invalidation.join("; ")}`);
  } else {
    lines.push(`**HOLD** — ${d.holdWhy}`);
  }
  if (d.bestOpportunity) {
    const b = d.bestOpportunity;
    lines.push("");
    lines.push(
      `**Best opportunity across every quote:** ${b.symbol} (${b.candidateId}) quoted in ${b.quoteSymbol}, confidence ${b.confidence.toFixed(2)} — ` +
        (b.executable ? "executable on the live route." : `**NOT executable today**: ${b.executableWhy}`),
    );
    if (!b.executable) lines.push(`> ${b.thesis}`);
  } else if (d.action === "hold") {
    lines.push("");
    lines.push("**Best opportunity across every quote:** none cleared the profile's conviction floor.");
  }
  if (d.action === "buy" && d.holdWhy) lines.push(`\n_${d.holdWhy}_`);
  lines.push("");
  lines.push("### Deterministic policy");
  lines.push("");
  if (run.entry === null) lines.push("_no intent built (hold)_");
  else if (!run.entry.ok) lines.push(`Entry refused before the wall: ${run.entry.why}`);
  else {
    const e = run.entry;
    lines.push(`Entry: ${run.spendUsdg} USDG → ${e.quotedOutRaw} raw tokens quoted, impact ${e.impactBps} bps, floor ${run.intent!.kind === "curve-trade" ? run.intent!.minAmountOutRaw : "?"}, progress ${(e.progressBps / 100).toFixed(1)}%, round trip back ${usdg(Number(e.roundTripOutRaw))} USDG.`);
    lines.push(`checkPolicy: ${run.policy?.ok ? "**ALLOWED**" : `**REFUSED** (${run.policy && !run.policy.ok ? `${run.policy.rule}: ${run.policy.detail}` : "?"})`}`);
    lines.push(`Simulation (eth_simulateV1): ${sim === null ? "not run" : sim.ok ? `ok — ${sim.tokensOut} raw tokens out, ${sim.gasUsed} gas` : `refused — ${sim.reason}`}`);
  }
  lines.push("");
  lines.push(`**Agrees with the deterministic path:** ${run.agreesWithDeterministic ? "yes" : "NO"}`);
  lines.push("");
  return lines.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

async function runOnce(
  OUT: string,
  brain: { url: string; token: string } | null,
): Promise<{ snapshot: TrendingSnapshot; runs: { run: AgentShadowRun; sim: ClassSimResult | null }[] }> {
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const snapshot: TrendingSnapshot = REPLAY
    ? parse<TrendingSnapshot>(readFileSync(REPLAY, "utf8"))
    : await buildTrendingSnapshot({ client, usdg: USDG, topN: TOP_N });
  if (REPLAY) log(`[shadow] REPLAYING saved snapshot ${REPLAY}`);
  log(
    `[shadow] snapshot ${snapshot.id} · head ${snapshot.head} · ${snapshot.secPerBlock.toFixed(4)} s/block${snapshot.clockMeasured ? "" : " (FALLBACK)"} · ` +
      `${snapshot.launches} launches in ${snapshot.launchLookbackBlocks} blocks · tape ${snapshot.tape.trades} trades, ${snapshot.tape.holes.length} holes · ` +
      `${snapshot.tradedCurves} curves traded · ${snapshot.candidates.length} candidates, ${snapshot.candidates.length - snapshot.unexecutable} executable · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  writeFileSync(path.join(OUT, "snapshot.json"), json(snapshot));

  const gas = await marginalGasUsdg();
  log(`[shadow] marginal gas ${gas.micro === null ? "unknown" : usdg(gas.micro) + " USDG"} (${gas.note})`);

  const knownCurves = [...new Set([...snapshot.candidates.map((c) => c.curve.toLowerCase()), ...AGENTS.flatMap((a) => a.held.map((h) => h.curve.toLowerCase()))])];
  const nowSec = Math.floor(Date.now() / 1000);
  const runs: { run: AgentShadowRun; sim: ClassSimResult | null; notes: string[] }[] = [];

  for (const a of AGENTS) {
    const { snapshot: portfolio, heldCostUsdg, notes } = await readPortfolio(a, snapshot.asOf);
    const limits: AgentLimits = {
      perTradeUsdg: BigInt(Math.round(a.perTradeUsdg * 1e6)),
      dailyUsdg: BigInt(Math.round(a.perTradeUsdg * 4 * 1e6)),
      allowedTargets: [a.vault, USDG],
      allowedAssets: [USDG],
      sellableAssets: [USDG.toLowerCase(), ...a.held.map((h) => h.token.toLowerCase())],
      curveAdapters: [],
      ponsClassVault: a.vault.toLowerCase(),
      knownCurves,
      quoteAssets: [USDG.toLowerCase()],
      cashToken: USDG.toLowerCase(),
      maxDrawdownBps: 10_000,
      expiresAt: nowSec + 7 * 86_400,
      maxOpsPerDay: 100,
    } as AgentLimits;
    const state: AgentState = {
      spentTodayUsdg: 0n,
      opsToday: 0,
      highWaterMarkUsdg: BigInt(portfolio.equityUsdg),
      equityUsdg: BigInt(portfolio.equityUsdg),
      equityKnown: true,
      nowSec,
    };
    const agent: TrendingAgent = {
      agentId: a.agentId,
      name: a.name,
      profile: parseProfile(a.profile as Record<string, unknown>),
      vault: a.vault,
      cfg: a.cfg,
      limits,
      state,
      heldClassCostUsdg: heldCostUsdg,
      portfolio,
      memory: [],
    };
    log(`[shadow] ${a.name}: cash ${usdg(portfolio.cashUsdg)} USDG, equity ${usdg(portfolio.equityUsdg)} USDG, ${portfolio.positions.length} class position(s) worth ${usdg(portfolio.positionsUsdg)} USDG, held cost ${usdg(Number(heldCostUsdg))} USDG`);
    const t1 = Date.now();
    const run = await researchForAgent(snapshot, agent, {
      brain,
      expectedTradeGasUsdg: gas.micro,
      runId: `shadow-${snapshot.head}-${a.name.toLowerCase()}`,
      now: () => Math.floor(Date.now() / 1000),
    });
    log(
      `[shadow] ${a.name}: ${run.legs.filter((l) => l.ok).length}/${run.legs.length} eligible · deterministic ${run.deterministicPick?.symbol ?? "none"} · ` +
        `brain ${run.decision.action === "buy" ? `BUY ${run.decision.symbol} @${run.decision.confidence.toFixed(2)}` : "HOLD"} · ` +
        `policy ${run.policy ? (run.policy.ok ? "allowed" : `refused ${run.policy.rule}`) : "n/a"} · agrees ${run.agreesWithDeterministic} · ${((Date.now() - t1) / 1000).toFixed(1)}s`,
    );

    let sim: ClassSimResult | null = null;
    if (run.intent && run.policy?.ok && run.intent.kind === "curve-trade") {
      const code = await client.getCode({ address: a.vault });
      if (!code || code === "0x") sim = { ok: false, reason: "vault not deployed" };
      else {
        const calls = buildClassBuyCalls({
          vault: a.vault,
          curve: run.intent.curve,
          quoteAsset: run.intent.assetIn,
          quoteInRaw: run.intent.amountInRaw,
          minTokensOutRaw: run.intent.minAmountOutRaw,
          deadline: BigInt(nowSec + 600),
        });
        sim = await simulateClassBuy({ client, account: a.smartAccount, calls });
        log(`[shadow] ${a.name}: simulation ${sim.ok ? `ok, ${sim.tokensOut} tokens out` : `refused — ${sim.reason}`}`);
      }
    }
    runs.push({ run, sim, notes });
    writeFileSync(path.join(OUT, `run-${a.name.toLowerCase()}.json`), json({ run, sim, notes }));
  }

  // ── the report ────────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# Trending Brain — shadow run ${snapshot.id}`);
  md.push("");
  md.push(`Head block ${snapshot.head} at ${new Date(snapshot.asOf * 1000).toISOString()} · ${snapshot.secPerBlock.toFixed(4)} s/block${snapshot.clockMeasured ? " (measured)" : " (FALLBACK, clock unread)"} · windows ${snapshot.windowsSec.map((w) => `${w / 60}m`).join("/")}.`);
  md.push(`Launch set: ${snapshot.launches} launches over ${snapshot.launchLookbackBlocks} blocks${snapshot.launchScanClamped ? " (clamped)" : ""}. Tape: ${snapshot.tape.trades} trades over blocks ${snapshot.tape.from}–${snapshot.tape.to}, ${snapshot.tape.holes.length} hole(s)${snapshot.tape.holes.length ? ` (${snapshot.tape.holes.map((h) => `${h.from}–${h.to} ${h.why}`).join(", ")})` : ""}. ${snapshot.tradedCurves} launch-set curves traded; the top ${snapshot.candidates.length} by trending score were read across every quote asset — ${snapshot.candidates.length - snapshot.unexecutable} of them executable on the live route (USDG-quoted).`);
  md.push(`Brain: ${brain ? `${BRAIN_URL}` : "NOT ASKED — deterministic dry run"}. Marginal gas: ${gas.micro === null ? "unknown" : usdg(gas.micro) + " USDG"} (${gas.note}).`);
  md.push("");
  md.push("> **Shadow assertions.** Nothing was executed. Grant limits are the class-route PRESETS, not the sealed grant. The portfolio quality flags handed to the Brain assert a clean, freshly contributed book so its gate opens and selection can be observed — they are not read from the ledger. The research universe is every quote asset; the live execution universe is still USDG only.");
  md.push("");
  md.push("## The snapshot both agents saw");
  md.push("");
  md.push(`Where the hour's trading was, by quote asset: ${snapshot.quoteBreakdown.map((q) => `${q.quote} ${q.curves} curves / ${q.trades} trades${q.executable ? "" : " (not executable)"}`).join(" · ")}.`);
  md.push("");
  md.push(`Quote prices used: ${snapshot.quotes.map((q) => `${q.asset.symbol} ${q.price ? (Number(q.price.usd8) / 1e8).toFixed(2) + " USD" + (q.price.stale ? " (STALE)" : "") : "unpriced"}`).join(" · ")}.`);
  md.push("");
  md.push(candidateTable(snapshot));
  md.push("");
  for (const { run, sim, notes } of runs) md.push(agentSection(run, sim, notes));
  md.push("## Side by side");
  md.push("");
  md.push("| | " + runs.map((r) => r.run.name).join(" | ") + " |");
  md.push("|---|" + runs.map(() => "---").join("|") + "|");
  const row = (label: string, f: (r: { run: AgentShadowRun; sim: ClassSimResult | null }) => string) => md.push(`| ${label} | ${runs.map(f).join(" | ")} |`);
  row("eligible after prefilter", (r) => `${r.run.legs.filter((l) => l.ok).length} of ${r.run.legs.length}`);
  row("deterministic pick", (r) => r.run.deterministicPick?.symbol ?? "none");
  row("profile #1", (r) => r.run.ranked[0]?.symbol ?? "none");
  row("best opportunity (any quote)", (r) =>
    r.run.decision.bestOpportunity
      ? `${r.run.decision.bestOpportunity.symbol} in ${r.run.decision.bestOpportunity.quoteSymbol} @${r.run.decision.bestOpportunity.confidence.toFixed(2)}${r.run.decision.bestOpportunity.executable ? "" : " (NOT executable)"}`
      : "none",
  );
  row("Brain decision (executable only)", (r) => (r.run.decision.action === "buy" ? `BUY ${r.run.decision.symbol} @${r.run.decision.confidence.toFixed(2)}` : "HOLD"));
  row("policy", (r) => (r.run.policy ? (r.run.policy.ok ? "allowed" : `refused ${r.run.policy.rule}`) : "—"));
  row("simulation", (r) => (r.sim ? (r.sim.ok ? "ok" : "refused") : "—"));
  row("agrees with deterministic", (r) => (r.run.agreesWithDeterministic ? "yes" : "no"));
  md.push("");
  const report = md.join("\n");
  writeFileSync(path.join(OUT, "report.md"), report);
  log(`\n${report}`);
  log(`\n[shadow] written to ${OUT}`);
  return { snapshot, runs };
}

async function main() {
  const brain = !NO_BRAIN && BRAIN_URL && BRAIN_TOKEN ? { url: BRAIN_URL, token: BRAIN_TOKEN } : null;
  log(`[shadow] rpc ${RPC} · brain ${brain ? BRAIN_URL : "NONE (deterministic dry run)"} · out ${OUT} · repeat ${REPEAT} every ${EVERY_SEC}s`);
  mkdirSync(OUT, { recursive: true });
  const rollup = path.join(OUT, "rollup.md");
  if (REPEAT > 1) {
    writeFileSync(
      rollup,
      "| run | head | candidates (exec) | " +
        AGENTS.map((a) => `${a.name} eligible | ${a.name} deterministic | ${a.name} best (any quote) | ${a.name} Brain | ${a.name} policy | ${a.name} agrees`).join(" | ") +
        " |\n|---|---|---|" +
        AGENTS.map(() => "---|---|---|---|---|---").join("|") +
        "|\n",
    );
  }
  for (let i = 0; i < REPEAT; i++) {
    const started = Date.now();
    const dir = REPEAT > 1 ? path.join(OUT, String(i + 1).padStart(3, "0")) : OUT;
    try {
      const { snapshot, runs } = await runOnce(dir, brain);
      if (REPEAT > 1) {
        const cells = runs.map(
          ({ run }) =>
            `${run.legs.filter((l) => l.ok).length}/${run.legs.length} | ${run.deterministicPick?.symbol ?? "none"} | ` +
            `${run.decision.bestOpportunity ? `${run.decision.bestOpportunity.symbol} in ${run.decision.bestOpportunity.quoteSymbol} @${run.decision.bestOpportunity.confidence.toFixed(2)}${run.decision.bestOpportunity.executable ? "" : " (NOT exec)"}` : "none"} | ` +
            `${run.decision.action === "buy" ? `BUY ${run.decision.symbol} @${run.decision.confidence.toFixed(2)}` : "HOLD"} | ` +
            `${run.policy ? (run.policy.ok ? "allowed" : `refused ${run.policy.rule}`) : "—"} | ${run.agreesWithDeterministic ? "yes" : "NO"}`,
        );
        writeFileSync(rollup, `| ${i + 1} | ${snapshot.head} | ${snapshot.candidates.length} (${snapshot.candidates.length - snapshot.unexecutable}) | ${cells.join(" | ")} |\n`, { flag: "a" });
      }
    } catch (e) {
      log(`[shadow] run ${i + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (REPEAT > 1) writeFileSync(rollup, `| ${i + 1} | failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e)} |\n`, { flag: "a" });
    }
    if (i + 1 < REPEAT) {
      const wait = Math.max(0, EVERY_SEC * 1000 - (Date.now() - started));
      log(`[shadow] next snapshot in ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

main().catch((e) => {
  console.error("[shadow] failed:", e);
  process.exit(1);
});
