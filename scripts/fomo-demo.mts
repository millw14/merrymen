/**
 * A FIXTURE DEMONSTRATION OF THE ON-DEMAND FOMO PATH — not live data.
 *
 * Runs the real planner, subject memory, broker, research service, store and
 * renderer end to end against an in-memory database and a provider stub that
 * serves the fixtures under worker/src/fomo/testdata (constructed from the
 * provider's documentation, NOT captured responses). Nothing leaves this
 * process: there is no key, no network and no model.
 *
 *   npx tsx scripts/fomo-demo.mts
 *
 * What it shows, question by question: which REGISTERED tool was invoked, the
 * envelope status, and the exact answer an owner would read — including the
 * follow-ups that keep the coin and chain, a correction, a refresh, a
 * factual-only request, and a revoked permission.
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../worker/src/db";
import { FomoBudget, MemoryAllowance } from "../worker/src/fomo/budget";
import { createDirectBroker } from "../worker/src/fomo/broker";
import { answerFomoQuestion } from "../worker/src/fomo/chat";
import { createFomoClient } from "../worker/src/fomo/provider";
import { createFomoService } from "../worker/src/fomo/service";
import * as store from "../worker/src/fomo/store";

const NOW = Date.UTC(2026, 9, 4, 16, 5);
const ALERTS_NEWEST = 1788378000000;
const clock = { now: NOW };
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../worker/src/fomo/testdata/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250" } });

function alertsNow(): Record<string, unknown> {
  const body = fixture("alerts");
  const shift = clock.now - 60_000 - ALERTS_NEWEST;
  for (const a of body.alerts as Record<string, number>[]) {
    if (typeof a.ts === "number") a.ts += shift;
    if (typeof a.execTs === "number") a.execTs += shift;
  }
  return body;
}

const calls: string[] = [];
let failTheses = false;
const fetchImpl = (async (input: RequestInfo | URL) => {
  const u = new URL(String(input));
  const p = u.pathname;
  calls.push(p);
  if (p === "/v2/tokens/search") return json(fixture("tokens-search"));
  if (p === "/v2/search") return json(fixture("search"));
  if (p === "/v2/alerts") return json(alertsNow());
  if (p.startsWith("/v2/thesis/token/")) return failTheses ? json({ error: "busy", retryable: false }, 503) : json(fixture("theses-token"));
  if (/\/stats$/.test(p)) return json(fixture("token-stats"));
  if (/\/balances$/.test(p)) return json(fixture("balances"));
  if (/\/positions$/.test(p)) return json(fixture("positions"));
  if (/\/swaps$/.test(p)) return json(fixture("swaps"));
  if (p.startsWith("/v2/leaderboard/tokens/")) return json(fixture("token-board-trending"));
  if (p.startsWith("/v2/leaderboard/")) {
    // One documented board, relabelled to the window asked for: the adapter
    // refuses a body naming a different window than the request (by design).
    const board = fixture("leaderboard-24h");
    board.window = p.split("/").pop();
    return json(board);
  }
  return json({ error: "not_found" }, 404);
}) as typeof fetch;

const db = wrapSqlite(new DatabaseSync(":memory:"));
await store.ensureFomoSchema(db, "sqlite");
const access = { dataAccess: true, monitoring: false, follow: false };
const client = createFomoClient({ apiKey: "fixture-demo-not-a-key", fetchImpl, now: () => clock.now, sleep: async () => {}, random: () => 0 });
const budget = new FomoBudget({
  port: new MemoryAllowance(),
  config: { sharedDailyCredits: 1_000_000, tenantHourlyCredits: 100_000, tenantDailyCredits: 100_000, groupHourlyCredits: 100_000 },
  now: () => clock.now,
});
const service = createFomoService({ db, dialect: "sqlite", client, access: async () => access, budget, now: () => clock.now });
const broker = createDirectBroker(service, "self", { now: () => clock.now });

async function ask(text: string): Promise<void> {
  clock.now += 45_000;
  calls.length = 0;
  const r = await answerFomoQuestion({ text, broker, now: clock.now, surface: "app-chat", audience: "owner", conversationKey: "demo", maxChars: 900 });
  console.log(`\n> ${text}`);
  if (!r.handled) {
    console.log("  (not a Fomo question: left to the existing chat handlers)");
    return;
  }
  const statuses = r.envelopes.map((e) => `${e.tool}=${e.status}${e.freshness.servedFrom !== "none" ? `/${e.freshness.servedFrom}` : ""}`);
  console.log(`  tools: ${r.toolsCalled.join(", ") || "(none — clarification)"} | ${statuses.join(" ")} | upstream calls: ${calls.length}`);
  console.log(r.text.split("\n").map((l) => "  " + l).join("\n"));
}

console.log("FIXTURE DEMONSTRATION — answers come from documentation-built fixtures, not live Fomo data.");
await ask("What are people on Fomo saying about $PONS?");
await ask("What about the sellers?");
await ask("Does that contradict what those traders said?");
await ask("refresh it");
await ask("What is @CryptoKaleo holding?");
await ask("What did trader CryptoKaleo buy recently?");
await ask("Show me the leading traders on fomo this week");
await ask("What are the teses on $PONS? Just give me the information, not a trading opinion.");
failTheses = true;
await ask("What are the latest theses on $PONS right now?");
failTheses = false;
await ask("what did you buy today?");
access.dataAccess = false;
await ask("What are the theses on $PONS on fomo?");
