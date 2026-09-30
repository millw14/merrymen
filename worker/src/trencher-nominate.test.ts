/**
 * NOMINATED COINS — what a Telegram group may hand to trading, and every cap
 * on it (docs/tg-groups.md, "The coin flow", "Trencher readiness",
 * "Nomination caps").
 *
 * The book is pure, so every edge is driven by an injected clock and a fake
 * of the store's day counters that behaves the way the durable one must: a
 * take is refused at the limit, a new UTC day starts from zero, and a refund
 * for a day that is no longer current gives nothing back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoinOutcome, Nomination, TrencherReadinessKind } from "./telegram/tg-groups/types";
import {
  NOMINATE,
  NominationBook,
  isCaAddress,
  safeNotes,
  trencherReadiness,
  type NominationCounters,
  type ReadinessInput,
  type ReviewedDecision,
} from "./trencher-nominate";

// ─── fixtures ───────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;

class FakeCounters implements NominationCounters {
  day = "";
  n = 0;
  entries = 0;
  log: string[] = [];
  throwOn: "take" | "entry" | "refund" | null = null;
  takeNomination(day: string, limit: number): boolean {
    this.log.push(`take:${day}:${limit}`);
    if (this.throwOn === "take") throw new Error("disk full");
    this.roll(day);
    if (this.n >= limit) return false;
    this.n++;
    return true;
  }
  takeGroupEntry(day: string, limit: number): boolean {
    this.log.push(`entry:${day}:${limit}`);
    if (this.throwOn === "entry") throw new Error("disk full");
    this.roll(day);
    if (this.entries >= limit) return false;
    this.entries++;
    return true;
  }
  refundGroupEntry(day: string): void {
    this.log.push(`refund:${day}`);
    if (this.throwOn === "refund") throw new Error("disk full");
    if (day !== this.day) return;
    this.entries = Math.max(0, this.entries - 1);
  }
  private roll(day: string) {
    if (day === this.day) return;
    this.day = day;
    this.n = 0;
    this.entries = 0;
  }
}

function setup(start = T0) {
  const clock = { t: start };
  const counters = new FakeCounters();
  const book = new NominationBook(counters, () => clock.t);
  return { clock, counters, book };
}

/** A distinct, valid, lowercase address per index (never the zero address). */
const addr = (i: number) => "0x" + (0xa0 + i).toString(16).padStart(40, "c");

let nextMessage = 1;
function nom(over: Partial<Nomination> = {}, now = T0): Nomination {
  return { address: addr(1), chatId: -100, messageId: nextMessage++, senderId: 7, atMs: now, ...over };
}

const hold = (over: Partial<ReviewedDecision> = {}): ReviewedDecision => ({
  action: "hold",
  decisionId: "dec_hold",
  holdKind: "MODEL_HOLD",
  thesis: "Flow looks one-sided and the setup is weak.",
  bullCase: "Buyers keep arriving.",
  bearCase: "Feels like the same few wallets passing it around.",
  risks: ["Liquidity is thin", "Sellers could show up fast"],
  ...over,
});

const buy = (over: Partial<ReviewedDecision> = {}): ReviewedDecision => ({
  action: "buy",
  decisionId: "dec_buy",
  holdKind: null,
  thesis: "New buyers keep showing up.",
  bullCase: "Two-sided flow with fresh wallets; up 40% in an hour.",
  bearCase: "Could fade.",
  risks: ["Thin"],
  ...over,
});

const READY_PAPER: TrencherReadinessKind = "ready-paper";

// ─── isCaAddress ────────────────────────────────────────────────────────────

describe("isCaAddress: 0x plus exactly forty hex", () => {
  it("accepts any letter case", () => {
    assert.ok(isCaAddress("0x" + "ab".repeat(20)));
    assert.ok(isCaAddress("0x" + "AB".repeat(20)));
    assert.ok(isCaAddress("0x" + "aB09".repeat(10)));
    assert.ok(isCaAddress("0X" + "ab".repeat(20)), "the /i flag covers the prefix too");
  });

  it("refuses everything that is not exactly that", () => {
    for (const bad of [
      "0x" + "a".repeat(39),
      "0x" + "a".repeat(41),
      "0x" + "a".repeat(64), // a tx hash or v4 pool id is never a CA
      "a".repeat(40),
      "0x" + "g".repeat(40),
      " 0x" + "a".repeat(40),
      "0x" + "a".repeat(40) + " ",
      "0x" + "a".repeat(40) + "\n",
      "look 0x" + "a".repeat(40),
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "",
    ]) assert.equal(isCaAddress(bad), false, JSON.stringify(bad));
  });

  it("is safe on a non-string at runtime", () => {
    assert.equal(isCaAddress(undefined as unknown as string), false);
    assert.equal(isCaAddress(42 as unknown as string), false);
  });
});

// ─── trencherReadiness ──────────────────────────────────────────────────────

const readyLive: ReadinessInput = {
  strategy: "trencher",
  assetMode: "crypto",
  trencherFastEnabled: true,
  brainUrl: "https://brain.example",
  brainToken: "tok",
  paper: false,
  hasTrencherGrant: true,
  trencherLiveEnabled: true,
};

