/**
 * WHAT IS MY AGENT DOING RIGHT NOW, AND WHAT HAPPENS NEXT.
 *
 * A user with $318 in the account looked at the home screen and asked, in the
 * group chat, "Will it now start trading". The screen he was looking at led
 * with **Total equity**, then "— building today · no deposit on record yet",
 * then CASH / VAULT / POSITIONS, then a sentence about what the chain caps.
 * Every one of those is true, and not one of them answers his question.
 *
 * That is the gap this fills. The console is an accounting surface pointed at
 * somebody who wants a status. Both are worth having; the status has to come
 * first, because it is the question everyone actually arrives with.
 *
 * THREE RULES, and they are the whole design:
 *
 *  1. NO JARGON THAT ISN'T LOAD-BEARING. Not "equity", not "positions", not
 *     "session key", not the strategy's internal name. A person who has just
 *     sent money wants a sentence, not a vocabulary.
 *  2. NEVER CLAIM WHAT WE DID NOT CHECK. This file has no clock and no market
 *     calendar, so it never says "the market is closed" — it says what it can
 *     see. The codebase's central rule is that unknown is not representable as
 *     zero, and a status line is exactly where that rule gets bent for the sake
 *     of a comforting sentence.
 *  3. ALWAYS SAY WHAT HAPPENS NEXT. A status with no next step is a status
 *     someone has to come back and ask about, which is what happened here.
 *
 * Pure, so the wording is testable without a browser, a chain, or a ledger.
 */

export interface AgentSnapshot {
  name: string;
  /** What the worker reports it is doing. `idle` means it is not running. */
  mode: "live" | "paper" | "idle";
  /** Practice chain — nothing here is real, whatever else is true. */
  testnet: boolean;
  /** Does the smart account hold any gas? Without it nothing can be signed. */
  hasGas: boolean;
  /** Trading capital, in USDG. */
  cashUsdg: number;
  /** Value of everything it is currently holding, in USDG. */
  positionsUsdg: number;
  /** How many distinct things it holds. */
  positionCount: number;
  /** Symbols it may trade at all — the ones sealed into the signature. */
  tradableCount: number;
  /** Trades that actually landed today. */
  landedToday: number;
  /** Intents its own rules turned down today. */
  refusedToday: number;
  /** Days until the key expires on its own. */
  daysLeft: number | null;
  /** The newest `err` the worker recorded, if any. */
  lastError: string | null;
}

export interface StatusLine {
  /** One sentence. What it is doing. */
  headline: string;
  /** One sentence. What happens next, or what to do about it. */
  next: string;
  /** Drives the dot: green = working, amber = waiting on you, red = stuck. */
  tone: "good" | "waiting" | "stuck";
}

/** `$1,234` — money the way a person writes it, never `1234.00 USDG`. */
function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

/**
 * Trim a worker error down to something a person can act on.
 *
 * These are written for an owner already (see the arm-failure path in
 * index.ts), but they carry addresses and clause after clause. The first
 * sentence is the part that says what is wrong.
 */
function firstSentence(s: string, max = 160): string {
  const cut = s.split(/(?<=[.!?])\s/)[0] ?? s;
  return cut.length > max ? `${cut.slice(0, max - 1).trimEnd()}…` : cut;
}

/**
 * NAME THE NETWORK, EVERY TIME WE ASK FOR MONEY.
 *
 * A user sent ETH to his account address and reported it “appearing in the
 * wallet”, then “topped up a wallet but nothing's showing”. His address held
 * 0.004268 ETH — on ETHEREUM MAINNET. On Robinhood Chain it had never been
 * touched: zero balance, zero USDG, nonce 0.
 *
 * He did nothing wrong. He was given an address and no network, and an
 * address is valid on every EVM chain — which is exactly why naming one is
 * not decoration. The funds are not lost (he controls the key) but they are
 * on the wrong chain, and nothing in this app ever told him which chain it
 * wanted.
 */
function network(testnet: boolean): string {
  return testnet ? "the practice chain" : "Robinhood Chain";
}

