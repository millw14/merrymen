/**
 * EVERY FLEET CAPITAL SCAN NAMES WHAT THE CLASSIFIER CANNOT GUESS.
 *
 * scanFleetCapital's optional inputs are "absent is byte-identical to
 * before" — which is exactly how an argument goes unpassed for months:
 * custodyAddressesFor was documented as required for class vaults and never
 * passed (every class buy read as a withdrawal), and `venueProxies` shipped
 * wired into the per-agent booker (deposit-log.ts) and neither orchestrator
 * sweep (review: mirror-fleet-scan-venue-proxies-unwired). Un-named, a margin
 * deposit to Lighter classifies `no-pair-external` = capital-out and a payout
 * capital-in, and the HWM repair and the reconstruction would move a perps
 * tenant's peak and fee basis by every margin leg.
 *
 * A source pin, because both callers are operator tools that run against the
 * live chain and have no unit seam: every non-test call of scanFleetCapital in
 * worker/src must pass `reserveTokens` from energyReserveTokens and
 * `venueProxies` from lighterVenueProxies — derived, never a typed list.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The argument text of every `scanFleetCapital(` call in `src`, by paren matching. */
function callsIn(src: string): string[] {
  const out: string[] = [];
  const re = /\bscanFleetCapital\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Skip the declaration and imports: only calls are awaited.
    if (!/await\s+$/.test(src.slice(Math.max(0, m.index - 16), m.index))) continue;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        out.push(src.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

it("every scanFleetCapital caller passes venueProxies and reserveTokens, derived from the chain id", () => {
  const files = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("node_modules"),
  );
  const calls: { file: string; text: string }[] = [];
  for (const f of files) for (const text of callsIn(readFileSync(path.join(here, f), "utf8"))) calls.push({ file: f, text });

  // The two operator sweeps, at least — a pin that finds nothing pins nothing.
  assert.ok(calls.filter((c) => c.file === "orchestrator.ts").length >= 2, `found ${calls.length} call(s): ${calls.map((c) => c.file).join(", ")}`);
  for (const c of calls) {
    assert.match(c.text, /venueProxies:\s*lighterVenueProxies\(/, `${c.file}: a scan that omits the Lighter proxy books margin as capital`);
    assert.match(c.text, /reserveTokens:\s*energyReserveTokens\(/, `${c.file}: a scan that omits the energy reserve books energy as a trade`);
  }
});