describe("trencherReadiness: the first failing row wins", () => {
  const rows: [string, Partial<ReadinessInput>, TrencherReadinessKind][] = [
    ["strategy is not trencher", { strategy: "momentum" }, "off"],
    ["stocks only", { assetMode: "stocks" }, "stocks-only"],
    ["fast path off", { trencherFastEnabled: false }, "slow"],
    ["no Brain URL", { brainUrl: null }, "no-brain"],
    ["no Brain token", { brainToken: undefined }, "no-brain"],
    ["a whitespace Brain URL", { brainUrl: "   " }, "no-brain"],
    ["an empty Brain token", { brainToken: "" }, "no-brain"],
    ["live without the vault permission", { hasTrencherGrant: false }, "no-vault"],
    ["paper without the vault permission", { paper: true, hasTrencherGrant: false }, "no-vault"],
    ["live with the live switch off", { trencherLiveEnabled: false }, "live-off"],
    ["paper", { paper: true }, "ready-paper"],
    ["live, everything satisfied", {}, "ready-live"],
  ];
  for (const [name, over, kind] of rows) {
    it(`${name} → ${kind}`, () => {
      assert.equal(trencherReadiness({ ...readyLive, ...over }).kind, kind);
    });
  }

  it("asset mode all and crypto both allow trencher", () => {
    assert.equal(trencherReadiness({ ...readyLive, assetMode: "all" }).kind, "ready-live");
    assert.equal(trencherReadiness({ ...readyLive, assetMode: "crypto" }).kind, "ready-live");
  });

  it("the table's order decides when several rows fail", () => {
    const everythingWrong: ReadinessInput = {
      strategy: "momentum", assetMode: "stocks", trencherFastEnabled: false, brainUrl: null, brainToken: null,
      paper: false, hasTrencherGrant: false, trencherLiveEnabled: false,
    };
    assert.equal(trencherReadiness(everythingWrong).kind, "off");
    assert.equal(trencherReadiness({ ...everythingWrong, strategy: "trencher" }).kind, "stocks-only");
    assert.equal(trencherReadiness({ ...everythingWrong, strategy: "trencher", assetMode: "all" }).kind, "slow");
    assert.equal(trencherReadiness({ ...everythingWrong, strategy: "trencher", assetMode: "all", trencherFastEnabled: true }).kind, "no-brain");
    assert.equal(
      trencherReadiness({ ...everythingWrong, strategy: "trencher", assetMode: "all", trencherFastEnabled: true, brainUrl: "u", brainToken: "t" }).kind,
      "no-vault",
      "the vault row comes before the live switch",
    );
  });

  it("paper does not need the live switch", () => {
    assert.equal(trencherReadiness({ ...readyLive, paper: true, trencherLiveEnabled: false }).kind, "ready-paper");
  });

  it("paper still needs the vault permission: discovery only runs for a grant that carries it", () => {
    assert.equal(trencherReadiness({ ...readyLive, paper: true, hasTrencherGrant: false, trencherLiveEnabled: false }).kind, "no-vault");
  });

  it("paper still needs everything above the live rows", () => {
    assert.equal(trencherReadiness({ ...readyLive, paper: true, brainToken: null }).kind, "no-brain");
    assert.equal(trencherReadiness({ ...readyLive, paper: true, trencherFastEnabled: false }).kind, "slow");
  });

  it("anything but an explicit paper=true is treated as live (the stricter rows)", () => {
    const notSaid = { ...readyLive, hasTrencherGrant: false, paper: undefined as unknown as boolean };
    assert.equal(trencherReadiness(notSaid).kind, "no-vault");
  });

  it("every owner reason is one plain sentence with no figure", () => {
    const kinds: TrencherReadinessKind[] = ["off", "stocks-only", "slow", "no-brain", "no-vault", "live-off", "ready-paper", "ready-live"];
    const inputs: Record<TrencherReadinessKind, Partial<ReadinessInput>> = {
      "off": { strategy: "x" }, "stocks-only": { assetMode: "stocks" }, "slow": { trencherFastEnabled: false },
      "no-brain": { brainUrl: "" }, "no-vault": { hasTrencherGrant: false }, "live-off": { trencherLiveEnabled: false },
      "ready-paper": { paper: true }, "ready-live": {},
    };
    const seen = new Set<string>();
    for (const k of kinds) {
      const r = trencherReadiness({ ...readyLive, ...inputs[k] });
      assert.equal(r.kind, k);
      assert.ok(r.ownerReason.length > 20, `${k} has a real sentence`);
      assert.doesNotMatch(r.ownerReason, /\p{N}|[$%]/u, `${k}: no figure`);
      assert.equal(r.ownerReason.match(/[.!?](\s|$)/g)?.length, 1, `${k}: one sentence`);
      assert.ok(!seen.has(r.ownerReason), `${k} has its own reason`);
      seen.add(r.ownerReason);
    }
  });

  it("the reasons that need a fix name Settings, and the Brain one says what to add", () => {
    for (const k of ["off", "stocks-only", "slow", "no-brain", "no-vault", "live-off"] as const) {
      const input = { "off": { strategy: "x" }, "stocks-only": { assetMode: "stocks" }, "slow": { trencherFastEnabled: false },
        "no-brain": { brainUrl: "" }, "no-vault": { hasTrencherGrant: false }, "live-off": { trencherLiveEnabled: false } }[k];
      assert.match(trencherReadiness({ ...readyLive, ...input }).ownerReason, /Settings/);
    }
    assert.match(trencherReadiness({ ...readyLive, brainUrl: null }).ownerReason, /Brain URL and token/);
    assert.match(trencherReadiness({ ...readyLive, hasTrencherGrant: false }).ownerReason, /Autonomous Trencher/);
    assert.match(trencherReadiness({ ...readyLive, paper: true }).ownerReason, /paper/);
  });
});

// ─── safeNotes ──────────────────────────────────────────────────────────────

describe("safeNotes: clauses with no figure, no address, no link, no handle", () => {
  it("keeps clean clauses, trimmed and in order", () => {
    assert.deepEqual(
      safeNotes(["  Liquidity is thin.  Buyers are mostly the same wallets!  ", "Sellers could show up fast"]),
      ["Liquidity is thin", "Buyers are mostly the same wallets", "Sellers could show up fast"],
    );
  });

  it("splits on sentence ends, semicolons, slashes, dashes and line breaks", () => {
    assert.deepEqual(
      safeNotes(["thin book; one-sided flow / no real bid — late to the move – chasing\nfading momentum - crowded"]),
      ["thin book", "one-sided flow", "no real bid", "late to the move", "chasing", "fading momentum", "crowded"],
    );
  });

  it("drops the whole clause that carries a digit, keeping its neighbours", () => {
    assert.deepEqual(safeNotes(["Volume is real. Up 40 in an hour. Flow is two-sided."]), ["Volume is real", "Flow is two-sided"]);
    assert.deepEqual(safeNotes(["rug risk / 5x from here / thin book"]), ["rug risk", "thin book"]);
  });

  it("drops $, % and any currency sign", () => {
    assert.deepEqual(safeNotes(["costs $ matter; slippage is a % game; fee in € terms; paid in ₿; fine otherwise"]), ["fine otherwise"]);
    assert.deepEqual(safeNotes(["full-width ％ sign; kept"]), ["kept"]);
  });

  it("drops numerals in any script, not only ASCII digits", () => {
    assert.deepEqual(safeNotes(["up ３x; half-life of ½ day; Arabic ٣ here; clean"]), ["clean"]);
  });

  it("drops 0x hex runs and base58 runs of 26 or more", () => {
    const ca = "0x" + "ab".repeat(20);
    assert.deepEqual(safeNotes([`deployer ${ca} holds a lot; clean one`]), ["clean one"]);
    assert.deepEqual(safeNotes(["mint 7xKXtgCWdTXJSDpbDjBkheTqAZRuJosgAsUabcdefghj is elsewhere; clean"]), ["clean"]);
    // 25 base58 characters is not a run.
    assert.deepEqual(safeNotes(["abcdefghijkmnopqrstuvwxyz stays"]), ["abcdefghijkmnopqrstuvwxyz stays"]);
    assert.deepEqual(safeNotes(["abcdefghijkmnopqrstuvwxyzA goes; kept"]), ["kept"]);
  });

  it("a zero-width character cannot split a mint into two short runs", () => {
    const mint = "xKXtgCWdTXJSDpbDjBkheTqAZRuJosgAsU";
    const split = mint.slice(0, 17) + "​" + mint.slice(17);
    assert.deepEqual(safeNotes([`sent to ${split}; clean`]), ["clean"]);
  });

  it("drops links, and no fragment of one survives the slash split", () => {
    const out = safeNotes([
      "see https://dexscreener.com/robinhood/abc/def for the chart; trust the tape",
      "www.geckoterminal.com/robinhood/pools; also pump.fun/coin is where it came from",
      "t.me/somegroup/abc said so / node.js dropped too / clean clause",
    ]);
    assert.deepEqual(out, ["trust the tape", "clean clause"]);
    for (const n of out) assert.doesNotMatch(n, /robinhood|dexscreener|gecko|pump|t\.me|com/i);
  });

  it("drops @handles, emails, hashtags and instrument ids", () => {
    assert.deepEqual(safeNotes(["@whale is buying; mail dev@coin.xyz; #moon season; rh:TSLA-like; nothing personal"]), ["nothing personal"]);
  });

  it("drops quantities spelled out, but not the pronoun one", () => {
    assert.deepEqual(
      safeNotes(["forty buyers; doubled overnight; a tenfold move; half the book; a dozen wallets; five percent; this one feels crowded"]),
      ["this one feels crowded"],
    );
  });

  it("two-sided and one-sided flow are trading words, not figures; other compounds still drop", () => {
    assert.deepEqual(
      safeNotes(["Two-sided flow with fresh wallets; one-sided selling; a two-way market; a hundred-dollar bid; twenty-five buyers"]),
      ["Two-sided flow with fresh wallets", "one-sided selling", "a two-way market"],
    );
    assert.deepEqual(safeNotes(["two-sided flow from two wallets"]), [], "the exemption covers the compound, not the clause");
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    assert.deepEqual(safeNotes(["Thin book. thin book", "THIN BOOK; new idea"]), ["Thin book", "new idea"]);
  });

  it("skips null, undefined, empty strings and letterless fragments", () => {
    assert.deepEqual(safeNotes([null, undefined, "", "   ", "...", "- ; —", "real clause"]), ["real clause"]);
    assert.deepEqual(safeNotes([]), []);
  });

  it("stops at maxChars, counted as joined by single spaces, never clipping a clause", () => {
    const a = "a".repeat(10), b = "b".repeat(10), c = "c".repeat(10);
    // 10 + 1 + 10 = 21; the third needs 11 more.
    assert.deepEqual(safeNotes([`${a}; ${b}; ${c}`], 21), [a, b]);
    assert.deepEqual(safeNotes([`${a}; ${b}; ${c}`], 32), [a, b, c]);
    assert.deepEqual(safeNotes([`${a}; ${b}; ${c}`], 31), [a, b]);
    // It stops rather than skipping ahead to a shorter clause that would fit.
    assert.deepEqual(safeNotes([`${a}; a long clause with many words that cannot fit; ok`], 30), [a]);
    assert.deepEqual(safeNotes([`${a}`], 0), []);
  });

  it("defaults to 400 characters in total", () => {
    const clauses = Array.from({ length: 40 }, (_, i) => "clause " + "abcdefghijklmnopqrstuvwxyz".slice(0, 1 + (i % 25)) + " end");
    const out = safeNotes([clauses.join("; ")]);
    assert.ok(out.join(" ").length <= 400);
    assert.ok(out.join(" ").length > 350, "fills close to the budget");
  });
});

