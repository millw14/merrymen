import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * THE CARD HAS TO REACH BOTH KINDS OF OWNER.
 *
 * The notifier has two entirely separate trade paths: immediate mode sends one
 * message per row, and quiet mode replaces those with a periodic digest built
 * from a `GROUP BY status` aggregate. The obvious way to add a P&L card is to
 * put it in the loop you happen to be reading, which ships a feature that never
 * fires for anyone on a digest — and nothing would fail, because the digest
 * would keep being correct about its counts.
 *
 * These read the source rather than driving the loop: the loop needs a live
 * sqlite ledger, a token and a chat, and the property worth protecting here is
 * structural — that neither path lost its card, and that the SQL feeding them
 * still carries the columns the card is built from.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "notifier.ts"), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const CODE = strip(SRC);

describe("a closed position reaches the owner in both notify modes", () => {
  it("sends the card on the immediate path", () => {
    const immediate = CODE.slice(CODE.indexOf("periodMin <= 0"), CODE.indexOf("Quiet mode"));
    assert.ok(immediate.includes("sendCardFor("), "the per-trade path no longer sends a card");
  });

  it("sends the card on the digest path too", () => {
    const quiet = CODE.slice(CODE.indexOf("tradeDigestLine(agg, periodMin)"));
    assert.ok(
      quiet.includes("sendCardFor("),
      "a digest owner would get counts and never a P&L card",
    );
    assert.ok(
      /realized_pnl_usdg IS NOT NULL/.test(quiet),
      "the digest must select only rows that actually closed at a knowable P&L",
    );
  });

  it("captions the digest card but not the immediate one", () => {
    // Immediate mode prints a full receipt directly above the picture; a digest
    // sends counts, so an uncaptioned card there is numbers with no position.
    assert.ok(/sendCardFor\(t, token, chatId, false\)/.test(CODE), "immediate card should be uncaptioned");
    assert.ok(/sendCardFor\(t, token, chatId, true\)/.test(CODE), "digest card must carry its own caption");
  });
});

describe("the query still carries what the card is drawn from", () => {
  it("selects the fill columns, in one shared list", () => {
    for (const col of ["target", "fill_side", "fill_cash_usdg", "realized_pnl_usdg"]) {
      assert.ok(
        new RegExp(`TRADE_PING_COLUMNS[\\s\\S]*${col}`).test(CODE),
        `${col} is not in the shared column list`,
      );
    }
    // Both paths must use the shared constant rather than an inline list, which
    // is how one of them silently drifts out of sync with the other.
    const uses = [...CODE.matchAll(/\$\{TRADE_PING_COLUMNS\}/g)].length;
    assert.ok(uses >= 2, `only ${uses} query uses the shared column list`);
  });

  it("never lets a failed picture swallow the trade receipt", () => {
    // The receipt is the record. sendCardFor is called AFTER sendMessage and
    // catches everything, so a missing template or an image library that will
    // not load costs the owner a picture and never a notification.
    const fn = CODE.slice(CODE.indexOf("async function sendCardFor"));
    assert.ok(/catch\s*\{/.test(fn.slice(0, 900)), "sendCardFor must swallow its own failures");
    const immediate = CODE.slice(CODE.indexOf("periodMin <= 0"), CODE.indexOf("Quiet mode"));
    assert.ok(
      immediate.indexOf("sendMessage(") < immediate.indexOf("sendCardFor("),
      "the receipt must go out before the card is attempted",
    );
  });
});