export function statusLine(a: AgentSnapshot): StatusLine {
  const name = a.name || "Your agent";
  const net = network(a.testnet);

  // ── Stuck: it cannot work, and no amount of waiting changes that ─────────
  //
  // FIRST, above everything. An agent that cannot start is the one case where
  // every other sentence would be a lie of omission — and it is the case that
  // went unnoticed for hours across ten accounts, because nothing on any screen
  // said it.
  if (a.lastError) {
    return {
      headline: `${name} has stopped and can't start again on its own.`,
      next: firstSentence(a.lastError),
      tone: "stuck",
    };
  }
  if (a.mode === "idle") {
    return {
      headline: `${name} isn't running.`,
      // Deliberately not a guess at why. `idle` means the worker reported no
      // agent armed; inventing a cause here would be exactly the thing rule 2
      // forbids.
      next: "It should come back on its own within a minute or two. If it doesn't, tell us — that's a bug at our end, not something you can fix.",
      tone: "stuck",
    };
  }
  // NO GAS — and this branch has to survive the fact that the owner has
  // usually ALREADY SENT MONEY.
  //
  // A user in the group chat, with $15 in the account: “It says it can't
  // trade. Because no ETH. But there is 15 bucks in it.” Both statements
  // were true. On this chain the money you TRADE with (USDG) and the money
  // you pay FEES with (ETH) are different assets, and a sentence that names
  // only the missing one reads as “your money is not there” to the person
  // who just sent it. He is not confused about his balance; the screen is
  // confused about what he already did.
  //
  // So when there IS cash, say so first and name the two-asset thing
  // outright. Rule 2 still holds: this claims nothing it did not check —
  // `cashUsdg` and `hasGas` are both read from the same snapshot.
  if (!a.hasGas) {
    return a.cashUsdg > 0
      ? {
          headline: `${name} has ${money(a.cashUsdg)} to trade with, but no ETH to pay the fees.`,
          next:
            "Your money is there. This chain charges fees in ETH, which is a separate thing from " +
            "the dollars you trade with, so the account needs a little of both. A few dollars of ETH " +
            `covers many trades — send it to the same account address, on ${net}. ETH sent on ` +
            "Ethereum, Base or any other network will not arrive here.",
          tone: "waiting",
        }
      : {
          headline: `${name} can't trade yet — the account has no ETH for fees.`,
          next:
            `Send a little ETH to the account address, on ${net} — not Ethereum or Base, which is ` +
            "where it most often ends up. A few dollars covers many trades.",
          tone: "waiting",
        };
  }

  // ── Practice ─────────────────────────────────────────────────────────────
  if (a.testnet) {
    return {
      headline: `${name} is on the practice chain, so none of this is real money.`,
      next: "Move it to real money from the wallet page when you're ready — it's free and takes one signature.",
      tone: "waiting",
    };
  }
  if (a.mode === "paper") {
    return {
      headline: `${name} is practising — real prices, pretend money.`,
      next:
        a.cashUsdg > 0
          ? "It's watching the market and showing you what it would do. Everything below is a simulation until it goes live."
          : "Add some USDG and it starts trading for real. Until then it practises so you can watch it work first.",
      tone: "waiting",
    };
  }

  // ── Live ─────────────────────────────────────────────────────────────────
  const expiring = a.daysLeft !== null && a.daysLeft <= 2;
  const expiryNote = expiring
    ? ` Its key expires in ${a.daysLeft === 0 ? "under a day" : `${a.daysLeft} day${a.daysLeft === 1 ? "" : "s"}`} — renew it on the wallet page, it's free.`
    : "";

  if (a.positionCount > 0) {
    return {
      headline: `${name} is holding ${money(a.positionsUsdg)}${a.positionCount > 1 ? ` across ${a.positionCount} things` : ""}.`,
      next: `It sells when its rules say to, not on a timer.${expiryNote}`,
      tone: expiring ? "waiting" : "good",
    };
  }
  if (a.landedToday > 0) {
    return {
      headline: `${name} made ${a.landedToday} trade${a.landedToday === 1 ? "" : "s"} today and is back in cash.`,
      next: `It's watching for the next one.${expiryNote}`,
      tone: expiring ? "waiting" : "good",
    };
  }
  if (a.refusedToday > 0) {
    return {
      // The refusals are the product working, and they read as failure unless
      // somebody says otherwise. This is the sentence that turns a wall of red
      // rows into evidence.
      headline: `${name} looked at ${a.refusedToday} trade${a.refusedToday === 1 ? "" : "s"} today and turned ${a.refusedToday === 1 ? "it" : "them"} down.`,
      next: `Passing is normal — it only buys when its own rules line up.${expiryNote}`,
      tone: expiring ? "waiting" : "good",
    };
  }
  if (a.cashUsdg <= 0) {
    return {
      headline: `${name} is live but has nothing to trade with.`,
      next: `Send USDG to the account address, on ${net}, and it starts working.`,
      tone: "waiting",
    };
  }
  return {
    headline: `${name} is live and watching${a.tradableCount > 0 ? ` ${a.tradableCount} coin${a.tradableCount === 1 ? "" : "s"}` : ""}.`,
    next: `It hasn't found a trade worth making yet. That's the normal state most of the time.${expiryNote}`,
    tone: "good",
  };
}
