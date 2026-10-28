/**
 * A READ-ONLY CAPABILITY PROBE OF THE FOMO DATA API — the evidence behind
 * AUTHENTICATED_TESTED in docs/fomo.md.
 *
 * The adapter is green in every fixture test, and fixtures were built from the
 * provider's documentation, not from captured responses. This runs the real
 * adapter against the real API with the operator's key and prints what each
 * route actually did, so a capability is never reported as verified on the
 * strength of a mock.
 *
 *   MERRYMEN_FOMO_API_KEY=… npx tsx scripts/fomo-probe.mts [--theses] [--trader] [--stream] [--budget=<credits>]
 *
 * WHAT IT SPENDS. By default: /v2/me (0), one 24h leaderboard row (250), the
 * trending board (250), one alerts page (125), stats for one Robinhood token
 * (250) — 875 credits. `--theses` adds one thesis page (1,250), `--trader` one
 * holdings read (250), `--stream` opens /ws/alerts for 15 s (0). `--budget`
 * refuses to start a call that would exceed it (default 5,000).
 *
 * WHAT A CALL COUNTS AGAINST THE BUDGET. The provider's own `x-credits-cost`
 * when it sends one: a 503 that billed 0 costs the probe 0, whatever the
 * route's list price. When it sends none (a timeout, a dropped connection),
 * nobody knows whether the call was billed, so the route's documented price
 * is counted: the budget errs toward stopping early, never toward overspending.
 *
 * WHAT IT NEVER DOES. No trading or payment route (the adapter refuses them),
 * no write of any kind, no key printed: stream URLs are shown redacted only.
 * It records nothing in any database unless MERRYMEN_FOMO_PROBE_DB=1 is set
 * with DATABASE_URL, in which case the observed capability records are merged
 * into fomo_capabilities.
 */
import { createFomoClient, alertsStreamUrl, PROVIDER_GUARDS, ROUTE_COST, type RouteName } from "../worker/src/fomo/provider";
import {
  DOCUMENTED_CAPABILITIES,
  CAPABILITY_FOR_ROUTE,
  capabilityFromAccount,
  capabilityFromCall,
  capabilityFromStream,
  capabilityReport,
  mergeCapabilities,
} from "../worker/src/fomo/capabilities";
import { isRobinhoodToken } from "../worker/src/fomo/identity";
import type { CapabilityRecord } from "../worker/src/fomo/types";

const key = (process.env.MERRYMEN_FOMO_API_KEY ?? process.env.FOMO_API_KEY ?? "").trim();
if (!key) {
  console.error("Set MERRYMEN_FOMO_API_KEY (or FOMO_API_KEY). Nothing was called.");
  process.exit(2);
}
// The adapter refuses a key of any other shape before sending anything, so a
// placeholder (an ellipsis, "<key>", a key with a stray space) would otherwise
// "probe" every route and report no-key for each without ever reaching the
// provider. Say so once, up front.
if (!PROVIDER_GUARDS.KEY_SHAPE.test(key)) {
  console.error("That value is not a usable key (8–512 printable ASCII characters, no spaces) — a placeholder? Nothing was sent.");
  process.exit(2);
}
const args = new Set(process.argv.slice(2));
const budgetArg = [...args].find((a) => a.startsWith("--budget="));
const budget = budgetArg ? Number(budgetArg.slice("--budget=".length)) : 5_000;
if (!Number.isFinite(budget) || budget < 0) {
  console.error("--budget must be a non-negative number of credits");
  process.exit(2);
}

const client = createFomoClient({ apiKey: key });
const observed: CapabilityRecord[] = [];
/** What the budget is charged: the provider's reported cost, or the documented price when it reported none. */
let charged = 0;
let spentReported = 0;
let unknownCost = 0;
let sent = 0;

/** Refuse a call that the remaining budget cannot cover at its documented price. */
function affordable(route: RouteName): boolean {
  const cost = ROUTE_COST[route].credits;
  if (charged + cost > budget) {
    console.log(`skip ${route}: would exceed the probe budget (${charged} + ${cost} > ${budget})`);
    return false;
  }
  return true;
}

async function probe<T>(route: RouteName, call: () => Promise<Awaited<ReturnType<typeof client.me>> | any>, extra?: Record<string, unknown>): Promise<T | null> {
  if (!affordable(route)) return null;
  const r = await call();
  // Only a call that reached the provider can have cost anything: attempts 0
  // means the adapter refused it locally (bad argument, refused path, no key).
  if ((r.meta?.attempts ?? 0) > 0) {
    sent++;
    const reported = r.meta?.creditsCost;
    if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
      charged += reported;
      spentReported += reported;
    } else {
      // No header (a timeout, no connection): it may have been billed, so count the list price.
      charged += ROUTE_COST[route].credits;
      unknownCost++;
    }
  }
  const capability = CAPABILITY_FOR_ROUTE[route];
  observed.push(capabilityFromCall(capability, ROUTE_COST[route].template, r, extra as never));
  const transient = !r.ok && r.retryable ? " (provider marked it transient)" : "";
  console.log(`${route}: ${r.ok ? "ok" : `failed (${r.failure})${transient}`} status=${r.meta?.status ?? "-"} attempts=${r.meta?.attempts ?? 0} credits=${r.meta?.creditsCost ?? "?"} remaining=${r.meta?.creditsRemaining ?? "?"}`);
  return r.ok ? (r.data as T) : null;
}

