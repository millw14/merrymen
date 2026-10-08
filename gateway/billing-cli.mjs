#!/usr/bin/env node
/**
 * Operator CLI for API billing: read accounts, correct credit, comp a plan,
 * and dry-run the payment reconciliation.
 *
 * Run it where the gateway runs, on the same volume (`railway ssh`), with the
 * gateway's environment, so it reads the same $MERRYMEN_DATA_DIR/billing.jsonl:
 *
 *   node billing-cli.mjs list
 *   node billing-cli.mjs show <wallet>
 *   node billing-cli.mjs adjust <wallet> <±tokens> --note "credited by hand: tx 0x… paid the old address"
 *   node billing-cli.mjs comp <wallet> <tier> <days> --note "launch partner"
 *   node billing-cli.mjs reconcile [--all]
 *
 * WRITES GO THROUGH THE GATEWAY'S OWN WRITER (lib/billing.mjs openLedger): the
 * same torn-tail repair, one flushed line per change. The running gateway
 * picks an adjustment or a comp up within 10 seconds; it accepts no other
 * record type from another process, so this CLI writes no other.
 *
 * Nothing here is reachable over HTTP, and nothing here moves tokens: an
 * adjustment changes API credit only. A comp is a period of a tier at no
 * charge, refused while a period the developer paid for is running. Both need
 * the developer to have created an account in the portal.
 * `reconcile` reads the chain and writes nothing; the gateway itself reverses
 * a payment that a reorg undid, every five minutes.
 */

import { createBilling, createPaymentsClient, openLedger, parseBillingConfig } from "./lib/billing.mjs";
import { PERIOD_MS, PLANS, formatTokens, parseTokens } from "./lib/billing-plans.mjs";
import { randomBytes } from "node:crypto";

const DAY = 86_400_000;
const config = parseBillingConfig(process.env);

