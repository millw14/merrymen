/**
 * WHERE THE GAS ACTUALLY WENT, operation by operation.
 *
 * The canary publishes a return of −73.8% on a 10.000000 USDG book. Only −4.1%
 * of that is the market: the other 69.7 percentage points are gas —
 * 6.969946 USDG across four landed operations, ~94% of the entire published
 * loss. A user reading that number believes the strategy lost three quarters of
 * their money. That is not what happened, and the difference between those two
 * stories is the whole reason this module exists.
 *
 * WHY A SINGLE AVERAGE IS THE WRONG ANSWER. An ERC-4337 account's FIRST
 * UserOperation carries `initCode`: the factory call that deploys the account,
 * plus whatever modules the grant installs. That is a one-time authorization
 * cost, it is charged as gas on whichever operation happens to be first, and it
 * lands in `trades.gas_usdg` on a row whose `kind` says `swap` — there is no
 * `enable` kind, so nothing in the schema marks it as setup. Divide the total
 * by the operation count and you get an "average trade costs 1.74 USDG"
 * that is wrong in the most expensive direction: it teaches every future
 * decision that trading is uneconomic when the money was spent once, on
 * turning the account on, and is already sunk.
 *
 * So this splits the total into:
 *
 *   setup / authorization    the first landed op's excess over the steady rate
 *   steady-state execution   what the NEXT trade will actually cost
 *   sponsored               what somebody else paid, never the owner's cost
 *   unpriced                landed ops whose gas could not be valued — named,
 *                           never silently treated as free
 *   reverted                gas burned on operations that did not land, which
 *                           the published figure does not count at all
 *
 * PURE, and every figure carries its evidence. `gasWei` and the userOp/tx
 * hashes travel with each line so any claim here can be checked against the
 * chain rather than believed.
 *
 * THE PREMIUM IS DERIVED, NOT PROVEN. "The first op cost more than the others"
 * is arithmetic this module can do. "Because it deployed the account" is a
 * claim about the chain, and `deploymentConfirmed` is only ever set by a caller
 * that went and looked at the EntryPoint's `AccountDeployed` event. Until then
 * the field says `null`, and the wording says "excess over steady state" rather
 * than "deployment".
 */

/** One operation as the ledger recorded it. Column names are the table's. */
export interface GasOp {
  id: number;
  kind: string;
  target: string;
  amountUsdg: number;
  status: string;
  userOpHash: string | null;
  txHash: string | null;
  /** Wei this owner paid. Null when the op never reached a receipt. */
  gasWei: string | null;
  /**
   * Gas UNITS charged. Null on rows written before it was captured.
   *
   * The stable half of the cost. Measured on the canary: op #1 used 6,019,786
   * units and ops #2-#4 used 526,934 / 509,850 / 510,760 — a clean 11.8x — while
   * the gas PRICE over the same four ops ranged 0.330 to 0.610 gwei. Splitting
   * on wei alone would have credited that price swing to the operations rather
   * than to the chain.
   */
  gasUnits: string | null;
  /** Wei somebody ELSE paid. Never the owner's cost — see the store's comment. */
  sponsoredGasWei: string | null;
  /** The valued cost, USDG. NULL means could-not-price, which is not zero. */
  gasUsdg: number | null;
  epoch: number;
  createdAt: number;
}

export interface KindTotal {
  ops: number;
  gasUsdg: number;
  /** Sum of `amount_usdg` — what was being traded, for a gas-to-size ratio. */
  notionalUsdg: number;
}

export interface GasDecomposition {
  account: string;
  epoch: number;
  /** Every landed op, oldest first. */
  landed: GasOp[];
  /** Landed ops that carry a gas figure. The others are named, not assumed. */
  priced: GasOp[];
  unpriced: GasOp[];
  /** Landed ops somebody else paid for. Excluded from the owner's total. */
  sponsored: GasOp[];
  /** Ops that burned gas without landing. Real spend the published figure omits. */
  reverted: GasOp[];