// ─── nominate: refusals ─────────────────────────────────────────────────────

describe("nominate: what it refuses, and in what order", () => {
  it("queues a valid nomination and lowercases its address", () => {
    const { book } = setup();
    const upper = "0x" + "AB".repeat(20);
    assert.deepEqual(book.nominate(nom({ address: upper }), READY_PAPER), { ok: true });
    assert.equal(book.active()?.address, upper.toLowerCase());
    assert.equal(book.nominated(upper)?.address, upper.toLowerCase());
  });

  it("refuses an address that is not a CA, and the zero address", () => {
    const { book, counters } = setup();
    for (const address of ["0x" + "a".repeat(64), "0x123", "not an address", "0x" + "0".repeat(40), ""]) {
      assert.deepEqual(book.nominate(nom({ address }), READY_PAPER), { ok: false, reason: "invalid" }, address);
    }
    assert.equal(counters.log.length, 0, "no counter touched");
  });

  it("refuses non-integer ids and a non-finite time", () => {
    const { book } = setup();
    assert.deepEqual(book.nominate(nom({ chatId: 1.5 }), READY_PAPER), { ok: false, reason: "invalid" });
    assert.deepEqual(book.nominate(nom({ messageId: Number.NaN }), READY_PAPER), { ok: false, reason: "invalid" });
    assert.deepEqual(book.nominate(nom({ senderId: "7" as unknown as number }), READY_PAPER), { ok: false, reason: "invalid" });
    assert.deepEqual(book.nominate(nom({ atMs: Number.POSITIVE_INFINITY }), READY_PAPER), { ok: false, reason: "invalid" });
  });

  it("refuses every readiness that is not ready", () => {
    for (const k of ["off", "stocks-only", "slow", "no-brain", "no-vault", "live-off"] as const) {
      const { book, counters } = setup();
      assert.deepEqual(book.nominate(nom(), k), { ok: false, reason: "not-ready" }, k);
      assert.equal(counters.log.length, 0);
    }
    const { book } = setup();
    assert.deepEqual(book.nominate(nom({ address: addr(1) }), "ready-live"), { ok: true });
    assert.deepEqual(book.nominate(nom({ address: addr(2), chatId: -200, senderId: 8 }), "ready-paper"), { ok: true });
  });

  it("an invalid address is refused as invalid even when not ready", () => {
    const { book } = setup();
    assert.deepEqual(book.nominate(nom({ address: "nope" }), "off"), { ok: false, reason: "invalid" });
  });

  it("a message older than ten minutes is invalid; exactly ten minutes is not", () => {
    const { book } = setup();
    assert.deepEqual(book.nominate(nom({ address: addr(1), atMs: T0 - NOMINATE.staleMessageMs - 1 }), READY_PAPER), { ok: false, reason: "invalid" });
    assert.deepEqual(book.nominate(nom({ address: addr(1), atMs: T0 - NOMINATE.staleMessageMs }), READY_PAPER), { ok: true });
  });

  it("a message dated far in the future is invalid", () => {
    const { book } = setup();
    assert.deepEqual(book.nominate(nom({ atMs: T0 + NOMINATE.staleMessageMs + 1 }), READY_PAPER), { ok: false, reason: "invalid" });
    assert.deepEqual(book.nominate(nom({ atMs: T0 + 5_000 }), READY_PAPER), { ok: true }, "a little clock skew is fine");
  });

  it("an address already pending is recent, from any chat, and costs nothing", () => {
    const { book, counters } = setup();
    assert.ok(book.nominate(nom({ address: addr(1) }), READY_PAPER).ok);
    const takes = counters.n;
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -999, senderId: 99 }), READY_PAPER), { ok: false, reason: "recent" });
    assert.equal(counters.n, takes);
  });

  it("an address with a verdict in the last six hours is recent; at six hours it is not", () => {
    const { book, clock } = setup();
    assert.ok(book.nominate(nom({ address: addr(1) }), READY_PAPER).ok);
    assert.equal(book.onReviewed(addr(1), hold())?.kind, "passed");
    clock.t = T0 + NOMINATE.reNominateMs - 1;
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -300, senderId: 30 }, clock.t), READY_PAPER), { ok: false, reason: "recent" });
    clock.t = T0 + NOMINATE.reNominateMs;
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -300, senderId: 30 }, clock.t), READY_PAPER), { ok: true });
  });

  it("per chat: four an hour, on a rolling window", () => {
    const { book, clock } = setup();
    for (let i = 0; i < 4; i++) {
      assert.ok(book.nominate(nom({ address: addr(10 + i), senderId: 100 + i }), READY_PAPER).ok, `#${i}`);
      book.onReviewed(addr(10 + i), hold({ decisionId: `d${i}` })); // free the queue
    }
    assert.deepEqual(book.nominate(nom({ address: addr(20), senderId: 200 }), READY_PAPER), { ok: false, reason: "chat-rate" });
    assert.ok(book.nominate(nom({ address: addr(21), chatId: -555, senderId: 201 }), READY_PAPER).ok, "another chat is not affected");
    clock.t = T0 + HOUR - 1;
    assert.deepEqual(book.nominate(nom({ address: addr(20), senderId: 200 }, clock.t), READY_PAPER), { ok: false, reason: "chat-rate" });
    clock.t = T0 + HOUR;
    assert.deepEqual(book.nominate(nom({ address: addr(20), senderId: 200 }, clock.t), READY_PAPER), { ok: true }, "an hour-old one has left the window");
  });

  it("per sender: two an hour, across chats, on a rolling window", () => {
    const { book, clock } = setup();
    assert.ok(book.nominate(nom({ address: addr(1), chatId: -1 }), READY_PAPER).ok);
    clock.t = T0 + 20 * MIN;
    assert.ok(book.nominate(nom({ address: addr(2), chatId: -2 }, clock.t), READY_PAPER).ok);
    assert.deepEqual(book.nominate(nom({ address: addr(3), chatId: -3 }, clock.t), READY_PAPER), { ok: false, reason: "sender-rate" });
    assert.ok(book.nominate(nom({ address: addr(3), chatId: -3, senderId: 8 }, clock.t), READY_PAPER).ok, "another sender is not affected");
    clock.t = T0 + HOUR - 1;
    assert.deepEqual(book.nominate(nom({ address: addr(4), chatId: -4 }, clock.t), READY_PAPER), { ok: false, reason: "sender-rate" });
    clock.t = T0 + HOUR;
    assert.deepEqual(book.nominate(nom({ address: addr(4), chatId: -4 }, clock.t), READY_PAPER), { ok: true }, "the first one left the window");
    assert.deepEqual(book.nominate(nom({ address: addr(5), chatId: -5 }, clock.t), READY_PAPER), { ok: false, reason: "sender-rate" }, "the second is still in it");
  });

  it("the chat window is checked before the sender window", () => {
    const { book } = setup();
    for (let i = 0; i < 4; i++) {
      assert.ok(book.nominate(nom({ address: addr(30 + i), senderId: i < 2 ? 7 : 50 + i }), READY_PAPER).ok);
      book.onReviewed(addr(30 + i), hold());
    }
    assert.deepEqual(book.nominate(nom({ address: addr(40), senderId: 7 }), READY_PAPER), { ok: false, reason: "chat-rate" });
  });

  it("refusals do not fill the rolling windows", () => {
    const { book } = setup();
    // Five refused attempts from one sender in one chat...
    for (let i = 0; i < 5; i++) assert.equal(book.nominate(nom({ address: "bad" }), READY_PAPER).ok, false);
    for (let i = 0; i < 5; i++) assert.equal(book.nominate(nom(), "off").ok, false);
    // ...and the sender still has both of their hour's nominations.
    assert.ok(book.nominate(nom({ address: addr(1) }), READY_PAPER).ok);
    assert.ok(book.nominate(nom({ address: addr(2) }), READY_PAPER).ok);
  });

  it("the queue holds five; the sixth is busy and spends no day's nomination", () => {
    const { book, counters } = setup();
    for (let i = 0; i < NOMINATE.queueMax; i++) {
      assert.ok(book.nominate(nom({ address: addr(i + 1), chatId: -(i + 1), senderId: i + 1 }), READY_PAPER).ok);
    }
    const before = counters.n;
    assert.deepEqual(book.nominate(nom({ address: addr(9), chatId: -9, senderId: 9 }), READY_PAPER), { ok: false, reason: "busy" });
    assert.equal(counters.n, before, "busy is decided before the durable counter");
    // A resolved one frees a place.
    book.onReviewed(addr(1), hold());
    assert.ok(book.nominate(nom({ address: addr(9), chatId: -9, senderId: 9 }), READY_PAPER).ok);
  });

  it("a nomination awaiting its fill still holds its place in the queue", () => {
    const { book } = setup();
    for (let i = 0; i < NOMINATE.queueMax; i++) book.nominate(nom({ address: addr(i + 1), chatId: -(i + 1), senderId: i + 1 }), READY_PAPER);
    book.onReviewed(addr(1), buy());
    assert.deepEqual(book.nominate(nom({ address: addr(9), chatId: -9, senderId: 9 }), READY_PAPER), { ok: false, reason: "busy" });
  });

  it("twelve a UTC day through the durable counter, then daily; a new day starts again", () => {
    const { book, clock, counters } = setup(Date.UTC(2026, 8, 28, 20, 0, 0));
    const start = clock.t;
    let i = 0;
    const one = () => {
      i++;
      const r = book.nominate(nom({ address: addr(100 + i), chatId: -(1000 + i), senderId: 1000 + i }, clock.t), READY_PAPER);
      if (r.ok) book.onReviewed(addr(100 + i), hold());
      return r;
    };
    for (let k = 0; k < NOMINATE.perDay; k++) assert.deepEqual(one(), { ok: true }, `#${k}`);
    assert.deepEqual(one(), { ok: false, reason: "daily" });
    assert.ok(counters.log.every((l) => l === `take:2026-09-28:${NOMINATE.perDay}`), counters.log.join());
    // Still the same UTC day one second before midnight.
    clock.t = Date.UTC(2026, 8, 28, 23, 59, 59);
    assert.deepEqual(one(), { ok: false, reason: "daily" });
    clock.t = Date.UTC(2026, 8, 29, 0, 0, 0);
    assert.deepEqual(one(), { ok: true });
    assert.equal(counters.log.at(-1), `take:2026-09-29:${NOMINATE.perDay}`);
    assert.ok(clock.t > start);
  });

  it("a counter that throws is a refusal, never a nomination", () => {
    const { book, counters } = setup();
    counters.throwOn = "take";
    assert.deepEqual(book.nominate(nom(), READY_PAPER), { ok: false, reason: "daily" });
    assert.equal(book.active(), null);
  });

  it("a replayed post is refused and costs nothing: recent while pending, recent after its verdict, invalid once stale", () => {
    const { book, clock, counters } = setup();
    const post = nom({ address: addr(1), messageId: 4242 });
    assert.deepEqual(book.nominate(post, READY_PAPER), { ok: true });
    const takes = counters.log.length;
    assert.deepEqual(book.nominate({ ...post }, READY_PAPER), { ok: false, reason: "recent" });
    clock.t = T0 + 2 * MIN;
    book.onReviewed(addr(1), hold());
    assert.deepEqual(book.nominate({ ...post }, READY_PAPER), { ok: false, reason: "recent" });
    clock.t = T0 + NOMINATE.staleMessageMs + 1;
    assert.deepEqual(book.nominate({ ...post }, READY_PAPER), { ok: false, reason: "invalid" });
    assert.equal(counters.log.length, takes, "no replay touched the day counter");
    // And the sender's window still holds only the one real nomination.
    assert.ok(book.nominate(nom({ address: addr(2) }, clock.t), READY_PAPER).ok);
  });

  it("does not keep a reference to the caller's object", () => {
    const { book } = setup();
    const n = nom({ address: addr(1) });
    book.nominate(n, READY_PAPER);
    n.address = addr(2);
    n.chatId = 1;
    assert.equal(book.active()?.address, addr(1));
    assert.equal(book.active()?.chatId, -100);
    const got = book.active()!;
    got.address = addr(3);
    assert.equal(book.active()?.address, addr(1), "nor hands one out");
  });

  it("keeps the address and ids only: message text smuggled on the object never reaches trading", () => {
    // The type says five fields; a caller at run time can hand over more. The
    // book copies the five (rule 1: nothing but a validated address and where
    // it came from crosses), so nothing it hands on or reports can carry the
    // words, the sender's name or the chat's title.
    const { book } = setup();
    const smuggled = { ...nom({ address: addr(1) }), text: "ape 100 into this now", name: "ann", chatTitle: "frog pond" };
    assert.ok(book.nominate(smuggled as Nomination, READY_PAPER).ok);
    const { address, chatId, messageId, senderId, atMs } = smuggled;
    assert.deepEqual(book.active(), { address, chatId, messageId, senderId, atMs });
    assert.deepEqual(book.nominated(addr(1)), { address, chatId, messageId, senderId, atMs });
    const outcome = book.onReviewed(addr(1), hold());
    const seen = JSON.stringify([book.active(), book.nominated(addr(1)), outcome]);
    for (const s of ["ape 100", "ann", "frog pond"]) assert.ok(!seen.includes(s), `the book kept "${s}"`);
  });
});

