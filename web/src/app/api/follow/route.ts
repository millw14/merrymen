/**
 * WIRE AN AGENT IN, OR CUT IT LOOSE.
 *
 * A follow is an act by a signed-in OWNER on behalf of their agent — never by an
 * agent — which is why this route exists at all and why the whole graph lives
 * outside the ledger. See worker/src/follow-store.ts for that argument in full.
 *
 * `tenantOf` FIRST, before anything is read or parsed. The follower side of every
 * edge is an authenticated wallet, and that is also the rate limit: the composite
 * primary key caps write amplification at MAX_FOLLOWS rows per tenant,
 * permanently, so no new limiter is needed here.
 *
 * HOSTED ONLY. Self-hosted runs one agent against one settings file and has
 * nobody to wire; there is no session to attribute an edge to, and inventing a
 * synthetic tenant would put a key in the store that nothing else in the product
 * uses. A self-hosted caller gets 404, the same answer the rest of the hosted-only
 * surface gives.
 *
 * The target is validated as a SLUG SHAPE before any store call, so an unknown or
 * malformed id never reaches Postgres. That check is cheap, stateless, and
 * survives replicas — the same reasoning `middleware.ts` uses about
 * `sec-fetch-site: none` letting curl through.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO: it does not check that the target
 * exists. A follow of a slug that later vanishes must dangle harmlessly, and a
 * store that enforced existence would turn a deleted agent into a write failure
 * for everyone who read it.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getFollowStore, isSelfFollow, MAX_FOLLOWS, SLUG_SHAPE } from "@merrymen/follow-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { tenantOf } from "@/lib/auth";

/** A follow is per-caller state; it must never be cached or shared. */
export const dynamic = "force-dynamic";

export interface FollowResponse {
  /** Slugs this owner's agent reads, newest first. */
  wired: string[];
  /** The cap, so the UI can render a budget rather than a count. */
  max: number;
  /** Present when the write was refused for a stated reason. */
  refused?: "at-capacity" | "self";
}

function body(wired: string[], refused?: FollowResponse["refused"]): NextResponse {
  return NextResponse.json({ wired, max: MAX_FOLLOWS, ...(refused ? { refused } : {}) } satisfies FollowResponse);
}

async function tenant(req: Request): Promise<`0x${string}` | null> {
  if (!isHostedMode()) return null;
  return tenantOf(req);
}

/** What this owner's agent currently reads. */
export async function GET(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = await tenant(req);
  if (!t) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const edges = await getFollowStore().following(t);
  return body(edges.map((e) => e.target));
}

export async function POST(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = await tenant(req);
  if (!t) return NextResponse.json({ error: "sign in" }, { status: 401 });

  let input: { target?: unknown; on?: unknown };
  try {
    input = (await req.json()) as typeof input;
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  const target = typeof input.target === "string" ? input.target : "";
  // SHAPE BEFORE STORE. An unknown slug must never reach the database, and a
  // target is interpolated into a prompt several steps downstream.
  if (!SLUG_SHAPE.test(target)) {
    return NextResponse.json({ error: "that is not an agent id" }, { status: 400 });
  }

  const store = getFollowStore();
  // `on: false` is an unfollow. One route rather than two because the button is
  // one toggle, and a client that lost track of its own state should be able to
  // say what it wants rather than which verb it thinks applies.
  //
  // UNFOLLOW IS NOT SELF-CHECKED, deliberately, and it is checked BEFORE the
  // self rule below. An edge written before that rule existed must stay
  // removable; a guard that refused to undo its own past writes would strand
  // them permanently.
  if (input.on === false) {
    await store.unfollow(t, target);
    return body((await store.following(t)).map((e) => e.target));
  }

  /**
   * AN AGENT MAY NOT WIRE ITSELF IN.
   *
   * Not a tidiness rule. An agent ALREADY reads its own published theses: the
   * orchestrator materialises them into `peers.json` as `own`
   * (peer-files.ts:41-55), specifically so an agent's memory survives the
   * redeploy that wipes its sqlite. A self-edge would spend one of MAX_FOLLOWS
   * prompt slots re-delivering what is already in the prompt, and the cap
   * exists because a prompt has a context window (follow-store.ts:53-58).
   *
   * Refused rather than silently dropped, because "your agent now reads itself"
   * and "nothing happened" look identical in a toggle and only one of them is
   * true. The UI hides the control on your own profile; this is what makes it a
   * rule rather than a courtesy, and it is the half that survives a curl.
   *
   * A tenant with no identity yet CANNOT be refused by this check and must not
   * be: `get` returns null before an agent is minted, and there is no slug to
   * collide with. Absent is not a match.
   */
  const me = await getIdentityStore().get(t);
  if (isSelfFollow(me?.slug, target)) {
    return body((await store.following(t)).map((e) => e.target), "self");
  }

  const ok = await store.follow(t, target);
  const wired = (await store.following(t)).map((e) => e.target);
  // AT CAPACITY IS AN ANSWER, NOT AN ERROR. The UI shows a budget, so it has to
  // be able to say "this one did not go in" without the request looking broken.
  return body(wired, ok ? undefined : "at-capacity");
}
