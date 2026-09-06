/**
 * THE ONE UN-METERED HOUSE-KEY MODEL CALL IN THE PRODUCT.
 *
 * `worker/src/scout-budget.test.ts` records the incident this is the twin of:
 * a shared Groq key, a 200,000-token daily allowance, 195,881 spent in a day by
 * a ranking pass running per tenant every ten minutes — "and the first person
 * to notice was a user whose chat stopped working". The worker's scout has been
 * gated on `scoutEnabled` ever since, and that gate is pinned.
 *
 * The web service ran the same scout, on the same house key, with NO gate at
 * all — bounded only by a 120-second in-process memo, which is roughly thirty
 * model calls an hour per replica whether or not anybody was reading the page.
 *
 * The fix is deliberately NOT the worker's. There the gate says "do not pay to
 * rank what you cannot buy", which costs nothing because a scouted coin could
 * not be bought anyway. Here the ranking IS the product — it is the verdict
 * every viewer reads — so gating it on a per-tenant TRADING permission would
 * empty the panel for everyone. A house switch and a house ceiling instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("./read-discoveries.ts", import.meta.url), "utf8");
/** Comments stripped: this file argues about spending at length in prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

describe("the display scout is bounded", () => {
  it("IT IS OFF UNLESS THE HOUSE TURNS IT ON", () => {
    // Asserted on the constant rather than on behaviour so that if the default
    // ever flips permissive, somebody has to change this line and think about
    // it — which is the whole mechanism the worker's version relies on too.
    assert.match(CODE, /MERRYMEN_DISPLAY_SCOUT_ENABLED/);
    assert.match(
      CODE,
      /const DISPLAY_SCOUT_ENABLED = \[[^\]]*\]\.includes\(/,
      "an allow-list of truthy strings, not a negation",
    );
    // The unset case must be falsy: `?? ""` and nothing else.
    assert.match(CODE, /process\.env\.MERRYMEN_DISPLAY_SCOUT_ENABLED \?\? ""/);
  });

  it("there is a daily ceiling, and it resets on a boundary a person can predict", () => {
    assert.match(CODE, /DISPLAY_SCOUT_DAILY_MAX/);
    assert.match(CODE, /spentToday\.calls >= DISPLAY_SCOUT_DAILY_MAX/);
    assert.match(CODE, /toISOString\(\)\.slice\(0, 10\)/, "a UTC day, not a rolling window");
  });

  it("THE MODEL IS UNREACHABLE WITHOUT PASSING BOTH", () => {
    // The property that matters: no path from the render to the provider that
    // skips the switch and the counter. `rankUncached` is the only caller of
    // the scout, and only `rankForDisplay` calls it.
    const uncached = CODE.slice(CODE.indexOf("async function rankUncached("));
    assert.match(uncached, /createMemecoinScout\(creds\)\.rank\(/, "the scout call lives in rankUncached");
    const gate = CODE.indexOf("if (!DISPLAY_SCOUT_ENABLED)");
    const spend = CODE.indexOf("spentToday.calls += 1");
    const call = CODE.indexOf("await rankUncached(kept, nowSec)");
    assert.ok(gate > 0 && spend > gate && call > spend, "switch, then counter, then the call");
    assert.equal(
      (CODE.match(/rankUncached\(/g) ?? []).length,
      2,
      "rankUncached must have exactly one caller besides its own declaration",
    );
  });

  it("a bounded-out render still returns rows — the page must not go blank", () => {
    // `why: "no-model"` is a path the page already renders honestly, as
    // "nothing has been vetted" rather than "nothing looked good". This just
    // adds another producer of it.
    const fn = CODE.slice(CODE.indexOf("async function rankForDisplay("), CODE.indexOf("async function rankUncached("));
    const refusals = fn.match(/return \{ picks: \[\], why: "no-model" \}/g) ?? [];
    assert.ok(refusals.length >= 2, "both the switch and the ceiling must answer, not throw");
  });
});

describe("a verdict outlives a payload", () => {
  it("the verdict memo is strictly longer-lived than the payload memo", () => {
    // The payload is 120s because the tape moves. A judgement about which coins
    // are worth looking at does not move on that clock, and re-deriving it every
    // two minutes was the entire spend.
    const ttl = Number(CODE.match(/VERDICT_TTL_MS = (\d+) \* 60_000/)?.[1] ?? 0) * 60_000;
    const whole = Number(CODE.match(/WHOLE_MS = (\d+)/)?.[1] ?? 0);
    assert.ok(ttl > 0 && whole > 0, "both memos must still exist");
    assert.ok(ttl > whole, `a verdict (${ttl}ms) must outlive a payload (${whole}ms)`);
  });

  it("A CACHED VERDICT IS ONLY REUSED FOR COINS IT ACTUALLY SAW", () => {
    // On this page `verdict: null` means "the scout looked and passed" — a
    // considered opinion. Serving a stale verdict set alongside a coin listed
    // since would attach that opinion to a coin nobody looked at, which is the
    // exact class of claim honesty.test.ts exists to stop.
    assert.match(
      CODE,
      /want\.every\(\(t\) => verdictMemo!\.ranked\.has\(t\)\)/,
      "reuse requires the screened set to be a subset of what was ranked",
    );
  });

  it("a failure is cached too, so a dead provider is not retried into a bill", () => {
    const fn = CODE.slice(CODE.indexOf("const result = await rankUncached"));
    assert.match(fn.slice(0, 400), /verdictMemo = \{ at: Date\.now\(\)/);
    // …and it is not conditional on the result being good.
    assert.ok(
      !/if \([^)]*result[^)]*\)\s*verdictMemo =/.test(fn.slice(0, 400)),
      "caching the verdict must not depend on the verdict succeeding",
    );
  });
});
