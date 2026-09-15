/**
 * ONE TENANT'S CLASS-ROUTE CONFIGURATION, READ AND PRINTED, NOTHING ELSE.
 *
 * WHY THIS EXISTS. The grant and the settings blob live in a Postgres reachable
 * only from inside Railway — `DATABASE_URL` names `postgres.railway.internal`
 * and the service publishes no proxy — so "does this owner's signed wall carry a
 * class vault?" cannot be answered from an operator's machine at all. It was
 * answered by guessing twice before this existed.
 *
 * ZERO WRITES. It opens the stores read-only, reads, formats and returns. There
 * is no code path here that calls `put`, and there is no argument that would
 * make one appear.
 *
 * IT CANNOT PRINT A SECRET, and that is a property of the shape rather than a
 * promise about the author. `describeTenant` takes a FLAT RECORD OF THE FIELDS
 * ASKED FOR — never the settings object — so a bot token, a DEK, a session key,
 * a grant blob or an RPC url is not in scope at the point where strings are
 * built. Handing it `settings` and trusting a formatter to pick carefully is the
 * version of this that leaks the first time somebody adds a field.
 *
 * ONE TENANT, NAMED EXPLICITLY. The caller supplies an address; there is no
 * "all" mode. A diagnostic that can dump the fleet is a different and much
 * larger thing to leave armed by accident.
 */

/** Exactly the fields this diagnostic reports. Nothing else may be passed in. */
export interface TenantFacts {
  tenant: string;
  smartAccount: string | null;
  /** The vault the SIGNATURE sealed, from the grant. Null when none. */
  grantClassVault: string | null;
  /** `vaultFor(smartAccount)` — deterministic, whether or not it was sealed. */
  derivedClassVault: string | null;
  /**
   * Has the vault contract been created?
   *
   * Null when the chain would not answer. Not false — an unread code check and
   * an absent contract are different facts, and this module exists because
   * somebody was about to act on the difference.
   */
  vaultDeployed: boolean | null;
  /** Settings, each null when the tenant has no stored value for it. */
  assetMode: string | null;
  liveTradingEnabled: boolean | null;
  /**
   * THE SUPPLY SIDE, and the reason this field is here at all.
   *
   * Every other setting below governs whether a candidate may be BOUGHT. This
   * one governs whether a candidate ever EXISTS: `runPonsDiscovery` opens with
   * `if (!cfg.discoveryEnabled ...) return` and that return is silent, so with
   * it off the launchpad scanner never runs, `discovered_pools` is never
   * written, and the class funnel honestly reports `scanned 0 → 0 qualified`
   * forever.
   *
   * Left out, this module reported "every gate this module can see is OPEN"
   * about an agent that could not see a single launch — which is worse than
   * silence, because it moves the search to the gates that were already fine.
   */
  discoveryEnabled: boolean | null;
  classSnipeEnabled: boolean | null;
  classPerEntryUsdg: number | null;
  classMaxPositions: number | null;
  scoutEnabled: boolean | null;
  scoutBudgetUsdg: number | null;
  scoutPerTokenUsdg: number | null;
  classMinDepthUsdg: number | null;
  maxImpactBps: number | null;
  slippageBps: number | null;
  classMaxHoldSec: number | null;
  classExitAtGraduationPct: number | null;
  /** True when the tenant has no settings row at all. */
  settingsMissing: boolean;
  /** Set when the settings read threw — distinct from "no row". */
  settingsError: string | null;
}

/** The defaults a field falls back to, for reporting only. Never written. */
const DEFAULTS: Record<string, string> = {
  assetMode: '"all"',
  liveTradingEnabled: "false",
  discoveryEnabled: "true",
  classSnipeEnabled: "false",
  classPerEntryUsdg: "0",
  classMaxPositions: "0",
  scoutEnabled: "false",
  scoutBudgetUsdg: "0",
  scoutPerTokenUsdg: "25",
  classMinDepthUsdg: "250",
  maxImpactBps: "300",
  slippageBps: "100",
  classMaxHoldSec: "21600",
  classExitAtGraduationPct: "85",
};

const SETTING_ORDER = [
  "assetMode",
  "liveTradingEnabled",
  "discoveryEnabled",
  "classSnipeEnabled",
  "classPerEntryUsdg",
  "classMaxPositions",
  "scoutEnabled",
  "scoutBudgetUsdg",
  "scoutPerTokenUsdg",
  "classMinDepthUsdg",
  "maxImpactBps",
  "slippageBps",
  "classMaxHoldSec",
  "classExitAtGraduationPct",
] as const;

