/**
 * WHICH TENANTS THIS ORCHESTRATOR MAY START, AND AT WHAT LEVEL.
 *
 * `MERRYMEN_FLEET_ROLLOUT` is the one operator switch for bringing a halted
 * fleet back a few tenants at a time. It replaces two earlier designs (a list
 * of tenants to resume, and a separate rollout level) with ONE variable, so
 * there is no combination of two switches for anybody to reason about:
 *
 *   none                                   no tenant is admitted
 *   all                                    every tenant is admitted, at trade
 *   0x<40 hex>:<level>,0x<40 hex>:<level>  only these, each at its own level
 *
 * where <level> is `observe`, `exits-only` or `trade`, and is accepted only
 * once a worker in this tree obeys it (WORKER_ENFORCED_LEVELS: today, `trade`
 * alone). The level reaches the child as MERRYMEN_ADMISSION_LEVEL (childEnv)
 * and nothing else of the value does: the list names other tenants, and a
 * child has no business knowing who else is running, the same reason
 * MERRYMEN_HOLDER_ADDRESS is stripped.
 *
 * A TENANT THE VALUE DOES NOT ADMIT IS `held`. The supervisor starts nothing
 * for it, leases nothing and retires none of its expired keys, so its home on
 * the volume stays exactly as the incident left it until it is admitted. It
 * stays in the roster (`wanted`): being out of the rollout is not being
 * removed, and the removed-agent sweep must still be able to tell the two
 * apart.
 *
 * BUT ITS OWNER CAN STILL REVOKE IT. A pending Telegram /kill is carried out
 * for a held tenant as for any other, within seconds, exactly as a dashboard
 * DELETE /api/grants is and as FLEET_HALT has always allowed: a kill only
 * takes authority away, and its request lives in a home a redeploy may
 * discard (kill-request.ts). The tenant is then removed, not held, and the
 * removed-agent sweep keeps its original book as it does for any revoke.
 *
 * ONLY EVER NARROWS. Every gate that already stops a tenant (FLEET_HALT, the
 * accounting hold, a lost lease, a pending kill, the source fences) still
 * stops it; this adds one more reason to stop and removes none.
 *
 * NO `halt` VALUE. Stopping the fleet is FLEET_HALT's job, and it already has
 * a reviewed release path. A second spelling of "stop" here would be a second
 * thing to clear, and the one somebody forgets.
 *
 * MALFORMED REFUSES, IT NEVER GUESSES. The same rule as
 * MERRYMEN_ACCOUNTING_HOLD_TENANTS: a typo that silently dropped one entry
 * would admit nobody it was meant to, or worse, be read as some other scope.
 * The orchestrator validates it at boot and refuses to start; every runtime
 * reader below fails closed to `held` on the same refusal, so a value that
 * somehow changed under a running process admits nobody.
 *
 * UNSET MEANS `all` ONLY OFF RAILWAY. The hosted fleet runs on Railway, and
 * an orchestrator there that was redeployed without the variable must not
 * quietly resume every tenant: it refuses to boot instead. Anywhere else (a
 * local supervisor, the test suites) unset keeps today's behaviour.
 */

export const FLEET_ROLLOUT_ENV = "MERRYMEN_FLEET_ROLLOUT";
/** What the child reads its own level from. The rollout itself never reaches a child. */
export const ADMISSION_LEVEL_ENV = "MERRYMEN_ADMISSION_LEVEL";
/** Far beyond any cohort the rollout plan uses, and small enough that the value stays a reviewable diff. */
export const MAX_ROLLOUT_TENANTS = 512;

export const ADMISSION_LEVELS = ["observe", "exits-only", "trade"] as const;
/** What an admitted child may do. Only these three ever reach a child. */
export type AdmissionLevel = (typeof ADMISSION_LEVELS)[number];
/** An admitted level, or `held`: the supervisor starts nothing for the tenant. */
export type RolloutLevel = AdmissionLevel | "held";

/**
 * THE LEVELS A WORKER IN THIS TREE OBEYS, and so the only ones the rollout
 * accepts. Today that is `trade` alone.
 *
 * `observe` and `exits-only` are the grammar's, and childEnv already hands a
 * child its level, but nothing in the worker reads MERRYMEN_ADMISSION_LEVEL
 * yet: that is the worker's admission gate (worker-admission.ts), a change of
 * its own. Until it is here, a tenant named at `observe` would be spawned with
 * the word in its environment and trade with full authority, while the
 * startup line and the heartbeat reported it as only being watched. A risk
 * control that depends on the order two changes are deployed in fails open
 * the one time they are deployed out of order. This one fails closed: such a
 * value refuses boot like any other the orchestrator cannot honour, and every
 * runtime reader reads it as `held`.
 *
 * The change that brings the worker's gate widens this set in the same
 * commit. fleet-rollout.test.ts fails until it does, and fails if the set is
 * widened without the gate.
 */
