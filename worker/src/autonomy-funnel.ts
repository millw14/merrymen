/**
 * THE FLEET'S AUTONOMY FUNNEL, AS THE OPERATOR READS IT: which rail an agent
 * is really on, which stage turned a proposal back, and which "holds" were
 * decisions at all.
 *
 * Pure: the SQL it needs is here as text, and everything else is a fold over
 * rows somebody else read. The orchestrator reads (collectFleetSnapshot) and
 * prints; this decides what the rows mean, where a test can run it.
 *
 * THREE THINGS THE ONE-LINE FUNNEL GOT WRONG, all read off a real hour
 * (2026-10-03T20:45Z): `11 live · proposals 194 · policy-passed 9 · userops 0
 * · LANDED 0 … 369 unreported`, refusals `no-exit 185`.
 *
 *  1. "11 live" WAS STALE. It grouped `agents.mode` over every row, and the
 *     mirror keeps a row's last mode across a respawn (ledger-mirror.ts:
 *     `mode = COALESCE(excluded.mode, agents.mode)`) while it copies
 *     `live_blocker` straight over. So for the minutes after any redeploy, and
 *     for good on an expired agent whose last beat was live, a row reads
 *     "trading for real" when nothing is. Four agents were.
 *
 *  2. ONE FUNNEL FOR TWO RAILS. The 9 "policy-passed" were paper fills, and
 *     every no-exit came from agents that were not on the live rail at all. So
 *     `policy-passed − userops` read as an execution drop-off when it was the
 *     paper rail doing exactly its job. And the executor's own pre-broadcast
 *     refusals (gas, the sponsor) were counted as POLICY refusals, so a fleet
 *     whose wall said yes and whose gas ceiling said no read as a wall problem.
 *
 *  3. "369 unreported" WERE NOT DECISIONS. They were the quiet market reviews
 *     (market-review.ts), written every five minutes for every quiet agent
 *     with no hold_kind — the residual bucket swallowed them, and a real
 *     unreported hold could not be seen beside them.
 */
import { isGasRefusal } from "./thesis-policy";
import { PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE, REVIEW_SOURCE } from "./market-review";

/**
 * THE HOUR'S TRADE ROWS, PER AGENT. Per agent rather than one grouped total
 * because a refusal row does not say which rail it was on — the wall runs
 * before the execution fork — and the only way to tell is the agent's own
 * rail (railOfTrade). Joined in JS rather than in SQL: `agents` keys an
 * account in whatever case it was written, and a LOWER() join against a
 * table that may hold one account under two spellings would count its
 * trades twice.
 *
 * Bounded by the hour, like before: a fleet's hour is a few hundred groups.
 */
export const AUTONOMY_TRADE_FUNNEL_SQL = `SELECT agent_id, status, COALESCE(reject_rule, '') AS rule, COUNT(*) AS n
  FROM trades WHERE created_at >= ? GROUP BY agent_id, status, rule`;

/**
 * THE HOUR'S HOLDS, BY KIND, with the quiet reviews in a bucket of their own.
 *
 * A quiet review is filed by its SOURCE, not by a hold_kind — quietReviewRow
 * sets none, and it is the same row whether it published or not — so the
 * sources are what name it. Only a row with NO hold_kind is reclassified: a
 * kind the writer did stamp is always the kind that is counted.
 */
export const QUIET_REVIEW_KIND = "QUIET_REVIEW";
const QUIET_REVIEW_SOURCES = [REVIEW_SOURCE, PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE] as const;
export const AUTONOMY_HOLDS_SQL = `SELECT COALESCE(hold_kind,
         CASE WHEN source IN (${QUIET_REVIEW_SOURCES.map((s) => `'${s}'`).join(", ")}) THEN '${QUIET_REVIEW_KIND}'
              ELSE 'unreported' END) AS kind,
       COUNT(*) AS n
  FROM decisions WHERE at >= ? AND action = 'hold' GROUP BY kind`;

