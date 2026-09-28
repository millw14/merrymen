/**
 * START OVER ASKS FOR THE PRACTICE RESET, AND HEARS BACK, BEFORE IT DISCARDS THE GRANT.
 *
 * /api/paper-reset finds the agent to queue the reset for through the live
 * grant (agent-for.ts hostedAgentFor), and Start over also sends DELETE
 * /api/grants. The two were fired side by side, so the DELETE could land first
 * and leave the reset nobody to queue for: a 401 the catch swallowed. That is
 * what happened in production at 2026-09-21T16:24:24Z, to an owner whose
 * practice book was held and who pressed Start over to get out of it.
 *
 * Read through the TypeScript parser rather than by regex, so the pin is about
 * the call structure (the DELETE runs in a `.then` of the chain the POST
 * starts) and not about line order, which a promise does not respect.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";

const SRC = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");
const AST = ts.createSourceFile("Wallet.tsx", SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const all = (root: ts.Node, keep: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (keep(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
};
/** Every `fetch("<url>", …)` under `root`. */
const fetches = (root: ts.Node, url: string) =>
  all(
    root,
    (n) =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "fetch" &&
      !!n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text === url,
  ) as ts.CallExpression[];

const discard = all(AST, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "discard")[0] as ts.FunctionDeclaration | undefined;

describe("Start over", () => {
  it("SENDS THE RESET FIRST, AND THE DELETE ONLY ONCE THE RESET HAS ANSWERED", () => {
    assert.ok(discard?.body, "discard() is where Start over lives");
    const [post] = fetches(discard, "/api/paper-reset");
    const [del] = fetches(discard, "/api/grants");
    assert.ok(post && del, "it asks for both");
    assert.equal(fetches(discard, "/api/grants").length, 1, "one DELETE, and only in the chain");
    assert.match(del.arguments[1]!.getText(), /method: "DELETE"/);

    // The DELETE is the body of an arrow passed to `.then(...)`, and that
    // `.then` is called on a chain whose root is the reset's fetch.
    const arrow = del.parent;
    assert.ok(ts.isArrowFunction(arrow), "the DELETE is started by a callback, not beside the reset");
    const then = arrow.parent;
    assert.ok(ts.isCallExpression(then) && ts.isPropertyAccessExpression(then.expression) && then.expression.name.text === "then");
    let root: ts.Expression = then.expression.expression;
    while (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression)) root = root.expression.expression;
    assert.equal(root, post, "and the chain it waits on is the reset's");
  });

  it("A RESET THAT FAILS OR HANGS STILL DISCARDS THE GRANT", () => {
    const [post] = fetches(discard!, "/api/paper-reset");
    // Bounded, so the kill-switch half is never held up for long…
    assert.match(post!.arguments[1]!.getText(), /signal: AbortSignal\.timeout\([\d_]+\)/);
    // …and a rejection is caught BEFORE the `.then`, so the DELETE still runs.
    const caught = post!.parent;
    assert.ok(ts.isPropertyAccessExpression(caught) && caught.name.text === "catch", "the reset's own failure is caught first");
    const next = caught.parent.parent;
    assert.ok(ts.isPropertyAccessExpression(next) && next.name.text === "then", "and only then does the DELETE go");
  });
});
