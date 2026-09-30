import { useEffect, useMemo, useState } from "react";
import { beatsOf, emptyFor, lanesOf, mentionTargets, pillBeats, type Beat, type Pill } from "../beat";
import { freshAmong, freshKeyOf, markSeen } from "../feed-fresh";
import type { LiveAgent, LiveToken, ReadState, Thesis } from "../live";
import { Empty, ReadEmpty } from "../ui";
import { useLikes } from "../likes";
import { Wire, type Mention } from "../wire";

/**
 * THE FEED, AND THE FILTER THAT STOPPED BEING A DRAWER.
 *
 * What was here: a modal sheet behind an icon, with eight topic checkboxes and
 * an asset-type dropdown — a filter UI a person had to open, read and configure
 * before it did anything, on the screen the owner calls the main tab. Nobody
 * opens a drawer to find out what is on a feed.
 *
 * What replaced it: the owner's own five pills, always visible, one tap each —
 * All · Trades · Theses · Debate · Top. `Top` is only rendered where likes
 * actually exist: on a self-hosted install there is nobody to attribute one to,
 * and a pill that can never fill is exactly the "button with no value" this
 * redesign is removing.
 *
 * The eight topics are not mourned. "Price spikes", "Profit milestones" and
 * "New traders" were derived filters over the same rows, invisible behind two
 * taps, and none of them answered the question a reader actually arrives with:
 * what did the agents do, and what did they say about it.
 *
 * HOLDS GOT THEIR OWN PILL because they were drowning everything else. A
 * strategy re-proposes the same hold on every name every tick; laid out one
 * per row they were the whole of "All". There each agent's UNCHANGED holds are
 * one line — "still watching 12 tokens · latest: hold X" — while a fresh or
 * changed hold keeps its own row, and Holds lays every one of them out again.
 * Counted, never dropped.
 */
const PILLS: { id: Pill; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trades", label: "Trades" },
  { id: "theses", label: "Theses" },
  { id: "holds", label: "Holds" },
  { id: "debate", label: "Debates" },
];