/** The agents rows the rails are judged from. Every agent, one row each. */
export const FLEET_RAILS_SQL = `SELECT smart_account, mode, live_blocker, beat_at FROM agents`;

// ── WHICH STAGE TURNED IT BACK ──────────────────────────────────────────────

export type RefusalStage = "wall" | "exec";

/**
 * THE OWNER'S WALL, OR THE HOUSE'S OWN EXECUTION?
 *
 * `exec` is everything refused before broadcast for a reason that is ours and
 * not the owner's policy: the gas and key-install vocabulary (isGasRefusal —
 * the same set the notifier already uses to say "it wasn't sent" rather than
 * "the wall turned it back", prefund-* included), the gas sponsor declining
 * (paymaster.ts's `sponsor-*` literals) and the ledger refusing the row that
 * must exist before anything goes out (`not-recorded`). Reusing that set, not
 * a list of our own, is deliberate: a second copy of the vocabulary is the
 * one that drifts.
 *
 * `receipt-unresolved` IS NEVER A REFUSAL, and it is not asked about here at
 * all. It means "sent, outcome unknown" (index.ts, UserOpUnresolved): the
 * operation went out and may have landed. foldFunnel counts it as a userop.
 */
export function stageOf(rule: string): RefusalStage {
  return isGasRefusal(rule) || rule.startsWith("sponsor-") || rule === "not-recorded" ? "exec" : "wall";
}

/** Sent, outcome unknown. Counted as a userop wherever it appears, never as a refusal. */
export const RECEIPT_UNRESOLVED = "receipt-unresolved";

/**
 * REFUSED BY THE OPERATOR'S ADMISSION GATE, not by the wall or the executor:
 * a tenant admitted at `observe` (or `exits-only`) books every proposal it may
 * not make as a rejected `rollout-hold` row, and a draining worker books
 * `draining`. Out of the funnel and counted on their own, so a cohort under
 * observation reads as "held, as asked" — never as a fleet whose policy
 * passes nothing, which is exactly what an alert on that funnel would page on.
 */
const ADMISSION_RULES: ReadonlySet<string> = new Set(["rollout-hold", "draining"]);

// ── WHICH RAIL ──────────────────────────────────────────────────────────────

export type Rail = "live" | "paper";

/** Statuses only the live rail ever writes: something was signed and sent. */
const SENT: ReadonlySet<string> = new Set(["submitted", "landed", "reverted", "dropped"]);

/**
 * THE RAIL ONE TRADE ROW WAS ON. The row itself says so wherever it can, and
 * the agent's rail is asked only for the one kind of row that cannot: a wall
 * refusal, made before the execution fork.
 *
 *   paper                              the simulator's own literal
 *   submitted/landed/reverted/dropped  only the live rail sends anything
 *   an exec refusal                    only the live rail builds an operation
 *   receipt-unresolved                 sent, so live
 *   a wall refusal                     the agent's rail, as its row says now
 *
 * "Paper" is everything that is not live — an idle agent's refusals included,
 * since an agent that is refusing to trade is not trading for real either.
 */
export function railOfTrade(status: string, rule: string, agentMode: string | null): Rail {
  if (status === "paper") return "paper";
  if (status !== "rejected" || rule === RECEIPT_UNRESOLVED) return "live";
  if (stageOf(rule) === "exec") return "live";
  return agentMode === "live" ? "live" : "paper";
}

export interface RailFunnel {
  /** Every row the rail saw this window, admission refusals excluded. */
  proposals: number;
  wallRefused: number;
  execRefused: number;
  /** Signed and sent: submitted, landed, reverted, dropped, or sent with no receipt yet. */
  userops: number;
  landed: number;
  /** Reached the chain and reverted there. */
  failed: number;
  paperFills: number;
}

export interface AutonomyFunnel {
  live: RailFunnel;
  paper: RailFunnel;
  /** Refused by the operator's admission gate (rollout-hold, draining). Not proposals. */
  admissionHeld: number;
  grantTooWide: number;
  /** Every refusal rule, largest first, with the stage that made it. */
  refusals: { rule: string; stage: RefusalStage; n: number }[];
}

