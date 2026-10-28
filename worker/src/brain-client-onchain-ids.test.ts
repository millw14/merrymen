/**
 * A SOLANA ID IS REFUSED AT THE CLIENT WHEREVER AN 0x ONE IS.
 *
 * Three groups. The shared detector (packages/core/src/ids.ts) gives the
 * answers Brain's Python mirror gives, case for case and in both scans, from
 * the fixture both read. A decision carrying a base58 key, signature or
 * explorer link in any screened field, glued to the text around it or not, is
 * refused whole, and every 0x refusal keeps its old words. And a desk policy
 * carrying one is withheld rather than sent into a 422.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { onchainIdIn, onchainIdsIn } from "../../packages/core/src/index";
import { decide, type BrainDecision, type DecideArgs } from "./brain-client";
import { buildShadowSnapshot, type ShadowInputs } from "./brain-shadow";
import { TRENCHER_FAST } from "./strategies/trencher";
import { trencherStrategyTerms, type StrategyTerms } from "./strategy-terms";

const MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const SIG = "3NGW7mkqWR84fuKhxiUmVTJg8AehpcEQHKZcivruB5449akQiFvm2Ej6AvJGLnfwW15Cb2wn1D6UAFMJtXh6tigd";
/** A real ed25519 public key with no digits (ids.test.ts pins its test seed). */
const LETTERS_32 = "EEuxbXvdXfvgGiFWKYyEksxzabPKjwhYTNvGXFitaqqT";
const LETTERS_64 = "A".repeat(87);
const EVM = `0x${"ab".repeat(20)}`;

describe("the detector Brain mirrors", () => {
  it("answers every shared case as services/brain/brain/onchain_ids.py does", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../services/brain/tests/data/onchain_ids.json", import.meta.url), "utf8"),
    ) as { cases: { text: string; hits: unknown[]; glued?: unknown[] }[] };
    assert.ok(fixture.cases.length >= 20);
    for (const c of fixture.cases) assert.deepEqual(onchainIdsIn(c.text), c.hits, JSON.stringify(c.text));
    // The glued scan Brain's backstop and this client both use (audit regressions F3).
    assert.ok(fixture.cases.filter((c) => c.glued && c.glued.length > 0 && c.hits.length === 0).length >= 8);
    for (const c of fixture.cases) assert.deepEqual(onchainIdsIn(c.text, { glued: true }), c.glued ?? c.hits, JSON.stringify(c.text));
  });

  // This file checks only the ids.ts half. The Python half runs in CI's brain
  // job, so that job must exist and must run Brain's suite.
  it("has its Python half run by CI's brain job", () => {
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = /^ {2}brain:\n((?: {4}.*\n|\n)*)/m.exec(ci)?.[1] ?? "";
    assert.match(job, /uses: actions\/setup-python@[0-9a-f]{40}/);
    assert.match(job, /working-directory: services\/brain\n\s+run: python -m pytest\b/);
    assert.doesNotMatch(job, /continue-on-error|^\s+if:/m);
  });
});

