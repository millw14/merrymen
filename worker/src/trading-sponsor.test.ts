import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sponsorWillQuote, SponsorRefused } from "./paymaster";
import { createTradingSponsor, tradingSponsorArm, tradingSponsorNeedsRearm } from "./trading-sponsor";
import { execModeOf } from "./exec-mode";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const cfg = { sponsorGasEnabled: true, bundlerApiKey: "public-test-key", sponsorshipPolicyId: "sp_test_trading" };
const args = {
  sender: "0x1111111111111111111111111111111111111111" as const,
  entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const,
  chainId: 4663,
};

describe("declared trading sponsorship", () => {
  it("only explicit coverage OFF selects the existing owner-paid path", () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error("unexpected provider request"); };
    for (const overrides of [{}, { bundlerApiKey: undefined }, { sponsorshipPolicyId: undefined }]) {
      assert.equal(createTradingSponsor({ ...cfg, ...overrides, sponsorGasEnabled: false }, 4663), undefined);
    }
    assert.equal(requests, 0);
  });

  it("refuses enabled coverage with a missing or blank key/policy before any provider access", () => {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error("unexpected provider request"); };
    for (const overrides of [
      { bundlerApiKey: undefined }, { bundlerApiKey: "  " },
      { sponsorshipPolicyId: undefined }, { sponsorshipPolicyId: "  " },
    ]) {
      assert.throws(() => createTradingSponsor({ ...cfg, ...overrides }, 4663),
        (e: unknown) => e instanceof SponsorRefused && e.rule === "sponsor-refused" && /Live trading is blocked/.test(e.message) && !e.message.includes(cfg.bundlerApiKey));
    }
    assert.equal(requests, 0);
  });

  it("keeps explicit paper practice available without a live executor, but blocks consent promotion", () => {
    for (const overrides of [{ bundlerApiKey: undefined }, { sponsorshipPolicyId: undefined }]) {
      const paperCfg = { ...cfg, ...overrides, liveTradingEnabled: false };
      const arm = tradingSponsorArm(paperCfg, 4663);
      assert.equal(arm.paperOnly, true);
      assert.equal(arm.sponsor, undefined);
      assert.match(arm.reason ?? "", /Live trading is blocked/);
      assert.equal(execModeOf({ armed: true, executor: false, chainId: 4663, cashUsdg: 100n,
        gasWei: 100n, gasSponsored: false, deadPolicy: false,
        liveTradingEnabled: false, paperTradingEnabled: true }).mode, "paper");
      assert.throws(() => tradingSponsorArm({ ...paperCfg, liveTradingEnabled: true }, 4663), SponsorRefused);
      assert.throws(() => tradingSponsorArm({ ...paperCfg, enforceLiveIntent: false }, 4663), SponsorRefused,
        "legacy consent migration is not permission to run a paper-only arm unsponsored");
    }
  });

  it("rebuilds a paper-only arm on live consent even after key/policy recovery or explicit coverage OFF", () => {
    const armed = { sponsorBlockedPaperOnly: true };
    const paperCfg = { ...cfg, sponsorshipPolicyId: undefined, liveTradingEnabled: false };
    assert.equal(tradingSponsorNeedsRearm(paperCfg, armed), false);
    assert.equal(tradingSponsorNeedsRearm({ ...paperCfg, liveTradingEnabled: true }, armed), true);
    const recovered = { ...cfg, liveTradingEnabled: true };
    assert.equal(tradingSponsorNeedsRearm(recovered, armed), true);
    assert.ok(tradingSponsorArm(recovered, 4663).sponsor);
    assert.equal(tradingSponsorNeedsRearm({ ...recovered, sponsorGasEnabled: false }, armed), true);
    assert.equal(tradingSponsorArm({ ...recovered, sponsorGasEnabled: false }, 4663).sponsor, undefined);
    assert.equal(tradingSponsorNeedsRearm(recovered, { sponsorBlockedPaperOnly: false }), false);
  });

  it("keeps the real sponsor and pinned policy after an arm probe refusal, and refuses the final quote", async () => {
    const requests: { method: string; params: unknown[] }[] = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.pimlico.io/v2/4663/rpc?apikey=public-test-key");
      const rpc = JSON.parse(String(init?.body)); requests.push(rpc);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "policy budget exhausted" } });
    };
    const sponsor = createTradingSponsor(cfg, 4663);
    assert.ok(sponsor);
    assert.deepEqual(sponsor.paymasterContext, { sponsorshipPolicyId: cfg.sponsorshipPolicyId });
    const probe = await sponsorWillQuote(sponsor, args);
    assert.equal(probe.ok, false);
    await assert.rejects(sponsor.paymaster.getPaymasterData({
      ...args, entryPointAddress: args.entryPoint, nonce: 0n, callData: "0x1234",
      context: sponsor.paymasterContext, callGasLimit: 100_000n,
      verificationGasLimit: 100_000n, preVerificationGas: 50_000n,
      maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
    }), (e: unknown) => e instanceof SponsorRefused && e.rule === "sponsor-refused");
    assert.deepEqual(requests.map(r => r.method), ["pm_getPaymasterStubData", "pm_getPaymasterData"]);
    for (const r of requests) assert.deepEqual(r.params[3], { sponsorshipPolicyId: cfg.sponsorshipPolicyId });
  });

  it("an arm probe declined by a calldata policy can still quote the permitted operation without self-pay", async () => {
    globalThis.fetch = async (_input, init) => {
      const rpc = JSON.parse(String(init?.body));
      return Response.json(rpc.method === "pm_getPaymasterStubData"
        ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "empty calls are not in the policy" } }
        : { jsonrpc: "2.0", id: rpc.id, result: { paymaster: "0x3333333333333333333333333333333333333333", paymasterData: "0x1234" } });
    };
    const sponsor = createTradingSponsor(cfg, 4663);
    assert.ok(sponsor);
    assert.equal((await sponsorWillQuote(sponsor, args)).ok, false);
    const quote = await sponsor.paymaster.getPaymasterData({
      ...args, entryPointAddress: args.entryPoint, nonce: 0n, callData: "0x1234",
      context: sponsor.paymasterContext,
    });
    assert.equal(quote.paymaster, "0x3333333333333333333333333333333333333333");
    assert.equal(quote.paymasterData, "0x1234");
  });
});