const emptyRail = (): RailFunnel => ({
  proposals: 0, wallRefused: 0, execRefused: 0, userops: 0, landed: 0, failed: 0, paperFills: 0,
});

/** Policy-passed, across both rails: every proposal the wall did not turn back. */
export function policyPassed(f: AutonomyFunnel): number {
  return f.live.proposals + f.paper.proposals - f.live.wallRefused - f.paper.wallRefused;
}

/**
 * FOLD THE HOUR'S ROWS INTO ONE FUNNEL PER RAIL.
 *
 * `modeOf` is the agent's mode as its row says now. Null — no row, or the
 * agents read failed — files a wall refusal under paper, which is the side
 * that cannot overstate how much is trading for real.
 */
export function foldFunnel(
  rows: readonly { agent_id: string; status: string; rule: string; n: number | string }[],
  modeOf: (agentId: string) => string | null,
): AutonomyFunnel {
  const f: AutonomyFunnel = { live: emptyRail(), paper: emptyRail(), admissionHeld: 0, grantTooWide: 0, refusals: [] };
  const refused = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    const status = String(r.status ?? "");
    const rule = String(r.rule ?? "");
    if (status === "rejected" && ADMISSION_RULES.has(rule)) {
      f.admissionHeld += n;
      continue;
    }
    const rail = f[railOfTrade(status, rule, modeOf(String(r.agent_id ?? "")))];
    rail.proposals += n;
    if (status === "rejected" && rule !== RECEIPT_UNRESOLVED) {
      if (stageOf(rule) === "exec") rail.execRefused += n;
      else rail.wallRefused += n;
      if (rule === "grant-too-wide") f.grantTooWide += n;
      if (rule) refused.set(rule, (refused.get(rule) ?? 0) + n);
      continue;
    }
    if (SENT.has(status) || rule === RECEIPT_UNRESOLVED) rail.userops += n;
    if (status === "landed") rail.landed += n;
    if (status === "reverted") rail.failed += n;
    if (status === "paper") rail.paperFills += n;
  }
  f.refusals = [...refused.entries()]
    .map(([rule, n]) => ({ rule, stage: stageOf(rule), n }))
    .sort((a, b) => b.n - a.n || a.rule.localeCompare(b.rule));
  return f;
}

// ── HOLDS ───────────────────────────────────────────────────────────────────

/** The kinds the autonomy line names, in the order it names them. */
const HOLD_BUCKETS: readonly (readonly [kind: string, label: string])[] = [
  ["MODEL_HOLD", "model"],
  ["GATE_FORCED_HOLD", "gate-forced"],
  ["STALE_MARK_HOLD", "stale-mark"],
  [QUIET_REVIEW_KIND, "quiet-review"],
  ["unreported", "unreported"],
];

/**
 * THE HOLDS CLAUSE OF THE AUTONOMY LINE, and every hold the query read is in it.
 *
 * It named three kinds and summed only those. When the writer started stamping
 * a hold on a stale price as STALE_MARK_HOLD — which had counted as a model
 * hold until then — those holds fell out of the line entirely, and a fleet
 * holding on dead feeds read as a fleet holding less. So the named buckets are
 * always printed (a kind the query found none of is a measured zero), and any
 * kind this list does not know is printed under its own name rather than
 * dropped. A new kind at the writer then shows up here the first hour it
 * happens, instead of being noticed as a gap in a total.
 *
 * QUIET REVIEWS ARE A BUCKET OF THEIR OWN (AUTONOMY_HOLDS_SQL), so
 * "unreported" is again what its name says: a hold nobody classified.
 */
