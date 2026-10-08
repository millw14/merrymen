import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeedPerpRow, FeedPerpsAccount } from "../lib/perps-view";
import { deskPerpsOf } from "./live";

const row: FeedPerpRow = { market: "BTC-PERP", side: "long", paper: true, size: "0.1", entry_price: "100", mark_price: "101", leverage: 2, margin_usdg: 5, liq_price: "50", liq_distance_pct: 50, unrealized_usdg: 0.1, stop_trigger: "95", funding_usdg: 0 };
const account: FeedPerpsAccount = { state: "ok", mode: "paper", book: "paper", paper: true, active: true, venue_read: true, venue_read_at: 1_800_000, stale: false, collateral_usdg: 10, in_transit_usdg: 0, unrealized_usdg: 0.1, at_lighter_usdg: 10.1, open_notional_usdg: 10, min_liq_distance_pct: 50, stops_missing: 0, incident: false, blocker: null, blocker_text: null, blocker_remedy: null };
const read = (changes: Partial<FeedPerpRow> = {}) => deskPerpsOf({ perps: [{ ...row, ...changes }], perpsAccount: account }, 1_800_000)!;

describe("position entry-plan provenance", () => {
  it("carries only the complete verified ledger profile and its matching deadline", () => {
    const result = read({ entry_style: "scalp-breakout", style_opened_at_sec: 1000, hold_deadline_sec: 2800 });
    assert.equal(result.rows[0]?.entryStyle, "scalp-breakout");
    assert.equal(result.rows[0]?.styleOpenedAtSec, 1000);
    assert.equal(result.rows[0]?.holdDeadlineSec, 2800);
  });
  it("never infers the current/default doctrine for legacy, unknown or malformed metadata", () => {
    for (const changes of [{}, { entry_style: "scalp-breakout" }, { entry_style: "scalp-breakout", style_opened_at_sec: 1000, hold_deadline_sec: 9999 }, { entry_style: "future-profile", style_opened_at_sec: 1000, hold_deadline_sec: 2800 }, { entry_style: "scalp-breakout", style_opened_at_sec: 8_640_000_000_000, hold_deadline_sec: 8_640_000_001_800 }]) {
      const result = read(changes as Partial<FeedPerpRow>);
      assert.equal(result.read, "ok", "bad optional metadata must not hide known exposure");
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]?.entryStyle, undefined);
      assert.equal(result.rows[0]?.styleOpenedAtSec, undefined);
      assert.equal(result.rows[0]?.holdDeadlineSec, undefined);
    }
  });
});
