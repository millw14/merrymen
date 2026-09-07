/**
 * HOW MANY WALLETS LIKED EACH POST ON THE FEED.
 *
 * A SEPARATE ROUTE FROM `/api/likes`, AND THAT IS THE POINT. Counts are the
 * same for every reader; "what have I liked" is different for every reader.
 * Folding them together would put a session read inside a cacheable response —
 * the failure `/api/theses` spends its whole header warning about, where "the
 * security property of this file is an absence" and any `tenantOf` appearing in
 * it or in what it calls turns every cache above into a leak.
 *
 * So the property here is the same absence: no `tenantOf`, no session, no
 * hosted branch, no per-caller anything. `LikeStore.counts()` takes post ids
 * and no tenant BY SIGNATURE, so this route cannot become per-caller by an
 * edit that forgets.
 *
 * IT ASKS ABOUT THE POSTS ON THE FEED, and that is a correctness fix rather
 * than an optimisation. The first version answered "the 500 most-liked posts of
 * all time", which an adversarial review took apart three ways:
 *
 *   - `post_likes` never expires and the feed window is 24 hours, so the ranked
 *     set drifts away from the displayed set permanently. Today's post, with
 *     one like, loses to a fortnight of accumulated ids.
 *   - A truncated-out post was ABSENT from the map, and both readers treat
 *     absence as zero — so a partial read rendered as "nobody liked this", with
 *     the response still claiming it had been read. That is the house rule
 *     inverted, on the route whose own catch block exists to honour it.
 *   - A post id is validated for SHAPE and deliberately not for existence, so a
 *     few hundred minted wallets liking fabricated ids could have taken every
 *     slot in a publicly cached response and emptied the Top pill for everyone.
 *
 * Asking by id closes all three: the ids come from the feed, every one of them
 * is answered (zero included), and a fabricated id crowds out nothing because
 * nobody asks about it.
 *
 * `readTheses` IS THE RIGHT SOURCE FOR THEM. It is the same session-free reader
 * `/api/theses` uses, so the ids here are exactly the ids the browser is
 * rendering, and calling it keeps this route free of any per-caller input.
 *
 * A COUNT IS NOT A RANKING OF ANYTHING BUT A FEED. `follow-store.ts` states the
 * rule these numbers inherit: display it, never sort an agent's world by it,
 * never let an agent read it — "the moment a number here can move an agent's
 * decision, minting wallets becomes a way to move somebody else's money". The
 * only consumer of this route is the browser's Top pill.
 */
import { NextResponse } from "next/server";
import { getLikeStore } from "@/lib/like-store";
import { readTheses } from "@/lib/read-theses";

export const runtime = "nodejs";
/**
 * Dynamic, with a short shared cache above it.
 *
 * NOT `revalidate` — that is an opt-in to BUILD-TIME prerendering, and there is
 * no DATABASE_URL inside the image build, so the baked body would be an empty
 * object served to every first visitor after every deploy. `/api/theses`
 * learned that the expensive way and wrote it down.
 */
export const dynamic = "force-dynamic";

export interface LikeCountsResponse {
  /**
   * post id → how many distinct wallets liked it, for every post on the feed.
   *
   * A post on the feed is always present, zero included. Absent means the post
   * is not in the current window — never "nobody liked it".
   */
  counts: Record<string, number>;
  /** False when the store could not be read — NOT "nobody has liked anything". */
  read: boolean;
}

export async function GET() {
  try {
    // Session-free, and the same read the public feed serves.
    const { theses } = await readTheses();
    const ids = theses.map((t) => t.postId).filter((id): id is string => !!id);
    const counts = await getLikeStore().counts(ids);
    return NextResponse.json({ counts, read: true } satisfies LikeCountsResponse, {
      headers: { "Cache-Control": "public, max-age=10, s-maxage=20, stale-while-revalidate=60" },
    });
  } catch {
    // AN UNREADABLE STORE IS NOT AN EMPTY ONE. Zero everywhere would render as
    // "nobody liked anything", and the Top pill would silently sort by nothing.
    return NextResponse.json({ counts: {}, read: false } satisfies LikeCountsResponse, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
