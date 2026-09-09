import { loadTokenQuotes, applyTokenQuotes } from "./quotes";
import { STOCK_TOKENS } from "@merrymen/core";
import { parseStrategy, strategyLabel, type StrategyGlance } from "./strategy";
import { whyLine } from "./why";

/**
 * THE FIVE THINGS THE BAR CAN BE ON.
 *
 * IDs, not labels. `board` left and `alpha` arrived, and the other three kept
 * their ids on purpose even though their labels changed: these strings are
 * wired into TabIcon's exhaustive switch, pathForScreen's record, the
 * `data-screen` attribute CSS selects on, and FirstVisit. Renaming `agent` to
 * `chat` or `you` to `profile` would be churn across five files for nothing a
 * reader of the screen can see.
 *
 * The leaderboard is not gone — it moved onto HOME, where a balance and a
 * ranking answer the same question ("how am I doing") and used to be two taps
 * apart.
 */
export type Tab = "home" | "feed" | "agent" | "alpha" | "you";
export type TokenTab = "held" | "buys";
export type Screen =
  | { kind: "tab"; tab: Tab }
  | { kind: "token"; id: string }
  | { kind: "profile"; slug: string }
  | { kind: "deposit" }
  | { kind: "withdraw" }
  | { kind: "search" }
  | { kind: "create" }
  | { kind: "settings" }
  | { kind: "grant" }
  | { kind: "limits" };

export interface AgentRef {
  slug: string;
  name: string;
  handle: string | null;
}

export interface LiveToken {
  id: string;
  symbol: string;
  name: string;
  logo: string;
  priceUsd: number | null;
  priceUpdatedAt?: number;
  priceSource?: string;
  uiMultiplier?: number;
  change24hPct: number | null;
  fdvUsd: number | null;
  holders: number | null;
  /**
   * How many agents hold it, and how many bought it in the window.
   *
   * NULL UNTIL THE LEDGER ANSWERS. These shipped as a literal `0` on the seeded
   * row while `holders` beside them was correctly null, so an unloaded market
   * table stated "0 agents hold this" about twenty-five real listed instruments
   * — and then stated exactly the same thing once the ledger came back and the
   * answer really was zero. Two different facts, one rendering.
   */
  agents: number | null;
  buys: number | null;
  kind: "stock" | "etf" | "memecoin";
  marks: number[];
  cast: AgentRef[];
}

export interface LiveAgent {
  unrankedWhy?: import("@/lib/rank-pnl").UnrankedWhy | null;
  gas?: {usdg:number;unpricedTrades:number};
  holdingsRead?: boolean;
  slug: string;
  name: string;
  handle: string | null;
  owner: string | null;
  pnlBps: number | null;
  /**
   * The series a chart may draw — AND WHICH QUANTITY IT IS.
   *
   * Two different numbers shared this field. The public profile fills it from
   * `AgentProfile.growth`, the growth index with deposits divided out; the
   * leaderboard fills it from `LeaderRow.curve`, which is raw `equity_usdg`.
   * `read-agent.ts` deletes the raw field on purpose and says why: equity steps
   * up the moment the owner funds the account, and a new epoch's whole opening
   * balance is written as one inbound flow — so drawn raw it shows a book
   * springing into existence at full value.
   *
   * A failed profile fetch fell back to the leaderboard row, and the chart drew
   * exactly that under the label "Performance history". So the kind now travels
   * with the numbers, and the chart draws nothing else.
   */
  curve: number[];
  curveKind?: "growth" | "equity";
  /**
   * Whether the flows divided out of that index were read from the chain.
   *
   * `EquityLine.tsx` refuses to draw without this and explains at length. The
   * terminal profile dropped the field, so the gate was unreachable on the only
   * surface that still draws the curve.
   */
  contributionsEvidenced?: boolean;
  publicBook?: boolean;
  holdingsUsd?: number | null;
  landed: number;
  /**
   * Trades that filled ON PAPER, kept apart from `landed` on purpose.
   *
   * read-agent.ts refuses to fold them together and records why: the page once
   * read "filled 0" beside ten posts saying "filled on paper", and widening
   * `landed` would re-arm the +2643.3% incident. So both travel, and the
   * profile shows both — it was showing only the first, so an agent with ten
   * simulated fills published "0 Completed trades".
   */
  filledPaper?: number;
  last: Thesis | null;
  glance: StrategyGlance;
  thesis: string;
}

