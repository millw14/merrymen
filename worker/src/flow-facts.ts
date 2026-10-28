/**
 * FLOW FACTS — what an on-chain indexer can honestly be quoted as saying about
 * the DEX trades in one coin over the last hour, and nothing more.
 *
 * Pure and vendor-neutral. The orchestrator's Bitquery lane
 * (venues/bitquery-lane.ts) produces these; children receive them over IPC
 * (flow-broker.ts); X answers and research Trencher reviews read them. None of those
 * consumers needs to know which indexer answered, so none of them is told: a
 * brand in a prompt is an invitation to recall whatever the model believes
 * about it, and a brand in a persisted decision is a migration waiting to
 * happen when the supplier changes (research-boundary.test.ts, the same rule).
 *
 * WHAT THESE ARE NOT. Not a price, not a forecast, not a signal, and never an
 * input to equity, P&L, sizing, a cap or a guard. A third party's count of
 * trades is a reason to look harder at a coin, the way a crowd outside a shop
 * is: it says nothing about whether the crowd is right, or whether it is one
 * person in many coats. Separate wallets are not proven separate people.
 *
 * UNKNOWN IS NEVER ZERO. Every number is `number | null`. A null is an
 * aggregate the indexer did not return; a 0 is the indexer saying "none". The
 * two have different remedies and must not be rendered alike.
 */

/** The trailing windows every flow reading covers, in minutes. Fixed: callers cannot widen them. */
export const FLOW_WINDOWS = [5, 15, 60] as const;
export type FlowWindowMin = (typeof FLOW_WINDOWS)[number];

/**
 * Why a reading is not here. The vocabulary the market feeds already use
 * (trencher-brain.ts, venues/fleet-feed-cache.ts), so one log grep covers them:
 *
 *   unavailable        the lane is off, unreachable, or this caller may not ask
 *   budget             our own knob refused it: daily points, rate or a busy lane
 *   provider-cooldown  the provider refused recently (429 and friends); waiting it out
 *   timeout            no answer in time; the call may still have been billed
 *   network            the request never got a response
 *   invalid-body       a response arrived but was not a usable answer
 *   invalid-shape      an answer arrived in a shape this code does not read
 *   invalid-request    the caller asked about something that is not a token
 *   http-NNN           the provider answered with that status
 */
export type FlowFailure =
  | "unavailable"
  | "budget"
  | "provider-cooldown"
  | "timeout"
  | "network"
  | "invalid-body"
  | "invalid-shape"
  | "invalid-request"
  | `http-${number}`;

const FAILURE_SHAPE = /^(?:unavailable|budget|provider-cooldown|timeout|network|invalid-body|invalid-shape|invalid-request|http-[1-5]\d\d)$/;

export function isFlowFailure(v: unknown): v is FlowFailure {
  return typeof v === "string" && FAILURE_SHAPE.test(v);
}

/** One trailing window of a coin's DEX tape. */
export interface FlowWindow {
  minutes: FlowWindowMin;
  buyUsd: number | null;
  sellUsd: number | null;
  buys: number | null;
  sells: number | null;
  /** Distinct addresses that bought. Harder to fake than a count, still not people. */
  buyers: number | null;
  sellers: number | null;
}

/** One venue's share of the last hour. `protocol` is the indexer's own slug, sanitised. */
export interface FlowVenue {
  protocol: string;
  family: string | null;
  buyUsd: number | null;
  sellUsd: number | null;
  buys: number | null;
  sells: number | null;
}

/** One of the largest single sells in the last hour. No wallet, no hash: a size and a time. */
export interface FlowSell {
  usd: number;
  /** Unix seconds. */
  at: number;
  protocol: string | null;
}

