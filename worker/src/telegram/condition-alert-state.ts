/** Only the notifier's six-hour condition cooldowns may cross a hosted restart. */
const CONDITION_KEY = /^(?:drawdown|low-gas|no-gas|withdrawal-gas|drawdown-halted:\d+(?:\.\d+)?|action-ceiling:\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/;
const MAX_CONDITIONS = 128;

export function conditionAlertTimes(value: unknown, now = Math.floor(Date.now() / 1000)): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, at]) => key.length <= 96 && CONDITION_KEY.test(key) &&
      typeof at === "number" && Number.isSafeInteger(at) && at > 0 && at <= now)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_CONDITIONS));
}

/** A cooldown belongs to the recipient who received the alert, never a fallback owner. */
export function restoredConditionAlerts(value: unknown, ownerId: number | null, now?: number): Record<string, number> {
  if (!Number.isSafeInteger(ownerId) || ownerId === null || ownerId <= 0 ||
      !value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return row.ownerId === ownerId ? conditionAlertTimes(row.firedAlerts, now) : {};
}
