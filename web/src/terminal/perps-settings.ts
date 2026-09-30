/**
 * SETTINGS → PERPETUALS, THE PARTS THAT ARE NOT A SCREEN (docs/perps.md rule 1,
 * rule 4, "Surfaces", "Settings").
 *
 * Every rule the section applies lives here as a plain function, so a test can
 * hold it without a DOM and the component (PerpsSettings.tsx) only renders.
 *
 * ── WHERE EACH NUMBER COMES FROM ─────────────────────────────────────────
 *
 * Bounds and grids: core's PERPS_NUM_BOUNDS, the ONE table the worker's clamp
 * and the settings PUT also read — imported, never retyped, because two
 * literal tables for one rule is how they drift. The consent version: core's
 * PERPS_LIVE_CONSENT_VERSION. The agent's state: `agents.perps`, the worker's
 * report, which the web only READS (core parsePerpsReport; null = not said).
 * Nothing here holds a venue figure — a minimum order, a margin fraction, a
 * price — because those are read live by the worker and a number remembered
 * from the day this was written would be a claim about today that nobody made.
 */
import {
  LIGHTER_MARKETS_V1,
  PERPS_LIVE_CONSENT_VERSION,
  PERPS_MARKETS_MAX,
  PERPS_NUM_BOUNDS,
  grantPerp,
  isPerpKey,
  parsePerpsReport,
  perpsBlockerText,
  perpsNumberOk,
  type PerpMarket,
  type PerpMarketClass,
  type PerpsDriver,
  type PerpsNumKey,
  type PerpsReport,
} from "@merrymen/core";
import { parseAmount } from "@/lib/parse-amount";
import { perpsBookOf, type PerpsBook } from "@/lib/perps-view";

// ── the numeric fields ──────────────────────────────────────────────────

/**
 * The numeric fields in the contract's table order, which is PERPS_NUM_BOUNDS's
 * own key order. Derived, so a bound core adds is a field the section renders
 * (and a label the compiler demands) rather than one it silently lacks.
 */
export const PERPS_NUM_KEYS = Object.keys(PERPS_NUM_BOUNDS) as PerpsNumKey[];

/** What each field is measured in. Leverage reads in x, the stop as a price move. */
export const PERPS_NUM_UNIT = {
  perpsMaxLeverage: "x",
  perpsPerTradeUsdg: "usdg",
  perpsMaxOpenNotionalUsdg: "usdg",
  perpsMaxCollateralUsdg: "usdg",
  perpsMaxOpensPerDay: "perDay",
  perpsStopLossPct: "pct",
  perpsStopSlipBps: "bps",
  perpsTakeProfitPct: "pct",
  perpsLiqBufferPct: "pct",
  perpsMaxSlippageBps: "bps",
} as const satisfies Record<PerpsNumKey, "x" | "usdg" | "perDay" | "pct" | "bps">;

/**
 * What an owner typed, read on the field's OWN grid.
 *
 * Not `unreadableSetting` (lib/parse-amount), which guesses the grid from the
 * key's suffix: `perpsStopLossPct` takes two decimals and that guess reads it
 * as a whole number. The PUT reads perps numbers at PERPS_NUM_BOUNDS' grid
 * too, so the screen and the server agree about what "2,5" is.
 *
 * Bounds ARE checked here, unlike the page's other numbers: the table is
 * core's, imported, so this is the one rule read twice rather than a second
 * copy of it. An empty field is a readable answer — "clear to the default" —
 * and reads as `null`.
 */
export type PerpsNumRead =
  | { ok: true; value: number | null }
  | { ok: false; reason: "rule" }
  | { ok: false; reason: "ambiguous"; readings: number[] };

export function readPerpsNum(key: PerpsNumKey, raw: string): PerpsNumRead {
  if (raw.trim() === "") return { ok: true, value: null };
  const b = PERPS_NUM_BOUNDS[key];
  const parsed = parseAmount(raw, { maxDecimals: b.decimals, min: b.min, max: b.max });
  if (parsed.ok) return perpsNumberOk(key, parsed.value) ? { ok: true, value: parsed.value } : { ok: false, reason: "rule" };
  if (parsed.reason === "ambiguous") return { ok: false, reason: "ambiguous", readings: parsed.readings };
  return { ok: false, reason: "rule" };
}

