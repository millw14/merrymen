/**
 * THE SHADOW DATASET, read back out of the tape.
 *
 * Every field here is already persisted — `brain-shadow.ts` writes the whole
 * decision into `decisions.signals_json` on every run. What was missing was any
 * way to READ it: shared Postgres is private-network-only, and `railway logs`
 * is a 503-line snapshot that a fleet of 24 children fills in about a minute.
 * Thirty decisions collected over an afternoon are durable in the database and
 * invisible to anybody trying to look at them.
 *
 * So this is the read side, and it is deliberately a REPORT rather than an
 * export: the questions it answers are the ones a cohort is being run to
 * answer, and each one is a column somebody has to be able to argue with.
 *
 *   does Brain produce differentiated opinions across agents and assets?
 *   does it HOLD for good reasons, or out of generic caution?
 *   does confidence move with evidence?
 *   how often is execution economics the reason not to trade?
 *
 * THE DISTINCTION THE WHOLE THING TURNS ON is between a hold that means "the
 * evidence says stay out" and a hold that means "there was nothing to read".
 * Those are the same word and completely different findings, and the analyst
 * verdicts are what separate them: a run where every lens returned `no-data` is
 * a blind run, and counting it as a considered hold would flatter the reasoner
 * for a failure of the pipeline in front of it.
 *
 * PURE. It is handed rows and returns strings.
 */

export interface ShadowRun {
  agentId: string;
  agentName: string;
  at: number;
  symbol: string | null;
  action: string | null;
  sizeUsdg: number | null;
  thesis: string | null;
  /** The parsed `signals_json`, or an empty object when it could not be read. */
  signals: Record<string, unknown>;
}

/** How much the analysts actually had to work with. */
export type Visibility = "blind" | "thin" | "informed";