const now = Math.floor(Date.now() / 1000);
let over: Partial<BrainDecision> = {};
const bodies: Record<string, unknown>[] = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  bodies.push(JSON.parse(raw) as Record<string, unknown>);
  const decision: BrainDecision = {
    schema_version: "1.0.0", decision_id: `dec_ids_${bodies.length}`, agent_id: "fixture", created_at: now, trigger_id: null,
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
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function args(extra: Partial<DecideArgs> = {}): DecideArgs {
  const inputs: ShadowInputs = {
    agentId: "fixture", now, epoch: 1, cashUsdg: 10e6, vaultUsdg: 0, quarantinedUsdg: 0, positions: [],
    netContributionsUsdg: 10e6, grossContributionsUsdg: 10e6, grossWithdrawalsUsdg: 0, gasUsdg: 0,
    quality: { auditPassed: true, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: true, gasBasis: "net", positionHistoryAvailable: true, quarantinedAssetsPresent: false, assessedAt: now },
    market: { instrumentId: "merrymen:meme", symbol: "MEME", instrumentClass: "memecoin", priceUsd: "0.0001", priceStale: false, signals: {} },
    expectedTradeGasUsdg: 0,
  };
  const snapshot = buildShadowSnapshot(inputs);
  return {
    runId: "fixture", agentId: "fixture", triggerId: "fixture", snapshot, tier: "pulse",
    market: { snapshot_id: snapshot.snapshotId, as_of: now, instrument_id: "merrymen:meme", symbol: "MEME", instrument_class: "memecoin", price_usd: "0.0001", signals: {}, expected_trade_gas_usdg: 0 },
    ...extra,
  };
}

async function answered(decision: Partial<BrainDecision>) {
  over = decision;
  try {
    return await decide({ url, token: "t" }, args());
  } finally {
    over = {};
  }
}

describe("a decision carrying a Solana id", () => {
  it("is refused whole, naming the field and the shape and never the id", async () => {
    const cases: [Partial<BrainDecision>, string][] = [
      [{ thesis: `the mint ${MINT} just migrated` }, "thesis carries a Solana address"],
      [{ instrument_id: MINT }, "instrument_id carries a Solana address"],
      [{ bull_case: `sig ${SIG} landed` }, "bull_case carries a Solana signature or secret key"],
      [{ risks: ["fine", "see solscan.io/token/ for the chart"] }, "risks[1] carries a Solana explorer link"],
      [{ invalidation: [`owned by ${"1".repeat(32)}`] }, "invalidation[0] carries a Solana address"],
      [{ evidence: [{ source: "s", ref: SIG, claim: "c" }] }, "evidence[0].ref carries a Solana signature or secret key"],
      [{ thesis: `owned by ${LETTERS_32}` }, "thesis carries a Solana address"],
      [{ evidence: [{ source: "s", ref: LETTERS_64, claim: "c" }] }, "evidence[0].ref carries a Solana signature or secret key"],
      // Glued to the text around it (audit regressions F3): the default scan read none of these.
      [{ thesis: `grab it CA${MINT} now` }, "thesis carries a Solana address"],
      [{ bear_case: `${MINT}is the one` }, "bear_case carries a Solana address"],
      [{ thesis: `owned by CA${LETTERS_32}` }, "thesis carries a Solana address"],
      [{ risks: [`tx${SIG}done`] }, "risks[0] carries a Solana signature or secret key"],
      [{ evidence: [{ source: "s", ref: `ref:0x${MINT}`, claim: "c" }] }, "evidence[0].ref carries a Solana address"],
    ];
    for (const [decision, why] of cases) {
      const r = await answered(decision);
      assert.equal(r.ok, false, why);
      assert.equal(!r.ok && r.kind, "malformed");
      assert.equal(!r.ok && r.detail, `refusing a decision that ${why}`);
      assert.ok(!r.ok && !r.detail.includes(MINT) && !r.detail.includes(SIG));
    }
  });

  it("keeps every 0x refusal in its old words, even when a Solana id comes first", async () => {
    let r = await answered({ thesis: `the mint ${MINT}`, bear_case: `the deployer ${EVM}` });
    assert.equal(!r.ok && r.detail, "refusing a decision that bear_case carries an address");
    r = await answered({ thesis: `router call 0xdeadbeefcafebabe00 then ${SIG}` });
    assert.equal(!r.ok && r.detail, "refusing a decision that thesis carries a hex blob");
  });

  it("leaves prose and today's ids alone", async () => {
    const r = await answered({
      thesis: "PEPE pumped 40% on the week; 41 buys / 22 sells.",
      evidence: [{ source: "trader-flow", ref: "[ref:d3fa91cr2c1]", claim: "two tracked wallets added" }],
      risks: ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        // Hex split at its zeros, and a long number: never an id glued to anything.
        "6fde6ce70efd0bc3e0c60538ccf57431cf76c354a617bd6c5a1f8198d4342cfa",
        "supply 63971511409728546707420640415976470808777281049430980144558505433936508649475518010444363585908687133263558897911835323323191563463575735092780586118530448"],
    });
    assert.ok(r.ok, JSON.stringify(r));
  });
});

describe("a desk policy carrying a Solana id", () => {
  const TODAYS_KEYS = ["agent_id", "market", "memory", "persona", "portfolio", "run_id", "schema_version", "stages", "tier", "trigger_id"];
  const forge = (terms: unknown, horizon: unknown = null) => ({ terms, horizon }) as unknown as StrategyTerms;

  it("is withheld, sends today's body, and costs no /health read", async () => {
    const asked: string[] = [];
    const capabilities = {
      advertises: (_u: string | null | undefined, c: string) => {
        asked.push(c);
        return true;
      },
      invalidate: () => {},
    };
    for (const forged of [forge(`Route via ${MINT}.`), forge("terms", "1".repeat(32)), forge(`see solscan.io/tx/${SIG}`), forge(`Route via ${LETTERS_32}.`), forge(`Replay ${LETTERS_64}.`),
      // Glued: Brain's bounds refuse these too, so sending them would cost the review a 422.
      forge(`Route via CA${MINT}.`), forge(`Replay tx${SIG}.`)]) {
      const r = await decide({ url, token: "t" }, args({ strategyTerms: forged }), { capabilities });
      assert.ok(r.ok);
      assert.equal(r.strategyTerms, "withheld");
      assert.deepEqual(Object.keys(bodies[bodies.length - 1]!).sort(), TODAYS_KEYS);
    }
    assert.deepEqual(asked, []);
    // The same forged shape without the id goes, so the id is what withheld it.
    const control = await decide({ url, token: "t" }, args({ strategyTerms: forge("Route via the pool.") }), { capabilities });
    assert.ok(control.ok);
    assert.equal(control.strategyTerms, "sent");
  });

  it("never withholds the terms the worker renders today", () => {
    const fast = trencherStrategyTerms(TRENCHER_FAST)!;
    assert.equal(onchainIdIn(fast.terms, { glued: true }), false);
    assert.equal(onchainIdIn(fast.horizon, { glued: true }), false);
  });
});
