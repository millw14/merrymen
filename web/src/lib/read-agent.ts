import { readPaperReturn } from "./paper-return";
/**
 * One agent, in public.
 *
 * Addressed by SLUG, never by smart account — the slug is stable across a
 * re-grant and the account is not, and the account is an address the
 * publication gate would refuse to print anyway.
 *
 * THE BOOK IS OPT-IN. Publishing per-agent position sizes on a public URL is
 * the same disclosure /api/scoreboard refuses when hosted, so an agent appears
 * here with its words always and its book only when its owner has said yes.
 *
 * EVERY READ SAYS WHETHER IT ANSWERED. Each query used to fall into a catch
 * that left a DEFAULT behind — an unreadable trades table rendered "filled 0 /
 * turned back 0", two confident figures about a named agent manufactured out of
 * an outage. The `*Read` flags are what let the page print a sentence instead.
 *
 * WHAT IS DELIBERATELY NOT HERE: the smart account, the signed caps, granted_at
 * and expires_at. read-leaderboard names all of them as things a public row must
 * not carry, and caps additionally tell an observer exactly what size clears the
 * wall.
 *
 * No session read. Same property as the other public readers, same reason.
 */
import { readProfileTrades, readRoundTrips, readTopTrades, type ProfileTrade, type TradeBook } from "./profile-trades";
import { readOperationCounts } from "./distinct-trades";
import { readEquityCloses } from "./equity-closes";
import { measuredMarks, netFlowsUpTo } from "./held-marks";
import { everyLandedOpSponsored } from "./gasless";
import { averageHoldSec } from "./hold-time";
import type { Db } from "../../../worker/src/db";
import { cache } from "react";
import { withReadDb } from "@/lib/ledger";
import { basisUsdg } from "@/lib/basis-usdg";
import { rankPnl, type UnrankedWhy } from "@/lib/rank-pnl";
import { growthIndex, drawdownBps } from "@/lib/growth-index";
import { PUBLISHABLE_STRATEGIES } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";
import { isEvidencedFlow } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";

export interface Holding {
  symbol: string;
  /** The token address, so the row can link to /t/<address>. */
  token: string | null;
  valueUsdg: number;
  /** What it cost. Null when there is no basis on record. */
  costUsdg: number | null;
  /** Unrealised, in bps. Null when the basis is unknown — never rendered as 0. */
  pnlBps: number | null;
  /** Share of the marked book, in bps. A percentage, never a second dollar figure. */
  shareBps: number | null;
  priceStale: boolean;
  /**
   * How this position was marked: 'chainlink' is a feed, anything else is a
   * pool or curve read. Only worth showing when it is NOT chainlink — that is
   * the schema default and a chip on every row is noise.
   */
  priceSource: string;
  /** A split or similar is pending, so on-chain balances are scaled. */
  acting: boolean;
  /** When the mark was last written. Null when unknown. */
  markedAt: number | null;
  /** When this agent first bought it, unix seconds. Null when unknown. */
  heldSince: number | null;
  /** How that first fill was evidenced. An estimate must not read as a measurement. */
  basisSource: "receipt" | "paper" | "quote" | null;
}

/** How this agent decides, when we may say. */
export type HowItTrades =
  | { kind: "strategy"; name: string }
  | { kind: "model"; provider: string | null; model: string | null };

