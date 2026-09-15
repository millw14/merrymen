/**
 * THE ONE-TIME MIGRATION THAT KEEPS A CONSENT GATE FROM BECOMING AN OUTAGE.
 *
 * `liveTradingEnabled` is now a required term of `canTradeForReal`, and it
 * defaults to FALSE — the only safe default for a field that means "spend my
 * money". But `worker/src/settings.ts` resolves an ABSENT field to the default,
 * and no tenant alive today has ever written this field. So the deploy that
 * enforces the gate would, on the next tick, move every agent in the fleet to
 * paper: including the ones whose owners are watching them trade real funds
 * right now, with no notice and nothing on screen to explain it.
 *
 * That is not a consent fix. That is a fleet outage wearing one.
 *
 * WHAT COUNTS AS CONSENT ALREADY GIVEN. Two signals, and both are things the
 * owner did rather than things we assume:
 *
 *   1. A REAL ORDER HAS LANDED. `trades.status` is written by the execution
 *      fork itself — the paper arm writes the literal `"paper"`
 *      (index.ts, the `recordTrade` in the paper branch), the live arm writes
 *      `"submitted"` then `"landed"`. So a non-paper row is a transaction this
 *      account actually put on chain. An owner watching that happen has
 *      consented in the only way that matters: by continuing.
 *
 *   2. THE OWNER EXPLICITLY TURNED THE SIMULATOR OFF. `paperTradingEnabled:
 *      false` was the closest thing to a live request the product used to
 *      offer — it is what the old `go-live` chat command wrote, and what the
 *      create wizard's "Live trading" radio wrote. It never actually gated
 *      anything, but a tenant who set it was ASKING for real trading, and this
 *      migration is the first time that ask can be honoured.
 *
 * WHAT DELIBERATELY DOES NOT COUNT:
 *
 *   - Having money. Funding is the exact thing that must stop implying consent;
 *     reading a balance here would re-create the bug inside its own fix.
 *   - A mainnet grant. Signing a permission is not the same as asking to use it
 *     — that distinction is the whole point of the new field.
 *   - `paperTradingEnabled` being merely ABSENT. It defaults true, so absence is
 *     the state of every tenant who never touched it, and treating it as a live
 *     request would grant consent to the entire fleet on a technicality.
 *
 * IT ONLY EVER GRANTS. Nothing here writes `false`. A tenant who has already
 * set the field is left exactly as they set it, and a tenant with no evidence
 * of live trading is left to the default — which means they keep practising
 * until they say otherwise, which is the correct outcome and not a regression.
 *
 * REPORT BEFORE APPLY. `planLiveIntentBackfill` reads and decides; nothing is
 * written until `applyLiveIntentBackfill` is called with that plan. The
 * orchestrator runs the first on `MERRYMEN_BACKFILL_LIVE_INTENT=report` and
 * both on `=apply`, so an operator sees the exact list — with the reason per
 * tenant — before a single row changes.
 *
 * IDEMPOTENT. Re-running after an apply produces an empty plan, because every
 * tenant it touched now has the field set explicitly.
 */

