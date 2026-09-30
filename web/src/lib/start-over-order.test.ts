/**
 * START OVER SENDS ONE REQUEST, AT ONCE, THAT OUTLIVES THE TAB.
 *
 * Start over is the kill switch for a discarded grant (DELETE /api/grants) and
 * the ask for a practice reset, and the reset finds its agent through that
 * grant. Fired side by side, the DELETE won and the reset answered 401
 * (production, 2026-09-21T16:24:24Z). Chained, so the DELETE went only once
 * the reset had answered, the kill waited on a round trip, and a tab closed
 * inside it never sent the DELETE at all: the page had already forgotten the
 * grant, the server still ran it. So the page now sends one request, the
 * server does the ordering (/api/grants/discard and lib/start-over.ts, driven in
 * app/api/grants/discard/discard.test.ts), and this pins the page's half.
 *
 * Read through the TypeScript parser rather than by regex, so the pin is about
 * the call structure (the request is a statement of discard() itself, not the
 * body of a callback that runs later) and not about line order.
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
/** Every `fetch("<url>…", …)` under `root` whose URL starts with `prefix`. */
const fetches = (root: ts.Node, prefix: string) =>
  all(
    root,
    (n) =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "fetch" &&
      !!n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      n.arguments[0].text.startsWith(prefix),
  ) as ts.CallExpression[];

const discard = all(AST, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "discard")[0] as ts.FunctionDeclaration | undefined;

describe("Start over", () => {
  it("SENDS ONE REQUEST THAT DOES BOTH, AND NEITHER HALF ON ITS OWN", () => {
    assert.ok(discard?.body, "discard() is where Start over lives");
    const sent = fetches(discard, "/api/grants/discard");
    assert.equal(sent.length, 1, "one request, which removes the grant and queues the reset from it");
    const urls = (prefix: string) => fetches(discard, prefix).map((f) => (f.arguments[0] as ts.StringLiteral).text);
    assert.deepEqual(urls("/api/grants").filter((u) => u !== "/api/grants/discard"), [], "no separate DELETE to order against");
    assert.deepEqual(urls("/api/paper-reset"), [], "and no separate reset");
    const init = sent[0]!.arguments[1]!.getText();
    assert.match(init, /method: "POST"/);
    assert.match(init, /keepalive: true/, "a tab closed straight after the press still delivers the kill");
  });

  it("SENT NOW, NOT FROM A CALLBACK, AND WITH NOTHING BEFORE IT THAT COULD THROW IT AWAY", () => {
    const [del] = fetches(discard!, "/api/grants/discard");
    // The nearest function around the request is discard() itself: it is not
    // the body of a `.then`, a timer or any other callback that runs later, or
    // not at all once the page has gone.
    let fn: ts.Node = del!.parent;
    while (!ts.isFunctionLike(fn)) fn = fn.parent;
    assert.equal(fn, discard, "started by discard(), not by something discard() schedules");
    // AbortSignal.timeout does not exist on every browser this page meets, and
    // a synchronous throw there would skip the kill and the rest of the reset
    // of this screen.
    assert.doesNotMatch(discard!.body!.getText(), /AbortSignal\.timeout/);
  });

  it("keeps the browser grant and backup when the server refuses or cannot confirm the kill", async () => {
    assert.ok(discard);
    // Drive the actual handler with its component dependencies replaced by
    // captures; no wallet keys, network or React rendering are needed.
    const code = ts.transpileModule(discard.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const outcome of ["refused", "offline", "removed", "replaced"] as const) {
      const steps: string[] = [];
      const errors: (string | null)[] = [];
      let stored = { smartAccount: "0xoriginal", serialized: "original-signature" };
      const deps: Record<string, unknown> = {
        discarding: false,
        funding: null,
        grant: null,
        loadGrant: () => stored,
        fetch: async () => {
          steps.push("request");
          if (outcome === "offline") throw new Error("offline");
          // Same account, newly signed: account comparison alone is not enough.
          if (outcome === "replaced") stored = { ...stored, serialized: "new-signature" };
          return new Response(JSON.stringify({ error: "The owner key could not be archived" }), { status: outcome === "refused" ? 409 : 200 });
        },
        clearGrant: () => steps.push("clear grant"),
        setError: (error: string | null) => errors.push(error),
        localStorage: { removeItem: () => steps.push("clear backup") },
        BACKUP_KEY: "backup",
        MAINNET: 4663,
        PRESETS: [{ caps: {} }],
      };
      for (const setter of ["setDiscarding", "setRenewed", "setGrant", "setBackedUp", "setReveal", "setAck", "setMainnetAck", "setFunding", "setChainId", "setCaps", "setCapText"]) deps[setter] = () => {};
      const handler = new Function(...Object.keys(deps), `${code}; return discard;`)(...Object.values(deps)) as () => Promise<void>;
      await handler();
      if (outcome === "removed") {
        assert.deepEqual(steps, ["request", "clear grant", "clear backup"]);
      } else {
        assert.deepEqual(steps, ["request"], "a failed kill must keep the wallet and backup intact");
        assert.match(errors.at(-1) ?? "", outcome === "refused" ? /could not be archived/ : outcome === "replaced" ? /newer wallet and its backup were kept/ : /could not confirm/);
      }
    }
  });
});
