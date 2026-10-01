/**
 * THE RESTART LOOP THAT PAID FOR ITSELF IN COLD ARMS.
 *
 * A cold arm is the single most expensive thing a child does to the shared
 * endpoint: twenty-eight sequential reads, twenty-one of them a getLogs walk
 * over 200,000 blocks, none of which batch because each one blocks the next. A
 * steady tick, by contrast, is three requests carrying forty-nine values. So a
 * restart is not a neutral event — it is roughly ten ticks' worth of load,
 * issued as a burst, at the endpoint that is already refusing.
 *
 * Two separate defects made that burst repeat for ever, and neither was
 * visible from the other's file:
 *
 *   THE WATCHDOG had no brake. The exit handler backed off and capped at
 *   MAX_RESTARTS; the watchdog called spawnChild on the line after the SIGKILL,
 *   with no delay and no ceiling. And the watchdog is the path a RATE-LIMITED
 *   child takes, because a tick stuck retrying stops beating — so the one
 *   failure mode the endpoint actually produces got the un-braked restart.
 *
 *   RECONCILE UNDID THE CEILING. It runs every fifteen seconds and spawns
 *   anything wanted that is not currently running, with `restarts` defaulting
 *   to 0 — so a tenant the exit handler had just given up on came back a
 *   quarter of a minute later with a clean ladder, climbed it, gave up, and was
 *   picked up again. Roughly nine restarts every two minutes, indefinitely.
 *
 * These are read out of the source because the policy is one function and two
 * call sites, and the failure is silent: a fleet that has quietly gone back to
 * restarting without a brake looks exactly like a fleet with flaky children.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const orch = () => readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");

describe("there is exactly one restart policy", () => {
  it("AND THE WATCHDOG GOES THROUGH IT", () => {
    // The regression to fear is this line reverting to a direct spawnChild,
    // which is what it was.
    const src = orch();
    const watchdog = src.slice(src.indexOf("export function watchdog("), src.indexOf("function haltRequested("));
    assert.match(watchdog, /scheduleRestart\(tenant as `0x\$\{string\}`, rung, "heartbeat stale"\)/);
    assert.ok(
      !/kill\("SIGKILL"\);[\s\S]{0,200}void spawnChild\(/.test(src),
      "the watchdog must not restart on the same line as the kill",
    );
    // AND IT IS THE ONLY RESTART. The entry goes before the kill, so the
    // corpse's exit handler finds it is not its own and stands aside rather
    // than scheduling a second, one-second, restart-count-zero restart that
    // always won — which is what kept this ladder from ever climbing.
    const deleted = watchdog.indexOf("children.delete(tenant);");
    assert.ok(deleted > 0 && deleted < watchdog.indexOf('child.proc.kill("SIGKILL")'), "the entry goes before the kill");
  });

  it("and so does an exit — of a child that is still its own", () => {
    const src = orch();
    assert.match(src, /scheduleRestart\(tenant, freshRestarts, restartReason\)/);
    // An exit whose entry is gone or replaced was stood down by somebody who
    // already decided (stop-the-loop.test.ts, A2).
    const stoppedAt = src.indexOf("const childStopped = (", src.indexOf("async function spawnChild("));
    const handler = src.slice(stoppedAt, src.indexOf('proc.on("error"', stoppedAt));
    const standAside = handler.indexOf("if (!ours) {");
    assert.match(src, /proc\.on\("exit", \(code, signal\) => childStopped\(`exited \(\$\{code\}\)`, `exit \$\{code\}`/);
    assert.ok(
      standAside > 0 && handler.indexOf("return;", standAside) < handler.indexOf("scheduleRestart(tenant, freshRestarts"),
      "only its own child's exit reaches the policy",
    );
  });

  it("BOTH PATHS PICK THE RUNG BY ONE RULE: HOW LONG THE CHILD STAYED ALIVE", () => {
    // The watchdog used to have its rung decided for it: the corpse's exit
    // scheduled rung 0 at one second, which always won. Deciding alone with
    // `restarts + 1`, it carried a rung from one incident into the next, so a
    // child that wedged once a week climbed a rung a week. A stall after a
    // healthy run is a fresh incident, as a death after one is; "alive" for a
    // wedged child is up to its last beat, not its age.
    const src = orch();
    const rule = src.slice(src.indexOf("function nextRung("), src.indexOf("\n}\n", src.indexOf("function nextRung(")));
    assert.match(rule, /aliveUntilMs - child\.startedAt > HEALTHY_RUN_MS \? 0 : child\.restarts \+ 1/);
    assert.match(src, /const freshRestarts = nextRung\(child, Date\.now\(\)\);/, "an exit is alive until it exits");
    const watchdog = src.slice(src.indexOf("export function watchdog("), src.indexOf("function haltRequested("));
    assert.match(
      watchdog,
      /const rung = nextRung\(child, beat === null \? child\.startedAt : beat \* 1000\);/,
      "a wedged child is alive until its last beat, and one that never beat was never alive",
    );
    assert.ok(!/scheduleRestart\([^)]*restarts \+ 1/.test(watchdog), "the watchdog does not climb on its own");
  });

  it("and the policy itself both waits and gives up", () => {
    const src = orch();
    const policy = src.slice(src.indexOf("function scheduleRestart("), src.indexOf("async function spawnChild("));
    assert.match(policy, /if \(restarts > MAX_RESTARTS\)/, "it must have a ceiling");
    assert.match(policy, /Math\.min\(30_000, 1_000 \* 2 \*\* Math\.min\(restarts, 5\)\)/, "and a backoff");
    assert.match(policy, /setTimeout\(/, "and the backoff must actually delay the spawn");
  });
});

describe("reconcile cannot undo the ceiling", () => {
  it("A GIVEN-UP TENANT IS SKIPPED WHILE IT IS STOOD DOWN", () => {
    const src = orch();
    const loop = src.slice(src.indexOf("for (const tenant of tenants) {"));
    assert.match(loop, /const cool = gaveUpUntil\.get\(lc\);/);
    assert.match(loop, /if \(cool && Date\.now\(\) < cool\.until\) continue;/);
  });

  it("AND IT COMES BACK WITH THE COUNT IT HAD, not a clean slate", () => {
    // The clean slate is the whole bug: it is what made MAX_RESTARTS
    // unreachable, because the ladder restarted at 1s every fifteen seconds.
    const src = orch();
    assert.match(src, /await spawnChild\(lc, cool\?\.restarts \?\? 0\);/);
  });

  it("but the stand-down expires, because a supervisor that stops trying is an outage", () => {
    // A tenant whose child cannot stay up is a real problem a human has to see.
    // Making the loop cheap must not make it permanent.
    const src = orch();
    assert.match(src, /const GIVE_UP_COOLOFF_MS = 5 \* 60_000;/);
    assert.match(src, /gaveUpUntil\.delete\(lc\);/);
  });

  it("and the stand-down survives the child, which is the only reason it works", () => {
    // Keyed to the tenant, not to a Child record — the record is gone by the
    // time reconcile looks, which is exactly how it saw a clean slate.
    const src = orch();
    assert.match(src, /const gaveUpUntil = new Map<string, \{ until: number; restarts: number \}>\(\);/);
  });

  it("NOR CAN IT UNDO A RESTART THAT IS STILL WAITING FOR ITS TIMER", () => {
    // The same clean slate by another door: a tenant whose restart timer had
    // not fired was not running, so the next pass spawned it at rung 0 and
    // the timer stood aside. 16s and 30s lose to a fifteen-second pass, so the
    // ladder reset at about #4 and MAX_RESTARTS (#9) was unreachable.
    // double-spawn.integration.test.ts drives it to the stand-down.
    const src = orch();
    const policy = src.slice(src.indexOf("function scheduleRestart("), src.indexOf("/** The worker entrypoint"));
    const recorded = policy.indexOf("restartPending.set(tenant, pending);");
    assert.ok(recorded > 0, "a scheduled restart is recorded");
    const own = policy.indexOf("if (restartPending.get(tenant) !== pending) return;");
    const released = policy.indexOf("restartPending.delete(tenant);");
    const spawned = policy.indexOf("void spawnChild(tenant, restarts)");
    assert.ok(own > 0 && own < released && released < spawned, "the timer acts only for itself, and lets go before it spawns");
  });
});

/**
 * ONE SPAWN PER TENANT AT A TIME.
 *
 * spawnChild awaits a dozen times between "nothing is running" and `spawn()`,
 * and every caller checked only `children`, which learns about a child at
 * `spawn()`. So a reconcile pass and a restart timer arriving inside that
 * window both started a worker: two processes on one home and one sqlite
 * file, both trading. Pinned through the TypeScript parser, so a comment or a
 * string holding the words cannot satisfy it; double-spawn.integration.test.ts
 * drives the same paths through the real reconcile().
 */
