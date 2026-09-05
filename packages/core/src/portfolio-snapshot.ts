/**
 * THE ONE DESCRIPTION OF WHAT AN AGENT OWNS AND HOW IT IS DOING.
 *
 * It lives in core rather than in the worker, the web tier or Brain, because
 * three copies of "what is this book worth" is how you get three answers. The
 * worker computes equity from balances, the web recomputed it from mirrored
 * rows, and Brain would have been the third — and each would have been right
 * about slightly different things. The whole accounting effort behind this file
 * exists because numbers that disagree are worse than numbers that are missing.
 *
 * SO: one type, one builder, four consumers — worker, web, social, Brain.
 *
 * MONEY IS INTEGER MICRO-USDG throughout. Not a preference: the ledger stores
 * decimal REAL, the chain speaks base units, and JavaScript's number silently
 * loses the difference. A snapshot that crosses a service boundary as a float is
 * a snapshot whose last decimal place depends on who parsed it.
 *
 * THE THREE THINGS THIS TYPE REFUSES TO DO:
 *
 *   1. It will not present UNKNOWN as ZERO. `netContributionsUsdg` is null when
 *      nothing is on record, and every consumer must handle that arm — equity
 *      minus zero is the owner's own bankroll presented as profit, which is the
 *      original bug this whole system was rebuilt around.
 *   2. It will not publish a P&L it cannot back. `pnl.publishable` is computed
 *      HERE, once, from the quality object, rather than left to five different
 *      gates in the web tier that historically disagreed.
 *   3. It will not let gross-of-gas masquerade as net. The basis travels with
 *      the figure.
 */

/** Integer micro-USDG (1e-6 USDG). The only money type that crosses a boundary. */
export type MicroUsdg = number;

export const USDG_SCALE = 1_000_000;

/** Decimal USDG to micro-USDG, rounded once, at the edge. */
export const toMicro = (usdg: number): MicroUsdg => Math.round(usdg * USDG_SCALE);
/** Micro-USDG to a decimal STRING. Never back to a float for display. */
export const microToString = (m: MicroUsdg): string => {
  const neg = m < 0;
  const a = Math.abs(Math.trunc(m));
  return `${neg ? "-" : ""}${Math.floor(a / USDG_SCALE)}.${String(a % USDG_SCALE).padStart(6, "0")}`;
};

/**
 * HOW MUCH OF THIS SNAPSHOT CAN BE TRUSTED, as machine-readable facts.
 *
 * Every field is a claim a consumer may need to refuse on. Prose in a `why`
 * string is for humans; these are for code, and the difference is that code
 * cannot be persuaded.
 */
export interface PortfolioQuality {
  /** The ledger recomputed from fills/flows/marks and matched. */
  auditPassed: boolean;
  /** Accounting epoch. Epoch 1 predates auditable flows and is forensic only. */
  epoch: number;
  /** Contributed capital rests on receipts, not on inference. */
  contributionsKnown: boolean;
  /** The equity series has no gaps in the window this snapshot covers. */
  equityComplete: boolean;
  /**
   * Whether trading costs are subtracted. `gross` means small edges are
   * overstated by exactly the gas, and saying so is the difference between a
   * qualified figure and a wrong one.
   */
  gasBasis: "gross" | "net" | "unknown";
  positionHistoryAvailable: boolean;
  /** Some holdings are carried at cost rather than at market. */
  quarantinedAssetsPresent: boolean;
  /** Unix seconds. A quality flag with no timestamp cannot be told from a stale one. */
  assessedAt: number | null;
}

export interface SnapshotPosition {
  /** Merrymen's canonical id. NEVER an address — see thesis-policy and Brain. */
  instrumentId: string;
  symbol: string;
  /** Base units as a decimal string; token decimals vary (USDG 6, most others 18). */
  qtyRaw: string;
  valueUsdg: MicroUsdg;
  costBasisUsdg: MicroUsdg | null;
  /** Where the price came from. A feed and a pool TWAP are not equal evidence. */
  priceSource: "chainlink" | "pool" | "paper" | "unknown";
  /** Carried at cost because it could not be sold or priced. */
  quarantined: boolean;
}

/**
 * WHY A P&L IS OR IS NOT PUBLISHABLE, decided once.
 *
 * The web tier had five separate gates for this and they disagreed, which is how
 * a `-100%` reached a real owner's screen. A closed union with a distinct arm
 * per reason means a consumer renders the reason rather than inventing one.
 */
export type PnlUnavailable =
  | "contributions-unknown"
  | "no-capital-contributed"
  | "equity-incomplete"
  | "epoch-unauditable";

export interface SnapshotPnl {
  /** equity − contributions − gas, in micro-USDG. Null when not publishable. */
  usdgSinceContribution: MicroUsdg | null;
  publishable: boolean;
  /** Set exactly when `publishable` is false. */
  unavailable: PnlUnavailable | null;
  /** Carried WITH the figure so it cannot be quoted without its qualifier. */
  gasBasis: PortfolioQuality["gasBasis"];
}

export interface PortfolioSnapshot {
  schemaVersion: "1.0.0";
  snapshotId: string;
  agentId: string;
  /** Unix seconds the underlying reads were taken. */
  asOf: number;
  epoch: number;

  cashUsdg: MicroUsdg;
  vaultUsdg: MicroUsdg;
  positionsUsdg: MicroUsdg;
  quarantinedUsdg: MicroUsdg;
  /** cash + vault + positions + quarantined. Computed, never read back. */
  equityUsdg: MicroUsdg;

