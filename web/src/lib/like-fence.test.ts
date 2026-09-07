/**
 * THE ONE NUMBER IN THIS PRODUCT A SYBIL CAN MINT.
 *
 * `worker/src/follow-store.ts` wrote the rule this file enforces, about
 * `followerCount`: *"Display it if you like; NEVER sort by it, and NEVER let an
 * agent read it. The moment a number here can move an agent's decision, minting
 * wallets becomes a way to move somebody else's money."*
 *
 * A like is that number, cheaper. A follow costs a slot in a prompt and is
 * capped at 8; a like costs nothing and there are as many wallets as anybody
 * cares to make. If a like count could reach a strategist prompt, buying
 * somebody else's agent's attention would cost the price of some gas.
 *
 * THE FENCE IS A SHAPE, NOT A RULE. Three structural facts, each pinned below:
 *
 *   1. The store lives under `web/src`, which the worker cannot import.
 *   2. `PublicThesis` — the object `peer-theses.ts` materialises into the file
 *      an agent's desk reads — has no post id and no count, so the peer path
 *      produces nothing a like could be keyed to.
 *   3. Counts never travel on `/api/theses`. They are a separate, session-free
 *      route, merged in the browser.
 *
 * None of these is a check somebody has to keep getting right. Each is an
 * import that would not resolve or a field that does not exist.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKER = join(ROOT, "worker", "src");

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("nothing an agent runs can see a like", () => {
  const files = walk(WORKER);

  it("finds the worker tree at all — a scan over nothing passes silently", () => {
    // The failure mode of every source-reading test, and the reason the ALPHA
    // route's guard carries the same assertion.
    assert.ok(files.length > 50, `expected worker/src, found ${files.length} files`);
    assert.ok(files.some((f) => f.endsWith("thesis-policy.ts")), "the publication gate must be in the scan");
    assert.ok(files.some((f) => f.endsWith("peer-theses.ts")), "and the peer materialiser");
  });

  it("NO FILE UNDER worker/src MENTIONS A LIKE, A POST ID, OR THE TABLE", () => {
    // Deliberately narrow tokens rather than the word "like", which appears in
    // ordinary prose ("likely", "alike", "would like to"). These are the names
    // that would only exist if the fence had been crossed.
    const banned = /\blike-store\b|\bgetLikeStore\b|\bpost_likes\b|\bpostId\b|\blikeCount\b|\bpostIdOf\b/;
    const offenders = files.filter((f) => banned.test(codeOf(readFileSync(f, "utf8"))));
    assert.deepEqual(offenders.map((f) => f.slice(ROOT.length)), [], "likes must not exist in the agent path");
  });

  it("and the store is somewhere the worker structurally cannot import from", () => {
    // `imports.test.ts` forbids every file under worker/src from alias-importing
    // @merrymen/*, and web/src is not aliased inward at all — so an import of
    // this module from the worker would not resolve, in tsc or at runtime.
    const store = join(ROOT, "web", "src", "lib", "like-store.ts");
    assert.ok(statSync(store).isFile(), "the like store lives under web/src, not worker/src");
    const guard = codeOf(readFileSync(join(WORKER, "imports.test.ts"), "utf8"));
    assert.match(guard, /@merrymen\\?\//, "the worker's alias ban is what makes this structural");
  });
});

describe("the published post carries no number", () => {
  it("`PublicThesis` HAS NO postId AND NO LIKES FIELD", () => {
    // The object peer-theses.ts writes into an agent's peer file. A count here
    // would be one refactor away from a prompt; there is nothing to refactor.
    const policy = readFileSync(join(WORKER, "thesis-policy.ts"), "utf8");
    const iface = policy.slice(policy.indexOf("export interface PublicThesis {"));
    const body = codeOf(iface.slice(0, iface.indexOf("\n}")));
    assert.ok(body.length > 100, "found the interface");
    for (const bad of ["postId", "likes", "likeCount", "liked"]) {
      assert.ok(!new RegExp(`\\b${bad}\\b`).test(body), `PublicThesis must not carry ${bad}`);
    }
  });

  it("the id is attached AFTER the gate, by the web reader", () => {
    const read = codeOf(readFileSync(join(ROOT, "web", "src", "lib", "read-theses.ts"), "utf8"));
    const gate = read.indexOf("publishableThesis(");
    const attach = read.indexOf("postIdOf(");
    assert.ok(gate > 0 && attach > gate, "a post that the gate drops never gets an id");
    assert.match(read, /if \(!post\) return null;/, "and the drop happens before the id is computed");
  });
});

describe("counts never ride on the cacheable public read", () => {
  it("/api/theses stays session-free and count-free", () => {
    const route = codeOf(readFileSync(join(ROOT, "web", "src", "app", "api", "theses", "route.ts"), "utf8"));
    assert.ok(!/tenantOf/.test(route), "a session read here turns every cache above it into a leak");
    assert.ok(!/like/i.test(route.replace(/likeCounts/g, "")), "counts do not travel with the posts");
  });

  it("THE COUNTS ROUTE CANNOT BECOME PER-CALLER BY ACCIDENT", () => {
    // `counts()` takes no tenant BY SIGNATURE, so the route has nothing to pass
    // it even if somebody adds a session read above. The same "the property is
    // an absence" discipline read-theses.ts is built on.
    const store = codeOf(readFileSync(join(ROOT, "web", "src", "lib", "like-store.ts"), "utf8"));
    assert.match(
      store,
      /counts\(postIds: readonly string\[\]\): Promise<Record<string, number>>/,
      "post ids in, no tenant",
    );
    const route = codeOf(
      readFileSync(join(ROOT, "web", "src", "app", "api", "like-counts", "route.ts"), "utf8"),
    );
    assert.ok(!/tenantOf/.test(route), "the counts route must not read a session");
    assert.match(route, /read: false/, "an unreadable store is not an empty one");
  });

  it("IT ANSWERS ABOUT THE FEED, NOT ABOUT THE TABLE", () => {
    // What an adversarial review took apart. `ORDER BY n DESC LIMIT 500` over
    // the whole table answered "the most-liked posts of all time": it drifted
    // away from the 24-hour feed window permanently, its truncation was
    // invisible (absence reads as zero on both consumers), and since a post id
    // is validated for SHAPE and not existence, minted wallets liking
    // fabricated ids could take every slot in a publicly cached response.
    const store = codeOf(readFileSync(join(ROOT, "web", "src", "lib", "like-store.ts"), "utf8"));
    assert.ok(!/ORDER BY n DESC/.test(store), "counts are not a ranking of the table");
    assert.match(store, /WHERE post_id = ANY\(\$1\)/, "asked by id");
    // Every asked-about id answers, zero included, so absence in the result
    // cannot be confused with a post nobody liked.
    assert.match(store, /Object\.fromEntries\(want\.map\(\(id\) => \[id, 0\]\)\)/);
    const route = codeOf(
      readFileSync(join(ROOT, "web", "src", "app", "api", "like-counts", "route.ts"), "utf8"),
    );
    // And the ids come from the same session-free reader the feed serves, so
    // this route still takes no per-caller input.
    assert.match(route, /await readTheses\(\)/);
    assert.match(route, /theses\.map\(\(t\) => t\.postId\)/);
  });

  it("AND A STORE FAILURE IS NEVER REPORTED AS A SIGNED-OUT READER", () => {
    // The other half of the same rule, on the per-caller route. Without a
    // read-failure flag the client left `signedIn` false, which disabled the
    // heart and titled it "Sign in to like posts" — telling somebody who signed
    // in five minutes ago to sign in, for a problem that was never theirs.
    const route = codeOf(readFileSync(join(ROOT, "web", "src", "app", "api", "likes", "route.ts"), "utf8"));
    assert.match(route, /read: boolean;/, "the per-caller route says whether it read");
    assert.match(route, /return body\(\[\], true, false\);/, "signedIn stays TRUE when the store fails");
    const likes = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "likes.ts"), "utf8"));
    assert.match(likes, /if \(j\.read === false\) \{/);
    assert.match(likes, /mineRead: boolean;/);
    const wire = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "wire.tsx"), "utf8"));
    assert.match(wire, /!likes\.mineRead\s*\n?\s*\? "Likes could not be loaded just now"/);
  });

  it("but the per-caller route is never cached", () => {
    const route = codeOf(readFileSync(join(ROOT, "web", "src", "app", "api", "likes", "route.ts"), "utf8"));
    assert.match(route, /export const dynamic = "force-dynamic"/);
    assert.match(route, /"Cache-Control": "private, no-store"/);
    assert.match(route, /tenantOf\(req\)/, "and it is per-caller on purpose");
    // Shape before store, exactly as /api/follow does it — scoped to the
    // WRITE handler, since the read handler legitimately opens the store with
    // no id in hand at all.
    const post = route.slice(route.indexOf("export async function POST("));
    const shape = post.indexOf("POST_ID_SHAPE.test(postId)");
    const store = post.indexOf("getLikeStore()");
    assert.ok(shape > 0 && store > shape, "an id that is not one must never reach the database");
    // And the session comes before the body is even parsed.
    assert.ok(post.indexOf("tenantOf(req)") < post.indexOf("req.json()"), "tenantOf first");
  });
});

describe("the button is where invalid HTML would have put it", () => {
  it("A SIBLING OF wire-hit, NOT A CHILD", () => {
    // `.wire-hit` is a <button>. A button inside a button is invalid: browsers
    // recover by hoisting the inner one out of the DOM you wrote, so the layout
    // silently differs from the source and activation is undefined.
    const wire = readFileSync(join(ROOT, "web", "src", "terminal", "wire.tsx"), "utf8");
    const hitOpen = wire.indexOf('className="wire-hit"');
    const hitClose = wire.indexOf("</button>", hitOpen);
    const like = wire.indexOf("<LikeButton");
    assert.ok(hitOpen > 0 && hitClose > hitOpen && like > hitClose, "the like slot sits after the hit closes");
  });

  it("and a post with no id renders no button at all", () => {
    const wire = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "wire.tsx"), "utf8"));
    assert.match(wire, /likes && beat\.postId \? <LikeButton/);
  });

  it("ONE STORE PER PAGE, NOT ONE PER FEED", () => {
    // Two <Feed>s mount at once on desktop: the tab and the sidebar rail, which
    // stays mounted because `hidden` hides an element without unmounting it.
    // Per-component state meant two polls of every like route and two different
    // answers — a heart filled in the rail and empty in the body, for one post.
    // The same class of bug as the phone mounting AccountEntry twice.
    const feed = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "screens", "Feed.tsx"), "utf8"));
    assert.match(feed, /import \{ useLikes \} from "\.\.\/likes"/);
    assert.ok(!/fetch\("\/api\/like/.test(feed), "a screen must not fetch likes itself");
    const store = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "likes.ts"), "utf8"));
    assert.match(store, /useSyncExternalStore\(subscribe, snapshot, serverSnapshot\)/);
    // And the poll stops when the last feed unmounts, rather than running for
    // the life of the tab on a screen nobody is looking at.
    assert.match(store, /if \(mounted <= 0 && timer !== null\)/);
  });

  it("no count is shown when the count was not read", () => {
    // A zero would be a claim about the post. The absence is a claim about our
    // read, and the two must not render the same — the distinction this whole
    // codebase is built on.
    const wire = codeOf(readFileSync(join(ROOT, "web", "src", "terminal", "wire.tsx"), "utf8"));
    assert.match(wire, /likes\.read && n > 0 \?/);
  });
});
