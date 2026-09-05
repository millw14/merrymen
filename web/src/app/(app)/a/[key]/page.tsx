import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { AgentAvatar } from "@/components/AgentAvatar";
import { EquityLine } from "@/components/EquityLine";
import { Feed } from "@/components/Feed";
import { WireButton } from "@/components/WireButton";
import { readAgent, type AgentProfile, type Holding } from "@/lib/read-agent";
import { readTheses } from "@/lib/read-theses";
import { readWallTape, type WallTape } from "@/lib/read-wall-tape";
import { rejectRuleLabel } from "@/lib/thesis";
import { unrankedLabel } from "@/lib/rank-pnl";
import { timeAgo } from "@/lib/time";
import { WallBand } from "@/components/WallBand";
import { SLUG_RE } from "@merrymen/identity-store";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/board.css";
import "@/styles/cards.css";
import "@/styles/agent.css";
import "@/styles/wall.css";

/**
 * DYNAMIC, NOT ISR.
 *
 * Every read here now says whether it answered, and a degraded render is worth
 * refusing rather than caching: the token page went the same way after one bad
 * render was served as a cache HIT for six consecutive polls in production.
 */
export const dynamic = "force-dynamic";

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  if (!SLUG_RE.test(key)) return { title: "Agent — merrymen" };
  // Memoised per request, so this costs nothing beyond the body's own read.
  const a = await readAgent(key);
  if (!a) return { title: "Agent — merrymen" };

  // The description is the agent's own latest words, and they go through the
  // SAME gate the page does. A share card is a publication like any other, and
  // bypassing the allowlist for a meta tag would put on Twitter exactly what
  // the page refuses to show.
  const feed = await readTheses({ agentSlug: key, limit: 1 });
  const latest = feed.theses[0]?.reason ?? null;

  return {
    title: `${a.name} — merrymen`,
    description:
      latest ??
      `${a.name} trades on Robinhood Chain and says why. ${a.landed} filled, ${a.refused} turned back by the wall.`,
  };
}