const yesNo = (v: boolean | null): string => (v === null ? "UNKNOWN (could not read)" : v ? "YES" : "NO");

/**
 * The report.
 *
 * ABSENT IS REPORTED AS ABSENT, with the default named beside it. A field the
 * owner never set and a field they set TO the default resolve identically at
 * runtime and mean opposite things to somebody deciding what to change — one is
 * a choice and the other is a gap.
 */
export function describeTenant(f: TenantFacts): string[] {
  const lines: string[] = [
    `tenant                        ${f.tenant}`,
    `smartAccount                  ${f.smartAccount ?? "UNKNOWN"}`,
    `grantPonsClassVault(grant)    ${f.grantClassVault ?? "null"}`,
    `derived vaultFor(account)     ${f.derivedClassVault ?? "UNKNOWN"}`,
    ``,
    `class vault sealed in grant:  ${yesNo(f.grantClassVault === null ? false : true)}`,
    `class vault deployed on-chain: ${yesNo(f.vaultDeployed)}`,
    ``,
  ];

  if (f.settingsError !== null) {
    lines.push(`settings UNREADABLE — ${f.settingsError}`);
    lines.push(`(every value below is therefore unknown, NOT default)`);
    return lines;
  }
  if (f.settingsMissing) {
    lines.push(`settings: NO ROW for this tenant — every field below falls to its default`);
  }

  const values = f as unknown as Record<string, unknown>;
  for (const name of SETTING_ORDER) {
    const v = values[name];
    const shown =
      v === null || v === undefined
        ? `(unset) -> default ${DEFAULTS[name] ?? "?"}`
        : JSON.stringify(v);
    lines.push(`${name.padEnd(29)} ${shown}`);
  }

  /**
   * THE ONE DERIVED LINE, because it is the question that gets asked next.
   *
   * A sealed vault is necessary and not sufficient: `proposeClassEntries` also
   * requires the route switched on, a non-zero size, room for another position,
   * and a live rail. Listing the fields without saying which of them is the
   * blocker invites the same guess this module was written to stop.
   */
  const blockers: string[] = [];
  if (f.grantClassVault === null) blockers.push("no class vault sealed in the grant (needs a re-sign)");
  if (f.classSnipeEnabled !== true) blockers.push("classSnipeEnabled is not true");
  if ((f.classPerEntryUsdg ?? 0) <= 0) blockers.push("classPerEntryUsdg is 0");
  if ((f.classMaxPositions ?? 0) <= 0) blockers.push("classMaxPositions is 0");
  if (f.liveTradingEnabled !== true) blockers.push("liveTradingEnabled is not true");
  if (f.assetMode === "stocks") blockers.push('assetMode is "stocks", which excludes the whole route');
  // EXPLICIT FALSE, not falsy. Every other test above reads an unset field as
  // off, because those fields default off. This one defaults ON, so `null` here
  // means "discovery is running under the default" and treating it as a blocker
  // would report a starved route for most of the fleet.
  if (f.discoveryEnabled === false) {
    blockers.push(
      "discoveryEnabled is false — the launchpad scanner never runs, so the candidate table stays empty " +
        "and the funnel reports `scanned 0` however open the gates below are",
    );
  }

  lines.push(``);
  lines.push(
    blockers.length === 0
      ? `class route: every gate this module can see is OPEN`
      : `class route BLOCKED BY: ${blockers.join("; ")}`,
  );
  // WHAT THIS MODULE STILL CANNOT SEE, said out loud next to the verdict.
  //
  // The candidate table is `discovered_pools` in the CHILD's sqlite, which is
  // ephemeral and reachable from nowhere but the child. So "every gate is OPEN"
  // is a statement about configuration and never a statement about supply: a
  // route with every gate open and an empty table buys nothing, and the only
  // thing that can report that is the child's own `[class census]` line.
  lines.push(
    `not visible from here: the candidate table itself (child sqlite) — ` +
      `read the child's "[class census] curve rows N all" line for supply`,
  );
  return lines;
}

