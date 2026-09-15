/**
 * A RULE THE WALL CAN RETURN AND THE PRODUCT CANNOT SAY IS A SLUG ON SOMEBODY'S
 * SCREEN.
 *
 * An owner asked, in the beta: "🧱 refused: no-exit. Nothing was sent and
 * nothing was spent. What does this mean if my agent tries to buy some custom
 * token i added?"
 *
 * It means his signed permission could not sell that token, so the buy was
 * refused before anything was fetched — a fact about the SIGNATURE, never about
 * liquidity or routing. That sentence already existed, in `policy.ts`'s own
 * `detail`, and every surface dropped it: `no-exit` was absent from
 * `thesis-policy.ts`'s map, so `rejectRuleLabel` returned null, `outcomeOf` fell
 * to "the wall turned it back", the wall-band had no lane for it, and the chat
 * printed the raw slug.
 *
 * WHY THE EXISTING DRIFT TEST COULD NOT CATCH IT. `refuse-vocabulary.test.ts`
 * covers `RefuseRule` — the closed union `execModeOf` produces, describing why
 * an agent is not trading AT ALL. `no-exit` is a different thing: a
 * `Verdict.rule` from the wall, typed as bare `string`, describing why ONE
 * intent was turned down. Nothing guarded that set, and `thesis-policy.ts`'s own
 * comment records five slugs already lost the same way once before.
 *
 * THE SHAPE IS TWO SETS, AND THAT IS THE POINT. A rule must be either published
 * or explicitly withheld WITH A REASON. A newly added rule lands in neither and
 * fails here immediately, which forces the author to decide — which is exactly
 * what did not happen for `no-exit`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { REJECT_RULES, rejectRuleLabel, rejectRuleRemedy } from "./thesis-policy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

/**
 * Every rule literal the wall can put on a verdict, read from SOURCE.
 *
 * From the text rather than from a type, for the reason `refuse-vocabulary.test.ts`
 * already gives about its own union: a type erases at runtime and would assert
 * nothing. The pattern tolerates a conditional — `rule: isDeposit ?
 * "deposit-cap" : "per-trade-cap"` — by taking every quoted slug on the line.
 */
function wallRules(): string[] {
  const src = read("policy.ts");
  const found = new Set<string>();
  for (const m of src.matchAll(/rule:\s*[^,}\n]*/g)) {
    for (const q of m[0].matchAll(/"([a-z][a-z-]+)"/g)) found.add(q[1]!);
  }
  assert.ok(found.size >= 10, `expected the wall's rules, parsed ${found.size}`);
  return [...found].sort();
}

/**
 * Rules deliberately NOT given a public sentence, each with the reason.
 *
 * Seeded truthfully from what is absent today rather than aspirationally: this
 * is a snapshot of a decision, and several of these deserve real sentences in
 * their own change. What matters is that each one was LOOKED AT.
 */
const UNPUBLISHED: Readonly<Record<string, string>> = Object.freeze({
  "non-positive": "an impossible intent — a zero or negative size. Never owner-caused.",
  expiry: "the key's window has passed; autonomy.ts already owns this sentence for every surface.",
  "order-amount": "the brokerage rail, which has its own vocabulary and no public tape yet.",
  "ticker-allowlist": "same rail, same reason.",
  "scout-budget": "deserves a real sentence; it is an owner-set ceiling, not a fault. Own change.",
  "transfer-amount": "withdrawal shape, not a trade — never reaches the trade tape.",
  "transfer-recipient": "withdrawal, as above.",
  "transfer-not-permitted": "withdrawal, as above. Deserves a sentence on the withdraw screen instead.",
  // NOTE: `transfer-recipient-allowlist` is NOT here — it IS published, and
  // listing it as withheld was caught by the both-sets check below on the first
  // run. That check earns its place: a stale exemption is as silent as a
  // missing sentence.
});