export interface Thesis {
  name: string;
  slug: string | null;
  handle: string | null;
  action: "buy" | "sell" | "hold" | null;
  symbol: string | null;
  sizeUsdg: number | null;
  reason: string | null;
  paper: boolean;
  head: string;
  when?: string;
  /**
   * WHAT HAPPENED TO THE DECISION — the whole union, not the convenient half.
   *
   * `"dropped"`, `"view"` and `"shadow"` were missing, so every surface that
   * switched on this field fell through to its past-tense default and reported
   * a decision nothing came of as a completed trade. See `shadow` below.
   */
  outcome?: "landed" | "refused" | "reverted" | "dropped" | "pending" | "view" | "shadow" | null;
  outcomeText?: string | null;
  /**
   * THE AGENT SAID THIS; NOTHING COULD HAVE COME OF IT.
   *
   * A shadow row is a real row with a real action, a real symbol and a real
   * size — `worker/src/thesis-policy.ts` says it is "indistinguishable, to
   * every gate below, from a real buy" — and that is exactly why the publisher
   * bakes the conditional into `head` ("would buy TSLA 5.00 USDG") and sets
   * this flag beside it.
   *
   * The terminal declared neither, so `verbOf` in beat.ts printed
   * "@robin bought TSLA" for a decision that never reached an executor, on the
   * public feed. Kept as its own boolean rather than `outcome === "shadow"`
   * because a renderer that has not learned the new outcome arm still has to
   * answer this question — and because they are different facts: `outcome` is
   * what happened to the decision, `shadow` is whether anything was connected
   * that could have made something happen.
   */
  shadow?: boolean;
  said?: number;
  at?: number;
  /**
   * A STABLE NAME FOR THIS POST, so a like can be cast against it.
   *
   * Optional because a post from an agent with no public slug does not get one
   * and is not likeable, and because a response from before the field existed
   * has none. Derived server-side in `lib/post-id.ts` from things already
   * rendered on the card, so it discloses nothing new.
   *
   * NOTE WHAT IS NOT HERE: a like COUNT. Counts arrive separately, keyed by
   * this id, and are merged in the browser — see `/api/like-counts`. The shape
   * is the fence: an object that reaches a prompt cannot carry a number a
   * wallet-minter can inflate.
   */
  postId?: string | null;
}

export interface ChainHolder {
  addr: string;
  value: string;
}

export interface LiveMine {
  statusLabel?: string;
  /**
   * The newest thing the worker warned about, or null.
   *
   * ONE, NOT FORTY. These repeat: the worker latches the ones that matter to
   * once-per-change, but a list on the agent screen would still become a log,
   * and a log is where a sentence goes to be ignored. The newest warning is the
   * one that describes now.
   */
  notice?: { level: string; message: string; at: string } | null;
  history?: number[];
  positions?: {symbol:string;valueUsd:number;stale:boolean;costUsd:number|null;pnlPct:number|null;floorBps:number|null;floorWhy:string|null}[];
  name: string;
  slug: string | null;
  handle: string | null;
  owner: string | null;
  equity: number | null;
  chg24: number | null;
  mode: string | null;
  thesis: string | null;
  moves: Thesis[];
  glance: StrategyGlance;
}

export interface LiveState {
  tokens: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  /**
   * WHETHER EACH READ ACTUALLY HAPPENED — carried beside the data, not instead
   * of it.
   *
   * Every empty array above has two possible meanings and the screens have to
   * be able to tell them apart before they say a word about the world. "Quiet."
   * is a claim; "we could not read the ledger" is a confession, and rendering
   * the first when the second is true is the incident `prerender.test.ts`
   * exists to remember.
   */
  reads: {
    market: ReadState;
    /**
     * The launchpad sweep, which is where every memecoin on the list comes
     * from — and whose failure was swallowed into an empty array.
     *
     * A refused discoveries read therefore dropped every coin from the market
     * list, and the token screen then announced "The market list came back
     * without this token. Check the address" about a coin the chain has: our
     * outage published as a fact about the instrument, which is precisely what
     * the unread-before-absent ordering exists to prevent.
     */
    discoveries: ReadState;
    board: ReadState;
    theses: ReadState;
    mine: ReadState;
  };
}

const LOGO = (addr: string) =>
  `https://cdn.robinhood.com/ncw_assets/logos/${addr.toLowerCase()}.png`;

/** Company mark. The NCW CDN is the same Robinhood feather for every listed token. */
const COMPANY = (symbol: string) =>
  `https://financialmodelingprep.com/image-stock/${symbol}.png`;

export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

export function coinPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(3)}`;
  if (n >= 100)
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

export function quoteTitle(token: LiveToken): string | undefined {
  if (token.priceSource !== "robinhood" || !token.priceUpdatedAt)
    return undefined;
  return `Robinhood bid/ask midpoint · ${new Date(token.priceUpdatedAt * 1000).toLocaleString()}`;
}

export function pctPts(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(n >= 100 || n <= -100 ? 0 : 2)}%`;
}

