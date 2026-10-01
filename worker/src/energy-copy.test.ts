/**
 * EVERY WAY THE ENERGY NOTICE CAN READ, RENDERED.
 *
 * The sentence reaches an owner through the notice slot on the web desk, iOS
 * and Android, and it asks them to move tokens or money. So each variant is
 * executed and held to the same rules: dated, naming Robinhood Chain, saying
 * exactly what still runs (stop-losses, take-profits, their own orders) and
 * that the agent's own AI reviews are paced, carrying the agent's address in
 * full exactly when sending there would count — and never saying anything
 * about the token's price or returns, or "you hold 0" about a wallet nobody
 * managed to read.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ENERGY_NOTICE_PREFIX } from "../../packages/core/src/index";
import { count, energyNotice, noticeDate, type EnergyNoticeFacts } from "./energy-copy";

const ACCOUNT = "0x8e93ba0c1b1d8f0a3c9b2e6f4d5a7c8b9e0f1a2b";
const HOLDER = "0x1234567890abcdef1234567890abcdef12345678";

const BASE: EnergyNoticeFacts = {
  day: "2026-09-27",
  account: ACCOUNT,
  chainId: 4663,
  holder: HOLDER,
  holderTokens: 12_000,
  agentTokens: 345,
  level: "low",
  buy: "ready",
  estimateUsdg: 37.12,
};

const VARIANTS: Record<string, Partial<EnergyNoticeFacts>> = {
  base: {},
  unread: { level: "unread", holderTokens: null, agentTokens: null },
  paper: { buy: "paper" },
  resign: { buy: "resign" },
  "not-mainnet": { chainId: 46630, buy: "not-mainnet", agentTokens: null },
  "estimate null": { estimateUsdg: null },
  "holder null": { holder: null, holderTokens: null },
  "counts null": { holderTokens: null, agentTokens: null },
  "buy null": { buy: null },
  "holds nothing": { holderTokens: 0, agentTokens: 0 },
};

const render = (over: Partial<EnergyNoticeFacts>) => energyNotice({ ...BASE, ...over });

describe("every variant keeps the promises", () => {
  for (const [name, over] of Object.entries(VARIANTS)) {
    const text = render(over);
    it(`${name}: dated, on Robinhood Chain, and the doors still open`, () => {
      assert.ok(text.startsWith(ENERGY_NOTICE_PREFIX), text);
      assert.ok(text.startsWith("Energy spent for 27 Sep (UTC): "), text);
      assert.match(text, /Robinhood Chain/);
      assert.match(text, /[Ss]top-losses, take-profits and your own orders still run/);
      assert.match(text, /My own AI reviews — including of my open positions — are paced/);
      // "Selling is never limited" was false: an exit the AI decides waits for
      // a paced review like anything else it starts on its own.
      assert.doesNotMatch(text, /\bselling\b/i, text);
      // The allowance is a tenth of the HOUSE baselines, not of the owner's own
      // preset or interval — "my usual" overstated it for Balanced and Bold.
      assert.match(text, /about a tenth of a standard day's AI reviews and new trades/);
      assert.doesNotMatch(text, /my usual/);
      assert.match(text, /00:00 UTC/);
      assert.match(text, /100,000/);
    });
    it(`${name}: the agent's address in full exactly when sending there counts`, () => {
      const notMainnet = name === "not-mainnet";
      assert.equal(text.includes(ACCOUNT), !notMainnet, text);
      if (!notMainnet) assert.equal(ACCOUNT.length, 42);
    });
    it(`${name}: nothing about price or returns`, () => {
      // "take-profit" is the name of a sell rule, not a word about returns.
      assert.doesNotMatch(text, /price|returns?\b|(?<!take-)profit|moon|pump|buyback|burn|investment/i, text);
      // The ONE dollar figure: the worker's estimate, and only when it is known.
      const dollars = text.match(/\$\d/g) ?? [];
      const known = (over.estimateUsdg === undefined ? BASE.estimateUsdg : over.estimateUsdg) !== null;
      const offersUsdg = !["paper", "not-mainnet", "buy null", "unread-paper"].includes(name);
      assert.equal(dollars.length, known && offersUsdg ? 1 : 0, text);
    });
    it(`${name}: never "hold 0"`, () => {
      assert.doesNotMatch(text, /\b0 \$MERRYMEN|hold 0\b|holds 0\b/, text);
    });
  }
});

describe("the arms", () => {
  it("THE BASE, word for word where it matters", () => {
    const t = render({});
    assert.equal(
      t,
      "Energy spent for 27 Sep (UTC): without 100,000 $MERRYMEN between your wallet and my account I get about a " +
        "tenth of a standard day's AI reviews and new trades, and today's new trades are used up. Nothing is broken — stop-losses, " +
        "take-profits and your own orders still run, and I pick up again at 00:00 UTC. My own AI reviews — including " +
        "of my open positions — are paced along with everything else I start on my own. You and I hold 12,345 between " +
        "us (87,655 short). For full strength, send $MERRYMEN on Robinhood Chain to my account " +
        `${ACCOUNT} (or keep it in your own wallet ${HOLDER} — both count), or send USDG to my account and ask me ` +
        "in chat to get my $MERRYMEN — you confirm the amount first (about $37.12 of USDG at the pool's current " +
        "rate). Or change nothing and I carry on at this pace.",
    );
  });

  it("UNREAD IS OUR READ, NOT THEIR WALLET — and claims nothing about what they hold", () => {
    const t = render(VARIANTS.unread!);
    assert.match(t, /our read failing, not your wallet/);
    assert.match(t, /couldn't read/);
    assert.doesNotMatch(t, /You and I hold|you hold \d|holds none/i);
    assert.doesNotMatch(t, /Nothing is broken/, "a failing read is something broken — ours");
  });

  it("paper: no USDG buy is offered", () => {
    const t = render(VARIANTS.paper!);
    assert.doesNotMatch(t, /send USDG/);
    assert.match(t, /Paper mode/);
    assert.match(t, /turn on Live trading first/);
  });

  it("resign: the re-sign comes before the ask", () => {
    const t = render(VARIANTS.resign!);
    assert.match(t, /renew my permission \(revocation requires network fees — my current key can't buy it\), then ask me in chat/);
    assert.doesNotMatch(t, /\bfree\b/i);
  });

  it("NOT MAINNET: only their own wallet counts, and the account is never printed", () => {
    const t = render(VARIANTS["not-mainnet"]!);
    assert.match(t, /keep 100,000 \$MERRYMEN on Robinhood Chain in your own wallet 0x1234/);
    assert.match(t, /my account is on another network, so tokens sent to it would not count/);
    assert.doesNotMatch(t, /send USDG/);
    assert.match(t, /Your wallet holds 12,000 \(88,000 short\)/);
  });

  it("an unknown estimate is left out, never guessed", () => {
    assert.doesNotMatch(render(VARIANTS["estimate null"]!), /about \$/);
  });

  it("no wallet linked: no wallet parenthetical, and the account is the whole figure", () => {
    const t = render(VARIANTS["holder null"]!);
    assert.doesNotMatch(t, /your own wallet/);
    assert.match(t, /My account holds 345 \(99,655 short\)/);
  });

  it("a count that was not read leaves the holdings out", () => {
    assert.doesNotMatch(render(VARIANTS["counts null"]!), /hold/i);
  });

  it("a known zero is 'none', not 0", () => {
    assert.match(render(VARIANTS["holds nothing"]!), /Neither your wallet nor my account holds any yet \(100,000 short\)/);
  });

  it("TELEGRAM'S DRESSING: addresses in code, the ask pointed at the app", () => {
    const t = energyNotice(BASE, { address: (a) => `<code>${a}</code>`, chatPlace: "in the Merrymen app chat (not here)" });
    assert.ok(t.includes(`<code>${ACCOUNT}</code>`));
    assert.ok(t.includes(`<code>${HOLDER}</code>`));
    assert.match(t, /ask me in the Merrymen app chat \(not here\) to get my \$MERRYMEN/);
  });
});

describe("the small print", () => {
  it("dates and counts render without locale data", () => {
    assert.equal(noticeDate("2026-01-05"), "5 Jan");
    assert.equal(noticeDate("2026-12-31"), "31 Dec");
    assert.equal(noticeDate("nonsense"), "nonsense");
    assert.equal(count(100_000), "100,000");
    assert.equal(count(999), "999");
    assert.equal(count(1_234_567), "1,234,567");
  });
});
