/**
 * THE OWNER'S LINE ABOUT A POLICY REFUSAL, and when it is news.
 *
 * Lifted out of index.ts's processIntent unchanged in behaviour, so the half of
 * a refusal that reaches the OWNER can be executed by a test beside the half
 * that reaches the PUBLIC feed. The two used to be joined only by the fact that
 * nothing ever filtered either; once the public gate learned to drop a
 * strategy's account-wide refusals (thesis-policy.ts), "the owner still hears
 * it" became a claim that needed proving rather than assuming.
 *
 * PURE, for that reason: it takes the last key it was told about and returns the
 * next one, and index.ts keeps the state.
 */

/**
 * Rules that are about the account's own state, not about an asset.
 *
 * Everything not listed here is treated as token-specific, which is the safe
 * direction: the cost of over-reporting is a repeated line, and the cost of
 * under-reporting is an owner never hearing about the second broken token.
 */
export const ACCOUNT_WIDE_RULES: ReadonlySet<string> = new Set([
  "expiry",
  "ops-cap",
  "per-trade-cap",
  "daily-cap",
  "deposit-cap",
  "drawdown-breaker",
  "scout-budget",
  "transfer-not-permitted",
  "non-positive",
]);

/**
 * The key this refusal is de-duplicated under, and the line to write — or null
 * when the owner was already told this exact thing last time.
 *
 * KEYED BY WHAT THE RULE IS ABOUT. A budget rule is about the ACCOUNT, so
 * `daily-cap` on QQQ and on NVDA are one piece of news; an asset rule is about
 * the TOKEN, so two coins failing `asset-allowlist` are two things to act on.
 */
export function ownerRefusalNotice(
  last: string | null,
  verdict: { rule: string; detail: string },
  kind: string,
  legs: { sell_token?: string | null; buy_token?: string | null },
): { key: string; line: string | null } {
  const key = ACCOUNT_WIDE_RULES.has(verdict.rule)
    ? `${verdict.rule}|${kind}`
    : `${verdict.rule}|${kind}|${legs.sell_token ?? ""}|${legs.buy_token ?? ""}`;
  return { key, line: key === last ? null : `policy rejected ${kind}: ${verdict.rule} — ${verdict.detail}` };
}
