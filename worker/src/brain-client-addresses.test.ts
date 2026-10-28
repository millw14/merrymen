/**
 * A DECISION THAT CARRIES AN ADDRESS IS REFUSED WHOLE, AT THE CLIENT.
 *
 * Against a real local HTTP server standing in for Brain: the thesis, an
 * evidence ref or a risk line holding a 0x address, or a Solana key or
 * signature (Solana P0), is "malformed", and the same decision without one is
 * accepted.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { base58Encode, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { decide, type BrainDecision } from "./brain-client";
import { buildShadowSnapshot, type ShadowInputs } from "./brain-shadow";

const now = Math.floor(Date.now() / 1000);
const SIG = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff));

let over: Partial<BrainDecision> = {};
const server = createServer(async (req, res) => {
  for await (const _ of req) void _;
  const decision: BrainDecision = {
    schema_version: "1.0.0", decision_id: "dec_addr", agent_id: "fixture", created_at: now, trigger_id: null,
    action: "hold", instrument_id: "merrymen:meme", symbol: "MEME", confidence: 0.5, suggested_delta_usdg: 0,
    target_position_usdg: null, thesis: "Buys are thinning into strength.", evidence: [], bull_case: "", bear_case: "",
    risks: [], invalidation: [], time_horizon: "up to 30 minutes", tier: "pulse", depth_used: "analysts",
    escalation_reasons: [], candidate_action: null, models: [], cost: { model_calls: 4, tokens_in: 1, tokens_out: 1, usd: 0 },
    ...over,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, decision, seconds: 0.1 }));
});
let url = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ask() {
  const inputs: ShadowInputs = {
    agentId: "fixture", now, epoch: 1, cashUsdg: 10e6, vaultUsdg: 0, quarantinedUsdg: 0, positions: [],
    netContributionsUsdg: 10e6, grossContributionsUsdg: 10e6, grossWithdrawalsUsdg: 0, gasUsdg: 0,
    quality: { auditPassed: true, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
    market: { instrumentId: "merrymen:meme", symbol: "MEME", instrumentClass: "memecoin", priceUsd: "0.0001", priceStale: false, signals: {} },
    expectedTradeGasUsdg: 0,
  };
  const snapshot = buildShadowSnapshot(inputs);
  return decide({ url, token: "t" }, {
    runId: "fixture", agentId: "fixture", triggerId: "fixture", snapshot, tier: "pulse",
    market: { snapshot_id: snapshot.snapshotId, as_of: now, instrument_id: "merrymen:meme", symbol: "MEME", instrument_class: "memecoin", price_usd: "0.0001", signals: {}, expected_trade_gas_usdg: 0 },
  });
}

describe("a Brain decision carrying an address", () => {
  it("is accepted without one", async () => {
    over = {};
    assert.equal((await ask()).ok, true);
  });

  for (const [label, id] of [["a 0x address", `0x${"ab".repeat(20)}`], ["a Solana mint", SOLANA_USDG_MINT], ["a Solana signature", SIG]] as const) {
    it(`is refused whole when a field holds ${label}`, async () => {
      for (const fields of [
        { thesis: `Rotating into ${id} while depth holds.` },
        { risks: [`a dump from ${id}`] },
        { evidence: [{ source: "tape", ref: id, claim: "buyers stayed" }] },
      ] as Partial<BrainDecision>[]) {
        over = fields;
        const result = await ask();
        assert.equal(result.ok, false, JSON.stringify(fields));
        if (!result.ok) {
          assert.equal(result.kind, "malformed");
          // A 0x address in its old words; a Solana id named for what it is (the Solana pass after them).
          assert.match(result.detail, /carries (?:an address|a Solana (?:address|signature or secret key))/);
        }
      }
    });
  }
});
