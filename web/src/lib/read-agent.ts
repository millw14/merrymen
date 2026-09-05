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
import { cache } from "react";
import { withReadDb } from "@/lib/ledger";
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
  /** Why there is no return to show. The page says which, rather than assuming. */
  unrankedWhy: UnrankedWhy | null;
  /** Peak-to-trough of the growth index. Null whenever the return is unranked. */
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
   */
  growth: { at: number; g: number }[];
  /** Empty when the owner has not opted in. `publicBook` says which it is. */
  holdings: Holding[];
  publicBook: boolean;
  /** Whether each read actually answered. A default is not an answer. */
  tradesRead: boolean;
  equityRead: boolean;
  flowsRead: boolean;
  holdingsRead: boolean;
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

  // Every account this tenant has held: a re-grant must not split an agent's
  // history into two strangers.
  const accounts = identity.accounts.map((a) => a.toLowerCase());
  if (accounts.length === 0) return null;

  // The book is the OWNER's call, and the setting is per tenant.
  let publicBook = false;
  try {
    const s = (await getSettingsStore().get(identity.tenant)) as { publicBook?: boolean } | null;
    publicBook = s?.publicBook === true;
  } catch {
    /* fail closed: no setting readable means no book published */
  }

  return withReadDb(async (db): Promise<AgentProfile | null> => {
    if (!db) return null;
    const inList = accounts.map(() => "?").join(", ");

    let row:
      | {
          smart_account: string;
          name: string;
          x_handle: string | null;
          mode: string;
          epoch: number;
          beat_at: number | null;
        }
      | undefined;
    try {
      row = (await db
        .prepare(
          `SELECT smart_account, name, x_handle, COALESCE(mode, 'idle') AS mode,
                  COALESCE(epoch, 1) AS epoch, beat_at
             FROM agents WHERE LOWER(smart_account) IN (${inList})
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...accounts)) as typeof row;
    } catch {
      return null;
    }
    if (!row) return null;

    const account = row.smart_account;
    const epoch = Number(row.epoch ?? 1);
    const paper = row.mode === "paper";

    // ── flows, row by row and not just summed ────────────────────────────────
    // The total is what the return divides by; the individual timestamps are
    // what make a drawdown mean anything, because without them money the owner
    // took out is indistinguishable from money the agent lost.
    let flows: { at: number; signed: number }[] = [];
    let contributed: number | null = null;
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
      contributed = rows.length === 0 ? null : flows.reduce((n, x) => n + x.signed, 0);
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
    let latest: number | null = null;
    let equityRead = false;
    let sinceAt = 0;
    try {
      const pts = (await db
        .prepare(
          `SELECT equity_usdg, at FROM (
             SELECT equity_usdg, at, id FROM equity WHERE agent_id = ? AND epoch = ?
              ORDER BY at DESC, id DESC LIMIT 500
           ) ORDER BY at ASC, id ASC`,
        )
        .all(account, epoch)) as { equity_usdg: number; at: number }[];
      equityRead = true;
      const clean = pts
        .map((p) => ({ v: Number(p.equity_usdg), at: Number(p.at) }))
        .filter((p) => Number.isFinite(p.v));
      latest = clean.length ? clean[clean.length - 1]!.v : null;
      sinceAt = clean.length ? clean[0]!.at : 0;

      // Computed on the FULL series before downsampling: dropping readings
      // first would misattribute every flow that fell between two kept ones.
      growthFull = growthIndex(clean, flows);

      // KEEP THE NEWEST READING, ALWAYS. A plain modulo anchors on index 0, so
      // the last few readings never reached the chart and its right-hand end
      // was not `latest` — the value the headline percentage divides.
      const step = Math.max(1, Math.ceil(clean.length / 60));
      growth = clean
        .map((p, i) => ({ at: p.at, g: growthFull[i]!, i }))
        .filter((p) => p.i % step === 0 || p.i === clean.length - 1)
        .map(({ at, g }) => ({ at, g }));
    } catch {
      /* no history */
    }

    // ── what it did, and what it cost ────────────────────────────────────────
    let gasUsdg = 0;
    let unpricedTrades = 0;
    let landed = 0;
    let filledPaper = 0;
    let refused = 0;
    let tokensTouched = 0;
    let tradesRead = false;
    try {
      const t = (await db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status = 'landed' THEN gas_usdg ELSE 0 END), 0) AS gas,
                  SUM(CASE WHEN status = 'landed' AND gas_wei IS NOT NULL AND gas_usdg IS NULL
                           THEN 1 ELSE 0 END) AS unpriced,
                  SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed,
                  SUM(CASE WHEN status = 'paper' THEN 1 ELSE 0 END) AS paper_filled,
                  SUM(CASE WHEN status IN ('rejected','reverted') THEN 1 ELSE 0 END) AS refused,
                  COUNT(DISTINCT CASE WHEN fill_side = 'buy' AND status = ?
                                      THEN LOWER(buy_token) END) AS tokens
             FROM trades WHERE agent_id = ? AND epoch = ?`,
        )
        .get(paper ? "paper" : "landed", account, epoch)) as
        | Record<string, number | null>
        | undefined;
      tradesRead = true;
      gasUsdg = Number(t?.gas ?? 0);
      // A fill whose gas could not be priced contributes nothing to the SUM and
      // is never counted, so the return silently understated its own cost.
      // Unpriced is a different fact from free.
      unpricedTrades = Number(t?.unpriced ?? 0);
      landed = Number(t?.landed ?? 0);
      filledPaper = Number(t?.paper_filled ?? 0);
      refused = Number(t?.refused ?? 0);
      // ONE evidence class, chosen from the agent's own mode. An integer cannot
      // carry a chip, so folding a real acquisition and a simulated one into one
      // number is mixing nobody could see.
      tokensTouched = Number(t?.tokens ?? 0);
    } catch {
      /* older ledger */
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
          const cost = r.cost_usdg === null || r.cost_usdg === undefined ? null : Number(r.cost_usdg);
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

    const { pnlBps, unrankedWhy } = rankPnl({ contributed, latest, gasUsdg, landed, contributionsKnown });

    return {
      slug: identity.slug,
      name: String(row.name ?? "Agent"),
      handle: (row.x_handle ?? "").trim() || null,
      mode: String(row.mode ?? "idle"),
      beatAt: row.beat_at ? Number(row.beat_at) : null,
      how,
      pnlBps,
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
      funded: contributed !== null,
      contributionsEvidenced: contributionsKnown === true,
      flowsWithTx,
      flowsTotal,
      growth,
      holdings,
      publicBook,
      tradesRead,
      equityRead,
      flowsRead,
      holdingsRead,
    };
  });
});
