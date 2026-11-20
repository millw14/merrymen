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
        session: { hosted: false, address: null },
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
        resetQueuedEarlier: { current: false },
        onAccountChanged: () => {},
      };
      for (const setter of ["setDiscarding", "setRenewed", "setGrant", "setBackedUp", "setReveal", "setAck", "setMainnetAck", "setFunding", "setChainId", "setCaps", "setCapText", "setStartOverNote"]) deps[setter] = () => {};
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

  /**
   * NO RESET QUEUED IS SAID. The server answers what became of the practice
   * reset (`paperReset`, discard/route.ts): "no-agent" when the grant it finds
   * the agent through was already stopped, "failed" when the queue could not
   * be written. Both used to end on the same clean page as a queued one
   * (2026-11-18). The kill and the browser cleanup are unchanged either way,
   * and a reset an earlier, incomplete press queued is never denied.
   */
  it("says when no practice reset was queued, and says nothing for one that was", async () => {
    assert.ok(discard);
    const code = ts.transpileModule(discard.getText(), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    /** One page: its presses share the page's memory of a reset an earlier press queued. */
    const page = () => {
      const resetQueuedEarlier = { current: false };
      return async (body: unknown, status = 200) => {
        const steps: string[] = [];
        const notes: (string | null)[] = [];
        const errors: (string | null)[] = [];
        let told = 0;
        const stored = { smartAccount: "0xoriginal", serialized: "original-signature" };
        const deps: Record<string, unknown> = {
          discarding: false,
          funding: null,
          grant: null,
          session: { hosted: true, address: "0x" + "a".repeat(40) },
          loadGrant: () => stored,
          fetch: async () => { steps.push("request"); return new Response(JSON.stringify(body), { status }); },
          clearGrant: () => steps.push("clear grant"),
          setError: (error: string | null) => errors.push(error),
          setStartOverNote: (note: string | null) => notes.push(note),
          localStorage: { removeItem: () => steps.push("clear backup") },
          BACKUP_KEY: "backup",
          MAINNET: 4663,
          PRESETS: [{ caps: {} }],
          resetQueuedEarlier,
          onAccountChanged: () => { told += 1; },
        };
        for (const setter of ["setDiscarding", "setRenewed", "setGrant", "setBackedUp", "setReveal", "setAck", "setMainnetAck", "setFunding", "setChainId", "setCaps", "setCapText"]) deps[setter] = () => {};
        const handler = new Function(...Object.keys(deps), `${code}; return discard;`)(...Object.values(deps)) as () => Promise<void>;
        await handler();
        assert.deepEqual(steps, status === 200 ? ["request", "clear grant", "clear backup"] : ["request"], "the kill and the browser cleanup are what they were");
        assert.equal(notes[0], null, "a press clears the last note first");
        assert.equal(told, 1, "the shell reads the account again once the server has answered");
        return { note: notes.at(-1) ?? null, error: errors.at(-1) ?? null };
      };
    };
    const run = async (body: unknown) => (await page()(body)).note;
    const none = await run({ ok: true, paperReset: "no-agent" });
    assert.match(none ?? "", /permission is discarded/);
    assert.match(none ?? "", /this Start over found no running agent, so no reset was queued/);
    assert.match(none ?? "", /the paper book was not restarted/);
    assert.doesNotMatch(none ?? "", /practice/, "the dialog's own words: the paper book");
    const failed = await run({ ok: true, paperReset: "failed" });
    assert.match(failed ?? "", /the reset could not be queued, so the paper book was not restarted/);
    assert.equal(await run({ ok: true, paperReset: "queued" }), null, "a queued reset needs no apology");
    assert.equal(await run({ ok: true, paperReset: "queued", perps: "stopped" }), null);
    // An answer that names no outcome is not read as one either way.
    assert.equal(await run({ ok: true }), null);
    assert.equal(await run("not json at all"), null);

    // AN INCOMPLETE START OVER THAT QUEUED THE RESET (a Perps wallet that would
    // not stop: discard/route.ts answers 503 after the Spot half). The first
    // press says the reset was queued; the retry, which finds no agent left,
    // does not deny it.
    const press = page();
    const incomplete = { error: "Start over incomplete: your agent's grant is discarded, but your Perps wallet's grant could not be revoked yet. Try again.", ownerFacing: true, paperReset: "queued", perps: "not-stopped" };
    const first = await press(incomplete, 503);
    assert.match(first.error ?? "", /Start over incomplete/);
    assert.equal(first.note, "The paper book's reset was queued.");
    const retry = await press({ ok: true, paperReset: "no-agent", perps: "stopped" });
    assert.match(retry.note ?? "", /reset was queued by your earlier press/);
    assert.doesNotMatch(retry.note ?? "", /no reset was queued|not restarted/);
    // Said once: a later press that finds nothing is this press's own news again.
    assert.match((await press({ ok: true, paperReset: "no-agent" })).note ?? "", /no reset was queued/);
    // A 503 whose reset was not queued says only its error.
    assert.equal((await page()({ ...incomplete, paperReset: "no-agent" }, 503)).note, null);
    // And the page draws it, as a status, whichever panel the discard left showing.
    const shell = SRC.indexOf('<div className="grant-shell">');
    const drawn = SRC.indexOf('{startOverNote && <p role="status">{startOverNote}</p>}', shell);
    assert.ok(shell > 0 && drawn > shell, "the note is drawn inside the shell");
    assert.ok(drawn < SRC.indexOf('id="permission-security"', shell) && drawn < SRC.indexOf("{(!grant || switching) && (", shell), "before any panel");
  });
});