export const WORKER_ENFORCED_LEVELS: ReadonlySet<AdmissionLevel> = new Set<AdmissionLevel>(["trade"]);

export type FleetRollout =
  | { scope: "none" }
  /** `unset` is the off-Railway default, kept apart so the log can say so. */
  | { scope: "all"; unset: boolean }
  | { scope: "list"; levels: ReadonlyMap<string, AdmissionLevel> };

type Env = Record<string, string | undefined>;

/**
 * VARIABLES RAILWAY INJECTS INTO EVERY DEPLOYMENT, any one of which says this
 * process is Railway-hosted. Several, because the cost of missing one is a
 * hosted orchestrator that resumes the whole fleet by default. Deliberately
 * not RAILWAY_TOKEN or anything else a developer's shell or a CI job may carry:
 * those say who is deploying, not where this process runs.
 */
const RAILWAY_MARKERS = [
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_ENVIRONMENT_NAME",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_SERVICE_ID",
  "RAILWAY_DEPLOYMENT_ID",
  "RAILWAY_REPLICA_ID",
  "RAILWAY_VOLUME_MOUNT_PATH",
] as const;

/**
 * Is this the Railway-hosted orchestrator? Also true for a required persistent
 * home, which persistent-home.ts accepts only at the Railway volume's mount: a
 * process that has opted into the production volume is the production fleet.
 */
export function railwayHosted(env: Env): boolean {
  return env.MERRYMEN_PERSISTENT_HOME_REQUIRED === "1" || RAILWAY_MARKERS.some((key) => env[key] !== undefined);
}

const ENTRY = /^(0x[0-9a-fA-F]{40}):(observe|exits-only|trade)$/;
const refuse = (why: string) =>
  new Error(`${FLEET_ROLLOUT_ENV} ${why}; refusing to start rather than guess which tenants it admits`);

function parseRollout(raw: string): FleetRollout {
  const value = raw.trim();
  if (value === "none") return { scope: "none" };
  if (value === "all") return { scope: "all", unset: false };
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > MAX_ROLLOUT_TENANTS) throw refuse(`names more than ${MAX_ROLLOUT_TENANTS} tenants`);
  const levels = new Map<string, AdmissionLevel>();
  entries.forEach((entry, i) => {
    // The position, never the text: the value is an operator's, and an entry
    // that does not parse is not something to repeat into a log as if it were.
    const m = ENTRY.exec(entry);
    if (!m) throw refuse(`entry ${i + 1} is not none, all or 0x<40 hex>:observe|exits-only|trade`);
    const tenant = m[1]!.toLowerCase();
    // Twice is ambiguous even at the same level: one of the two was meant to
    // be something else, and nobody can say which.
    if (levels.has(tenant)) throw refuse(`entry ${i + 1} names a tenant an earlier entry already named`);
    // Well-formed, and still not a promise this build can keep. The level is
    // one of the grammar's three words, so naming it repeats nothing else.
    const level = m[2] as AdmissionLevel;
    if (!WORKER_ENFORCED_LEVELS.has(level)) {
      throw refuse(`entry ${i + 1} asks for ${level}, which no worker in this build enforces yet (nothing reads ${ADMISSION_LEVEL_ENV}); name it at trade or leave it out`);
    }
    levels.set(tenant, level);
  });
  return { scope: "list", levels };
}

/** The last value parsed, so a fleet pass that asks per tenant does not reparse 512 entries each time. */
let memo: { raw: string | undefined; railway: boolean; rollout: FleetRollout } | null = null;

/**
 * THE ROLLOUT, OR A REFUSAL. Throws on a malformed value, and on an unset one
 * on Railway; runOrchestrator calls this before anything else can start, so
 * the refusal is a failed boot. Everything after boot goes through
 * rolloutLevel, which turns the same refusal into `held`.
 */
export function fleetRollout(env: Env = process.env): FleetRollout {
  const raw = env[FLEET_ROLLOUT_ENV];
  const railway = railwayHosted(env);
  if (memo && memo.raw === raw && memo.railway === railway) return memo.rollout;
  let rollout: FleetRollout;
  if (raw === undefined) {
    if (railway) throw refuse("is unset, and a Railway-hosted orchestrator must name its scope (none, all, or the tenants it admits)");
    rollout = { scope: "all", unset: true };
  } else {
    rollout = parseRollout(raw);
  }
  memo = { raw, railway, rollout };
  return rollout;
}