/** The stored settings the section reads (SettingsView["values"], narrowed to what it uses). */
export interface PerpsStored {
  perpsEnabled?: boolean;
  perpsLiveEnabled?: boolean;
  perpsLiveConsentVersion?: number;
  perpsLiveConsentAt?: number;
  perpsRegionAttested?: boolean;
  perpsDriver?: PerpsDriver;
  perpsMarkets?: string[];
  liveTradingEnabled?: boolean;
  strategy?: string;
  perpsMaxLeverage?: number;
  perpsPerTradeUsdg?: number;
  perpsMaxOpenNotionalUsdg?: number;
  perpsMaxCollateralUsdg?: number;
  perpsMaxOpensPerDay?: number;
  perpsStopLossPct?: number;
  perpsStopSlipBps?: number;
  perpsTakeProfitPct?: number;
  perpsLiqBufferPct?: number;
  perpsMaxSlippageBps?: number;
}

/** The defaults the section falls back to (SETTINGS_DEFAULTS, narrowed). */
export type PerpsDefaults = Record<PerpsNumKey, number> & {
  perpsEnabled: boolean;
  perpsDriver: PerpsDriver;
  perpsMarkets: string[];
  liveTradingEnabled: boolean;
  strategy: string;
};

/**
 * The value IN FORCE for a numeric field as the screen stands: what was typed
 * when it reads, else what is stored, else the default. Used for sentences
 * that describe the combination (the stop at the chosen leverage), never for
 * what is sent.
 */
export function perpsNumInForce(key: PerpsNumKey, typed: string | undefined, stored: PerpsStored, defaults: PerpsDefaults): number {
  if (typed !== undefined) {
    const r = readPerpsNum(key, typed);
    if (r.ok) return r.value ?? defaults[key];
  }
  const s = stored[key];
  return typeof s === "number" && perpsNumberOk(key, s) ? s : defaults[key];
}

// ── the markets ─────────────────────────────────────────────────────────

/** Crypto first (the default markets and perp-trend's whole universe), then the rest. */
export const PERP_CLASS_ORDER: readonly PerpMarketClass[] = ["crypto", "equity", "etf", "metal", "pre-ipo", "meme"];

/** LIGHTER_MARKETS_V1 grouped by class, crypto first, the table's own order inside each. */
export function perpMarketGroups(): { cls: PerpMarketClass; markets: PerpMarket[] }[] {
  return PERP_CLASS_ORDER.map((cls) => ({ cls, markets: LIGHTER_MARKETS_V1.filter((m) => m.cls === cls) })).filter(
    (g) => g.markets.length > 0,
  );
}

/**
 * Markets whose underlying closes — US stocks and funds, and gold and silver —
 * while Lighter keeps trading them. The weekend-gap finding (completeness
 * review, equity-perps-session-gaps): marks barely move while the market is
 * shut and then gap at the open, which a stop cannot protect against. Crypto
 * never closes; pre-IPO and meme markets have no session to close.
 */
export const SESSION_GAP_CLASSES: ReadonlySet<PerpMarketClass> = new Set(["equity", "etf", "metal"]);

export function sessionGapMarkets(keys: readonly string[]): string[] {
  return keys.filter((k) => {
    const m = LIGHTER_MARKETS_V1.find((x) => x.key === k);
    return m !== undefined && SESSION_GAP_CLASSES.has(m.cls);
  });
}

/**
 * The markets IN FORCE, the way the worker resolves them (worker/src/settings.ts,
 * "MARKETS FAIL CLOSED"): an absent list is the default; a stored list keeps
 * only keys this build lists, once each, in order, up to the cap. Starting a
 * draft from anything else would carry a hand-edited unknown key into the next
 * save, which the PUT refuses by name.
 */
export function perpMarketsInForce(stored: PerpsStored, defaults: PerpsDefaults): string[] {
  if (!Array.isArray(stored.perpsMarkets)) return [...defaults.perpsMarkets];
  const out: string[] = [];
  for (const k of stored.perpsMarkets) if (isPerpKey(k) && !out.includes(k)) out.push(k);
  return out.slice(0, PERPS_MARKETS_MAX);
}

// ── the draft and its save ──────────────────────────────────────────────

/** What the owner changed and has not saved. null / absent = untouched. */
export interface PerpsDraft {
  driver: PerpsDriver | null;
  markets: string[] | null;
  nums: Partial<Record<PerpsNumKey, string>>;
}

