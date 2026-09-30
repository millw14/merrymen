import { compactUsd } from "@/lib/format";
import { sayOf } from "@/lib/post-line";
import { xProfileUrl } from "@/lib/x-handle";
import {
  callFigure,
  callFigureText,
  cameToNothing,
  dealSizeOf,
  livePriceOf,
  pillOf,
  tokenFor,
  verbOf,
  watchCount,
  whenLabel,
  whoOf,
  type Actor,
  type ChorusBeat,
  type Lane,
  type Mention,
  type TradeBeat,
  type ViewBeat,
  type WatchBeat,
} from "./beat";
import { useNow } from "./clock";
import { isFresh } from "./feed-fresh";
import { money, type LiveToken } from "./live";
import { Coin, Face, FaceOn } from "./ui";

/**
 * The coin a row is about, for its logo and its link: the same one its price
 * is read from (beat.ts `tokenFor`), by address, never by a ticker a
 * deployer chose. It picked the first ticker match — "a wrong logo is
 * cosmetic" — but the row's click opens that token, so a memecoin named TSLA
 * sent a reader of an agent's TSLA trade to somebody else's coin.
 */
function logoOf(tokens: LiveToken[], symbol: string | null): LiveToken | undefined {
  return tokenFor(tokens, symbol) ?? undefined;
}

/**
 * THE AGENT'S LINE, AND THE REASON BEHIND "WHY" — for a summary row, which
 * leads with its latest member's words (lib/post-line.ts). The expander is a
 * SIBLING of `wire-hit`, never inside that <button>.
 */
function SaidWhy({ say, why, post, who }: { say: string | null; why: string | null; post: boolean; who?: string }) {
  return (
    <>
      {say ? (
        <p className={post ? "wire-why wire-post" : "wire-why"}>
          {who ? (
            <>
              <b>{who}</b>:{" "}
            </>
          ) : null}
          {say}
        </p>
      ) : null}
      {why ? (
        <details className="wire-more">
          <summary>why</summary>
          <p className="wire-why">{why}</p>
        </details>
      ) : null}
    </>
  );
}

/**
 * What a reader has done with a post, and what everybody else has.
 *
 * PASSED IN RATHER THAN FETCHED HERE. The two halves come from two routes on
 * purpose — `mine` is per-caller and uncacheable, `counts` is the same for
 * everyone and cached — and they are merged once per page in `likes.ts`, not
 * once per feed. Two feeds mount at a time on desktop.
 */
export type Likes = import("./likes").LikesView;

/** An agent this post's own words named — built in beat.ts, where it is tested. */
export type { Mention } from "./beat";

export function Wire({
  lanes,
  tokens,
  onToken,
  onAgent,
  likes,
  mentions,
  fresh,
}: {
  lanes: Lane[];
  tokens: LiveToken[];
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
  likes?: Likes;
  /**
   * beat id → the handles this post's own words name, when they belong to
   * agents that also posted in the window. A FACT WE READ, not an inference:
   * see `repliesIn`.
   */
  mentions?: Map<string, Mention[]>;
  /**
   * Keys of the posts this page had not shown before this read — see
   * feed-fresh.ts. Those rows slide in. Absent, nothing moves.
   */
  fresh?: ReadonlySet<string>;
}) {
  // FIVE SECONDS, so an age reads "12s" and then "17s" rather than sitting on
  // "now" for a minute (clock.ts). Thirty made a fresh row look stale on
  // arrival — the rail ticked slower than the posts it was showing.
  const now = useNow(5_000);
  return (
    <div className="wire">
      {lanes.map((lane) => {
        switch (lane.kind) {
          case "lull":
            return <div key={lane.id} className="wire-lull" aria-hidden />;
          case "beat": {
            const isNew = isFresh(lane.beat, fresh);
            if (lane.beat.kind === "watch") {
              return (
                <WatchRow key={lane.id} beat={lane.beat} tokens={tokens} now={now} onAgent={onAgent} isNew={isNew} />
              );
            }
            if (lane.beat.kind === "chorus") {
              return (
                <ChorusRow key={lane.id} beat={lane.beat} tokens={tokens} now={now} onToken={onToken} onAgent={onAgent} isNew={isNew} />
              );
            }
            return (
              <BeatRow
                key={lane.id}
                beat={lane.beat}
                tokens={tokens}
                now={now}
                onToken={onToken}
                onAgent={onAgent}
                likes={likes}
                mentions={mentions?.get(lane.beat.id)}
                isNew={isNew}
              />
            );
          }
          default: {
            const _x: never = lane;
            return _x;
          }
        }
      })}
    </div>
  );
}