function die(msg) {
  console.error(`[billing] ${msg}`);
  process.exit(1);
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

const wallet = (raw) => {
  const w = String(raw ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(w)) die(`not a wallet address: ${raw ?? "(missing)"}`);
  return w;
};

/** Every write states why. The note stays in the ledger; the developer never sees it. */
function note(argv) {
  const n = flag(argv, "note");
  if (!n || !n.trim() || n.length > 500 || /[\x00-\x1f\x7f]/.test(n)) die("--note \"why\" is required (at most 500 characters, one line)");
  return n.trim();
}

/** A read-only view of the gateway's files, computed the way the gateway computes it. */
const view = (extra = {}) => createBilling({ ...config, readOnly: true, publicClient: null, log: (l) => console.error(l), ...extra });

async function writer() {
  const ledger = await openLedger({ dataDir: config.dataDir, log: (l) => console.error(l) });
  if (ledger.fatal) die(`the ledger is ${ledger.fatal}: not writing. Repair ${ledger.file} first.`);
  return ledger;
}

async function list() {
  const billing = await view();
  const ledger = await openLedger({ dataDir: config.dataDir, log: () => {} });
  const accounts = [...ledger.state.accounts.values()];
  if (!accounts.length) return console.log("[billing] no accounts.");
  for (const a of accounts) {
    const v = billing.accountView(a.owner).json;
    const ends = v.plan.ends_at ? ` until ${v.plan.ends_at.slice(0, 10)}` : "";
    console.log(`  ${a.owner}  ${v.plan.id.padEnd(6)}${ends.padEnd(17)}  credit ${v.credit_tokens.padStart(12)}  selected ${v.plan.selected}  ${JSON.stringify(a.name)}`);
  }
}

async function show(argv) {
  const owner = wallet(argv[1]);
  const billing = await view();
  const r = billing.accountView(owner);
  if (r.status !== 200) die(`no account for ${owner}`);
  const v = r.json;
  console.log(`\n  account   ${v.account.id}  ${JSON.stringify(v.account.name)}  created ${v.account.created_at}`);
  console.log(`  wallet    ${v.account.wallet}`);
  console.log(`  plan      ${v.plan.id}${v.plan.ends_at ? ` ${v.plan.starts_at} → ${v.plan.ends_at}` : ""}  selected ${v.plan.selected}${v.plan.renews_on_next_request ? "  (renews on next request)" : ""}`);
  console.log(`  credit    ${v.credit_tokens} MERRYMEN${v.due_tokens ? `  due ${v.due_tokens} for ${v.due_for}` : ""}`);
  console.log(`  usage     ${v.usage.used} / ${v.usage.limit} until ${v.usage.resets_at}${v.usage.by_key.length ? `  (${v.usage.by_key.map((k) => `${k.key_id} ${k.used}`).join(", ")})` : ""}`);
  console.log("  history:");
  for (const h of v.history) console.log(`    ${h.at}  ${h.type.padEnd(10)}  ${h.amount_tokens.padStart(14)}  ${[h.tier, h.reason, h.tx_hash].filter(Boolean).join("  ")}`);
  console.log("");
}

async function adjust(argv) {
  const owner = wallet(argv[1]);
  let amount;
  try { amount = parseTokens(argv[2]); } catch { die("adjust needs a signed token amount, such as +25000 or -100.5"); }
  if (amount === 0n) die("an adjustment of zero changes nothing");
  const why = note(argv);
  const ledger = await writer();
  const acct = ledger.state.byOwner.get(owner);
  if (!acct) die(`no account for ${owner}: the developer creates one at merrymen.dev/api first`);
  await ledger.enqueue(() => ledger.append({ type: "adjustment", account_id: acct.account_id, amount_raw: amount.toString(), note: why, operator: true }));
  console.log(`[billing] ${owner}: ${amount > 0n ? "+" : ""}${formatTokens(amount)} MERRYMEN of API credit, now ${formatTokens(ledger.state.byOwner.get(owner).credit)}. The gateway applies it within 10 s.`);
}

async function comp(argv) {
  const owner = wallet(argv[1]);
  const tier = argv[2];
  const plan = Object.hasOwn(PLANS, tier ?? "") ? PLANS[tier] : null;
  if (!plan || plan.price_raw === 0n) die(`comp needs a paid tier: ${Object.keys(PLANS).filter((t) => t !== "free").join(", ")}`);
  const days = Number(argv[3]);
  if (!Number.isInteger(days) || days < 1 || days > 365) die("comp needs a number of days from 1 to 365");
  const why = note(argv);
  const ledger = await writer();
  const acct = ledger.state.byOwner.get(owner);
  if (!acct) die(`no account for ${owner}: the developer creates one at merrymen.dev/api first`);
  const now = ledger.now();
  // A comp starts now and runs alongside anything already running. Over a
  // period the developer paid for, it would either be hidden by it (a cheaper
  // comp) or use up the paid days in parallel (a dearer one). Refused; the
  // operator comps after it ends, or credits tokens with `adjust` instead.
  const paid = acct.periods.filter((p) => p.bought && p.ends_at > now).sort((a, b) => b.ends_at - a.ends_at)[0];
  if (paid) {
    die(`${owner}'s paid ${paid.tier} period runs until ${new Date(paid.ends_at).toISOString()}. A comp now would run alongside it `
      + "and hide or use up part of what was paid for: comp after that date, or credit tokens with adjust. Nothing written.");
  }
  const hex = () => randomBytes(12).toString("hex");
  await ledger.enqueue(() => ledger.append({ type: "charge", account_id: acct.account_id, charge_id: `chg_${hex()}`, period_id: `per_${hex()}`,
    reason: "comp", tier: plan.id, price_raw: "0", tier_price_raw: plan.price_raw.toString(), requests: plan.requests,
    tier_requests: plan.requests, rpm: plan.rpm,
    starts_at: now, ends_at: now + days * DAY, note: why }));
  const longer = days * DAY > PERIOD_MS ? ` (its quota of ${plan.requests} requests covers all ${days} days)` : "";
  console.log(`[billing] ${owner}: ${plan.name} at no charge until ${new Date(now + days * DAY).toISOString()}${longer}. The gateway applies it within 10 s.`);
}

async function reconcile(argv) {
  if (!config.rpc) die("set MERRYMEN_PAYMENTS_RPC or MERRYMEN_GATEWAY_RPC to read the chain");
  const billing = await view({ publicClient: createPaymentsClient(config.rpc) });
  const all = argv.includes("--all");
  const findings = await billing.reconcile({ dryRun: true, all });
  if (!findings.length) return console.log(`[billing] every ${all ? "" : "recent "}payment still stands on chain.`);
  for (const f of findings) console.log(`  WOULD REVERSE  ${f.tx_hash}  ${f.owner}  ${formatTokens(f.amount_raw)} MERRYMEN  (${f.why})`);
  console.log("[billing] dry run: nothing written. The gateway reverses these itself within five minutes of a payment.");
}

const argv = process.argv.slice(2);
const commands = { list, show, adjust, comp, reconcile };
if (!Object.hasOwn(commands, argv[0] ?? "")) {
  console.log("usage: billing-cli.mjs list | show <wallet> | adjust <wallet> <±tokens> --note \"…\" | comp <wallet> <tier> <days> --note \"…\" | reconcile [--all]");
  process.exit(argv[0] ? 1 : 0);
}
await commands[argv[0]](argv);
