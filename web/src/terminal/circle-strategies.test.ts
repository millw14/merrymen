/**
 * A STRATEGY THE WORKER WILL NOT RUN MUST NOT BE OFFERED UNMARKED.
 *
 * Reported by a tester, about a funded agent: "when the strategy is 'even
 * keel', I've realised that the agent hasn't bought automatically a single
 * stock token during all day.... I don't know if it makes sense and first buys
 * must be done by user or agent should have bought some if there are some
 * stocks in the basket".
 *
 * Nothing was broken. `even-keel` and `dip-hunter` are Merry Circle strategies:
 * the tick gates them on `holderTier.bonusStrategies`, writes ONE warn event,
 * and returns — every tick, for ever, for anyone below Merry Man. The picker
 * offered both with no marking, so the whole flow was available to somebody who
 * could never use it: choose it, read a description of what it does, sign a
 * grant, send real money, and watch an agent that never buys anything.
 *
 * THE TWO LISTS LIVE IN TWO PLACES AND THIS IS WHY THEY MAY. The canonical one
 * is `CIRCLE_STRATEGIES` in the worker's registry; the picker is a client
 * component, and importing the registry there would pull every strategy
 * implementation into the browser bundle for the sake of two strings. So the
 * picker keeps its own flag and this test is the seam: add a strategy to the
 * gate without marking it here and this fails, which is the only way the next
 * one does not repeat the report above.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { EN, type MessageKey } from "@/lib/messages/en";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** The names the WORKER refuses to run for a non-holder. */