/**
 * ONE AGENT'S UNCHANGED HOLDS, AS ONE LINE — "still watching 12 tokens ·
 * latest: hold X".
 *
 * The latest hold is carried in full, reason and all, so the line still says
 * what the agent concluded most recently; the rest are a count, and the Holds
 * pill lays them out. No like control: a summary is not a post.
 */
function WatchRow({
  beat,
  tokens,
  now,
  onAgent,
  isNew,
}: {
  beat: WatchBeat;
  tokens: LiveToken[];
  now: number;
  onAgent?: (slug: string) => void;
  isNew: boolean;
}) {
  const latest = beat.latest;
  const tok = logoOf(tokens, latest.symbol);
  const actor = beat.actor;
  const open = () => onAgent?.(actor.slug);
  // The agent's own line when the latest hold has one, and the reason behind
  // "why" — the same pair the member's own row shows.
  const { say, why } = sayOf({ post: latest.post, reason: latest.reason });
  const lead = say && say !== latest.head ? say : null;
  return (
    <div className={`wire-beat view watch${isNew ? " wire-new" : ""}`}>
      <button type="button" className="wire-mark" onClick={open}>
        <FaceOn name={actor.name} slug={actor.slug} symbol={latest.symbol ?? ""} logo={tok?.logo ?? ""} />
      </button>
      <div className="wire-body">
        <button type="button" className="wire-hit" onClick={open}>
          <span className="wire-said">
            <span className="wire-line">
              <strong>{whoOf(beat)}</strong> is still watching {watchCount(beat)} · latest:{" "}
              {latest.head}{" "}
              {latest.paper && <i className="tag unsettled">paper</i>}{" "}
              <em className="wire-when">{whenLabel(beat, now)}</em>
            </span>
          </span>
        </button>
        <OwnerLine actor={actor} />
        <SaidWhy say={lead} why={why && why !== latest.head ? why : null} post={!!latest.post} />
      </div>
    </div>
  );
}

/**
 * WHO OWNS THE AGENT, under the row it heads — and only when it was proven.
 *
 * The row is headed by the agent's name. The owner's X handle is typed by the
 * owner and nothing checks it, so an unproven one is not printed here at all:
 * `actor.owner` is null unless the owner posted our nonce from that account.
 * A sibling of `wire-hit`, never a child — a link inside a button is invalid.
 */
function OwnerLine({ actor }: { actor: Actor }) {
  const href = actor.owner ? xProfileUrl(actor.owner) : null;
  if (!actor.owner || !href) return null;
  return (
    <p className="owned">
      {"owned by "}
      <a href={href} target="_blank" rel="noreferrer noopener" className="owner-x">
        {actor.owner}
      </a>
      <i className="owner-ok" title="This X account was proven by its owner">
        {" ✓"}
      </i>
    </p>
  );
}

/**
 * THE COIN, BY NAME — the id in the tooltip.
 *
 * "T3139F043B88" is `T` plus eleven hex of the contract: what everything
 * prices and settles against, and nothing a reader can use. The name is what
 * is printed; the id is one hover away for anybody reconciling against the
 * ledger, and it is the only thing printed when there is no name.
 */
function Named({ beat }: { beat: { label: string | null; symbol: string | null } }) {
  const shown = beat.label ?? beat.symbol ?? "";
  return <span title={beat.symbol && beat.symbol !== shown ? beat.symbol : undefined}>{shown}</span>;
}

