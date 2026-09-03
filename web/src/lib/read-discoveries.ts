import { createPublicClient } from "viem";
import { rpcTransportFor, robinhoodChain } from "./rpc";
import {
  fetchGeckoPoolsResult,
  screenPools,
  type GeckoBucket,
  type GeckoPool,
  type GeckoWindow,
} from "../../../worker/src/venues/geckoterminal";
import { recentPonsLaunches } from "../../../worker/src/venues/pons";
import {
  readCurveActivity,
  isActive,
  MAX_ACTIVITY_BLOCKS,
} from "../../../worker/src/venues/pons-activity";
import { readTokenMeta } from "../../../worker/src/venues/pons-meta";
import {
  readCardFacts,
  readBlockClock,
  ageSecOf,
} from "../../../worker/src/venues/pons-card";
import { resolveConfig } from "../../../worker/src/settings";
import { resolveLlm } from "../../../worker/src/llm";
import { createMemecoinScout } from "../../../worker/src/strategist/memecoin-scout";
import { researchCoins, scoutFieldsFor } from "../../../worker/src/strategist/coin-research";

/**
 * What is trading on this chain.
 *
 * READS THE INDEX, NOT THE LEDGER, and that is the whole design decision.
 * Every other panel here goes through `withReadDb` against the worker's
 * database — which works self-hosted and renders EMPTY on the hosted deploy,
 * because the orchestrator strips DATABASE_URL from each worker child, so the
 * child writes sqlite in its own container while this service reads a Postgres
 * nothing ever created the schema in. A discoveries panel built the same way
 * would be blank on app.merrymen.dev for exactly that reason.
 *
 * Fetching server-side instead means the panel shows the same thing to
 * everyone, hosted or not, with no database and no tenant scoping —
 * `discovered_pools` has no tenant column anyway. It is the same shape
 * /api/market already uses.
 *
 * ONE READER, ONE MEMO, EVERY CALLER. This lived inside the route handler,
 * which meant the only way to reach it was an HTTP request — so a server
 * component wanting the same facts had to fetch its own process over the
 * network and miss the single-flight memo entirely. On a chain already
 * refusing this fleet at ~442 rate-limit hits in five minutes, a second
 * upstream read for facts we are holding in memory is the expensive mistake.
 * The route below is now a thin GET over this.
 *
 * WHAT THIS IS. A third party's claim about a market, used to decide what is
 * worth LOOKING at. It is not a recommendation, nothing here has been checked
 * against the chain, and the agent cannot act on any of it without the owner
 * adding the token in /settings and re-signing the grant.
 */

/** The same floor the worker's own screen uses, so the two agree on "worth showing". */
const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };

/** GeckoTerminal's venue slugs for the two halves of the Pons launchpad. */
const GRADUATED = "pons-v2-dex";
const ON_CURVE = "pons-v2";

export interface DiscoveryRow {
  token: string;
  name: string;
  venue: string;
  priceUsd: number | null;
  /**
   * Depth as the INDEX reports it.
   *
   * For a coin still on its bonding curve this is mostly the VIRTUAL SEED — a
   * fresh curve reports about $4,100 of "reserve" while holding none of it —
   * so the UI must never present it as money you could sell into. That is why
   * `onCurve` travels with it.
   */
  reserveUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  buyers24h: number | null;
  ageDays: number | null;
  /** Graduated off a Pons bonding curve into a real pool. */
  graduated: boolean;
  /** Still on its bonding curve — treat `reserveUsd` with suspicion. */
  onCurve: boolean;
  /**
   * The scout's own line on this coin, when it had one.
   *
   * Declared here because the builder has always ATTACHED it while the type
   * never admitted it — so every consumer had to re-declare this interface
   * locally, which is exactly how the console ended up with a private copy of
   * it. Null is a real answer: the scout looked and passed. `verdictsWhy` on
   * the payload says whether it could look at all.
   */
  verdict?: { conviction: number; reason: string } | null;
  /**
   * The index's tape across every window it published — 5m, 1h, 6h, 24h.
   *
   * Carried on every row rather than fetched per token on demand, because it
   * costs nothing: these numbers arrive in the same trending_pools response
   * that produced the row, and were being parsed and dropped. A page reading
   * this payload for one token therefore adds ZERO upstream requests to a
   * chain that is already refusing this fleet.
   *
   * A window the index omitted is null throughout, never zero — the difference
   * between "nobody traded it" and "the index did not say".
   */
  buckets: Record<GeckoWindow, GeckoBucket>;
  /**
   * The pool this row describes, as the index identifies it.
   *
   * TWO WIDTHS AND THE DIFFERENCE MATTERS: 20 bytes is a pool contract, 32 is
   * a v4/Pons poolId that cannot be called. Both are perfectly good keys for
   * the index's own OHLCV endpoint, which is the only thing this field is for
   * — it is never somewhere to send an eth_call.
   */
  poolId: string;
  /** Which venue these figures came from, so a page can say. */
  dex: string;
}