export interface RunView {
  agentId: string;
  agentName: string;
  at: number;
  symbol: string;
  instrumentId: string;
  trigger: string;
  action: string;
  confidence: number;
  deltaUsdg: number;
  lenses: { lens: string; direction: string; confidence: number }[];
  visibility: Visibility;
  escalated: boolean;
  escalationReasons: string[];
  depth: string;
  thesis: string;
  expectedEdgeUsdg: number | null;
  expectedGasUsdg: number | null;
  economics: string;
  /** Gas as a percentage of the trade it proposed. Null for a hold. */
  gasShareOfTradePct: number | null;
  calls: number;
  tokens: number;
  usd: number;
  seconds: number;
  executorCalls: number;
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

/** Read one persisted run. NEVER throws — a malformed row is still a row. */
export function viewRun(r: ShadowRun): RunView {
  const s = r.signals;
  const cost = (s.cost ?? {}) as Record<string, unknown>;
  const rawLenses = Array.isArray(s.analyst_views) ? (s.analyst_views as Record<string, unknown>[]) : [];
  const lenses = rawLenses.map((v) => ({
    lens: str(v.lens, "?"),
    direction: str(v.direction, "no-data"),
    confidence: num(v.confidence),
  }));

  // BLIND, THIN OR INFORMED — the distinction the dataset exists to draw.
  // A run where every lens returned `no-data` did not decide to hold; it had
  // nothing to decide with, and counting it as a considered hold would credit
  // the reasoner for a failure of the pipeline in front of it.
  const withData = lenses.filter((l) => l.direction !== "no-data").length;
  const visibility: Visibility = lenses.length === 0 || withData === 0 ? "blind" : withData === 1 ? "thin" : "informed";

  const escalationReasons = Array.isArray(s.escalation_reasons) ? (s.escalation_reasons as string[]) : [];
  const delta = num(s.suggested_delta_usdg);
  const gas = s.expected_trade_gas_usdg === null || s.expected_trade_gas_usdg === undefined
    ? null
    : num(s.expected_trade_gas_usdg);
  const edge = s.expected_edge_usdg === null || s.expected_edge_usdg === undefined ? null : num(s.expected_edge_usdg);

  return {
    agentId: r.agentId,
    agentName: r.agentName,
    at: r.at,
    symbol: r.symbol ?? "?",
    instrumentId: str(s.instrument_id, "?"),
    trigger: str(s.trigger_reason, "?"),
    // REFUSED IS NOT A TRADE, and it is not a hold either.
    //
    // A run that produced no decision writes a row with NO action field at all
    // — deliberately, so that "decided nothing" and "decided, with no size" are
    // different row shapes. Mapping that absence to a placeholder and then
    // testing `!== "hold"` counted every refusal as a BUY/SELL: the first live
    // report announced "1 BUY/SELL, size 0.000000 USDG", which was a refusal
    // wearing a trade's clothes. A report that invents a trade is worse than no
    // report, because this one exists to answer whether Brain ever proposes one.
    action:
      r.action === null || r.action === undefined || r.action === "" ? "refused" : r.action.toLowerCase(),
    confidence: num(s.confidence),
    deltaUsdg: delta,
    lenses,
    visibility,
    escalated: escalationReasons.length > 0,
    escalationReasons,
    depth: str(s.depth_used, "?"),
    thesis: (r.thesis ?? "").replace(/\s+/g, " ").trim(),
    expectedEdgeUsdg: edge,
    expectedGasUsdg: gas,
    economics: str(s.economics, "unknown"),
    // Gas against the size it actually proposed — the number that decides
    // whether a trade is worth making, and meaningless for a hold.
    gasShareOfTradePct:
      gas !== null && Math.abs(delta) > 0 ? (gas / Math.abs(delta)) * 100 : null,
    calls: num(cost.model_calls),
    tokens: num(cost.tokens_in) + num(cost.tokens_out),
    usd: num(cost.usd),
    seconds: num(s.latency_seconds),
    executorCalls: num(s.executor_calls),
  };
}

const pct = (n: number, of: number): string => (of === 0 ? "—" : `${((n / of) * 100).toFixed(0)}%`);
const usdg = (micro: number): string => (micro / 1e6).toFixed(6);

/**
 * The report. One block per agent, then the fleet answers.
 *
 * Ordered oldest-first within an agent, because the question "did confidence
 * move with evidence?" is a question about a sequence.
 */
export function datasetLines(runs: readonly RunView[]): string[] {
  const out: string[] = [];
  if (runs.length === 0) return ["no shadow decisions recorded yet"];

  const byAgent = new Map<string, RunView[]>();
  for (const r of runs) {
    const k = `${r.agentId}|${r.agentName}`;
    (byAgent.get(k) ?? byAgent.set(k, []).get(k)!).push(r);
  }

  for (const [key, rs] of byAgent) {
    const [id, name] = key.split("|");
    rs.sort((a, b) => a.at - b.at);
    out.push(`${id!.slice(0, 10)}… ${name} — ${rs.length} decision(s)`);
    for (const r of rs) {
      const when = new Date(r.at * 1000).toISOString().slice(11, 19);
      out.push(
        `  ${when} ${r.action.toUpperCase().padEnd(4)} ${r.symbol.padEnd(6)} conf ${r.confidence.toFixed(2)} ` +
          `delta ${r.deltaUsdg} · ${r.visibility.padEnd(8)} · ${r.trigger.padEnd(17)} ` +
          `· ${r.depth}${r.escalated ? ` (escalated: ${r.escalationReasons.join(",")})` : ""} ` +
          `· ${r.calls}c ${r.tokens}t $${r.usd.toFixed(4)} ${r.seconds.toFixed(1)}s`,
      );
      out.push(`      lenses ${r.lenses.map((l) => `${l.lens}:${l.direction}`).join(" ") || "none recorded"}`);
      if (r.action === "buy" || r.action === "sell") {
        out.push(
          `      economics ${r.economics} · edge ${r.expectedEdgeUsdg ?? "—"} vs gas ${r.expectedGasUsdg ?? "—"} ` +
            `micro-USDG` +
            (r.gasShareOfTradePct === null ? "" : ` = ${r.gasShareOfTradePct.toFixed(1)}% of the proposed size`),
        );
      }
      if (r.thesis) out.push(`      "${r.thesis.slice(0, 160)}${r.thesis.length > 160 ? "…" : ""}"`);
    }
  }

  // ── THE ANSWERS ──────────────────────────────────────────────────────────
  const n = runs.length;
  const count = <T extends string>(f: (r: RunView) => T): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const r of runs) m[f(r)] = (m[f(r)] ?? 0) + 1;
    return m;
  };

  const actions = count((r) => r.action);
  const vis = count((r) => r.visibility);
  const econ = count((r) => (r.action === "buy" || r.action === "sell" ? r.economics : `n/a (${r.action})`));
  // ONLY AN EXPLICIT BUY OR SELL IS A TRADE. A hold is not, a refusal is not,
  // and an action nobody recognises is certainly not.
  const trades = runs.filter((r) => r.action === "buy" || r.action === "sell");
  const refused = runs.filter((r) => r.action === "refused").length;
  const escalated = runs.filter((r) => r.escalated).length;

  const conf = runs.map((r) => r.confidence).sort((a, b) => a - b);
  const median = conf.length ? conf[Math.floor(conf.length / 2)]! : 0;
  const lensDirs: Record<string, number> = {};
  for (const r of runs) for (const l of r.lenses) lensDirs[l.direction] = (lensDirs[l.direction] ?? 0) + 1;

  out.push(`─── ${n} decision(s) across ${byAgent.size} agent(s) ───`);
  out.push(`actions        ${JSON.stringify(actions)}`);
  out.push(
    `visibility     ${JSON.stringify(vis)}  ` +
      `— blind means EVERY lens returned no-data, which is not a considered hold`,
  );
  out.push(`lens verdicts  ${JSON.stringify(lensDirs)}`);
  out.push(
    `confidence     median ${median.toFixed(2)} · min ${(conf[0] ?? 0).toFixed(2)} · max ${(conf[conf.length - 1] ?? 0).toFixed(2)}`,
  );
  out.push(`escalated      ${escalated} of ${n} (${pct(escalated, n)})`);
  out.push(`refused        ${refused} — runs that produced no decision at all`);
  out.push(`economics      ${JSON.stringify(econ)}`);
  out.push(
    `cost           ${(runs.reduce((s, r) => s + r.usd, 0)).toFixed(4)} USD total · ` +
      `mean ${(runs.reduce((s, r) => s + r.calls, 0) / n).toFixed(1)} calls, ` +
      `${(runs.reduce((s, r) => s + r.seconds, 0) / n).toFixed(1)}s`,
  );

  // HOLDS, SPLIT BY WHY. The headline number of the whole exercise.
  const holds = runs.filter((r) => r.action === "hold");
  const blindHolds = holds.filter((r) => r.visibility === "blind").length;
  out.push(
    `holds          ${holds.length} — ${blindHolds} with NOTHING to read, ` +
      `${holds.length - blindHolds} with at least one lens reporting`,
  );

  if (trades.length) {
    const shares = trades.map((r) => r.gasShareOfTradePct).filter((x): x is number => x !== null);
    out.push(
      `BUY/SELL       ${trades.length} — sizes ${trades.map((r) => usdg(Math.abs(r.deltaUsdg))).join(", ")} USDG` +
        (shares.length ? ` · gas ${shares.map((s) => `${s.toFixed(1)}%`).join(", ")} of size` : ""),
    );
  } else {
    out.push(`BUY/SELL       none yet — every decision so far is a hold`);
  }

  // SAFETY, stated every time rather than assumed.
  const exec = runs.reduce((s, r) => s + r.executorCalls, 0);
  out.push(`EXECUTOR CALLS ${exec} — must be exactly 0 while execution is disconnected`);
  return out;
}