/**
 * WHICH COLOUR A CHANGE GETS — and the one that says "we do not know".
 *
 * Every call site used to be written `(n ?? 0) < 0 ? "down" : "up"`, which
 * coalesces an UNKNOWN change to zero and then paints it green. The text beside
 * it correctly rendered "—", so the screen said "we don't know" in words and
 * "it went up" in colour, and colour is what a reader takes in first on a table
 * of twenty-five tokens. Green is a claim.
 *
 * `flat` is the third answer and the palette already had it (`.delta.flat`);
 * it just was not reachable from anything but the delta chip.
 */
export function deltaClass(n: number | null | undefined): "up" | "down" | "flat" {
  if (n === null || n === undefined || !Number.isFinite(n)) return "flat";
  return n < 0 ? "down" : "up";
}

export function pctBps(bps: number | null): string {
  if (bps === null) return "—";
  const pct = bps / 100;
  if (Math.abs(pct) < 0.05) return "0.0%";
  return `${pct > 0 ? "+" : "\u2212"}${Math.abs(pct).toFixed(1)}%`;
}

export function money(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How long ago this printed. Snapshot `said` is seconds-ago, not a unix time. */
export function ageOf(t: Thesis, now = Date.now()): string {
  if (t.when) return t.when;

  const raw = t.at ?? t.said;
  if (raw == null) return "";
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return relSec((now - ms) / 1000);
}

function relSec(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function sizeOf(t: Thesis): number | null {
  if (t.sizeUsdg != null && t.sizeUsdg > 0) return t.sizeUsdg;
  const m = t.head?.match(/(\d+(?:\.\d+)?)\s*USDG/i);
  return m ? Number(m[1]) : null;
}

/**
 * A ledger timestamp, in seconds, read as the UTC it actually is.
 *
 * `fmtEpoch` in lib/ledger.ts writes `new Date(sec*1000).toISOString().slice(0,19).replace("T"," ")`
 * — so "2026-09-05 12:34:56", a UTC instant with the marker filed off.
 * `Date.parse` of a space-separated string with no zone is LOCAL time in every
 * engine, so every age on the feed and the whole daily-spend gauge were wrong
 * by the viewer's offset: an hour out in London, five in New York, and enough
 * to move a trade across midnight and out of "today".
 */
export function ledgerSeconds(raw: string): number {
  const t = Date.parse(/\dZ?$/.test(raw) && raw.includes(" ") ? `${raw.replace(" ", "T")}Z` : raw);
  return Number.isFinite(t) ? t / 1000 : 0;
}

/**
 * What happened to a trade — an ALLOW-LIST, because the ledger has more states
 * than this screen knows about.
 *
 * It was written as a negation: anything not 'rejected' and not 'reverted' was
 * published as "landed". `trades.status` is genuinely written 'submitted' while
 * an operation is in flight — ledger-mirror.ts keys its resolution on
 * `AND status = 'submitted'` — and `/api/feed` selects the column with no WHERE
 * clause, so unresolved rows reach the browser and were reported as filled.
 * A trade the chain has not confirmed is `pending`, and so is any status added
 * after this line was written.
 */
export function tradeOutcome(status: string): NonNullable<Thesis["outcome"]> {
  if (status === "landed" || status === "paper") return "landed";
  if (status === "rejected") return "refused";
  if (status === "reverted") return "reverted";
  return "pending";
}

export function seedLive(): LiveState {
  return ({
    tokens: robinhoodFallback(),
    agents: [],
    theses: [],
    mine: null,
    // NOBODY HAS ASKED YET. The seed exists so the shell has a market list to
    // draw before the first fetch returns; every empty array beside it is an
    // absence of a request, and a screen that reads them as an absence of
    // activity is asserting something nobody has checked.
    reads: { market: "unread", discoveries: "unread", board: "unread", theses: "unread", mine: "unread" },
  });
}

function robinhoodFallback(): LiveToken[] {
  return STOCK_TOKENS.map((t) => ({
    id: t.address.toLowerCase(),
    symbol: t.symbol,
    name: t.name,
    logo: COMPANY(t.symbol),
    priceUsd: null,
    change24hPct: null,
    fdvUsd: null,
    holders: null,
    agents: null,
    buys: null,
    kind: t.kind,
    marks: [],
    cast: [],
  }));
}

/**
 * DID WE GET AN ANSWER, AND WAS THE ANSWER READABLE?
 *
 * Three states, not two, and the third is the one this product is built on.
 *
 *   unread      nobody has asked yet — the seed
 *   unreadable  we asked and could not be told: the request failed, or it
 *               succeeded carrying `source: "none"`, which every reader in
 *               web/src/lib publishes to mean "the ledger could not be read"
 *   ok          we asked and were told, and the answer may legitimately be
 *               nothing at all
 *
 * `getJson` used to swallow all of that into `null`, and every consumer wrote
 * `?? []` after it — so a database outage arrived at the screens as an empty
 * array and rendered as "Quiet." and "Nobody has traded yet.". The old Feed
 * component's header names this exact incident: "an empty ledger and an
 * UNREADABLE one look identical to a reader unless the page says which it is",
 * and prerender.test.ts memorialises the deploy where it shipped.
 */
export type ReadState = "unread" | "unreadable" | "ok";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * What a read amounted to. A body carrying `source: "none"` is UNREADABLE even
 * though the request returned 200 — that shape is the reader's way of saying it
 * could not open the ledger, and treating it as data is the whole bug.
 */
export function readStateOf(body: { source?: string } | null | undefined): ReadState {
  if (body == null) return "unreadable";
  return body.source === "none" ? "unreadable" : "ok";
}

export async function loadLive(onMine?: (mine: LiveMine | null) => void): Promise<LiveState> {
  const [market, board, thesesRes, feed, quotes, disc] = await Promise.all([
    getJson<{ tokens: MarketTok[]; source?: string }>("/api/market"),
    getJson<{ agents: BoardRow[]; source?: string }>("/api/leaderboard"),
    getJson<{ theses: Thesis[]; source?: string }>("/api/theses"),
    getJson<Feed>("/api/feed").then(feed=>{onMine?.(mineOf(feed,[]));return feed;}),
    loadTokenQuotes(),
    getJson<Disc>("/api/discoveries"),
  ]);


  if(!market && !board && !thesesRes) throw new Error("Market and agent data could not be loaded.");
  const theses = (thesesRes?.theses ?? []).filter((t) => t.slug || t.name);
  const bySymbol = new Map<string, Thesis[]>();
  for (const t of theses) {
    if (!t.symbol) continue;
    const k = t.symbol.toUpperCase();
    const list = bySymbol.get(k) ?? [];
    list.push(t);
    bySymbol.set(k, list);
  }

  const tokens = new Map<string, LiveToken>();
  for (const t of robinhoodFallback()) tokens.set(t.id, t);

  for (const t of market?.tokens ?? []) {
    const id = t.address.toLowerCase();
    const posts = bySymbol.get(t.symbol.toUpperCase()) ?? [];
    tokens.set(id, {
      id,
      symbol: t.symbol,
      name: t.name,
      logo:
        t.kind === "memecoin" ? t.logo || LOGO(t.address) : COMPANY(t.symbol),
      priceUsd: t.priceUsd,
      change24hPct: null,
      fdvUsd: null,
      holders: t.holders,
      agents: uniqueAgents(posts),
      buys: posts.filter((p) => p.action === "buy").length,
      kind: t.kind,
      marks: [],
      cast: castOf(posts),
    });
  }

  for (const r of disc?.rows ?? []) {
    const id = r.token.toLowerCase();
    // Pool discovery must not turn a registered stock into a memecoin.
    if(tokens.has(id) && tokens.get(id)!.kind !== "memecoin") continue;
    const symbol = (r.name.split(/[\s/]/)[0] ?? r.name).toUpperCase();
    const posts = bySymbol.get(symbol) ?? [];
    const marks = marksOf(r);
    tokens.set(id, {
      id,
      symbol,
      name: r.name,
      logo: r.verdict ? "" : "",
      priceUsd: r.priceUsd,
      change24hPct: r.change24hPct,
      fdvUsd: r.fdvUsd,
      holders: null,
      agents: uniqueAgents(posts),
      buys: r.buyers24h ?? posts.filter((p) => p.action === "buy").length,
      kind: "memecoin",
      marks,
      cast: castOf(posts),
    });
  }

  for (const f of disc?.fresh ?? []) {
    if (!f.token) continue;
    const id = f.token.toLowerCase();
    if (tokens.has(id) && tokens.get(id)!.logo) continue;
    const symbol = (f.symbol || f.name || "TOKEN").toUpperCase();
    const posts = bySymbol.get(symbol) ?? [];
    const prev = tokens.get(id);
    tokens.set(id, {
      id,
      symbol,
      name: f.name || symbol,
      logo: f.logo
        ? `/api/coin-image?uri=${encodeURIComponent(f.logo)}`
        : (prev?.logo ?? ""),
      priceUsd: prev?.priceUsd ?? null,
      change24hPct: prev?.change24hPct ?? null,
      fdvUsd: prev?.fdvUsd ?? null,
      holders: prev?.holders ?? null,
      agents: uniqueAgents(posts),
      buys: f.trades ?? 0,
      kind: "memecoin",
      marks: prev?.marks ?? [],
      cast: prev?.cast ?? castOf(posts),
    });
  }

  const latestBySlug = new Map<string, Thesis>();
  for (const t of theses) {
    const key = t.slug ?? t.name;
    if (!latestBySlug.has(key)) latestBySlug.set(key, t);
  }

  const agents: LiveAgent[] = (board?.agents ?? [])
    .filter((a) => a.slug)
    .map((a) => ({
      slug: a.slug!,
      name: a.name,
      handle: a.handle,
      pnlBps: a.pnlBps,
      unrankedWhy: a.unrankedWhy,
      curve: a.curve ?? [],
      // RAW EQUITY from the leaderboard read — never a growth index, and the
      // profile chart refuses to draw it.
      curveKind: "equity" as const,
      landed: a.landed,
      last: latestBySlug.get(a.slug!) ?? latestBySlug.get(a.name) ?? null,
      owner: a.handle,
      glance: publicGlance(),
      thesis:
        (latestBySlug.get(a.slug!) ?? latestBySlug.get(a.name))?.reason ?? "",
    }));

  if (agents.length === 0) {
    for (const t of latestBySlug.values()) {
      if (!t.slug) continue;
      agents.push({
        slug: t.slug,
        name: t.name,
        handle: t.handle,
        pnlBps: null,
        curve: [],
        landed: 0,
        last: t,
        owner: t.handle,
        glance: publicGlance(),
        thesis: t.reason ?? "",
      });
      if (agents.length >= 12) break;
    }
  }

  const mine = mineOf(feed, theses);

  return ({
    tokens: applyTokenQuotes([...tokens.values()], quotes),
    agents,
    theses,
    mine,
    // WHETHER EACH READ HAPPENED, carried alongside what it returned. A body
    // that arrived with `source: "none"` counts as unreadable even though the
    // request succeeded: that shape IS the reader telling us it could not open
    // the ledger. See `readStateOf`.
    reads: {
      market: readStateOf(market),
      discoveries: readStateOf(disc),
      board: readStateOf(board),
      theses: readStateOf(thesesRes),
      mine: readStateOf(feed),
    },
  });
}

function agentsFromTheses(theses: Thesis[]): LiveAgent[] {
  const by = new Map<string, LiveAgent>();
  for (const t of theses) {
    if (!t.slug) continue;
    const prev = by.get(t.slug);
    if (!prev) {
      by.set(t.slug, {
        slug: t.slug,
        name: t.name,
        handle: t.handle,
        owner: null,
        pnlBps: null,
        curve: [],
        landed: t.outcome === "landed" ? (t.said ?? 1) : 0,
        last: t.action === "buy" ? t : null,
        glance: publicGlance(),
        thesis: whyLine(t),
      });
    } else {
      if (!prev.last && t.action === "buy") prev.last = t;
      if (t.outcome === "landed") prev.landed += t.said ?? 1;
    }
  }
  return [...by.values()];
}

function uniqueAgents(posts: Thesis[]): number {
  return new Set(posts.map((p) => p.slug ?? p.name)).size;
}

function castOf(posts: Thesis[]): AgentRef[] {
  const seen = new Set<string>();
  const out: AgentRef[] = [];
  const ordered = [...posts].sort((a, b) => {
    if (a.action === "buy" && b.action !== "buy") return -1;
    if (b.action === "buy" && a.action !== "buy") return 1;
    return 0;
  });
  for (const p of ordered) {
    const id = p.slug ?? p.name;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ slug: p.slug ?? id, name: p.name, handle: p.handle });
  }
  return out;
}