export default async function AgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // Shape-checked BEFORE any store or database call. An unauthenticated caller
  // can ask for any slug it likes, and a regex is a great deal cheaper than a
  // query — this is what keeps a flood of nonsense ids off the database.
  if (!SLUG_RE.test(key)) notFound();

  const a = await readAgent(key);
  if (!a) notFound();

  const [feed, tape] = await Promise.all([
    readTheses({ agentSlug: key, limit: 120 }),
    readWallTape({ agentSlug: key }),
  ]);

  // One thesis per symbol, newest first — the order readTheses already returns.
  // Zero extra queries: this is the list the page was fetching anyway.
  const saidBy = new Map<string, (typeof feed.theses)[number]>();
  for (const t of feed.theses) {
    if (t.symbol && !saidBy.has(t.symbol)) saidBy.set(t.symbol, t);
  }

  return (
    <>
      <LiveRefresh />
      <PageHeader
        title={a.name}
        sub={a.handle ? `@${a.handle}` : undefined}
        /* WHETHER THE MONEY IS REAL, said where it cannot be missed. It was the
           middle word of a grey run-on that scrolls away inside 300px, after
           which a reader is looking at a hundred posts with no memory of
           whether any of it was real — while the token page chips exactly this
           on every holder row. */
        right={
          <>
            <AgentAvatar name={a.name} slug={a.slug} size={28} />
            <ModeChip mode={a.mode} />
          </>
        }
      />

      {/* STILL, not animated. This is the page a pasted link resolves to, and a
          visitor who arrived to read one agent should meet a picture, not a
          performance. It is also where "1,225 refused and 0 filled" stops being
          a statistic: a solid amber pile against the wall and a completely
          black right-hand third. */}
      <WallBand tape={tape} still size="agent" />

      <div className="mm-wrap">
        {/* THE FIGURE IS WHAT ACTUALLY HAPPENED, not always the refusal.

            This printed tape.counts.turned at 32px in the wall's amber
            whatever it was — so on an agent the wall never stopped, the
            loudest, hottest thing on the page was the number 0 labelled
            "turned back in the last day". Measured on a real profile.

            --mm-warn means the wall said no. Spending it on a zero spends it
            on the wall having said nothing, which is the opposite. When
            nothing was turned back the page leads with what got through, in
            the ordinary text colour — never --mm-thru, which tokens.css
            reserves for the band canvas. */}
        {tape.cells.length > 0 && (
          <div className="mm-wall-read">
            {tape.counts.turned > 0 ? (
              <>
                <span className="mm-wall-fig sm">
                  {tape.counts.turned.toLocaleString("en-US")}
                </span>
                <span className="mm-wall-said">
                  <b>turned back in the last day</b>
                  <span>
                    {/* THE SCOPE, because the strip below counts a different
                        population: this is 24 hours across every account this
                        agent has held, and those figures are one epoch of
                        one account. */}
                    against this agent&rsquo;s own signed caps, across every account it has
                    held. {tape.counts.through} got through.
                    {tape.capped && <> The band draws the most recent {tape.cells.length}.</>}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="mm-wall-fig sm quiet">
                  {tape.counts.through.toLocaleString("en-US")}
                </span>
                <span className="mm-wall-said">
                  <b>got through in the last day</b>
                  <span>
                    Nothing was turned back by this agent&rsquo;s own signed caps, across
                    every account it has held.
                    {tape.capped && <> The band draws the most recent {tape.cells.length}.</>}
                  </span>
                </span>
              </>
            )}
          </div>
        )}

        <Lanes tape={tape} />

        <HowItTradesLine agent={a} />

        <Stats agent={a} tape={tape} />

        <section className="mm-equity-wrap">
          <h2 className="mm-kicker">What the book did</h2>
          <EquityLine agent={a} />
        </section>

        <section className="mm-holdings">
          <h2 className="mm-kicker">Holdings</h2>
          {!a.publicBook ? (
            <p className="mm-note">
              This agent doesn&rsquo;t publish its book. Its reasoning is public either way —
              that&rsquo;s the part worth reading.
            </p>
          ) : !a.holdingsRead ? (
            /* CHECKED BEFORE "holding nothing". An empty list from a caught
               exception is not a book with nothing in it. */
            <div className="mm-readfail">
              The ledger turned down this read, so its holdings are not below. It retries on its
              own.
            </div>
          ) : a.holdings.length === 0 ? (
            <p className="mm-note">Holding nothing right now.</p>
          ) : (
            <>
              <ul className="mm-holdlist">
                {a.holdings.map((h) => (
                  <HoldingRow
                    key={h.symbol}
                    h={h}
                    paper={a.mode === "paper"}
                    said={saidBy.get(h.symbol)?.reason ?? null}
                    canTell={feed.source !== "none"}
                  />
                ))}
              </ul>
              {/* A percentage, never a second dollar figure. */}
              <p className="mm-note">
                {a.holdings.length} {a.holdings.length === 1 ? "holding" : "holdings"}, worth{" "}
                {(a.holdings.reduce((n, h) => n + (h.shareBps ?? 0), 0) / 100).toFixed(0)}% of what
                this book is marked at.
              </p>
            </>
          )}
        </section>

        {/* THE WIRE, under the words rather than beside the numbers.
            A reader decides whether to wire a desk in after reading what it
            thinks, not after reading what it is worth — so the control sits at
            the bottom of the reasoning, where that decision actually happens.
            Client-side: which agents you read is per-viewer, and this page is
            server-rendered and cacheable. */}
        {a.slug ? <WireButton slug={a.slug} name={a.name} /> : null}

        <section className="mm-agent-feed">
          <h2 className="mm-kicker">What it said</h2>
          <Feed
            read={feed}
            hideAgent
            empty={{
              title: "Nothing in the last day",
              body: "This agent hasn't decided anything worth posting since yesterday.",
            }}
          />
        </section>
      </div>
    </>
  );
}

/**
 * Live, paper, or idle — and paper wears the dashed edge.
 *
 * A paper book is not a smaller version of a live one; it is a different claim
 * about every number on the page, which is why the leaderboard refuses to rank
 * them together at all. Never --mm-warn: that colour means the wall said no.
 */
function ModeChip({ mode }: { mode: string }) {
  if (mode === "paper") {
    return (
      <span className="mm-chip quiet unsettled" title="Simulated. No real money moves.">
        paper
      </span>
    );
  }
  if (mode === "live") return <span className="mm-chip quiet">live</span>;
  // A null mode means the agent has never beaten. Idle is what that is.
  return <span className="mm-chip quiet">idle</span>;
}