export const EMPTY_PERPS_DRAFT: PerpsDraft = Object.freeze({ driver: null, markets: null, nums: Object.freeze({}) }) as PerpsDraft;

export function perpsDraftDirty(d: PerpsDraft): boolean {
  return d.driver !== null || d.markets !== null || Object.keys(d.nums).length > 0;
}

export interface PerpsDraftProblems {
  nums: Partial<Record<PerpsNumKey, Exclude<PerpsNumRead, { ok: true }>>>;
  markets: "empty" | "too-many" | null;
  /** The largest position in force, when the total typed or stored is below it — the PUT's own cross-check. */
  openBelowTrade: number | null;
}

/**
 * What stops this draft being sent, judged the way the PUT judges it — so the
 * owner reads the refusal beside the field, before pressing save, rather than
 * as a 400 after.
 */
export function perpsDraftProblems(d: PerpsDraft, stored: PerpsStored, defaults: PerpsDefaults): PerpsDraftProblems {
  const nums: PerpsDraftProblems["nums"] = {};
  for (const k of PERPS_NUM_KEYS) {
    const raw = d.nums[k];
    if (raw === undefined) continue;
    const r = readPerpsNum(k, raw);
    if (!r.ok) nums[k] = r;
  }
  const markets = d.markets === null ? null : d.markets.length === 0 ? "empty" : d.markets.length > PERPS_MARKETS_MAX ? "too-many" : null;
  // Only when the save touches either number, as the route does: a stored pair
  // from an older build must not make every unrelated save fail.
  let openBelowTrade: number | null = null;
  const touchesPair = d.nums.perpsPerTradeUsdg !== undefined || d.nums.perpsMaxOpenNotionalUsdg !== undefined;
  if (touchesPair && !nums.perpsPerTradeUsdg && !nums.perpsMaxOpenNotionalUsdg) {
    const perTrade = perpsNumInForce("perpsPerTradeUsdg", d.nums.perpsPerTradeUsdg, stored, defaults);
    const open = perpsNumInForce("perpsMaxOpenNotionalUsdg", d.nums.perpsMaxOpenNotionalUsdg, stored, defaults);
    if (open < perTrade) openBelowTrade = perTrade;
  }
  return { nums, markets, openBelowTrade };
}

export function perpsDraftBlocked(p: PerpsDraftProblems): boolean {
  return Object.keys(p.nums).length > 0 || p.markets !== null || p.openBelowTrade !== null;
}

/**
 * The PUT body for "Save perpetuals settings": ONLY what was touched, numbers
 * as numbers (read on their grid), an emptied number as null (the route's
 * "clear to the default"). Never a switch and never a consent key — those are
 * their own acts, each with its own save, below.
 *
 * Call only with a draft `perpsDraftProblems` passed; an unreadable number is
 * left out rather than guessed.
 */
export function perpsDraftBody(d: PerpsDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (d.driver !== null) body.perpsDriver = d.driver;
  if (d.markets !== null) body.perpsMarkets = [...d.markets];
  for (const k of PERPS_NUM_KEYS) {
    const raw = d.nums[k];
    if (raw === undefined) continue;
    const r = readPerpsNum(k, raw);
    if (r.ok) body[k] = r.value;
  }
  return body;
}

// ── the two switches ────────────────────────────────────────────────────

/**
 * DOES THE REAL-MONEY CONSENT ON FILE COUNT? Exactly the worker's reading
 * (worker/src/settings.ts, "THE CONSENT IS A RECORD, NOT A SWITCH"): the
 * switch, the CURRENT version, the attestation and the PUT's own stamp. The
 * switch on screen shows this, not `perpsLiveEnabled` alone — a consent to an
 * older text is stored as `true` and trades nothing, and a switch reading "on"
 * over it would tell the owner they are live when they are not.
 */
export function liveConsentCounts(s: PerpsStored): boolean {
  return (
    s.perpsLiveEnabled === true &&
    s.perpsLiveConsentVersion === PERPS_LIVE_CONSENT_VERSION &&
    s.perpsRegionAttested === true &&
    typeof s.perpsLiveConsentAt === "number" &&
    Number.isSafeInteger(s.perpsLiveConsentAt) &&
    s.perpsLiveConsentAt > 0
  );
}

