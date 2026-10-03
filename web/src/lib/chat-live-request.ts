/**
 * A model may propose live trading only when this message explicitly asks for
 * it. History, a paper-mode blocker, and questions about the switch are not a
 * request. This is proposal eligibility only; the owner still confirms the
 * card, and execution keeps its existing authority and limits.
 *
 * Match complete requests using the registry's English command vocabulary,
 * rather than a substring such as "go live" inside a quote or explanation.
 * Ambiguous or unsupported phrasing leaves the reply as ordinary chat.
 */
const PREFIX = String.raw`(?:(?:hi|hello|hey)(?:\s+there)?[,!\s]+)?(?:(?:yes|ok|okay)[,\s]+)?(?:please[,\s]+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please[,\s]+)?)|(?:i\s+(?:want|would\s+like)\s+(?:you\s+)?to\s+)|(?:i(?:\s+am|'m)\s+ready\s+to\s+)|(?:let(?:'s|\s+us)\s+))?`;
const MODE = String.raw`(?:live\s+trading|real(?:\s+money)?\s+trading)`;
const ACTION = String.raw`(?:go\s+live|(?:start|enable|activate)\s+(?:(?:my|your)\s+)?${MODE}|(?:turn|switch)\s+on\s+${MODE}|(?:turn|switch)\s+${MODE}\s+on|switch\s+(?:(?:me|us)\s+)?to\s+(?:live(?:\s+(?:trading|mode))?|real\s+money)|use\s+real\s+money|trade\s+for\s+real|start\s+trading\s+(?:live|with\s+real\s+money))`;
const SUFFIX = String.raw`(?:\s+(?:now|today|from\s+now\s+on|for\s+me|within\s+(?:my|the)\s+(?:(?:current|signed)\s+)?(?:limits|caps)))*(?:[,\s]+(?:please|thanks|thank\s+you))*[.!?]*`;
const REQUEST = new RegExp(`^${PREFIX}${ACTION}${SUFFIX}$`, "i");

export function requestsLiveTrading(message: unknown): boolean {
  if (typeof message !== "string" || message.length > 2_000) return false;
  const text = message.normalize("NFKC").replace(/[\u2018\u2019]/g, "'")
    .replace(/[-\u2010-\u2015]/g, " ").replace(/\s+/g, " ").trim();
  return REQUEST.test(text);
}
