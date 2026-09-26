/**
 * The chat's history is read again after the startup fill repair.
 *
 * Spawn reads each child's history (history-files.ts) before startHistoryRepair
 * begins, so without this what the repair recovers — a coin's name, a fill
 * side, a sale's P&L — reaches the chat only at the next redeploy. Pinned
 * through the TypeScript parser, as orchestrator-groupchat.test.ts does, so a
 * comment or a string containing the words cannot satisfy it; and nothing here
 * imports the orchestrator, so no test home is created.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");
const AST = ts.createSourceFile("orchestrator.ts", SRC, ts.ScriptTarget.Latest, true);

function all(root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (keep(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}
const calls = (root: ts.Node, name: string) =>
  all(root, (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) as ts.CallExpression[];
const fn = (name: string) => AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);

describe("history refresh after the startup repair", () => {
  it("runs after the repair, awaited, only when the repair wrote something", () => {
    const repair = fn("startHistoryRepair");
    assert.ok(repair);
    const fix = calls(repair, "repairHistoricalFills")[0];
    const refresh = calls(repair, "refreshHistoryForLiveChildren")[0];
    assert.ok(fix && refresh, "startHistoryRepair calls both");
    assert.ok(refresh.getStart() > fix.getEnd(), "the refresh comes after the repair");
    assert.ok(ts.isAwaitExpression(refresh.parent), "awaited inside the repair's own async body");
    let gated = false;
    for (let p: ts.Node | undefined = refresh.parent; p && p !== repair; p = p.parent) {
      if (ts.isIfStatement(p) && /result\.(repaired|pnlRecovered)/.test(p.expression.getText())) gated = true;
    }
    assert.ok(gated, "only when the repair recovered something");
  });

  it("re-reads each live child behind its lease, with its current account, skipping one replaced meanwhile", () => {
    const live = fn("refreshHistoryForLiveChildren");
    assert.ok(live);
    const w = calls(live, "writeHistoryForChild")[0];
    assert.ok(w, "it writes the history");
    const account = w.arguments[1]!;
    assert.ok(ts.isPropertyAccessExpression(account) && account.name.text === "smartAccount", "the child's current smartAccount");
    assert.match(live.getText(), /\.healthy\(\)/);
    assert.match(live.getText(), /children\.get\(tenant\) !== child/);
    assert.match(live.getText(), /if \(stopping\) return/);
  });

  it("spawn still writes the history exactly once", () => {
    // spawnChild is the single-flight guard; the spawn itself is the function it wraps.
    const guard = fn("spawnChild");
    assert.ok(guard);
    assert.equal(calls(guard, "spawnChildUnguarded").length, 1, "spawnChild runs the spawn, once");
    const spawn = fn("spawnChildUnguarded");
    assert.ok(spawn);
    assert.equal(calls(spawn, "writeHistoryForChild").length, 1);
  });
});

describe("the bound between carried history and the child's own ledger", () => {
  it("is where the child's ledger begins, taken before any await, and bounds everything carried", () => {
    const w = fn("writeHistoryForChild");
    assert.ok(w);
    const start = calls(w, "ledgerStartOf")[0];
    const firstAwait = all(w, (n) => ts.isAwaitExpression(n))[0];
    assert.ok(start && firstAwait, "reads the ledger's start, and awaits later");
    assert.ok(start.getEnd() < firstAwait.getStart(), "before any await — so before a spawn's child exists");
    const load = calls(w, "loadHistoryFromShared")[0];
    assert.ok(load && load.arguments[3] && /\buntil\b/.test(load.arguments[3].getText()), "the carried rows and account end there");
  });

  it("the ledger's start is its earliest mark, flow or trade row", () => {
    const f = fn("ledgerStartOf");
    assert.ok(f);
    const text = f.getText();
    for (const table of ["equity", "flows", "trades"]) assert.ok(text.includes(`FROM ${table}`), table);
    assert.match(text, /readOnly: true/);
  });
});