/**
 * A stack of the faces in a chorus, the coin on top. Lives here rather than in
 * ui.tsx because this row is its only caller; the `.stack .faces` rules it
 * draws with never left the sheet.
 */
function FacesOn({ actors, symbol, logo }: { actors: ChorusBeat["actors"]; symbol: string; logo: string }) {
  return (
    <span className="stack">
      <span className="faces">
        {actors.slice(0, 3).map((a) => (
          <Face key={a.slug} name={a.name} slug={a.slug} />
        ))}
      </span>
      <span className="stack-badge">
        <Coin symbol={symbol} logo={logo} />
      </span>
    </span>
  );
}

/**
 * SEVERAL AGENTS, ONE HOLD — "TSLA · 5 agents holding".
 *
 * Every agent in it is named and clickable, because a count nobody can check
 * is just a number. The words shown are the latest member's own, attributed to
 * them: the others said the same thing with different figures, and printing
 * one sentence as everybody's would put numbers in mouths that did not say them.
 */
function ChorusRow({
  beat,
  tokens,
  now,
  onToken,
  onAgent,
  isNew,
}: {
  beat: ChorusBeat;
  tokens: LiveToken[];
  now: number;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
  isNew: boolean;
}) {
  const tok = logoOf(tokens, beat.symbol);
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else onAgent?.(beat.latest.actor.slug);
  };
  const paper = beat.members.filter((m) => m.paper).length;
  // Still the latest member's OWN words, attributed to them — its post when it
  // wrote one, and then the reason behind "why": the reason is the sentence
  // the crowd was grouped on (`chorusOf`), and no other row shows it.
  const { say, why } = sayOf({ post: beat.latest.post, reason: beat.latest.reason });
  return (
    <div className={`wire-beat view chorus${isNew ? " wire-new" : ""}`}>
      <button type="button" className="wire-mark" onClick={open}>
        <FacesOn actors={beat.actors} symbol={beat.symbol} logo={tok?.logo ?? ""} />
      </button>
      <div className="wire-body">
        <button type="button" className="wire-hit" onClick={open}>
          <span className="wire-said">
            <span className="wire-line">
              <strong><Named beat={beat} /></strong> · {beat.actors.length} agents holding{" "}
              {paper > 0 && <i className="tag unsettled">{paper} on paper</i>}{" "}
              <em className="wire-when">{whenLabel(beat, now)}</em>
            </span>
          </span>
        </button>
        <SaidWhy say={say} why={why} post={!!beat.latest.post} who={beat.latest.actor.name} />
        <p className="wire-mentions">
          {beat.actors.map((a, i) => (
            <span key={a.slug}>
              {i > 0 ? ", " : ""}
              <button type="button" onClick={() => onAgent?.(a.slug)}>
                {a.name}
              </button>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

function BeatRow({
  beat,
  tokens,
  now,
  onToken,
  onAgent,
  likes,
  mentions,
  isNew,
}: {
  beat: TradeBeat | ViewBeat;
  tokens: LiveToken[];
  now: number;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
  likes?: Likes;
  mentions?: Mention[];
  isNew: boolean;
}) {
  const tok = logoOf(tokens, beat.symbol);
  const actor = beat.actor;
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else if (onAgent) onAgent(actor.slug);
  };

  /*
   * THE ACCENT MEANS MONEY MOVED, so a trade that did not move any must not
   * wear it. The class came from `action` alone, so a refused buy kept
   * `.buy` and its green inset bar — the row said "tried to buy" in words and
   * "bought" in colour, with the dollar figure beside it, which is the same
   * claim the words were fixed to stop making. The `.view` rule below already
   * spells the principle out: "the buy/sell accents mean money moved, and the
   * whole point of this arm is that none did."
   *
   * Added ALONGSIDE the action class rather than replacing it, so anything
   * keying off buy/sell still works and only the accent is neutralised.
   */
  const turned = beat.kind === "trade" && cameToNothing(beat);
  // THE AMBER AND THE BYLINE COME FROM THE ROW. They were keyed on the
  // author's current strategy, so a TSLA hold from an agent that has since
  // switched to Trencher read "Trench thesis". The badge alone still speaks
  // for the agent's current mode, and its title says that is what it means.
  const cls = [
    "wire-beat",
    beat.kind === "trade" ? beat.action : "view",
    turned ? "turned" : "",
    beat.trench ? "is-trencher" : "",
    isNew ? "wire-new" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // THE LINE THE ROW LEADS WITH: the agent's own post when it wrote one, our
  // reason otherwise — and the reason, when a post took the lead, behind "why"
  // (lib/post-line.ts). A view whose head IS its reasoning must not print it
  // twice, whichever slot it would land in.
  const { say, why } = sayOf({ post: beat.post, reason: beat.reason });
  const echo = (s: string | null) => beat.kind === "view" && s === beat.head;
  const lead = say && !echo(say) ? say : null;
  const more = why && !echo(why) ? why : null;

  // THE CALL'S OWN NUMBER, where the token's 24h change used to sit — see
  // `callFigure`. Null whenever an input was not read, and then nothing is
  // printed at all.
  const figure = callFigure(beat, livePriceOf(tokens, beat.symbol));
  const shown = figure ? callFigureText(figure) : null;
  const pill = beat.kind === "trade" ? pillOf(beat) : null;
  // Never a size beside a realized percent whose dollars were withheld.
  const size = dealSizeOf(beat);

  return (
    <div className={cls}>
      <button type="button" className="wire-mark" onClick={open}>
        <FaceOn name={actor.name} slug={actor.slug} symbol={beat.symbol ?? ""} logo={tok?.logo ?? ""} />
      </button>
      <div className="wire-body">
        {beat.trench && <div className="trench-byline">{actor.trencher && <span className="trench-badge" title="This agent currently uses Trencher mode">Trencher</span>}<span>{beat.kind === "view" ? "Trench thesis" : "Trench trade"}</span></div>}
        <button type="button" className="wire-hit" onClick={open}>
          <span className="wire-said">
            <span className="wire-line">
              {/* TWO SENTENCES, BUILT TWO DIFFERENT WAYS, and the difference is
                  the point. A trade has a direction the rail may conjugate. A
                  view does not, so it prints what the PUBLISHER wrote — which
                  is where the conditional already lives, and the only string
                  that knows whether anything could have happened. */}
              <strong>{whoOf(beat)}</strong>{" "}
              {beat.kind === "trade" ? (
                <>
                  {verbOf(beat)} <Named beat={beat} />{" "}
                </>
              ) : (
                <>{beat.head} </>
              )}
              {/* THE FILL WAS REAL; THE MONEY WAS NOT.
                  "In the feed it says I've bought things but nothing shows in
                  my portfolio" — both halves true, because the fill landed on
                  a paper book and the portfolio reads the funded one. Every
                  other surface in the app marks this; the rail was the one
                  that printed the sentence and stopped. Beside the sentence
                  rather than inside the verb: "bought" is not the wrong word,
                  the conclusion a reader draws from it is. */}
              {beat.paper && <i className="tag unsettled">paper</i>}{" "}
              {/* WHY IT DID NOT HAPPEN, where the claim was made.
                  `verbOf` now says "tried to buy" rather than "bought" for a
                  refused, reverted or dropped row — but "tried" without the
                  reason invites the reader to blame the agent, when the
                  commonest reason by far is a limit they set themselves ("past
                  today's spending cap"). The publisher already writes the
                  sentence; the rail just never showed it. */}
              {beat.kind === "trade" && beat.outcomeText && cameToNothing(beat) && (
                <i className="wire-refused">— {beat.outcomeText}</i>
              )}{" "}
              {/* "×24 · since 2h" for a view that has only been repeated, or a
                  refusal that has: its newest copy is not news, and printing
                  its age as "now" is what kept a scheduled hold looking like
                  fresh activity. */}
              <em className="wire-when">{whenLabel(beat, now)}</em>
            </span>
          </span>
        </button>
        <OwnerLine actor={actor} />

        {/* The take, when it adds something the line did not already say. */}
        {lead ? <p className={beat.post ? "wire-why wire-post" : "wire-why"}>{lead}</p> : null}
        {/* A SIBLING OF `wire-hit`, like the like control below: a <details>
            inside that <button> would be interactive content inside a button. */}
        {more ? (
          <details className="wire-more">
            <summary>why</summary>
            <p className="wire-why">{more}</p>
          </details>
        ) : null}

        {beat.symbol ? (
          <div className="wire-parts">
            <button type="button" className="wire-part" onClick={open}>
              <span className="wire-seat">
                <Coin symbol={beat.symbol} logo={tok?.logo ?? ""} />
                <Named beat={beat} />
              </span>
              <span className="wire-part-fig">
                {/* "[Buy] $5.00 at $3.1M MC" — the pill says whether money
                    moved (`pillOf`), the size is what the decision named, and
                    the market cap is the one recorded AT DECISION TIME, shown
                    only when it was. */}
                {pill || size != null ? (
                  <span className="wire-deal">
                    {pill ? (
                      <span className={`wire-pill ${pill.tone}${pill.unsettled ? " unsettled" : ""}`}>{pill.label}</span>
                    ) : null}
                    {size != null ? <b>{money(size)}</b> : null}
                    {beat.kind === "trade" && beat.mcapUsd !== null ? (
                      <small className="wire-mc">at {compactUsd(beat.mcapUsd)} MC</small>
                    ) : null}
                  </span>
                ) : null}
                {shown && figure ? (
                  <span className={`wire-call ${shown.tone}`}>
                    {shown.pct} <small>{figure.basis}</small>
                    {shown.usd ? <b className="wire-call-usd">{shown.usd}</b> : null}
                  </span>
                ) : null}
              </span>
            </button>
          </div>
        ) : null}

        {/* "MENTIONS", NEVER "REPLYING TO". One is a fact about the words on
            this post; the other is an intent the rows do not carry and we did
            not read. The named agent is on the same page, so a reader can go
            and check — which is the only reason this is safe to render at all. */}
        {mentions?.length ? (
          <p className="wire-mentions">
            mentions{" "}
            {mentions.map((m, i) => (
              <span key={m.slug}>
                {i > 0 ? ", " : ""}
                <button type="button" onClick={() => onAgent?.(m.slug)}>
                  {m.name}
                </button>
              </span>
            ))}
          </p>
        ) : null}

        {/* A SIBLING OF `wire-hit`, never a child. That element is a <button>,
            and a button inside a button is invalid HTML: browsers recover by
            hoisting it out of the DOM you wrote, so the layout silently differs
            from the source and the inner control's activation is undefined. */}
        {likes && beat.postId ? <LikeButton postId={beat.postId} likes={likes} /> : null}
      </div>
    </div>
  );
}

function LikeButton({ postId, likes }: { postId: string; likes: Likes }) {
  const on = likes.mine.has(postId);
  const n = likes.counts[postId] ?? 0;
  const can = likes.onLike !== null;
  return (
    <div className="wire-acts">
      <button
        type="button"
        className={`wire-like${on ? " on" : ""}`}
        aria-pressed={on}
        // SIGNED OUT IS NOT BROKEN, AND NEITHER IS THE SAME AS DOWN. The button
        // stays visible and says which it is, because a control that disappears
        // teaches nobody why — and one that says "sign in" to somebody who is
        // signed in sends them to a remedy that cannot work.
        title={
          !likes.mineRead
            ? "Likes could not be loaded just now"
            : can
              ? on
                ? "Remove your like"
                : "Like this post"
              : "Sign in to like posts"
        }
        onClick={() => likes.onLike?.(postId, !on)}
        disabled={!can}
      >
        <Heart filled={on} />
        {/* NO NUMBER WHEN WE DID NOT ASK. A zero here would be a claim about
            the post; the absence is a claim about our read, and the two must
            not render the same. */}
        {likes.read && n > 0 ? <span className="mono">{n}</span> : null}
      </button>
    </div>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.9" aria-hidden>
      <path d="M12 20s-7-4.35-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 4.65-7 9-7 9z" />
    </svg>
  );
}


