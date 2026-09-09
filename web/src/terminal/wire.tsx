import { verbOf, whoOf, type Beat, type Lane } from "./beat";
import { elapsed, useNow } from "./clock";
import { money, type LiveToken } from "./live";
import { Coin, Delta, FaceOn } from "./ui";

function logoOf(tokens: LiveToken[], symbol: string | null): LiveToken | undefined {
  if (!symbol) return undefined;
  return tokens.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase());
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

/** An agent this post's own words named, and where to go to read them. */
export interface Mention {
  /** Bare, no leading "@" — the renderer adds it. */
  handle: string;
  slug: string;
}

export function Wire({
  lanes,
  tokens,
  onToken,
  onAgent,
  likes,
  mentions,
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
}) {
  const now = useNow(30_000);
  return (
    <div className="wire">
      {lanes.map((lane) => {
        switch (lane.kind) {
          case "lull":
            return <div key={lane.id} className="wire-lull" aria-hidden />;
          case "beat": {
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

function BeatRow({
  beat,
  tokens,
  now,
  onToken,
  onAgent,
  likes,
  mentions,
}: {
  beat: Beat;
  tokens: LiveToken[];
  now: number;
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
  likes?: Likes;
  mentions?: Mention[];
}) {
  const tok = logoOf(tokens, beat.symbol);
  const actor = beat.actor;
  const open = () => {
    if (tok && onToken) onToken(tok.id);
    else if (onAgent) onAgent(actor.slug);
  };

  const cls = ["wire-beat", beat.kind === "trade" ? beat.action : "view"].join(" ");

  return (
    <div className={cls}>
      <button type="button" className="wire-mark" onClick={open}>
        <FaceOn name={actor.name} slug={actor.slug} symbol={beat.symbol ?? ""} logo={tok?.logo ?? ""} />
      </button>
      <div className="wire-body">
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
                  {verbOf(beat)} {beat.symbol}{" "}
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
              {beat.kind === "trade" &&
                beat.outcomeText &&
                (beat.outcome === "refused" ||
                  beat.outcome === "reverted" ||
                  beat.outcome === "dropped") && (
                  <i className="wire-refused">— {beat.outcomeText}</i>
                )}{" "}
              <em className="wire-when">{whenOf(beat.at, now)}</em>
            </span>
          </span>
        </button>

        {/* The take, when it adds something the line did not already say. A
            view whose head IS its reasoning must not print it twice. */}
        {beat.reason && (beat.kind === "trade" || beat.reason !== beat.head) ? (
          <p className="wire-why">{beat.reason}</p>
        ) : null}

        {beat.symbol ? (
          <div className="wire-parts">
            <button type="button" className="wire-part" onClick={open}>
              <span className="wire-seat">
                <Coin symbol={beat.symbol} logo={tok?.logo ?? ""} />
                {beat.symbol}
              </span>
              <span className="wire-part-fig">
                {beat.sizeUsd != null ? <b>{money(beat.sizeUsd)}</b> : null}
                <Delta value={tok?.change24hPct ?? null} suffix="%" size={11} />
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
                  @{m.handle}
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

function whenOf(at: number, now: number): string {
  const age = elapsed(at, now);
  switch (age.unit) {
    case "s":
      return "now";
    case "m":
    case "h":
    case "d":
      return age.text;
    default: {
      const _x: never = age.unit;
      return _x;
    }
  }
}
