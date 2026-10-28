import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveToken } from "./live";
import { positionLabel, tokenForPosition } from "./position-token";

const swarm = "0x7eebda046d451bc7a7d12491eff72a861aa8136e";
const token = (id: string, symbol: string) => ({ id, symbol }) as LiveToken;

describe("position display identity", () => {
  it("shows the recorded ticker while retaining the original bookkeeping key", () => {
    const position = { symbol: "TA861AA8136E", token: swarm, displaySymbol: "SWARM" };
    assert.equal(positionLabel(position), "$SWARM");
    assert.equal(position.symbol, "TA861AA8136E");
    assert.equal(positionLabel({ ...position, displaySymbol: "$Index" }), "$Index");
  });

  it("uses an address fallback for missing, unsafe, or generated labels", () => {
    for (const displaySymbol of [null, "", "TA861AA8136E", "ta861aa8136e", swarm, "<script>", "line\nbreak"]) {
      assert.equal(positionLabel({ symbol: "SWARM", token: swarm, displaySymbol }), "0x7eeb…136e");
    }
    assert.equal(positionLabel({ symbol: "TA861AA8136E" }), "Unknown token");
    assert.equal(positionLabel({ symbol: "ETH" }), "$ETH", "older human-readable feeds remain readable");
  });

  it("matches the address even when the market has a different or duplicate ticker", () => {
    const other = token("0x" + "1".repeat(40), "SWARM");
    const actual = token(swarm.toUpperCase(), "RENAMED");
    const position = { symbol: "TA861AA8136E", token: swarm, displaySymbol: "SWARM" };
    assert.equal(tokenForPosition(position, [other, actual]), actual);
    assert.equal(tokenForPosition(position, [other]), undefined, "an unlisted holding never links to a ticker collision");
  });

  it("only links older symbol-only positions when the name is unambiguous", () => {
    const first = token(swarm, "SWARM");
    assert.equal(tokenForPosition({ symbol: "swarm" }, [first]), first);
    assert.equal(tokenForPosition({ symbol: "SWARM" }, [first, token("other", "SWARM")]), undefined);
  });
});
