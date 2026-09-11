import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tradeDigestLine, tradeLine } from "./notifier";

test("tradeDigestLine summarises only the non-empty status buckets", () => {
  const line = tradeDigestLine(
    [
      { status: "paper", c: 12, s: 75 },
      { status: "rejected", c: 3, s: 22.5 },
    ],
    15,
  );
  assert.match(line, /last 15m/);
  assert.match(line, /12× paper \(75\.00 USDG\)/);
  assert.match(line, /3× turned back/);
  assert.doesNotMatch(line, /landed/); // no landed bucket → not shown
});

test("tradeDigestLine labels periods nicely (m / h / d)", () => {
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 5), /last 5m/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 60), /last 1h/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 1440), /last 1d/);
});

test("tradeDigestLine with nothing new reads as quiet", () => {
  assert.match(tradeDigestLine([], 30), /quiet/);
});

/**
 * WHO GETS BLAMED when a trade does not go out.
 *
 * The wall is the owner's OWN sealed policy. Saying it turned a trade back when
 * the real cause was the house's gas sponsor declining sends them looking
 * through their settings for a fault that is not theirs — and there is nothing
 * they could change that would fix it.
 *
 * SponsorRefused carries a fixed three-word vocabulary, all prefixed `sponsor-`,
 * so the distinction is a prefix test rather than a guess at the text.
 */
test("a sponsor failure is not reported as the wall refusing", () => {
  for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd"]) {
    const line = tradeLine(
      { id: 1, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: rule, tx_hash: null },
      null,
    );
    assert.doesNotMatch(line, /the wall/, `${rule} must not be blamed on the wall`);
    assert.match(line, /gas sponsor declined/);
    assert.match(line, /ours to fix/);
  }
});

test("a real wall refusal still says so", () => {
  // The unsponsored path, and the overwhelmingly common one. It must not move.
  const line = tradeLine(
    { id: 2, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: "per-trade-cap", tx_hash: null },
    null,
  );
  assert.match(line, /the wall turned back a swap \(per-trade-cap\)/);
  assert.doesNotMatch(line, /sponsor/);
});

/**
 * THE ALERT FOR AN AGENT THAT IS WORKING PERFECTLY AND DOING NOTHING.
 *
 * A tester watched a funded, unblocked, live agent propose nothing for days and
 * reported it as broken. It was not: its effective ceiling —
 * `min(llmMaxActionUsdg, the per-trade cap sealed into the grant)` — was $1
 * against $46.75 of cash, so every window it correctly concluded there was
 * nothing worth buying at that size. The strategist wrote the reason out each
 * time ("the max action size ($1) is barely bigger than the position itself")
 * and it went only into prose nobody acts on.
 *
 * Every other condition alert reports something broken. This one reports a
 * setting quietly making a working agent look dead, which is why it needed
 * writing at all.
 */
const NOTIFIER = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");

test("the ceiling alert fires on the RATIO, not on a fixed floor", () => {
  // $1 is fine on a $20 book and absurd on a $50 one. The test is whether a
  // single action could move the book at all.
  assert.match(NOTIFIER, /inputs\.cashUsdg >= 20 \* inputs\.maxActionUsdg/);
});

test("it does not fire on paper, or when it cannot tell", () => {
  // Paper fabricates its numbers, and an unarmed agent has no ceiling — both
  // would be claims about something nobody measured.
  const block = NOTIFIER.slice(NOTIFIER.indexOf("A CEILING SO LOW"));
  const cond = block.slice(0, block.indexOf("await fire("));
  assert.match(cond, /!inputs\.paper/, "paper numbers are fabricated");
  assert.match(cond, /inputs\.maxActionUsdg !== null/);
  assert.match(cond, /inputs\.cashUsdg !== null/);
  assert.match(cond, /inputs\.maxActionUsdg > 0/, "a zero ceiling is a different problem");
});

test("the key carries the ceiling, so raising it and still stalling re-alerts", () => {
  // Keyed on the value rather than a bare name: an owner who raises $1 to $2 and
  // hits the same wall must hear about it, not be swallowed by a 6h cooldown
  // started by the message they already acted on.
  assert.match(NOTIFIER, /`action-ceiling:\$\{inputs\.maxActionUsdg\}`/);
});

test("the message names BOTH places the cap can live, and says nothing is broken", () => {
  // Whichever of the two is lower is the one that binds, and an owner told to
  // fix one of them may change it and see no difference at all.
  const msg = NOTIFIER.slice(NOTIFIER.indexOf("action-ceiling:"));
  const body = msg.slice(0, msg.indexOf("`,\n      );"));
  assert.match(body, /\/grant/, "the signed cap");
  assert.match(body, /LLM max per action/, "and the settings ceiling");
  assert.match(body, /whichever is lower/i, "because only one of them binds");
  assert.match(body, /[Nn]othing is broken/, "an agent behaving correctly must not read as a fault");
  assert.match(body, /free, same wallet/, "re-signing must not sound like moving money");
});

test("the ceiling reported is the one that BINDS, not whichever is handier", () => {
  // The whole defect is that the binding cap can live in either of two places.
  // Dave's is $1 in a SIGNED GRANT — reporting `llmMaxActionUsdg` alone would
  // have told him a number he could not have changed by changing it, and
  // reporting the grant alone would lie to an owner whose settings are lower.
  const INDEX = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const supply = INDEX.slice(INDEX.indexOf("maxActionUsdg: active"));
  const expr = supply.slice(0, supply.indexOf("cashUsdg:"));
  assert.match(expr, /Math\.min\(/, "the lower of the two, or it is not the binding one");
  assert.match(expr, /cfg\.llmMaxActionUsdg/);
  assert.match(expr, /active\.limits\.perTradeUsdg/, "the signed cap is the half nobody could see");
  // Unarmed means no signed cap exists yet, so there is no binding ceiling to
  // report — null, not the settings value standing in for one.
  assert.match(expr, /active\s*\?/, "an unarmed agent has no ceiling to report");
  assert.match(expr, /:\s*null/);
});