export function autonomyHolds(rows: readonly { kind: string; n: number | string }[]): string {
  const count = (k: string) => rows.filter((r) => r.kind === k).reduce((s, r) => s + Number(r.n), 0);
  const named = new Set(HOLD_BUCKETS.map(([k]) => k));
  const unknown = [...new Set(rows.map((r) => r.kind).filter((k) => !named.has(k)))].sort();
  return [
    ...HOLD_BUCKETS.map(([k, label]) => `${count(k)} ${label}`),
    ...unknown.map((k) => `${count(k)} ${k}`),
  ].join(", ");
}

// ── RAILS ───────────────────────────────────────────────────────────────────

/** Not yet beaten since this replica started its worker: the row is its predecessor's. */
export const RAIL_RESPAWNING = "unknown (respawning)";
/** No worker in this replica: nothing here is trading for it, whatever its row last said. */
export const RAIL_NO_WORKER = "no worker here";

/** The order the rails line names them; any other mode follows under its own name. */
const RAIL_ORDER = ["live", "paper", "idle", RAIL_RESPAWNING, RAIL_NO_WORKER] as const;

export interface AgentRailRow {
  smart_account: string;
  mode: string | null;
  live_blocker: string | null;
  beat_at: number | string | null;
}

/**
 * A BEAT IN SECONDS, whichever unit the row was written in. `beat_at` is
 * seconds where this worker writes it, but rows carried in from elsewhere
 * have held milliseconds, so it is normalised per row — never by a fleet-wide
 * guess, which one mis-scaled row would skew for everybody.
 */