/**
 * THE PUBLIC WIRE CARRIES NO STRATEGY, and this is where that is admitted.
 *
 * /api/leaderboard and /api/theses publish what an agent SAID, not how it is
 * configured — an owner’s strategy is settings, and settings are not public.
 * This function used to take a thesis, the whole thesis list and a slug, ignore
 * all three, and return `{id:"custom"}`, which renders as "Its own rules": a
 * statement about an agent that may well be running steady-basket.
 *
 * `known:false` is the honest version, and the screens render it as unpublished
 * rather than as a rulebook.
 */
function publicGlance(): StrategyGlance {
  return { id: "custom", label: "Strategy", known: false };
}

function marksOf(r: DiscRow): number[] {
  return typeof r.priceUsd === "number" && Number.isFinite(r.priceUsd)
    ? [r.priceUsd]
    : [];
}

/** A day in seconds. The window "today's change" actually means. */
const DAY_SEC = 86_400;

/**
 * The book's value twenty-four hours before `nowSec`, or null.
 *
 * Null is the answer whenever the series does not reach back a full day — a
 * change measured over six hours is not a smaller version of a daily one, it is
 * a different number with a day's name on it. Exported for the test.
 */
export function equityDayAgo(
  points: readonly { equity_usdg: number; at?: string }[],
  nowSec: number,
): number | null {
  const stamped = points
    .map((p) => ({ at: p.at ? ledgerSeconds(p.at) : 0, v: p.equity_usdg }))
    .filter((p) => p.at > 0 && Number.isFinite(p.v))
    .sort((a, b) => a.at - b.at);
  if (stamped.length < 2) return null;
  const cutoff = nowSec - DAY_SEC;
  // The series has to START at or before the cutoff, or it does not cover a day.
  if (stamped[0]!.at > cutoff) return null;
  let best: number | null = null;
  for (const p of stamped) {
    if (p.at <= cutoff) best = p.v;
    else break;
  }
  return best;
}