// ─── one under review, and its priority ─────────────────────────────────────

describe("one nomination under review at a time", () => {
  it("active is the oldest waiting one, and priority holds every waiting one in queue order", () => {
    // Not only the head: the chat-side look does not pre-screen depth, flow or
    // discovery's verification, so the head may never be eligible at the
    // tick, and a hint naming only it would starve the coins behind it
    // until their TTL (the reviewer takes the first ELIGIBLE one).
    const { book } = setup();
    assert.equal(book.active(), null);
    assert.equal(book.priority().size, 0);
    book.nominate(nom({ address: addr(3), chatId: -3, senderId: 3 }), READY_PAPER);
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 2 }), READY_PAPER);
    assert.equal(book.active()?.address, addr(3));
    assert.deepEqual([...book.priority()], [addr(3), addr(1), addr(2)]);
  });

  it("priority leaves out a nomination past its TTL even while its claimed entry keeps it for the fill", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs;
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 2 }, clock.t), READY_PAPER);
    assert.deepEqual([...book.priority()], [addr(2)]);
    assert.equal(book.active()?.address, addr(2));
  });

  it("a BUY ends the review: the next one becomes active while the first waits for its fill", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 2 }), READY_PAPER);
    assert.equal(book.onReviewed(addr(1), buy()), null);
    assert.equal(book.active()?.address, addr(2));
    assert.deepEqual([...book.priority()], [addr(2)]);
    assert.equal(book.nominated(addr(1))?.address, addr(1), "still nominated until its fill");
  });

  it("a verdict takes a coin out of priority, and nothing is left when the queue empties", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 2 }), READY_PAPER);
    assert.deepEqual([...book.priority()], [addr(1), addr(2)]);
    book.onReviewed(addr(1), hold());
    assert.deepEqual([...book.priority()], [addr(2)]);
    book.onReviewed(addr(2), hold({ action: "sell" }));
    assert.equal(book.active(), null);
    assert.equal(book.priority().size, 0);
    assert.equal(book.nominated(addr(1)), null);
  });

  it("nominated() is case-insensitive and null for anything else", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    assert.equal(book.nominated(addr(1).toUpperCase().replace("0X", "0x"))?.address, addr(1));
    assert.equal(book.nominated(addr(2)), null);
    assert.equal(book.nominated("garbage"), null);
  });
});

