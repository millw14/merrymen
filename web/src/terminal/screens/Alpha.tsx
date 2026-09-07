import { useEffect, useState } from "react";
import { Info } from "@/components/Info";
import { compactUsd, coinPrice } from "../live";
import { Empty } from "../ui";
import type { AlphaExtras, DiscoveryRow } from "@/lib/read-discoveries";

/**
 * ALPHA — what the scout looked at, and what it threw out.
 *
 * THIS IS NOT THE COINS PAGE BEHIND A LOCK. `/api/discoveries` is public and
 * stays public. What is here is the working: the coins the model was shown and
 * DECLINED, and what was read about each one before it looked. See the route's
 * header for why a lock over already-public data would be decoration.
 *
 * Every honesty rule the coin cards carry applies here and is repeated rather
 * than assumed, because a passed-over coin is exactly the one a reader is most
 * likely to misread: `onCurve` means there is no pool and the "depth" figure is
 * mostly a virtual seed, and no verdict means nobody formed one — never that
 * the coin failed something.
 */

/** One row as this screen receives it: the public shape, plus the research. */
type Research = NonNullable<AlphaExtras["research"]>[string];
type Item = DiscoveryRow & { research: Research | null };

type Wire =
  | {
      locked: true;
      why: "sign-in" | "balance" | "unreachable";
      picks: number;
      passed: number;
      need: { tokens: number; name: string; emoji: string; perks: string[] };
      token: { symbol: string; address: string };
    }
  | {
      locked: false;
      tier: { id: string; name: string; emoji: string } | null;
      fetchedAt: number;
      picks: Item[];
      passed: Item[];
      verdictsWhy: "no-model" | "model-failed" | null;
      researched: boolean;
      truncated: boolean;
      degraded: boolean;
      indexUnreachable: boolean;
    };

type State = { kind: "loading" } | { kind: "failed"; why: string } | { kind: "ok"; wire: Wire };