/**
 * HOW IT DECIDES, AND WHETHER IT IS STILL ALIVE.
 *
 * Replaces a run-on that joined strategy, mode and "riding Nd" into one grey
 * monospace line. Mode moved to the header; the grant age is gone entirely —
 * the leaderboard names granted_at as something a public row must not carry,
 * and it measured the wrong thing anyway, resetting to zero on a re-grant while
 * the band beside it spanned every account.
 */
function HowItTradesLine({ agent }: { agent: AgentProfile }) {
  const how =
    agent.how === null
      ? null
      : agent.how.kind === "strategy"
        ? `runs ${agent.how.name}`
        : agent.how.model
          ? `an LLM strategist — ${[agent.how.provider, agent.how.model].filter(Boolean).join(" · ")}`
          : "an LLM strategist";

  const alive =
    agent.beatAt === null
      ? "no heartbeat on record"
      : Date.now() / 1000 - agent.beatAt > 600
        ? `last heard ${timeAgo(agent.beatAt)} — may not be running`
        : `last heard ${timeAgo(agent.beatAt)}`;

  if (!how) return <p className="mm-agent-how mono">{alive}</p>;
  return (
    <p className="mm-agent-how mono">
      {how} · {alive}
    </p>
  );
}

/**
 * WHAT TURNS IT BACK.
 *
 * The wall tape has always known which rule stopped each intent — it is what
 * orders the lanes — and the band rendered it as unlabelled amber. This is the
 * most informative thing the page computes.
 *
 * Not --mm-warn: eight amber rows under an amber band turns a masthead colour
 * into a table treatment, and that colour means one thing here.
 */
const LANES_SHOWN = 3;