// ─── reviews and fills ──────────────────────────────────────────────────────

describe("onReviewed: a Brain view becomes an outcome", () => {
  it("HOLD → passed, grounded in the bear case and risks, with no figure", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -42, messageId: 777 }), READY_PAPER);
    const o = book.onReviewed(addr(1), hold({
      decisionId: "dec_1",
      bearCase: "Same few wallets passing it around. Down 30% from the top.",
      risks: ["Liquidity is thin", "Dev holds $40k", "Liquidity is thin"],
    }));
    assert.deepEqual(o, {
      kind: "passed", address: addr(1), chatId: -42, messageId: 777, decisionId: "dec_1",
      notes: ["Same few wallets passing it around", "Liquidity is thin"],
    });
  });

  it("SELL → passed too", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    assert.equal(book.onReviewed(addr(1), hold({ action: "sell", decisionId: "dec_s" }))?.kind, "passed");
  });

  it("falls back to the thesis when the bear case and risks leave nothing safe", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    const o = book.onReviewed(addr(1), hold({ bearCase: "Down 40%.", risks: ["$5k liquidity"], thesis: "Flow is one-sided." }));
    assert.equal(o?.kind, "passed");
    assert.deepEqual(o && "notes" in o ? o.notes : null, ["Flow is one-sided"]);
  });

  it("passes with empty notes when nothing at all is safe", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    const o = book.onReviewed(addr(1), hold({ bearCase: null, risks: null, thesis: "Up 12% on 3 buyers." }));
    assert.deepEqual(o && "notes" in o ? o.notes : null, []);
  });

  for (const holdKind of ["GATE_FORCED_HOLD", "STALE_MARK_HOLD"]) {
    it(`a ${holdKind} is not a market view → skipped, with no notes`, () => {
      const { book } = setup();
      book.nominate(nom({ address: addr(1), chatId: -5, messageId: 55 }), READY_PAPER);
      const o = book.onReviewed(addr(1), hold({ holdKind, decisionId: "dec_g" }));
      assert.deepEqual(o, { kind: "skipped", address: addr(1), chatId: -5, messageId: 55, decisionId: "dec_g" });
    });
  }

  it("a MODEL_HOLD or no hold kind is a real view", () => {
    for (const holdKind of ["MODEL_HOLD", null, undefined]) {
      const { book } = setup();
      book.nominate(nom({ address: addr(1) }), READY_PAPER);
      assert.equal(book.onReviewed(addr(1), hold({ holdKind }))?.kind, "passed", String(holdKind));
    }
  });

  it("a review of an address nobody nominated says nothing", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    assert.equal(book.onReviewed(addr(2), hold()), null);
    assert.equal(book.onReviewed(addr(2), buy()), null);
    assert.equal(book.active()?.address, addr(1));
  });

  it("an outcome is given once: a second review of a resolved nomination says nothing", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    assert.equal(book.onReviewed(addr(1), hold())?.kind, "passed");
    assert.equal(book.onReviewed(addr(1), hold()), null);
    assert.equal(book.onReviewed(addr(1), buy()), null);
  });

  it("a review matches by address even when the nomination is queued, not active", () => {
    // The rotation may review a coin on its own before the nomination's turn.
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 2 }), READY_PAPER);
    assert.equal(book.onReviewed(addr(2), hold())?.kind, "passed");
    assert.equal(book.active()?.address, addr(1));
  });

  it("a BUY with no decision id can never be taken → skipped", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 11 }), READY_PAPER);
    assert.deepEqual(book.onReviewed(addr(1), buy({ decisionId: "" })), { kind: "skipped", address: addr(1), chatId: -1, messageId: 11 });
  });
});

