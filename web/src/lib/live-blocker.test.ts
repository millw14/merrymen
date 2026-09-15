/**
 * A REFUSE RULE THE FUNDING SCREEN CANNOT TALK ABOUT IS A SILENT ONE.
 *
 * The worker decides what blocks the live rail; this page only translates the
 * name into something the person looking at a deposit address can act on. That
 * split is right, and it has exactly one failure mode: somebody adds a rule to
 * `exec-mode.ts` and the screen renders nothing for it — which is how an owner
 * ends up funding an account that was never short of money.
 *
 * `no-gas` was added to `RefuseRule` earlier today, and a census once the fleet
 * stopped being killed mid-tick found it is now the LARGEST blocker: 12
 * agents, against 9 wrong-chain, 6 dead-policy and 2 no-cash. That is twelve
 * owners who were reading "Send USDG to your agent's account" and doing it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ADVISED_RULES, blockerAdvice } from "./live-blocker";

/**
 * Every member of the `RefuseRule` union, read from its source.
 *
 * THE UNION MOVED, AND THIS FOLLOWED IT. It was declared in
 * `worker/src/exec-mode.ts` and is now in `packages/core/src/autonomy.ts`,
 * because the web tier cannot import from the worker and so had no way to
 * render the remedies at all — which is how nine owners sat in practice mode
 * while the one thing that would fix it was named only in a worker log.
 * exec-mode.ts re-exports it, so every worker importer is untouched.
 *
 * Read as TEXT rather than imported on purpose, and that is worth keeping: the
 * property is that the screen covers the union as DECLARED, and importing the
 * type would erase at runtime and assert nothing.
 */
