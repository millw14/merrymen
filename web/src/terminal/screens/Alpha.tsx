import { useEffect, useState } from "react";
import { LockKeyhole, FileText, Activity, ExternalLink } from "lucide-react";
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
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let mounted = true;
    setState({ kind: "loading" });
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
  }, [revision]);

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
      <p className="alpha-intro">The research behind the trade.</p>

      {state.kind === "loading" && <p role="status" className="hosted-note">Loading Alpha…</p>}

      {state.kind === "failed" && (
        <Empty
          title="Alpha is unavailable."
          action={{label:"Try again",onClick:()=>setRevision(value=>value+1)}}
        />
      )}

      {state.kind === "ok" && state.wire.locked && <Locked wire={state.wire} onRefresh={()=>setRevision(value=>value+1)} />}
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
function Locked({ wire, onRefresh }: { wire: Extract<Wire, { locked: true }>; onRefresh:()=>void }) {
  return <>
    <section className="alpha-gate">
      <LockKeyhole size={32}/><h2>An edge for holders.</h2>
      <p>Hold {wire.token.symbol} in your signed-in wallet to unlock Alpha.</p>
      <div className="alpha-threshold"><strong>{wire.need.tokens.toLocaleString()}</strong><span>{wire.token.symbol}</span></div>
      {wire.why === "unreachable" && <p role="status">Could not verify your holdings. Try again.</p>}
      {wire.why === "sign-in" ? <a className="flow-primary" href="/profile">Sign in with wallet</a> : <button className="flow-primary" onClick={onRefresh}>Verify wallet holdings</button>}
    </section>
    <section className="alpha-inside"><h2>Inside Alpha</h2>
      {/* HOW MUCH IS BEHIND THE LOCK, in live numbers rather than a promise.
          The route sends these counts precisely so a locked reader can weigh
          the ask — its own comment calls them "the honest advertisement: they
          say how much is there without saying what it is". Naming what is
          inside without saying how much of it there is asks somebody for
          100,000 tokens on trust. Rendered only when the scout has actually
          ranked something: 0 vetted would advertise an empty desk, and the
          truthful thing to show then is nothing. */}
      {wire.picks + wire.passed > 0 && (
        <p className="alpha-counts"><b>{wire.picks}</b> vetted · <b>{wire.passed}</b> looked at and passed</p>
      )}
      <ul><li><Activity size={22} aria-hidden="true"/><span>Tokens our agents researched</span></li><li><FileText size={22} aria-hidden="true"/><span>Short takes with the reasoning attached</span></li><li><ExternalLink size={22} aria-hidden="true"/><span>What our agents kept—and passed on</span></li></ul></section>
  </>;
}

function Desk({ wire, onToken }: { wire: Extract<Wire, { locked: false }>; onToken: (id: string) => void }) {
  return (
    <>
      {/* SAID ONCE FOR THE PAGE, NOT PER COIN. These fail as a wave — the index
          refuses a burst, not one token — so thirty per-card caveats would read
          as thirty broken coins instead of one degraded read. */}
      {wire.indexUnreachable && (
        <p className="hosted-note" role="status">
          Market data is unavailable. Try again shortly.
        </p>
      )}
      {wire.truncated && !wire.indexUnreachable && (
        <p className="hosted-note" role="status">
          Some market data is unavailable.
        </p>
      )}
      {!wire.researched && (
        <p className="hosted-note" role="status">
          Website research is unavailable for this update.
        </p>
      )}

      <section className="strip">
        <h3>
          Kept <span>{wire.picks.length}</span>
        </h3>
        {wire.picks.length === 0 ? (
          wire.verdictsWhy ? (
            // The distinction the whole read is built on: it could not look.
            <Empty
              title="Nothing has been vetted."
              note={
                wire.verdictsWhy === "no-model"
                  ? "Research has not run yet."
                  : "Research is unavailable."
              }
            />
          ) : (
            <Empty
              title="No picks this time."
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