function toRow(p: GeckoPool, nowSec: number): DiscoveryRow {
  return {
    token: p.tokenAddress,
    // The index's own label, shown as a label and never used as identity: the
    // worker reads a symbol from the contract precisely because this string is
    // attacker-chosen and could impersonate a real ticker.
    name: p.name,
    venue: p.dex,
    priceUsd: p.priceUsd,
    reserveUsd: p.reserveUsd,
    fdvUsd: p.fdvUsd,
    volume24hUsd: p.volume24hUsd,
    change24hPct: p.change24hPct,
    buyers24h: p.buyers24h,
    ageDays: p.createdAt === null ? null : Math.max(0, (nowSec - p.createdAt) / 86_400),
    graduated: p.dex === GRADUATED,
    onCurve: p.dex === ON_CURVE,
    buckets: p.buckets,
    poolId: p.poolId,
    dex: p.dex,
  };
}

/** A launch from the last few minutes that people are actually trading. */
export interface FreshRow {
  token: string;
  curve: string;
  trades: number;
  /** Distinct trading ADDRESSES, from the trade event's own indexed field. */
  traders: number;
  /** The launcher's own words. Sanitised, and a claim rather than a fact. */
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  /** Published nothing at all — the shape an abandoned template has. */
  bare: boolean;
  /** The ERC-20's own ticker, from the chain. Empty when unreadable. */
  symbol: string;
  /** The ERC-20's own name, from the chain. Empty when unreadable. */
  name: string;
  /**
   * The launcher's logo URI, usually `ipfs://…`. Never given to a browser
   * directly — it goes through /api/coin-image, which is both what makes it
   * load at all (every gateway 403s a browser User-Agent) and what keeps an
   * attacker-chosen URL out of the reader's browser.
   */
  logo: string;
  /** Seconds since it launched, measured from a real block clock. Null when unknown. */
  ageSec: number | null;
  /** Basis points of its own graduation threshold, net of the virtual seed. */
  progressBps: number | null;
}

/**
 * The other end of the launchpad: what launched in the last quarter hour and
 * has a tape.
 *
 * Pons runs at roughly 940 launches an hour, so this is a FUNNEL rather than a
 * list. The gate is trading — 25 trades and 3 distinct addresses — which keeps
 * about an eighth of launches and holds 96% of the ones that go on to graduate.
 * A dev buy, having socials, and the creator's history were all measured and
 * are worth nothing as filters.
 *
 * Three RPC calls for the whole thing, whatever the launch rate: the launches,
 * one chain-wide sweep of every curve trade, and one Multicall3 batch for the
 * survivors' metadata.
 */
/**
 * Which of the three enrichment reads came back.
 *
 * These fail as a WAVE, not one coin at a time — the RPC refuses the burst and
 * all three return nothing together — so the answer belongs to the page, not to
 * a card. Observed in production on 2026-08-30: 28 rows with real trade counts
 * and every enriched field blank, served for about two and a half minutes.
 */
export interface ChainStatus {
  /**
   * The launch scan and the trade sweep — the reads that produce the ROWS.
   *
   * Separate from the three below because it fails differently and worse: when
   * this goes, there are no rows at all, and an empty list renders as "nothing
   * launched in the last few minutes has anyone trading it" — a confident claim
   * about a launchpad running at 940 launches an hour. Same mistake as `bare`,
   * one level up.
   */
  launchpad: boolean;
  /** The launcher's description, logo and socials (pons-meta). */
  meta: boolean;
  /** Symbol, name and curve progress (pons-card). */
  facts: boolean;
  /** The block clock that turns a block number into an age. */
  clock: boolean;
}