/**
 * Did the coin's launcher sell, as far as the indexer can tell? "Launcher"
 * means exactly one thing: the address the launchpad factory's own launch
 * event recorded for this coin — never an address the token reports about
 * itself, which any contract can forge.
 *
 *   not-derivable  no factory launch record for this coin (only Pons
 *                  launches have one, and only inside the lookback), so
 *                  nothing was asked. Not "the launcher did not sell".
 *   unavailable    a launcher is known but the read failed or ran out of time.
 *   read           the indexer answered for the window.
 *
 * The address is never part of a fact: it is resolved and used on the
 * orchestrator and goes no further. (The field keeps the name `creator` on
 * the wire; what it holds is the launch record's creator topic.)
 */
export type CreatorFlow =
  | { state: "not-derivable" }
  | { state: "unavailable"; failure: FlowFailure }
  | {
      state: "read";
      windowMin: number;
      /** DEX sells by the creator's own address. */
      sells: number | null;
      sellUsd: number | null;
      /** Token transfers OUT of the creator's address of any kind: a sell, a move to another wallet, a pool. */
      transfersOut: number | null;
      transferOutUsd: number | null;
    };

export interface FlowFacts {
  token: `0x${string}`;
  /** When the indexer was asked (ms). A cached answer keeps its original time. */
  observedAt: number;
  windows: FlowWindow[];
  venues: FlowVenue[];
  largestSells: FlowSell[];
  creator: CreatorFlow;
}

export type FlowResult = { ok: true; facts: FlowFacts } | { ok: false; failure: FlowFailure };

// ── bounds ──────────────────────────────────────────────────────────────────

export const FLOW_LIMITS = Object.freeze({
  venues: 8,
  largestSells: 10,
  protocolChars: 32,
  /** A USD figure past this is an indexer artefact, not a memecoin's hour. */
  maxUsd: 1e12,
  maxCount: 1e9,
});

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** A finite, non-negative number from a number or a numeric string, or null. Integers when `int`. */
export function flowNumber(v: unknown, int = false): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  if (int) return Number.isSafeInteger(n) && n <= FLOW_LIMITS.maxCount ? n : null;
  return n <= FLOW_LIMITS.maxUsd ? n : null;
}

/** An indexer slug made safe to show and to put in a prompt: a known alphabet, capped, or null. */
export function flowSlug(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, FLOW_LIMITS.protocolChars);
  return s.length > 0 ? s : null;
}

// ── validation (the child's side of the wire trusts nothing) ───────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * A wire number: null, or a JSON number in range. Stricter than flowNumber on
 * purpose — the lane already turned the provider's strings into numbers, so a
 * string here is not a format quirk, it is a reading nobody parsed.
 */
const nullable = (v: unknown, int: boolean): number | null | undefined =>
  v === null ? null : typeof v === "number" ? flowNumber(v, int) ?? undefined : undefined;