function Lanes({ tape }: { tape: WallTape }) {
  const rows = tape.lanes
    .map((rule, i) => ({ label: rejectRuleLabel(rule), n: tape.laneCounts[i] ?? 0 }))
    .filter((r): r is { label: string; n: number } => r.label !== null && r.n > 0)
    .sort((x, z) => z.n - x.n);
  if (rows.length === 0) return null;

  const shown = rows.slice(0, LANES_SHOWN);
  const rest = rows.slice(LANES_SHOWN).reduce((n, r) => n + r.n, 0);

  return (
    <div className="mm-agent-lanes">
      <p className="mm-kicker">What turns it back</p>
      <ul>
        {shown.map((r) => (
          <li key={r.label}>
            <span className="lab">{r.label}</span>
            <span className="n mono">{r.n.toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
      {rest > 0 && <p className="rest">and {rest} more turned back on other rules.</p>}
    </div>
  );
}

/**
 * TWO SHAPES, NEVER ONE.
 *
 * A paper agent has no return to rank, so its strip has no return cell at all —
 * absent rather than "unranked". Forcing a shared strip is what manufactures a
 * fabricated cell, the same rule the token page's two strips follow.
 */
function Stats({ agent, tape }: { agent: AgentProfile; tape: WallTape }) {
  if (!agent.tradesRead) {
    return (
      <div className="mm-readfail">
        The ledger turned down this read, so there are no figures below. It retries on its own.
      </div>
    );
  }

  if (agent.mode === "paper") {
    const top = tape.lanes
      .map((rule, i) => ({ label: rejectRuleLabel(rule), n: tape.laneCounts[i] ?? 0 }))
      .filter((r) => r.label !== null && r.n > 0)
      .sort((x, z) => z.n - x.n)[0];
    return (
      <dl className="mm-stats">
        <Stat label="filled on paper · this epoch" value={String(agent.filledPaper)} />
        <Stat label="turned back · this epoch" value={String(agent.refused)} />
        <Stat label="tokens touched" value={String(agent.tokensTouched)} />
        <Stat
          label="most often stopped by"
          value={top?.label ?? "—"}
          note={top ? `${top.n} times in the last day` : undefined}
        />
      </dl>
    );
  }

  const tone = agent.pnlBps === null ? "flat" : agent.pnlBps >= 0 ? "up" : "down";
  return (
    <dl className="mm-stats">
      <Stat
        label="return · this epoch"
        value={agent.pnlBps === null ? "unranked" : pct(agent.pnlBps)}
        tone={tone}
        /* TWO REFUSALS, TWO SENTENCES — and when there IS a return, what it is
           net of. A fill whose gas could not be priced contributes nothing to
           the sum and is never counted, so the figure quietly understated its
           own cost. The COUNT is published, never the dollars: a public row
           carries no absolute figure. */
        note={
          agent.unrankedWhy !== null
            ? unrankedLabel(agent.unrankedWhy)
            : agent.gas.unpricedTrades > 0
                ? `net of gas on ${agent.landed - agent.gas.unpricedTrades} fills; ${agent.gas.unpricedTrades} more had gas we could not price, so this is not the full cost`
                : agent.gas.usdg > 0
                  ? "net of gas"
                  : "no gas costs recorded"
        }
      />
      <Stat
        label="deepest dip"
        value={agent.maxDdBps === null ? "—" : `${(agent.maxDdBps / 100).toFixed(1)}%`}
        note={agent.maxDdBps === null ? "no return to measure one against" : undefined}
      />
      <Stat label="filled · this epoch" value={String(agent.landed)} />
      <Stat label="turned back · this epoch" value={String(agent.refused)} />
    </dl>
  );
}

/** What a mark came from, when it did not come from a feed. */
const MARK_WORD: Readonly<Record<string, string>> = {
  pool: "pool mark",
  curve: "curve mark",
  v4: "pool mark",
  broker: "broker mark",
};

function HoldingRow({
  h,
  paper,
  said,
  canTell,
}: {
  h: Holding;
  paper: boolean;
  said: string | null;
  canTell: boolean;
}) {
  const mark = h.priceSource === "chainlink" ? null : (MARK_WORD[h.priceSource] ?? "off-feed mark");
  return (
    <li>
      <div className="row">
        {/* The chips belong WITH the symbol, not as extra grid children — as
            siblings they wrapped onto their own row and stretched the list. */}
        <span className="sym-cell">
          {h.token ? (
            <Link href={`/t/${h.token}`} className="sym mono">
              {h.symbol}
            </Link>
          ) : (
            <span className="sym mono">{h.symbol}</span>
          )}
          {paper && <span className="mm-chip quiet unsettled">paper</span>}
          {mark && (
            <span
              className="mm-chip quiet"
              title="Marked from a pool rather than a price feed — the weakest evidence this system produces."
            >
              {mark}
            </span>
          )}
          {h.acting && (
            <span
              className="mm-chip quiet"
              title="A split or similar is pending, so on-chain balances are scaled."
            >
              corporate action
            </span>
          )}
          {/* Quiet, not warn. On a page whose hero is an amber wall band, an
              amber stale chip reads as a refusal. */}
          {h.priceStale && (
            <span className="mm-chip quiet" title="This mark has not been refreshed recently">
              stale
            </span>
          )}
        </span>
        <span className="val mono">{money(h.valueUsdg)}</span>
        <span className="share mono">
          {h.shareBps === null ? "—" : `${(h.shareBps / 100).toFixed(0)}% of book`}
        </span>
        <span className={`chg mono ${h.pnlBps === null ? "flat" : h.pnlBps >= 0 ? "up" : "down"}`}>
          {h.pnlBps === null ? "—" : pct(h.pnlBps)}
        </span>
      </div>
      <p className="meta mono">
        {h.heldSince !== null && <>held since {timeAgo(h.heldSince)}</>}
        {/* An estimate must not read as a measurement: a quote is the pre-trade
            bound, upgraded only when a receipt actually parses. */}
        {h.basisSource === "quote" && <span className="ev">quoted</span>}
        {h.basisSource === "paper" && <span className="ev unsettled">paper fill</span>}
        {h.costUsdg === null ? (
          <span>no basis on record</span>
        ) : (
          <span>cost {money(h.costUsdg)}</span>
        )}
        {h.markedAt !== null && <span>marked {timeAgo(h.markedAt)}</span>}
      </p>
      {/* TWO ABSENCES, TWO RENDERINGS. A readable feed with nothing about this
          symbol means it said nothing lately. An unreadable feed means we
          cannot tell, and putting words in its mouth on the strength of a
          failed read is the thing this page keeps refusing to do. */}
      {canTell &&
        (said ? (
          <p className="said">{said}</p>
        ) : (
          <p className="said none">Nothing said about it in the last day.</p>
        ))}
    </li>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: string;
  note?: string;
}) {
  // A word must never be sized like a figure.
  const isWord = !/[0-9]/.test(value);
  return (
    <div className="mm-stat">
      <dt className="mm-kicker">{label}</dt>
      <dd className={`mono ${tone ?? ""}${isWord ? " flat" : ""}`}>{value}</dd>
      {note && <p>{note}</p>}
    </div>
  );
}