const iso = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "not stated");
const me = await probe<any>("me", () => client.me());
if (me) {
  observed.push(...capabilityFromAccount(me, Date.now()));
  const flag = (v: boolean | null) => (v === true ? "included" : v === false ? "not included" : "not stated");
  console.log(
    `account: plan=${me.plan ?? "?"} dailyLimit=${me.dailyLimit ?? "not stated"} planExpiresAt=${iso(me.planExpiresAt)} ` +
      `credits remaining=${me.credits?.remaining ?? "?"} of ${me.credits?.monthly ?? "?"} monthly; ` +
      `/ws/alerts ${flag(me.streams?.appFeed)}, /ws/trades ${flag(me.streams?.onChain)}`,
  );
}

const board = await probe<any>("leaderboard", () => client.leaderboard("24h", 1));
await probe<any>("tokenBoardTrending", () => client.tokenBoard("trending", 5));
const alerts = await probe<any>("alerts", () => client.alerts({ chain: "robinhood", limit: 5 }, "rest-lookup"));

const rhToken = (alerts?.rows ?? []).map((e: any) => e.token).find((t: any) => isRobinhoodToken(t));
if (!alerts) {
  console.log("alerts page unavailable; token routes not probed");
} else if (rhToken) {
  await probe<any>("tokenStats", () => client.tokenStats(rhToken.address, { networkId: 4663 }));
  if (args.has("--theses")) await probe<any>("thesesByToken", () => client.thesesByToken(rhToken.address, { network: "robinhood", pages: 1 }));
} else {
  console.log("no Robinhood token in the sampled alerts page; token routes not probed");
}

const firstTrader = board?.rows?.[0]?.trader?.userId;
if (args.has("--trader") && firstTrader) await probe<any>("balances", () => client.balances(firstTrader));

if (args.has("--stream")) {
  const endpoint = alertsStreamUrl(key, { chain: "robinhood" });
  if (!endpoint.ok) {
    console.log(`stream: not opened (${endpoint.failure})`);
  } else {
    console.log(`stream: opening ${endpoint.redacted} for 15 s`);
    const result = await new Promise<{ welcome: boolean; delaySeconds?: number; closeCode?: number; closeReason?: string }>((resolve) => {
      const ws = new WebSocket(endpoint.url);
      const done = (r: { welcome: boolean; delaySeconds?: number; closeCode?: number; closeReason?: string }) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        resolve(r);
      };
      const timer = setTimeout(() => done({ welcome: false }), 15_000);
      ws.onmessage = (ev) => {
        try {
          const f = JSON.parse(String(ev.data));
          if (f?.type === "welcome") done({ welcome: true, delaySeconds: typeof f.delaySeconds === "number" ? f.delaySeconds : undefined });
        } catch { /* not JSON: keep waiting for a welcome */ }
      };
      // The reason text only decides whether a 1008 names the key or the plan (capabilities.ts); it is never printed.
      ws.onclose = (ev) => done({ welcome: false, closeCode: ev.code, closeReason: typeof ev.reason === "string" ? ev.reason : undefined });
      ws.onerror = () => { /* the close event carries the code */ };
    });
    observed.push(capabilityFromStream("ws-alerts", "/ws/alerts", result, Date.now()));
    console.log(`stream: ${result.welcome ? "welcome received" : `no welcome${result.closeCode != null ? ` (close ${result.closeCode})` : ""}`}`);
  }
}

const merged = mergeCapabilities(DOCUMENTED_CAPABILITIES, observed);
console.log("\n" + capabilityReport(merged));
console.log(
  `\ncalls sent: ${sent}; credits charged to the probe budget ${charged} of ${budget}: reported by the provider ${spentReported}` +
    (unknownCost ? `, plus list price for ${unknownCost} call(s) that reported no cost` : ""),
);

if (process.env.MERRYMEN_FOMO_PROBE_DB === "1" && process.env.DATABASE_URL) {
  const { makePgDb } = await import("../worker/src/db");
  const { ensureFomoSchema, upsertCapability } = await import("../worker/src/fomo/store");
  const db = await makePgDb(process.env.DATABASE_URL);
  await ensureFomoSchema(db, "postgres");
  for (const rec of observed) await upsertCapability(db, rec);
  console.log(`recorded ${observed.length} observed capability records`);
  process.exit(0);
}