/** Space out a burst: the reads are cheap, the RPC's tolerance for concurrency is not. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rank the screened set with the same scout the worker uses.
 *
 * Optionally researches first, when a browser is configured on THIS service —
 * the signals then reach the model exactly as they do in the worker. Absent a
 * browser it ranks on numbers alone, which is the worker's behaviour too.
 *
 * Never throws: a page that cannot form an opinion still shows the market. And
 * with no model configured it returns no picks at all rather than a default
 * opinion — "nothing has been vetted" is the honest answer there, not
 * "everything looks fine".
 */
async function rankForDisplay(
  kept: readonly GeckoPool[],
  nowSec: number,
): Promise<{
  picks: { pool: GeckoPool; conviction: number; reason: string }[];
  /**
   * Why there are no verdicts, when there are none.
   *
   * "no-model", "model-failed" and "chose nothing" are three different facts and
   * only the last is an opinion. The scout fails CLOSED on a provider error —
   * correctly, since its whole job is to cut a list down — but that makes an
   * outage indistinguishable from a considered pass, and a page showing no
   * verdicts would read as "the agent looked and liked nothing" either way.
   * That is the same silent-failure shape as the coin cards and the market
   * index, so it gets the same treatment.
   */
  why?: "no-model" | "model-failed";
}> {
  if (!kept.length) return { picks: [] };
  let creds;
  let cfg;
  try {
    cfg = resolveConfig();
    creds = resolveLlm(cfg);
  } catch {
    return { picks: [], why: "no-model" };
  }
  if (!creds) return { picks: [], why: "no-model" };
  try {

    let research: ReadonlyMap<string, ReturnType<typeof scoutFieldsFor>> | undefined;
    if (cfg.browserUrl && cfg.browserToken) {
      // WAS A HARD-CODED LITERAL, which meant no configuration could move it —
      // not MERRYMEN_RPC_MAINNET, not a tenant's own endpoint, not a failover.
      // It also carried no `chain`, so viem had no default to fall back to and
      // the literal WAS the configuration.
      const client = createPublicClient({
        chain: robinhoodChain,
        transport: rpcTransportFor(robinhoodChain.id, "research"),
      });
      const found = await researchCoins(kept, {
        client: client as never,
        browser: { baseUrl: cfg.browserUrl, token: cfg.browserToken },
      });
      research = new Map([...found].map(([k, r]) => [k, scoutFieldsFor(r)]));
    }
    return await createMemecoinScout(creds).rank(kept, nowSec, research);
  } catch {
    return { picks: [] };
  }
}