/** Only the query this module makes. Injected so a test needs no database. */
export interface TradesReader {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Only what this module reads and writes. Same seam as announce.ts's. */
export interface SettingsStoreLike {
  listTenants(): Promise<`0x${string}`[]>;
  get(tenant: `0x${string}`): Promise<Record<string, unknown> | null>;
  put(tenant: `0x${string}`, settings: Record<string, unknown>): Promise<void>;
}

export type GrantReason =
  /** A real order reached the chain under this account. */
  | "has-traded-for-real"
  /** The owner explicitly switched the simulator off — the old go-live signal. */
  | "explicitly-not-paper";

export interface BackfillPlan {
  /** Tenants that will be granted live intent, with the evidence for each. */
  grant: { tenant: `0x${string}`; reason: GrantReason }[];
  /** Tenants left to the default — practising until they ask otherwise. */
  leaveDefault: `0x${string}`[];
  /** Tenants that already carry the field, untouched either way. */
  alreadySet: { tenant: `0x${string}`; value: boolean }[];
  /**
   * Tenants whose settings could not be read.
   *
   * NOT counted as anything. An unreadable record is not evidence of live
   * trading and it is not evidence of practising, so it is reported and skipped
   * — the same rule this codebase keeps everywhere else about a failed read.
   */
  unreadable: `0x${string}`[];
}

/**
 * Every account that has ever put a REAL order on chain, lowercased.
 *
 * `status` is the discriminator rather than `tx_hash`, because a live order
 * that was submitted and never mined still means the owner was trading for
 * real — and it is the column the execution fork sets deliberately, one literal
 * per rail, rather than a field that happens to be null on one path.
 *
 * THE ENUM IS FIVE WIDE AND THE LINE BETWEEN THEM IS `onChain`, NOT SUCCESS.
 * `store.ts:894` declares "landed" | "reverted" | "rejected" | "paper" |
 * "submitted", and `index.ts:6803` picks between the middle two with
 * `status: onChain ? "reverted" : "rejected"` under a comment that settles the
 * question outright: "REVERTED MEANS THE CHAIN REVERTED IT… `rejected` is the
 * vocabulary for 'we did not send it'."
 *
 *   landed    — submitted, mined, succeeded.                REAL
 *   submitted — in flight, not yet settled.                 REAL
 *   reverted  — reached the chain and failed there.         REAL — gas was spent
 *   rejected  — never left the box; a pre-flight refusal.   not real
 *   paper     — the simulator.                              not real
 *
 * The first version of this query asked for `('landed', 'submitted')` and so
 * read a REVERTED tenant as one who had never traded. That is precisely the
 * owner most likely to exist: an agent whose swaps keep reverting is one the
 * owner is watching spend real gas and get nothing, and the migration would
 * have answered their misfortune by silently moving them to paper. A failing
 * live trader is still a live trader.
 */
async function accountsThatTradedForReal(db: TradesReader): Promise<Set<string>> {
  const { rows } = await db.query(
    `SELECT DISTINCT agent_id FROM trades WHERE status IN ('landed', 'submitted', 'reverted')`,
  );
  return new Set(
    rows
      .map((r) => (typeof r.agent_id === "string" ? r.agent_id.toLowerCase() : null))
      .filter((a): a is string => a !== null),
  );
}

/**
 * Decide what the migration would do, WITHOUT writing anything.
 *
 * `agentIdOf` maps a tenant to the id the `trades` table is keyed by. It is
 * injected because that mapping is the orchestrator's business, not this
 * module's, and getting it wrong in either direction is expensive: a tenant
 * wrongly matched is granted consent nobody gave, and a tenant wrongly missed
 * is a live agent silently stopped.
 */
export async function planLiveIntentBackfill(deps: {
  settings: SettingsStoreLike;
  db: TradesReader;
  agentIdOf: (tenant: `0x${string}`) => string | null;
  /**
   * EVERY TENANT WITH A GRANT, not just those with a stored settings row.
   *
   * The first report caught this: 46 tenants had a grant with an account and the
   * plan covered 39, because it iterated the settings store alone. A tenant who
   * has never saved a setting has no row there — and if they have traded for
   * real, they would be invisible to the migration, fall to the `false` default
   * when the gate came into force, and stop trading with nothing to explain it.
   *
   * Settings-less is not the same as never-asked. The trade tape is the evidence
   * either way, so the union is what must be walked.
   */
  grantTenants?: readonly `0x${string}`[];
}): Promise<BackfillPlan> {
  const traded = await accountsThatTradedForReal(deps.db);
  const plan: BackfillPlan = { grant: [], leaveDefault: [], alreadySet: [], unreadable: [] };

  const seen = new Set<string>();
  const everyone: `0x${string}`[] = [];
  for (const t of [...(await deps.settings.listTenants()), ...(deps.grantTenants ?? [])]) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    everyone.push(t);
  }