function mineOf(feed: Feed | null, theses: Thesis[]): LiveMine | null {
  if (!feed?.agent?.name && !feed?.equity?.length) return null;
  const name = feed.agent?.name ?? "Your agent";
  const mineTheses = feed.agent?.slug ? theses.filter((t) => t.slug === feed.agent?.slug) : [];
  const curve = (feed.equity ?? [])
    .map((e) => e.equity_usdg)
    .filter(Number.isFinite);
  /**
   * NULL, NOT ZERO. `curve.at(-1) ?? 0` turned "this book has no equity
   * history" into "this book holds nothing" — and `money()` renders that as a
   * definite $0.00, which is a statement about an account nobody has read.
   */
  const latest = curve.at(-1) ?? null;
  /**
   * WHAT THE BOOK WAS WORTH A DAY AGO — or null, because a shorter history has
   * no daily change in it.
   *
   * This was `const dayAgo = null`, hard-coded, so `chg24` was permanently null
   * and every "today" figure on the product was dead code. The prototype filled
   * it from `curve[0]` — the OLDEST point — which is the change since the series
   * began wearing the name of a daily one; on a week-old book those differ by an
   * order of magnitude.
   *
   * So: the last point at or before twenty-four hours ago, and nothing when the
   * series does not reach back that far. The same rule research/technical.ts
   * applies to a return window, for the same reason.
   */
  const dayAgo = equityDayAgo(feed.equity ?? [], Date.now() / 1000);
  const mode = feed.agent?.strategy ?? null;
  const slug = feed.agent?.slug ?? null;
  /**
   * THE NEWEST THING WORTH SAYING, if the worker said one.
   *
   * WARN AND ERR ONLY. The "ok" level is the running commentary — a floor
   * stamped, a stale feed noticed — and putting that on the agent screen would
   * bury the one message that matters under the ones that do not.
   */
  const notice = (feed.events ?? []).find(
    (e) => (e.level === "warn" || e.level === "err" || e.level === "error") && !!e.message,
  );
  return {
    name,
    slug,
    handle: mineTheses[0]?.handle ?? null,
    owner: "you",
    equity: latest,
    history: curve,
    notice: notice ? { level: String(notice.level), message: String(notice.message), at: String(notice.created_at ?? "") } : null,
    // `costUsd` is NULL when the ledger has no basis, never 0 — the difference
    // between "I do not know what this cost" and "it was free", which is the
    // whole of whether the agent can answer a question about taking a profit.
    positions: (feed.positions ?? []).map(p=>{
      // Already whole USDG: /api/feed converts the ledger's micro-USDG column at
      // the boundary (see basisUsdg), so nothing here has to know that the one
      // money field on this row is kept in a different unit from the rest.
      const c = p.cost_usdg === null || p.cost_usdg === undefined ? null : Number(p.cost_usdg);
      const costUsd = c === null || !Number.isFinite(c) || c <= 0 ? null : c;
      return {
        symbol:p.symbol,
        valueUsd:p.value_usdg,
        stale:!!p.price_stale,
        costUsd,
        pnlPct: costUsd === null ? null : ((p.value_usdg - costUsd) / costUsd) * 100,
        // THIS position's own floor, when it carries one. Null means the
        // owner's single setting applies — what the whole book did before a
        // floor could be graded per entry.
        floorBps: typeof p.stop_floor_bps === "number" && p.stop_floor_bps > 0 ? p.stop_floor_bps : null,
        floorWhy: typeof p.stop_floor_why === "string" && p.stop_floor_why ? p.stop_floor_why : null,
      };
    }),
    chg24: latest !== null && dayAgo !== null ? latest - dayAgo : null,
    mode,
    thesis: mineTheses[0]?.reason ?? null,
    moves: (feed.trades ?? []).map(t=>{
      const buy=STOCK_TOKENS.find(s=>s.address.toLowerCase()===t.buy_token?.toLowerCase());
      const sell=STOCK_TOKENS.find(s=>s.address.toLowerCase()===t.sell_token?.toLowerCase());
      return {
        slug,name,handle:null,
        action:buy ? "buy" as const : sell ? "sell" as const : null,
        symbol:buy?.symbol ?? sell?.symbol ?? null,
        sizeUsdg:t.amount_usdg,
        reason:null,
        paper:t.status==="paper",
        head:t.kind,
        at:ledgerSeconds(t.created_at),
        outcome:tradeOutcome(t.status),
        // THE RULE THAT STOPPED IT, which was on the wire and dropped on the
        // floor. `/api/feed` selects `reject_rule` deliberately; without it
        // every refused trade of the owner's own rendered "No explanation
        // available", which is a statement about us and not about the wall.
        outcomeText:t.reject_rule ?? null,
      };
    }),
    glance: {
      id: parseStrategy(mode), label: strategyLabel(parseStrategy(mode)),
      // NULL WHEN THE ROW DID NOT CARRY IT. `?? 0` published "you have no
      // uncommitted cash" for a snapshot that simply did not include the
      // column, and the header prints it in dollars beside an Add-funds button.
      cashUsd: feed.equity?.at(-1)?.cash_usdg ?? undefined,
      vaultUsd: feed.equity?.at(-1)?.vault_usdg ?? undefined,
      legs: (feed.positions ?? []).filter(p => p.value_usdg > 0).map(p => ({symbol:p.symbol, weight:latest && latest > 0 ? Math.round(p.value_usdg / latest * 100) : 0})),
    },
  };
}