async function readFresh(): Promise<{ rows: FreshRow[]; chain: ChainStatus }> {
  // `true` means "read it", so a total failure below reports three honest
  // falses rather than three optimistic trues.
  const chain: ChainStatus = { launchpad: false, meta: false, facts: false, clock: false };
  try {
    // The second hard-coded literal. Same reasoning as the one above.
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: rpcTransportFor(robinhoodChain.id, "chain-status"),
    });
    const W = MAX_ACTIVITY_BLOCKS;
    const [scan, activity] = await Promise.all([
      recentPonsLaunches(client as never, W),
      readCurveActivity(client as never, W),
    ]);
    // A null activity map means the node refused, which is a different fact
    // from a quiet launchpad — showing nothing is right, inventing an empty
    // tape for every launch is not.
    if (scan.failed || !activity) return { rows: [], chain };
    chain.launchpad = true;
    const live = scan.launches.filter((l) => isActive(activity.get(l.curve.toLowerCase())));

    // SEQUENTIAL, NOT Promise.all — and this is the one behavioural change here.
    // These three used to fire as a burst immediately after two heavy log
    // sweeps, and the whole burst is what the node refuses: all three come back
    // empty together while the sweeps that preceded them succeeded. They cost
    // ~700ms in total, so spacing them is nearly free, and the alternative
    // (more retries) multiplies the burst that draws the refusal.
    const meta = await readTokenMeta(client as never, live.map((l) => l.token));
    chain.meta = meta.size > 0 || live.length === 0;
    await sleep(120);
    const facts = await readCardFacts(client as never, live);
    chain.facts = facts.size > 0 || live.length === 0;
    await sleep(120);
    const clock = await readBlockClock(client as never);
    chain.clock = clock !== null;

    return {
      chain,
      rows: live
        .map((l) => {
          const a = activity.get(l.curve.toLowerCase())!;
          const m = meta.get(l.token.toLowerCase());
          const f = facts.get(l.token.toLowerCase());
          return {
            token: l.token,
            curve: l.curve,
            trades: a.buys + a.sells,
            traders: a.traders,
            description: m?.description ?? "",
            twitter: m?.twitter ?? "",
            telegram: m?.telegram ?? "",
            website: m?.website ?? "",
            // `bare` means "this launcher published NOTHING", which is a claim
            // about the coin — so it may only be made when the read succeeded.
            // It used to be `m ? m.bare : true`, which turned every unread coin
            // into an accusation: the card said "Published nothing about
            // itself" and "no socials" about coins that published plenty.
            // readTokenMeta returns a MAP precisely so a caller can tell "read
            // and empty" from "not read", and this threw that away.
            bare: m ? m.bare : false,
            symbol: f?.symbol ?? "",
            name: f?.name ?? "",
            logo: m?.logo ?? "",
            ageSec: ageSecOf(clock, l.blockNumber),
            progressBps: f?.progressBps ?? null,
          };
        })
        // By distinct addresses, not trade count: 291 trades from 25 addresses is
        // a different thing from 223 trades from 176, and only one of them looks
        // like people.
        .sort((x, y) => y.traders - x.traders),
    };
  } catch {
    return { rows: [], chain };
  }
}

export interface Payload {
  fetchedAt: number;
  scanned: number;
  indexUnreachable: boolean;
  rows: DiscoveryRow[];
  graduated: number;
  fresh: FreshRow[];
  chain: ChainStatus;
  /**
   * Why no coin carries a verdict, when none does.
   *
   * null is a real opinion — the scout looked and picked nothing, which the
   * prompt says is often the right answer. A value means it could not look, and
   * the page must not render that as a considered pass.
   */
  verdictsWhy: "no-model" | "model-failed" | null;
  degraded: boolean;
}

/**
 * One in-flight read at a time, and one result shared by every viewer.
 *
 * REPLACES `export const revalidate = 120`, which cached whatever it got —
 * including a degraded render, which it then served for minutes. This is the
 * same sharing with a say in what gets kept: a whole read is reused for two
 * minutes, a degraded one for ten seconds.
 *
 * The single-flight part is not optional once the route is dynamic. The console
 * polls this every 120s PER OPEN TAB; without it, every tab that misses fires
 * two heavy log sweeps plus three enrichment reads into a keyless RPC — which is
 * precisely the burst that makes the enrichment fail in the first place.
 *
 * A per-process memo is enough while `web` runs one replica (railway.json sets
 * no replica count). Scale it and each replica keeps its own — still correct,
 * just N times the upstream traffic.
 */
let inFlight: Promise<Shared> | null = null;
let last: { at: number; shared: Shared } | null = null;
const WHOLE_MS = 120_000;
const DEGRADED_MS = 10_000;