/** Switched on under a consent that no longer counts (an older text, or a partial record). */
export function liveConsentStale(s: PerpsStored): boolean {
  return s.perpsLiveEnabled === true && !liveConsentCounts(s);
}

/**
 * THE CONSENT, AS SENT. The version is core's constant — the text on screen is
 * that version's — and the attestation is `true` only because the panel will
 * not send without its box ticked. `perpsLiveConsentAt` is never sent: the
 * route takes it off any body and stamps its own clock, so a client can
 * neither backdate a consent nor keep an old one looking fresh.
 */
export function perpsLiveOnBody(): { perpsLiveEnabled: true; perpsLiveConsentVersion: number; perpsRegionAttested: true } {
  return { perpsLiveEnabled: true, perpsLiveConsentVersion: PERPS_LIVE_CONSENT_VERSION, perpsRegionAttested: true };
}

/**
 * Withdrawing: the switch alone. The route clears the whole record for it and
 * writes it even when something else in the same save is refused (its
 * `offs`), so off is one click and always lands.
 */
export function perpsLiveOffBody(): { perpsLiveEnabled: false } {
  return { perpsLiveEnabled: false };
}

/**
 * FOR THE WALLET THESE VALUES WERE READ FOR (SettingsView.owner), as the
 * page's own save sends it: another tab can sign a different wallet in unseen,
 * and the route refuses a body naming someone other than the session rather
 * than writing a consent to spend real money onto an agent nobody looked at.
 */
export function withOwner<T extends Record<string, unknown>>(body: T, owner: string | null): T | (T & { owner: string }) {
  return owner !== null ? { ...body, owner } : body;
}

// ── what the agent and its grant say ────────────────────────────────────

/**
 * GET /api/grants, as this section reads it. Every field says "not said"
 * separately from "no": a read that failed is `unread`, and inside a read the
 * report, the operator's offer and the signed cap are each null when absent.
 */
export type PerpsGrantRead =
  | { state: "loading" }
  | { state: "unread" }
  | {
      state: "read";
      /** Is there a signed permission at all? */
      exists: boolean;
      /** `agents.perps`, parsed by core's whitelist. null = the agent has not said. */
      report: PerpsReport | null;
      /**
       * The account's own book (AgentStatus `mode`: "paper" | "live" | "idle"),
       * null when not said. The report's `mode` is the perps rail, which reads
       * "off" while a practice position is still held (perpsBookOf).
       */
      accountMode: string | null;
      /** The operator's offer of a new live opt-in for this account; null = not said. */
      optIn: boolean | null;
      /** Does the signed permission carry the perps route? null when there is no permission. */
      granted: boolean | null;
      /** The signed per-trade cap, USDG; null when absent or unreadable. */
      signedPerTradeUsdg: number | null;
    };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * `perps` is read off the answer even before AgentStatus names it (the desk
 * adds it), and parsed again here by core's whitelist: a server older or newer
 * than this build, or a value of the wrong shape, reads as "not said" — never
 * as a book with nothing in it.
 */
export function readPerpsGrant(json: unknown): PerpsGrantRead {
  if (!isRecord(json) || typeof json.exists !== "boolean") return { state: "unread" };
  const report = parsePerpsReport(json.perps);
  const optIn = typeof json.perpsOptIn === "boolean" ? json.perpsOptIn : null;
  const accountMode = typeof json.mode === "string" ? json.mode : null;
  if (!json.exists) return { state: "read", exists: false, report, accountMode, optIn, granted: null, signedPerTradeUsdg: null };
  const grant = isRecord(json.grant) ? json.grant : {};
  const features = Array.isArray(grant.grantFeatures) ? grant.grantFeatures.filter((f): f is string => typeof f === "string") : [];
  const granted =
    grantPerp({ grantFeatures: features, chainId: typeof grant.chainId === "number" ? grant.chainId : NaN, perp: grant.perp }) !== null;
  const caps = isRecord(grant.caps) ? grant.caps : {};
  const perTrade = caps.perTradeUsdg;
  const signedPerTradeUsdg = typeof perTrade === "number" && Number.isFinite(perTrade) && perTrade > 0 ? perTrade : null;
  return { state: "read", exists: true, report, accountMode, optIn, granted, signedPerTradeUsdg };
}