/**
 * A token by address or by symbol, CASE-INSENSITIVELY ON BOTH.
 *
 * The lowercase on the address is the whole bug fix. `t.id` is
 * `address.toLowerCase()` by construction, but the id this is called with comes
 * out of the URL — and every link anybody actually shares carries the EIP-55
 * checksummed form, because that is what a wallet, a block explorer and this
 * app's own `STOCK_TOKENS` table all write. `t.id === id` therefore never
 * matched a pasted link, the symbol fallback could not match an address either,
 * and the shell rendered "Token unavailable" for TSLA while the sidebar beside
 * it showed TSLA at $355.48.
 *
 * It survived review because the market list passes `t.id`, already lowercased,
 * so every click worked and only shared links were broken — which is the half of
 * the surface a local review never exercises.
 */
export function tokenById(
  tokens: LiveToken[],
  id: string,
): LiveToken | undefined {
  const want = id.trim().toLowerCase();
  return tokens.find(
    (t) => t.id.toLowerCase() === want || t.symbol.toLowerCase() === want,
  );
}

export function agentBySlug(
  agents: LiveAgent[],
  slug: string,
): LiveAgent | undefined {
  return agents.find((a) => a.slug === slug);
}

export function thesesForSymbol(theses: Thesis[], symbol: string): Thesis[] {
  const k = symbol.toUpperCase();
  const seen = new Set<string>();
  const out: Thesis[] = [];
  for (const t of theses) {
    if ((t.symbol ?? "").toUpperCase() !== k) continue;
    const id = t.slug ?? t.name;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(t);
  }
  return out;
}