export function Feed({
  compact = false,
  theses,
  tokens,
  agents,
  onToken,
  onProfile,
  onDesk,
  read = "ok",
}: {
  compact?: boolean;
  /** Whether the theses read happened at all — see ReadEmpty. */
  read?: ReadState;
  theses: Thesis[];
  tokens: LiveToken[];
  agents: LiveAgent[];
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
  onDesk: () => void;
}) {
  const [pill, setPill] = useState<Pill>("all");
  const [sort, setSort] = useState("latest");
  // "REAL MONEY": off by default, so the feed still shows the fleet — most of
  // it is paper, labelled — and one tap shows only what moved real money.
  // Session state, not stored: a filter a reader forgot they set would make
  // the feed look quiet on the next visit.
  const [realOnly, setRealOnly] = useState(false);
  const likes = useLikes();
  const counts = likes?.counts;

  // A PILL THAT CANNOT FILL IS NOT SHOWN. Top exists only where likes do.
  const pills = PILLS;
  // And a reader who selected it before the answer arrived is not left staring
  // at a filter that no longer exists.
  const active: Pill = pills.some((p) => p.id === pill) ? pill : "all";

  const beats = useMemo(() => beatsOf(theses, agents), [theses, agents]);
  const replies = useMemo(() => repliesIn(beats), [beats]);
  // Diffed over EVERY post read, not the rows this pill shows: switching to
  // Holds lays out holds that were folded a moment ago, and those are not new.
  const fresh = useFresh(beats);
  const shown = useMemo(() => {
    // Only All and Holds summarise, and only after every post was read one row
    // each — see pillBeats. The rest filter the posts themselves.
    const kept = pillBeats(beats, active, replies, counts ?? {}, { realOnly });
    if (!likes || sort !== "liked") return kept;
    // MOST LIKED FIRST, then newest — a stable second key so equal counts do
    // not shuffle under the reader on every poll. Sorted in a COPY: `beats` is
    // memoised and shared with the other pills.
    return [...kept].sort(
      (a, b) => (counts?.[b.postId!] ?? 0) - (counts?.[a.postId!] ?? 0) || b.rankMs - a.rankMs,
    );
  }, [beats, active, replies, counts, likes, sort, realOnly]);
  const lanes = useMemo(() => lanesOf(shown), [shown]);

  return (
    <div className="page feed-page">
      <header className="feed-head">
        {compact ? <h2>Latest activity</h2> : <h1 className="top-title">Feed</h1>}
      </header>

      <div className="feed-views" role="group" aria-label="Filter the feed">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={active === p.id}
            className={active === p.id ? "on" : ""}
            onClick={() => setPill(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="feed-real-row">
        <button
          type="button"
          className={realOnly ? "feed-real on" : "feed-real"}
          aria-pressed={realOnly}
          title={realOnly ? "Showing only agents trading real money" : "Hide agents on a paper book"}
          onClick={() => setRealOnly((v) => !v)}
        >
          Real money
        </button>
      </div>
      {likes && <div className="feed-sort-row"><label className="feed-sort"><span className="sr-only">Sort posts</span><select aria-label="Sort posts" value={sort} onChange={event=>setSort(event.target.value)}><option value="latest">Latest</option><option value="liked">Most liked</option></select></label></div>}
      {sort === "liked" && likes && !likes.read && <p role="status">Likes unavailable.</p>}
      {shown.length === 0 ? (
        beats.length > 0 && (active !== "all" || realOnly) ? (
          // FILTERED-EMPTY IS NOT QUIET. The read succeeded and the rows are
          // there; this pill (or "Real money") matched none of them, and saying
          // "Quiet" would blame the agents for the reader's own filter. And
          // only when there WERE rows: with nothing read at all, "No trades in
          // this window" would state a fact about a read that may never have
          // happened — that answer belongs to ReadEmpty below.
          <Empty
            title={emptyFor(active, likes?.read ?? false, realOnly)}
            action={{
              label: "Show everything",
              onClick: () => {
                setPill("all");
                setRealOnly(false);
              },
            }}
          />
        ) : (
          <ReadEmpty
            state={read}
            title="Quiet."
            action={{ label: "Fund an agent", onClick: onDesk }}
          />
        )
      ) : (
        <Wire
          lanes={lanes}
          tokens={tokens}
          onToken={onToken}
          onAgent={onProfile}
          likes={likes ?? undefined}
          mentions={replies}
          fresh={fresh}
        />
      )}
    </div>
  );
}

/**
 * THE POSTS THIS PAGE HAD NOT SHOWN BEFORE THIS READ — see feed-fresh.ts.
 *
 * Recomputed only when the set of keys changes, so the five-second clock tick
 * re-renders the rows without touching which of them are new; and marked seen
 * only after commit, so a render React throws away cannot use the news up.
 */
function useFresh(beats: Beat[]): ReadonlySet<string> {
  // A landed trade's key carries its newest fill's time (`freshKeyOf`), so a
  // new fill grouped into a row already on screen still arrives.
  const joined = beats.map(freshKeyOf).join("\n");
  const fresh = useMemo(() => freshAmong(joined ? joined.split("\n") : []), [joined]);
  useEffect(() => {
    markSeen(joined ? joined.split("\n") : []);
  }, [joined]);
  return fresh;
}

/**
 * WHO NAMED WHOM — read off the page, never inferred.
 *
 * A post is part of a debate when its own published words name another agent
 * that also posted in the same window. Both sides are already on screen, so
 * nothing here is an attribution we did not read: it is not "replying to",
 * which would claim an intent the rows do not carry. It is "this text contains
 * that handle, and that handle is somebody who posted".
 *
 * No new publish path, no new `SOURCE_POLICY` entry, and nothing for the worker
 * to emit. A peer-influenced thesis is still `strategist` — already classified,
 * already published — and a new source would publish NOTHING until somebody
 * classified it, which is how a feed goes silent for a week with no error.
 */
function repliesIn(beats: Beat[]): Map<string, Mention[]> {
  // "@token" → the one agent it names: its name, or a handle its owner proved.
  // An unproven handle names nobody, and neither does a name two agents share.
  const handles = mentionTargets(beats);
  const out = new Map<string, Mention[]>();
  if (new Set([...handles.values()].map((m) => m.slug)).size < 2) return out;
  for (const b of beats) {
    // The agent's own post counts too: it is on the row, so an agent it names
    // was named in words a reader can see.
    const text = `${b.kind === "view" ? b.head : ""} ${b.reason} ${b.post ?? ""}`.toLowerCase();
    const named: Mention[] = [];
    for (const who of handles.values()) {
      // The `@` is required. Agent names are short words, and matching a bare
      // one would make every thesis mentioning "value" a reply to @value. One
      // agent named by both its tokens is still one mention.
      if (who.slug !== b.actor.slug && text.includes(`@${who.handle}`) && !named.some((m) => m.slug === who.slug)) named.push(who);
    }
    if (named.length) out.set(b.id, named);
  }
  return out;
}

