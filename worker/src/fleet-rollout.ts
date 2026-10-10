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
 * once a worker in this tree obeys it (WORKER_ENFORCED_LEVELS: all three, now
 * that worker-admission.ts does). The level reaches the child as
 * MERRYMEN_ADMISSION_LEVEL (childEnv)
 * and nothing else of the value does: the list names other tenants, and a
 * child has no business knowing who else is running, the same reason
 * MERRYMEN_HOLDER_ADDRESS is stripped.
 *
 * A TENANT THE VALUE DOES NOT ADMIT IS `held`. The supervisor starts nothing
 * for it and leases nothing, so its home on the volume stays exactly as the
 * incident left it until it is admitted, but for one file: once its key has
 * expired, the copy of that key (grant.json) is removed, as for any tenant,
 * because that only takes authority away and needs no lease. It stays in the
 * roster (`wanted`): being out of the rollout is not being removed, and the
 * removed-agent sweep must still be able to tell the two apart.
 *
 * BUT ITS OWNER CAN STILL REVOKE IT. A pending Telegram /kill is carried out
 * for a held tenant as for any other, within seconds, exactly as a dashboard
 * DELETE /api/grants is and as FLEET_HALT has always allowed: a kill only
 * takes authority away, and its request lives in a home a redeploy may
 * discard (kill-request.ts). The tenant is then removed, not held, and the
 * removed-agent sweep keeps its original book as it does for any revoke.
 *
 * ONLY EVER NARROWS, BUT FOR ONE ROUTE THE OWNER ASKED FOR. Every gate that
 * already stops a tenant (FLEET_HALT, the accounting hold, a lost lease, a
 * pending kill, the source fences) still stops it; the list adds one more
 * reason to stop and removes none.
 *
 * The one route: MERRYMEN_ROLLOUT_NEW_TENANTS (observe | exits-only | trade).
 * On 2026-10-09, with the list naming 49 tenants and production live, a tester
 * created a new agent and nothing ever started for it: no worker, no link code
 * for its bot ("starting up" for good), no line saying why. The list exists so
 * the pre-incident fleet comes back a few reviewed tenants at a time; a tenant
 * created since has no accounting to review. The owner decided that day that
 * every genuinely new agent must start without being named. So, under an
 * explicit list only, a tenant the list does not name is admitted at this
 * variable's level once the orchestrator has proved it new (no home or archive
 * on the volume, no history in Postgres) and recorded that, durably, before
 * its first spawn (new-tenant-admission.ts). That is one more way in, and no
 * gate fewer: the accounting hold, FLEET_HALT, a pending kill, an expired
 * key, the lease, the process cap and every source fence stop it exactly as
 * they stop a named tenant, and its first spawn still goes through the
 * new-book path (registerLedgerSource), which refuses any account with
 * history. It also never takes a process slot a named tenant is waiting
 * for, and leaves the automatic lane's headroom free (newTenantRoom). Never
 * under `none`, the emergency stop; nothing to add under `all`. A tenant the
 * list names keeps the list's level. Unset, nothing changes from before: a
 * tenant the list does not name is held, recorded or not. So the rule now
 * reads: the list, and the variable, each only ever ADD a reason to run that
 * is checked against every reason to stop; neither removes one.
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
import { RAILWAY_ONLY_IDENTITY } from "./deploy-guard-checks";
/**
 * What the child reads its own level from (ADMISSION_LEVEL_ENV), and what an
 * admitted child may do (AdmissionLevel: only these three ever reach a child).
 * The worker's admission gate defines both, once; re-exported for the callers
 * and tests that knew them here. The rollout itself never reaches a child.
 */
import { ADMISSION_LEVEL_ENV, ADMISSION_LEVELS, type AdmissionLevel } from "./worker-admission";
export { ADMISSION_LEVEL_ENV, ADMISSION_LEVELS, type AdmissionLevel };

export const FLEET_ROLLOUT_ENV = "MERRYMEN_FLEET_ROLLOUT";
/** Far beyond any cohort the rollout plan uses, and small enough that the value stays a reviewable diff. */
export const MAX_ROLLOUT_TENANTS = 512;

/** An admitted level, or `held`: the supervisor starts nothing for the tenant. */
export type RolloutLevel = AdmissionLevel | "held";

