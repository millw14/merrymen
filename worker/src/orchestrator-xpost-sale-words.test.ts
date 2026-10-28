/** Exhaustive sale-pool checks use the same room gate and suffixes as production. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { admitAgentLine } from "./groupchat/policy";
import { REPEAT_LIMIT, similarity } from "./social-post";
import { admitXPost } from "./xpost/gate";
import { openerKey } from "./xpost/memory";
import { appendPublicToken, publicTokenSuffix } from "./xpost/public-wallet";
import { appendSaleOutcome, hasSaleOutcome, saleWordBudget } from "./xpost/sale-outcome";
import { SALE_PARTS, SALE_SHORT_LINES, saleLines } from "./xpost/sale-words";

const counted = (text: string) => text.replace(/\{coin\}|\bsold\b/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && similarity(w, w) > 0);
const admit = (line: string, coin: string, recentOwn: string[] = [], recentFleet: string[] = []) =>
  admitXPost(line, { kind: "sell", agentName: "Alan Al Dale", mode: "live", coins: [coin], recentOwn, recentFleet, recentOpeners: recentOwn.slice(0, 8), house: true }, admitAgentLine);
const TOKEN = { address: `0x${"ab".repeat(20)}`, chainId: 4663, txHash: `0x${"cd".repeat(32)}` };
const suffix = publicTokenSuffix(TOKEN, true)!;
const whole = (line: string, gainPct: number) => {
  const said = appendSaleOutcome(line, "profit", gainPct, { seed: line, suffix });
  return said ? appendPublicToken(said, TOKEN, true) : null;
};

describe("varied receipt-backed sale fallbacks", () => {
  it("walks 24 natural first choices and 576 reserve candidates once, from a deterministic receipt-specific starting point", () => {
    const a = saleLines("WISP", "sell:a"), b = saleLines("WISP", "sell:b");
    assert.equal(a.length, 600);
    assert.equal(new Set(a).size, 600);
    assert.deepEqual([...a].sort(), [...b].sort());
    assert.notEqual(a[0], b[0]);
    assert.deepEqual(a, saleLines("WISP", "sell:a"));
    assert.deepEqual(saleLines("", "sell:a"), []);
    assert.ok(saleLines("Pudgy  Penguin", "x").every((line) => line.includes("Pudgy Penguin")));
  });

  it("has 24 distinct openers and independently distinctive parts", () => {
    assert.ok(new Set(saleLines("WISP", "x").map((line) => openerKey(line, ["WISP"]))).size >= 24);
    const short = new Set(SALE_SHORT_LINES.map((line) => line.replace("{coin}", "WISP")));
    assert.equal(short.size, 24);
    assert.ok(saleLines("WISP", "x").slice(0, 24).every((line) => short.has(line)));
    const sets = SALE_PARTS.flat().map((part) => new Set(counted(part)));
    SALE_PARTS.flat().forEach((part, i) => {
      const unique = [...sets[i]!].filter((word) => sets.every((other, j) => i === j || !other.has(word)));
      assert.ok(unique.length >= (i < 48 ? 3 : 2), `${part}: only ${unique.join(", ")}`);
    });
  });

  it("every candidate clears the real gate across normal, multiple-word and digit-containing coin names", () => {
    for (const coin of ["CAPITOL", "WISP", "IGNITION", "ALTAI", "INDEX", "Pudgy Penguin", "MOON", "T57F813C4571"]) {
      for (const line of saleLines(coin, `sell:${coin}`)) {
        const v = admit(line, coin);
        assert.ok(v.ok, `${line} → ${v.ok ? "" : v.reason}`);
      }
    }
  });

  it("keeps timing, quantity, position and outcome claims outside the prose pool", () => {
    for (const text of [
      "just sold some casino from the stack", "sold some casino, still holding the rest", "sold casino, rest of the bag stays put",
      "sold half of my casino here", "sold casino at the top of the range", "sold casino into strength, still in some",
    ]) assert.equal(admit(text, "Casino").ok, false, text);
    for (const line of saleLines("WISP", "x")) {
      assert.match(line, /\bsold\b/);
      assert.match(line, /\bWISP\b/);
      assert.doesNotMatch(line, /\p{N}|%|\$|@|#|https?:|\b(?:profit|gain|loss|green|red|win|won|all|closed|exited|out|early|late|pleased|nice|remaining|left|still in|holding|rest|bag|half|some|quarter)\b/iu, line);
      assert.doesNotMatch(line, /receipt's below/i, "no promise of a link on owners who do not share one");
    }
  });

  it("every short-label candidate fits a five-figure gain plus the complete raw explorer URL and CA", () => {
    for (const coin of ["PEPE", "CAPITOL", "IGNITION", "ALTAI", "MOON"]) {
      for (const line of saleLines(coin, "s")) {
        const body = whole(line, 12345);
        assert.ok(body, line);
        assert.ok(body.length <= 280);
        assert.equal(hasSaleOutcome(body, "profit", 12345), true);
      }
    }
    for (const coin of ["Wrapped Robinhood Ethers", "Pudgy Penguin", "T57F813C4571"]) {
      const fitting = saleLines(coin, "s").filter((line) => line.length <= saleWordBudget("profit", 12345, suffix, 4) && admit(line, coin).ok && whole(line, 12345));
      assert.ok(fitting.length >= 24, `${coin}: ${fitting.length} candidates fit`);
    }
  });

  it("a hundred same-coin wins remain possible with the long repeat history and eight-opener window", () => {
    const said: string[] = [];
    for (let i = 0; i < 100; i++) {
      const line = saleLines("PEPE", `sell:${i}`).find((candidate) => admit(candidate, "PEPE", said).ok && whole(candidate, 12345));
      assert.ok(line, `win ${i + 1}`);
      assert.ok(said.every((prior) => similarity(line!, prior) < REPEAT_LIMIT));
      said.unshift(line!);
    }
  });

  it("coin-swapped copies and recent fleet lines are refused; another opener remains available", () => {
    const prior = saleLines("CAPITOL", "s")[0]!.replace("CAPITOL", "WISP");
    assert.equal(admit(prior, "WISP", [prior]).ok, false);
    assert.equal(admit(prior, "WISP", [], [prior]).ok, false);
    const next = saleLines("WISP", "s").find((line) => admit(line, "WISP", [prior], [prior]).ok);
    assert.ok(next);
    assert.notEqual(openerKey(next, ["WISP"]), openerKey(prior, ["WISP"]));
  });
});
