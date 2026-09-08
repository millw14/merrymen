/**
 * THE RESOLVER THAT MUST NEVER GUESS.
 *
 * Anyone can launch a token calling itself anything, and on this chain they
 * have: the live market list carries five coins named NEON, four named HANK,
 * three named STRC. `instrumentClassOf` already writes the rule down — "A
 * discovered token may call itself AAPL. The address is the identity."
 *
 * So the tests that matter here are the ones where a resolver would be tempted
 * to be helpful. Returning the first NEON, or the one with the most volume, or
 * the newest, is not a convenience — it is spending somebody's stated amount on
 * a coin they did not name, silently, with no way for them to notice before the
 * fill.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSnipeTarget, shortAddress, type SnipeCandidate } from "./snipe-target";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const c = (symbol: string, name: string, n: number, covered = false): SnipeCandidate => ({
  address: at(n),
  symbol,
  name,
  covered,
});

const NEON_A = c("NEON", "Neon", 1);
const NEON_B = c("NEON", "Neon Genesis", 2);
const PEPE = c("PEPE", "Pepe the Frog", 3, true);
const WIF = c("WIF", "dogwifhat", 4);
const BOOK = [NEON_A, NEON_B, PEPE, WIF];

describe("one match acts", () => {
  it("AN EXACT TICKER RESOLVES", () => {
    const r = resolveSnipeTarget("PEPE", BOOK);
    assert.equal(r.kind, "one");
    assert.equal(r.kind === "one" && r.target.address, PEPE.address);
    assert.equal(r.kind === "one" && r.matchedOn, "symbol");
  });

  it("and case, whitespace and a leading $ are how people type", () => {
    for (const q of ["pepe", "  PePe  ", "$PEPE", "$pepe"]) {
      const r = resolveSnipeTarget(q, BOOK);
      assert.equal(r.kind === "one" && r.target.symbol, "PEPE", `failed on ${JSON.stringify(q)}`);
    }
  });

  it("A NAME FRAGMENT RESOLVES when no ticker matched", () => {
    const r = resolveSnipeTarget("dogwif", BOOK);
    assert.equal(r.kind, "one");
    assert.equal(r.kind === "one" && r.target.symbol, "WIF");
    assert.equal(r.kind === "one" && r.matchedOn, "name");
  });

  it("and an address is the identity, so it always wins", () => {
    const r = resolveSnipeTarget(NEON_B.address.toUpperCase(), BOOK);
    assert.equal(r.kind, "one");
    assert.equal(r.kind === "one" && r.target.address, NEON_B.address);
    assert.equal(r.kind === "one" && r.matchedOn, "address");
  });
});

describe("more than one asks — it never picks", () => {
  it("FIVE COINS CALLED NEON IS A QUESTION, NOT A CHOICE", () => {
    // The failure this file exists to prevent. There is no tie-break by volume,
    // age, depth or order: any of those would spend the money on a coin the
    // owner did not name, and they would find out from the fill.
    const r = resolveSnipeTarget("NEON", BOOK);
    assert.equal(r.kind, "many");
    assert.equal(r.kind === "many" && r.candidates.length, 2);
  });

  it("and an ambiguous NAME asks too", () => {
    const r = resolveSnipeTarget("neon", [NEON_A, NEON_B, c("XYZ", "neon lights", 9)]);
    // "neon" matches both tickers exactly, so the symbol step answers first —
    // and it is still ambiguous, so it still asks.
    assert.equal(r.kind, "many");
  });

  it("AND A TICKER TIE IS NEVER RESOLVED BY FALLING THROUGH TO NAMES", () => {
    // The subtle one: two exact ticker matches must not degrade into a name
    // search that happens to yield one answer. Exactness that is ambiguous is
    // still the most exact information available, and the honest reply is the
    // question — not a less exact match that looks decisive.
    const r = resolveSnipeTarget("NEON", [NEON_A, NEON_B, c("OTHER", "NEON special", 7)]);
    assert.equal(r.kind, "many");
    assert.equal(r.kind === "many" && r.candidates.every((x) => x.symbol === "NEON"), true);
  });
});

describe("zero says so", () => {
  it("AN UNKNOWN NAME IS NOT FOUND, not silently dropped", () => {
    assert.equal(resolveSnipeTarget("NOTACOIN", BOOK).kind, "none");
  });

  it("AND AN UNKNOWN ADDRESS IS NOT FABRICATED INTO A TARGET", () => {
    // The dangerous shortcut: an address is well-formed, so it is tempting to
    // trust it as self-describing and trade it. This repo cannot price or exit
    // a token it has never seen, so an unknown address is a miss.
    assert.equal(resolveSnipeTarget(at(999), BOOK).kind, "none");
  });

  it("and an empty query is a miss rather than a match on everything", () => {
    for (const q of ["", "   ", "$"]) {
      assert.equal(resolveSnipeTarget(q, BOOK).kind, "none", JSON.stringify(q));
    }
  });

  it("and a candidate with no name cannot be matched into by a blank one", () => {
    const nameless: SnipeCandidate = { address: at(11), symbol: "AAA", name: null };
    assert.equal(resolveSnipeTarget("zzz", [nameless]).kind, "none");
  });
});

describe("coverage travels but never filters", () => {
  it("AN UNCOVERED COIN STILL RESOLVES", () => {
    // "I found it and your key does not cover it yet" tells an owner what to do
    // next. "I could not find it" sends them looking for a typo that is not
    // there. The wall still refuses the trade; that is the wall's job, not the
    // resolver's.
    const r = resolveSnipeTarget("WIF", BOOK);
    assert.equal(r.kind, "one");
    assert.equal(r.kind === "one" && r.target.covered, false);
  });
});

describe("telling two coins with one ticker apart", () => {
  it("SHOWS ENOUGH ADDRESS TO CHECK AGAINST AN EXPLORER", () => {
    assert.equal(shortAddress(at(1)), "0x0000…0001");
    // Two NEONs must not render identically, or the question cannot be answered.
    assert.notEqual(shortAddress(NEON_A.address), shortAddress(NEON_B.address));
  });

  it("and it does not mangle something that is not an address", () => {
    assert.equal(shortAddress("PEPE"), "pepe");
  });
});
