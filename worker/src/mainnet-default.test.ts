import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { GAS_FLOOR_USDG, preflight, verdict, type PreflightInput } from "./preflight";
import { SETTINGS_DEFAULTS } from "../../packages/core/src/index";

/**
 * THE DEFAULT MUST LEAD SOMEWHERE.
 *
 * /grant defaulted to testnet 46630, and preflight classifies exactly that as a
 * hard BLOCKER — not as a policy choice but as a fact: every token and router
 * address merrymen knows is a mainnet deployment, so on testnet a balance reads
 * as zero and every route is refused. The most likely outcome of accepting every
 * default was an agent that could never trade, and a user asking why.
 */

const NOW = 1_800_000_000;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";

/** A fresh install that has done nothing but sign and fund. */
function freshInstall(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    settings: {
      bundlerApiKey: "pim_x",
      basketSymbols: SETTINGS_DEFAULTS.basketSymbols as string[],
      buyPerTickUsdg: SETTINGS_DEFAULTS.buyPerTickUsdg,
      idleFloorUsdg: SETTINGS_DEFAULTS.idleFloorUsdg,
    },
    grant: {
      smartAccount: ACCOUNT,
      owner: ACCOUNT,
      sessionKeyAddress: ACCOUNT,
      serialized: "x",
      caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 },
      grantedAt: NOW,
      expiresAt: NOW + 7 * 86_400,
      chainId: 4663,
      grantFeatures: ["tradeable-v2"],
    } as never,
    nowSec: NOW,
    usdg: 100,
    ethWei: 10n ** 16n,
    bundlerReachable: true,
    missingPolicyContracts: [],
    deadPolicy: false,
    accountDeployed: true,
    ...over,
  };
}

const ids = (i: PreflightInput, level: string) =>
  preflight(i).filter((c) => c.level === level).map((c) => c.id);

test("the shipped chain default is one preflight calls tradeable", () => {
  const src = readFileSync("web/src/app/grant/page.tsx", "utf8");
  assert.match(src, /useState<number>\(MAINNET\)/, "the grant page must open on mainnet");
  assert.equal(
    /useState<number>\(TESTNET\)/.test(src),
    false,
    "the old default produced an agent that could never trade",
  );
});

test("a fresh mainnet install has NO blockers", () => {
  const v = verdict(preflight(freshInstall()));
  assert.equal(v.ready, true, `blockers: ${ids(freshInstall(), "blocker").join(", ")}`);
});

test("the same install on the OLD default is blocked — which is the point", () => {
  const onTestnet = freshInstall({ grant: { ...freshInstall().grant!, chainId: 46630 } as never });
  assert.ok(ids(onTestnet, "blocker").includes("chain"));
});

test("the caps default is the scout, sized for an account with nothing in it yet", () => {
  // Caps are sealed BEFORE funding, so the default cannot be sized to capital
  // nobody has deposited. The outlaw's 50 x 48 is a four-figure ceiling to hand
  // someone who has not seen the thing trade once.
  const src = readFileSync("web/src/app/grant/page.tsx", "utf8");
  assert.match(src, /useState<GrantCaps>\(PRESETS\[0\]!\.caps\)/);
  assert.equal(/useState<GrantCaps>\(DEFAULTS\)/.test(src), false);
});

test("nothing in web/ still falls back to testnet when a chain is unknown", () => {
  // These fired precisely during onboarding — before a chain had been chosen —
  // so the console stamped "testnet 46630" into its footer and offered a faucet
  // to someone the grant page was about to put on mainnet.
  //
  // The console was replaced by /you; the property belongs to whatever renders
  // an agent's chain, not to the file that used to.
  for (const f of ["web/src/lib/session.ts", "web/src/app/(app)/you/YouClient.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.equal(/robinhoodTestnet\.id/.test(src), false, `${f} still defaults to testnet`);
    assert.equal(/\?\?\s*46630/.test(src), false, `${f} still falls back to 46630`);
  }
});

test("practice is still reachable — simplification is not removal", () => {
  // The owner's decision was to fix paper and KEEP practice, not to delete it.
  // A user who wants to watch before risking anything must still be able to.
  const src = readFileSync("web/src/app/grant/page.tsx", "utf8");
  assert.match(src, /setChainId\(TESTNET\)/, "the practice card must still be clickable");
  assert.match(src, /Practice \(testnet\)/);
});

test("the real-money acknowledgement survives the flip", () => {
  // Mainnet-by-default makes this MORE load-bearing, not less: it is now the
  // first thing standing between a new user and a real-funds wall. Deleting it
  // and calling that "one less step" would be trading a warning for a metric.
  const src = readFileSync("web/src/app/grant/page.tsx", "utf8");
  assert.match(src, /const createBlocked = isMainnet && !mainnetAck;/);
  assert.match(src, /acknowledge the real-funds warning above first/);
});

test("GAS_FLOOR_USDG is still the floor Stage 4 has to clear", () => {
  // Not fixed here — recorded so the next stage has a failing expectation to
  // aim at rather than a paragraph to remember.
  const legs = (SETTINGS_DEFAULTS.basketSymbols as string[]).length;
  const perLeg = SETTINGS_DEFAULTS.buyPerTickUsdg / legs;
  assert.ok(perLeg < GAS_FLOOR_USDG, "if this ever passes, delete this test and the Stage 4 item");
});