/**
 * THE POSITION CEILING, AND WHAT IT IS ACTUALLY COUNTING.
 *
 * `proposeClassEntries` ends with
 *   `if (cfg.classMaxPositions > 0 && held.length >= cfg.classMaxPositions) return []`
 * where `held` is `classPositions(agentId)` — which selects
 * `WHERE agent_id = ?` and applies NO state predicate. So CLOSED, SWEPT and
 * RECOVERED rows count against the ceiling exactly like open ones, and nothing
 * ever deletes them.
 *
 * WHY IT MATTERS MORE THAN AN ORDINARY OFF-BY-ONE. The gate sits BELOW the
 * funnel, writes no log line, and is not covered by the `· BUYING OFF` suffix
 * (which keys only on `classSnipeEnabled` and `classPerEntryUsdg`). An agent at
 * the ceiling therefore prints `… → 1 qualified` every tick and never buys,
 * which is the exact reading that sends an operator to the executor and the
 * wall. A route that has completed `classMaxPositions` round trips is off
 * permanently, and says nothing.
 *
 * Reported as BOTH numbers, never one: the count the gate uses, and the count
 * of positions actually standing. When they differ, the difference is the bug
 * and this says so rather than leaving it to be noticed.
 */
export interface ClassPositionCensus {
  /** Every row for this agent, whatever its state — what the ceiling counts. */
  states: readonly (string | null)[];
  /** `classMaxPositions`, or null when unset (the gate is then inert). */
  ceiling: number | null;
}

/** States that are a position the agent still has money or tokens in. */
const STANDING = new Set(["open", "recovered"]);

export function describeClassPositions(c: ClassPositionCensus): string[] {
  const lines: string[] = [];
  const total = c.states.length;
  const standing = c.states.filter((s) => s !== null && STANDING.has(s)).length;
  const tally = new Map<string, number>();
  for (const s of c.states) tally.set(s ?? "(null)", (tally.get(s ?? "(null)") ?? 0) + 1);
  const shown = [...tally].sort().map(([s, n]) => `${n}×${s}`).join(", ");

  lines.push(``);
  lines.push(`class positions: ${total} row(s) — ${shown || "none"}`);
  lines.push(`  standing (open/recovered): ${standing}`);
  lines.push(`  counted by the ceiling:    ${total}   <- classPositions applies no state filter`);
  if (c.ceiling === null || c.ceiling <= 0) {
    lines.push(`  classMaxPositions is ${c.ceiling === null ? "unset" : String(c.ceiling)} — the ceiling does not bind`);
    return lines;
  }
  lines.push(`  classMaxPositions:         ${c.ceiling}`);
  if (total >= c.ceiling) {
    lines.push(
      `  *** ENTRIES ARE SHUT: ${total} >= ${c.ceiling}. proposeClassEntries returns [] with NO log line, ` +
        `below the funnel — so the funnel keeps printing "qualified" and nothing is ever bought.`,
    );
    if (standing < c.ceiling) {
      lines.push(
        `  *** AND IT IS COUNTING ${total - standing} FINISHED POSITION(S). Only ${standing} are standing; ` +
          `the ceiling is held shut by rows the agent has already exited.`,
      );
    }
  } else {
    lines.push(`  room for ${c.ceiling - total} more by the count the gate uses`);
  }
  return lines;
}

/**
 * THE SECOND QUESTION THIS MODULE GETS ASKED: why is the breaker refusing?
 *
 * The drawdown breaker divides by `agents.hwm_usdg` (policy.ts:725-731), and
 * that figure lives in the SHARED database — the one an operator's machine
 * cannot reach. So "is this a real drawdown or a stale peak?" was, like the
 * settings question above, answerable only by guessing.
 *
 * ONE INVARIANT MAKES THE ANSWER CHECKABLE. A peak is contributed capital plus
 * realised profit. An agent that has never traded has no realised profit, so
 * for it the peak MUST equal net contributions. When the durable peak exceeds
 * what the owner ever put in, the excess is not performance — it is money the
 * book is still counting after it left, or counted twice on the way in. That is
 * a defect in the accounting, and it is reported here as one rather than
 * rendered as a drawdown the owner is expected to trade out of.
 *
 * SAME DISCIPLINE AS ABOVE: a flat record of named numbers. No settings blob,
 * no grant, no keys.
 */
