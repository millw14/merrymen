/**
 * THE TELEGRAM HALF OF ENERGY IS WIRED TO THE WORKER'S OWN REPORT.
 *
 * /status's energy line and the once-a-day alert read what the tick decided
 * (`energyReport`, refreshed by refreshEnergy and published on the agents
 * row), never a second computation — two readings of one allowance is how an
 * owner is told "spent" by one surface and "low" by another. Both live inside
 * main(), which a test cannot call, so the wiring is pinned in the source
 * (the order-command.test.ts precedent) and the behaviour is executed in
 * telegram/energy-status.test.ts and telegram/energy-alert.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const INDEX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The object literal `name` builds, from its start to the first `});` at its own indent. */
function literal(start: string, end: string): string {
  const at = INDEX.indexOf(start);
  assert.ok(at > 0, `${start} moved — re-anchor this test`);
  const rest = INDEX.slice(at);
  const stop = rest.indexOf(end);
  assert.ok(stop > 0, `${end} after ${start} moved — re-anchor this test`);
  return rest.slice(0, stop);
}

describe("index.ts hands the Telegram surfaces the tick's energy report", () => {
  it("buildStatusContext passes energyReport — and nothing while unarmed", () => {
    const ctx = literal("const buildStatusContext = () => ({", "\n  });");
    assert.match(ctx, /energy: active \? energyReport : null,/);
  });

  it("the notifier's alert inputs carry the report and the addresses from the grant and settings", () => {
    const inputs = literal("getAlertInputs: () => ({", "\n    }),");
    assert.match(inputs, /energy: active \? energyReport : null,/);
    assert.match(inputs, /energyAccount: active\?\.grant\.smartAccount \?\? null,/);
    assert.match(inputs, /energyChainId: active\?\.grant\.chainId \?\? null,/);
    assert.match(inputs, /energyHolder: cfg\.holderAddress \?\? null,/);
  });

  it("THE ALERT RIDES THE NOTICE'S DURABLE CLAIM — set only after this process wins it, for the armed agent", () => {
    // telegram.json does not survive a hosted redeploy, so its alert keys
    // cannot keep the alert to once a day; energy_days.told_at can, because
    // the orchestrator seeds it back before the rebuilt child arms.
    const inputs = literal("getAlertInputs: () => ({", "\n    }),");
    assert.match(inputs, /energyToldDay: energyToldDayOf\(energyToldHere, active\?\.agentId\),/);
    const tell = literal("async function tellEnergySpent(", "\n  }\n");
    const claim = tell.indexOf("const claimed = await claimEnergyNotice(agentId, day, now);");
    const gate = tell.indexOf("if (!claimed) return;");
    const set = tell.indexOf("energyToldHere = { agentId, day };");
    assert.ok(claim > 0 && gate > claim && set > gate, "the marker is set only once the claim is won");
    assert.equal(INDEX.split("energyToldHere = ").length - 1, 1, "and nowhere else");
  });

  it("the report they read is the one refreshEnergy publishes", () => {
    // The report on the agents row and the report Telegram reads are the same
    // object, so they cannot disagree.
    const refresh = INDEX.slice(INDEX.indexOf("async function refreshEnergy("));
    const body = refresh.slice(0, refresh.indexOf("\n  }\n"));
    assert.match(body, /energyReport = energyStatus\(/);
    assert.match(body, /setAgentEnergy\(agentId, JSON\.stringify\(energyReport\)\)/);
  });

  it("nothing in the Telegram poll path reaches the energy buy", () => {
    // Read-only in v1: /status and the alert tell; the buy is the app chat's.
    // Telegram's trades go through submitChatTrade, which refuses $MERRYMEN
    // (the buy path's slice); nothing here may route around it.
    const telegram = literal("startTelegram({", "\n  });");
    assert.doesNotMatch(telegram, /submitEnergyBuy|energy-buy|MERRYMEN/);
  });
});
