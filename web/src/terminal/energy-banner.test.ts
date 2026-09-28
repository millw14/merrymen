/**
 * THE ENERGY PANEL ON THE DESK: WHERE IT SITS, WHAT IT SAYS, WHAT IT MAY DO.
 *
 * Energy is how much an agent may start on its own each day. Without 100,000
 * $MERRYMEN between the owner's wallet and the agent's account it runs on about
 * a tenth of a normal day, and when that is used up it waits for 00:00 UTC.
 * The desk says so from the worker's own report — and every way that sentence
 * could go wrong costs somebody money or trust:
 *
 *   - it could say it where it does not belong: over the Circle banner (one
 *     number, the same remedy), or outside the conversation scroller, where
 *     banners used to take the whole phone;
 *   - it could print the address shortened, or invite the model to type it —
 *     one wrong character and the tokens are gone;
 *   - "Ask me to get it" could place something, where it must only fill the
 *     composer and leave the proposal, the card and the click to the owner;
 *   - it could talk about the token as anything but capacity;
 *   - an unread balance could come out as a number, above all as 0.
 *
 * Placement is pinned in the source; the words are rendered and read.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnergyStatus } from "@merrymen/core";
import { energyRemedies, energyView, type EnergyRemedies, type EnergyView } from "./energy-view";

(globalThis as unknown as { React: typeof React }).React = React;

const raw = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — block, JSX and line — so prose about a rule never satisfies it. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const AGENT = raw("./screens/Agent.tsx");
const AGENT_CODE = code(AGENT);
const NOTE = code(raw("./EnergyNote.tsx"));

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
const NOW = 1_790_500_000;
const noop = () => {};

const report = (over: Partial<EnergyStatus> = {}): EnergyStatus => ({
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 2_000,
  holderTokens: 10_345,
  needTokens: 100_000,
  day: "2026-09-27",
  resetsAt: NOW + 3_600,
  reviews: { used: 2, allowed: 3 },
  entries: { used: 1, allowed: 2 },
  spent: false,
  buy: "ready",
  estimateUsdg: 37,
  at: NOW - 60,
  ...over,
});

/** What a reader sees: tags dropped, the entities React escapes decoded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function note(
  e: EnergyStatus | null,
  opts: { chainId?: number | null; account?: string | null; view?: EnergyView; remedies?: EnergyRemedies } = {},
): Promise<string> {
  const { EnergyNote } = await import("./EnergyNote");
  const chainId = opts.chainId === undefined ? 4663 : opts.chainId;
  return renderToStaticMarkup(
    createElement(EnergyNote, {
      view: opts.view ?? energyView(e, NOW),
      remedies: opts.remedies ?? energyRemedies(e, chainId),
      account: opts.account === undefined ? ACCOUNT : opts.account,
      estimateUsdg: e?.estimateUsdg ?? null,
      onDeposit: noop,
      onAsk: noop,
      onResign: noop,
    }),
  );
}

describe("where the panel sits", () => {
  it("INSIDE THE CONVERSATION SCROLLER, never pinned above it", () => {
    const conv = AGENT_CODE.indexOf('className="desk-conversation"');
    const panel = AGENT_CODE.indexOf("<EnergyNote");
    const proposals = AGENT_CODE.indexOf("<Proposals onResign");
    assert.ok(conv > 0 && panel > conv, "the panel must be inside the desk-conversation section");
    assert.ok(proposals > panel, "and above the proposals, still inside the scroller");
  });

  it("CIRCLE BANNER, THEN ENERGY, THEN THE NOTICE", () => {
    const circle = AGENT_CODE.indexOf("{circleLocked && (");
    const panel = AGENT_CODE.indexOf("<EnergyNote");
    const notice = AGENT_CODE.indexOf("{!blocked && !circleLocked && notice && (");
    assert.ok(circle > 0 && panel > circle && notice > panel, "the harder stop outranks energy; energy outranks a log line");
  });

  it("AND NEVER BESIDE THE CIRCLE BANNER — one number lifts both, one banner says it", () => {
    assert.match(AGENT_CODE, /\{!circleLocked && \(\s*<EnergyNote/);
  });

  it("IT IS MOUNTED — imported by the screen that ships", () => {
    assert.match(AGENT, /import \{ EnergyNote \} from "\.\.\/EnergyNote";/);
    assert.match(AGENT_CODE, /energyView\(energy, Date\.now\(\) \/ 1000\)/, "from the worker's report, against now");
  });

  it("THE WORKER'S 'full' STANDS THE CIRCLE BANNER DOWN, appended after the tier's own test", () => {
    assert.match(
      AGENT_CODE,
      /tier\.why !== "sign-in" && !tier\.bonusStrategies &&\s*!workerSaysFull\(energy\)/,
    );
  });

  it("THE DATED 'Energy spent for' NOTICE STEPS ASIDE ONLY WHILE THE PANEL SAYS IT", () => {
    const n = AGENT_CODE.slice(AGENT_CODE.indexOf("const notice ="), AGENT_CODE.indexOf(": null;", AGENT_CODE.indexOf("const notice =")));
    assert.match(n, /energyNow\.kind !== "none" && energyNow\.spent/);
    assert.match(n, /startsWith\(ENERGY_NOTICE_PREFIX\)/, "matched on core's prefix, never a retyped string");
    assert.match(AGENT_CODE, /<p>\{notice\.message\}<\/p>/);
  });
});

describe("what the panel may do", () => {
  it("'ASK ME' ONLY FILLS THE COMPOSER — no proposal, no send, no order", () => {
    const at = AGENT_CODE.indexOf("onAsk={");
    assert.ok(at > 0, "the panel is given an ask handler");
    const handler = AGENT_CODE.slice(at, AGENT_CODE.indexOf("\n", at));
    assert.match(handler, /onAsk=\{\(\) => setAsk\("Get your \$MERRYMEN"\)\}/);
    assert.ok(!/setPending|setProposal|send\(|placeOrder|confirm/.test(handler), handler);
    // And setAsk is the draft setter, nothing else.
    assert.match(AGENT_CODE, /const setAsk = chat\.setDraft;/);
    // Inside the panel, the button calls exactly what it was handed.
    assert.match(NOTE, /<button type="button" onClick=\{onAsk\}>\s*Ask me to get it\s*<\/button>/);
    assert.ok(!/fetch\(|\/api\/orders|placeOrder/.test(NOTE), "the panel itself reaches no route");
  });

  it("THE ADDRESS IS RENDERED IN FULL, beside a copy button", () => {
    assert.match(NOTE, /<code className="funding-address">\{account\}<\/code>/);
    assert.ok(!/short\(|slice\(0|\.\.\.\$\{|…/.test(NOTE.replace(/"…"/g, "")), "no shortening of the address");
    assert.match(NOTE, /navigator\.clipboard\.writeText\(account\)/);
  });

  it("NO SECOND REAL-MONEY LABEL on the desk", () => {
    assert.equal((AGENT.match(/autonomy\.moneyLabel/g) ?? []).length, 1);
    assert.ok(!/moneyLabel/.test(NOTE));
  });
});

describe("what the panel says", () => {
  it("NOTHING, when there is nothing true to say", async () => {
    assert.equal(await note(null), "");
    assert.equal(await note(report({ level: "full" })), "");
    assert.equal(await note(report({ gated: false, mode: "observe", spent: true })), "");
  });

  it("LOW, NOT SPENT: one quiet line with the worker's counts", async () => {
    const t = text(await note(report()));
    assert.match(t, /^Low energy: without 100,000 \$MERRYMEN between your wallet and my account/);
    assert.match(t, /2 of 3 AI reviews and 1 of 2 new trades used today/);
    assert.match(t, /00:00 UTC/);
    assert.match(await note(report()), /<progress/, "a bar against an allowance the worker reported");
  });

  it("…and no bar, and no 'of —', against what nobody read", async () => {
    const html = await note(report({ reviews: null, entries: { used: 1, allowed: null } }));
    assert.ok(!/<progress/.test(html), "no bar against an unread allowance");
    assert.ok(!/AI reviews/.test(text(html)), "an agent with no paid reviewer is not told it has — of them");
  });

  it("UNREAD: our read failing, never their wallet, and never a number", async () => {
    const t = text(await note(report({ level: "unread", agentTokens: null, holderTokens: null })));
    assert.match(t, /That's our read failing, not your wallet/);
    assert.ok(!/\bhold\b/.test(t));
  });

  it("SPENT: the day, the doors still open, every remedy — and 'change nothing'", async () => {
    const html = await note(report({ spent: true }));
    const t = text(html);
    assert.match(t, /Energy spent for today — I pick up again at 00:00 UTC\./);
    // A tenth of the HOUSE's standard day, not of the owner's own preset.
    assert.match(t, /about a tenth of a standard day's AI reviews and new trades/);
    assert.doesNotMatch(t, /my usual/);
    assert.match(t, /Stop-losses, take-profits and your own orders still run; my own AI reviews — including of my open positions — are paced along with the rest\./);
    assert.doesNotMatch(t, /\bSelling\b/, "an exit the AI decides is paced; 'selling still runs' was false");
    assert.match(t, /You and I hold 12,345 \$MERRYMEN — 87,655 short\./);
    const noWallet = text(await note(report({ spent: true, holderCounted: false, holderTokens: null, agentTokens: 5_000 })));
    assert.match(noWallet, /My account holds 5,000 \$MERRYMEN — 95,000 short\./, "the figure is not dropped when no wallet counts");
    assert.match(t, /Send \$MERRYMEN on Robinhood Chain to my account:/);
    assert.ok(t.includes(ACCOUNT), "the address, whole");
    assert.match(t, /Copy address/);
    assert.match(t, /Or send USDG to that address and ask me to get my \$MERRYMEN — you'll confirm the amount first/);
    assert.match(t, /Ask me to get it/);
    assert.match(t, /Or change nothing — I carry on at this pace\./);
  });

  it("SPENT BUT A COUNT UNREAD: no holdings line, never 'hold 0' or 'hold —'", async () => {
    const t = text(await note(report({ spent: true, holderTokens: null })));
    assert.ok(!/You and I hold/.test(t));
    assert.ok(!/\b0 \$MERRYMEN|hold 0/.test(t));
  });

  it("SPENT AND UNREAD: says so, with no count at all", async () => {
    const t = text(await note(report({ spent: true, level: "unread", agentTokens: null, holderTokens: null })));
    assert.match(t, /I couldn't read the \$MERRYMEN balances — that's our read failing, not your wallet\./);
    assert.ok(!/You and I hold/.test(t));
  });

  it("PAPER: no USDG route — practice never spends real money on this", async () => {
    const t = text(await note(report({ spent: true, buy: "paper" })));
    assert.match(t, /I'm in Paper mode, so I won't spend real USDG on it/);
    assert.ok(!/send USDG/i.test(t));
    assert.ok(!/Ask me to get it/.test(t));
  });

  it("RESIGN: the key cannot buy it yet, and the re-sign is offered", async () => {
    const t = text(await note(report({ spent: true, buy: "resign" })));
    assert.match(t, /My key can't buy it yet — re-sign my permission \(free\) first\./);
    assert.ok(!/Ask me to get it/.test(t));
  });

  it("NOT ON MAINNET: the address is never offered — tokens sent there would not count", async () => {
    const e = report({ spent: true, buy: "not-mainnet", agentTokens: null, holderTokens: 5 });
    const t = text(await note(e, { chainId: 46630 }));
    assert.ok(!t.includes(ACCOUNT), "no address to send to");
    assert.match(t, /My account is on another network, so \$MERRYMEN sent to it would not count/);
    assert.match(t, /in your own wallet/);
  });

  it("THE ESTIMATE, WHEN THE WORKER HAS ONE, IS A RATE — never a price call", async () => {
    assert.match(text(await note(report({ spent: true }))), /about \$37\.00 of USDG at the pool's current rate/);
    assert.ok(!/about \$/.test(text(await note(report({ spent: true, estimateUsdg: null })))));
  });

  it("$MERRYMEN IS ENERGY, NOTHING MORE — no price, returns or profit, and no percentages", async () => {
    // Every variant the panel can render, read as a person reads it.
    const variants: EnergyStatus[] = [
      report(),
      report({ level: "unread", agentTokens: null, holderTokens: null }),
      report({ spent: true }),
      report({ spent: true, level: "unread", agentTokens: null, holderTokens: null }),
      report({ spent: true, buy: "paper" }),
      report({ spent: true, buy: "resign" }),
      report({ spent: true, buy: "not-mainnet", agentTokens: null }),
    ];
    const all = (await Promise.all(variants.map((e) => note(e)))).map(text).join(" ");
    assert.ok(all.length > 500, "the scan must find the copy");
    // "take-profit" names a sell rule; it is not a word about returns.
    assert.doesNotMatch(all, /price|returns?\b|(?<!take-)profit|moon|pump|buyback|burn|invest/i);
    assert.doesNotMatch(all, /\d+(\.\d+)?\s*%/, "a fee or tax percentage can go stale without a line of code changing");
  });

  it("and the Circle banner's own words hold to the same stance", () => {
    const banner = AGENT_CODE.slice(AGENT_CODE.indexOf("{circleLocked && ("), AGENT_CODE.indexOf("<EnergyNote"));
    assert.doesNotMatch(banner, /price|returns?\b|profit/i);
    assert.match(banner, /00:00 UTC|between them/);
  });
});

/**
 * THE FUNDING SCREEN SAYS THE SAME THING, beside the address it is about.
 *
 * It is where "How to top up" lands, where the chat's open-deposit lands, and
 * what Android shows in its /deposit WebView — so it is the one place a remedy
 * and a copyable address reach every client at once.
 */
