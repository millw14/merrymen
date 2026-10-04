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
 * refuses to start a call that would exceed it (default 2,000).
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
const budget = budgetArg ? Number(budgetArg.slice("--budget=".length)) : 2_000;
if (!Number.isFinite(budget) || budget < 0) {
  console.error("--budget must be a non-negative number of credits");
  process.exit(2);
}

const client = createFomoClient({ apiKey: key });
const observed: CapabilityRecord[] = [];
let spentEstimate = 0;
let spentReported = 0;
let sent = 0;

/** Refuse a call that the remaining budget cannot cover at its documented price. */
function affordable(route: RouteName): boolean {
  const cost = ROUTE_COST[route].credits;
  if (spentEstimate + cost > budget) {
    console.log(`skip ${route}: would exceed the probe budget (${spentEstimate} + ${cost} > ${budget})`);
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
    spentEstimate += ROUTE_COST[route].credits;
  }
  if (r.meta?.creditsCost != null) spentReported += r.meta.creditsCost;
  const capability = CAPABILITY_FOR_ROUTE[route];
  observed.push(capabilityFromCall(capability, ROUTE_COST[route].template, r, extra as never));
  console.log(`${route}: ${r.ok ? "ok" : `failed (${r.failure})`} status=${r.meta?.status ?? "-"} credits=${r.meta?.creditsCost ?? "?"} remaining=${r.meta?.creditsRemaining ?? "?"}`);
  return r.ok ? (r.data as T) : null;
}

const me = await probe<any>("me", () => client.me());
if (me) observed.push(...capabilityFromAccount(me, Date.now()));

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
    const result = await new Promise<{ welcome: boolean; delaySeconds?: number; closeCode?: number }>((resolve) => {
      const ws = new WebSocket(endpoint.url);
      const done = (r: { welcome: boolean; delaySeconds?: number; closeCode?: number }) => {
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
      ws.onclose = (ev) => done({ welcome: false, closeCode: ev.code });
      ws.onerror = () => { /* the close event carries the code */ };
    });
    observed.push(capabilityFromStream("ws-alerts", "/ws/alerts", result, Date.now()));
    console.log(`stream: ${result.welcome ? "welcome received" : `no welcome${result.closeCode != null ? ` (close ${result.closeCode})` : ""}`}`);
  }
}

const merged = mergeCapabilities(DOCUMENTED_CAPABILITIES, observed);
console.log("\n" + capabilityReport(merged));
console.log(`\ncalls sent: ${sent}; credits: estimated ${spentEstimate}, reported by the provider ${spentReported}`);

if (process.env.MERRYMEN_FOMO_PROBE_DB === "1" && process.env.DATABASE_URL) {
  const { makePgDb } = await import("../worker/src/db");
  const { ensureFomoSchema, upsertCapability } = await import("../worker/src/fomo/store");
  const db = await makePgDb(process.env.DATABASE_URL);
  await ensureFomoSchema(db, "postgres");
  for (const rec of observed) await upsertCapability(db, rec);
  console.log(`recorded ${observed.length} observed capability records`);
  process.exit(0);
}