export interface AccountingFacts {
  smartAccount: string | null;
  /**
   * The EFFECTIVE peak: `hwm_usdg − hwm_withdrawn_usdg`, floored at zero.
   *
   * What the drawdown breaker actually divides by. Reporting the raw column
   * instead printed "5470bps — REFUSING every buy" about an account the engine
   * was reading at 0bps — the confidently-wrong number this module exists to
   * stop, produced by this module.
   */
  durableHwmUsdg: number | null;
  /** Σ every upward move. Shown so the effective figure can be checked. */
  durableHwmGrossUsdg: number | null;
  /** Σ withdrawals that have taken the peak down. */
  durableHwmWithdrawnUsdg: number | null;
  durableAccruedFeeUsdg: number | null;
  durableEpoch: number | null;
  /** On-chain equity right now, in USDG. Null when the chain would not answer. */
  equityUsdg: number | null;
  /** The owner's own signed ceiling, from `grant.caps.maxDrawdownPct`. */
  maxDrawdownBps: number | null;
  /** Every durable flow row for this agent, oldest first. Null when unread. */
  flows:
    | {
        direction: string;
        amountUsdg: number;
        source: string;
        txHash: string | null;
        blockNumber: number | null;
      }[]
    | null;
  /** How many trade rows the shared ledger holds. Null when unread. */
  trades: number | null;
  /** Set when a read threw — distinct from "no rows". */
  error: string | null;
}

const usd = (n: number): string => n.toFixed(6);

/**
 * The accounting report, and the one derived verdict worth printing.
 *
 * EVERY UNKNOWN STAYS UNKNOWN. A null peak is not zero and a null flow list is
 * not an empty one; the whole reason this file exists is that somebody was
 * about to act on that difference.
 */
export function describeAccounting(f: AccountingFacts): string[] {
  const lines: string[] = [``, `── accounting ─────────────────────────────────`];
  if (f.error !== null) {
    lines.push(`accounting UNREADABLE — ${f.error}`);
    lines.push(`(nothing below is known; do NOT read a missing figure as zero)`);
    return lines;
  }

  lines.push(`smartAccount                  ${f.smartAccount ?? "UNKNOWN"}`);
  lines.push(
    `durable peak (effective)      ${f.durableHwmUsdg === null ? "UNKNOWN" : usd(f.durableHwmUsdg)}` +
      (f.durableHwmGrossUsdg === null
        ? ""
        : `  = gross ${usd(f.durableHwmGrossUsdg)} − withdrawn ${usd(f.durableHwmWithdrawnUsdg ?? 0)}`),
  );
  lines.push(
    `durable accrued_fee_usdg      ${f.durableAccruedFeeUsdg === null ? "UNKNOWN" : usd(f.durableAccruedFeeUsdg)}`,
  );
  lines.push(`durable epoch                 ${f.durableEpoch ?? "UNKNOWN"}`);
  lines.push(`equity now (on chain)         ${f.equityUsdg === null ? "UNKNOWN" : usd(f.equityUsdg)}`);
  lines.push(`trade rows in shared ledger   ${f.trades ?? "UNKNOWN"}`);
  lines.push(
    `maxDrawdownBps (signed cap)   ${f.maxDrawdownBps === null ? "UNKNOWN" : String(f.maxDrawdownBps)}`,
  );

  if (f.durableHwmUsdg !== null && f.durableHwmUsdg > 0 && f.equityUsdg !== null) {
    const bps = Math.floor(((f.durableHwmUsdg - f.equityUsdg) / f.durableHwmUsdg) * 10_000);
    lines.push(
      `→ breaker reads                ${bps}bps` +
        (f.maxDrawdownBps === null ? `` : bps >= f.maxDrawdownBps ? ` — REFUSING every buy` : ` — under the cap`),
    );
  }

  lines.push(``);
  if (f.flows === null) {
    lines.push(`flows UNREADABLE`);
    return lines;
  }
  if (f.flows.length === 0) {
    lines.push(`flows: NONE on record — the book has never seen capital arrive`);
  }
  let net = 0;
  for (const fl of f.flows) {
    net += fl.direction === "in" ? fl.amountUsdg : -fl.amountUsdg;
    lines.push(
      `  ${fl.direction === "in" ? "IN " : "OUT"} ${usd(fl.amountUsdg).padStart(14)}` +
        `  running ${usd(net).padStart(14)}  ${fl.source.padEnd(11)}` +
        `  ${fl.txHash ? fl.txHash.slice(0, 12) + "…" : "(no tx)"}` +
        `  ${fl.blockNumber ?? ""}`,
    );
  }
  lines.push(`net contributions             ${usd(net)}`);

  // THE VERDICT. Only stated when the premise for it actually holds: a peak
  // above contributions is only provably wrong when there is no realised
  // profit that could explain it, and only a zero trade count establishes that.
  if (f.durableHwmUsdg !== null && f.trades !== null && f.flows.length > 0) {
    const excess = f.durableHwmUsdg - net;
    if (f.trades === 0 && excess > 0.000001) {
      lines.push(
        `→ DEFECT: the peak exceeds contributed capital by ${usd(excess)} USDG on ZERO trades. ` +
          `With no realised profit the peak cannot exceed what was put in, so this is money the ` +
          `book is still counting after it left (or counted twice on the way in) — not a drawdown.`,
      );
    } else if (f.trades === 0) {
      lines.push(`→ peak agrees with contributed capital on zero trades`);
    } else {
      lines.push(
        `→ ${f.trades} trade(s) on record, so realised profit may legitimately explain a peak ` +
          `above contributions — this module cannot settle it alone`,
      );
    }
  }
  return lines;
}

