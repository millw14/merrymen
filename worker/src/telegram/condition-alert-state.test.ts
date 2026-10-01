import assert from "node:assert/strict";
import { test } from "node:test";
import { conditionAlertTimes, restoredConditionAlerts } from "./condition-alert-state";

test("only numeric, non-future condition cooldowns are durable", () => {
  const now = 1_790_000_000;
  assert.deepEqual(conditionAlertTimes({
    "drawdown-halted:500": now - 5,
    "action-ceiling:0.5": now - 6,
    "low-gas": String(now),
    "no-gas": Infinity,
    "withdrawal-gas": now + 1,
    drawdown: -1,
    "milestone:7": now,
    botToken: now,
    "https://private.example/secret": now,
  }, now), { "drawdown-halted:500": now - 5, "action-ceiling:0.5": now - 6 });
  assert.deepEqual(conditionAlertTimes([now], now), {});
  assert.deepEqual(conditionAlertTimes({ drawdown: 4.5 }, now), {});
});

test("cooldowns restore only for the same positive DM recipient", () => {
  const state = { ownerId: 123, firedAlerts: { "drawdown-halted:500": 50 } };
  assert.deepEqual(restoredConditionAlerts(state, 123, 100), state.firedAlerts);
  for (const owner of [null, 124, -100, NaN, Infinity, 1.5]) {
    assert.deepEqual(restoredConditionAlerts(state, owner, 100), {});
  }
  assert.deepEqual(restoredConditionAlerts({ ...state, ownerId: "123" }, 123, 100), {});
});

test("many historical caps cannot grow the durable envelope without bound", () => {
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`drawdown-halted:${i}`, i + 1]));
  const restored = conditionAlertTimes(entries, 300);
  assert.equal(Object.keys(restored).length, 128);
  assert.equal(restored["drawdown-halted:199"], 200);
  assert.equal(restored["drawdown-halted:0"], undefined);
});
