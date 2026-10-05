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
      <p>
        Your funds are in your smart account{" "}
        {funds.explorer
          ? <a href={funds.explorer} target="_blank" rel="noreferrer" title={funds.account}>{funds.short}</a>
          : <span title={funds.account}>{funds.short}</span>}
        {funds.testnet ? " on the test network" : null} and the vaults it controls.
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