export function thesesForAgent(
  theses: Thesis[],
  slug: string,
  name: string,
): Thesis[] {
  return theses.filter((t) => t.slug === slug || t.name === name).slice(0, 12);
}

export async function chainHolders(addr: string): Promise<ChainHolder[]> {
  const d = await getJson<{
    items?: { address?: { hash?: string }; value?: string }[];
  }>(`/api/venue?desk=holders&token=${encodeURIComponent(addr)}`);
  const rows = (d?.items ?? []).slice(0, 8).map((h) => {
    const hash = h.address?.hash ?? "";
    return {
      addr: hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "—",
      value: h.value ?? "—",
    };
  });
  return rows;
}

export function faceSrc(slug: string | null): string | null {
  if (!slug) return null;
  const seed = slug;
  return `https://robohash.org/${encodeURIComponent(seed)}.png?set=set1&size=160x160`;
}

export function lede(text: string | null | undefined): string {
  if (!text) return "";
  const line = text
    .split("\n")
    .find((l) => l.trim() && !l.trim().startsWith("-"));
  return (line ?? text).trim();
}

/**
 * The one-line summary of an agent's most recent decision.
 *
 * PREFERS `head`, WHICH IS THE PUBLISHER'S OWN SENTENCE. `publishableThesis`
 * builds it precisely so surfaces that are not React components do not have to
 * reassemble one — and it is where the shadow conditional lives, as
 * "would buy TSLA 5.00 USDG". Rebuilding the line from `action` threw that away
 * and printed "Bought TSLA" for a decision nothing came of; the same mistake
 * `peer-view.ts` made once and is now pinned against in
 * worker/src/brain-disconnected.test.ts.
 *
 * The reconstruction survives only as the fallback for a row with no head at
 * all, and it carries the conditional too.
 */
