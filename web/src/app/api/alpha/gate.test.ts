/**
 * THE FIRST LOCK IN THIS PRODUCT, AND THE FIRST HOUSE-WIDE SCAN FOR THE COLUMN
 * IT WOULD BE MOST TEMPTING TO PUT BEHIND IT.
 *
 * Two separate jobs, in one file because they are the same mistake at two
 * distances: publishing something that was never ours to publish.
 *
 * The gate. A lock is a control, and a control that does not control anything
 * is worse than none — it makes everybody downstream reason as though something
 * were protected. So these tests are about the three ways this one could be
 * hollow: it could gate on something self-declared, it could ship the body to a
 * locked reader and hide it with CSS, or it could turn a failed read into an
 * accusation about the reader's wallet.
 *
 * The scan. `thesis.test.ts` already forbids `signals_json` — the owner's whole
 * balance sheet — but it reads ONE hard-coded path, `api/theses/route.ts`. A
 * new route selecting that column passes every test in this repo today, and
 * ALPHA is precisely the kind of route somebody would reach for it from
 * ("Brain's research is richer"). The guard lands before the temptation.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROUTE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

/**
 * Comments stripped.
 *
 * This route's header argues at length about what it is NOT — it names the site
 * password, `holderAddress` and the `mmk_` token in order to refuse them — and a
 * raw scan would flag the very paragraph warning people off each one. The same
 * trap `privy-boundary.test.ts` names, and the same idiom.
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(ROUTE);

describe("what the gate reads", () => {
  it("A SERVER-VERIFIED WALLET, and nothing self-declared", () => {
    // tenantOf recovers an address from a signature the server checked and
    // carries it in an HMAC-signed httpOnly cookie. Everything below is a
    // string somebody typed.
    assert.match(CODE, /tenantOf\(req\)/);
    assert.ok(!/holderAddress/.test(CODE), "settings.holderAddress is self-declared, not proof");
    assert.ok(!/sitePassword|site-gate|siteGate/.test(CODE), "the site password is a doorknob, not a lock");
    assert.ok(!/mmk_|gatewayToken/.test(CODE), "a bearer token this service cannot verify is not an identity");
    // And it must not fall through to /api/circle's file read.
    assert.ok(!/homePaths|readFile/.test(CODE), "a local settings file says nothing about this caller");
  });

  it("the tier is DERIVED from a balance on every request, never stored as a yes", () => {
    // A cached boolean outlives the holding it was derived from: sell, and the
    // door stays open for the life of the memo. Caching the BALANCE and
    // re-deriving means a seller loses access with nothing to invalidate.
    assert.match(CODE, /tierForBalance\(raw\)/);
    assert.match(CODE, /balances = new Map<string, \{ at: number; raw: bigint \}>/);
    assert.ok(!/allowed|isHolder|hasAccess/.test(CODE), "cache the balance, not the verdict");
  });

  it("hosted mode is what makes it a gate at all", () => {
    // Self-hosted has one operator, one settings file and no session to
    // attribute a holding to. Gating there would lock an owner out of their own
    // install; NOT branching on it would leave the hosted lock keyed on a
    // session that self-hosted never sets.
    const hosted = CODE.indexOf("isHostedMode()");
    const tenant = CODE.indexOf("tenantOf(req)");
    assert.ok(hosted > 0 && tenant > hosted, "the hosted check comes first");
  });
});

describe("it fails closed, and it says which way", () => {
  it("THREE REASONS, NOT ONE", () => {
    // "Sign in", "hold some" and "we could not check" have three different next
    // steps, and only two of them are about the reader.
    for (const why of ['"sign-in"', '"balance"', '"unreachable"']) {
      assert.ok(CODE.includes(`locked(${why}`), `no caller produces ${why}`);
    }
  });

  it("AN RPC OUTAGE IS NEVER RENDERED AS 'YOU DO NOT HOLD ENOUGH'", () => {
    // The one that costs a reader money: told they hold too little, they go and
    // buy more to fix a problem that is ours. So `unreachable` must come from
    // the catch — a fact about our read — and never from the tier comparison.
    const cat = CODE.indexOf("} catch {");
    const unreachable = CODE.indexOf('locked("unreachable"');
    const outsider = CODE.indexOf('tier.id === "outsider"');
    assert.ok(cat > 0 && unreachable > cat, "the unreachable answer belongs to the catch");
    assert.ok(outsider > unreachable, "and the balance answer is only reached once the read succeeded");
  });

  it("a read that throws does not fall through to the open desk", () => {
    // `raw` is declared before the try and assigned inside it, so TypeScript
    // itself refuses a path that reaches tierForBalance without a successful
    // read. Pinned because widening the catch to `raw = 0n` would compile.
    assert.match(CODE, /let raw: bigint;/);
    assert.ok(!/raw = 0n/.test(CODE), "a failed read must not fabricate a zero balance");
  });
});

describe("the teaser", () => {
  it("OMITS THE BODY FROM THE PAYLOAD, not from the stylesheet", () => {
    // A CSS blur leaves the text in the DOM, in view-source and in the network
    // tab. The locked answer carries counts and the price of entry; there is
    // nothing to un-blur because nothing was sent.
    const fn = CODE.slice(CODE.indexOf("function locked("), CODE.indexOf("function open("));
    assert.ok(fn.length > 0, "the locked responder must exist");
    for (const leak of ["payload.rows", "alpha.passed.map", "verdict", "research", "reason"]) {
      assert.ok(!fn.includes(leak), `the locked payload must not carry ${leak}`);
    }
    assert.match(fn, /picks: counts\.picks/, "counts are the honest advertisement");
  });

  it("and its copy comes from the tier table, not from a hand-typed promise", () => {
    // token.ts:1-17 forbids price, returns, buybacks and burns in any copy
    // rendering these tiers. Reading CIRCLE_TIERS means that stance cannot
    // drift out of one screen.
    assert.match(CODE, /ENTRY_TIER = CIRCLE_TIERS\.find/);
    assert.match(CODE, /perks: ENTRY_TIER\.perks/);
  });
});

describe("the response is per-caller and must never be shared", () => {
  it("force-dynamic AND private, no-store", () => {
    // Either alone is not enough: force-dynamic stops Next caching it, and the
    // header is what stops a CDN or a browser handing one holder's desk to the
    // next visitor on the same connection.
    assert.match(CODE, /export const dynamic = "force-dynamic"/);
    assert.equal(
      (CODE.match(/"Cache-Control": "private, no-store"/g) ?? []).length,
      2,
      "both the locked and the open answer need it",
    );
  });
});

describe("what the lock is actually over", () => {
  it("NOT A COPY OF THE PUBLIC PAYLOAD", () => {
    // /api/discoveries serves the same rows to anybody, and that is deliberate:
    // the verdict on a listed coin is what makes the coins page worth loading.
    // So the gated half has to be something else, or the lock is decoration
    // that makes everyone downstream reason as though something were protected.
    assert.match(CODE, /sharedAlpha\(\)/, "the working, not the payload reader");
    assert.match(CODE, /alpha\.passed/, "what the scout was shown and turned down");
    assert.match(CODE, /alpha\.research/, "and what was read before it decided");
  });

  it("and the public route did not quietly gain it", () => {
    const pub = codeOf(readFileSync(new URL("../discoveries/route.ts", import.meta.url), "utf8"));
    assert.match(pub, /sharedRead\(\)/);
    assert.ok(!/sharedAlpha/.test(pub), "the extras are not reachable over the public route");
    assert.ok(!/tenantOf/.test(pub), "and it stays session-free, or every cache above it leaks");
  });

  it("`researched` is a fact about the pass, never a null on every coin", () => {
    // The browser is configured per SERVICE, so "no site research ran" is never
    // a statement about one coin — rendered per card it would read as thirty
    // coins that failed a check nobody ran.
    assert.match(CODE, /researched: alpha\.research !== null/);
  });
});

/**
 * ── THE HOUSE-WIDE SCAN ──────────────────────────────────────────────────
 *
 * `signals_json` is the owner's entire balance sheet — positions, sizes, model
 * spend. `worker/src/peer-theses.ts` calls it "THE COLUMN TO KEEP OUT". The
 * strongest guarantee in the design is an absence: it is not filtered out of a
 * response, it is never fetched.
 *
 * The existing guard reads one path. This one walks every route in the app, so
 * the guarantee survives the next route somebody adds.
 */
function everyRoute(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) everyRoute(full, out);
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

describe("no HTTP route may select the owner's balance sheet", () => {
  // `import.meta.dirname`, not a URL: this repo lives under a path with a space
  // in it, and `new URL(..).pathname` hands readdirSync a percent-encoded name
  // that does not exist. The scan then finds nothing and passes forever, which
  // is the exact silent-pass this suite's first case is here to catch.
  const routes = everyRoute(join(import.meta.dirname, ".."));

  it("finds the routes at all — a scan over nothing passes silently", () => {
    // The failure mode of every source-reading test: a wrong path returns an
    // empty list and the assertion below is vacuously true forever.
    assert.ok(routes.length > 10, `expected the api tree, found ${routes.length} routes`);
    assert.ok(routes.some((r) => r.includes("theses")), "the route the original guard watched");
    assert.ok(routes.some((r) => r.includes("alpha")), "and this one");
  });

  it("SIGNALS_JSON IS NEVER SELECTED, anywhere under api/", () => {
    const offenders = routes.filter((r) => /signals_json/.test(codeOf(readFileSync(r, "utf8"))));
    assert.deepEqual(offenders, [], `these routes select the owner's balance sheet: ${offenders.join(", ")}`);
  });
});