function refuseRules(): string[] {
  const src = readFileSync(new URL("../../../packages/core/src/autonomy.ts", import.meta.url), "utf8");
  const at = src.indexOf("export type RefuseRule");
  assert.ok(at > 0, "RefuseRule must be declared in packages/core/src/autonomy.ts");
  const decl = src.slice(at, src.indexOf(";", at));
  const names = [...decl.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(names.length >= 4, `expected the union's members, parsed ${names.length}`);
  return names;
}

describe("the screen can talk about every blocker there is", () => {
  it("EVERY RefuseRule HAS ADVICE", () => {
    const missing = refuseRules().filter((r) => blockerAdvice(r) === null);
    assert.deepEqual(missing, [], `these blockers would render as nothing: ${missing.join(", ")}`);
  });

  it("and nothing here invents a rule the worker does not have", () => {
    const rules = refuseRules();
    const extra = ADVISED_RULES.filter((r) => !rules.includes(r));
    assert.deepEqual(extra, [], `advice for rules that cannot occur: ${extra.join(", ")}`);
  });

  it("NO-GAS IS THE ONE THIS WAS BUILT FOR, and it says to send ETH", () => {
    const a = blockerAdvice("no-gas");
    assert.ok(a);
    assert.equal(a.funding, true, "money is the fix, so the funding panel must say so");
    assert.match(a.say, /ETH/, "and it must name the asset that is missing");
    assert.ok(!/USDG/.test(a.say), "naming USDG here is what sent owners round the loop again");
  });

  it("and the three that money CANNOT fix say so", () => {
    // The failure this codebase keeps refusing: a screen that looks like it is
    // telling you what to do while being wrong about what would happen. An
    // owner who sends ETH to a wrong-chain agent has spent money for nothing.
    for (const rule of ["dead-policy", "wrong-chain", "not-armed", "no-executor"]) {
      const a = blockerAdvice(rule);
      assert.ok(a, `${rule} has no advice`);
      assert.equal(a.funding, false, `${rule} must not be presented as a funding problem`);
    }
  });
});

describe("what null means", () => {
  it("trading for real, and never beaten, are both silence", () => {
    assert.equal(blockerAdvice(null), null);
    assert.equal(blockerAdvice(undefined), null);
    assert.equal(blockerAdvice(""), null);
  });

  it("AN UNKNOWN RULE IS SILENCE, NOT A GUESS", () => {
    // A newer worker talking to an older page. Inventing advice for a name this
    // build has never seen would be worse than saying nothing.
    assert.equal(blockerAdvice("something-added-next-year"), null);
  });
});

describe("the fact travels from the child to the screen", () => {
  const codeOf = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
  const at = (p: string) => codeOf(readFileSync(new URL(p, import.meta.url), "utf8"));

  it("the worker writes it on the row it already mirrors", () => {
    // Same channel as `sponsor_gas`, for the same stated reason: only the child
    // resolves it and the dashboard has no other way to learn it.
    const store = at("../../../worker/src/store.ts");
    assert.match(store, /ALTER TABLE agents ADD COLUMN live_blocker TEXT/);
    assert.match(store, /UPDATE agents SET mode = \?, beat_at = \?, sponsor_gas = \?, live_blocker = \?/);
    const index = at("../../../worker/src/index.ts");
    assert.match(index, /setAgentMode\(active\.agentId, mode, at, sponsorGas, blocking\)/);
  });

  it("the mirror carries it to the shared database", () => {
    // A column the child writes and the mirror drops is a column the hosted
    // dashboard can never see — every hosted tenant read IDLE for weeks that way.
    const mirror = at("../../../worker/src/ledger-mirror.ts");
    assert.match(mirror, /sponsor_gas, live_blocker, x_handle/);
    assert.match(mirror, /live_blocker = excluded\.live_blocker/);
    assert.match(mirror, /a\.live_blocker \?\? null/);
  });

  it("and the route hands it to the browser", () => {
    const route = at("../app/api/grants/route.ts");
    assert.match(route, /SELECT mode, beat_at, sponsor_gas, live_blocker FROM agents/);
    assert.match(route, /liveBlocker = row\.live_blocker \?\? null;/);
    assert.match(route, /\n    liveBlocker,\n/);
  });
});

describe("the owner is told on the screen they actually open", () => {
  const codeOf = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
  const at = (p: string) => codeOf(readFileSync(new URL(p, import.meta.url), "utf8"));

  it("THE AGENT SCREEN SAYS WHAT IS STOPPING IT", () => {
    // status-line.ts has had the right testnet sentence for months — on /you,
    // which an owner who believes their agent is trading has no reason to open.
    // Measured on the fleet: ten agents on the practice chain and six with a
    // dead policy, every one showing an ordinary-looking desk. Their owners are
    // the ones reporting "it doesn't trade".
    const agent = at("../terminal/screens/Agent.tsx");
    assert.match(agent, /const blocked = blockerAdvice\(liveBlocker\)/);
    // THE RED PANEL IS NOW CONDITIONAL, and that is the fix rather than a
    // regression. It was unconditional, so the one state that means "your agent
    // is practising, exactly as you asked" was delivered as an alarm — which is
    // how a beta owner came to believe a working agent was broken.
    assert.match(agent, /blocked\.fault \? "desk-blocked" : "desk-note"/);
  });

  it("and it points at the signer only when signing is the fix", () => {
    // Sending money to a wrong-chain agent is money spent for nothing, and
    // re-signing does not conjure USDG.
    //
    // THIS USED TO READ `!blocked.funding`, inferring "a signature fixes it"
    // from "money does not". That inference was wrong in both directions and
    // shipped wrong: `no-executor` is ours to fix — the advice says so in as
    // many words — and the screen offered its owner a re-sign button for it
    // anyway. `live-not-enabled` is the second counterexample. The remedy is
    // now stated by the advice rather than guessed from its opposite.
    const agent = at("../terminal/screens/Agent.tsx");
    assert.match(agent, /\{blocked\.resign && \(/);
    assert.match(agent, /onClick=\{onResign\}/);
    assert.doesNotMatch(agent, /\{!blocked\.funding && \(/, "no longer inferred from funding");
  });

  it("and a state that is NOT a fault offers the switch, not a signature", () => {
    // The complaint this whole change came from: a practising owner was shown a
    // red banner and a re-sign button, and re-signing could never clear it
    // because nothing was broken. What he needed was the control that changes
    // the decision — and it has to be on this screen, because this is the one
    // he opens.
    const a = blockerAdvice("live-not-enabled");
    assert.ok(a);
    assert.equal(a.fault, false, "nothing is wrong");
    assert.equal(a.resign, false, "so a signature is not the remedy");
    assert.equal(a.funding, false, "and neither is money");
    assert.match(a.say, /Live trading/i, "it names the switch");
    // AND SAYS NOTHING ABOUT SIMULATION. This advice is keyed on the rule alone,
    // and the rule reaches two states: with paper trading on the agent
    // simulates, with it off `execModeOf` returns `refuse` and it does nothing
    // at all. An earlier draft said "practising with simulated money" for both,
    // which told a stopped agent's owner it was practising — and, in the idle
    // arm of `autonomyOf`, sat that sentence beside `simulated: false` and
    // "Available cash" in one object.
    assert.doesNotMatch(a.say, /practis|simulat/i, "the rule alone cannot know that");
    assert.match(a.say, /no real orders/i, "only what is true in both states");

    const agent = at("../terminal/screens/Agent.tsx");
    assert.match(agent, /liveBlocker === "live-not-enabled"/);
    assert.match(agent, /onClick=\{onSettings\}/, "and points at where the switch lives");
  });

  it("no-executor stops asking the owner for a signature it never needed", () => {
    const a = blockerAdvice("no-executor");
    assert.ok(a);
    assert.equal(a.funding, false);
    assert.equal(a.resign, false, "ours to fix — its own sentence says so");
    assert.equal(a.fault, true, "but it IS a fault, unlike live-not-enabled");
  });

  it("WRONG-CHAIN IS A SIGNING PROBLEM, NOT A FUNDING ONE", () => {
    // The ten testnet agents cannot be fixed by their owners sending anything.
    // They need a new grant on 4663, which only the owner's own signature can
    // mint — so the button has to be the signer, and money must not be implied.
    const a = blockerAdvice("wrong-chain");
    assert.ok(a);
    assert.equal(a.funding, false);
    assert.match(a.say, /new grant on Robinhood Chain/);
    assert.match(a.say, /funds sent here will sit unused/);
  });

  it("the shell hands it the child's verdict, not one it worked out itself", () => {
    const app = at("../terminal/App.tsx");
    assert.match(app, /liveBlocker=\{account\?\.status\.liveBlocker\}/);
  });
});

describe("the chat is told what the screen already knows", () => {
  it("THE BLOCKER REACHES THE MODEL, or the agent guesses at a fact it was handed", () => {
    // `liveBlocker` is what the worker itself resolved as the ONE thing stopping
    // real trading. It was a prop on the agent screen, rendered as advice, and
    // never sent to the chat — so an owner asking "do I still need to send gas
    // in ETH?" got a general answer while the specific one sat in the same
    // component. Reported verbatim in the beta.
    const agent = readFileSync(new URL("../terminal/screens/Agent.tsx", import.meta.url), "utf8");
    assert.match(agent, /liveBlocker:liveBlocker \?\? null,/);
  });

  it("and the prompt names every rule the screen advises on", () => {
    // If a new RefuseRule gains screen advice but the prompt does not learn it,
    // the agent falls back to a guess about the one thing it could have known.
    const chat = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    for (const rule of ADVISED_RULES) {
      // The prompt lives inside a template literal, so its backticks are
      // escaped in the source. Match the rule name and its bullet, not the
      // quoting — the quoting is an artefact of where the string lives.
      assert.match(
        chat,
        new RegExp(`·\\s*\\\\?\`${rule}\\\\?\``),
        `the chat prompt must explain ${rule}`,
      );
    }
  });

  it("AND NULL IS NOT READ AS 'ALL FINE'", () => {
    // Null means trading for real OR never beaten. The prompt has to carry that
    // ambiguity, because reading it as health is how an idle agent gets told it
    // is working.
    const chat = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(chat, /A NULL \\?`liveBlocker\\?` IS TWO ANSWERS/);
  });
});

/**
 * THE MODEL IS A SURFACE TOO, and it was the one telling owners the opposite.
 *
 * Three separate things pointed the chat at the wrong answer after live intent
 * became a real switch, and every one of them was invisible: the prompt is
 * prose, the STATE blob is a string, and neither typechecks.
 */
describe("the chat is not instructed to deny the switch it now has", () => {
  /**
   * The PROMPT, not the file. Comments are stripped because the history of this
   * copy is deliberately recorded in one above the template literal — quoting
   * the retired sentence inside the prompt would risk the model repeating it,
   * which is precisely the failure being fixed.
   */
  const PROMPT = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("STOPS SAYING THERE IS NO SWITCH", () => {
    // It said so in capitals, three lines above the bullet describing the
    // switch, with two beta incidents cited as justification. The paragraph was
    // written when it was true, and it stayed after it stopped being true —
    // which is the most durable kind of wrong copy there is.
    assert.doesNotMatch(PROMPT, /You do not have a switch/i);
    assert.doesNotMatch(
      PROMPT,
      /run on your own as soon as your key is signed and there is something to trade with/i,
      "funding plus a signature is exactly what must no longer imply live trading",
    );
  });

  it("and says which field IS the mode", () => {
    // `paperTradingEnabled` defaults true and CreateAgent now writes it true
    // unconditionally, so it is true for nearly every agent — including live
    // ones. A model reading it as the mode tells an owner their money is
    // pretend while it is being spent, which is the original defect pointed the
    // more dangerous way.
    // Backticks are escaped inside the template literal, so match the words.
    assert.match(PROMPT, /liveTradingEnabled\\?` IS THE MODE/);
    assert.match(PROMPT, /paperTradingEnabled\\?` IS NOT/);
  });

  it("and the STATE actually carries it", () => {
    // The prompt can only reason about fields the client sends. This one was
    // sending the misleading field and not the decisive one.
    const AGENT = readFileSync(
      new URL("../terminal/screens/Agent.tsx", import.meta.url),
      "utf8",
    );
    assert.match(AGENT, /liveTradingEnabled:settings\?\.values\?\.liveTradingEnabled/);
  });
});