  for (const tenant of everyone) {
    let current: Record<string, unknown> | null;
    try {
      current = await deps.settings.get(tenant);
    } catch {
      plan.unreadable.push(tenant);
      continue;
    }
    if (current === null) {
      /**
       * NO STORED SETTINGS — which says nothing about whether they trade.
       *
       * This used to drop straight to `leaveDefault`, on the reasoning that
       * somebody who has never set anything has never asked for live. That is
       * true of the SETTING and false of the account: an agent can be trading
       * real money on a grant whose owner never opened the settings screen, and
       * the trade tape says so. Dropping them here would have disarmed exactly
       * the people with the least reason to expect it.
       */
      const agentId = deps.agentIdOf(tenant);
      if (agentId !== null && traded.has(agentId.toLowerCase())) {
        plan.grant.push({ tenant, reason: "has-traded-for-real" });
      } else {
        plan.leaveDefault.push(tenant);
      }
      continue;
    }

    if (typeof current.liveTradingEnabled === "boolean") {
      plan.alreadySet.push({ tenant, value: current.liveTradingEnabled });
      continue;
    }

    const agentId = deps.agentIdOf(tenant);
    if (agentId !== null && traded.has(agentId.toLowerCase())) {
      plan.grant.push({ tenant, reason: "has-traded-for-real" });
      continue;
    }
    // ONLY an explicit false. Absent means "never touched it", and
    // paperTradingEnabled defaults TRUE — so reading absence as a live request
    // would grant the whole fleet consent nobody gave.
    if (current.paperTradingEnabled === false) {
      plan.grant.push({ tenant, reason: "explicitly-not-paper" });
      continue;
    }
    plan.leaveDefault.push(tenant);
  }
  return plan;
}

/**
 * Write the plan. Grants only — this never sets `false` for anybody.
 *
 * Re-reads each tenant immediately before writing rather than trusting the
 * record the plan was built from: between the report and the apply an owner may
 * have set the field themselves, and their answer must win over our inference
 * about them.
 */
export async function applyLiveIntentBackfill(
  plan: BackfillPlan,
  settings: SettingsStoreLike,
): Promise<{ written: `0x${string}`[]; skipped: { tenant: `0x${string}`; why: string }[] }> {
  const written: `0x${string}`[] = [];
  const skipped: { tenant: `0x${string}`; why: string }[] = [];

  for (const { tenant } of plan.grant) {
    try {
      const fresh = await settings.get(tenant);
      if (fresh === null) {
        // A TENANT WITH NO SETTINGS ROW IS STILL MIGRATED, because the plan only
        // puts one here on the evidence of the trade tape. Writing the flag
        // alone creates the row with nothing else in it, which is exactly right:
        // every other setting keeps falling through to its default, as it did
        // when the row was absent.
        await settings.put(tenant, { liveTradingEnabled: true });
        written.push(tenant);
        continue;
      }
      if (typeof fresh.liveTradingEnabled === "boolean") {
        skipped.push({ tenant, why: "the owner set it themselves — their answer wins" });
        continue;
      }
      await settings.put(tenant, { ...fresh, liveTradingEnabled: true });
      written.push(tenant);
    } catch (e) {
      // One tenant's failure must not abandon the rest: a half-finished
      // migration that stopped at the first error is how a fleet ends up split
      // between two contracts with nobody knowing where the line is.
      skipped.push({ tenant, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { written, skipped };
}

/** The report an operator reads before allowing the write. */
export function describeBackfill(plan: BackfillPlan): string {
  const lines = [
    `[live-intent] ${plan.grant.length} tenant(s) would be granted live trading:`,
    ...plan.grant.map((g) => `  GRANT ${g.tenant} — ${g.reason}`),
    `[live-intent] ${plan.leaveDefault.length} left on Paper (no evidence they ever asked for live)`,
    `[live-intent] ${plan.alreadySet.length} already carry the field, untouched`,
    ...plan.alreadySet.map((a) => `  KEEP  ${a.tenant} — liveTradingEnabled=${a.value}`),
  ];
  if (plan.unreadable.length) {
    lines.push(
      `[live-intent] ${plan.unreadable.length} UNREADABLE and skipped — these are not "no", they are "we could not tell":`,
      ...plan.unreadable.map((t) => `  SKIP  ${t}`),
    );
  }
  return lines.join("\n");
}
