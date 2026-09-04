/**
 * WHAT IS ACTUALLY IN THE SHARED LEDGER, AND WHAT A REPAIR WOULD DO TO IT.
 *
 * READ ONLY. Nothing here writes, and it is deliberately not `repair.mjs`: this
 * is the thing you run first, and the numbers it prints are what a repair
 * decision has to be made against.
 *
 * WHY IT LIVES IN THE ORCHESTRATOR rather than in the spike script beside it.
 * The shared Postgres is reachable only from inside Railway's private network —
 * `DATABASE_URL` names `postgres.railway.internal`, and there is no public
 * proxy — so `railway run` executes on a laptop that cannot resolve it. The
 * orchestrator is already in there, already holds the URL, and already has a log
 * channel an operator reads. Gated behind an env var and off by default, because
 * a fleet-wide financial dump is not something a routine boot should emit.
 *
 * TWO MECHANISMS PUT WRONG NUMBERS HERE, and they compound:
 *
 *   THE WORKER booked the whole balance as an opening contribution on every
 *   redeploy, because a hosted child's SQLite is discarded by the container and
 *   the accounting read that emptiness as "this money just arrived".
 *
 *   THE MIRROR, finding its watermark row gone after a rebuild, rewound its
 *   cursor to zero and re-copied rows 1..N into a table with no unique key and
 *   an INSERT with no ON CONFLICT. The orchestrator has been logging this as
 *   CURSOR REWOUND the whole time.
 *
 * The first is fixed. The second is a data problem, which is what this measures.
 */
import type { Db } from "./db";
import { isEvidencedFlow } from "./accounting-scope";

/** One flow row, as an auditor needs to see it. */
export interface FlowRowView {
  id: number;
  epoch: number;
  direction: string;
  amountUsdg: number;
  source: string;
  /** Presence, not the hash — a preview is about shape, and the hash is long. */
  hasTx: boolean;
  txHash: string | null;
  at: number;
}

export interface AgentDiagnosis {
  /** The ledger key. Every table is on this. */
  smartAccount: string;
  /** The owner address that signed the grant — a DIFFERENT string, kept separate. */
  ownerAddress: string | null;
  epoch: number;
  /** Newest equity mark in this epoch, when there is one. */
  navUsdg: number | null;
  hwmUsdg: number;

  flowRows: FlowRowView[];
  totalRows: number;
  /** Σ over rows that are receipts or reconciling epoch bridges. */
  evidencedUsdg: number;
  /** Σ over everything else — the part nobody can point at. */
  unevidencedUsdg: number;
  unevidencedRows: number;

  /**
   * Inbound rows with no evidence. Every phantom opening balance is one; so is
   * every legitimate deposit made while the deposit scan was off, and nothing in
   * the row separates them.
   */
  suspectedPhantomDeposits: number;
  /** Outbound rows with no evidence — the shape behind a large negative total. */
  suspectedPhantomWithdrawals: number;

  contributionsBeforeUsdg: number;
  contributionsAfterUsdg: number;

  /** Duplicate copies of a tx-hashed flow. Unambiguous: one tx cannot deposit twice. */
  duplicateRows: number;

  /**
   * The reason a safe correction CANNOT be proposed, when there is one.
   *
   * Null means the proposal is safe on its own terms. It still has to be checked
   * against the chain, which this function cannot do — it has a database handle,
   * not an RPC — so a null here is a necessary condition, never a sufficient one.
   */
  unsafe: string | null;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Measure every agent that has any flow row. Never throws.
 *
 * One query per table rather than per agent: the fleet is two dozen tenants and
 * a per-agent loop over five tables is a hundred round trips on a database the
 * orchestrator shares with everything else it does.
 */
export async function diagnoseAccounting(shared: Db): Promise<AgentDiagnosis[]> {
  const flows = (await shared
    .prepare(
      `SELECT id, agent_id, epoch, direction, amount_usdg, source, tx_hash, at
         FROM flows ORDER BY agent_id, epoch, at, id`,
    )
    .all()) as unknown as Record<string, unknown>[];

  const agents = (await shared
    .prepare("SELECT smart_account, owner_address, epoch, hwm_usdg FROM agents")
    .all()) as unknown as Record<string, unknown>[];
  const byAccount = new Map(agents.map((a) => [String(a.smart_account).toLowerCase(), a]));

  const equity = (await shared
    .prepare(
      `SELECT agent_id, epoch, equity_usdg, at FROM equity
        ORDER BY agent_id, epoch, at DESC, id DESC`,
    )
    .all()) as unknown as Record<string, unknown>[];
  /** Newest mark per (account, epoch) — the first row of each group, given the ORDER BY. */
  const navBy = new Map<string, number>();
  for (const e of equity) {
    const k = `${String(e.agent_id).toLowerCase()}#${num(e.epoch)}`;
    if (!navBy.has(k)) navBy.set(k, num(e.equity_usdg));
  }

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const f of flows) {
    const k = String(f.agent_id).toLowerCase();
    const list = grouped.get(k);
    if (list) list.push(f);
    else grouped.set(k, [f]);
  }

