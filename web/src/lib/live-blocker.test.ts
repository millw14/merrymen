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
    assert.match(agent, /className="desk-blocked"/);
  });

  it("and it points at the signer only when signing is the fix", () => {
    // Sending money to a wrong-chain agent is money spent for nothing, and
    // re-signing does not conjure USDG. `funding` is which of the two it is.
    const agent = at("../terminal/screens/Agent.tsx");
    assert.match(agent, /\{!blocked\.funding && \(/);
    assert.match(agent, /onClick=\{onResign\}/);
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
