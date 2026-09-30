/**
 * LOADING, FAILED, AND READ ARE THREE ANSWERS.
 *
 * `account` is null in two situations — the first read has not come back, and
 * it came back with a failure — and both rendered "Loading your account…". A
 * failed read therefore said "loading" for ever, with nothing to press. The
 * portfolio had the mirror image: an owner whose book was still in flight was
 * told "Your portfolio data is not available yet", a verdict about a request
 * that had not answered.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountState } from "./HostedControls";

(globalThis as unknown as { React: typeof React }).React = React;

const noop = () => {};
/** What a reader sees: tags dropped, the entities React escapes decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const withAgent: AccountState = {
  session: { hosted: true, address: "0x" + "a".repeat(40) },
  status: { exists: true, grant: { smartAccount: "0x" + "b".repeat(40), chainId: 4663, caps: { perTradeUsdg: 10, dailyUsdg: 50 } } },
};

async function entry(props: Record<string, unknown>): Promise<string> {
  const { AccountEntry } = await import("./HostedControls");
  return renderToStaticMarkup(createElement(AccountEntry, { onRefresh: noop, ...props } as never));
}
async function create(props: Record<string, unknown>): Promise<string> {
  const { CreateAgent } = await import("./screens/CreateAgent");
  return renderToStaticMarkup(
    createElement(CreateAgent, { onRefresh: noop, onBack: noop, onDone: noop, onFund: noop, ...props } as never),
  );
}

describe("the account entry", () => {
  it("draws a skeleton while the account is loading, and claims nothing", async () => {
    const html = await entry({ account: null, accountFailed: false });
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(text(html), /Create an agent|Sign in/);
  });

  it("says a failed account read failed, and offers to try again", async () => {
    const html = await entry({ account: null, accountFailed: true });
    assert.doesNotMatch(text(html), /Loading/i, "a read that failed is not still loading");
    assert.doesNotMatch(html, /aria-busy/);
    assert.match(text(html), /couldn.t load your account/i);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
  });

  it("does not call a portfolio still in flight 'not available'", async () => {
    const html = await entry({ account: withAgent, portfolio: "unread" });
    assert.doesNotMatch(text(html), /not available/);
    assert.match(html, /aria-busy="true"/);
  });

  it("says a portfolio read that failed failed", async () => {
    const html = await entry({ account: withAgent, portfolio: "unreadable" });
    assert.match(text(html), /couldn.t load your portfolio/i);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
  });

  it("keeps 'not available yet' for a portfolio the server read and found empty", async () => {
    // A brand-new agent the mirror has not reached: the read succeeded and
    // there is no book yet. That sentence is true here, and only here.
    const html = await entry({ account: withAgent, portfolio: "ok" });
    assert.match(text(html), /not available yet/);
  });
});

describe("the create screen", () => {
  it("does not say 'Loading your account' about a read that failed", async () => {
    const html = await create({ account: null, accountFailed: true });
    assert.doesNotMatch(text(html), /Loading/i);
    assert.match(text(html), /couldn.t load your account/i);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
  });

  it("draws a skeleton while it is still loading", async () => {
    const html = await create({ account: null, accountFailed: false });
    assert.match(html, /aria-busy="true"/);
  });
});

describe("a retry the reader asked for", () => {
  // The failure stays true until a read succeeds, so "We couldn't load your
  // account" stood unchanged through the retry just pressed, and the button
  // looked like it had done nothing.
  it("says it is trying again, and cannot be pressed twice", async () => {
    for (const html of [
      await entry({ account: null, accountFailed: true, retrying: true }),
      await entry({ account: withAgent, portfolio: "unreadable", retrying: true }),
      await create({ account: null, accountFailed: true, retrying: true }),
    ]) {
      assert.match(text(html), /Trying to load your (account|portfolio) again/);
      assert.match(html, /<button[^>]*disabled=""[^>]*>Trying again…<\/button>/);
      assert.doesNotMatch(text(html), /couldn.t load/i);
    }
  });
});
