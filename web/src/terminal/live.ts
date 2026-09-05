import { loadTokenQuotes, applyTokenQuotes } from "./quotes";
import { STOCK_TOKENS } from "@merrymen/core";
import { parseStrategy, strategyLabel, type StrategyGlance } from "./strategy";
import { whyLine } from "./why";

export type Tab = "home" | "feed" | "agent" | "board" | "you";
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
  agents: number;
  buys: number;
  kind: "stock" | "etf" | "memecoin";
  marks: number[];
  cast: AgentRef[];
}

export interface LiveAgent {
  slug: string;
  name: string;
  handle: string | null;
  owner: string | null;
  pnlBps: number | null;
  curve: number[];
  publicBook?: boolean;
  holdingsUsd?: number | null;
  landed: number;
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
  outcome?: "landed" | "refused" | "reverted" | "pending" | null;
  outcomeText?: string | null;
  said?: number;
  at?: number;
}

export interface ChainHolder {
  addr: string;
  value: string;
}

export interface LiveMine {
  statusLabel?: string;
  history?: number[];
  positions?: {symbol:string;valueUsd:number;stale:boolean}[];
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

export function seedLive(): LiveState {
  return ({
    tokens: robinhoodFallback(),
    agents: [],
    theses: [],
    mine: null,
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
    agents: 0,
    buys: 0,
    kind: t.kind,
    marks: [],
    cast: [],
  }));
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function loadLive(onMine?: (mine: LiveMine | null) => void): Promise<LiveState> {
  const [market, board, thesesRes, feed, quotes, disc] = await Promise.all([
    getJson<{ tokens: MarketTok[] }>("/api/market"),
    getJson<{ agents: BoardRow[] }>("/api/leaderboard"),
    getJson<{ theses: Thesis[] }>("/api/theses"),
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
      curve: a.curve ?? [],
      landed: a.landed,
      last: latestBySlug.get(a.slug!) ?? latestBySlug.get(a.name) ?? null,
      owner: a.handle,
      glance: glanceFromPosts(
        latestBySlug.get(a.slug!) ?? latestBySlug.get(a.name) ?? null,
        theses,
        a.slug!,
      ),
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
        glance: glanceFromPosts(t, theses, t.slug),
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
        glance: glanceFromPosts(t, theses, t.slug),
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

function glanceFromPosts(
  last: Thesis | null,
  theses: Thesis[],
  slug: string,
): StrategyGlance {

  return { id: "custom", label: "Strategy" };
}

function marksOf(r: DiscRow): number[] {
  return typeof r.priceUsd === "number" && Number.isFinite(r.priceUsd)
    ? [r.priceUsd]
    : [];
}

function mineOf(feed: Feed | null, theses: Thesis[]): LiveMine | null {
  if (!feed?.agent?.name && !feed?.equity?.length) return null;
  const name = feed.agent?.name ?? "Your agent";
  const mineTheses = feed.agent?.slug ? theses.filter((t) => t.slug === feed.agent?.slug) : [];
  const curve = (feed.equity ?? [])
    .map((e) => e.equity_usdg)
    .filter(Number.isFinite);
  const latest = curve.at(-1) ?? 0;
  const dayAgo = null;
  const mode = feed.agent?.strategy ?? null;
  const slug = feed.agent?.slug ?? null;
  return {
    name,
    slug,
    handle: mineTheses[0]?.handle ?? null,
    owner: "you",
    equity: latest,
    history: curve,
    positions: (feed.positions ?? []).map(p=>({symbol:p.symbol,valueUsd:p.value_usdg,stale:!!p.price_stale})),
    chg24: latest !== null && dayAgo !== null ? latest - dayAgo : null,
    mode,
    thesis: mineTheses[0]?.reason ?? null,
    moves: (feed.trades ?? []).map(t=>{
      const buy=STOCK_TOKENS.find(s=>s.address.toLowerCase()===t.buy_token?.toLowerCase());
      const sell=STOCK_TOKENS.find(s=>s.address.toLowerCase()===t.sell_token?.toLowerCase());
      return {slug,name,handle:null,action:buy ? "buy" as const : sell ? "sell" as const : null,symbol:buy?.symbol ?? sell?.symbol ?? null,sizeUsdg:t.amount_usdg,reason:null,paper:t.status==="paper",head:t.kind,at:Date.parse(t.created_at)/1000,outcome:t.status==="rejected" ? "refused" as const : t.status==="reverted" ? "reverted" as const : "landed" as const};
    }),
    glance: {
      id: parseStrategy(mode), label: strategyLabel(parseStrategy(mode)),
      cashUsd: feed.equity?.at(-1)?.cash_usdg ?? 0,
      vaultUsd: feed.equity?.at(-1)?.vault_usdg ?? 0,
      legs: (feed.positions ?? []).filter(p => p.value_usdg > 0).map(p => ({symbol:p.symbol, weight:latest && latest > 0 ? Math.round(p.value_usdg / latest * 100) : 0})),
    },
  };
}

export function tokenById(
  tokens: LiveToken[],
  id: string,
): LiveToken | undefined {
  return tokens.find(
    (t) => t.id === id || t.symbol.toLowerCase() === id.toLowerCase(),
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
  }>(`/blockscout/tokens/${addr}/holders`);
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

export function lastLine(t: Thesis | null): string {
  if (!t) return "";
  if (t.action && t.symbol) {
    const verb =
      t.action === "buy" ? "Bought" : t.action === "sell" ? "Sold" : "Holding";
    return `${verb} ${t.symbol}`;
  }
  return t.head || t.reason || "";
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
  agent?: { name?: string; strategy?: string; slug?: string | null } | null;
  trades?: {kind:string;buy_token:string|null;sell_token:string|null;amount_usdg:number;status:string;created_at:string}[];
  equity?: { equity_usdg: number; cash_usdg?: number; vault_usdg?: number; at?: string }[];
  positions?: {symbol:string; value_usdg:number; price_stale?:number}[];
}