export function beatSec(beatAt: number | string | null | undefined): number | null {
  if (beatAt === null || beatAt === undefined || beatAt === "") return null;
  const v = Number(beatAt);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

/**
 * THE RAIL ONE AGENT IS ON, AS FAR AS THIS REPLICA CAN VOUCH FOR IT.
 *
 * An agent counts as LIVE only if its row says `live`, nothing is blocking
 * the live rail, and that row was written by the worker running NOW — it has
 * beaten since this replica spawned it. A mode written before the spawn is the
 * predecessor's, carried across by the mirror's COALESCE, and so is every
 * other field of the row: until the new worker beats, the honest answer is
 * that nobody knows yet ("unknown (respawning)").
 *
 * `spawnedAtMs` is undefined when this replica runs no worker for the agent —
 * expired, killed, held, halted, or held by another replica. Its row is the
 * last thing a dead process said, and none of it is current.
 *
 * Freshness applies to every mode, not only to `live`: a stale `paper` is
 * just as untrue, and "paper by choice" read off a respawning row would be the
 * same error pointing the other way.
 */
export function railOf(row: AgentRailRow, spawnedAtMs: number | undefined): string {
  if (spawnedAtMs === undefined) return RAIL_NO_WORKER;
  const beat = beatSec(row.beat_at);
  // Whole seconds both sides: a beat is stamped to the second, and a first
  // beat comes a tick after the spawn, never inside the spawn's own second.
  if (beat === null || beat < Math.floor(spawnedAtMs / 1000)) return RAIL_RESPAWNING;
  const mode = row.mode === null || row.mode === undefined || row.mode === "" ? null : String(row.mode);
  if (mode === null) return RAIL_RESPAWNING;
  if (mode === "live") {
    // `live` with a blocker is two facts that cannot both be true of one
    // verdict (exec-mode.ts writes them together). Not counted as either.
    return row.live_blocker === null || row.live_blocker === undefined ? "live" : RAIL_RESPAWNING;
  }
  return mode;
}

export interface FleetRails {
  /** Agents per rail, in RAIL_ORDER, then any other mode by name. */
  counts: Record<string, number>;
  /** The agents railOf calls live. The autonomy line's "N live", and its silence rule. */
  live: number;
}

/** Every agent, judged by railOf. `spawnedAt` is keyed by the lowercased smart account. */
export function fleetRails(rows: readonly AgentRailRow[], spawnedAt: ReadonlyMap<string, number>): FleetRails {
  const by = new Map<string, number>();
  for (const row of rows) {
    const rail = railOf(row, spawnedAt.get(String(row.smart_account ?? "").toLowerCase()));
    by.set(rail, (by.get(rail) ?? 0) + 1);
  }
  const counts: Record<string, number> = {};
  for (const rail of RAIL_ORDER) if (by.has(rail)) counts[rail] = by.get(rail)!;
  for (const rail of [...by.keys()].filter((k) => !(RAIL_ORDER as readonly string[]).includes(k)).sort()) {
    counts[rail] = by.get(rail)!;
  }
  return { counts, live: by.get("live") ?? 0 };
}

/** `fleet| rails — live 3, paper 10, …` — the prefix is unchanged; the counts are now vouched for. */
export function railsLine(rails: FleetRails): string | null {
  const parts = Object.entries(rails.counts).map(([rail, n]) => `${rail} ${n}`);
  return parts.length ? `fleet| rails — ${parts.join(", ")}` : null;
}

// ── THE LINES ───────────────────────────────────────────────────────────────

/**
 * THE AUTONOMY LINES, or none.
 *
 * SILENT ONLY WHEN NOBODY IS LIVE — because silence means two things and
 * this is a health metric.
 *
 * It used to be silent on any idle hour. But "no agent is trading for real"
 * and "every agent is live and proposed nothing for an hour" are opposite
 * facts, and the second is the one worth waking up for: it is precisely the
 * state that went unnoticed for weeks. Rendered identically as an absent
 * line, an operator reads the alarming case as the boring one — the same
 * empty-versus-unavailable mistake this codebase refuses everywhere it prints
 * a number.
 *
 * `liveAgents === null` is a FAILED READ and stays silent, because claiming
 * "0 live" off a query that did not answer would be the same error pointing
 * the other way.
 *
 * THE FIRST LINE KEEPS ITS FIELDS AND ITS PREFIX, so whatever already greps
 * `autonomy| 1h — ` or `LANDED 0` still finds them. What changed is what
 * "policy-passed" counts: every proposal the WALL did not turn back, so an
 * operation the gas ceiling or the sponsor refused is a pass of policy and a
 * failure of execution, as it is. The per-rail lines then say where each went.
 */
export function autonomyLines(
  liveAgents: number | null,
  f: AutonomyFunnel,
  holds: readonly { kind: string; n: number | string }[],
): string[] {
  const proposals = f.live.proposals + f.paper.proposals;
  if (!(proposals > 0 || f.admissionHeld > 0 || holds.length > 0 || (liveAgents !== null && liveAgents > 0))) return [];
  const userops = f.live.userops + f.paper.userops;
  const landed = f.live.landed + f.paper.landed;
  const failed = f.live.failed + f.paper.failed;
  const lines = [
    `autonomy| 1h — ${liveAgents ?? "?"} live · proposals ${proposals} · ` +
      (f.admissionHeld > 0 ? `admission-held ${f.admissionHeld} · ` : "") +
      `policy-passed ${policyPassed(f)} · ` +
      `userops ${userops} · LANDED ${landed} · failed ${failed} · ` +
      `grant-too-wide ${f.grantTooWide} · holds ${autonomyHolds(holds)}`,
    `autonomy| 1h live-rail — proposals ${f.live.proposals} · wall-refused ${f.live.wallRefused} · ` +
      `exec-refused ${f.live.execRefused} · userops ${f.live.userops} · LANDED ${f.live.landed} · failed ${f.live.failed}`,
    `autonomy| 1h paper-rail — proposals ${f.paper.proposals} · wall-refused ${f.paper.wallRefused} · ` +
      `paper-fills ${f.paper.paperFills}`,
  ];
  // The refusals, largest first, so a new one announces itself rather than
  // hiding inside a total, each tagged with the stage that made it. Bounded —
  // a fleet refusing in twenty ways should report the five that matter, not
  // push the log window out.
  const why = f.refusals
    .slice(0, 5)
    .map((r) => `${r.rule} ${r.n} [${r.stage}]`)
    .join(" · ");
  if (why) lines.push(`autonomy| 1h refusals — ${why}`);
  return lines;
}