  const out: AgentDiagnosis[] = [];
  for (const [account, rows] of grouped) {
    const agent = byAccount.get(account);
    const epoch = num(agent?.epoch) || 1;

    // EPOCH-SCOPED, like every other contribution reader. Rows in a closed epoch
    // are kept for forensics and excluded from the figure.
    const inEpoch = rows.filter((r) => num(r.epoch) === epoch);

    const view: FlowRowView[] = inEpoch.map((r) => ({
      id: num(r.id),
      epoch: num(r.epoch),
      direction: String(r.direction),
      amountUsdg: num(r.amount_usdg),
      source: String(r.source ?? ""),
      hasTx: typeof r.tx_hash === "string" && r.tx_hash.length > 0,
      txHash: typeof r.tx_hash === "string" && r.tx_hash ? r.tx_hash : null,
      at: num(r.at),
    }));

    const signed = (r: FlowRowView) => (r.direction === "in" ? r.amountUsdg : -r.amountUsdg);
    const evidenced = view.filter((r) => isEvidencedFlow(r.source) || r.hasTx);
    const unevidenced = view.filter((r) => !(isEvidencedFlow(r.source) || r.hasTx));

    // A tx-hashed row copied more than once is the mirror rewind, not a second
    // deposit. Counted separately because removing it is unambiguous.
    const seen = new Map<string, number>();
    let duplicateRows = 0;
    for (const r of view) {
      if (!r.hasTx) continue;
      const k = `${r.direction}|${r.amountUsdg}|${String(r.txHash).toLowerCase()}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > 1) duplicateRows += 1;
    }

    const before = view.reduce((s, r) => s + signed(r), 0);
    const after = evidenced.reduce((s, r) => s + signed(r), 0);

    const nav = navBy.get(`${account}#${epoch}`) ?? null;

    // WHEN A CORRECTION CANNOT BE PROPOSED SAFELY. Each of these is a case where
    // quarantining the unevidenced rows would leave a figure that is worse than
    // the wrong one it replaces.
    let unsafe: string | null = null;
    if (evidenced.length === 0 && nav !== null && nav > 0) {
      unsafe =
        "no evidenced contribution row at all, but the account holds value — quarantining would leave " +
        "contributions at zero, and equity minus zero is the owner's principal published as profit";
    } else if (after < 0) {
      unsafe =
        `the evidenced total is negative (${after.toFixed(6)} USDG) — more evidenced outflow than inflow, ` +
        "which cannot be a contribution figure and means the evidenced rows are themselves incomplete";
    }

    out.push({
      smartAccount: String(agent?.smart_account ?? account),
      ownerAddress: typeof agent?.owner_address === "string" ? agent.owner_address : null,
      epoch,
      navUsdg: nav,
      hwmUsdg: num(agent?.hwm_usdg),
      flowRows: view,
      totalRows: view.length,
      evidencedUsdg: after,
      unevidencedUsdg: before - after,
      unevidencedRows: unevidenced.length,
      suspectedPhantomDeposits: unevidenced.filter((r) => r.direction === "in").length,
      suspectedPhantomWithdrawals: unevidenced.filter((r) => r.direction !== "in").length,
      contributionsBeforeUsdg: before,
      contributionsAfterUsdg: after,
      duplicateRows,
      unsafe,
    });
  }
  out.sort((a, b) => Math.abs(b.unevidencedUsdg) - Math.abs(a.unevidencedUsdg));
  return out;
}

/**
 * The preview, as lines an operator reads before approving anything.
 *
 * Every affected agent gets its rows listed individually, because "quarantine 3
 * rows" is not a thing anybody can consent to without seeing which three.
 */
export function diagnosisLines(all: AgentDiagnosis[]): string[] {
  const L: string[] = [];
  const f = (n: number) => n.toFixed(6);
  const affected = all.filter((a) => a.unevidencedRows > 0 || a.duplicateRows > 0);

  L.push(`ACCOUNTING DIAGNOSIS — ${all.length} agent(s) with flow rows, ${affected.length} affected`);
  L.push(
    `fleet unevidenced total: ${f(all.reduce((s, a) => s + a.unevidencedUsdg, 0))} USDG ` +
      `across ${all.reduce((s, a) => s + a.unevidencedRows, 0)} row(s)`,
  );
  L.push("");

  for (const a of all) {
    const known = a.unevidencedRows === 0;
    L.push(`── ${a.smartAccount}`);
    L.push(`   owner ${a.ownerAddress ?? "unknown"}   epoch ${a.epoch}`);
    L.push(
      `   NAV ${a.navUsdg === null ? "unknown" : f(a.navUsdg)}   hwm ${f(a.hwmUsdg)}   ` +
        `rows ${a.totalRows} (unevidenced ${a.unevidencedRows}, duplicates ${a.duplicateRows})`,
    );
    L.push(
      `   suspected phantom deposits ${a.suspectedPhantomDeposits}   ` +
        `withdrawals ${a.suspectedPhantomWithdrawals}`,
    );
    L.push(`   contributions ${f(a.contributionsBeforeUsdg)} -> ${f(a.contributionsAfterUsdg)} USDG`);
    L.push(
      `      evidenced ${f(a.evidencedUsdg)} · unevidenced ${f(a.unevidencedUsdg)}`,
    );
    for (const r of a.flowRows) {
      L.push(
        `      id ${String(r.id).padStart(6)} e${r.epoch} ${r.direction.padEnd(3)} ` +
          `${f(r.amountUsdg).padStart(14)} src ${r.source.padEnd(15)} ` +
          `tx ${r.hasTx ? String(r.txHash).slice(0, 12) + "…" : "NONE"} ` +
          `${isEvidencedFlow(r.source) || r.hasTx ? "KEEP" : "QUARANTINE"}`,
      );
    }
    // The resulting quality, by the same rule the worker applies.
    L.push(
      `   after repair: contributionsKnown ${known || a.unevidencedRows > 0 ? (a.unevidencedRows > 0 ? "true (once quarantined)" : "true") : "true"}` +
        `   PnL publishable ${a.unsafe === null && a.navUsdg !== null ? "yes" : "NO"}`,
    );
    if (a.unsafe) L.push(`   !! CANNOT PROPOSE A SAFE CORRECTION: ${a.unsafe}`);
    L.push("");
  }
  return L;
}