/**
 * THE LEVELS A WORKER IN THIS TREE OBEYS, and so the only ones the rollout
 * accepts: all three, the worker's admission gate's own list
 * (worker-admission.ts ADMISSION_LEVELS).
 *
 * Until that gate was in this tree this was `trade` alone. Nothing in the
 * worker read MERRYMEN_ADMISSION_LEVEL then, so a tenant named at `observe`
 * would have been spawned with the word in its environment and traded with
 * full authority, while the startup line and the heartbeat reported it as
 * only being watched. A risk control that depends on the order two changes
 * are deployed in fails open the one time they are deployed out of order. Now
 * a child reads its level at boot and refuses, at the top of
 * processIntentLocked and before any budget is reserved, every intent at
 * `observe` and every entry at `exits-only` (a `rollout-hold` row); one with
 * no level at all, hosted, reads as `observe`. A child runs the orchestrator's
 * own tree (orchestrator.ts WORKER_ENTRY), so the two halves can no longer be
 * deployed apart.
 *
 * Built from the gate's list rather than written out, so a level reaches the
 * grammar only by being added there, where admissionRefusal decides what it
 * refuses. The refusal below stays for a level this set ever leaves out: such
 * a value refuses boot like any other the orchestrator cannot honour, and
 * every runtime reader reads it as `held`. fleet-rollout.test.ts pins the set
 * to the gate's presence in this tree, in both directions.
 */
export const WORKER_ENFORCED_LEVELS: ReadonlySet<AdmissionLevel> = new Set<AdmissionLevel>(ADMISSION_LEVELS);

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
 *
 * THE DEPLOY GUARD'S OWN LIST, AND WIDER, NEVER NARROWER. The identity names
 * are deploy-guard-checks.ts's (onRailway), so the two can never disagree in
 * the direction that admits: whatever the guard treats as Railway, this treats
 * as Railway too. This one also counts the volume's mount path, and a marker
 * that is present but empty, which the guard does not. Here wider only means
 * an unset rollout refuses in more places, so it stays fail-closed.
 */
const RAILWAY_MARKERS = [...RAILWAY_ONLY_IDENTITY, "RAILWAY_VOLUME_MOUNT_PATH"] as const;

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
      throw refuse(`entry ${i + 1} asks for ${level}, which no worker in this build enforces; name it at a level one does, or leave it out`);
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

export const ROLLOUT_NEW_TENANTS_ENV = "MERRYMEN_ROLLOUT_NEW_TENANTS";

const refuseNew = (why: string) =>
  new Error(`${ROLLOUT_NEW_TENANTS_ENV} ${why}; refusing to start rather than guess which tenants it admits`);

/**
 * THE LEVEL MERRYMEN_ROLLOUT_NEW_TENANTS ASKS FOR, OR NULL WHEN UNSET. Throws
 * on anything else, by the rollout's own rule: runOrchestrator asks this at
 * boot beside fleetRollout, so a typo is a failed boot, never a guess. One of
 * the grammar's three words, exactly (whitespace around it ignored, as around
 * a rollout entry), and only one a worker in this build enforces. No `none`,
 * `off` or empty value: removing the variable is the one way to turn it off.
 *
 * Whether it is IN EFFECT is newTenantLevel's question: a valid value is
 * accepted beside `none` and `all` too, so that flipping the rollout to
 * `none` in an emergency never also needs this deleted to boot.
 */
export function rolloutNewTenants(env: Env = process.env): AdmissionLevel | null {
  const raw = env[ROLLOUT_NEW_TENANTS_ENV];
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value !== "observe" && value !== "exits-only" && value !== "trade") {
    throw refuseNew("is not observe, exits-only or trade (remove it to admit no tenant the list does not name)");
  }
  if (!WORKER_ENFORCED_LEVELS.has(value)) throw refuseNew(`asks for ${value}, which no worker in this build enforces`);
  return value;
}

/**
 * THE LEVEL A RECORDED NEW TENANT IS ADMITTED AT NOW, or null when the route
 * is shut: the variable unset, the rollout not an explicit list (`none` is the
 * emergency stop; `all` admits everybody already), or either value refused.
 * Read on every ask, never remembered, so lowering the variable lowers every
 * tenant it admitted and removing it holds them all again. Fails closed.
 */
export function newTenantLevel(env: Env = process.env): AdmissionLevel | null {
  try {
    if (fleetRollout(env).scope !== "list") return null;
    return rolloutNewTenants(env);
  } catch {
    return null;
  }
}

/**
 * COULD THE NEW-TENANT ROUTE ADMIT THIS TENANT AT ALL: the route is open and
 * the list does not name it. Whether it IS new, and whether it has been
 * recorded, are new-tenant-admission.ts's and the orchestrator's questions.
 */