describe("every rule the wall can return has been looked at", () => {
  it("IS EITHER PUBLISHED OR EXPLICITLY WITHHELD, WITH A REASON", () => {
    // The assertion that would have caught `no-exit` the day it was written.
    for (const rule of wallRules()) {
      const published = REJECT_RULES.includes(rule);
      const withheld = Object.prototype.hasOwnProperty.call(UNPUBLISHED, rule);
      assert.notEqual(
        published,
        withheld,
        published
          ? `${rule} is both published and listed as withheld — pick one`
          : `${rule} has no public sentence and no stated reason for not having one. ` +
            `Add it to thesis-policy.ts's map, or to UNPUBLISHED here with why.`,
      );
    }
  });

  it("and nothing is withheld that the wall cannot actually produce", () => {
    // A stale exemption is how a rule quietly stops being covered.
    const rules = wallRules();
    for (const rule of Object.keys(UNPUBLISHED)) {
      assert.ok(rules.includes(rule), `${rule} is withheld but policy.ts no longer returns it`);
    }
  });

  it("the wall battery's expected rules are all published", () => {
    // `wall-battery.ts` already exercised `no-exit` — the battery knew about a
    // rule the vocabulary did not, which is the drift in one sentence.
    const battery = read("wall-battery.ts");
    for (const m of battery.matchAll(/expectedRule:\s*"([a-z][a-z-]+)"/g)) {
      const rule = m[1]!;
      if (Object.prototype.hasOwnProperty.call(UNPUBLISHED, rule)) continue;
      assert.ok(REJECT_RULES.includes(rule), `the battery expects ${rule}; the vocabulary has no words for it`);
    }
  });
});

describe("no-exit says what it is and what to do", () => {
  it("HAS A PUBLIC SENTENCE — this is the one an owner was handed as a slug", () => {
    const say = rejectRuleLabel("no-exit");
    assert.ok(say, "no-exit must have words");
    assert.ok(!say.includes("no-exit"), "never the slug echoed back");
    // It is a signature fact. Saying anything about liquidity or routing would
    // be wrong: the rule is checked before a quote is ever fetched.
    assert.match(say, /sell/i, "it names what the key cannot do");
    assert.doesNotMatch(say, /liquidity|pool|route/i, "it is not a tradability claim");
  });

  it("and the PUBLIC sentence carries no URL, because a stranger cannot act on it", () => {
    // The whole reason there are two registers. This map is read by the public
    // tape, where the reader is not the owner.
    for (const rule of REJECT_RULES) {
      assert.doesNotMatch(rejectRuleLabel(rule) ?? "", /\/grant|\/settings/, rule);
    }
  });

  it("while the OWNER's register names the remedy that actually works", () => {
    const fix = rejectRuleRemedy("no-exit");
    assert.ok(fix);
    assert.match(fix, /re-sign/i);
    assert.match(fix, /\/grant/, "and where");
  });

  it("a rule with no owner action gets no invented remedy", () => {
    // `autonomy.ts`'s ownerRemedy draws the same line: "the owner can fix it"
    // and "the owner fixes it the same way" are different claims.
    assert.equal(rejectRuleRemedy("non-positive"), null);
    assert.equal(rejectRuleRemedy(null), null);
    assert.equal(rejectRuleRemedy("a-rule-from-next-year"), null);
  });
});

describe("the owner's refusal message is words, not a slug", () => {
  it("SAYS WHAT HAPPENED AND WHAT TO DO, and keeps the slug for support", () => {
    const src = read("index.ts");
    // The LAST occurrence: the default arm of `sayTradeOutcome`, which is the
    // one an owner meets. Earlier matches are other reply shapes.
    const at = src.lastIndexOf("🧱 refused");
    assert.ok(at > 0, "the refusal reply must still exist");
    const arm = src.slice(Math.max(0, at - 1600), at + 400);
    assert.match(arm, /rejectRuleLabel\(outcome\.rejectRule\)/, "the sentence comes from the vocabulary");
    assert.match(arm, /rejectRuleRemedy\(outcome\.rejectRule\)/, "and the remedy with it");
    // The slug survives as a parenthetical: support triages on it, and an
    // unknown rule must stay traceable rather than becoming silence.
    assert.match(arm, /\(\$\{slug\}\)/, "the slug is kept, just not as the whole sentence");
  });
});
