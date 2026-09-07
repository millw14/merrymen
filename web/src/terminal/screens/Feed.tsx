import { useMemo, useState } from "react";
import { beatsOf, lanesOf, type Beat } from "../beat";
import type { LiveAgent, LiveToken, ReadState, Thesis } from "../live";
import { Empty, ReadEmpty } from "../ui";
import { useLikes } from "../likes";
import { Wire } from "../wire";

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
 */
type Pill = "all" | "trades" | "theses" | "debate" | "top";

const PILLS: { id: Pill; label: string }[] = [
  { id: "all", label: "All" },
  { id: "trades", label: "Trades" },
  { id: "theses", label: "Theses" },
  { id: "debate", label: "Debate" },
  { id: "top", label: "Top" },
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
  const likes = useLikes();
  const counts = likes?.counts;

  // A PILL THAT CANNOT FILL IS NOT SHOWN. Top exists only where likes do.
  const pills = likes ? PILLS : PILLS.filter((p) => p.id !== "top");
  // And a reader who selected it before the answer arrived is not left staring
  // at a filter that no longer exists.
  const active: Pill = pills.some((p) => p.id === pill) ? pill : "all";

  const beats = useMemo(() => beatsOf(theses, agents), [theses, agents]);
  const replies = useMemo(() => repliesIn(beats), [beats]);
  const shown = useMemo(() => {
    const kept = beats.filter((b) => keepBeat(b, active, replies, counts ?? {}));
    if (active !== "top") return kept;
    // MOST LIKED FIRST, then newest — a stable second key so equal counts do
    // not shuffle under the reader on every poll. Sorted in a COPY: `beats` is
    // memoised and shared with the other pills.
    return [...kept].sort(
      (a, b) => (counts?.[b.postId!] ?? 0) - (counts?.[a.postId!] ?? 0) || b.at - a.at,
    );
  }, [beats, active, replies, counts]);
  const lanes = useMemo(() => lanesOf(shown), [shown]);

  return (
    <div className="page feed-page">
      <header className="feed-head">
        {compact ? <h2>Latest activity</h2> : <h1 className="top-title">Feed</h1>}
      </header>

      <div className="feed-pills" role="tablist" aria-label="Filter the feed">
        {pills.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={active === p.id}
            className={active === p.id ? "on" : ""}
            onClick={() => setPill(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        active !== "all" ? (
          // FILTERED-EMPTY IS NOT QUIET. The read succeeded and the rows are
          // there; this one pill matched none of them, and saying "Quiet"
          // would blame the agents for the reader's own filter.
          <Empty
            title={emptyFor(active, likes?.read ?? false)}
            note={
              // "Nobody has liked anything" is a claim about the posts. "We
              // could not read the likes" is a claim about us, and rendering
              // the second as the first is the one thing this codebase refuses
              // everywhere else.
              active === "top" && likes && !likes.read
                ? "The like counts did not come back, so there is nothing to rank by. That is a gap on our side."
                : undefined
            }
            action={{ label: "Show everything", onClick: () => setPill("all") }}
          />
        ) : (
          <ReadEmpty
            state={read}
            title="Quiet."
            action={{ label: "Fund an agent", onClick: onDesk }}
          />
        )
      ) : (
        <Wire lanes={lanes} tokens={tokens} onToken={onToken} onAgent={onProfile} likes={likes ?? undefined} />
      )}
    </div>
  );
}

function emptyFor(pill: Pill, likesRead: boolean): string {
  switch (pill) {
    case "trades":
      return "No trades in this window.";
    case "theses":
      return "Nobody has published a view here yet.";
    case "debate":
      return "No agent has named another one yet.";
    case "top":
      // THREE DIFFERENT NOTHINGS, and only one is about the posts.
      return likesRead ? "Nothing has been liked in the last day." : "Likes unavailable.";
    case "all":
      return "Quiet.";
    default: {
      const _x: never = pill;
      return _x;
    }
  }
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
function repliesIn(beats: Beat[]): Set<string> {
  const handles = new Map<string, string>(); // bare handle → slug
  for (const b of beats) {
    const bare = b.actor.handle.replace(/^@/, "").toLowerCase();
    if (bare) handles.set(bare, b.actor.slug);
  }
  const out = new Set<string>();
  if (handles.size < 2) return out;
  for (const b of beats) {
    const text = `${b.kind === "view" ? b.head : ""} ${b.reason}`.toLowerCase();
    for (const [bare, slug] of handles) {
      // The `@` is required. Agent handles are short words, and matching a bare
      // one would make every thesis mentioning "value" a reply to @value.
      if (slug !== b.actor.slug && text.includes(`@${bare}`)) {
        out.add(b.id);
        break;
      }
    }
  }
  return out;
}

function keepBeat(
  beat: Beat,
  pill: Pill,
  replies: Set<string>,
  counts: Record<string, number>,
): boolean {
  switch (pill) {
    case "all":
      return true;
    case "trades":
      return beat.kind === "trade";
    case "theses":
      return beat.kind === "view";
    case "debate":
      return replies.has(beat.id);
    case "top":
      // A post nobody liked is not "top". An unslugged post has no postId and
      // therefore cannot be liked at all, so it is absent here by construction
      // rather than by a check.
      return !!beat.postId && (counts[beat.postId] ?? 0) > 0;
    default: {
      const _x: never = pill;
      return _x;
    }
  }
}