export function Alpha({ onToken }: { onToken: (id: string) => void }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let mounted = true;
    fetch("/api/alpha", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`the alpha desk answered ${r.status}`);
        return (await r.json()) as Wire;
      })
      .then((wire) => mounted && setState({ kind: "ok", wire }))
      // OUR failure, said as ours. A fetch that did not land says nothing at
      // all about what the scout thinks, and "nothing vetted" here would be us
      // publishing an outage as an opinion.
      .catch((e: unknown) =>
        mounted && setState({ kind: "failed", why: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="page alpha-page">
      <header className="board-head">
        <h1 className="top-title">Alpha</h1>
        {state.kind === "ok" && !state.wire.locked && state.wire.tier && (
          <span className="alpha-tier">
            {state.wire.tier.emoji} {state.wire.tier.name}
          </span>
        )}
      </header>

      {state.kind === "loading" && <p role="status" className="hosted-note">Reading the desk…</p>}

      {state.kind === "failed" && (
        <Empty
          title="The alpha desk could not be read."
          note={`${state.why}. That is a gap on our side, not a quiet market.`}
        />
      )}

      {state.kind === "ok" && state.wire.locked && <Locked wire={state.wire} />}
      {state.kind === "ok" && !state.wire.locked && <Desk wire={state.wire} onToken={onToken} />}
    </div>
  );
}

/**
 * THE TEASER, AND WHY IT IS ONLY COUNTS.
 *
 * There is nothing to un-blur here: the bodies never left the server. What a
 * locked reader gets is the size of the thing and the price of entry, which is
 * an honest advertisement — and three different reasons, because "sign in",
 * "hold some" and "we could not check" have three different next steps.
 */
function Locked({ wire }: { wire: Extract<Wire, { locked: true }> }) {
  const head =
    wire.why === "sign-in"
      ? "Sign in to open the desk."
      : wire.why === "unreachable"
        ? "We could not read your balance."
        : "The desk is open to $MERRYMEN holders.";
  const line =
    wire.why === "sign-in"
      ? "Alpha reads your wallet, so it needs to know which one it is."
      : wire.why === "unreachable"
        ? // Never "you don't hold enough" on a failed read. The reader would go
          // and buy more to fix a problem that is ours.
          "The chain did not answer when we asked what you hold. Nothing is being said about your wallet — try again shortly."
        : `Hold ${wire.need.tokens.toLocaleString()} ${wire.token.symbol} to read it.`;

  return (
    <section className="alpha-lock">
      <h2>{head}</h2>
      <p>{line}</p>
      <p className="alpha-count mono">
        <b>{wire.picks}</b> vetted · <b>{wire.passed}</b> looked at and passed
      </p>
      <p className="hosted-note">
        Behind this: what the scout was shown and turned down, and what was read about each coin
        before it decided. The coins it kept are public on the markets screen.
      </p>
      {wire.why === "balance" && (
        <ul className="alpha-perks">
          {wire.need.perks.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {wire.why === "sign-in" && (
        <a className="alpha-go" href="/">
          Sign in
        </a>
      )}
    </section>
  );
}

function Desk({ wire, onToken }: { wire: Extract<Wire, { locked: false }>; onToken: (id: string) => void }) {
  return (
    <>
      {/* SAID ONCE FOR THE PAGE, NOT PER COIN. These fail as a wave — the index
          refuses a burst, not one token — so thirty per-card caveats would read
          as thirty broken coins instead of one degraded read. */}
      {wire.indexUnreachable && (
        <p className="hosted-note" role="status">
          The market index did not answer this pass. Nothing below is a judgement about a quiet
          market — it is the shape of a read that failed.
        </p>
      )}
      {wire.truncated && !wire.indexUnreachable && (
        <p className="hosted-note" role="status">
          The index cut the sweep short, so this is a prefix of the market rather than the market.
        </p>
      )}
      {!wire.researched && (
        <p className="hosted-note" role="status">
          No site research ran on this pass, so nothing below says whether a coin&rsquo;s own site
          holds up. Absent is not clean.
        </p>
      )}

      <section className="strip">
        <h3>
          Kept <span>{wire.picks.length}</span>
          <Info>
            The scout ranks what the numeric screen already admitted. Conviction is an ordering —
            look here first — never a size and never a permission to trade.
          </Info>
        </h3>
        {wire.picks.length === 0 ? (
          wire.verdictsWhy ? (
            // The distinction the whole read is built on: it could not look.
            <Empty
              title="Nothing has been vetted."
              note={
                wire.verdictsWhy === "no-model"
                  ? "The scout was not run on this pass, so nothing here was judged either way."
                  : "The scout could not be reached. That is not the same as looking and liking nothing."
              }
            />
          ) : (
            <Empty
              title="It looked and kept nothing."
              note="Often the right answer on this chain. Passed coins are below."
            />
          )
        ) : (
          <ol className="alpha-list">
            {wire.picks.map((r) => (
              <Row key={r.token} r={r} onToken={onToken} />
            ))}
          </ol>
        )}
      </section>

      {wire.passed.length > 0 && (
        <details className="alpha-passed">
          <summary>
            Looked at and passed <span className="mono">{wire.passed.length}</span>
          </summary>
          <ol className="alpha-list">
            {wire.passed.map((r) => (
              <Row key={r.token} r={r} onToken={onToken} passed />
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

function Row({ r, onToken, passed = false }: { r: Item; onToken: (id: string) => void; passed?: boolean }) {
  const up = (r.change24hPct ?? 0) >= 0;
  return (
    <li className={`alpha-row${passed ? " out" : ""}`}>
      <button type="button" className="alpha-hit" onClick={() => onToken(r.token)}>
        <span className="alpha-name">
          <b>{r.name}</b>
          {/* TWO DIFFERENT NOES, and the curve one comes first. A coin on its
              launch curve has no pool at all, so "add it to a grant" is advice
              that does not work — the owner would pay for a re-sign and still
              not be able to touch it. */}
          {r.onCurve && <span className="alpha-chip">on its curve</span>}
          {r.graduated && <span className="alpha-chip up">graduated</span>}
        </span>
        <span className={`alpha-chg mono ${up ? "up" : "down"}`}>
          {r.change24hPct === null ? "—" : `${up ? "+" : ""}${r.change24hPct.toFixed(1)}%`}
        </span>
      </button>

      {r.verdict && (
        <p className="alpha-say">
          <span className="pips" aria-label={`conviction ${r.verdict.conviction} of 5`}>
            {"▮".repeat(Math.max(1, Math.min(5, r.verdict.conviction)))}
          </span>
          {r.verdict.reason}
        </p>
      )}

      <p className="alpha-figs mono">
        <span>
          <i>px</i>
          {coinPrice(r.priceUsd)}
        </span>
        <span>
          {/* FDV, and it says FDV. The index substitutes fully-diluted value
              whenever it has no circulating supply, and calling that market cap
              makes every young coin look bigger and safer than it is. */}
          <i>fdv</i>
          {compactUsd(r.fdvUsd)}
        </span>
        <span>
          <i>depth</i>
          {/* A curve reports a reserve that is mostly the virtual seed — about
              $4,100 it does not hold — so it is never shown as sellable depth. */}
          {r.onCurve ? "pre-grad" : compactUsd(r.reserveUsd)}
        </span>
        <span>
          <i>24h</i>
          {compactUsd(r.volume24hUsd)}
        </span>
        <span>
          <i>buyers</i>
          {r.buyers24h === null ? "—" : r.buyers24h}
        </span>
      </p>

      {r.research && <ResearchLine f={r.research} />}
    </li>
  );
}

/**
 * The site read, as facts rather than prose.
 *
 * Never the launcher's own words — those are an instruction channel, which is
 * why the scout is fed counts and booleans and never the page text. Nulls are
 * skipped rather than rendered as a dash: "we did not visit" is already said
 * once for the page, and repeating it per coin turns an absence into an
 * accusation.
 */
function ResearchLine({ f }: { f: Research }) {
  const parts: string[] = [];
  if (f.publishedNothing === true) parts.push("published nothing");
  if (f.siteReachable === false) parts.push("site down");
  if (f.siteReachable === true) {
    parts.push("site up");
    if (f.siteNamesContract === true) parts.push("names the contract");
    if (f.siteNamesContract === false) parts.push("never names the contract");
    if (f.siteHypeWords !== null) parts.push(`${f.siteHypeWords} hype words`);
    if (f.siteOutboundDomains !== null) parts.push(`${f.siteOutboundDomains} outbound`);
  }
  if (!parts.length) return null;
  return <p className="alpha-research mono">{parts.join(" · ")}</p>;
}
