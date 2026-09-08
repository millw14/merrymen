/**
 * READ-ONLY census of owner-binding versions across every stored grant.
 *
 * One question: is the second-browser re-sign path reachable for the people
 * reporting that it is not? Wallet.tsx adopts a server-held grant only when its
 * binding is `privy-did-owner-v1`, because that is the only kind whose owner
 * travels with the login. Anything else still needs a key that lives in one
 * browser, and this says how many of those there are.
 *
 * Reads. Never writes — see the standing rule about audits repairing production.
 */
import { getGrantStore } from "../worker/src/grant-store.js";

const store = getGrantStore();
const tenants = await store.listTenants();
const counts = new Map<string, number>();
let noBinding = 0;
for (const t of tenants) {
  const g = await store.get(t).catch(() => null);
  if (!g) continue;
  const v = (g as { binding?: { version?: string } }).binding?.version;
  if (!v) { noBinding += 1; continue; }
  counts.set(v, (counts.get(v) ?? 0) + 1);
}
console.log("tenants:", tenants.length);
for (const [v, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${v}: ${n}`);
console.log("  (no binding at all):", noBinding);
