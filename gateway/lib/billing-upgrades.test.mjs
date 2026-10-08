/**
 * TWO UPGRADES IN ONE PERIOD.
 *
 * An upgrade charges the pro-rated difference between the new tier's price and
 * the price the period was bought at (lib/billing.mjs decide()). After a first
 * upgrade, "bought at" is the tier that upgrade bought, not the tier the period
 * started on: Crumbs -> Loaf -> Feast must charge Feast minus LOAF for the time
 * left, or the second step charges again for the difference the first one
 * already paid. billing.test.mjs covers single upgrades, where the two readings
 * agree; this is the case where they do not, live and after a replay.
 *
 * `node --test lib/billing-upgrades.test.mjs`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBilling, openLedger } from "./billing.mjs";
import { ONE_TOKEN, PERIOD_MS } from "./billing-plans.mjs";

const OWNER = `0x${"c3".repeat(20)}`;
const START = 1_800_000_000_000;
const raw = (tokens) => (BigInt(tokens) * ONE_TOKEN).toString();

const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test("a second upgrade in one period is priced against the tier the first one bought, live and after a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "merrymen-upgrades-"));
  dirs.push(dir);
  const clock = { t: START };
  const boot = () => createBilling({ dataDir: dir, mode: "enforce", now: () => clock.t, log: () => {}, timers: false, keyRegistry: async () => new Map() });
  let billing = await boot();
  assert.equal((await billing.createAccount(OWNER, "Acme")).status, 201);
  // Credit as the operator CLI grants it, picked up by the gateway's tail.
  const cli = await openLedger({ dataDir: dir, now: () => clock.t, log: () => {} });
  const acct = cli.state.byOwner.get(OWNER);
  await cli.enqueue(() => cli.append({ type: "adjustment", account_id: acct.account_id, amount_raw: raw(1_000_000), note: "test", operator: true }));
  await billing.tail();

  const choose = async (tier) => {
    const r = await billing.choosePlan(OWNER, { tier, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  assert.equal((await choose("crumbs")).plan.id, "crumbs"); // 100,000 for [START, START + 30 days)
  clock.t = START + PERIOD_MS / 3;
  // Loaf for the last two thirds: (400,000 - 100,000) x 2/3.
  assert.equal((await choose("loaf")).plan.id, "loaf");
  clock.t = START + (2 * PERIOD_MS) / 3;
  // A preview says what confirming will charge, before anything is written.
  const preview = (await billing.choosePlan(OWNER, { tier: "feast" })).json;
  assert.deepEqual([preview.effect, preview.charge_now_raw], ["upgrade_now", raw(200_000)]);
  // Feast for the last third: (1,000,000 - 400,000) x 1/3, NOT (1,000,000 - 100,000) x 1/3.
  const feast = await choose("feast");
  assert.equal(feast.plan.id, "feast");
  assert.equal(feast.plan.ends_at, new Date(START + PERIOD_MS).toISOString(), "an upgrade never moves the period's end");

  const charges = (await readFile(path.join(dir, "billing.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.type === "charge");
  assert.deepEqual(charges.map((c) => [c.reason, c.tier, c.price_raw, c.tier_price_raw]), [
    ["activate", "crumbs", raw(100_000), raw(100_000)],
    ["upgrade", "loaf", raw(200_000), raw(400_000)],
    ["upgrade", "feast", raw(200_000), raw(1_000_000)],
  ]);
  assert.equal(new Set(charges.map((c) => c.period_id)).size, 1, "one period throughout");
  // 1,000,000 granted, 500,000 charged; renewing on Feast needs the other 500,000.
  const summary = (v) => [v.plan.id, v.credit_tokens, v.due_for, v.due_tokens];
  assert.deepEqual(summary(feast), ["feast", "500000", "renewal", "500000"]);

  // A restart replays the same three lines into the same account.
  billing = await boot();
  assert.deepEqual(summary(billing.accountView(OWNER).json), summary(feast));
  assert.equal(await billing.settle(OWNER), 0, "nothing is charged again after a replay");
});