  /**
   * NULL MEANS UNKNOWN, and unknown is not zero.
   *
   * A ledger written before flow tracking knows nothing about what was put in,
   * and treating that as "nothing was put in" republishes the original bug.
   */
  netContributionsUsdg: MicroUsdg | null;
  grossContributionsUsdg: MicroUsdg | null;
  grossWithdrawalsUsdg: MicroUsdg | null;

  /** Gas actually paid, priced. Null when it could not be priced at burn time. */
  gasUsdg: MicroUsdg | null;

  positions: SnapshotPosition[];
  quality: PortfolioQuality;
  pnl: SnapshotPnl;
}

export interface SnapshotInputs {
  agentId: string;
  asOf: number;
  epoch: number;
  cashUsdg: MicroUsdg;
  vaultUsdg?: MicroUsdg;
  quarantinedUsdg?: MicroUsdg;
  netContributionsUsdg: MicroUsdg | null;
  grossContributionsUsdg?: MicroUsdg | null;
  grossWithdrawalsUsdg?: MicroUsdg | null;
  gasUsdg: MicroUsdg | null;
  positions: SnapshotPosition[];
  quality: PortfolioQuality;
  /** Injected so the builder stays pure and two callers cannot disagree on ids. */
  snapshotId: string;
}

/**
 * Build the snapshot. PURE, and the ONLY place equity and P&L are computed.
 *
 * `buildPortfolioSnapshot` is what stops "web NAV", "worker NAV" and "Brain NAV"
 * from becoming three implementations. A consumer that wants a number calls
 * this; a consumer that computes its own is a bug.
 */
export function buildPortfolioSnapshot(input: SnapshotInputs): PortfolioSnapshot {
  const vault = input.vaultUsdg ?? 0;
  const quarantined = input.quarantinedUsdg ?? 0;
  const positionsUsdg = input.positions
    .filter((p) => !p.quarantined)
    .reduce((sum, p) => sum + p.valueUsdg, 0);

  // THE EQUITY IDENTITY, in one place. cash + vault + positions + quarantined.
  // Quarantined holdings are carried at cost and are still the owner's, so
  // leaving them out understates the book by exactly what cannot be sold.
  const equityUsdg = input.cashUsdg + vault + positionsUsdg + quarantined;

  const pnl = computePnl({
    equityUsdg,
    netContributionsUsdg: input.netContributionsUsdg,
    gasUsdg: input.gasUsdg,
    quality: input.quality,
  });

  return {
    schemaVersion: "1.0.0",
    snapshotId: input.snapshotId,
    agentId: input.agentId,
    asOf: input.asOf,
    epoch: input.epoch,
    cashUsdg: input.cashUsdg,
    vaultUsdg: vault,
    positionsUsdg,
    quarantinedUsdg: quarantined,
    equityUsdg,
    netContributionsUsdg: input.netContributionsUsdg,
    grossContributionsUsdg: input.grossContributionsUsdg ?? null,
    grossWithdrawalsUsdg: input.grossWithdrawalsUsdg ?? null,
    gasUsdg: input.gasUsdg,
    positions: input.positions,
    quality: input.quality,
    pnl,
  };
}

/**
 * ONE GATE, and it is checked in the order the reasons actually bite.
 *
 * The web tier had five gates for this question and they disagreed with each
 * other, which is how a fabricated `-100%` reached an owner's screen. Order
 * matters: an unknown denominator is a different fact from a zero one, and
 * reporting the wrong reason sends whoever reads it to the wrong place.
 */
export function computePnl(args: {
  equityUsdg: MicroUsdg;
  netContributionsUsdg: MicroUsdg | null;
  gasUsdg: MicroUsdg | null;
  quality: PortfolioQuality;
}): SnapshotPnl {
  const basis = args.quality.gasBasis;

  if (args.netContributionsUsdg === null || !args.quality.contributionsKnown) {
    return { usdgSinceContribution: null, publishable: false, unavailable: "contributions-unknown", gasBasis: basis };
  }
  if (args.quality.epoch < 2) {
    // Epoch 1 predates auditable flows by construction. Its rows are kept for
    // forensics and must never be presented as measured.
    return { usdgSinceContribution: null, publishable: false, unavailable: "epoch-unauditable", gasBasis: basis };
  }
  if (args.netContributionsUsdg <= 0) {
    // KNOWN, and zero. That is knowledge — no real capital is at stake — but it
    // is not a denominator, so no percentage rests on it.
    return { usdgSinceContribution: null, publishable: false, unavailable: "no-capital-contributed", gasBasis: basis };
  }
  if (!args.quality.equityComplete) {
    return { usdgSinceContribution: null, publishable: false, unavailable: "equity-incomplete", gasBasis: basis };
  }

  // GAS IS SUBTRACTED WHEN IT IS KNOWN, and the basis says so when it is not.
  // Silently omitting it would overstate every small edge by exactly the gas.
  const gas = args.gasUsdg ?? 0;
  return {
    usdgSinceContribution: args.equityUsdg - args.netContributionsUsdg - gas,
    publishable: true,
    unavailable: null,
    gasBasis: args.gasUsdg === null ? "gross" : basis,
  };
}

/**
 * The percentage, or null. Separated from the figure because a percentage needs
 * a denominator and the figure does not — and every place that has published a
 * wrong number here published a percentage.
 */
export function pnlPercent(snap: PortfolioSnapshot): number | null {
  if (!snap.pnl.publishable || snap.pnl.usdgSinceContribution === null) return null;
  if (!snap.netContributionsUsdg || snap.netContributionsUsdg <= 0) return null;
  return (snap.pnl.usdgSinceContribution / snap.netContributionsUsdg) * 100;
}