/** This tenant's level. Fails closed: a value that cannot be read admits nobody. */
export function rolloutLevel(tenant: string, env: Env = process.env): RolloutLevel {
  let rollout: FleetRollout;
  try {
    rollout = fleetRollout(env);
  } catch {
    return "held";
  }
  if (rollout.scope === "all") return "trade";
  if (rollout.scope === "none") return "held";
  return rollout.levels.get(tenant.toLowerCase()) ?? "held";
}

/** Out of the rollout: nothing is started, leased or retired for it. Its owner's kill still is carried out. */
export function rolloutHeld(tenant: string, env: Env = process.env): boolean {
  return rolloutLevel(tenant, env) === "held";
}

/**
 * The level a child's environment carries. A held tenant is never spawned
 * (every spawn path asks rolloutHeld first), so `held` cannot reach here in
 * practice; were it to, the child gets the grammar's most restrictive level
 * rather than an unset variable or a word no worker knows. (No worker in this
 * tree obeys `observe` yet, which is why WORKER_ENFORCED_LEVELS keeps anyone
 * who is spawned at `trade`.)
 */
export function childAdmissionLevel(tenant: string, env: Env = process.env): AdmissionLevel {
  const level = rolloutLevel(tenant, env);
  return level === "held" ? "observe" : level;
}

/**
 * MAY A WRITER THAT TOUCHES EVERY TENANT AT ONCE RUN? Only when every tenant
 * is admitted. The history repair, the holder-claims backfill and the MCP
 * background work each write rows for the whole fleet, held tenants included,
 * and a held tenant's shared rows must stay what the incident left until its
 * own admission is reviewed.
 */
export function rolloutAdmitsWholeFleet(env: Env = process.env): boolean {
  try {
    return fleetRollout(env).scope === "all";
  } catch {
    return false;
  }
}

export interface RolloutCounts {
  trade: number;
  "exits-only": number;
  observe: number;
  held: number;
  /**
   * Tenants the value names that the roster does not hold: a typo, or a grant
   * removed since the value was written. Either way the operator meant to admit
   * somebody who is not being admitted, and should hear about it.
   */
  absent: number;
}

/** How many of the roster sit at each level, and how many named tenants it lacks. */
export function rolloutCounts(roster: readonly string[], env: Env = process.env): RolloutCounts {
  const counts: RolloutCounts = { trade: 0, "exits-only": 0, observe: 0, held: 0, absent: 0 };
  const present = new Set(roster.map((tenant) => tenant.toLowerCase()));
  for (const tenant of present) counts[rolloutLevel(tenant, env)] += 1;
  try {
    const rollout = fleetRollout(env);
    if (rollout.scope === "list") for (const tenant of rollout.levels.keys()) if (!present.has(tenant)) counts.absent += 1;
  } catch {
    /* refused: every tenant is already counted held */
  }
  return counts;
}

function scopeName(env: Env): string {
  try {
    const rollout = fleetRollout(env);
    if (rollout.scope === "list") return `${rollout.levels.size} named`;
    if (rollout.scope === "all" && rollout.unset) return "all (unset off Railway)";
    return rollout.scope;
  } catch {
    return "REFUSED";
  }
}

/** The heartbeat's rollout line, every pass, beside the fleet's own. */
export function rolloutLine(counts: RolloutCounts, env: Env = process.env): string {
  return (
    `fleet| rollout ${scopeName(env)} — trade ${counts.trade} · exits-only ${counts["exits-only"]} · ` +
    `observe ${counts.observe} · held ${counts.held}` +
    (counts.absent > 0 ? ` · named but not in the roster ${counts.absent}` : "")
  );
}

/** Said once at boot, so the operator who redeployed sees the scope took. */
export function rolloutStartupLine(rollout: FleetRollout): string {
  if (rollout.scope === "none") {
    return `fleet rollout: none — no tenant is admitted; grants and homes stay as they are, and owners' kills and removed agents are still carried out`;
  }
  if (rollout.scope === "all") {
    return rollout.unset
      ? `fleet rollout: ${FLEET_ROLLOUT_ENV} unset off Railway — every tenant is admitted at trade, as before`
      : "fleet rollout: all — every tenant is admitted at trade";
  }
  const by = { trade: 0, "exits-only": 0, observe: 0 };
  for (const level of rollout.levels.values()) by[level] += 1;
  return (
    `fleet rollout: ${rollout.levels.size} named tenant(s) — trade ${by.trade} · exits-only ${by["exits-only"]} · observe ${by.observe}; ` +
    "every other tenant is held, and the fleet-wide writers (history repair, holder-claims backfill, MCP background) stay off"
  );
}
