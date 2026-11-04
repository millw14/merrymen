import { PerformanceChart } from "../DitherChart";
import { ArrowUpRight, ChartNoAxesCombined, MessageCircle, MessagesSquare, Plus, Shirt, Sparkles, Trophy } from "lucide-react";
import { useGroupChatSupported } from "../groupchat";
import type { LiveAgent, LiveMine, LiveToken, Thesis, TokenTab } from "../live";
import { AgentStrip } from "../AgentStrip";
import Link from "../Link";
import { usd, usdParts } from "@/lib/format";
import { pausedRecovery } from "../recovery-view";
import { Board } from "./Board";
import { MerrymanHero } from "@/merryman/MerrymanHero";
import { moodOf, type MoodInput } from "@/merryman/mood";
import { DRAFT, useOutfit } from "@/merryman/wardrobe-store";

/**
 * HOME IS YOUR MERRYMAN.
 *
 * It used to stack six sections and about forty numbers: a balance hero, a
 * connections strip, a five-row leaderboard of a dozen fields a row, and a
 * market table — the whole product on the first screen a newcomer opens. Now
 * it answers one question, "how is my merryman doing?", with the character
 * himself (his pose and his bubble are READINGS of the agent, see
 * merryman/mood.ts), the balance, and the three things you can do next. The
 * market table moved to Explore → Markets; the leaderboard is a teaser of
 * three that opens Explore → Leaders.
 *
 * For somebody with no agent he is the invitation: dress one, then create it.
 */
