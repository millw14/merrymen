import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { decide } from "./brain-client";
import { buildShadowSnapshot, type ShadowInputs } from "./brain-shadow";

test("Brain deadline covers a stalled response body, not just response headers", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    // No complete JSON body arrives. The client must release the worker tick.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const now = Math.floor(Date.now() / 1000);
  const inputs: ShadowInputs = {
    agentId: "fixture", now, epoch: 2, cashUsdg: 100e6, vaultUsdg: 0, quarantinedUsdg: 0, positions: [],
    netContributionsUsdg: 100e6, grossContributionsUsdg: 100e6, grossWithdrawalsUsdg: 0, gasUsdg: 0,
    quality: { auditPassed: true, epoch: 2, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
    market: { instrumentId: "merrymen:nvda", symbol: "NVDA", instrumentClass: "equity-token", priceUsd: "100", priceStale: false, signals: {} },
    expectedTradeGasUsdg: 0,
  };
  const snapshot = buildShadowSnapshot(inputs);
  const emergency = setTimeout(() => server.closeAllConnections(), 2000);
  try {
    const result = await decide({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "fixture", timeoutMs: 100 }, {
      runId: "fixture", agentId: "fixture", triggerId: "fixture", snapshot,
      market: { snapshot_id: snapshot.snapshotId, as_of: now, instrument_id: "merrymen:nvda", symbol: "NVDA", instrument_class: "equity-token", price_usd: "100", signals: {}, expected_trade_gas_usdg: 0 },
    });
    assert.ok(!result.ok);
    assert.match(result.detail, /abort|timeout/i, "the configured deadline must terminate the body read");
  } finally {
    clearTimeout(emergency);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