export function newTenantRouteOpen(tenant: string, env: Env = process.env): boolean {
  if (newTenantLevel(env) === null) return false;
  const rollout = fleetRollout(env);
  return rollout.scope === "list" && !rollout.levels.has(tenant.toLowerCase());
}

/**
 * This tenant's level. Fails closed: a value that cannot be read admits nobody.
 *
 * `admittedNew` is the orchestrator's record of tenants the new-tenant route
 * has admitted (new-tenant-admission.ts, lowercase). It is asked only for a
 * tenant an explicit list does not name, and answers at the level the variable
 * gives now; left out, or with the route shut, nothing differs from before.
 */
export function rolloutLevel(tenant: string, env: Env = process.env, admittedNew?: ReadonlySet<string>): RolloutLevel {
  let rollout: FleetRollout;
  try {
    rollout = fleetRollout(env);
  } catch {
    return "held";
  }
  if (rollout.scope === "all") return "trade";
  if (rollout.scope === "none") return "held";
  const lc = tenant.toLowerCase();
  const named = rollout.levels.get(lc);
  if (named) return named;
  if (admittedNew?.has(lc)) return newTenantLevel(env) ?? "held";
  return "held";
}

/** Out of the rollout: nothing is started or leased for it. Its owner's kill, and an expired key's scrub, still are carried out. */
export function rolloutHeld(tenant: string, env: Env = process.env, admittedNew?: ReadonlySet<string>): boolean {
  return rolloutLevel(tenant, env, admittedNew) === "held";
}

/**
 * The level a child's environment carries. A held tenant is never spawned
 * (every spawn path asks rolloutHeld first), so `held` cannot reach here in
 * practice; were it to, the child gets the grammar's most restrictive level
 * rather than an unset variable or a word no worker knows: one the worker's
 * admission gate obeys by refusing every intent (worker-admission.ts).
 */