export interface AgentProfile {
  slug: string;
  name: string;
  handle: string | null;
  /**
   * Was that handle PROVEN, or merely typed?
   *
   * The handle alone is unverified — the owner typed it and nothing checked
   * they own it — so it renders as plain text. Only this flag, set from a
   * stored xProof, lets a surface turn it into a link to x.com.
   */
  handleVerified: boolean;
  /** "live" | "paper" | "idle". The LAST HEARTBEAT's value, not a per-row fact. */
  mode: string;
  /** Unix seconds of the last heartbeat. Null when it has never beaten. */
  beatAt: number | null;
  /**
   * How it decides. Null when we may not say.
   *
   * Replaces a `strategy` field that never worked: it read `decisions.strategy`,
   * which the ordinary decision writer never populates — only the strategist
   * does, with one constant string — so a dip-hunter agent showed nothing and
   * every strategist agent showed the same words. The discriminator is
   * `decisions.source`, which is the key the publication policy already uses.
   */
  how: HowItTrades | null;
  /** The published return, or null. Exactly one of this and unrankedWhy is set. */
  pnlBps: number | null;
  paperPnlBps?: number | null;
  /** Why there is no return to show. The page says which, rather than assuming. */
  unrankedWhy: UnrankedWhy | null;
  /**
   * Peak-to-trough of the growth index. Null whenever the return is unranked.
   *
   * A FLOOR: measured over hourly closes (equity-closes.ts), so a trough that
   * opened and recovered inside one hour is not seen.
   */
  maxDdBps: number | null;
  /** Trades that filled for real. This is what reaches rankPnl. */
  landed: number;
  /**
   * Trades that filled on paper.
   *
   * A SEPARATE COUNTER, never folded into `landed`. The page read "filled 0"
   * beside "10 got through" beside ten posts saying "filled on paper", all on
   * one screen — but widening `landed` would re-arm the +2643.3% incident,
   * because an agent that ran live and flipped to paper inside one epoch would
   * then divide a pretend balance by a real deposit.
   */
  filledPaper: number;
  refused: number;
  /** Distinct tokens bought, in this agent's own evidence class only. */
  tokensTouched: number;
  /** Gas charged against the return, and how many fills we could not price. */
  gas: { usdg: number; unpricedTrades: number };
  /** Whether any deposit or withdrawal is on record at all. */
  funded: boolean;
  /**
   * Whether the flows behind that funding are EVIDENCE.
   *
   *  only says rows exist. The growth chart divides each period's flow
   * out of the equity line, so rows that were inferred from a balance change —
   * every phantom opening balance a redeploy wrote — distort the index and the
   * percentage printed beside it. The canary published -4.1% that way while the
   * same page correctly refused to publish a return.
   */
  contributionsEvidenced: boolean;
  /** How many flows carry a transaction, against how many there are. */
  flowsWithTx: number;
  flowsTotal: number;
  /**
   * Equity with the owner's deposits and withdrawals divided out — the series
   * that moves only when the book itself does. Starts at 1.
   *
   * THERE IS NO RAW `curve` FIELD, on purpose. equity_usdg steps up the moment
   * the owner funds the account, and a new epoch's entire opening balance is
   * written as one inbound flow — so drawn raw it shows a book springing into
   * existence at full value. Removing the field is what stops a future page
   * drawing it again.
   *
   * ONE POINT PER HOUR OVER THE WHOLE PERIOD, oldest first, every one of them —
   * the page slices 24H / 7D / 30D / ALL itself, so the default ALL covers the
   * span the headline does. See equity-closes.ts for why the old newest-500
   * read printed "0.00%" under "+21.5%".
   */
  growth: { at: number; g: number }[];
  /**
   * Whether `growth` reaches back to this period's first reading. False when the
   * read hit its cap and the oldest hours were not read — then there is no
   * "ALL" the page may offer, because the line would not be the whole period.
   */
  growthComplete: boolean;
  /** Empty when the owner has not opted in. `publicBook` says which it is. */
  holdings: Holding[];
  publicBook: boolean;
  /** Whether each read actually answered. A default is not an answer. */
  tradesRead: boolean;
  recentTrades: ProfileTrade[];
  activityRead: boolean;
  equityRead: boolean;
  flowsRead: boolean;
  holdingsRead: boolean;
  /**
   * TOP TRADES: this period's best evidenced sells by return, at most five, in
   * the agent's current book (profile-trades.ts readTopTrades). Dollars only
   * under the same opt-in as the rest of the book.
   */
  topTrades: ProfileTrade[];
  /** Whether that list was read. An empty list that was read is "No closed trades yet". */
  topTradesRead: boolean;
  /**
   * Distinct buys and sells this period in the agent's current book — one per
   * operation, so a redeploy's copies are not trades. Null when unread.
   */
  tradeCount: number | null;
  /** True when that count came from a capped read and is a floor ("5,000+"). */
  tradeCountFloor: boolean;
  /**
   * The mean hold of this period's FIFO-paired round trips, seconds (hold-time.ts).
   * Null when there is no round trip, or any fill it would pair was unread —
   * the stats line leaves the term out rather than print a stand-in.
   */
  avgHoldSec: number | null;
  /** When this agent's identity was minted, unix seconds. Null when unread. */
  joinedAt: number | null;
  /**
   * True only when EVERY landed operation this period was sponsored — measured,
   * never assumed (gasless.ts). False covers "some were not", "none landed" and
   * "could not read", and all three print no claim.
   */
  gasless: boolean;
}