describe("the funding screen", () => {
  async function funding(e: EnergyStatus | null, chainId = 4663): Promise<string> {
    const { FundingPanel } = await import("./HostedControls");
    // The panel judges the report against the real clock, so its day must
    // still be running now.
    if (e) e = { ...e, resetsAt: Math.floor(Date.now() / 1000) + 3_600 };
    return text(
      renderToStaticMarkup(
        createElement(FundingPanel, {
          mode: "deposit",
          onClose: noop,
          account: {
            session: { hosted: true, address: "0x" + "a".repeat(40) },
            status: {
              exists: true,
              energy: e,
              grant: { smartAccount: ACCOUNT, chainId, caps: { perTradeUsdg: 10, dailyUsdg: 50 } },
            },
          },
        }),
      ),
    );
  }

  it("SAYS NOTHING ABOUT A LIMIT THAT LIMITS NOTHING", async () => {
    for (const e of [null, report({ level: "full" }), report({ gated: false, mode: "off" })]) {
      assert.ok(!/Energy/.test(await funding(e)), JSON.stringify(e?.level));
    }
  });

  it("LOW: the combined standing, what full needs, and both routes", async () => {
    const t = await funding(report());
    assert.match(t, /your wallet and this account hold 12,345 \$MERRYMEN between them, 87,655 short/);
    assert.match(t, /Full strength needs 100,000 \$MERRYMEN between your wallet and this account/);
    assert.match(t, /below that your agent gets about a tenth of a standard day's AI reviews and new trades/);
    assert.match(t, /Stop-losses, take-profits and your own orders are never limited; its own AI reviews — including of its open positions — are paced along with the rest\./);
    assert.doesNotMatch(t, /\bSelling\b/);
    assert.match(t, /Send \$MERRYMEN on Robinhood Chain to this same address, or send USDG here and ask your agent in chat to get its \$MERRYMEN — you confirm the amount first\./);
    assert.match(t, /Or change nothing/);
    assert.match(t, /Copy deposit address/, "the existing copy button stays");
  });

  it("NO WALLET THAT COUNTS: the account's own figure — never 'couldn't read'", async () => {
    const t = await funding(report({ holderCounted: false, holderTokens: null, agentTokens: 5_000 }));
    assert.match(t, /this account holds 5,000 \$MERRYMEN, 95,000 short — no wallet of yours counts toward it/);
    assert.doesNotMatch(t, /couldn't read/);
    const failed = await funding(report({ holderCounted: true, holderTokens: null }));
    assert.match(failed, /we couldn't read every \$MERRYMEN balance just now/, "a real failed read still says so");
    const offChain = await funding(report({ buy: "not-mainnet", holderCounted: false, holderTokens: null, agentTokens: null }), 46630);
    assert.match(offChain, /no wallet of yours counts toward it yet/);
    assert.doesNotMatch(offChain, /couldn't read/);
  });

  it("SPENT says the reset", async () => {
    assert.match(await funding(report({ spent: true })), /spent for today, back at 00:00 UTC/);
  });

  it("UNREAD is our read, never a number", async () => {
    const t = await funding(report({ level: "unread", agentTokens: null, holderTokens: null }));
    assert.match(t, /that's our read failing, not your wallet/);
    assert.ok(!/\bhold\b/.test(t));
  });

  it("PAPER offers no USDG route", async () => {
    const t = await funding(report({ buy: "paper" }));
    assert.match(t, /won't spend real USDG on it — turn on Live trading first/);
    assert.ok(!/send USDG here/.test(t));
  });

  it("RESIGN says the key cannot buy it yet", async () => {
    assert.match(await funding(report({ buy: "resign" })), /re-sign your agent's permission \(free — its current key can't buy it\)/);
  });

  it("ANOTHER NETWORK: never 'send it here'", async () => {
    const t = await funding(report({ buy: "not-mainnet", agentTokens: null, holderTokens: 50 }), 46630);
    assert.match(t, /This account is on another network, so \$MERRYMEN sent to it would not count/);
    assert.ok(!/to this same address/.test(t));
  });

  it("AND THE SAME STANCE: no price, returns or percentages", async () => {
    const all = (
      await Promise.all(
        [report(), report({ spent: true, buy: "paper" }), report({ buy: "resign" }), report({ level: "unread" })].map((e) =>
          funding(e),
        ),
      )
    ).join(" ");
    const energyCopy = all.slice(all.indexOf("Energy"));
    assert.doesNotMatch(energyCopy, /price|returns?\b|(?<!take-)profit|invest|\d+(\.\d+)?\s*%/i);
  });
});