export function lastLine(t: Thesis | null): string {
  if (!t) return "";
  if (t.head) return t.head;
  if (t.action && t.symbol) {
    const shadow = t.shadow === true || t.outcome === "shadow";
    const verb =
      t.action === "buy"
        ? shadow ? "Would buy" : "Bought"
        : t.action === "sell"
          ? shadow ? "Would sell" : "Sold"
          : shadow ? "Would hold" : "Holding";
    return `${verb} ${t.symbol}`;
  }
  return t.reason || "";
}

interface MarketTok {
  symbol: string;
  name: string;
  kind: "stock" | "etf" | "memecoin";
  address: string;
  logo: string;
  priceUsd: number | null;
  holders: number | null;
}

interface BoardRow {
  unrankedWhy?: import("@/lib/rank-pnl").UnrankedWhy | null;
  slug: string | null;
  name: string;
  handle: string | null;
  pnlBps: number | null;
  curve?: number[];
  landed: number;
}

interface DiscRow {
  token: string;
  name: string;
  priceUsd: number | null;
  change24hPct: number | null;
  fdvUsd: number | null;
  buyers24h: number | null;
  verdict?: unknown;
}

interface Disc {
  /** "none" when the index could not be reached — see readStateOf. */
  source?: string;
  rows?: DiscRow[];
  fresh?: {
    token: string;
    symbol: string;
    name: string;
    logo: string;
    trades: number;
  }[];
}

interface Feed {
  /** "none" means the ledger could not be read — see readStateOf. */
  source?: string;
  /**
   * THE WARNINGS NOBODY HAD EVER SEEN — past tense now, and the tense is the
   * point.
   *
   * /api/feed had selected these for a long time and the terminal dropped them
   * on the floor: LiveMine had no field for them, so every gate that reports
   * itself with addEvent() and nothing else was invisible by construction.
   * That is what turned a blocked agent into a quiet one — the Circle-strategy
   * gate, the trencher rail and the discovery credential check all announce
   * themselves here and nowhere else.
   *
   * THEY REACH A SCREEN NOW: `notice` is built from this array at ~line 735
   * (newest warn/err/error with a message) and rendered on the agent desk at
   * screens/Agent.tsx, guarded so a resolved blocker outranks a log line.
   * circle-strategies.test.ts pins the filter and that JSX.
   *
   * This paragraph said the opposite in the present tense for a while after
   * that landed, and it cost a re-audit: the stale sentence is more convincing
   * than the code, because it is the thing a reader finds first. The other
   * renderer — railNotices, in app/(app)/you/YouClient.tsx — is still unmounted
   * and still tracked in mounted.test.ts KNOWN_DEBT; that half has not moved.
   */
  events?: { level?: string; message?: string; created_at?: string }[];
  agent?: { name?: string; strategy?: string; slug?: string | null } | null;
  trades?: {
    kind: string;
    buy_token: string | null;
    sell_token: string | null;
    amount_usdg: number;
    /**
     * The ledger's own word, NOT a narrowed union.
     *
     * `/api/feed` declares it as `"landed" | "reverted" | "rejected" | "paper"`
     * and selects the column with no WHERE clause — but the ledger genuinely
     * writes `'submitted'` for an operation still in flight. Typing it `string`
     * here is what forces `tradeOutcome` to be an allow-list instead of a
     * negation, which is how an unconfirmed trade stopped being published as
     * a fill.
     */
    status: string;
    /** The rule the wall refused it under. Selected by the route, was dropped here. */
    reject_rule?: string | null;
    created_at: string;
  }[];
  equity?: { equity_usdg: number; cash_usdg?: number; vault_usdg?: number; at?: string }[];
  positions?: {symbol:string; value_usdg:number; price_stale?:number; cost_usdg?:number|null; stop_floor_bps?:number|null; stop_floor_why?:string|null}[];
}
