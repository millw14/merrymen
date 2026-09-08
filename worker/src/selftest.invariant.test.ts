import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RIALTO, UNISWAP, type GrantCaps } from "../../packages/core/src/index";
import { buildCallPermissions } from "../../packages/core/src/wall";

/**
 * `merrymen selftest` IS THE GATE BEFORE REAL MONEY.
 *
 * cli/bin.mjs walks a first-timer to it as onboarding step 4, "prove the shot
 * lands". Three separate things made it prove nothing:
 *
 *  1. It exited 0 unconditionally. processIntent absorbs every failure — a
 *     policy rejection, no-route, no-gas, a bundler refusal, an on-chain revert
 *     all record a row and return normally — so "did not throw" carries no
 *     information whatsoever. It printed "done" for UserOps the wall refused.
 *  2. The approve leg was hardcoded to the Rialto router, so a green result
 *     said nothing about the default Uniswap path. Worse — see the test below —
 *     Rialto is not in the wall of any grant this repo can sign, so the probe
 *     violated the call policy on every install, and reported success.
 *  3. It passed equityUsdg = 0n with equityKnown defaulting to true: an
 *     unknown book asserted as a zero one, in a codebase whose central rule is
 *     that unknown is never representable as zero.
 *
 * index.ts exports nothing, so the wiring is pinned as source. The claim about
 * the WALL below is checked for real, against the real permission builder.
 */

const SRC = readFileSync(fileURLToPath(new URL("index.ts", import.meta.url)), "utf8");
/*
  TWO SLICES, because the probe moved out of the CLI block.

  It used to live inline under `if (selftest)`. It is now runSelftestProbe,
  shared by the CLI and by the dashboard command a hosted deployment queues —
  hosted spawns the worker without --selftest, so the CLI-only version was
  unreachable for every hosted tenant, which is how a fleet-wide arming failure
  stayed invisible for hours.
*/
/** What runs, and how its verdict is reached. */
const PROBE = SRC.slice(
  SRC.indexOf("  async function runSelftestProbe("),
  SRC.indexOf("  let lastStrandedAt = 0;"),
);
/** The CLI wrapper: exit codes, and the caveats a terminal user is shown. */
const SELFTEST = SRC.slice(SRC.indexOf("  if (selftest) {"));

test("the probe approves the router this install will actually use", () => {
  const intent = SRC.slice(SRC.indexOf("function selfTestIntent("), SRC.indexOf("/** Everything tied to the currently"));
  assert.match(intent, /target:\s*swapRouterFor\(cfg\)/, "the probe's target must follow swapVenue");
  assert.doesNotMatch(intent, /RIALTO\./, "no hardcoded venue in the probe");
  // And the approve call it actually emits.
  assert.match(
    SRC,
    /args:\s*\[swapRouterFor\(cfg\),\s*intent\.sellAmountRaw\]/,
    "the approve spender must follow swapVenue too — the intent and the calldata must agree",
  );
});

test("a grant this repo can sign does NOT carry the Rialto router — which is why the old probe always violated the wall", () => {
  // Not a source scan: the actual wall, from the actual builder, with the
  // options both signers actually pass (neither passes allowRialto).
  const SELF = "0x00000000000000000000000000000000000000a1" as const;
  const CAPS: GrantCaps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
  const perms = buildCallPermissions(CAPS, SELF) as unknown as { target: string; functionName?: string }[];
  const targets = perms.map((p) => p.target.toLowerCase());
  assert.equal(
    targets.includes(RIALTO.routerSnapshot.toLowerCase()),
    false,
    "Rialto is opt-in and no signer opts in — so approving it could only ever be refused",
  );
  assert.equal(
    targets.includes(UNISWAP.swapRouter02.toLowerCase()),
    true,
    "…while the Uniswap router IS in every wall, so the probe now approves something real",
  );
});

test("selftest fails loudly unless the probe LANDED", () => {
  // IT MUST READ THE LEDGER ROW, not the absence of an exception. It used to
  // read the global `lastTradeOutcome` directly after the await; it now takes
  // the verdict back from `processIntentReporting`, which clears, runs and
  // reads INSIDE the serialising chain. Strictly stronger — the old shape could
  // be handed the previous intent's outcome, because every early return in
  // processIntentLocked leaves it standing — so the assertion moves with it
  // rather than pinning the weaker mechanism.
  assert.match(
    PROBE,
    /const outcome = await processIntentReporting\(/,
    "the verdict must come from the row this intent wrote, not from a global read after the fact",
  );
  // The VERDICT belongs to the probe; the EXIT CODE belongs to the CLI. Split
  // because the probe is now shared with a dashboard command that has no
  // process to exit — and a shared probe is the whole point: the copy that
  // drifts is always the one nobody runs, which for months was the hosted one,
  // because there wasn't one.
  assert.match(
    PROBE,
    /status !== "landed"[\s\S]{0,400}ok: false/,
    "anything other than 'landed' must be a failing verdict — a green light for a refused UserOp is worse than no check",
  );
  assert.match(PROBE, /!outcome[\s\S]{0,200}ok: false/, "no row at all must also fail");
  assert.match(
    SELFTEST,
    /!result\.ok[\s\S]{0,300}process\.exit\(1\)/,
    "and the CLI must turn a failing verdict into a non-zero exit",
  );
  // The success line must not overclaim: it proves approve, not the swap.
  assert.match(SELFTEST, /PASSED/, "sanity: there is still a success path");
  assert.match(
    SELFTEST,
    /swap call itself is not covered/i,
    "say what green does NOT mean — this never exercises exactInputSingle",
  );
});

test("selftest declares the probe's book UNKNOWN rather than zero", () => {
  assert.match(
    PROBE,
    // Either wrapper — both serialise on the same chain. What is pinned is the
    // third argument.
    /processIntent(?:Reporting)?\(probe, 0n, false\)/,
    "equityKnown must be false — passing 0n as a known equity is the exact 'unknown as zero' bug this codebase exists to avoid",
  );
});

test("selftest warns when the answer cannot mean what it looks like", () => {
  // Both are cases where the run can go green while proving nothing: a testnet
  // grant approves an address with no code, and a Rialto-configured install is
  // about to be refused by a wall that never carried its router.
  //
  // The chain caveat is in the PROBE, so the dashboard gets it too — a hosted
  // tenant on testnet needs that sentence at least as much as a terminal user.
  // The Rialto note stays CLI-only: swapVenue 'rialto' is not reachable from
  // the hosted settings API, which strips the field.
  assert.match(PROBE, /TRADEABLE_CHAIN_ID/, "a non-mainnet grant must be called out, on both surfaces");
  assert.match(SELFTEST, /swapVenue === "rialto"/, "a Rialto install must be told the wall will refuse");
});

test("the CLI and the dashboard run the SAME probe", () => {
  // The hosted gap existed precisely because only one caller had one.
  assert.match(PROBE, /async function runSelftestProbe/, "the shared probe must exist");
  assert.match(SELFTEST, /runSelftestProbe\("selftest"\)/, "the CLI must call it");
  assert.match(SRC, /runSelftestProbe\("dashboard"\)/, "the queued command must call it too");
});
