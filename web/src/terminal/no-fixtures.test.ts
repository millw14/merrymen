/**
 * NOTHING ON A SCREEN IS INVENTED HERE.
 *
 * The terminal was built as a standalone prototype first —
 * `samples/agents-only-shell`, removed in the same commit as this file — and
 * that prototype ran on fixtures. It had to: it was a design study with no
 * ledger behind it. But the fixtures it chose were not neutral placeholders,
 * and this is why the directory could not stay in the tree:
 *
 *   sample.ts   mapped invented display names onto REAL production agent slugs
 *               under the comment "Live slugs from app.merrymen.dev — same
 *               robots the feed already shows", and invented owners for them
 *   why.ts      hung hand-written quotes off those same real slugs
 *               (tj9fr041atb68ec8 → "The one name in the ten I actually
 *               wanted…") and generated a sentence from the strategy id for any
 *               agent it had no quote for
 *   Board.tsx   derived a dollar balance for each agent from a hash of its name
 *   live.ts     substituted the whole fixture set whenever the real API
 *               returned nothing — so an outage rendered as a busy product
 *
 * …and it shipped a `deploy/vercel.json`, so all of that was one command away
 * from being a public website attributing invented statements to identifiable
 * agents.
 *
 * The port to `web/src/terminal` dropped every one of those, which was the
 * right call and the most important thing anybody did in that integration. This
 * file exists so it stays dropped. The failure mode it guards is not malice —
 * it is somebody diffing the two copies to "sync a fix" and carrying a fixture
 * table back across, in a file whose name gives no hint of what is in it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TERMINAL = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(TERMINAL, "..", "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const FILES = sources(TERMINAL).map((f) => [path.relative(TERMINAL, f).split(path.sep).join("/"), readFileSync(f, "utf8")] as const);

describe("the prototype's fixtures cannot come back", () => {
  it("the sample directory is not in the tree", () => {
    // Kept in git history on `feat/fomo-shell`; what must not exist is a second
    // live copy of these screens that nothing builds, typechecks or tests.
    let present = true;
    try {
      statSync(path.join(REPO, "samples", "agents-only-shell"));
    } catch {
      present = false;
    }
    assert.equal(present, false, "samples/agents-only-shell is back — see this file's header");
  });

  it("INVARIANT: no terminal module imports a fixture set", () => {
    for (const [name, src] of FILES) {
      assert.ok(!/from ["'].*sample["']|from ["'].*fixtures?["']/.test(src), `${name} imports fixtures`);
      assert.ok(!/samples\/agents-only-shell/.test(src), `${name} reaches into the sample`);
    }
  });

  it("INVARIANT: no fabrication table by name or by shape", () => {
    for (const [name, src] of FILES) {
      for (const banned of ["SAMPLE_OWNERS", "FACE_SEEDS", "SAMPLE_AGENTS", "AGENT_TAKE", "NAME_TAKE", "voiceOf"]) {
        assert.ok(!src.includes(banned), `${name} reintroduces ${banned}`);
      }
      // A record keyed by slug holding sentences is the same thing renamed.
      assert.ok(
        !/Record<string,\s*Record<string,\s*string>>/.test(src),
        `${name} declares a slug → symbol → sentence table`,
      );
    }
  });

  it("REGRESSION: no real production slug is hard-coded anywhere", () => {
    // The sample's fixtures were keyed on live slugs: sixteen lowercase
    // alphanumerics, always MIXING letters and digits ("tj9fr041atb68ec8").
    // The digit requirement is what keeps ordinary sixteen-letter identifiers
    // out of it — "visibilitychange" is not an agent.
    const SLUG = /["'](?=[a-z0-9]{16}["'])(?=[a-z0-9]*\d)[a-z0-9]{16}["']/g;
    for (const [name, src] of FILES) {
      const hits = [...src.matchAll(SLUG)].map((m) => m[0]);
      assert.deepEqual(hits, [], `${name} hard-codes what looks like an agent slug: ${hits.join(", ")}`);
    }
  });

  it("REGRESSION: no figure is derived from a hash", () => {
    // Two of the prototype's inventions were hash-driven: a dollar balance per
    // agent, and a strategy per slug. Both are stable, plausible and false,
    // which is the worst combination a number on this product can have.
    for (const [name, src] of FILES) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      // FNV-1a, the prototype's hash, by its two constants.
      assert.ok(!code.includes("16777619"), `${name} still hashes something`);
      assert.ok(!code.includes("2166136261"), `${name} still hashes something`);
    }
  });

  it("a public agent's strategy is reported as unpublished, not guessed", () => {
    // The wire carries no strategy for anyone but the owner, and "custom"
    // renders as "Its own rules" — a claim about an agent that may well be
    // running steady-basket.
    const live = FILES.find(([n]) => n === "live.ts")![1];
    assert.match(live, /known: false/, "the public glance must mark itself unknown");
    for (const screen of ["screens/Board.tsx", "screens/Profile.tsx", "Desktop.tsx"]) {
      const src = FILES.find(([n]) => n === screen)![1];
      assert.match(src, /known === false/, `${screen} must not print a rulebook nobody published`);
    }
  });
});
