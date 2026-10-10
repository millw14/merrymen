/**
 * REHEARSE A CLASS BUY AGAINST THE LIVE CHAIN, sending nothing.
 *
 * The class route has no simulation step: the vault executor arm reads the
 * vault's code and builds calls, and the only pre-trade checks are the
 * producer's own reserve arithmetic. pons-simulate.ts rehearses the OTHER curve
 * venue (PonsSelfTrade) through `eth_simulateV1`, and decodes that adapter's
 * `tradeExactIn` return — which is the wrong ABI for a vault `buy`. This is the
 * vault's own version: same node method, same two-calls-in-one-block shape
 * (the approve has to be visible to the buy, exactly as inside one UserOp),
 * decoded against `PonsClassVault.buy(...) returns (uint256 tokensOut)`.
 *
 * WHAT A GREEN RESULT MEANS AND DOES NOT. It means that, at the block the node
 * simulated, the account's approve and the vault's buy both succeed and the
 * curve would deliver `tokensOut` at or above the floor. It does not mean the
 * next block will agree — a curve moves 1,546 bps at p99 over four minutes
 * (pons-price.ts) — and it is not a permission: the wall's `checkPolicy` has
 * already said yes or no by the time anyone simulates, and a rehearsal that
 * passes on a refused intent is still a refused intent.
 *
 * A refusal is a reason, never a throw. The harness that calls this must not be
 * taken down by a node that lacks `eth_simulateV1`.
 */
import type { PublicClient } from "viem";
import { decodeFunctionResult } from "viem";
import { PONS_CLASS_VAULT_ABI } from "../../../packages/core/src/index";
import type { Call } from "../executor";

export type ClassSimResult =
  | { ok: true; tokensOut: bigint; gasUsed: bigint }
  | { ok: false; reason: string };

export async function simulateClassBuy(opts: {
  client: Pick<PublicClient, "request">;
  /** The smart account — the vault's owner, and the USDG holder. */
  account: `0x${string}`;
  /** Exactly what buildClassBuyCalls returned: approve, then buy. */
  calls: readonly Call[];
}): Promise<ClassSimResult> {
  if (opts.calls.length !== 2) {
    return { ok: false, reason: `expected an approve and a buy, got ${opts.calls.length} calls` };
  }
  try {
    const res = (await opts.client.request({
      method: "eth_simulateV1",
      params: [
        {
          blockStateCalls: [
            {
              calls: opts.calls.map((c) => ({
                from: opts.account,
                to: c.to,
                data: c.data,
                value: `0x${c.value.toString(16)}`,
              })),
            },
          ],
          traceTransfers: false,
          validation: false,
        },
        "latest",
      ],
    } as never)) as { calls: { status: string; returnData: string; gasUsed: string; error?: { message: string } }[] }[];

    const block = res?.[0];
    if (!block || !Array.isArray(block.calls) || block.calls.length !== 2) {
      return { ok: false, reason: "the node returned a shape this code does not understand" };
    }
    const [approve, buy] = block.calls;
    if (approve!.status !== "0x1") {
      return { ok: false, reason: `the approve reverted: ${approve!.error?.message ?? "no reason given"}` };
    }
    if (buy!.status !== "0x1") {
      const sel = buy!.returnData?.slice(0, 10) ?? "";
      return { ok: false, reason: `the vault buy reverted${sel ? ` (${sel})` : ""}: ${buy!.error?.message ?? ""}`.trim() };
    }
    const tokensOut = decodeFunctionResult({
      abi: PONS_CLASS_VAULT_ABI,
      functionName: "buy",
      data: buy!.returnData as `0x${string}`,
    }) as bigint;
    return { ok: true, tokensOut, gasUsed: BigInt(buy!.gasUsed) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