describe("onFill: only a landed or paper fill is a buy", () => {
  function bought(status: string, paper: boolean) {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -9, messageId: 99 }), READY_PAPER);
    assert.equal(book.onReviewed(addr(1), buy({ decisionId: "dec_b" })), null, "a BUY says nothing yet");
    return { book, o: book.onFill("dec_b", status, paper) };
  }

  it("landed → bought, with notes from the thesis and bull case, no figure", () => {
    const { o } = bought("landed", false);
    assert.deepEqual(o, {
      kind: "bought", address: addr(1), chatId: -9, messageId: 99, paper: false, decisionId: "dec_b",
      notes: ["New buyers keep showing up", "Two-sided flow with fresh wallets"],
    });
  });

  it("paper → bought on paper", () => {
    const { o } = bought("paper", true);
    assert.equal(o?.kind === "bought" && o.paper, true);
  });

  it("paper is said if either the status or the caller says paper", () => {
    assert.equal((bought("paper", false).o as { paper: boolean }).paper, true);
    assert.equal((bought("landed", true).o as { paper: boolean }).paper, true);
  });

  it("submitted is not an answer yet; the later landing is", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.onFill("dec_b", "submitted", false), null);
    assert.equal(book.nominated(addr(1))?.address, addr(1));
    assert.equal(book.onFill("dec_b", "landed", false)?.kind, "bought");
    assert.equal(book.onFill("dec_b", "landed", false), null, "once");
    assert.equal(book.nominated(addr(1)), null);
  });

  for (const status of ["reverted", "rejected", "dropped", "something-new", ""]) {
    it(`${JSON.stringify(status)} → skipped, never the reason`, () => {
      const { book } = setup();
      book.nominate(nom({ address: addr(1), chatId: -9, messageId: 99 }), READY_PAPER);
      book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
      assert.deepEqual(book.onFill("dec_b", status, false), { kind: "skipped", address: addr(1), chatId: -9, messageId: 99, decisionId: "dec_b" });
    });
  }

  it("a fill for an unknown decision says nothing", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.onFill("dec_other", "landed", false), null);
    assert.equal(book.onFill("", "landed", false), null);
    assert.equal(book.nominated(addr(1))?.address, addr(1));
  });

  it("after a BUY, a later HOLD is ignored: a fill for the BUY may be in flight", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.onReviewed(addr(1), hold()), null);
    assert.equal(book.onReviewed(addr(1), hold({ holdKind: "GATE_FORCED_HOLD" })), null);
    assert.equal(book.onFill("dec_b", "landed", false)?.kind, "bought");
  });

  it("after a BUY, a later BUY adds its id: either fill is matched, only once", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_1" }));
    book.onReviewed(addr(1), buy({ decisionId: "dec_2", thesis: "Second look, still likes it." }));
    const o = book.onFill("dec_2", "paper", true);
    assert.equal(o?.kind, "bought");
    assert.deepEqual(o && "notes" in o ? o.notes : null, ["Second look, still likes it", "Two-sided flow with fresh wallets"]);
    assert.equal(book.onFill("dec_1", "landed", false), null, "the other id no longer speaks for it");
  });

  it("a verdict from a fill starts the re-nominate clock", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy());
    book.onFill("dec_buy", "rejected", false);
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -2, senderId: 2 }), READY_PAPER), { ok: false, reason: "recent" });
  });
});

// ─── TTL, reset, exit ───────────────────────────────────────────────────────

describe("expire: the TTL sweep", () => {
  it("nothing expires a millisecond early; at the TTL it is expired, and the queue is freed", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 10, senderId: 1 }), READY_PAPER);
    clock.t = T0 + 5 * MIN;
    book.nominate(nom({ address: addr(2), chatId: -2, messageId: 20, senderId: 2 }, clock.t), READY_PAPER);
    clock.t = T0 + NOMINATE.ttlMs - 1;
    assert.deepEqual(book.expire(), []);
    clock.t = T0 + NOMINATE.ttlMs;
    assert.deepEqual(book.expire(), [{ kind: "expired", address: addr(1), chatId: -1, messageId: 10 }]);
    assert.equal(book.active()?.address, addr(2));
    assert.deepEqual(book.expire(), [], "said once");
  });

  it("a nomination awaiting its fill expires on the same TTL, and a late fill says nothing", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    clock.t = T0 + NOMINATE.ttlMs;
    assert.equal(book.expire()[0]?.kind, "expired");
    assert.equal(book.onFill("dec_b", "landed", false), null);
    assert.equal(book.onExit(addr(1)), null, "not remembered as bought");
  });

  it("a claimed entry in flight outlives the TTL: a fill just past it is told as a buy and remembered for the exit", () => {
    // BUY at ttl-20s, the entry claimed at ttl-10s, its live receipt at
    // ttl+10s. Ended by the TTL, the group would hear "sat this one out"
    // about a coin just bought, and the exit line would never come.
    const { book, clock, counters } = setup();
    book.nominate(nom({ address: addr(1), chatId: -9, messageId: 99 }), READY_PAPER);
    clock.t = T0 + NOMINATE.ttlMs - 20_000;
    assert.equal(book.onReviewed(addr(1), buy({ decisionId: "dec_b" })), null);
    clock.t = T0 + NOMINATE.ttlMs - 10_000;
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs + 10_000;
    assert.deepEqual(book.expire(), [], "not expired while its entry is in flight");
    const o = book.onFill("dec_b", "landed", false);
    assert.equal(o?.kind, "bought");
    assert.equal(o?.kind === "bought" && o.paper, false);
    assert.deepEqual(book.expire(), [], "one outcome, never a second");
    book.refundEntry(addr(1));
    assert.equal(counters.entries, 1, "the claim is spent by the fill");
    assert.equal(book.onExit(addr(1))?.kind, "exited", "remembered as bought");
  });

  it("past the TTL, a nomination kept for its fill starts nothing new", () => {
    // The grace is for the entry already claimed: no second claim, no
    // review answer, not group-sourced for a new entry, not in priority.
    const { book, clock, counters } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs;
    const takes = counters.log.filter((l) => l.startsWith("entry")).length;
    assert.equal(book.claimEntry(addr(1)), "not-nominated");
    assert.equal(counters.log.filter((l) => l.startsWith("entry")).length, takes, "nothing is taken");
    assert.equal(book.nominated(addr(1)), null);
    assert.equal(book.onReviewed(addr(1), buy({ decisionId: "dec_late" })), null);
    assert.equal(book.onFill("dec_late", "landed", false), null, "a later decision does not speak for it");
    assert.equal(book.priority().size, 0);
    // It is still held, so the coin is not re-nominated under it.
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -2, senderId: 2 }, clock.t), READY_PAPER), { ok: false, reason: "recent" });
    assert.equal(book.onFill("dec_b", "paper", true)?.kind, "bought");
  });

  it("the grace has a hard bound: an entry that never answers is expired at TTL plus the grace", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 10 }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    assert.equal(book.onFill("dec_b", "submitted", false), null, "submitted is not an answer");
    clock.t = T0 + NOMINATE.ttlMs + NOMINATE.entryInFlightGraceMs - 1;
    assert.deepEqual(book.expire(), []);
    clock.t = T0 + NOMINATE.ttlMs + NOMINATE.entryInFlightGraceMs;
    assert.deepEqual(book.expire(), [{ kind: "expired", address: addr(1), chatId: -1, messageId: 10 }]);
    assert.equal(book.onFill("dec_b", "landed", false), null, "too late to speak for it");
  });

  it("a refund ends the grace: no fill is coming, so the TTL applies again", () => {
    const { book, clock, counters } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 10 }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs + MIN;
    assert.deepEqual(book.expire(), []);
    book.refundEntry(addr(1));
    assert.equal(counters.entries, 0);
    assert.deepEqual(book.expire(), [{ kind: "expired", address: addr(1), chatId: -1, messageId: 10 }]);
  });

  it("an older unspent claim for the same coin does not keep a new nomination of it alive", () => {
    const { book, clock } = setup();
    // The first nomination's entry went `submitted` and never answered: its
    // claim stays outstanding after the hard bound expires the nomination.
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 1 }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_first" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs + NOMINATE.entryInFlightGraceMs;
    assert.equal(book.expire().length, 1);
    // The coin is posted again (expired is not a verdict) and nobody claims.
    const again = clock.t;
    assert.ok(book.nominate(nom({ address: addr(1), chatId: -2, messageId: 20, senderId: 2 }, again), READY_PAPER).ok);
    clock.t = again + NOMINATE.ttlMs;
    assert.deepEqual(book.expire(), [{ kind: "expired", address: addr(1), chatId: -2, messageId: 20 }]);
  });

  it("an expiry found by another call is kept for expire(), never lost", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 10 }), READY_PAPER);
    clock.t = T0 + NOMINATE.ttlMs + 1;
    assert.equal(book.active(), null);
    assert.equal(book.onReviewed(addr(1), hold()), null, "too late to speak for it");
    assert.deepEqual(book.expire(), [{ kind: "expired", address: addr(1), chatId: -1, messageId: 10 }]);
  });

  it("expired is not a verdict: the coin may be nominated again", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    clock.t = T0 + NOMINATE.ttlMs;
    book.expire();
    assert.deepEqual(book.nominate(nom({ address: addr(1), chatId: -2, senderId: 2 }, clock.t), READY_PAPER), { ok: true });
  });
});

