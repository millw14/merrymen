import { CASH } from "../../packages/core/src/index";
import { GasRefused, NotRecorded, UserOpReverted, UserOpUnresolved, type AgentExecutor, type UserOpGasProof } from "./executor";
import { SponsorRefused } from "./paymaster";
import { classifyRevert } from "./revert";
import type { TradeRow } from "./store";
import { KEY_INSTALL_KIND } from "./telegram/trade-rows";

export interface KeyInstallAccounting {
  addTrade(row: TradeRow): Promise<boolean>;
  /** Execution-time price only; a recovered cost stays unpriced unless its historical price is known. */
  priceGas?(wei: bigint): Promise<number | null>;
}

/** No worker setting gets to decide who paid a settled operation. */
export function gasFields(proof: Pick<UserOpGasProof, "gasWei" | "gasUnits" | "gasPayer">,
  pricedUsdg: number | null = null): Pick<TradeRow, "gas_wei" | "sponsored_gas_wei" | "gas_units" | "gas_usdg"> | null {
  if (typeof proof.gasWei !== "bigint" || proof.gasWei < 0n || typeof proof.gasUnits !== "bigint" || proof.gasUnits < 0n ||
    (proof.gasPayer !== "owner" && proof.gasPayer !== "sponsor")) return null;
  return {
    ...(proof.gasPayer === "sponsor" ? { sponsored_gas_wei: proof.gasWei.toString() } : {
      gas_wei: proof.gasWei.toString(),
      ...(pricedUsdg !== null && Number.isFinite(pricedUsdg) && pricedUsdg >= 0 ? { gas_usdg: pricedUsdg } : {}),
    }),
    ...(proof.gasUnits > 0n ? { gas_units: proof.gasUnits.toString() } : {}),
  };
}

/** False leaves the pre-broadcast row submitted, so a later resolver can still book the expense. */
export async function settleKeyInstall(deps: KeyInstallAccounting, agentId: string, outcome: {
  userOpHash: string; success: boolean; proof: UserOpGasProof; rejectRule?: string;
}): Promise<boolean> {
  if (!gasFields(outcome.proof)) return false;
  let priced: number | null = null;
  if (outcome.proof.gasPayer === "owner" && deps.priceGas) {
    try { priced = await deps.priceGas(outcome.proof.gasWei); } catch { /* cost survives an unavailable price */ }
  }
  return deps.addTrade({
    agent_id: agentId, kind: KEY_INSTALL_KIND, target: CASH.USDG, amount_usdg: 0,
    user_op_hash: outcome.userOpHash, tx_hash: outcome.proof.txHash,
    status: outcome.success ? "landed" : "reverted",
    ...(outcome.success ? {} : { reject_rule: outcome.rejectRule ?? "reverted on-chain (resolved)" }),
    ...gasFields(outcome.proof, priced)!,
  });
}

/** Runs once under the caller's intent lock; only receipt reads, never broadcasts, may be retried. */
export async function installKeyRecorded(deps: KeyInstallAccounting & {
  refreshBudget(): Promise<void>;
  event(level: "ok" | "warn" | "err", message: string): Promise<unknown>;
  resolveMinutes: number;
}, agentId: string, executor: AgentExecutor): Promise<void> {
  let recorded = false;
  let settled = false;
  try {
    const exec = await executor.installKey({ onSubmitted: async (hash, op) => {
      recorded = await deps.addTrade({
        agent_id: agentId, kind: KEY_INSTALL_KIND, target: CASH.USDG, amount_usdg: 0,
        user_op_hash: hash, ...(op.nonce !== null ? { user_op_nonce: op.nonce.toString() } : {}), status: "submitted",
      });
      if (!recorded) throw new NotRecorded(hash);
    } });
    if (exec.gasPayer === undefined) throw new UserOpUnresolved(exec.userOpHash, "receipt did not prove the gas payer");
    settled = await settleKeyInstall(deps, agentId, { userOpHash: exec.userOpHash, success: true,
      proof: { txHash: exec.txHash, gasWei: exec.gasWei, gasUnits: exec.gasUnits, gasPayer: exec.gasPayer } });
    if (!settled) throw new UserOpUnresolved(exec.userOpHash, "the installation expense could not be written to the ledger");
    await deps.refreshBudget();
    await deps.event("ok", `installed this key's permissions on their own (${exec.txHash}): with the trade riding along they came to ` +
      `more than a key's first operation may use. Nothing was traded; the next trade goes as an ordinary operation.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof GasRefused) {
      await deps.event("warn", `couldn't install this key's permissions on their own either — nothing was signed: ${msg.slice(0, 300)}. ` +
        `If this repeats, re-sign at /grant with fewer custom tokens or capabilities.`);
      return;
    }
    if (e instanceof NotRecorded || e instanceof SponsorRefused) {
      await deps.event("warn", `didn't install this key's permissions on their own — nothing was sent: ${msg.slice(0, 300)}`);
      return;
    }
    if (e instanceof UserOpReverted && e.gasProof) {
      settled = await settleKeyInstall(deps, agentId, { userOpHash: e.userOpHash, success: false,
        proof: e.gasProof, rejectRule: classifyRevert(msg).rule });
      if (settled) {
        await deps.refreshBudget();
        await deps.event("err", `installing this key's permissions on their own reverted on-chain; its gas cost is recorded: ${msg.slice(0, 300)}`);
        return;
      }
    }
    // A failed terminal write, missing receipt or old error with no cost proof
    // retains its recovery row. No retry here can sign or broadcast again.
    if (recorded) await deps.refreshBudget();
    await deps.event("warn", settled
      ? `this key's installation outcome and gas are recorded, but a later step failed: ${msg.slice(0, 200)}`
      : recorded
        ? `installing this key's permissions on their own was submitted and its outcome or expense is not recorded yet; ` +
          `the resolver will settle it within ${deps.resolveMinutes} minutes. ${msg.slice(0, 200)}`
        : `couldn't install this key's permissions on their own: ${msg.slice(0, 300)}`);
  }
}