/**
 * WHERE THE MONEY WENT, when the peak and the equity disagree.
 *
 * `describeAccounting` can say the peak is above what is left; it cannot say
 * whether the shortfall is a LOSS (which the breaker exists to stop, and which
 * nothing here may repair away) or a WITHDRAWAL (which should have moved the
 * peak with it and did not). Only the position ledger separates those, so this
 * prints it: what was bought, what it cost, what came back, and how each row
 * ended.
 *
 * `swept` is the answer that matters: the owner took the asset home, so the
 * position is gone with no sale, no proceeds and no result.
 *
 * THIS COMMENT USED TO NAME `recovered` FOR THAT, AND IT WAS WRONG. `recovered`
 * is reached only under `if (balance > 0n)` (class-reconcile.ts) and means a
 * holding STILL IN the vault whose purchase the tape cannot explain — an
 * unknown basis, not a withdrawal. A sweep leaves a zero balance, which took
 * the other branch entirely and landed on `closed`, beside genuine
 * liquidations, with `proceeds 0` next to a real cost. That is what made a
 * withdrawal read as a total loss, and reading this comment while fixing it
 * would have sent the fix to the wrong branch.
 */
export interface LedgerFacts {
  /** Trade rows by status: `{landed: 2, rejected: 94}`. Null when unread. */
  tradesByStatus: Record<string, number> | null;
  /** Non-class positions still on the books. Null when unread. */
  openPositions: { symbol: string; custody: string; qty: string }[] | null;
  /** Class rows, whatever their state. Null when unread. */
  classPositions:
    | { symbol: string; state: string; costUsdg: string | null; proceedsUsdg: string | null }[]
    | null;
  error: string | null;
}

export function describeLedger(f: LedgerFacts): string[] {
  const lines: string[] = [``, `── where the money went ───────────────────────`];
  if (f.error !== null) {
    lines.push(`ledger UNREADABLE — ${f.error}`);
    return lines;
  }

  if (f.tradesByStatus === null) lines.push(`trades by status             UNKNOWN`);
  else {
    const entries = Object.entries(f.tradesByStatus).sort((a, b) => b[1] - a[1]);
    lines.push(
      `trades by status             ${entries.length === 0 ? "none" : entries.map(([k, v]) => `${k}=${v}`).join(" ")}`,
    );
    // THE FIGURE THE DRAWDOWN QUESTION TURNS ON. A rejected trade moved no
    // money, so a book full of them cannot have lost any.
    const moved = entries.filter(([k]) => k === "landed" || k === "submitted").reduce((n, [, v]) => n + v, 0);
    lines.push(`  of which actually moved    ${moved}`);
  }

  if (f.openPositions === null) lines.push(`open positions               UNKNOWN`);
  else if (f.openPositions.length === 0) lines.push(`open positions               none`);
  else for (const p of f.openPositions) lines.push(`  ${p.symbol.padEnd(10)} ${p.custody.padEnd(8)} ${p.qty}`);

  if (f.classPositions === null) lines.push(`class positions              UNKNOWN`);
  else if (f.classPositions.length === 0) lines.push(`class positions              none`);
  else
    for (const p of f.classPositions)
      lines.push(
        `  ${p.symbol.padEnd(10)} ${p.state.padEnd(10)} cost ${p.costUsdg ?? "unknown"} proceeds ${p.proceedsUsdg ?? "unknown"}`,
      );
  return lines;
}

/**
 * THE FOUR ROWS THAT MOVED MONEY, IN FULL.
 *
 * A count of landed trades is enough to refuse a verdict and not enough to
 * reach one. When the question is "how much of the missing capital went HOME
 * and how much was LOST", the answer is per-row and the rows are few, so they
 * are printed whole rather than summarised into a figure that hides the
 * distinction the question turns on.
 *
 * Rejections are excluded on purpose: 94 of them moved nothing, and listing
 * them would bury the four that did.
 */
