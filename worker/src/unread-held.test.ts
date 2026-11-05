/**
 * ONE UNREADABLE HELD COIN MUST NOT FREEZE EXITS — the pure half.
 *
 * index.ts has no exports, so the decisions it makes about an unread holding
 * live in unread-held.ts and are run here: which gaps hold the tick and which
 * only make the book incomplete; which unread coins count as held; that an
 * unread coin leaves the book whole, never at a partial balance; what the
 * owner is told, once per change; and when the heartbeat may not divide by a
 * figure that is short of a holding. index.ts's wiring of each is pinned by
 * custody.test.ts "the tick uses the custody seam".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NOTHING_SHOWN,
  NO_HELD_UNREAD,
  TRENCHER_CASH_GAP,
  classifyBookGaps,
  heartbeatDrawdownBps,
  heldUnreadOf,
  shownEquityOf,
  unreadHeldNotice,
  unreadHeldOf,
  withoutUnreadHeld,
} from "./unread-held";

const GATO = "0x436B01E41314d4b010edd24cf7c997a7d111c0ab";
const WATCH = [
  { symbol: "AAPL", address: "0x00000000000000000000000000000000000000a1" },
  { symbol: "GATO", address: GATO },
  { symbol: "DELTA", address: "0x00000000000000000000000000000000000000d7" },
  { symbol: "NOCODE", address: "0x00000000000000000000000000000000000000ee" },
];
const none = new Set<string>();
const held = (over: Partial<Parameters<typeof unreadHeldOf>[0]> = {}) =>
  unreadHeldOf({ unread: [], basisOnRecord: [], vaultTokens: [], watch: WATCH, lastLiveHeld: none, heldThisTick: none, ...over });

describe("classifyBookGaps — which gaps hold the tick", () => {
  const base = { balances: [] as string[], classVault: [] as string[], positionsReadFailed: false, trencherCashUnread: false, unreadHeld: [] as string[] };

  it("A PER-TOKEN UNREAD HELD COIN NEVER REACHES THE EARLY RETURN — it makes the book incomplete instead", () => {
    const g = classifyBookGaps({ ...base, unreadHeld: ["GATO", "DELTA", "GATO"] });
    assert.deepEqual(g.holdTick, [], "one coin's failed row must not switch off every stop-loss");
    assert.deepEqual(g.incomplete, ["DELTA", "GATO"]);
  });

  it("and not beside a whole-book gap either: those hold, the coin is still only incomplete", () => {
    const g = classifyBookGaps({ ...base, balances: ["cash"], classVault: ["class"], trencherCashUnread: true, unreadHeld: ["GATO"] });
    assert.deepEqual(g.holdTick, ["cash", "class", TRENCHER_CASH_GAP]);
    assert.ok(!g.holdTick.includes("GATO"));
    assert.deepEqual(g.incomplete, ["GATO"]);
  });

  it("whole-book gaps hold the tick, in the order the owner reads them: cash, ETH, the vault, the class vault, the Trencher vault's cash", () => {
    assert.deepEqual(classifyBookGaps({ ...base, balances: ["eth", "cash", "vault"] }).holdTick, ["eth", "cash", "vault"]);
    assert.deepEqual(classifyBookGaps({ ...base, classVault: ["class"] }).holdTick, ["class"]);
    assert.deepEqual(classifyBookGaps({ ...base, trencherCashUnread: true }).holdTick, ["Trencher vault cash"]);
  });

  it("A WHOLE POSITIONS READ THAT FAILED holds the tick as `positions`, and leaves no per-coin half to speak", () => {
    const g = classifyBookGaps({ ...base, positionsReadFailed: true, unreadHeld: ["GATO"] });
    assert.deepEqual(g.holdTick, ["positions"]);
    assert.deepEqual(g.incomplete, []);
  });

  it("nothing unread is nothing at all", () => {
    assert.deepEqual(classifyBookGaps(base), { holdTick: [], incomplete: [] });
  });
});

describe("unreadHeldOf — which unread coins the books say are held", () => {
  it("an open basis, or a lookup that threw (custody.ts unreadHeldOnRecord), is held", () => {
    assert.deepEqual(held({ unread: ["GATO", "NOCODE"], basisOnRecord: ["GATO"] }), ["GATO"]);
  });

  it("THE TRENCHER VAULT'S OWN tokens() is on record — the GATO case, whose basis was closed while the vault held every unit", () => {
    assert.deepEqual(held({ unread: ["GATO", "NOCODE"], vaultTokens: [GATO.toLowerCase()] }), ["GATO"]);
    // Whatever case either side is spelled in.
    assert.deepEqual(held({ unread: ["GATO"], vaultTokens: [GATO.toUpperCase().replace("0X", "0x")] }), ["GATO"]);
  });

  it("held on the last live tick is on record — the no-basis holding #383 let drop out of equity", () => {
    assert.deepEqual(held({ unread: ["DELTA", "NOCODE"], lastLiveHeld: new Set(["DELTA"]) }), ["DELTA"]);
  });

  it("read as held by the other custody THIS tick is on record — otherwise the half that answered is a partial balance", () => {
    assert.deepEqual(held({ unread: ["GATO"], heldThisTick: new Set(["GATO"]) }), ["GATO"]);
  });

  it("A COIN WITH NONE OF THESE IS LEFT OUT, as #383 decided: a no-code address fails every tick, and must not refuse every buy for good", () => {
    assert.deepEqual(held({ unread: ["NOCODE"] }), []);
  });

  it("only unread coins come back, once each, sorted — evidence about a coin that read is not a gap", () => {
    const got = held({
      unread: ["GATO", "DELTA", "GATO"],
      basisOnRecord: ["GATO", "AAPL"],
      lastLiveHeld: new Set(["DELTA", "AAPL"]),
      heldThisTick: new Set(["AAPL"]),
    });
    assert.deepEqual(got, ["DELTA", "GATO"]);
  });
});

describe("withoutUnreadHeld — never a partial holding", () => {
  type P = { symbol: string; rawBalance: bigint };
  const book = (): { positions: P[]; missingPrice: string[]; unpricedByDesign: string[] } => ({
    // GATO's VAULT half read; its account half did not. It must not stay at the half.
    positions: [{ symbol: "AAPL", rawBalance: 5n }, { symbol: "GATO", rawBalance: 1_000n }],
    missingPrice: ["NVDA", "GATO"],
    unpricedByDesign: ["DELTA", "GATO"],
  });

  it("strips an unread-held coin from all three lists, whole", () => {
    const out = withoutUnreadHeld(book(), ["GATO"]);
    assert.deepEqual(out.positions.map((p) => p.symbol), ["AAPL"]);
    assert.deepEqual(out.missingPrice, ["NVDA"]);
    assert.deepEqual(out.unpricedByDesign, ["DELTA"], "never carried at cost through the quarantine either");
  });

  it("leaves everything else exactly as it was, in order", () => {
    const b = book();
    const out = withoutUnreadHeld(b, ["DELTA"]);
    assert.deepEqual(out.positions, b.positions);
    assert.deepEqual(out.missingPrice, b.missingPrice);
    assert.deepEqual(out.unpricedByDesign, ["GATO"]);
  });

  it("nothing unread hands back the very same book", () => {
    const b = book();
    assert.equal(withoutUnreadHeld(b, []), b);
  });
});

describe("heldUnreadOf — what the wall is handed", () => {
  it("by symbol, sorted, and by lowercased address for the sale check", () => {
    const h = heldUnreadOf(["GATO", "DELTA"], WATCH);
    assert.deepEqual(h.symbols, ["DELTA", "GATO"]);
    assert.equal(h.tokens.get(GATO.toLowerCase()), "GATO");
    assert.equal(h.tokens.get("0x00000000000000000000000000000000000000d7"), "DELTA");
    assert.equal(h.tokens.size, 2);
  });

  it("nothing unread is the empty value, which refuses nothing", () => {
    assert.equal(heldUnreadOf([], WATCH), NO_HELD_UNREAD);
    assert.deepEqual(NO_HELD_UNREAD.symbols, []);
    assert.equal(NO_HELD_UNREAD.tokens.size, 0);
  });
});

describe("unreadHeldNotice — once per change, with the remedy that applies", () => {
  const vault = new Set(["GATO"]);

  it("the first sight warns, names the coin, says exits-only and that it is a data gap", () => {
    const n = unreadHeldNotice("", ["DELTA"], vault);
    assert.equal(n.key, "DELTA");
    assert.equal(n.event?.level, "warn");
    const t = n.event?.text ?? "";
    assert.match(t, /DELTA/);
    assert.match(t, /exits-only/);
    assert.match(t, /nothing new is bought/);
    assert.match(t, /stop-losses, take-profits and sells of everything else still go out/);
    assert.match(t, /data gap, not a loss/);
  });

  it("the same set again says nothing — not once per tick", () => {
    assert.equal(unreadHeldNotice("DELTA", ["DELTA"], vault).event, null);
    assert.equal(unreadHeldNotice("DELTA,GATO", ["GATO", "DELTA"], vault).event, null, "the key is sorted");
  });

  it("A WALLET COIN is pointed at Settings, or unwatching it — and told what unwatching costs", () => {
    const t = unreadHeldNotice("", ["DELTA"], vault).event?.text ?? "";
    assert.match(t, /check DELTA's token address in Settings/);
    assert.match(t, /stop watching it/);
    assert.doesNotMatch(t, /contact support/);
  });

  it("A TRENCHER VAULT COIN cannot be unwatched, so it is told so, plainly, and to contact support", () => {
    const t = unreadHeldNotice("", ["GATO"], vault).event?.text ?? "";
    assert.match(t, /Trencher vault's own token list/);
    assert.match(t, /cannot be unwatched/);
    assert.match(t, /failing on-chain/);
    assert.match(t, /contact support/);
    assert.doesNotMatch(t, /Settings/);
  });

  it("both kinds at once carry both remedies, and the set names every coin", () => {
    const n = unreadHeldNotice("GATO", ["GATO", "DELTA"], vault);
    assert.equal(n.key, "DELTA,GATO");
    assert.equal(n.event?.level, "warn");
    const t = n.event?.text ?? "";
    assert.match(t, /DELTA and GATO balance/);
    assert.match(t, /Settings/);
    assert.match(t, /contact support/);
  });

  it("ONE ok WHEN IT EMPTIES, naming what reads again — and claiming nothing about anything else", () => {
    const n = unreadHeldNotice("DELTA,GATO", [], vault);
    assert.equal(n.key, "");
    assert.equal(n.event?.level, "ok");
    assert.match(n.event?.text ?? "", /I can read DELTA and GATO again/);
    assert.doesNotMatch(n.event?.text ?? "", /breaker/, "an unread venue or an unknown cost may still hold the book");
    assert.equal(unreadHeldNotice("", [], vault).event, null, "and nothing when there was nothing");
  });
});

describe("shownEquityOf and the heartbeat drawdown — never a phantom loss from a partial sum", () => {
  const WHOLE = { equityUsdg: 1_000_000_000n, shortOfHolding: false };

  it("a complete book shows itself", () => {
    assert.deepEqual(shownEquityOf({ equityUsdg: 900_000_000n, complete: true, venueUnread: false, holdingUnread: false, last: WHOLE }), {
      equityUsdg: 900_000_000n,
      shortOfHolding: false,
    });
  });

  it("an unread holding keeps the LAST WHOLE figure shown, as an unread venue already did", () => {
    const shown = shownEquityOf({ equityUsdg: 400_000_000n, complete: false, venueUnread: false, holdingUnread: true, last: WHOLE });
    assert.deepEqual(shown, WHOLE);
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown }), 0);
  });

  it("THE RESTART CORNER: no whole figure yet, so the partial is shown — flagged, and the heartbeat says nothing about it", () => {
    const first = shownEquityOf({ equityUsdg: 400_000_000n, complete: false, venueUnread: false, holdingUnread: true, last: NOTHING_SHOWN });
    assert.deepEqual(first, { equityUsdg: 400_000_000n, shortOfHolding: true });
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: first }), null, "a 60% 'drawdown' nobody made");
    // Every tick after holds it — and stays silent — until a whole figure composes.
    const next = shownEquityOf({ equityUsdg: 380_000_000n, complete: false, venueUnread: false, holdingUnread: true, last: first });
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: next }), null);
    const whole = shownEquityOf({ equityUsdg: 950_000_000n, complete: true, venueUnread: false, holdingUnread: false, last: next });
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: whole }), 500);
  });

  it("NARROW: an unread venue or an unknown cost keeps today's heartbeat, partial or not", () => {
    const venue = shownEquityOf({ equityUsdg: 400_000_000n, complete: false, venueUnread: true, holdingUnread: false, last: NOTHING_SHOWN });
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: venue }), 6_000);
    const cost = shownEquityOf({ equityUsdg: 400_000_000n, complete: false, venueUnread: false, holdingUnread: false, last: WHOLE });
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: cost }), 6_000);
  });

  it("no peak, or nothing shown, is no figure — as before", () => {
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 0n, shown: WHOLE }), null);
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1n, shown: NOTHING_SHOWN }), null);
    assert.equal(heartbeatDrawdownBps({ peakUsdg: 1_000_000_000n, shown: { equityUsdg: 1_200_000_000n, shortOfHolding: false } }), 0);
  });
});