describe("reset: a context change", () => {
  it("every pending nomination is expired, waiting or awaiting its fill, in queue order", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, messageId: 2, senderId: 2 }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.deepEqual(book.reset(), [
      { kind: "expired", address: addr(1), chatId: -1, messageId: 1 },
      { kind: "expired", address: addr(2), chatId: -2, messageId: 2 },
    ]);
    assert.equal(book.active(), null);
    assert.equal(book.onFill("dec_b", "landed", false), null);
    assert.deepEqual(book.reset(), []);
    assert.deepEqual(book.expire(), []);
  });

  it("spares a nomination whose claimed entry is in flight: its order was already taken, and its fill answers it", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 1, senderId: 1 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, messageId: 2, senderId: 2 }), READY_PAPER);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    assert.deepEqual(book.reset(), [{ kind: "expired", address: addr(2), chatId: -2, messageId: 2 }]);
    assert.equal(book.onFill("dec_b", "paper", true)?.kind, "bought");
    assert.equal(book.onExit(addr(1))?.kind, "exited");
  });

  it("includes expiries already found but not yet collected", () => {
    const { book, clock } = setup();
    book.nominate(nom({ address: addr(1), chatId: -1, messageId: 1, senderId: 1 }), READY_PAPER);
    clock.t = T0 + 10 * MIN;
    book.nominate(nom({ address: addr(2), chatId: -2, messageId: 2, senderId: 2 }, clock.t), READY_PAPER);
    clock.t = T0 + NOMINATE.ttlMs;
    book.active(); // finds the first one expired
    assert.deepEqual(book.reset().map((o) => o.address), [addr(1), addr(2)]);
  });

  it("hands out no fresh allowance: windows and the re-nominate memory survive", () => {
    const { book } = setup();
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), hold());
    book.nominate(nom({ address: addr(2) }), READY_PAPER);
    book.reset();
    assert.deepEqual(book.nominate(nom({ address: addr(3) }), READY_PAPER), { ok: false, reason: "sender-rate" });
    assert.deepEqual(book.nominate(nom({ address: addr(1), senderId: 9 }), READY_PAPER), { ok: false, reason: "recent" });
  });
});

describe("onExit: one line for a coin bought through a nomination", () => {
  function boughtBook() {
    const s = setup();
    s.book.nominate(nom({ address: addr(1), chatId: -3, messageId: 33 }), READY_PAPER);
    s.book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    s.book.onFill("dec_b", "landed", false);
    return s;
  }

  it("says it once, with sanitised notes", () => {
    const { book, clock } = boughtBook();
    clock.t = T0 + 30 * MIN;
    assert.deepEqual(book.onExit(addr(1).toUpperCase().replace("0X", "0x"), ["ran out of steam", "down 20%", "@someone sold"]), {
      kind: "exited", address: addr(1), chatId: -3, messageId: 33, notes: ["ran out of steam"],
    });
    assert.equal(book.onExit(addr(1)), null, "at most once");
  });

  it("notes are optional", () => {
    const { book } = boughtBook();
    assert.deepEqual(book.onExit(addr(1)), { kind: "exited", address: addr(1), chatId: -3, messageId: 33, notes: [] });
  });

  it("nothing for a coin that was never bought through a nomination", () => {
    const { book } = setup();
    assert.equal(book.onExit(addr(1)), null);
    book.nominate(nom({ address: addr(1) }), READY_PAPER);
    book.onReviewed(addr(1), hold());
    assert.equal(book.onExit(addr(1)), null, "passed, not bought");
  });

  it("nothing once the bought memory has run out; just inside it still speaks", () => {
    const a = boughtBook();
    a.clock.t = T0 + NOMINATE.boughtMemoryMs - 1;
    assert.equal(a.book.onExit(addr(1))?.kind, "exited");
    const b = boughtBook();
    b.clock.t = T0 + NOMINATE.boughtMemoryMs;
    assert.equal(b.book.onExit(addr(1)), null);
  });

  it("the bought memory survives a reset", () => {
    const { book } = boughtBook();
    book.reset();
    assert.equal(book.onExit(addr(1))?.kind, "exited");
  });
});

// ─── group-sourced entry claims ─────────────────────────────────────────────