/** The identity fields a profile reads. `createdAt` is checked, not trusted. */
export interface ProfileIdentity {
  slug: string;
  accounts: readonly string[];
  createdAt?: unknown;
}

/**
 * A join date, when the identity carries a believable one.
 *
 * Unix SECONDS, as both identity stores write it. A number past 1e11 is a
 * millisecond value (or garbage) and would print a date thousands of years
 * out, so it is unread rather than reinterpreted — a guessed unit is a guess.
 */
function joinedAtOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n < 1e11 ? Math.floor(n) : null;
}

/**
 * A provider or model name, which is TENANT FREE TEXT.
 *
 * Bounded by the hosted settings route but only string-checked worker-side, and
 * the charset it admits includes things that look like addresses — which the
 * thesis gate would drop a whole post for containing. Shape-check before
 * publishing, and publish nothing rather than something unexpected.
 */
const NAME_SHAPE = /^[A-Za-z0-9._/:-]{2,96}$/;
const safeName = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return NAME_SHAPE.test(s) ? s : null;
};

/**
 * Memoised per request: the page reads this twice, once for its metadata and
 * once for its body, and each call is eight round trips.
 */
export const readAgent = cache(async function readAgent(
  slug: string,
): Promise<AgentProfile | null> {
  let identity;
  try {
    identity = await getIdentityStore().bySlug(slug);
  } catch {
    return null;
  }
  if (!identity) return null;

  // The book is the OWNER's call, and the setting is per tenant.
  let publicBook = false;
  try {
    const s = (await getSettingsStore().get(identity.tenant)) as { publicBook?: boolean } | null;
    publicBook = s?.publicBook === true;
  } catch {
    /* fail closed: no setting readable means no book published */
  }

  const found = identity;
  return withReadDb(async (db): Promise<AgentProfile | null> => (db ? profileOf(db, found, publicBook) : null));
});

type AgentRow = {
  smart_account: string;
  name: string;
  x_handle: string | null;
  x_verified: number | null;
  mode: string;
  epoch: number;
  beat_at: number | null;
};

/**
 * The agent's newest account and its current run, or null when none of the
 * identity's accounts is on this ledger (or the ledger could not be read).
 *
 * Every account this tenant has held: a re-grant must not split an agent's
 * history into two strangers.
 */