/**
 * The status line, from `agents.perps`. Four answers, and none of them is
 * "nothing there" unless the report says so: a failed read is `unread`, a
 * missing or malformed report is `not-reported`, and a report whose venue
 * figures are null carries `lighterUnread` — the worker's own marker for "the
 * account could not be read" (perps/view.ts buildPerpsReport).
 */
export type PerpsStatusView =
  | { kind: "loading" }
  | { kind: "unread" }
  | { kind: "not-reported" }
  | {
      kind: "report";
      mode: PerpsReport["mode"];
      /** Why perps are not trading, in the owner's words (core perpsBlockerText). Never repeats "off" beside the off line. */
      blocker: { what: string; remedy: string | null } | null;
      /**
       * Which money the positions are (perpsBookOf): the count says "paper
       * positions" for practice, and never calls an unplaced book real.
       */
      book: PerpsBook | null;
      /**
       * The positions as counted: listed when the venue was read; when it was
       * NOT, the worker's last-held count — max(listed, stopsMissing), since an
       * unread read counts every held position as without a seen stop. Never
       * "0" over an unread venue that held something.
       */
      positions: number;
      lighterUnread: boolean;
      stopsMissing: number;
      /** Unknown activity the blocker line does not already say. */
      incident: boolean;
    };

export function perpsStatusView(read: PerpsGrantRead): PerpsStatusView {
  if (read.state === "loading") return { kind: "loading" };
  if (read.state === "unread") return { kind: "unread" };
  const r = read.report;
  if (r === null) return { kind: "not-reported" };
  const lighterUnread = r.collateralMicro === null;
  return {
    kind: "report",
    mode: r.mode,
    blocker: r.blocker !== null && r.blocker !== "perps-off" ? perpsBlockerText(r.blocker) : null,
    book: perpsBookOf(r, read.accountMode),
    positions: lighterUnread ? Math.max(r.positions.length, r.stopsMissing) : r.positions.length,
    lighterUnread,
    stopsMissing: r.stopsMissing,
    incident: r.incident && r.blocker !== "perps-unknown-activity",
  };
}

/**
 * The largest open the agent may make: min(signed per-trade, the setting) —
 * docs/perps.md rule 6's "effective" cap. null when the signed half is not
 * known, because half a minimum is not a minimum.
 */
export function perpsEffectiveCap(signedPerTradeUsdg: number | null, perpsPerTradeUsdg: number): number | null {
  return signedPerTradeUsdg === null ? null : Math.min(signedPerTradeUsdg, perpsPerTradeUsdg);
}

// ── the stop at the chosen leverage ─────────────────────────────────────

/**
 * The stop, said as what it costs. `perpsStopLossPct` is a PRICE move; at
 * leverage L the same move is L times that share of the margin posted. The
 * rest is arithmetic the owner could do and should not have to:
 *
 *   worstMarginPct  the stop's fill at the edge of its slippage allowance,
 *                   on the worse side (a short's: trigger × (1 + slip) from
 *                   entry × (1 + stop)), times L. A jump past the stop can
 *                   still be worse, and the sentence says so.
 *   liqBoundPct     100 / L. Isolated liquidation comes BEFORE the whole
 *                   margin is gone (the venue's maintenance fraction is
 *                   positive), so this is a bound, never an estimate of it —
 *                   the margin fractions are read live and are not here.
 *   everyOpenRefused  rule 7 refuses an open unless the stop's worst price
 *                   beats liquidation by perpsLiqBufferPct of entry. The long
 *                   side's worst stop sits (stop + slip − stop × slip) from
 *                   entry, and liquidation sits nearer than 1/L, so when that
 *                   plus the buffer reaches 1/L no market can pass. Below it,
 *                   whether one passes depends on the market and is the
 *                   worker's call, not this screen's.
 */
export function stopAtLeverage(a: { stopPct: number; slipBps: number; leverage: number; liqBufferPct: number }): {
  marginPct: number;
  worstMarginPct: number;
  liqBoundPct: number;
  everyOpenRefused: boolean;
} {
  const s = a.stopPct / 100;
  const p = a.slipBps / 10_000;
  const b = a.liqBufferPct / 100;
  const L = a.leverage;
  const worstLong = s + p - s * p;
  const worstShort = s + p + s * p;
  return {
    marginPct: round1(a.stopPct * L),
    worstMarginPct: round1(worstShort * L * 100),
    liqBoundPct: round1(100 / L),
    everyOpenRefused: worstLong + b >= 1 / L - 1e-12,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
