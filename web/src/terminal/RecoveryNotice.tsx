import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import { shortDateTime } from "@/lib/format";
import { pausedRecovery, recoveryDetail, recoveryMemory } from "./recovery-view";

export function RecoveryNotice({ recovery }: { recovery?: FleetRecoveryView | null }) {
  const held = pausedRecovery(recovery);
  if (!held) return null;
  const memory = recoveryMemory(held);
  const beat = held.lastVerifiedHeartbeatAt;
  return <div className="agent-recovery" role="status">
    <strong>Trading paused for recovery</strong>
    <p>{recoveryDetail(held)}</p>
    {memory ? <p>{memory}</p> : null}
    {typeof beat === "number" && Number.isFinite(beat) && beat > 0
      ? <small>Last verified activity: {shortDateTime(beat * 1000)}</small> : null}
  </div>;
}
