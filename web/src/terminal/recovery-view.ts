import type { Autonomy } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { TelegramStatus } from "@/app/api/telegram/route";

/** Optional on older servers. Only an explicit recovery pause changes the UI. */
export function pausedRecovery(value: FleetRecoveryView | null | undefined): FleetRecoveryView | null {
  return value?.tradingPaused === true && ["checking", "history-only", "reconciling"].includes(value.state) ? value : null;
}

export function recoveryDetail(recovery: FleetRecoveryView): string {
  return recovery.history === "available"
    ? "Some saved history is available. Trading remains paused pending reconciliation."
    : "Saved trading records have not yet been verified. Trading remains paused.";
}

export function recoveryMemory(recovery: FleetRecoveryView): string | null {
  return recovery.memory === "preserved" ? "Its saved memories are preserved."
    : recovery.memory === "recovered" ? "Its saved memories have been recovered." : null;
}

export function ownerTradeEmptyTitle(recovery: FleetRecoveryView | null | undefined): string {
  return pausedRecovery(recovery) ? "No saved trades available yet" : "No trades yet.";
}

/** Presentation only: never clears a hold or changes wallet/trading authority. */
export function recoveryAutonomy(autonomy: Autonomy, recovery: FleetRecoveryView | null | undefined): Autonomy {
  if (!pausedRecovery(recovery)) return autonomy;
  return { ...autonomy, state: "checking", label: "RECOVERING", rule: null,
    reason: "Trading remains paused pending reconciliation.",
    headline: null, action: null, needsOwnerAction: false,
    moneyLabel: autonomy.simulated ? "Last recorded paper cash" : "Last recorded cash" };
}

/** Recovery is not evidence that a bot is polling or able to reply. */
export function recoveryTelegram(status: TelegramStatus | null): { label: string; detail: string | null } {
  if (!status) return { label: "Checking connection…", detail: null };
  if (!status.hasToken) return { label: "Not set up", detail: null };
  if (!status.enabled) return { label: "Switched off", detail: null };
  if (status.botElsewhere) return { label: "Connected to another agent", detail: null };
  if (status.listening?.state === "revoked" && !status.connected) return { label: "Token refused", detail: "Check the saved token in Settings." };
  if (!status.connected) return { label: "Connection unverified", detail: null };
  if (status.listening?.state === "conflict") return { label: "Another program has the bot", detail: "Replies are not confirmed." };
  return { label: "Waiting for recovery", detail: status.listening?.state === "live"
    ? "Bot polling is confirmed. Trading stays paused."
    : "Replies are not confirmed while recovery is in progress." };
}
