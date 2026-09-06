/**
 * IS PRIVY LOGIN ON, IN THE BROWSER'S OPINION? One answer, two readers.
 *
 * `Providers.tsx` decides whether to mount `PrivyProvider`, and
 * `HostedControls.tsx` decides whether to render "Continue with X". If those
 * two ever disagreed the failure is ugly and confusing: the button renders,
 * calls `usePrivy()`, and throws because no provider is above it.
 *
 * THE FORMAT IS CHECKED, not just the presence. `PrivyProvider` validates the
 * app id at construction and THROWS — which, because every `(app)` route is
 * prerendered, turns a mistyped environment variable into a failed build with
 * `Error occurred prerendering page "/agent"` and no mention of Privy in the
 * summary. A deployment with a malformed id falls back to the legacy wallet
 * login instead, which is the behaviour a half-configured environment should
 * have anyway.
 *
 * CLIENT-SAFE. `NEXT_PUBLIC_` is inlined into the browser bundle by design —
 * the app id is public. The SECRET is read only by web/src/lib/privy.ts on the
 * server, and privy-boundary.test.ts asserts that it never gains a
 * `NEXT_PUBLIC_` sibling.
 */

export const PRIVY_APP_ID = (process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "").trim();

/**
 * THE BETA SWITCH, SEPARATE FROM THE CREDENTIALS ON PURPOSE.
 *
 * The app id being present means Privy CAN work here; this means it SHOULD.
 * Keeping them apart is what lets the code ship to production with the login
 * unchanged, and lets the rollout be one variable rather than one deploy —
 * me, then three to five testers, then twenty, with a way back that does not
 * involve reverting a merge.
 *
 * NEXT_PUBLIC_ because the browser decides which button to draw, and the
 * decision has to be the same one the provider makes or a button renders with
 * no provider above it.
 */
const BETA = (process.env.NEXT_PUBLIC_MERRYMEN_PRIVY_BETA ?? "").trim() === "1";

/**
 * Privy app ids are lowercase alphanumeric, ~25 characters. Deliberately loose
 * on length — this exists to catch "unset", "changeme" and a pasted URL, not to
 * validate Privy's id scheme, which is theirs to change.
 */
export function privyEnabled(): boolean {
  return BETA && /^[a-z0-9]{18,40}$/.test(PRIVY_APP_ID);
}
