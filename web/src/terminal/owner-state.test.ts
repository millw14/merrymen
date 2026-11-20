/**
 * A STOPPED OWNER IS NOT A NEWCOMER, AND A NEWCOMER IS NOT A STOPPED OWNER.
 *
 * 2026-11-18: a paper owner stopped his agent for a re-signature and never
 * signed. His feed still named his agent, his book was on file — and Home and
 * Me said "Create your merryman", every other page "Your agent starts here",
 * and his own profile "Private". owner-state.ts names the state once; this
 * runs every arm of it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountState } from "./HostedControls";
import {
  ownerStateOf,
  ownsProfile,
  perpsReadWanted,
  stoppedFigure,
  stoppedOf,
  type OwnerInputs,
} from "./owner-state";

const ME = `0x${"a".repeat(40)}`;
const signedIn = (status: AccountState["status"]): AccountState => ({ session: { hosted: true, address: ME }, status });
const hako = { name: "hako merry", slug: "hako-merry" };
const base: OwnerInputs = {
  account: signedIn({ exists: false, tenant: ME }),
  feed: "ok",
  feedIsOwn: true,
  named: hako,
  perps: "none",
};
const state = (over: Partial<OwnerInputs> = {}) => ownerStateOf({ ...base, ...over });

describe("the owner's state", () => {
  it("a removed record with the session's own identity is stopped, and starts again from /create", () => {
    const s = state();
    assert.equal(s.kind, "stopped-removed");
    assert.deepEqual(stoppedOf(s), {
      name: "hako merry", slug: "hako-merry", stored: false,
      restart: { href: "/create", label: "Start him again" }, profile: "/a/hako-merry",
    });
  });

  it("a record held for a renewal is stopped too, and is renewed at /grant#resign", () => {
    const s = state({ account: signedIn({ exists: false, tenant: ME, stored: true }) });
    assert.equal(s.kind, "stopped-stored");
    assert.deepEqual(stoppedOf(s)?.restart, { href: "/grant#resign", label: "Renew his pass" });
  });

  it("a live grant is live, whatever else is said", () => {
    for (const perps of ["held", "none", "unread", null] as const) {
      assert.equal(state({ account: signedIn({ exists: true, tenant: ME }), perps }).kind, "live");
    }
    assert.equal(state({ account: signedIn({ exists: true, tenant: ME }), feed: "unread", feedIsOwn: false, named: null }).kind, "live");
  });

  it("a Perps-only owner is never told the agent is stopped; a Perps read that failed says nothing either", () => {
    assert.equal(state({ perps: "held" }).kind, "perps-only");
    assert.equal(stoppedOf(state({ perps: "held" })), null);
    assert.equal(state({ perps: "unread" }).kind, "none", "could not tell: what the screens said before");
    assert.equal(state({ perps: null }).kind, "checking", "asked, not answered: claim neither");
  });

  it("a brand-new account has no identity in its feed, and stays a newcomer", () => {
    // The feed's identity for a tenant the identity store has no slug for
    // (feed-identity.ts identityOf): the default name, no slug.
    assert.equal(state({ named: { name: "Robin", slug: null } }).kind, "none");
    assert.equal(state({ named: null }).kind, "none");
  });

  it("a feed for another session names nobody's agent here", () => {
    assert.equal(state({ feedIsOwn: false }).kind, "none");
    assert.equal(state({ feedIsOwn: false, feed: "unreadable" }).kind, "none");
  });

  it("before the feed's first answer, stopped and new look alike: checking", () => {
    assert.equal(state({ feed: "unread", feedIsOwn: false, named: null }).kind, "checking");
  });

  it("signed out, self-hosted, or an account not read yet: nothing to say", () => {
    assert.equal(state({ account: { session: { hosted: true, address: null }, status: { exists: false, tenant: null } } }).kind, "none");
    // Self-hosted: the feed names no slug, and the install's own screens are as they were.
    assert.equal(state({ account: { session: { hosted: false, address: null }, status: { exists: false } } }).kind, "none");
    assert.equal(state({ account: { session: { hosted: false, address: null }, status: { exists: false } }, feed: "unread" }).kind, "none");
    assert.equal(state({ account: null }).kind, "none");
  });

  it("the Perps wallet is asked only where it decides the answer", () => {
    const want = (over: Partial<OwnerInputs> = {}) => perpsReadWanted({ ...base, ...over });
    assert.equal(want(), true);
    assert.equal(want({ account: signedIn({ exists: true, tenant: ME }) }), false, "live");
    assert.equal(want({ feed: "unread" }), false, "the feed decides first");
    assert.equal(want({ feedIsOwn: false }), false);
    assert.equal(want({ named: { name: "Robin", slug: null } }), false, "a newcomer");
    assert.equal(want({ account: { session: { hosted: true, address: null }, status: { exists: false, tenant: null } } }), false, "signed out");
    assert.equal(want({ account: null }), false);
  });
});

describe("whose profile this is", () => {
  it("the session's own agent, live or stopped, from the feed's identity", () => {
    assert.equal(ownsProfile(true, hako, "hako-merry"), true);
    assert.equal(ownsProfile(true, hako, "someone-else"), false, "a stranger's page");
    assert.equal(ownsProfile(false, hako, "hako-merry"), false, "a feed for another session owns nothing here");
    assert.equal(ownsProfile(true, { slug: null }, "hako-merry"), false);
    assert.equal(ownsProfile(true, null, "hako-merry"), false);
  });
});

describe("the stopped card's figure", () => {
  const figures = (over: Record<string, unknown> = {}) => ({
    recentTrades: null, topTrades: null,
    figures: { book: "paper" as const, equityUsdg: 1000, equityAt: Date.UTC(2026, 10, 18, 18, 4) / 1000, held: false, pnlUsdg: 0, pnlAt: null, underReview: false, pnlEstimated: false, ...over },
  });
  it("nothing while the owner's read is out or was refused", () => {
    assert.equal(stoppedFigure(undefined), null);
    assert.equal(stoppedFigure(null), null);
  });
  it("the value with its book and date, paper said once in the label", () => {
    const f = stoppedFigure(figures());
    assert.equal(f?.label, "Paper value");
    assert.equal(f?.value, "$1,000.00");
    assert.match(f?.asOf ?? "", /Nov 18/);
    assert.equal(stoppedFigure(figures({ book: "live" }))?.label, "Value");
    assert.equal(stoppedFigure(figures({ held: true }))?.held, true);
  });
  it("a value nobody could read is a dash, never $0.00", () => {
    assert.deepEqual(stoppedFigure(figures({ equityUsdg: null, equityAt: null })), { label: "Paper value", value: "—", asOf: null, held: false });
    assert.deepEqual(stoppedFigure({ recentTrades: null, topTrades: null, figures: null }), { label: "Value", value: "—", asOf: null, held: false });
  });
});