describe("claimEntry / refundEntry: at most three group-sourced entries a UTC day", () => {
  function withNominated(n = 5) {
    const s = setup();
    for (let i = 1; i <= n; i++) s.book.nominate(nom({ address: addr(i), chatId: -i, senderId: i }), READY_PAPER);
    return s;
  }

  it("claims through the durable counter with today's day and the cap", () => {
    const { book, counters } = withNominated();
    assert.equal(book.claimEntry(addr(1)), "taken");
    assert.equal(counters.log.at(-1), `entry:2026-09-28:${NOMINATE.groupEntriesPerDay}`);
    assert.equal(counters.entries, 1);
  });

  it("the fourth claim of the day is refused", () => {
    const { book } = withNominated();
    assert.equal(book.claimEntry(addr(1)), "taken");
    assert.equal(book.claimEntry(addr(2)), "taken");
    assert.equal(book.claimEntry(addr(3)), "taken");
    assert.equal(book.claimEntry(addr(4)), "cap");
  });

  it("a refund gives the slot back", () => {
    const { book, counters } = withNominated();
    book.claimEntry(addr(1));
    book.claimEntry(addr(2));
    book.claimEntry(addr(3));
    book.refundEntry(addr(2));
    assert.equal(counters.entries, 2);
    assert.equal(book.claimEntry(addr(4)), "taken");
  });

  it("an address nobody nominated answers not-nominated, and nothing is taken", () => {
    const { book, counters } = withNominated(1);
    assert.equal(book.claimEntry(addr(9)), "not-nominated");
    assert.equal(counters.log.filter((l) => l.startsWith("entry")).length, 0);
    book.refundEntry(addr(9));
    assert.equal(counters.log.filter((l) => l.startsWith("refund")).length, 0);
  });

  it("a refund with no outstanding claim gives nothing back", () => {
    const { book, counters } = withNominated();
    book.claimEntry(addr(1));
    book.refundEntry(addr(1));
    book.refundEntry(addr(1));
    book.refundEntry(addr(2));
    assert.equal(counters.log.filter((l) => l.startsWith("refund")).length, 1);
    assert.equal(counters.entries, 0);
  });

  it("a refund after the fill landed gives nothing back", () => {
    const { book, counters } = withNominated(1);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    book.onFill("dec_b", "landed", false);
    book.refundEntry(addr(1));
    assert.equal(counters.entries, 1, "a landed entry stays spent");
  });

  it("a refund after a failed fill still works (the entry path refunds after it records the trade)", () => {
    const { book, counters } = withNominated(1);
    book.onReviewed(addr(1), buy({ decisionId: "dec_b" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    assert.equal(book.onFill("dec_b", "rejected", false)?.kind, "skipped");
    book.refundEntry(addr(1));
    assert.equal(counters.entries, 0);
  });

  it("a refund goes back to the day the claim was taken from", () => {
    const { book, counters, clock } = setup(Date.UTC(2026, 8, 28, 23, 59, 0));
    book.nominate(nom({ address: addr(1) }, clock.t), READY_PAPER);
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = Date.UTC(2026, 8, 29, 0, 0, 30);
    book.refundEntry(addr(1));
    assert.equal(counters.log.at(-1), "refund:2026-09-28");
  });

  it("a claim on a new UTC day starts that day's count", () => {
    const { book, counters, clock } = setup(Date.UTC(2026, 8, 28, 23, 50, 0));
    for (let i = 1; i <= 4; i++) book.nominate(nom({ address: addr(i), chatId: -i, senderId: i }, clock.t), READY_PAPER);
    book.claimEntry(addr(1));
    book.claimEntry(addr(2));
    book.claimEntry(addr(3));
    assert.equal(book.claimEntry(addr(4)), "cap");
    clock.t = Date.UTC(2026, 8, 29, 0, 0, 0);
    assert.equal(book.claimEntry(addr(4)), "taken");
    assert.equal(counters.log.at(-1), `entry:2026-09-29:${NOMINATE.groupEntriesPerDay}`);
  });

  it("a counter that throws refuses the claim, and a throwing refund is swallowed", () => {
    const { book, counters } = withNominated(2);
    counters.throwOn = "entry";
    assert.equal(book.claimEntry(addr(1)), "cap");
    counters.throwOn = null;
    assert.equal(book.claimEntry(addr(2)), "taken");
    counters.throwOn = "refund";
    assert.doesNotThrow(() => book.refundEntry(addr(2)));
  });

  it("an expired nomination is no longer group-sourced, but its outstanding claim can still be refunded", () => {
    const { book, counters, clock } = withNominated(1);
    assert.equal(book.claimEntry(addr(1)), "taken");
    clock.t = T0 + NOMINATE.ttlMs;
    book.expire();
    assert.equal(book.nominated(addr(1)), null);
    book.refundEntry(addr(1));
    assert.equal(counters.entries, 0);
  });

  it("a TTL that runs out between nominated() and claimEntry() is not-nominated, never a claim", () => {
    const { book, counters, clock } = withNominated(1);
    // An earlier entry for this coin claimed and went `submitted`: its claim
    // stays outstanding, and it is the one a wrong refund would pop.
    book.onReviewed(addr(1), buy({ decisionId: "dec_first" }));
    assert.equal(book.claimEntry(addr(1)), "taken");
    // The next entry's two book calls straddle the TTL.
    clock.t = T0 + NOMINATE.ttlMs - 1;
    assert.ok(book.nominated(addr(1)), "still pending when the caller looked");
    clock.t = T0 + NOMINATE.ttlMs;
    const takes = counters.log.filter((l) => l.startsWith("entry")).length;
    assert.equal(book.claimEntry(addr(1)), "not-nominated");
    assert.equal(counters.log.filter((l) => l.startsWith("entry")).length, takes, "nothing is taken");
    assert.equal(counters.entries, 1, "the earlier entry's claim stays spent");
  });
});

// ─── what crosses ───────────────────────────────────────────────────────────

describe("what an outcome carries", () => {
  it("never the sender, never a figure: only where the post was, the address and safe notes", () => {
    const { book } = setup();
    const outcomes: (CoinOutcome | null)[] = [];
    book.nominate(nom({ address: addr(1), chatId: -1, senderId: 111 }), READY_PAPER);
    book.nominate(nom({ address: addr(2), chatId: -2, senderId: 222 }), READY_PAPER);
    book.nominate(nom({ address: addr(3), chatId: -3, senderId: 333 }), READY_PAPER);
    outcomes.push(book.onReviewed(addr(1), hold({ bearCase: "Down 50%; dead chart", risks: ["$1 floor"] })));
    book.onReviewed(addr(2), buy({ decisionId: "dec_2", thesis: "Buy 5 USDG here", bullCase: "Momentum is real" }));
    outcomes.push(book.onFill("dec_2", "paper", true));
    outcomes.push(...book.reset());
    assert.equal(outcomes.length, 3);
    for (const o of outcomes) {
      assert.ok(o);
      const keys = Object.keys(o).sort();
      assert.ok(!keys.includes("senderId"), JSON.stringify(o));
      if ("notes" in o) for (const n of o.notes) assert.doesNotMatch(n, /\p{N}|[$%@]|0x/u);
    }
    assert.deepEqual((outcomes[0] as { notes: string[] }).notes, ["dead chart"]);
    assert.deepEqual((outcomes[1] as { notes: string[] }).notes, ["Momentum is real"]);
  });
});