export interface MovementFacts {
  landed:
    | {
        kind: string;
        target: string;
        amountUsdg: number;
        status: string;
        txHash: string | null;
        /**
         * NULL is the honest value and the one that matters here.
         *
         * `applyFill` returns `basisUnknown` when a sell meets no cost basis,
         * and `bookFill` then writes NULL rather than a zero — so a round trip
         * that completed with no basis reads as "no result recorded", not as
         * "broke even". `getRealizedPnlUsdg` excludes these rows.
         */
        realizedPnlUsdg: number | null;
        /**
         * Whether `bookFill` ran at all for this trade.
         *
         * NULL means it did not: the fill columns are written only by that
         * function. It is the difference between "the sell had no cost basis to
         * measure against" and "the sell was never booked as a fill", which read
         * identically in a NULL realised P&L and need opposite fixes.
         */
        fillSide: string | null;
        basisSource: string | null;
      }[]
    | null;
  classRows:
    | {
        token: string;
        symbol: string | null;
        state: string;
        costUsdg: string | null;
        proceedsUsdg: string | null;
        qtyRaw: string | null;
        openedAtBlock: string | null;
        /**
         * The clock the EXIT is measured against — `first_seen`, unix seconds.
         *
         * Not `opened_at_block`. `proposeClassExits` computes
         * `heldSec = now - firstSeen`, and `first_seen` DEFAULTS TO NOW on a
         * rebuilt row, so a container restart stamps a position as brand new and
         * would restart its six-hour hold. `rehydrateClassRow` corrects it back
         * from the entry block; this is how you check that it did.
         */
        firstSeen: number | null;
        /** The two fields the SELL leg is built from. Without them there is no exit. */
        curve: string | null;
        quoteToken: string | null;
        entryTx: string | null;
        exitTx: string | null;
      }[]
    | null;
  error: string | null;
}

export function describeMovements(f: MovementFacts): string[] {
  const lines: string[] = [``, `── every row that moved money ─────────────────`];
  if (f.error !== null) {
    lines.push(`movements UNREADABLE — ${f.error}`);
    return lines;
  }
  if (f.landed === null) lines.push(`landed trades                UNKNOWN`);
  else if (f.landed.length === 0) lines.push(`landed trades                none`);
  else
    for (const t of f.landed)
      lines.push(
        `  ${t.status.padEnd(10)} ${t.kind.padEnd(12)} ${t.amountUsdg.toFixed(6).padStart(12)} USDG ` +
          `→ ${t.target}  ${t.txHash ? t.txHash.slice(0, 12) + "…" : "(no tx)"}  ` +
          `realised ${t.realizedPnlUsdg === null ? "NOT RECORDED" : t.realizedPnlUsdg.toFixed(6)}` +
          `  fill ${t.fillSide ?? "NEVER BOOKED"}/${t.basisSource ?? "-"}`,
      );

  lines.push(``);
  if (f.classRows === null) lines.push(`class rows                   UNKNOWN`);
  else if (f.classRows.length === 0) lines.push(`class rows                   none`);
  else
    for (const c of f.classRows) {
      lines.push(`  ${c.token}  ${c.symbol ?? "(no symbol)"}  state=${c.state}`);
      // THE EXIT IS BUILT FROM THESE TWO. A position with a cost and a clock but
      // no curve cannot be sold at all, which is the failure worth seeing before
      // it is needed rather than at the moment it is.
      lines.push(`    curve ${c.curve ?? "MISSING — NO EXIT CAN BE BUILT"} · quote ${c.quoteToken ?? "MISSING"}`);
      lines.push(
        `    hold clock first_seen ${c.firstSeen ?? "UNKNOWN"}` +
          (c.firstSeen === null
            ? ""
            : ` (${new Date(c.firstSeen * 1000).toISOString()}) — held ${Math.round((Date.now() / 1000 - c.firstSeen) / 60)}m`),
      );
      lines.push(
        `    cost ${c.costUsdg ?? "UNKNOWN"} · proceeds ${c.proceedsUsdg ?? "UNKNOWN"} · qty ${c.qtyRaw ?? "UNKNOWN"}`,
      );
      lines.push(
        `    opened at block ${c.openedAtBlock ?? "UNKNOWN"} · entry ${c.entryTx ? c.entryTx.slice(0, 12) + "…" : "(none)"} · ` +
          `exit ${c.exitTx ? c.exitTx.slice(0, 12) + "…" : "(none)"}`,
      );
    }
  return lines;
}