export function childAdmissionLevel(tenant: string, env: Env = process.env, admittedNew?: ReadonlySet<string>): AdmissionLevel {
  const level = rolloutLevel(tenant, env, admittedNew);
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

/**
 * THE ROSTER, AS THE HEARTBEAT SAYS IT. The three levels count tenants the
 * rollout admits that have a key which has not expired and no accounting hold:
 * admitted, which is not the same as running (a lease another replica holds,
 * the process cap, a book whose restore failed). Everybody else is one of the
 * two buckets nothing runs for, so a figure under `trade` is never a tenant
 * that cannot trade whatever the rollout says.
 */
export interface RolloutCounts {
  trade: number;
  "exits-only": number;
  observe: number;
  /** Not admitted by the rollout, or named by the accounting hold: the operator holds it. */
  held: number;
  /** Admitted and not held, but its key has expired: it cannot sign, so nothing runs. */
  expired: number;
  /**
   * Tenants the value names that the roster does not hold: a typo, or a grant
   * removed since the value was written. Either way the operator meant to admit
   * somebody who is not being admitted, and should hear about it.
   */
  absent: number;
  /**
   * Of the admitted, those the new-tenant route admits (the list does not name
   * them; new-tenant-admission.ts recorded them). Already counted at their
   * level: this says how many of those figures came in that way. Present only
   * while the route is open, so with MERRYMEN_ROLLOUT_NEW_TENANTS unset the
   * counts are exactly what they were before it existed.
   */
  new?: number;
}

/**
 * How many of the roster sit at each level, and how many named tenants it
 * lacks. `accountingHeld` and `unexpired` are reconcile's own answers for the
 * same pass (lowercase); left out, nobody is accounting-held and no key has
 * expired. `newTenants` is the orchestrator's record of tenants the
 * new-tenant route admitted (rolloutLevel says how it is read).
 */
export function rolloutCounts(
  roster: readonly string[],
  env: Env = process.env,
  pass: { accountingHeld?: ReadonlySet<string>; unexpired?: ReadonlySet<string>; newTenants?: ReadonlySet<string> } = {},
): RolloutCounts {
  const counts: RolloutCounts = { trade: 0, "exits-only": 0, observe: 0, held: 0, expired: 0, absent: 0 };
  const routeOpen = newTenantLevel(env) !== null;
  if (routeOpen) counts.new = 0;
  const present = new Set(roster.map((tenant) => tenant.toLowerCase()));
  for (const tenant of present) {
    const level = rolloutLevel(tenant, env, pass.newTenants);
    if (level === "held" || pass.accountingHeld?.has(tenant)) counts.held += 1;
    else if (pass.unexpired && !pass.unexpired.has(tenant)) counts.expired += 1;
    else {
      counts[level] += 1;
      if (routeOpen && pass.newTenants?.has(tenant) && newTenantRouteOpen(tenant, env)) counts.new! += 1;
    }
  }
  try {
    const rollout = fleetRollout(env);
    if (rollout.scope === "list") for (const tenant of rollout.levels.keys()) if (!present.has(tenant)) counts.absent += 1;
  } catch {
    /* refused: every tenant is already counted held */
  }
  return counts;
}

/**
 * The scope's name. An explicit list with the new-tenant route open says the
 * route's level beside it, "49 named (new at trade)", within the heartbeat's
 * vocabulary for a scope (fleet-heartbeat.ts safeScope); with it shut, the
 * name is what it always was.
 */
function scopeName(env: Env): string {
  try {
    const rollout = fleetRollout(env);
    if (rollout.scope === "list") {
      const level = newTenantLevel(env);
      return `${rollout.levels.size} named${level ? ` (new at ${level})` : ""}`;
    }
    if (rollout.scope === "all" && rollout.unset) return "all (unset off Railway)";
    return rollout.scope;
  } catch {
    return "REFUSED";
  }
}

/**
 * The heartbeat's rollout line, every pass, beside the fleet's own. Null
 * counts are a pass that could not read the roster: the scope is still said,
 * and no figure from an older pass is passed off as this one's.
 */
export function rolloutLine(counts: RolloutCounts | null, env: Env = process.env): string {
  if (!counts) return `fleet| rollout ${scopeName(env)} — the last pass could not read the roster`;
  return (
    `fleet| rollout ${scopeName(env)} — admitted: trade ${counts.trade} · exits-only ${counts["exits-only"]} · ` +
    // "new N": of the admitted just counted, how many the new-tenant route
    // admitted. Said only while it is open, so the line is unchanged without it.
    `observe ${counts.observe}${counts.new === undefined ? "" : ` · new ${counts.new} of those`}; not run: held ${counts.held} · expired ${counts.expired}` +
    (counts.absent > 0 ? `; named but not in the roster ${counts.absent}` : "")
  );
}

/**
 * The same, for the heartbeat row (fleet-heartbeat.ts RolloutSummary): the
 * scope's name and the last pass's count per level, never a tenant. Null
 * counts still publish the scope, with no levels: the scope is what an outside
 * check needs to expect a fleet that runs nobody, and an empty `levels` is
 * "not counted", never zeros.
 */
export function rolloutSummary(counts: RolloutCounts | null, env: Env = process.env): { scope: string; levels: Record<string, number> } {
  return { scope: scopeName(env), levels: counts ? { ...counts } : {} };
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

/**
 * Said once at boot beside the rollout's line: MERRYMEN_ROLLOUT_NEW_TENANTS's
 * value, and what it does under the scope that took. Throws on a malformed
 * value, as rolloutNewTenants does; runOrchestrator has asked that already.
 */
export function newTenantsStartupLine(env: Env = process.env): string {
  const level = rolloutNewTenants(env);
  if (level === null) {
    return `fleet rollout: ${ROLLOUT_NEW_TENANTS_ENV} unset — a tenant the rollout does not name is held, new or not, as before`;
  }
  let scope: FleetRollout["scope"] | "refused";
  try { scope = fleetRollout(env).scope; } catch { scope = "refused"; }
  if (scope === "none") return `fleet rollout: ${ROLLOUT_NEW_TENANTS_ENV}=${level} has no effect under none — the emergency stop admits nobody, new or not`;
  if (scope === "all") return `fleet rollout: ${ROLLOUT_NEW_TENANTS_ENV}=${level} has no effect under all — every tenant is admitted at trade already`;
  if (scope === "refused") return `fleet rollout: ${ROLLOUT_NEW_TENANTS_ENV}=${level}, but the rollout itself is refused — nobody is admitted`;
  return (
    `fleet rollout: ${ROLLOUT_NEW_TENANTS_ENV}=${level} — a tenant the list does not name is admitted at ${level} once it is proved genuinely new ` +
    "(no home and no archive on the volume, no history in Postgres) and recorded in fleet_new_tenant_admissions before its first spawn; " +
    "the accounting hold, FLEET_HALT, kills, expired keys, leases and the process cap stop it as they stop any tenant"
  );
}