function sharedReadFull(): Promise<Shared> {
  const ttl = last?.shared.payload.degraded ? DEGRADED_MS : WHOLE_MS;
  if (last && Date.now() - last.at < ttl) return Promise.resolve(last.shared);
  if (inFlight) return inFlight;
  inFlight = build()
    .then((p) => {
      last = { at: Date.now(), shared: p };
      return p;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function sharedRead(): Promise<Payload> {
  return sharedReadFull().then((s) => s.payload);
}

/**
 * What the index said about ONE token, and whether it could be asked at all.
 *
 * Reads sharedPools, NOT the whole payload. A token page wanting four figures
 * was otherwise waiting on a launchpad sweep, three chain enrichment reads and
 * the scout's LLM pass — none of which say anything about the token in the URL.
 *
 * A null row means the index answered and this token was not among the pools
 * it returned. That is only an absence if it answered, which is what the
 * second half of the result is for.
 */
export async function readPoolFor(
  token: string,
): Promise<{ row: DiscoveryRow | null; indexUnreachable: boolean }> {
  const { byToken, asked, reached } = await sharedPools();
  return {
    row: byToken.get(token.toLowerCase()) ?? null,
    // False only when NOT ONE feed answered. A partial read is still a read.
    indexUnreachable: reached === 0 && asked > 0,
  };
}

/** A payload, and the wider set only a same-process caller can reach. */
interface Shared {
  payload: Payload;
  unscreened: Map<string, DiscoveryRow>;
}

/** What the index said about the market, before anything is built on top. */
interface Pools {
  /** Every pool it returned, keyed by token, screened by nothing. */
  byToken: Map<string, DiscoveryRow>;
  all: GeckoPool[];
  asked: number;
  reached: number;
  nowSec: number;
}

/**
 * THE FEEDS, AND ONLY THE FEEDS.
 *
 * Split out of build() because a page wanting four figures about ONE token was
 * waiting for the whole discovery panel: a launchpad sweep over chain logs,
 * three enrichment reads, and AN LLM CALL — the scout's verdict pass runs
 * inside build(), so a cold memo made a token page view block on a model.
 * None of that says anything about the token being looked at.
 *
 * Memoised in its own right, so the two paths still share the three fetches
 * rather than doubling them.
 */
let poolsInFlight: Promise<Pools> | null = null;
let poolsLast: { at: number; pools: Pools } | null = null;

export function sharedPools(): Promise<Pools> {
  // A refused sweep is worth retrying sooner than a whole one — the same split
  // the payload memo below makes, for the same reason.
  const ttl = poolsLast && poolsLast.pools.reached === 0 ? DEGRADED_MS : WHOLE_MS;
  if (poolsLast && Date.now() - poolsLast.at < ttl) return Promise.resolve(poolsLast.pools);
  if (poolsInFlight) return poolsInFlight;
  poolsInFlight = readPools()
    .then((p) => {
      poolsLast = { at: Date.now(), pools: p };
      return p;
    })
    .finally(() => {
      poolsInFlight = null;
    });
  return poolsInFlight;
}

async function readPools(): Promise<Pools> {
  const nowSec = Math.floor(Date.now() / 1000);
  const byPool = new Map<string, GeckoPool>();
  // Every feed refused is a different fact from every feed being empty, and
  // only one of them means the market is quiet. This API is keyless and
  // rate-limited, so the refusal is routine — and a page that renders it as
  // "nothing clearing the floor" states something false while looking normal.
  let asked = 0;
  let reached = 0;
  for (const feed of ["trending_pools", "new_pools", "pools"] as const) {
    const r = await fetchGeckoPoolsResult(feed);
    asked++;
    if (!r.failed) reached++;
    for (const p of r.pools) {
      // Deduped by TOKEN and kept at its BUSIEST venue — the same coin appears
      // in several feeds and often on several venues, and a reader cares about
      // the coin.
      //
      // Ranked on volume, with reserve only as a tiebreak. Deepest-reserve
      // picked the wrong pool to describe a token by: a live pool here carries
      // $27.0M of reserve against $4,506 of daily volume, so the row a reader
      // saw was the one nobody trades. The screened set is unaffected — it
      // already floors at $50k of volume.
      const prev = byPool.get(p.tokenAddress);
      const better =
        !prev ||
        (p.volume24hUsd ?? 0) > (prev.volume24hUsd ?? 0) ||
        ((p.volume24hUsd ?? 0) === (prev.volume24hUsd ?? 0) &&
          (p.reserveUsd ?? 0) > (prev.reserveUsd ?? 0));
      if (better) byPool.set(p.tokenAddress, p);
    }
  }

  const all = [...byPool.values()];
  const byToken = new Map<string, DiscoveryRow>();
  for (const p of all) {
    byToken.set(p.tokenAddress.toLowerCase(), { ...toRow(p, nowSec), verdict: null });
  }
  return { byToken, all, asked, reached, nowSec };
}

async function build(): Promise<Shared> {
  // The feeds, shared with every token page. The only await the two paths
  // still have in common.
  const { byToken, all, asked, reached, nowSec } = await sharedPools();
  const { rows: fresh, chain } = await readFresh();
  const { kept } = screenPools(all, LIMITS);

  // ── THE AGENT'S OWN VERDICT, FORMED HERE ────────────────────────────────
  //
  // Server-side for the same reason the screen above is: a worker child has no
  // DATABASE_URL (the orchestrator strips it), so it writes its ledger to sqlite
  // in its own container and NOTHING it decides can be read by this service.
  // A verdict panel fed from `decisions` would be permanently empty on
  // app.merrymen.dev — the exact failure this route's header was written about.
  //
  // So the same model that ranks candidates in the worker ranks them again
  // here, on the same screened set, and the answer travels with the row. It is
  // one LLM call per render, shared by every viewer through the memo above.
  //
  // This is a READING, not a permission. Nothing here can authorise a trade:
  // the wall only admits assets sealed into a signature, and the scout is
  // structurally incapable of naming a token it was not offered.
  const scoutRes = await rankForDisplay(kept, nowSec);
  const verdictsWhy = scoutRes.why ?? null;
  const verdictByToken = new Map<string, { conviction: number; reason: string }>();
  for (const pick of scoutRes.picks) {
    verdictByToken.set(pick.pool.tokenAddress.toLowerCase(), {
      conviction: pick.conviction,
      reason: pick.reason,
    });
  }

  // EVERY POOL THE INDEX RETURNED, screened or not, keyed by token.
  //
  // `rows` below is the SCREENED set — it exists to fill a discovery panel, so
  // it drops anything under the display floor. That makes it the wrong thing to
  // answer "does the index know this token" with: an agent's actual holdings
  // are mostly small coins, and every one of them is missing from `rows` for a
  // reason that has nothing to do with the index. Asked that question against
  // `rows`, a token page would report "no market data" for a coin the index had
  // just described in full.
  //
  // Kept in the memo rather than on the payload: it is several times the size
  // and no HTTP caller wants it.
  //
  // COPIED rather than mutated: sharedPools' map is handed to token pages as
  // well, and stamping this render's verdicts into it would leak one panel's
  // opinions onto every reader of a single token.
  const unscreened = new Map<string, DiscoveryRow>();
  for (const [key, row] of byToken) {
    unscreened.set(key, { ...row, verdict: verdictByToken.get(key) ?? null });
  }
  const rows = kept
    .map((p) => unscreened.get(p.tokenAddress.toLowerCase()))
    .filter((r): r is DiscoveryRow => r !== undefined);
  // Graduated first, then by 24h move: a coin that just made it off the
  // launchpad is the thing this page exists to surface.
  rows.sort((a, b) => Number(b.graduated) - Number(a.graduated) || (b.change24hPct ?? 0) - (a.change24hPct ?? 0));

  // A render worth keeping is one where every source answered. Anything less
  // gets a short life, so the next viewer re-asks instead of inheriting it.
  //
  // CACHING IS WHAT TURNED A BLINK INTO AN OUTAGE. The enrichment reads fail as
  // an occasional wave and recover in seconds, but a degraded render used to be
  // cached like any other: measured in production, one bad render was served
  // `x-nextjs-cache: HIT` for six consecutive polls — about two and a half
  // minutes of every card claiming its coin had published nothing. Only the
  // cache made it last that long. A render worth keeping is one where every
  // source answered; anything less gets a short life, so the next viewer
  // re-asks instead of inheriting it.
  const degraded =
    !chain.launchpad || !chain.meta || !chain.facts || !chain.clock || (reached === 0 && asked > 0);

  const payload: Payload = {
    fetchedAt: nowSec,
    scanned: all.length,
    // False only when NOT ONE feed answered. A partial read is still a read.
    indexUnreachable: reached === 0 && asked > 0,
    rows,
    graduated: rows.filter((r) => r.graduated).length,
    fresh,
    chain,
    // Null means the scout looked and picked nothing, which is a real and often
    // correct answer. A value means it could not look at all — and that must
    // not read on the page as a considered pass.
    verdictsWhy,
    degraded,
  };
  return { payload, unscreened };
}