describe("a tenant being spawned is not a tenant that isn't running", () => {
  const AST = ts.createSourceFile("orchestrator.ts", orch(), ts.ScriptTarget.Latest, true);
  const fn = (name: string) => {
    const f = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(f?.body, `${name} must exist`);
    return f;
  };
  const all = (root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] => {
    const out: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      if (keep(n)) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
  };
  const calls = (root: ts.Node, name: string) =>
    all(root, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name);
  const within = (n: ts.Node, outer: ts.Node) => n.getStart() >= outer.getStart() && n.getEnd() <= outer.getEnd();

  /** The claim: the tenant goes into `spawning`, stamped with when. */
  const isClaim = (s: ts.Statement) => /^spawning\.set\(tenant, \{ since: Date\.now\(\), flagged: false \}\);$/.test(s.getText());

  it("SPAWNCHILD REFUSES A SECOND ENTRY, AND CLAIMS THE TENANT BEFORE ITS FIRST AWAIT", () => {
    const spawn = fn("spawnChild");
    const stmts = [...spawn.body!.statements];
    const refuse = stmts.findIndex(
      (s) => ts.isIfStatement(s) && s.expression.getText() === "spawning.has(tenant)" && all(s.thenStatement, ts.isReturnStatement).length > 0,
    );
    const claim = stmts.findIndex(isClaim);
    assert.ok(refuse >= 0, "a tenant already in `spawning` is refused");
    assert.ok(claim > refuse, "and the claim follows the refusal");
    const firstAwait = all(spawn, ts.isAwaitExpression)[0];
    assert.ok(firstAwait && stmts[claim]!.getEnd() < firstAwait.getStart(), "synchronously — before anything can interleave");
  });

  it("AND RELEASES IT HOWEVER IT LEAVES", () => {
    // A leaked claim is a tenant reconcile never spawns again. Every return
    // and every await after the claim sits inside one try whose finally
    // releases it, and that try is the rest of the function.
    const spawn = fn("spawnChild");
    const stmts = [...spawn.body!.statements];
    const claim = stmts.findIndex(isClaim);
    const guarded = stmts[claim + 1];
    assert.ok(guarded && ts.isTryStatement(guarded), "the statement after the claim is a try");
    assert.equal(claim + 2, stmts.length, "and nothing follows it");
    assert.ok(guarded.finallyBlock && /spawning\.delete\(tenant\)/.test(guarded.finallyBlock.getText()), "its finally releases the claim");
    const after = (n: ts.Node) => n.getStart() > stmts[claim]!.getEnd();
    for (const r of all(spawn, ts.isReturnStatement).filter(after)) {
      // The exit handler's own returns are inside the try as well; they leave
      // the handler, not spawnChild, and are covered by the same check.
      assert.ok(within(r, guarded.tryBlock), `return at ${r.getStart()} is inside the try`);
    }
    for (const a of all(spawn, ts.isAwaitExpression)) assert.ok(within(a, guarded.tryBlock), "every await is inside the try");
  });

  it("RECONCILE AND THE RESTART TIMER STEP ROUND A SPAWN IN PROGRESS", () => {
    const rec = fn("reconcile");
    const skip = all(
      rec,
      (n) =>
        ts.isIfStatement(n) &&
        n.expression.getText() === "children.has(lc) || spawning.has(lc) || restartPending.has(lc)" &&
        ts.isContinueStatement(n.thenStatement),
    )[0];
    assert.ok(skip, "reconcile skips a tenant that is running, being spawned, or waiting on its restart timer");
    const spawnCall = calls(rec, "spawnChild")[0];
    const leaseCall = calls(rec, "acquireTenantLease")[0];
    assert.ok(spawnCall && leaseCall && skip.getEnd() < leaseCall.getStart(), "before it takes a lease or spawns");

    const policy = fn("scheduleRestart");
    const timerSpawn = calls(policy, "spawnChild")[0];
    assert.ok(timerSpawn, "the timer spawns through spawnChild");
    let guard: ts.IfStatement | undefined;
    for (let p: ts.Node | undefined = timerSpawn.parent; p && p !== policy; p = p.parent) if (ts.isIfStatement(p)) guard = p;
    assert.ok(guard && /!spawning\.has\(tenant\)/.test(guard.expression.getText()), "and only when no spawn is in progress");
  });

  it("THE PRECONDITIONS ARE ASKED AGAIN AFTER THE LAST AWAIT, BEFORE spawn()", () => {
    // Checked on the way in, then a dozen awaits: a shutdown, a FLEET_HALT, a
    // lease dropped or released, or a Telegram kill landing in between was
    // invisible, and the child started anyway.
    const spawn = fn("spawnChild");
    const late = calls(spawn, "lateSpawnRefusal")[0];
    const started = calls(spawn, "spawn")[0];
    assert.ok(late && started, "spawnChild asks again, and spawns");
    const lateAwaits = all(spawn, ts.isAwaitExpression).filter((a) => a.getEnd() > late.getStart());
    const capRefusal = all(spawn, ts.isIfStatement).find(
      (node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText() === "localChildProcessCount() >= MAX_LOCAL_CHILD_PROCESSES",
    );
    assert.ok(capRefusal, "the only post-guard await belongs to the process-cap refusal");
    assert.deepEqual(lateAwaits.map((a) => a.getText()), ["await releaseLease(tenant)"], "no await that can reach spawn follows the final guard");
    const release = lateAwaits[0];
    assert.ok(release);
    assert.ok(
      release.getStart() > capRefusal.thenStatement.getStart() && release.getEnd() < capRefusal.thenStatement.getEnd() &&
      /return;/.test(capRefusal.thenStatement.getText()),
      "the lease release returns instead of continuing to spawn",
    );
    assert.ok(late.getEnd() < started.getStart(), "and before the worker starts");
    const refusal = fn("lateSpawnRefusal").body!.getText();
    for (const asked of ["stopping", "haltRequested()", "leases.get(tenant) !== lease", "lease.healthy()", "killRequested(childHome(tenant))"]) {
      assert.ok(refusal.includes(asked), `it asks ${asked}`);
    }
  });

  it("A SPAWN THAT NEVER SETTLES IS SAID OUT LOUD, AND ITS CLAIM IS NEVER TAKEN BACK", () => {
    // Stepping round a claim is silent, so a spawn stuck on a lock wait would
    // take its tenant, and its Telegram bot, dark with nothing in the log.
    // Releasing the claim instead would reopen the double spawn.
    const rec = fn("reconcile");
    const flag = calls(rec, "flagStuckSpawn")[0];
    const skip = all(rec, (n) => ts.isIfStatement(n) && /spawning\.has\(lc\)/.test(n.expression.getText()))[0];
    assert.ok(flag && skip && flag.getEnd() < skip.getStart(), "reconcile looks before it steps round");
    const body = fn("flagStuckSpawn").body!;
    assert.match(body.getText(), /\[alert\] spawn for/);
    assert.ok(!/spawning\.(delete|clear)\(/.test(body.getText()), "it only says so");
  });
});

/**
 * THE KILL SWITCH WIPES EVERY HOME IT STANDS DOWN, NOT ONLY A RUNNING ONE.
 *
 * A kill or a DELETE /api/grants that lands mid-spawn is refused at the last
 * moment, after the grant, the settings (with the bot token) and the anchor
 * were written — so the tenant never reaches `children`, and the kill-switch
 * branch, which walked only `children`, never wiped it. Driven in
 * double-spawn.integration.test.ts.
 */
describe("a stood-down tenant's home goes with it", () => {
  const AST = ts.createSourceFile("orchestrator.ts", orch(), ts.ScriptTarget.Latest, true);
  const rec = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "reconcile")!;

  it("RECONCILE WALKS THE HOMES ON DISK, AND KEEPS HOMES WITH AN EXIT OR EXPIRY DRAIN", () => {
    const text = rec.body!.getText();
    const walk = text.indexOf("for (const tenant of childHomeTenants())");
    assert.ok(walk > 0, "the homes on disk, not the running set");
    const loop = text.slice(walk);
    assert.match(loop, /if \(wanted\.has\(tenant\) \|\| children\.has\(tenant\) \|\| spawning\.has\(tenant\) \|\| retiringExpired\.has\(tenant\) \|\| exitingChildren\.has\(tenant\) \|\| holders\.has\(tenant\)\) continue;/);
    // Its restart is cancelled before anything awaits, so no timer starts a
    // spawn in the home while it is being read and wiped.
    const cancel = loop.indexOf("cancelRestart(tenant);");
    const firstAwait = loop.indexOf("await ");
    const wipe = loop.indexOf("rmSync(childHome(tenant)");
    assert.ok(cancel > 0 && cancel < firstAwait && firstAwait < wipe, "cancel, carry the ledger up, then wipe");
    // Asked again after the await: a spawn that started meanwhile keeps its home.
    const recheck = loop.indexOf("if (children.has(tenant) || spawning.has(tenant) || retiringExpired.has(tenant) || exitingChildren.has(tenant) || holders.has(tenant)) continue;", firstAwait);
    assert.ok(recheck > firstAwait && recheck < wipe, "and it looks again before the wipe");
  });

  it("AND CARRIES ITS LEDGER UP FIRST, BUT ONLY UNDER THE LEASE", () => {
    const loop = rec.body!.getText().slice(rec.body!.getText().indexOf("for (const tenant of childHomeTenants())"));
    const mirror = loop.indexOf("await finalMirrorBeforeAnchor(tenant,");
    assert.ok(mirror > 0 && mirror < loop.indexOf("rmSync(childHome(tenant)"));
    assert.match(loop, /if \(url && leases\.get\(tenant\)\?\.healthy\(\) && !holders\.has\(tenant\)\) \{/);
    // Never a held book, even one whose lease is kept while its hold process
    // has not exited: restore-hold.test.ts pins the same guard.
  });
});