export function Home({
  agents,
  theses,
  mine,
  onAgent,
  onDeposit,
  onDesk,
  onGroupChat,
  onCreate,
  onWardrobe,
  onLeaders,
  onResign,
  hasAgent,
  phase,
  read,
  retired = null,
  retiredAgents = [],
}: {
  tokens?: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  mine: LiveMine | null;
  tokenTab?: TokenTab;
  onTokenTab?: (tab: TokenTab) => void;
  onToken?: (id: string) => void;
  onAgent: (slug: string) => void;
  onDeposit: () => void;
  onSearch?: () => void;
  onDesk: () => void;
  /**
   * Opens the group chat. A CALLBACK, like every other way off this screen,
   * and not a next/link: Home renders in node tests, where a Link falls back to
   * requestIdleCallback on a global only a browser has (`self`). Optional, so a
   * caller with no room — and every existing test — is unaffected.
   */
  onGroupChat?: () => void;
  /** Where "Create your merryman" goes. Callbacks, for the reason above. */
  onCreate?: () => void;
  onWardrobe?: () => void;
  onLeaders?: () => void;
  /** The renewal, when his bubble says the pass is running out. */
  onResign?: () => void;
  /**
   * Has the SERVER said this owner has an agent?
   *
   * Deliberately NOT `!!mine`. `mine` is falsy while the account is still
   * loading as well as when there is genuinely no agent, so a card gated on
   * it appears late, on top of whatever the reader had already started.
   */
  hasAgent: boolean;
  /** What the shell knows before `mine` exists: still reading, failed, signed out. */
  phase?: Exclude<MoodInput["phase"], "agent">;
  /** Whether the leaderboard READ landed — quiet and unreadable are different. */
  read: import("../live").ReadState;
  /** Accounts the board folded into a count. See Board. */
  retired?: number | null;
  retiredAgents?: import("../live").RetiredAgent[];
}) {
  // The phone's way into the group chat. Hidden only on an install that said
  // it has no room (self-hosted answers 404), never merely while unknown.
  const room = useGroupChatSupported();
  const eq = mine?.equity ?? null;
  const recovery = pausedRecovery(mine?.recovery);
  const chg = recovery ? null : mine?.chg24 ?? null;
  // WAS `money(eq).replace("$", "").split(".")`, and both halves of that were
  // English-shaped. The symbol is a SUFFIX in Spanish, Vietnamese, Russian and
  // Indonesian so the replace missed it, and the decimal mark is a COMMA in
  // most of the shipped languages so the split returned the whole figure as
  // `whole` and nothing as `frac` — a balance with its cents silently dropped
  // and a stray symbol left in front of it.
  const { lead, fraction, trail } = usdParts(eq);
  const mood = moodOf(
    mine
      ? { phase: "agent", autonomy: mine.autonomy, recovery: recovery !== null }
      : { phase: phase ?? (hasAgent ? "loading" : "no-agent") },
  );
  // HIS LOOK: the owner's own choice for their agent, or the one being dressed
  // before an agent exists. Seeded on the slug otherwise, like every other
  // merryman on the board.
  const outfitId = mine?.slug ?? DRAFT;
  const { outfit } = useOutfit(outfitId, mine?.slug ?? mine?.name ?? DRAFT);
  const name = mine?.name ?? "Your merryman";
  const renew = mine && (mine.autonomy.rule === "expired" || mine.autonomy.expiresSoon) && !recovery && onResign;

  return (
    <div className="home-page">
      <header className="top home-overview">
        <div className="home-heading"><h1 className="top-title">Home</h1>{room && onGroupChat && <button type="button" className="icon-btn" aria-label="Group chat" title="Group chat" onClick={onGroupChat}><MessagesSquare size={22} strokeWidth={1.8} aria-hidden="true"/></button>}</div>

        <MerrymanHero outfit={outfit} mood={mood} name={name} moves={mine?.moves}>
          {mine ? (
            <>
              <button type="button" className="hero" onClick={onDesk}>
                <span className="mm-hero-name">{mine.name}</span>
                <span className="home-balance-label">{recovery ? "Last recorded portfolio" : "Portfolio balance"}</span>
                <div className="balance">
                  {lead}
                  {fraction !== null && <sup>{fraction}</sup>}
                  {trail}
                </div>
                {chg !== null && (
                  <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
                    {/* The sign is this product's own — U+2212, not a hyphen, so
                        it reads as a minus in the monospace column. The figure and
                        its symbol are the locale's. */}
                    {chg < 0 ? "−" : "+"}
                    {usd(Math.abs(chg))} today
                  </p>
                )}
              </button>
              <div className="mm-actions">
                {renew ? (
                  <button type="button" className="mm-action primary" onClick={onResign}><Sparkles size={18} aria-hidden="true"/> Renew his pass</button>
                ) : (
                  <button type="button" className="mm-action primary" onClick={onDeposit}><Plus size={18} aria-hidden="true"/> Add money</button>
                )}
                <button type="button" className="mm-action" onClick={onDesk}><MessageCircle size={18} aria-hidden="true"/> Talk</button>
                {onWardrobe && <button type="button" className="mm-action" onClick={onWardrobe}><Shirt size={18} aria-hidden="true"/> Dress</button>}
              </div>
            </>
          ) : hasAgent ? (
            // AN OWNER WHOSE NUMBERS HAVE NOT LANDED is not a newcomer: no
            // invitation to create what they already have. The account card
            // above Home says what is loading or failed, with its retry.
            <div className="hero empty">
              <h2>{phase === "failed" ? "Can't reach your merryman's numbers right now." : "Fetching your merryman's numbers…"}</h2>
              <p>{phase === "failed" ? "Nothing has changed with your agent or your money; this page will try again." : "One moment."}</p>
            </div>
          ) : (
            <>
              <div className="hero empty">
                <h2>Meet your merryman.</h2>
                <p>He trades for you inside limits you set, explains every move, and stops the moment you say so. Start with pretend money — no risk.</p>
              </div>
              <div className="mm-actions">
                <button type="button" className="mm-action primary" onClick={onCreate ?? onDeposit}><Sparkles size={18} aria-hidden="true"/> Create your merryman</button>
                {onWardrobe && <button type="button" className="mm-action" onClick={onWardrobe}><Shirt size={18} aria-hidden="true"/> Dress him first</button>}
              </div>
            </>
          )}
        </MerrymanHero>

        {mine && <Link className="owner-trades-link" href="/agent#trades">
          <ChartNoAxesCombined size={20} aria-hidden="true"/>
          <span><strong>Trades &amp; P&amp;L</strong></span>
          <ArrowUpRight size={18} aria-hidden="true"/>
        </Link>}
        {mine && (
          <PerformanceChart
            balance values={mine.history ?? []}
            height={56}
          />
        )}
      </header>

      {/* WHAT IS CONNECTED, AND WHAT IS NOT.

          Telegram and Trencher both live behind collapsed drawers in a
          long settings form, and both produced stuck testers rather than mere
          inconvenience. A reading, not a second set of controls: it says what
          the settings say and links to them. It renders nothing for a visitor
          with no agent, who has no bot to connect and no strategy to run. */}
      <AgentStrip hasAgent={hasAgent} recovery={mine?.recovery} funds={mine?.recoveryFunds} agentDown={mine?.agentDown}/>

      {/*
        THE LEADERBOARD, NOT A SECOND COPY OF IT — and on Home only a taste of
        it. Mounted rather than reimplemented on purpose: Board carries the
        unreadable-vs-quiet distinction through ReadEmpty, and honesty.test.ts
        pins that by reading Board.tsx. The full board is Explore → Leaders.
      */}
      <section className="home-leaders-teaser" aria-label="Top merrymen">
        <Board
          preview
          read={read}
          retired={retired}
          retiredAgents={retiredAgents}
          agents={agents}
          theses={theses}
          mine={mine}
          onProfile={onAgent}
          onDesk={onCreate ?? onDeposit}
        />
        {onLeaders && <button type="button" className="home-show-more" onClick={onLeaders}><Trophy size={16} aria-hidden="true"/> See the whole leaderboard in Explore</button>}
      </section>
    </div>
  );
}