  /** What the published P&L subtracts: landed gas only. */
  totalLandedGasUsdg: number;
  revertedGasUsdg: number;
  byKind: Record<string, KindTotal>;

  /** The account's first landed op — the one that carries any setup cost. */
  first: GasOp | null;
  /** Every priced landed op after the first. */
  subsequent: GasOp[];
  steadyMedianUsdg: number | null;
  steadyMeanUsdg: number | null;
  steadyMaxUsdg: number | null;

  /**
   * First-op cost less the steady-state rate, when both are known and the
   * first genuinely cost more. Null when there is nothing to compare against —
   * one landed op tells you nothing about which part of it was one-time.
   */
  setupPremiumUsdg: number | null;
  /** Only a caller that checked the chain may set this. */
  deploymentConfirmed: boolean | null;
  /**
   * Which quantity the premium was split on.
   *
   * "usdg" means gas units were not recorded, so the figure carries whatever
   * the base fee did between the first operation and the later ones — stated
   * rather than hidden, so nobody quotes it as though it were exact.
   */
  premiumBasis: "units" | "usdg" | "none";
  /** Steady-state gas UNITS per operation, when they were recorded. */
  steadyMedianUnits: number | null;

  /** What the NEXT trade should be expected to cost. */
  marginalGasUsdg: number | null;
  /** That cost as a share of a typical trade, in percent. */
  marginalShareOfTradePct: number | null;
  /** The typical trade size the share above is measured against. */
  typicalTradeUsdg: number | null;
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * WHICH OPERATIONS ARE TRADES.
 *
 * A vault deposit moves money between two pockets inside the same wall — it is
 * not a position and its size is not a trade size, so folding it into a
 * gas-per-trade ratio would divide real gas by a notional nobody traded. It
 * still COSTS gas, so it stays in the total; it is only excluded from the
 * denominator.
 */
const TRADE_KINDS = new Set(["swap", "curve-trade"]);

/**
 * Decompose. PURE — no database, no clock, no environment.
 *
 * `ops` must be every row for one account in one epoch, oldest first. The
 * ordering is load-bearing: "first" means first, and a caller that sorts by id
 * descending would attribute the setup cost to the most recent trade.
 */
export function decomposeGas(account: string, epoch: number, ops: readonly GasOp[]): GasDecomposition {
  const landed = ops.filter((o) => o.status === "landed");
  const reverted = ops.filter((o) => o.status === "reverted");

  // SPONSORED IS NOT THE OWNER'S COST. `gas_wei` means "what this owner spent"
  // and `sponsored_gas_wei` means "what somebody else did" — the store keeps
  // them in separate columns precisely so this distinction survives.
  const sponsored = landed.filter((o) => o.sponsoredGasWei !== null && o.sponsoredGasWei !== "");
  const owned = landed.filter((o) => !sponsored.includes(o));

  const priced = owned.filter((o) => typeof o.gasUsdg === "number" && Number.isFinite(o.gasUsdg));
  const unpriced = owned.filter((o) => !priced.includes(o));

  const totalLandedGasUsdg = priced.reduce((n, o) => n + (o.gasUsdg ?? 0), 0);
  const revertedGasUsdg = reverted.reduce((n, o) => n + (o.gasUsdg ?? 0), 0);

  const byKind: Record<string, KindTotal> = {};
  for (const o of priced) {
    const k = (byKind[o.kind] ??= { ops: 0, gasUsdg: 0, notionalUsdg: 0 });
    k.ops += 1;
    k.gasUsdg += o.gasUsdg ?? 0;
    k.notionalUsdg += Number.isFinite(o.amountUsdg) ? o.amountUsdg : 0;
  }

  const first = priced[0] ?? null;
  const subsequent = priced.slice(1);
  const rest = subsequent.map((o) => o.gasUsdg ?? 0);

  const steadyMedianUsdg = median(rest);
  const steadyMeanUsdg = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : null;
  const steadyMaxUsdg = rest.length ? Math.max(...rest) : null;

  // ── THE PREMIUM, IN UNITS WHERE UNITS EXIST ───────────────────────────────
  //
  // A PREMIUM NEEDS SOMETHING TO BE A PREMIUM OVER. With one landed op there is
  // no steady state to compare against, and calling the whole of it "setup"
  // would be a guess dressed as a decomposition.
  //
  // WHEN GAS UNITS ARE RECORDED the split is done on them and converted at the
  // FIRST OP'S OWN gas price, because that is the price at which the setup work
  // was actually bought. Doing it on USDG instead credits the chain's base fee
  // to the operation: the canary's four ops ranged 0.330-0.610 gwei, and a
  // USDG-median split put setup at 4.224 USDG where the unit split puts it at
  // 4.565 — an 8% error on a number that will be subtracted from a user's
  // return and handed to a model as the cost of doing business.
  const unitsOf = (o: GasOp | null): number | null => {
    const raw = o?.gasUnits;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const firstUnits = unitsOf(first);
  const laterUnits = subsequent.map(unitsOf).filter((n): n is number => n !== null);
  const steadyMedianUnits = median(laterUnits);

  let setupPremiumUsdg: number | null = null;
  let premiumBasis: "units" | "usdg" | "none" = "none";
  if (
    first !== null &&
    firstUnits !== null &&
    steadyMedianUnits !== null &&
    firstUnits > steadyMedianUnits &&
    (first.gasUsdg ?? 0) > 0
  ) {
    const pricePerUnit = (first.gasUsdg ?? 0) / firstUnits;
    setupPremiumUsdg = (firstUnits - steadyMedianUnits) * pricePerUnit;
    premiumBasis = "units";
  } else if (first !== null && steadyMedianUsdg !== null && (first.gasUsdg ?? 0) > steadyMedianUsdg) {
    setupPremiumUsdg = (first.gasUsdg ?? 0) - steadyMedianUsdg;
    premiumBasis = "usdg";
  }

  // WHAT THE NEXT TRADE COSTS. The median of the ops after the first — not the
  // mean, which one deployment-inflated outlier drags upward, and not the
  // overall average, which is the mistake this module exists to prevent.
  const marginalGasUsdg = steadyMedianUsdg;

  const tradeSizes = priced
    .filter((o) => TRADE_KINDS.has(o.kind) && Number.isFinite(o.amountUsdg) && o.amountUsdg > 0)
    .map((o) => o.amountUsdg);
  const typicalTradeUsdg = median(tradeSizes);
  const marginalShareOfTradePct =
    marginalGasUsdg !== null && typicalTradeUsdg !== null && typicalTradeUsdg > 0
      ? (marginalGasUsdg / typicalTradeUsdg) * 100
      : null;

  return {
    account,
    epoch,
    landed,
    priced,
    unpriced,
    sponsored,
    reverted,
    totalLandedGasUsdg,
    revertedGasUsdg,
    byKind,
    first,
    subsequent,
    steadyMedianUsdg,
    steadyMeanUsdg,
    steadyMaxUsdg,
    setupPremiumUsdg,
    deploymentConfirmed: null,
    premiumBasis,
    steadyMedianUnits,
    marginalGasUsdg,
    marginalShareOfTradePct,
    typicalTradeUsdg,
  };
}

const usd = (n: number | null): string => (n === null ? "—" : n.toFixed(6));
const short = (h: string | null): string => (h ? `${h.slice(0, 10)}…` : "—");

/**
 * The report, one line at a time.
 *
 * Sized for a log window that holds 503 lines and is shared with a mirror that
 * writes 200 a minute, so it stays compact and puts the evidence — userOp and
 * tx hashes — on the per-operation lines where a reader can check them.
 */
export function gasAuditLines(d: GasDecomposition): string[] {
  const out: string[] = [];
  out.push(
    `${d.account} epoch ${d.epoch} — ${d.landed.length} landed, ${d.priced.length} priced, ` +
      `${d.unpriced.length} unpriced, ${d.sponsored.length} sponsored, ${d.reverted.length} reverted`,
  );

  for (const [i, o] of d.priced.entries()) {
    // FULL HASHES on the per-operation lines. The summary below can abbreviate
    // because it is a pointer; these are the evidence, and a truncated hash
    // cannot be looked up — which makes it a decoration rather than a citation.
    // NOTE `tx_hash` is the BUNDLED transaction and is shared with other
    // people's operations; `user_op_hash` is the one that identifies ours.
    out.push(
      `  #${i + 1} ${o.kind.padEnd(14)} ${usd(o.gasUsdg)} USDG gas · ` +
        `${o.amountUsdg.toFixed(4)} USDG notional · wei ${o.gasWei ?? "—"}`,
    );
    out.push(`      op ${o.userOpHash ?? "—"}`);
    out.push(`      tx ${o.txHash ?? "—"} (bundled — shared with other senders)`);
  }
  for (const o of d.unpriced) {
    // NAMED, never dropped. An op whose gas could not be valued is not free,
    // and a total that quietly excludes it understates the real cost.
    out.push(`  UNPRICED ${o.kind} · op ${short(o.userOpHash)} · wei ${o.gasWei ?? "—"} — cost unknown, not zero`);
  }
  for (const o of d.sponsored) {
    out.push(`  SPONSORED ${o.kind} · op ${short(o.userOpHash)} · wei ${o.sponsoredGasWei} — somebody else paid`);
  }

  for (const [kind, k] of Object.entries(d.byKind)) {
    out.push(
      `  by kind ${kind.padEnd(14)} ${k.ops} op(s) ${usd(k.gasUsdg)} USDG gas over ` +
        `${k.notionalUsdg.toFixed(4)} USDG notional`,
    );
  }

  out.push(`  TOTAL landed gas      ${usd(d.totalLandedGasUsdg)} USDG  (this is what the published P&L subtracts)`);
  if (d.revertedGasUsdg > 0) {
    out.push(
      `  reverted gas          ${usd(d.revertedGasUsdg)} USDG  — real spend the published figure does NOT count`,
    );
  }
  out.push(`  first landed op       ${usd(d.first?.gasUsdg ?? null)} USDG  op ${short(d.first?.userOpHash ?? null)}`);
  out.push(
    `  steady state          median ${usd(d.steadyMedianUsdg)} · mean ${usd(d.steadyMeanUsdg)} · ` +
      `max ${usd(d.steadyMaxUsdg)} USDG over ${d.subsequent.length} later op(s)`,
  );
  out.push(
    `  setup premium         ${usd(d.setupPremiumUsdg)} USDG  ` +
      (d.setupPremiumUsdg === null
        ? "(not derivable — no later op to compare against)"
        : d.premiumBasis === "units"
          ? `(split on GAS UNITS: ${d.first?.gasUnits ?? "?"} vs a steady ${d.steadyMedianUnits ?? "?"}, ` +
            `valued at the first op's own gas price)`
          : "(split on USDG — gas units were not recorded, so this figure carries the base-fee " +
            "movement between the first op and the later ones)") +
      (d.deploymentConfirmed === true ? " · EntryPoint AccountDeployed CONFIRMED" : ""),
  );
  out.push(
    `  MARGINAL next trade   ${usd(d.marginalGasUsdg)} USDG` +
      (d.marginalShareOfTradePct !== null
        ? ` = ${d.marginalShareOfTradePct.toFixed(1)}% of a typical ${usd(d.typicalTradeUsdg)} USDG trade`
        : " (no trade-sized op to measure against)"),
  );
  return out;
}
