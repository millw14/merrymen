import assert from "node:assert/strict";
import { test } from "node:test";
import { autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { LiveMine } from "./live";
import { chatStateOf } from "./chat-payload";

const recovery: FleetRecoveryView = { state: "history-only", tradingPaused: true, history: "available",
  memory: "unknown", checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };
const mine: LiveMine = { name: "Example Robin", slug: "example", handle: null, owner: "you", equity: 120,
  chg24: 5, mode: "live", statusLabel: "LIVE", moves: [], thesis: null,
  autonomy: autonomyOf({ mode: "live", liveBlocker: null }), glance: { id: "custom", label: "", cashUsd: 95, vaultUsd: 10 },
  positions: [{ symbol: "EXAMPLE", valueUsd: 15, costUsd: 12, costFromQuote: false, pnlPct: 25,
    stale: false, floorBps: 2500, floorWhy: "recorded floor" }] };
const args = { mine, settings: { values: { liveTradingEnabled: true, paperTradingEnabled: true,
  strategistStopLossBps: 2500, takeProfitBps: 5000 } }, liveBlocker: "dead-policy", perTrade: 10, perDay: 25, stopped: false };

test("normal and older-server chat payloads retain their existing display state", () => {
  for (const absent of [undefined, null]) {
    const state = chatStateOf({ ...args, mine: { ...mine, recovery: absent } });
    assert.equal(state.equity, 120);
    assert.equal(state.cashUsd, 95);
    assert.equal(state.positions?.[0]?.symbol, "EXAMPLE");
    assert.equal(state.liveTradingEnabled, true);
    assert.equal(state.liveBlocker, "dead-policy");
    assert.equal(state.stopped, false);
    assert.equal(state.workerHeardFrom, null, "a screen that never said is unknown, not never-started");
    assert.equal("lastRecorded" in state, false);
  }
});

test("the chat is told whether any heartbeat ever landed, and the desk's own reason when it is not trading", () => {
  const heard = chatStateOf({ ...args, mine: { ...mine, workerHeardFrom: true } });
  assert.equal(heard.workerHeardFrom, true);
  assert.equal(heard.workerReason, null, "LIVE has no reason to give");
  const never = chatStateOf({ ...args, liveBlocker: null, stopped: true,
    mine: { ...mine, workerHeardFrom: false, statusLabel: "IDLE", autonomy: autonomyOf({ mode: null, liveBlocker: null }) } });
  assert.equal(never.workerHeardFrom, false);
  assert.equal(never.workerReason, null, "nothing is invented for an agent that never started");
  const blocked = chatStateOf({ ...args, mine: { ...mine, workerHeardFrom: true, statusLabel: "BLOCKED",
    autonomy: autonomyOf({ mode: "paper", liveBlocker: "dead-policy" }) } });
  assert.match(String(blocked.workerReason), /signed before a fix/);
});

test("a recovery-held display snapshot is explicitly last recorded, without current book or authority claims", () => {
  const state = chatStateOf({ ...args, mine: { ...mine, recovery, workerHeardFrom: false } });
  assert.equal(state.workerStatus, "Trading paused for recovery");
  assert.equal(state.stopped, true);
  assert.equal(state.liveBlocker, null);
  assert.equal(state.workerHeardFrom, null, "a hold answers whether it is running, not the browser's heartbeat read");
  assert.equal(state.workerReason, null);
  for (const field of ["equity", "cashUsd", "vaultUsd", "positions", "liveTradingEnabled", "paperTradingEnabled",
    "stopLossBps", "takeProfitBps"] as const) assert.equal(state[field], null, field);
  assert.deepEqual(state.recovery, recovery);
  assert.equal(state.lastRecorded?.equity, 120);
  assert.equal(state.lastRecorded?.cashUsd, 95);
  assert.equal(state.lastRecorded?.positions?.[0]?.symbol, "EXAMPLE");
  assert.equal(state.lastRecorded?.positions?.[0]?.unrealisedPct, 25);
  assert.equal(state.lastRecorded?.liveTradingEnabled, true, "a saved setting is not erased or called current authority");
});

test("missing saved positions stay unknown during recovery", () => {
  const state = chatStateOf({ ...args, mine: { ...mine, positions: undefined, recovery } });
  assert.equal(state.lastRecorded?.positions, null);
});