function gatedInWorker(): string[] {
  const src = read("../../../worker/src/strategies/registry.ts");
  const m = src.match(/export const CIRCLE_STRATEGIES = \[([^\]]*)\]/);
  assert.ok(m, "CIRCLE_STRATEGIES must still be a literal array in the registry");
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** The names the PICKER marks as holder-only. */
function markedInPicker(): string[] {
  const src = read("./screens/CreateAgent.tsx");
  return [...src.matchAll(/\{id:"([^"]+)"[^}]*circle:true[^}]*\}/g)].map((x) => x[1]!);
}

describe("the picker marks what the worker gates", () => {
  it("EVERY GATED STRATEGY IS MARKED", () => {
    const gated = gatedInWorker();
    assert.ok(gated.length > 0, "the gate must still exist");
    const marked = markedInPicker();
    for (const s of gated) {
      assert.ok(marked.includes(s), `${s} is holder-only in the worker but unmarked in the picker`);
    }
  });

  it("and nothing is marked that the worker would happily run", () => {
    // The other direction matters too: a false badge sends somebody to buy a
    // token they did not need.
    const gated = gatedInWorker();
    for (const s of markedInPicker()) {
      assert.ok(gated.includes(s), `${s} is marked holder-only but the worker does not gate it`);
    }
  });

  it("AND THE MARK SAYS WHAT HAPPENS IF YOU PICK IT ANYWAY", () => {
    // A badge alone is a label. The sentence is what stops somebody funding an
    // agent that will not trade.
    const src = read("./screens/CreateAgent.tsx");
    assert.match(src, /Runs only while you hold \$MERRYMEN/);
    assert.match(src, /opens nothing new until you do/);
  });

  it("and the gate itself is still where the test thinks it is", () => {
    // If the worker stops gating, this whole file is obsolete rather than
    // quietly passing over a check that no longer applies.
    const src = read("../../../worker/src/index.ts");
    assert.match(src, /isCircleStrategy\(strategy\.name\) && !circle\.unlocked/);
    // Unlocked by the exact tier or by the standing energy reads — the same
    // 100,000 line, so the badge's threshold is the worker's (circle-gate.ts).
    assert.match(src, /circleStanding\(\{ tierUnlocks: holderTier\.bonusStrategies, level: holderStanding\.level \}\)/);
  });
});

describe("even-keel says why it is idle", () => {
  it("IT NO LONGER RETURNS EMPTY AND SILENT", () => {
    // steady-basket.ts learned this the hard way — its own comment records 34
    // agents spending a weekend "doing nothing and saying nothing". The `idle`
    // channel on Tick and the `all-legs-stale` / `under-one-buy` vocabulary
    // were built for it; even-keel used neither.
    const src = read("../../../worker/src/strategies/even-keel.ts");
    assert.match(src, /idle: \{ code: "all-legs-stale"/);
    assert.match(src, /code: "under-one-buy"/);
  });

  it("and the stale case is the one that fires overnight", () => {
    // Every Chainlink equity feed is stale outside US market hours, so a stock
    // basket has nothing to weigh itself against for most of the day. That is
    // the branch the tester hit, and it is the one that must speak.
    const src = read("../../../worker/src/strategies/even-keel.ts");
    const stale = src.slice(src.indexOf("if (tradable.length === 0)"), src.indexOf("const valueOf"));
    assert.match(stale, /all-legs-stale/);
    assert.match(stale, /cfg\.legs\.length > 0/, "a basket with no legs is a different fact");
  });
});

describe("the Circle gate is satisfiable, and the warning is visible", () => {
  it("THE ORCHESTRATOR SUPPLIES THE HOLDER ADDRESS, so the tier can be earned at all", () => {
    // `cfg.holderAddress` is what the child reads to resolve its tier, and
    // hosted NO SCREEN EVER WROTE IT — so circle.ts returned OUTSIDER for every
    // tenant and half the picker was inert for the whole beta, however much
    // $MERRYMEN anybody held. Marking the strategies as holders-only (above)
    // would have been a lie without this.
    // The tenant is the FALLBACK now: a wallet proven by its own signature
    // (/api/holder) outranks it, which is how somebody holding $MERRYMEN
    // outside their login wallet earns the tier. What matters here is
    // unchanged — the child is written an address the server established, not
    // one the tenant typed.
    // And one $MERRYMEN wallet powers one agent: which of the two counts is
    // effectiveHolder's call, over the holder claims (B2).
    const orch = readFileSync(new URL("../../../worker/src/orchestrator.ts", import.meta.url), "utf8");
    assert.match(orch, /effectiveHolder\(tenant, settings\?\.holderProof \?\? null, \(w\) => claims\.get\(w\)\)\?\.address \?\? null/);
    assert.match(orch, /JSON\.stringify\(forChild, null, 2\)/, "and the child must be written the amended copy");
  });

  it("AND IT OVERWRITES, because the field was self-declared", () => {
    // /api/settings accepts holderAddress from the tenant with shape validation
    // and nothing else, so anyone could have named a whale's wallet and claimed
    // the tier. /api/alpha refuses to use this field for exactly that reason.
    // The orchestrator's copy is the session-verified wallet, so the spread has
    // to put it LAST.
    const orch = readFileSync(new URL("../../../worker/src/orchestrator.ts", import.meta.url), "utf8");
    // The end marker appears in three functions, so search FORWARD from the
    // start of the block rather than from the top of the file — otherwise the
    // slice runs backwards and comes out empty, which passes nothing and
    // proves nothing.
    const from = orch.indexOf("const forChild: MerrymenSettings = childSettingsFor(settings, holder);");
    assert.ok(from > 0, "the child settings copy must still be built here");
    const block = orch.slice(from, orch.indexOf("const home = childHome(tenant);", from));
    assert.ok(!/settings\.holderAddress/.test(block), "the self-declared field must not be read here");
    // STRONGER THAN OVERRIDING: the helper drops the stored field before
    // anything else, so it cannot survive even when no wallet counts (B2).
    const helper = readFileSync(new URL("../../../worker/src/holder-claims.ts", import.meta.url), "utf8");
    const fn = helper.slice(helper.indexOf("export function childSettingsFor("));
    const drop = fn.indexOf("const { holderAddress: _typedIn, ...rest } = settings ?? {};");
    const write = fn.indexOf("holderAddress: holder }");
    assert.ok(drop > 0 && write > drop, "the established address replaces the stored one, never the other way round");
    // And the stored, typed-in field is never a fallback: only a signature or
    // the session wallet decides whose balance counts.
    assert.ok(!/settings\??\.holderAddress/.test(fn.slice(0, fn.indexOf("\n}\n"))), "the self-declared field must not be read");
  });

  it("and a worker warning now reaches a screen that ships", () => {
    // Every gate that reports itself with addEvent() and nothing else was
    // invisible: /api/feed selected the events table, live.ts had no field for
    // it, and the only renderer sits in a route that returns null.
    const live = readFileSync(new URL("./live.ts", import.meta.url), "utf8");
    assert.match(live, /notice\?: \{ level: string; message: string; at: string \} \| null;/);
    assert.match(live, /e\.level === "warn" \|\| e\.level === "err"/);
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    // `notice` is mine.notice, minus the one dated "Energy spent for …" line
    // while the energy panel is already saying it (energy-banner.test.ts).
    assert.match(agent, /\{!blocked && !circleLocked && notice && \(/);
    assert.match(agent, /const notice =\s*mine\.notice &&/);
  });

  it("and the blocker still outranks it, because one is resolved and one is a log line", () => {
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    assert.ok(
      agent.indexOf("{blocked && (") < agent.indexOf("{!blocked && !circleLocked && notice && ("),
      "the resolved blocker must render above the notice",
    );
  });

  it("AND THE CIRCLE BLOCK IS ITS OWN BANNER, not a line in the log slot", () => {
    // "The app should warn more eye-catching when someone has chosen a
    // holder-only strategy and don't have access to it… I had to go to
    // /api/circle to check that and that's not good for normies."
    //
    // The notice slot renders the newest warn EVENT, and the Circle warn is
    // written once per process behind a latch — so hours later it has aged out
    // of the feed's window and the slot shows something else, or nothing. A
    // permanent condition cannot be reported by a transient log line.
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    assert.match(agent, /\{circleLocked && \(/);
    assert.match(agent, /desk-circle-locked/);
    // Derived from the reader's own standing, so it is true on first paint.
    assert.match(agent, /isCircleStrategyId\(mine\.glance\.id\) && tier !== null/);
    // And it must not fire while the tier is still unknown — an unread balance
    // is not a locked one.
    assert.match(agent, /tier\.why !== "sign-in" && !tier\.bonusStrategies/);
  });

  it("AND IT NAMES THE REMEDIES, NONE OF THEM \"ADD FUNDS\"", () => {
    // THIS ASSERTION USED TO RUN THE OTHER WAY. It pinned "Adding funds won't
    // change it", which was true while only the owner's own wallet counted and
    // stopped being true the day an agent could turn USDG into its own
    // $MERRYMEN (the get-energy command). A funded owner told money is not the
    // fix is exactly the owner who needs to hear that, converted, it is.
    //
    // What is pinned now: the count is the COMBINED one — the owner's wallet
    // and the agent's account, "between them" — the remedies are named, and an
    // unread balance is never defaulted to a zero.
    const agent = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(agent, /Adding funds won't change it/);
    assert.match(agent, /between them/);
    // Inside a template literal, so it is a plain apostrophe rather than the
    // JSX entity the surrounding markup uses.
    assert.match(agent, /ask me to get my \$MERRYMEN/);
    assert.doesNotMatch(agent, /tokens \?\? 0/, "an unread balance rendered as 'you hold 0'");
  });

  it("and the picker shows the same standing at the moment of choosing", () => {
    const create = readFileSync(new URL("./screens/CreateAgent.tsx", import.meta.url), "utf8");
    assert.match(create, /create-locked/);
    assert.match(create, /This one won&apos;t run yet/);
    // An unreadable balance is its own answer there too, never "you hold too
    // little" — somebody would go and buy more on the strength of our outage.
    assert.match(create, /That&apos;s our read failing, not your wallet/);
  });
});

/**
 * THE STANDING COUNTS THE OWNER'S WALLET AND THE AGENT'S ACCOUNT — EXCEPT WHERE
 * THE AGENT DOES NOT EXIST YET.
 *
 * /api/tier's `tokens` and `bonusStrategies` are the combined figure the worker
 * counts. That is the right answer on the desk and in Settings, about the agent
 * that exists. It is the wrong answer in the create flow: a new agent is a new,
 * empty account, and the old one's $MERRYMEN stays with the old one.
 */
describe("whose tokens each screen counts", () => {
  it("CREATE JUDGES THE WALLET ALONE, and says what a new agent does not inherit", async () => {
    const create = readFileSync(new URL("./screens/CreateAgent.tsx", import.meta.url), "utf8");
    assert.match(create, /!newAgentQualifies\(tier\)/);
    assert.match(create, /Your wallet holds \{count\(tier\.holderTokens\)\} \$MERRYMEN/);
    assert.match(create, /stays with\s+that agent — a new agent starts without it/);
    assert.doesNotMatch(create, /tokens \?\? 0/, "an unread count is a dash, not a zero");
    const { newAgentQualifies, UNREADABLE_TIER } = await import("./tier");
    const t = { ...UNREADABLE_TIER, why: "ok" as const, needTokens: 100_000 };
    assert.equal(newAgentQualifies({ ...t, holderTokens: 100_000, tokens: 100_000, bonusStrategies: true }), true);
    assert.equal(
      newAgentQualifies({ ...t, holderTokens: 60_000, agentTokens: 40_000, tokens: 100_000, bonusStrategies: true }),
      false,
      "the current agent's 40,000 does not come with a new one",
    );
    assert.equal(newAgentQualifies({ ...t, holderTokens: null }), false, "an unread wallet never qualifies");
  });

  it("SETTINGS STATES THE COMBINED FIGURE about the agent that exists", () => {
    const settings = readFileSync(new URL("./screens/Settings.tsx", import.meta.url), "utf8");
    // The figure renders through the catalogue, with the live counts in
    // {have} and {need} — never `?? 0`.
    assert.match(settings, /t\("settings\.text\.holdingShortfall", \{ have: count\(tier\.tokens\), need: count\(tier\.needTokens\) \}\)/);
    assert.match(
      EN["settings.text.holdingShortfall" as MessageKey] as string,
      /Your wallet and your agent's account hold \{have\} \$MERRYMEN and it needs \{need\}/,
    );
    assert.doesNotMatch(settings, /tier\.tokens \?\? 0/);
  });

  it("THE ENERGY LINE SHOWS ONLY WHILE THE DEPLOYMENT GATES ENERGY — as CreateAgent's does", () => {
    // The gate is off until an operator turns it on; describing a throttle
    // while nothing is limited is a false reason to buy. The paragraph renders
    // through the catalogue; the guard around it is what this pins.
    const settings = readFileSync(new URL("./screens/Settings.tsx", import.meta.url), "utf8");
    const at = settings.indexOf('t("settings.text.energyGateExplain"');
    assert.ok(at > 0);
    const guard = settings.lastIndexOf("{tier?.energyGate && (", at);
    assert.ok(guard > 0 && at - guard < 200, "the paragraph sits directly inside the energyGate guard");
    const create = readFileSync(new URL("./screens/CreateAgent.tsx", import.meta.url), "utf8");
    assert.match(create, /tier\.energyGate &&[\s\S]{0,400}Your agent runs at full energy/);
  });

  it("AND SAYS WHAT THE TOKEN IS FOR, and only that", () => {
    const energy = EN["settings.text.energyGateExplain" as MessageKey] as string;
    assert.match(energy, /\$MERRYMEN buys\s+capacity, nothing else — we make no promise about its price\./);
    assert.match(energy, /Stop-losses, take-profits and your own orders are never limited; its own AI\s+reviews — including of its open positions — are paced along with the rest\./);
    assert.doesNotMatch(energy, /Selling, stop-losses/, "an exit the AI decides is paced; 'selling is never limited' was false");
  });
});

/**
 * WHAT A SHORT CIRCLE AGENT DOES, IN ONE SENTENCE ON EVERY SURFACE
 * (worker/src/circle-gate.ts).
 *
 * Below the tier the worker does not tick the Circle strategy at all — a
 * rebalancer allowed only its trims sold the book down to cash — and the class
 * route's exits still run. The surfaces used to disagree: the web banner said
 * "It still closes what it holds" (false for both strategies: dip-hunter never
 * sells and even-keel is no longer asked), while Settings, iOS and Android said
 * the agent "stays idle" (false while a class position is being closed). Every
 * one of them now says the worker note's own sentence.
 */
const SENTENCE = /leaves\s+its\s+basket\s+as\s+it\s+is;\s+positions\s+in\s+a\s+class\s+vault\s+are\s+still\s+closed\s+by\s+their\s+own\s+exit\s+rules/;
/** Source text with JSX/Kotlin string joins flattened, so a wrapped sentence still reads as one. */
const flat = (src: string) => src.replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ");

describe("every surface says what a short Circle agent still does", () => {
  it("THE WEB BANNER: it opens nothing new, leaves its basket as it is, and says nothing about closing what it holds", () => {
    const agent = read("./screens/Agent.tsx");
    assert.match(agent, /is a Merry Circle strategy — it opens nothing new right now\./);
    assert.match(flat(agent), SENTENCE);
    assert.doesNotMatch(agent, /still closes what it holds/, "the strategy's own sells do not run below the tier");
    assert.doesNotMatch(agent, /it isn&apos;t running/, "class exits run below the tier");
  });

  it("SETTINGS AND CREATE, WEB: the same sentence, never 'stay idle'", () => {
    // Settings renders the sentence through the catalogue; CreateAgent still
    // carries it literally. Both ends are pinned: the key on one side, the
    // words on the other, and the catalogue holding the sentence itself.
    const settings = flat(read("./screens/Settings.tsx"));
    assert.match(settings, /t\("settings\.text\.holdingShortfall"/);
    assert.doesNotMatch(settings, /stays? idle until you hold enough/);
    assert.match(
      EN["settings.text.holdingShortfall" as MessageKey] as string,
      /opens nothing new and leaves its basket as it is/,
    );
    const create = flat(read("./screens/CreateAgent.tsx"));
    assert.match(create, SENTENCE);
    assert.doesNotMatch(create, /stays? idle until you hold enough/);
  });

  it("iOS AND ANDROID: the same sentence in the native strings", () => {
    const ios = flat(read("../../../ios-native/Sources/GrantScreen.swift"));
    assert.match(ios, /this strategy opens nothing new and leaves its basket as it is/);
    assert.match(ios, SENTENCE);
    assert.doesNotMatch(ios, /stays idle until your wallet/);
    const android = flat(read("../../../android-native/app/src/main/java/dev/merrymen/app/ui/screens/SettingsEditor.kt"));
    assert.match(android, /Until you do it opens nothing new and leaves its basket as it is/);
    assert.match(android, SENTENCE);
    assert.doesNotMatch(android, /agent stays idle until you do/);
  });

  it("THE WORKER'S OWN NOTE says it too — the surfaces repeat it, they do not invent it", () => {
    assert.match(flat(read("../../../worker/src/circle-gate.ts")), SENTENCE);
  });
});
