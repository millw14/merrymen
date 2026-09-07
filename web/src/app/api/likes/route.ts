/**
 * LIKE A POST, OR TAKE IT BACK.
 *
 * Copied from `/api/follow` deliberately, down to the order of the checks: a
 * like is the same shape of act — a signed-in OWNER doing something on behalf
 * of nobody but themselves — and the follow route's reasoning about why
 * `tenantOf` comes first, why the shape check comes before the store, and why
 * the target's existence is NOT checked, all transfer unchanged.
 *
 * WHAT IS PER-CALLER HERE. This route answers "what have I liked", which is
 * different for every reader, so it is `force-dynamic` and never cached. The
 * COUNTS — the same for everybody — are a separate route, `/api/like-counts`,
 * which is session-free by signature so it can be cached without becoming a
 * leak. Folding them together would put a session read in a cacheable response,
 * which is the exact failure `/api/theses` spends its header warning about.
 *
 * `tenantOf` IS THE RATE LIMIT. The composite primary key plus MAX_LIKES caps
 * write amplification per wallet permanently, so no new limiter is needed —
 * the same argument the follow store makes about its own cap.
 *
 * HOSTED ONLY. Self-hosted is one operator against one settings file; there is
 * nobody for a like to be attributed to, and a synthetic tenant would put a key
 * in the store nothing else uses. 404, like the rest of the hosted-only surface.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { getLikeStore, MAX_LIKES } from "@/lib/like-store";
import { POST_ID_SHAPE } from "@/lib/post-id";

/** A like is per-caller state; it must never be cached or shared. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface LikesResponse {
  /** Post ids this wallet has liked. */
  liked: string[];
  /**
   * WHETHER A LIKE COULD BE STORED AT ALL, said explicitly.
   *
   * The read below answers 200 with an empty list for a signed-OUT visitor,
   * because "you have liked nothing" is true and complete and does not deserve
   * an error banner on a working feed. But an empty list is then ambiguous —
   * signed in and liked nothing looks identical — and a client inferring
   * "signed in" from the 200 renders an enabled button that 401s on click.
   * That is a button with no value, which is the exact thing this whole
   * redesign is about. So the answer says which.
   */
  signedIn: boolean;
  /**
   * AN UNREADABLE STORE IS NOT A SIGNED-OUT READER.
   *
   * The counts route has carried this flag from the start; this one did not,
   * and an adversarial review found what that costs. A store failure gave the
   * client nothing to distinguish, so it left `signedIn` at its initial false,
   * which disabled the button and titled it "Sign in to like posts" — telling
   * a reader who signed in five minutes ago that they are signed out. That is
   * worse than showing a zero: it is a false claim about them, with a remedy
   * that cannot work.
   *
   * `signedIn` stays TRUE in that case, because it is true — the session was
   * read successfully; it is the store that would not answer.
   */
  read: boolean;
  max: number;
  /** Present when the write was refused for a stated reason. */
  refused?: "at-capacity";
}

function body(
  liked: string[],
  signedIn: boolean,
  read: boolean,
  refused?: LikesResponse["refused"],
): NextResponse {
  return NextResponse.json(
    { liked, signedIn, read, max: MAX_LIKES, ...(refused ? { refused } : {}) } satisfies LikesResponse,
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = tenantOf(req);
  // Nothing to read is a complete answer, so it counts as read.
  if (!t) return body([], false, true);
  try {
    return body(await getLikeStore().liked(t), true, true);
  } catch {
    // 200 rather than 500 on purpose: the client can only act on the
    // distinction if it can see the body.
    return body([], true, false);
  }
}

export async function POST(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = tenantOf(req);
  if (!t) return NextResponse.json({ error: "sign in" }, { status: 401 });

  let input: { postId?: unknown; on?: unknown };
  try {
    input = (await req.json()) as typeof input;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const postId = typeof input.postId === "string" ? input.postId : "";
  // SHAPE BEFORE STORE. An id that is not one must never reach the database —
  // cheap, stateless, and it survives replicas.
  if (!POST_ID_SHAPE.test(postId)) {
    return NextResponse.json({ error: "that is not a post" }, { status: 400 });
  }

  const store = getLikeStore();
  // `on: false` is an unlike. One route rather than two, because the button is
  // one toggle and a client that lost track of its own state should be able to
  // say what it wants rather than which verb it thinks applies.
  // A WRITE THAT FAILS SAYS SO. Reported as `read: false` rather than a 500 so
  // the client can put the number back where it was and say why, instead of
  // leaving an optimistic +1 standing over a like that was never stored.
  try {
    if (input.on === false) {
      await store.unlike(t, postId);
      return body(await store.liked(t), true, true);
    }
    const ok = await store.like(t, postId);
    return body(await store.liked(t), true, true, ok ? undefined : "at-capacity");
  } catch {
    return body([], true, false);
  }
}