async function agentRowOf(db: Db, identity: ProfileIdentity): Promise<AgentRow | null> {
  const accounts = identity.accounts.map((a) => a.toLowerCase());
  if (accounts.length === 0) return null;
  const inList = accounts.map(() => "?").join(", ");
  try {
    const row = (await db
      .prepare(
        `SELECT smart_account, name, x_handle, COALESCE(x_verified, 0) AS x_verified,
                COALESCE(mode, 'idle') AS mode,
                COALESCE(epoch, 1) AS epoch, beat_at
           FROM agents WHERE LOWER(smart_account) IN (${inList})
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(...accounts)) as AgentRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * THE OWNER'S OWN TRADES, WITH THEIR SIZES AND DOLLARS.
 *
 * The spec's rule for a profile's money is "the book is public OR it is the
 * owner's own view", and the public read below takes no session — so on a
 * private book it withheld the owner's own sizes from the owner too. This is
 * the owner's view: the same lists the profile shows, read with the money in.
 *
 * NEVER REACHABLE WITHOUT THE OWNER'S SESSION. Its only caller is readOwnBook,
 * which the session-checked /api/agents/[slug]/own serves; the public route and
 * the public page never call it. Holdings are not here: the profile draws them
 * only for a published book, and the owner's desk already shows its positions.
 */
export interface OwnBook {
  recentTrades: ProfileTrade[];
  activityRead: boolean;
  topTrades: ProfileTrade[];
  topTradesRead: boolean;
}

export async function ownBookOf(db: Db, identity: ProfileIdentity): Promise<OwnBook | null> {
  const row = await agentRowOf(db, identity);
  if (!row) return null;
  const epoch = Number(row.epoch ?? 1);
  const book: TradeBook = row.mode === "paper" ? "paper" : "landed";
  // `true` is the money switch these reads take — here because the viewer is
  // the owner, not because the book was published.
  const activity = await readProfileTrades(db, row.smart_account, epoch, true);
  const top = await readTopTrades(db, row.smart_account, epoch, true, book);
  return { recentTrades: activity.trades, activityRead: activity.read, topTrades: top.trades, topTradesRead: top.read };
}

/**
 * What anyone but the owner is told: the same as for an agent that does not
 * exist. The owner's view is not confirmed to be here for anyone else.
 */
export const NOT_OWN_BOOK = { status: 404, error: "Agent not found" } as const;

/**
 * The owner's view of `slug`, for the session's `tenant` — or why not.
 *
 * THE TENANT IS THE SESSION'S, and ownership is the identity store's record
 * that this slug belongs to it. Nothing in the request can name an owner, and
 * a slug that is somebody else's answers exactly as one that is nobody's.
 */
export async function readOwnBook(
  slug: string,
  tenant: string,
): Promise<{ status: 200; book: OwnBook } | { status: 404 | 503; error: string }> {
  let identity;
  try {
    identity = await getIdentityStore().bySlug(slug);
  } catch {
    return { status: 503, error: "This agent could not be looked up right now." };
  }
  if (!identity || identity.tenant.toLowerCase() !== tenant.toLowerCase()) return NOT_OWN_BOOK;
  const found = identity;
  const book = await withReadDb(async (db) => (db ? ownBookOf(db, found) : null));
  return book ? { status: 200, book } : { status: 404, error: "No trades on record for this agent." };
}

/**
 * The page itself, from one ledger. Out of `readAgent` so a test can drive it
 * against the worker's own schema: the identity and the book setting come from
 * stores a test would otherwise have to stand up, and neither is where the
 * arithmetic this page publishes lives.
 */
export async function profileOf(
  db: Db,
  identity: ProfileIdentity,
  publicBook: boolean,
): Promise<AgentProfile | null> {
  const row = await agentRowOf(db, identity);
  if (!row) return null;

  const account = row.smart_account;
  const epoch = Number(row.epoch ?? 1);
  const paper = row.mode === "paper";

  // ── flows, row by row and not just summed ────────────────────────────────
  // The total is what the return divides by; the individual timestamps are
  // what make a drawdown mean anything, because without them money the owner
  // took out is indistinguishable from money the agent lost.
  let flows: { at: number; signed: number }[] = [];
  /** Every flow on record this run: whether the book was ever funded. */
  let onRecord: number | null = null;
  let flowsWithTx = 0;
  let flowsTotal = 0;
  let flowsRead = false;
  try {
    const rows = (await db
      .prepare(
        `SELECT direction, amount_usdg, at, source FROM flows
           WHERE agent_id = ? AND epoch = ? ORDER BY at ASC`,
      )
      .all(account, epoch)) as {
      direction: string;
      amount_usdg: number;
      at: number;
      source: string | null;
    }[];
    flowsRead = true;
    flows = rows.map((r) => ({
      at: Number(r.at),
      signed: (r.direction === "in" ? 1 : -1) * Number(r.amount_usdg),
    }));
    onRecord = rows.length === 0 ? null : flows.reduce((n, x) => n + x.signed, 0);
    flowsTotal = rows.length;
    // WHAT COUNTS AS EVIDENCE IS ONE RULE, AND IT LIVES IN THE WORKER.
    //
    // This counted ('chain-log','transfer-intent'), which disagreed with the
    // worker's ('chain-log','epoch-carry') in BOTH directions — and the comment
    // that used to sit here said a new epoch's opening balance is written
    // 'inferred', which stopped being true when `openNextEpoch` got its own
    // source. So an agent that had crossed a boundary was publicly told its
    // bridged capital was guesswork while the anchor counted the same row as
    // evidence, from the same database, at the same moment.
    //
    // A carry is not a receipt — it has no transaction and never can — but it
    // is checkable against the prior epoch's own closing mark, which is a
    // different and sufficient kind of support. The page publishes the SHAPE of
    // the evidence, never amounts.
    flowsWithTx = rows.filter((r) => isEvidencedFlow(String(r.source ?? ""))).length;
  } catch {
    /* flows arrives with a worker migration */
  }

  // ── equity, divided by what the owner put in ─────────────────────────────
  let growth: { at: number; g: number }[] = [];
  let growthFull: number[] = [];
  let growthComplete = false;
  let latest: number | null = null;
  /** When `latest` was taken: the flows the return may pair with it are those booked by then. */
  let latestAt: number | null = null;
  let equityRead = false;
  let sinceAt = 0;
  try {
    // THE WHOLE PERIOD, one close an hour, newest reading always included —
    // see equity-closes.ts. It replaced the newest 500 raw rows, which were
    // two to eight hours of a period the headline measures in full.
    const { marks: pts, complete } = await readEquityCloses(db, account, epoch);
    equityRead = true;
    growthComplete = complete;
    // ONE SERIES, ONE BOOK — the paper book opens at 1,000 USDG and the
    // funded one holds what was sent, and both write here. A growth index
    // computed across the step between them measures a change of ledger, not
    // a change in value.
    //
    // AND ONLY MEASURED MARKS (held-marks.ts). A mark taken while flow
    // inference was held can carry a withdrawal or an energy buy not booked
    // yet; the index read over it dips until the booking lands, and the
    // drawdown below keeps the dip for good. The book is still the NEWEST
    // mark's, held or not.
    const clean = measuredMarks(pts)
      .map((p) => ({ v: Number(p.equity_usdg), at: Number(p.at) }))
      .filter((p) => Number.isFinite(p.v));
    latest = clean.length ? clean[clean.length - 1]!.v : null;
    latestAt = clean.length ? clean[clean.length - 1]!.at : null;
    sinceAt = clean.length ? clean[0]!.at : 0;

    // Every flow is attributed to the hour it fell in: growthIndex takes the
    // flows at or before each close, so a deposit between two closes is
    // divided out of exactly the period that contains it.
    growthFull = growthIndex(clean, flows);

    // EVERY CLOSE, UNTHINNED. The page slices the windows, so the server no
    // longer decimates — and with no decimation there is no modulo left that
    // could drop the newest reading, which is the value the headline divides.
    growth = clean.map((p, i) => ({ at: p.at, g: growthFull[i]! }));
  } catch {
    /* no history */
  }

  // ── what it did, and what it cost ────────────────────────────────────────
  let gasUsdg = 0;
  let unpricedTrades = 0;
  const activity = await readProfileTrades(db, account, epoch, publicBook);
  let landed = 0;
  let filledPaper = 0;
  let refused = 0;
  let tokensTouched = 0;
  let tradesRead = false;
  try {
    // OPERATIONS, NOT ROWS. A redeploy re-records every recent op and the
    // mirror used to copy each one up again, so counting rows put every one
    // of those ops into "Completed operations" twice.
    // ONE evidence class for tokens, chosen from the agent's own mode. An
    // integer cannot carry a chip, so folding a real acquisition and a
    // simulated one into one number is mixing nobody could see.
    const t = await readOperationCounts(db, account, epoch, paper ? "paper" : "landed");
    tradesRead = true;
    gasUsdg = t.gasUsdg;
    // A fill whose gas could not be priced contributes nothing to the SUM and
    // is never counted, so the return silently understated its own cost.
    // Unpriced is a different fact from free.
    unpricedTrades = t.unpricedTrades;
    landed = t.landed;
    filledPaper = t.filledPaper;
    refused = t.refused;
    tokensTouched = t.tokensTouched;
  } catch {
    /* older ledger */
  }

  // ── the stats line and TOP TRADES ────────────────────────────────────────
  // ONE BOOK, the agent's current one, for the reason tokensTouched gives
  // above: a trade count, a hold and a best trade that mixed the practice
  // book into the real one would each be a number nobody could unmix.
  const book: TradeBook = paper ? "paper" : "landed";
  const top = await readTopTrades(db, account, epoch, publicBook, book);
  const trips = await readRoundTrips(db, account, epoch, book);
  let gasless = false;
  try {
    gasless = await everyLandedOpSponsored(db, account, epoch);
  } catch {
    /* the column arrives with a worker migration; unread is no claim */
  }

  // ── how it decides ───────────────────────────────────────────────────────
  let how: HowItTrades | null = null;
  try {
    // `decisions` has no epoch column, so it cannot be scoped like everything
    // else here. Bounded by the first equity reading of this epoch instead —
    // the instant this run started measuring.
    const s = (await db
      .prepare(
        `SELECT source, provider, model FROM decisions
          WHERE agent_id = ? AND at >= ? ORDER BY at DESC LIMIT 1`,
      )
      .get(account, sinceAt)) as
      | { source: string | null; provider: string | null; model: string | null }
      | undefined;
    const source = String(s?.source ?? "");
    if (source === "strategist") {
      how = { kind: "model", provider: safeName(s?.provider), model: safeName(s?.model) };
    } else if (source.startsWith("strategy:")) {
      const name = source.slice("strategy:".length);
      // A tenant's own strategy file is deliberately absent from this list,
      // which is the same reason the publication gate keeps it.
      if ((PUBLISHABLE_STRATEGIES as readonly string[]).includes(name)) {
        how = { kind: "strategy", name };
      }
    }
  } catch {
    /* no decisions yet */
  }

  // ── the book, when its owner publishes it ────────────────────────────────
  let holdings: Holding[] = [];
  let holdingsRead = false;
  if (publicBook) {
    try {
      const rows = (await db
        .prepare(
          `SELECT p.symbol AS symbol, p.token AS token, p.value_usdg AS value_usdg,
                  p.price_stale AS price_stale, p.price_source AS price_source,
                  p.ui_multiplier AS ui_multiplier, p.updated_at AS updated_at,
                  b.cost_usdg AS cost_usdg
             FROM positions p
             LEFT JOIN cost_basis b
               ON b.agent_id = p.agent_id AND b.symbol = p.symbol AND b.mode = ?
            WHERE p.agent_id = ?
            ORDER BY p.value_usdg DESC`,
        )
        .all(paper ? "paper" : "live", account)) as Record<string, unknown>[];
      holdingsRead = true;

      // When it first bought each of them, and how that fill was evidenced.
      //
      // KEYED ON buy_token, NOT ON A SYMBOL: `trades` has no symbol column at
      // all, so a query selecting one throws into this catch and every
      // holding silently reports no entry, for ever. The token address is
      // what the two tables actually share.
      //
      // Earliest-first under a cap, so truncation can only drop later trades
      // and never change the first entry this computes.
      const first = new Map<string, { at: number; basis: Holding["basisSource"] }>();
      try {
        const fills = (await db
          .prepare(
            `SELECT buy_token, created_at, basis_source FROM trades
              WHERE agent_id = ? AND epoch = ? AND fill_side = 'buy'
                AND status IN ('landed','paper') AND buy_token IS NOT NULL
              ORDER BY created_at ASC LIMIT 500`,
          )
          .all(account, epoch)) as Record<string, unknown>[];
        for (const f of fills) {
          const tok = String(f.buy_token).toLowerCase();
          if (first.has(tok)) continue;
          const b = f.basis_source;
          first.set(tok, {
            at: Number(f.created_at),
            basis: b === "receipt" || b === "paper" || b === "quote" ? b : null,
          });
        }
      } catch {
        /* fill columns arrive with a worker migration */
      }

      const book = rows.reduce((n, r) => n + Number(r.value_usdg ?? 0), 0);
      holdings = rows.map((r) => {
        const value = Number(r.value_usdg ?? 0);
        // MICRO-USDG ON THE WIRE — see basisUsdg. Read as whole USDG this
        // made every holding on the public agent page look down 99.99%.
        const cost = basisUsdg(r.cost_usdg);
        const sym = String(r.symbol);
        const f = r.token ? (first.get(String(r.token).toLowerCase()) ?? null) : null;
        const mult = r.ui_multiplier === null || r.ui_multiplier === undefined
          ? 1
          : Number(r.ui_multiplier);
        return {
          symbol: sym,
          token: r.token ? String(r.token) : null,
          valueUsdg: value,
          costUsdg: cost,
          // Unknown basis means unknown return, not a flat one.
          pnlBps: cost !== null && cost > 0 ? Math.round(((value - cost) / cost) * 10_000) : null,
          shareBps: book > 0 ? Math.round((value / book) * 10_000) : null,
          priceStale: Number(r.price_stale ?? 0) === 1,
          priceSource: String(r.price_source ?? "chainlink"),
          acting: Number.isFinite(mult) && mult !== 1,
          markedAt: r.updated_at ? Number(r.updated_at) : null,
          heldSince: f?.at ?? null,
          basisSource: f?.basis ?? null,
        };
      });
    } catch {
      /* cost_basis arrives with a worker migration */
    }
  }

  // THE SAME RULE THE LEADERBOARD USES, and it was missing here. This computed
  // the identical arithmetic without the landed > 0 refusal, so the profile
  // published a return the board was correctly refusing to rank — for the same
  // agent, on the same data, at the same moment.
  // THE DENOMINATOR'S EVIDENCE, from the worker's own assessment.
  //
  // Read separately and defensively: the column arrives with a worker
  // migration, and a missing column must cost a quality signal rather than the
  // page. Null on failure, and null is "not assessed" — which rankPnl refuses
  // on rather than treats as permission.
  let contributionsKnown: boolean | null = null;
  try {
    const q = (await db
      .prepare("SELECT contributions_known FROM agents WHERE LOWER(smart_account) = ?")
      .get(account.toLowerCase())) as { contributions_known: number | null } | undefined;
    contributionsKnown =
      q?.contributions_known === null || q?.contributions_known === undefined
        ? null
        : Number(q.contributions_known) === 1;
  } catch {
    /* the column arrives with a worker migration; unknown until it does */
  }

  // THE RETURN'S DENOMINATOR IS WHAT WAS ON RECORD BY ITS NUMERATOR. `latest`
  // is the newest measured mark, which during a hold is older than the flows
  // booked since — an owner transfer that landed, a settled energy buy — and
  // those are not in its cash. Pairing them publishes the transfer as profit
  // for as long as the hold lasts. With no measured mark there is no numerator
  // either, and the reason rankPnl gives is decided as before, on every flow.
  const contributed = latestAt === null ? onRecord : netFlowsUpTo(flows, latestAt);
  const { pnlBps, unrankedWhy } = rankPnl({ contributed, latest, gasUsdg, landed, contributionsKnown });

  return {
    slug: identity.slug,
    name: String(row.name ?? "Agent"),
    handle: (row.x_handle ?? "").trim() || null,
    // WHETHER ANYONE CHECKED. The handle is what the owner typed; this is
    // whether they proved it. Only a true here may become a link.
    handleVerified: Number(row.x_verified ?? 0) !== 0,
    mode: String(row.mode ?? "idle"),
    beatAt: row.beat_at ? Number(row.beat_at) : null,
    how,
    pnlBps,
    paperPnlBps: paper ? await readPaperReturn(db, account, epoch) : null,
    unrankedWhy,
    // REFUSED ON THE SAME CONDITION AS THE RETURN. An agent that has never
    // filled has produced no drawdown either, and the figure it showed came
    // from a paper book's flat opening balance plus the owner's deposits.
    //
    // Measured on the growth index rather than the equity line, so a
    // withdrawal is not a loss — and on the UNDECIMATED series, because one
    // reading in nine cannot see a trough between two kept samples.
    maxDdBps: unrankedWhy === null ? drawdownBps(growthFull) : null,
    landed,
    filledPaper,
    refused,
    tokensTouched,
    gas: { usdg: gasUsdg, unpricedTrades },
    funded: onRecord !== null,
    contributionsEvidenced: contributionsKnown === true,
    flowsWithTx,
    flowsTotal,
    growth,
    growthComplete,
    holdings,
    publicBook,
    tradesRead,
    recentTrades: activity.trades,
    activityRead: activity.read,
    equityRead,
    flowsRead,
    holdingsRead,
    topTrades: top.trades,
    topTradesRead: top.read,
    // A capped read's count is a floor and says so; its hold is not computed,
    // because FIFO needs the earliest buys and a capped tape may not have them.
    // What the book carried into the period is sold first and pairs with
    // nothing (hold-time.ts); unread, it refuses the hold of any coin sold.
    tradeCount: trips ? trips.fills.length : null,
    tradeCountFloor: trips?.truncated === true,
    avgHoldSec: trips && !trips.truncated ? averageHoldSec(trips.fills, trips.opening, trips.dust) : null,
    joinedAt: joinedAtOf(identity.createdAt),
    // AND CONSISTENT WITH THE GAS THIS PAGE CHARGES. A sponsored op writes no
    // owner gas at all (index.ts), so any priced or unpriced cost beside the
    // claim means the two disagree — and "every trade sponsored" printed over
    // "net of $0.40 in gas" would be a contradiction on one screen.
    gasless: gasless && gasUsdg === 0 && unpricedTrades === 0,
  };
}
