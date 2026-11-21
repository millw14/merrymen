/**
 * A STOPPED OWNER IS NOT A NEWCOMER, AND A NEWCOMER IS NOT A STOPPED OWNER.
 *
 * 2026-11-18: a paper owner stopped his agent for a re-signature and never
 * signed. His feed still named his agent, his book was on file — and Home and
 * Me said "Create your merryman", every other page "Your agent starts here",
 * and his own profile "Private". owner-state.ts names the state once; this
 * runs every arm of it, then renders the screens that read it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { AccountState } from "./HostedControls";
import {
  ownBookSlug,
  ownerStateOf,
  ownsProfile,
  perpsReadWanted,
  stoppedFigure,
  stoppedOf,
  type OwnBookRead,
  type OwnerInputs,
  type StoppedOwner,
} from "./owner-state";
import type { ReadState } from "./live";

(globalThis as unknown as { React: typeof React }).React = React;

const ME = `0x${"a".repeat(40)}`;
const signedIn = (status: AccountState["status"]): AccountState => ({ session: { hosted: true, address: ME }, status });
const hako = { name: "hako merry", slug: "hako-merry" };
const paperBook: OwnBookRead = {
  recentTrades: null, topTrades: null,
  figures: { book: "paper", equityUsdg: 1000, equityAt: Date.UTC(2026, 10, 18, 18, 4) / 1000, held: false, pnlUsdg: 0, pnlAt: null, underReview: false, pnlEstimated: false },
};
const base: OwnerInputs = {
  account: signedIn({ exists: false, tenant: ME }),
  feed: "ok",
  feedAnswered: true,
  feedIsOwn: true,
  named: hako,
  book: paperBook,
  perps: "none",
};
const state = (over: Partial<OwnerInputs> = {}) => ownerStateOf({ ...base, ...over });
const held = signedIn({ exists: false, tenant: ME, stored: true });

describe("the owner's state", () => {
  it("a removed record whose book the owner-only read found is stopped, and starts again from /create", () => {
    const s = state();
    assert.equal(s.kind, "stopped-removed");
    assert.deepEqual(stoppedOf(s), {
      name: "hako merry", slug: "hako-merry", stored: false,
      restart: { href: "/create", label: "Start it again" }, profile: "/a/hako-merry",
    });
  });

  it("a record held for a renewal is stopped too, and starts again from /create as well", () => {
    // /create sends a browser holding the saved wallet on to /grant#resign
    // itself; /grant#resign straight away gave a Privy owner on any other
    // browser the owner-key restore form.
    for (const book of [paperBook, null, undefined]) {
      const s = state({ account: held, book });
      assert.equal(s.kind, "stopped-stored", String(book));
      assert.deepEqual(stoppedOf(s)?.restart, { href: "/create", label: "Start it again" });
    }
  });

  it("a Privy newcomer has a slug and no book: a newcomer, not a stopped agent", () => {
    // Every Privy sign-in claims a slug with no accounts (identity-store.ts
    // resolveOrClaimDid), and the feed names it with the default name.
    const robin = { name: "Robin", slug: "y8vq3k2m" };
    assert.equal(state({ named: robin, book: null }).kind, "none", "/own refused: no Spot agent on record");
    assert.equal(stoppedOf(state({ named: robin, book: null })), null);
    assert.equal(state({ named: robin, book: undefined }).kind, "checking", "/own not answered yet: claim neither");
    for (const perps of ["held", "none", "unread", null] as const) {
      assert.equal(state({ named: robin, book: null, perps }).kind, "none", `perps ${perps}`);
    }
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
    // Perps-only with no Spot account on record: /own refuses, whatever Perps says.
    assert.equal(state({ book: null, perps: "held" }).kind, "none");
  });

  it("a Spot record held for a renewal is stopped whatever the Perps wallet holds", () => {
    for (const perps of ["held", "none", "unread", null] as const) {
      assert.equal(state({ account: held, perps }).kind, "stopped-stored", `perps ${perps}`);
    }
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
    assert.equal(state({ feed: "unread", feedAnswered: false, feedIsOwn: false, named: null }).kind, "checking");
  });

  it("a feed that failed before it ever answered: a held record waits, anyone else keeps Create", () => {
    // accountFeedRead says "unreadable" and feedMatchesAccount false for it,
    // exactly as for a feed answered for another session.
    assert.equal(state({ account: held, feed: "unreadable", feedAnswered: false, feedIsOwn: false, named: null }).kind, "checking");
    // A newcomer must not sit on "One moment…" with no Create for an outage.
    assert.equal(state({ account: signedIn({ exists: false, tenant: ME }), feed: "unreadable", feedAnswered: false, feedIsOwn: false, named: null }).kind, "none");
    // Answered for another session: that one is known, and names nobody here.
    assert.equal(state({ feed: "unreadable", feedAnswered: true, feedIsOwn: false }).kind, "none");
  });

  it("signed out, self-hosted, or an account not read yet: nothing to say", () => {
    assert.equal(state({ account: { session: { hosted: true, address: null }, status: { exists: false, tenant: null } } }).kind, "none");
    // Self-hosted: the feed names no slug, and the install's own screens are as they were.
    assert.equal(state({ account: { session: { hosted: false, address: null }, status: { exists: false } } }).kind, "none");
    assert.equal(state({ account: { session: { hosted: false, address: null }, status: { exists: false } }, feed: "unread" }).kind, "none");
    assert.equal(state({ account: null }).kind, "none");
  });

  it("the Perps wallet is asked only where it decides the answer: a removed record with a book", () => {
    const want = (over: Partial<OwnerInputs> = {}) => perpsReadWanted({ ...base, ...over });
    assert.equal(want(), true);
    assert.equal(want({ account: signedIn({ exists: true, tenant: ME }) }), false, "live");
    assert.equal(want({ account: held }), false, "a held record is stopped whatever Perps holds");
    assert.equal(want({ book: null }), false, "no book: a newcomer, and no Perps read for one");
    assert.equal(want({ book: undefined }), false, "the book decides first");
    assert.equal(want({ feed: "unread" }), false, "the feed decides first");
    assert.equal(want({ feedAnswered: false }), false);
    assert.equal(want({ feedIsOwn: false }), false);
    assert.equal(want({ named: { name: "Robin", slug: null } }), false, "no slug");
    assert.equal(want({ account: { session: { hosted: true, address: null }, status: { exists: false, tenant: null } } }), false, "signed out");
    assert.equal(want({ account: null }), false);
  });

  it("the owner's book is asked for the session's own slug, and only while it may be a stopped agent's", () => {
    const slug = (over: Partial<OwnerInputs> = {}) => ownBookSlug({ ...base, ...over });
    assert.equal(slug(), "hako-merry");
    assert.equal(slug({ account: held }), "hako-merry", "a held record's figure");
    assert.equal(slug({ account: signedIn({ exists: true, tenant: ME }) }), null, "live: the desk has its own");
    assert.equal(slug({ feedIsOwn: false }), null, "never a slug from another session's feed");
    assert.equal(slug({ feedAnswered: false }), null);
    assert.equal(slug({ named: { name: "Robin", slug: null } }), null);
    assert.equal(slug({ account: { session: { hosted: false, address: null }, status: { exists: false } } }), null, "self-hosted");
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

// ── the screens ──────────────────────────────────────────────────────────────

const noop = () => {};
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;
const words = (d: Document) => (d.body.textContent ?? "").replace(/\s+/g, " ");
const stopped = (stored = false): StoppedOwner => stoppedOf(state(stored ? { account: held } : {}))!;
const NEWCOMER = /Create your merryman|Your agent starts here|Your merryman lives here|Meet your merryman/;

async function home(props: Record<string, unknown>) {
  const { Home } = await import("./screens/Home");
  return doc(createElement(Home, {
    mine: null, tokens: [], agents: [], theses: [], tokenTab: "buys", read: "ok" as ReadState, hasAgent: false, phase: "no-agent",
    onTokenTab: noop, onToken: noop, onAgent: noop, onDeposit: noop, onSearch: noop, onDesk: noop, onCreate: noop, onWardrobe: noop,
    ...props,
  } as never));
}
async function you(props: Record<string, unknown>) {
  const { You } = await import("./screens/You");
  return doc(createElement(You, {
    mine: null, history: [], stopped: false, perTrade: null, perDay: null, hasAgent: false,
    onLimits: noop, onStop: noop, onDesk: noop, onDeposit: noop, onWithdraw: noop, onCreate: noop,
    ...props,
  } as never));
}
async function entry(props: Record<string, unknown>) {
  const { AccountEntry } = await import("./HostedControls");
  return doc(createElement(AccountEntry, { account: signedIn({ exists: false, tenant: ME }), onRefresh: noop, onSignedIn: noop, ...props } as never));
}
async function header(props: Record<string, unknown>) {
  const { DesktopHeader } = await import("./Desktop");
  const { autonomyOf } = await import("@merrymen/core");
  const mine = { name: "Your agent", slug: null, handle: null, owner: null, equity: null, chg24: null, mode: null, thesis: null, moves: [], glance: { id: "custom", label: "" }, autonomy: autonomyOf({ mode: null, liveBlocker: null }) };
  return doc(createElement(DesktopHeader, { mine, hasAgent: false, onScreen: noop, onTab: noop, ...props } as never));
}

describe("a stopped owner's screens say stopped, with one way back", () => {
  for (const stored of [false, true]) {
    const restart = { href: "/create", label: "Start it again" };
    it(`Home (${stored ? "held for a renewal" : "removed"})`, async () => {
      const d = await home({ stoppedAgent: stopped(stored), stoppedBook: paperBook });
      const text = words(d);
      assert.match(text, /hako merry is stopped/);
      assert.match(text, /It isn't trading\. Its record and profile are kept\./);
      assert.match(text, /Paper value \$1,000\.00 as of Nov 18/);
      assert.doesNotMatch(text, NEWCOMER);
      assert.equal(text.match(/paper/gi)?.length, 1, "paper is said once");
      const restarts = [...d.querySelectorAll("a.mm-action.primary")];
      assert.equal(restarts.length, 1, "one way to restart");
      assert.equal(restarts[0]!.getAttribute("href"), restart.href);
      assert.equal(restarts[0]!.textContent?.trim(), restart.label);
      assert.equal(d.querySelector("a.mm-action:not(.primary)")?.getAttribute("href"), "/a/hako-merry");
      assert.equal(d.querySelector(".home-quick") === null, true, "no desk shortcuts for an agent with no grant");
    });
    it(`Me (${stored ? "held for a renewal" : "removed"})`, async () => {
      const d = await you({ stoppedAgent: stopped(stored), stoppedBook: paperBook });
      const text = words(d);
      assert.match(text, /hako merry is stopped/);
      assert.match(text, /Paper value \$1,000\.00 as of Nov 18/);
      assert.doesNotMatch(text, NEWCOMER);
      assert.equal(d.querySelector("a.flow-primary")?.getAttribute("href"), restart.href);
      assert.equal(d.querySelector("a.flow-primary")?.textContent, restart.label);
    });
    it(`the account entry and the desktop aside (${stored ? "held for a renewal" : "removed"})`, async () => {
      const d = await entry({ stoppedAgent: stopped(stored), stoppedBook: paperBook });
      const text = words(d);
      assert.match(text, /hako merry is stopped/);
      assert.doesNotMatch(text, NEWCOMER);
      assert.equal(d.querySelectorAll("a.flow-primary").length, 1);
      assert.equal(d.querySelector("a.flow-primary")?.getAttribute("href"), restart.href);
    });
    it(`the desktop header (${stored ? "held for a renewal" : "removed"})`, async () => {
      const d = await header({ stoppedAgent: stopped(stored) });
      const text = words(d);
      assert.doesNotMatch(text, /Create your merryman|Create an agent/);
      assert.equal(d.querySelector("a.desktop-fund")?.getAttribute("href"), restart.href);
      assert.equal(d.querySelector("a.desktop-fund")?.textContent, restart.label);
      assert.match(d.querySelector(".desktop-account-menu summary")?.textContent ?? "", /hako merry/);
    });
  }

  it("the figure: nothing while the read is out or refused, a dash for a value nobody read", async () => {
    for (const book of [undefined, null]) {
      const text = words(await home({ stoppedAgent: stopped(), stoppedBook: book }));
      assert.match(text, /hako merry is stopped/);
      assert.doesNotMatch(text, /Value|\$/, String(book));
    }
    const unknown = words(await entry({ stoppedAgent: stopped(), stoppedBook: { recentTrades: null, topTrades: null, figures: null } }));
    assert.match(unknown, /Value —/);
    assert.doesNotMatch(unknown, /\$0\.00/);
  });
});

describe("a newcomer, and a state not yet known, are not told they are stopped", () => {
  it("the newcomer's screens are the newcomer's", async () => {
    assert.match(words(await home({})), /Create your merryman/);
    assert.match(words(await you({})), /Create your merryman/);
    assert.match(words(await entry({})), /Your agent starts here/);
    assert.match(words(await header({})), /Create your merryman/);
    for (const d of [await home({}), await you({}), await entry({}), await header({})]) assert.doesNotMatch(words(d), /is stopped/);
  });

  it("checking claims neither", async () => {
    for (const d of [await home({ checking: true }), await you({ checking: true }), await entry({ checking: true }), await header({ checking: true })]) {
      assert.doesNotMatch(words(d), /is stopped|Create your merryman|Your agent starts here|Create an agent|Your merryman lives here/);
    }
  });

  it("an owner with a live grant whose numbers are loading is not stopped either", async () => {
    const text = words(await home({ hasAgent: true, phase: "loading" }));
    assert.match(text, /Fetching your merryman's numbers/);
    assert.doesNotMatch(text, /is stopped/);
  });
});
