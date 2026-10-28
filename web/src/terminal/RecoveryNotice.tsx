import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import { shortDateTime } from "@/lib/format";
import { pausedRecovery, recoveryDetail, recoveryMemory, type RecoveryFunds } from "./recovery-view";

/**
 * `funds` is optional and separate from `recovery` on purpose: the hold comes
 * from the worker's recovery row, the funds from the grant and chain read in the
 * same /api/grants answer (recoveryFunds). A surface without that answer draws
 * the notice exactly as before, and nothing about funds is guessed.
 */
export function RecoveryNotice({ recovery, funds }: { recovery?: FleetRecoveryView | null; funds?: RecoveryFunds | null }) {
  const held = pausedRecovery(recovery);
  if (!held) return null;
  const memory = recoveryMemory(held);
  const beat = held.lastVerifiedHeartbeatAt;
  return <div className="agent-recovery" role="status">
    <strong>Trading paused for recovery</strong>
    <p>{recoveryDetail(held)}</p>
    {memory ? <p>{memory}</p> : null}
    {funds ? <>
      {/* "VAULTS IT OWNS", NOT "VAULTS IT CONTROLS". The per-account vaults —
          the class vault(s) and the Trencher vault — are CREATE2-salted with
          this smart account as their owner, so "owns" is the chain's own word
          for them. The Morpho vault is not one of them: the account holds its
          shares as a balance in the account itself and controls nothing about
          the vault. "Any", because an account may have none of these yet, or
          several (class v1 and v2, Trencher). */}
      <p>
        Your funds are in your smart account{" "}
        {funds.explorer
          ? <a href={funds.explorer} target="_blank" rel="noreferrer" title={funds.account}>{funds.short}</a>
          : <span title={funds.account}>{funds.short}</span>}
        {funds.testnet ? " on the test network" : null} and in any vaults it owns.
      </p>
      <p>{funds.cash}</p>
      {funds.excludes ? <small>{funds.excludes}</small> : null}
      {funds.paper ? <p>{funds.paper}</p> : null}
      {funds.withdraw ? <p>{funds.withdraw}</p> : null}
    </> : null}
    {typeof beat === "number" && Number.isFinite(beat) && beat > 0
      ? <small>Last verified activity: {shortDateTime(beat * 1000)}</small> : null}
  </div>;
}