function windowOf(v: unknown): FlowWindow | null {
  if (!isRec(v) || !FLOW_WINDOWS.includes(v.minutes as FlowWindowMin)) return null;
  const out: Partial<FlowWindow> = { minutes: v.minutes as FlowWindowMin };
  for (const [k, int] of [["buyUsd", false], ["sellUsd", false], ["buys", true], ["sells", true], ["buyers", true], ["sellers", true]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out as FlowWindow;
}

function venueOf(v: unknown): FlowVenue | null {
  if (!isRec(v)) return null;
  const protocol = flowSlug(v.protocol);
  if (!protocol || protocol !== v.protocol) return null;
  const family = v.family === null ? null : flowSlug(v.family);
  if (family !== v.family) return null;
  const out: FlowVenue = { protocol, family, buyUsd: null, sellUsd: null, buys: null, sells: null };
  for (const [k, int] of [["buyUsd", false], ["sellUsd", false], ["buys", true], ["sells", true]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out;
}

/** A positive safe integer clock reading (seconds or ms), or null. Not a count, so not count-capped. */
const timeOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

function sellOf(v: unknown): FlowSell | null {
  if (!isRec(v)) return null;
  const usd = typeof v.usd === "number" ? flowNumber(v.usd) : null;
  const at = timeOf(v.at);
  const protocol = v.protocol === null ? null : flowSlug(v.protocol);
  if (usd === null || at === null || protocol !== v.protocol) return null;
  return { usd, at, protocol };
}

function creatorOf(v: unknown): CreatorFlow | null {
  if (!isRec(v)) return null;
  if (v.state === "not-derivable") return { state: "not-derivable" };
  if (v.state === "unavailable") return isFlowFailure(v.failure) ? { state: "unavailable", failure: v.failure } : null;
  if (v.state !== "read") return null;
  const windowMin = typeof v.windowMin === "number" ? flowNumber(v.windowMin, true) : null;
  if (windowMin === null || windowMin <= 0 || windowMin > 24 * 60) return null;
  const out = { state: "read" as const, windowMin, sells: null, sellUsd: null, transfersOut: null, transferOutUsd: null } as Extract<CreatorFlow, { state: "read" }>;
  for (const [k, int] of [["sells", true], ["sellUsd", false], ["transfersOut", true], ["transferOutUsd", false]] as const) {
    const n = nullable(v[k], int);
    if (n === undefined) return null;
    out[k] = n;
  }
  return out;
}

/**
 * A FlowFacts from untrusted JSON (the IPC wire), or null. Strict: a field in
 * the wrong shape rejects the whole reading rather than being defaulted,
 * because a defaulted count is a fabricated one.
 */
export function flowFactsOf(v: unknown): FlowFacts | null {
  if (!isRec(v) || typeof v.token !== "string" || !ADDRESS.test(v.token)) return null;
  const observedAt = timeOf(v.observedAt);
  if (observedAt === null) return null;
  if (!Array.isArray(v.windows) || v.windows.length !== FLOW_WINDOWS.length) return null;
  const windows = v.windows.map(windowOf);
  if (windows.some((w, i) => w === null || w.minutes !== FLOW_WINDOWS[i])) return null;
  if (!Array.isArray(v.venues) || v.venues.length > FLOW_LIMITS.venues) return null;
  const venues = v.venues.map(venueOf);
  if (venues.some((x) => x === null)) return null;
  if (!Array.isArray(v.largestSells) || v.largestSells.length > FLOW_LIMITS.largestSells) return null;
  const largestSells = v.largestSells.map(sellOf);
  if (largestSells.some((x) => x === null)) return null;
  const creator = creatorOf(v.creator);
  if (!creator) return null;
  return {
    token: v.token as `0x${string}`,
    observedAt,
    windows: windows as FlowWindow[],
    venues: venues as FlowVenue[],
    largestSells: largestSells as FlowSell[],
    creator,
  };
}

/** A FlowResult from untrusted JSON, or null. */
export function flowResultOf(v: unknown): FlowResult | null {
  if (!isRec(v)) return null;
  if (v.ok === false) return isFlowFailure(v.failure) ? { ok: false, failure: v.failure } : null;
  if (v.ok !== true) return null;
  const facts = flowFactsOf(v.facts);
  return facts ? { ok: true, facts } : null;
}

// ── rendering ───────────────────────────────────────────────────────────────

/** The Brain signals key this block is sent under (services/brain schemas.py LENS_KEYS; the manager reads it). */
export const ONCHAIN_FLOW_LENS = "onchain-flow";

/** Hard ceiling, matching brain-material.ts, coin-builder.ts and fomo/lens.ts. */
const LENS_MAX = 1200;

const ATTRIBUTION =
  "Source: an on-chain indexer's record of DEX trades in this coin, aggregated by Merrymen. Indexer data, not a forecast.";
const NOT_LINE =
  "WHAT THIS IS NOT: a price, a prediction or a reason to trade. Distinct addresses are not proven distinct people; a null is unknown, never zero.";

/** Nothing in a rendered block may look like an address or a hash. */
const ADDRESSY = /0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{32,}/;

/** True when the indexer reported no trades at all in the widest window. */
function silentHour(f: FlowFacts): boolean {
  const hour = f.windows.find((w) => w.minutes === 60);
  return !hour || ((hour.buys ?? 0) === 0 && (hour.sells ?? 0) === 0 && (hour.buyUsd ?? 0) === 0 && (hour.sellUsd ?? 0) === 0);
}

/** Whole dollars from $100 (either sign), cents below: precision a reader can use, not noise. */
const round = (n: number | null): number | null => (n === null ? null : Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

/**
 * Labelled by where the address came from, so a reader of the block never
 * takes it for "the creator's wallet" in any looser sense than that record.
 */
const LAUNCHER_BASIS = "launchpad factory's launch record";

function launcherJson(c: CreatorFlow): Record<string, unknown> {
  if (c.state === "read") {
    return { basis: LAUNCHER_BASIS, state: "read", windowMin: c.windowMin, dexSells: c.sells, dexSellUsd: round(c.sellUsd), transfersOut: c.transfersOut, transferOutUsd: round(c.transferOutUsd) };
  }
  return c.state === "unavailable" ? { state: "unknown" } : { state: "not-derivable" };
}

/**
 * The block the Brain is sent: attribution first, then one compact JSON
 * object, then what it is not. Null — never a sentence — when there is nothing
 * honest to say: a failed read, an hour with no indexed trades (absence is not
 * a verdict: it can be an indexer gap as easily as a dead coin), or anything
 * address-shaped in the output.
 *
 * SENT by research accounts' Trencher entry reviews (review-flow.ts), and
 * only to a Brain whose /health lists the key in `lens_keys`: an older build
 * would refuse the whole decision over it. Brain gives it to the manager, not
 * to an analyst (graph.py ONCHAIN_FLOW); see docs/bitquery-lane.md.
 */
export function renderFlowLens(r: FlowResult, now: number = Date.now()): string | null {
  if (!r.ok) return null;
  const f = r.facts;
  if (silentHour(f)) return null;
  const windows: Record<string, unknown> = {};
  for (const w of f.windows) {
    windows[`${w.minutes}m`] = {
      buyUsd: round(w.buyUsd),
      sellUsd: round(w.sellUsd),
      netUsd: w.buyUsd === null || w.sellUsd === null ? null : round(w.buyUsd - w.sellUsd),
      buys: w.buys,
      sells: w.sells,
      buyers: w.buyers,
      sellers: w.sellers,
    };
  }
  const body: Record<string, unknown> = {
    ageSec: Math.max(0, Math.round((now - f.observedAt) / 1000)),
    windows,
    venues60m: f.venues.slice(0, 4).map((v) => ({ venue: v.protocol, buyUsd: round(v.buyUsd), sellUsd: round(v.sellUsd), trades: v.buys === null || v.sells === null ? null : v.buys + v.sells })),
    largestSellsUsd60m: f.largestSells.slice(0, 3).map((s) => round(s.usd)),
    launcher: launcherJson(f.creator),
  };
  let json = JSON.stringify(body);
  const room = LENS_MAX - ATTRIBUTION.length - NOT_LINE.length - 2;
  if (json.length > room) {
    // Venues go first, then sells: the windows and the launcher are the reading.
    body.venues60m = [];
    json = JSON.stringify(body);
    if (json.length > room) {
      body.largestSellsUsd60m = [];
      json = JSON.stringify(body);
    }
  }
  const text = `${ATTRIBUTION}\n${json}\n${NOT_LINE}`;
  if (text.length > LENS_MAX || ADDRESSY.test(text)) return null;
  return text;
}

// ── X: bands, never figures ─────────────────────────────────────────────────

/**
 * WHAT AN X ANSWER MAY BE TOLD, IN BANDS — never a dollar figure or a count.
 *
 * docs/x-posting.md rule 2, as xpost/writer.ts and xpost/gate.ts enforce it:
 * the X model is never shown a number and a post never carries one. The
 * writer's clean() drops any fact with a digit, and the gate refuses a post
 * with a numeral or a quantity word. Numeric flow lines would therefore be
 * dropped silently — or invite someone to loosen clean() or the gate, which
 * would put dollar flow, counts and sell sizes about named coins on a
 * person's X account, one step from a trading signal.
 *
 * So X gets a CLOSED VOCABULARY, the way buy posts get BUY_GLOSS: each band
 * below has fixed glosses written here, with no digit, no quantity word and
 * none of the gate's refused vocabulary (no "sold", "selling", "wallet",
 * "dump"…). flow-facts.test.ts runs every gloss through the room's base gate
 * and the X vocabulary clauses. The writer and the gate are NOT to be
 * changed to admit flow facts; new wording goes here, through that test.
 *
 * WHAT IS NEVER SAID: that nothing happened. An hour with no indexed trades,
 * a launcher who did not sell, a failed read — each is no line at all,
 * because absence of evidence is exactly what a forger or an indexer gap
 * produces. Every gloss carries its attribution ("on-chain data").
 */
export type FlowXBand =
  | "buys-lead"
  | "buys-edge"
  | "even"
  | "sells-edge"
  | "sells-lead"
  | "light"
  | "pace-up"
  | "pace-down"
  | "buyers-narrow"
  | "buyers-broad"
  | "one-big-sell"
  | "launcher-sells"
  | "launcher-moved";

export const FLOW_X_GLOSS: ReadonlyMap<FlowXBand, readonly string[]> = new Map<FlowXBand, readonly string[]>([
  // the hour's balance, by quote-side dollars
  ["buys-lead", ["on-chain data shows buys clearly outweighing sells over the last hour", "per on-chain data, buys ran well ahead of sells over the last hour"]],
  ["buys-edge", ["on-chain data shows buys a little ahead of sells over the last hour", "per on-chain data, buys edged out sells over the last hour"]],
  ["even", ["on-chain data shows buys and sells roughly even over the last hour", "per on-chain data, buys and sells were about level over the last hour"]],
  ["sells-edge", ["on-chain data shows sells a little ahead of buys over the last hour", "per on-chain data, sells edged out buys over the last hour"]],
  ["sells-lead", ["on-chain data shows sells clearly outweighing buys over the last hour", "per on-chain data, sells ran well ahead of buys over the last hour"]],
  ["light", ["on-chain data shows only light trading in it over the last hour", "per on-chain data, it barely traded over the last hour"]],
  // where in the hour the trading fell
  ["pace-up", ["on-chain data shows most of the last hour's trading came in the last quarter hour", "per on-chain data, trading in it picked up in the last quarter hour"]],
  ["pace-down", ["on-chain data shows trading in it went quiet in the last quarter hour", "per on-chain data, trading in it slowed right down in the last quarter hour"]],
  // how many addresses bought — addresses, never claimed to be people
  ["buyers-narrow", ["on-chain data shows a small group of addresses doing the buying over the last hour", "per on-chain data, the buying over the last hour came from only a small group of addresses"]],
  ["buyers-broad", ["on-chain data shows the buying spread across lots of different addresses over the last hour", "per on-chain data, lots of different addresses were buying over the last hour"]],
  // one sell dwarfing the rest
  ["one-big-sell", ["on-chain data shows one sell made up most of the sells over the last hour", "per on-chain data, a single sell was most of the sells over the last hour"]],
  // the launch record's address (orchestrator-flow.ts), said as exactly that
  ["launcher-sells", ["on-chain data shows sells from the address the launchpad recorded as its launcher in the last hour", "per on-chain data, the address that launched it on the launchpad has made sells in the last hour"]],
  ["launcher-moved", ["on-chain data shows the address the launchpad recorded as its launcher moving tokens out in the last hour", "per on-chain data, the address that launched it on the launchpad moved tokens out in the last hour"]],
]);

/** Where the bands' edges sit. Internal: none of these numbers leaves this file. */
export const FLOW_X_EDGES = Object.freeze({
  /** Below this many quote-side dollars in the hour, the balance is noise: "light". */
  minHourUsd: 50,
  /** Buy share of the hour's dollars for "lead" and "edge" (and their mirror for sells). */
  leadShare: 0.65,
  edgeShare: 0.55,
  /** Share of the hour's dollars in the last quarter hour for "pace-up" / "pace-down". */
  paceUpShare: 0.6,
  paceDownShare: 0.05,
  /** Distinct buying addresses in the hour. */
  narrowBuyers: 3,
  broadBuyers: 25,
  /** One sell at least this share of the hour's sell dollars, among at least this many sells. */
  bigSellShare: 0.5,
  bigSellMinSells: 3,
});

/** The bands a reading supports, in a fixed order. Empty when there is nothing honest to say. */
export function flowXBands(r: FlowResult): FlowXBand[] {
  if (!r.ok) return [];
  const f = r.facts;
  if (silentHour(f)) return [];
  const E = FLOW_X_EDGES;
  const bands: FlowXBand[] = [];
  const hour = f.windows.find((w) => w.minutes === 60);
  const quarter = f.windows.find((w) => w.minutes === 15);
  const hourUsd = hour && hour.buyUsd !== null && hour.sellUsd !== null ? hour.buyUsd + hour.sellUsd : null;
  if (hour && hourUsd !== null) {
    if (hourUsd < E.minHourUsd) bands.push("light");
    else {
      const share = hour.buyUsd! / hourUsd;
      bands.push(share >= E.leadShare ? "buys-lead" : share >= E.edgeShare ? "buys-edge" : share > 1 - E.edgeShare ? "even" : share > 1 - E.leadShare ? "sells-edge" : "sells-lead");
      if (quarter && quarter.buyUsd !== null && quarter.sellUsd !== null) {
        const pace = (quarter.buyUsd + quarter.sellUsd) / hourUsd;
        if (pace >= E.paceUpShare) bands.push("pace-up");
        else if (pace <= E.paceDownShare) bands.push("pace-down");
      }
    }
  }
  if (hour && hour.buyers !== null && hour.buys !== null && hour.buys > 0) {
    if (hour.buyers <= E.narrowBuyers) bands.push("buyers-narrow");
    else if (hour.buyers >= E.broadBuyers) bands.push("buyers-broad");
  }
  const big = f.largestSells[0];
  if (big && hour && hour.sellUsd !== null && hour.sellUsd > 0 && hour.sells !== null && hour.sells >= E.bigSellMinSells && big.usd >= E.bigSellShare * hour.sellUsd) {
    bands.push("one-big-sell");
  }
  // Only what the launch record's address DID, and only over the hour the
  // glosses name. "It did not sell" is never said (see above).
  const c = f.creator;
  if (c.state === "read" && c.windowMin === 60) {
    if (c.sells !== null && c.sells > 0) bands.push("launcher-sells");
    else if (c.transfersOut !== null && c.transfersOut > 0) bands.push("launcher-moved");
  }
  return bands;
}

/** FNV-1a: which gloss of a band, stable per seed. Not security, just variety. */
function glossIndex(seed: string, band: string, n: number): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}|${band}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % n;
}

/**
 * The lines an X answer may paraphrase: one fixed gloss per band, chosen by
 * `seed` (the caller passes something like `${tenant}|${token}`, so two
 * accounts answering about one coin are not handed the same words — the
 * gate's fleet-echo clause would drop one of them). Digit-free by
 * construction, and checked again on the way out.
 */
export function flowXLines(r: FlowResult, seed = ""): string[] {
  return flowXBands(r)
    .map((band) => {
      const glosses = FLOW_X_GLOSS.get(band)!;
      return glosses[glossIndex(seed, band, glosses.length)]!;
    })
    .filter((l) => !/\p{N}/u.test(l) && !ADDRESSY.test(l));
}
