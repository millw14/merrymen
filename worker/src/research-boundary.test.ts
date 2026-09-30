/**
 * BRAIN DOES NOT KNOW WHO SELLS US THE NEWS, AND NEITHER DOES A CHILD.
 *
 * Two boundaries, pinned here because both are invisible at the call site and
 * both are the kind that stay intact right up until somebody adds one
 * reasonable-looking import.
 *
 * THE VENDOR BOUNDARY. Everything above the adapter speaks `NewsItem` and
 * `NewsSentiment`. The reason is not tidiness: the first vendor is never the
 * last, and a name that has leaked into the desk, the prompt, the schema or a
 * persisted decision is a name that cannot be replaced without a migration.
 * The adapter is also where sanitisation happens, so a second vendor added
 * later cannot forget to do it — the normaliser is the only route in.
 *
 * THE CREDENTIAL BOUNDARY. The orchestrator fetches; children do not. That is
 * what makes "the Brain service never sees the news token" a property of the
 * process boundary rather than a claim about anybody's carefulness — a child
 * that never holds the value cannot put it in a prompt, a log line, a decision
 * row or a published thesis.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(WORKER_SRC, "..", "..");

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

/** The vendor's name, in the two spellings that could appear. */
const VENDOR = /marketaux/i;

describe("the Brain service does not know the vendor exists", () => {
  it("no file under services/brain names it", () => {
    const files = walk(path.join(REPO, "services", "brain"), (f) =>
      /\.(py|md|toml|txt|json|yaml|yml)$/.test(f),
    );
    assert.ok(files.length > 10, "the walk found the service at all");
    const guilty = files.filter((f) => VENDOR.test(readFileSync(f, "utf8")));
    assert.deepEqual(guilty.map((f) => path.relative(REPO, f)), []);
  });

  it("nor does the vendor-neutral schema the rest of the worker speaks", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "news.ts"), "utf8");
    assert.ok(!VENDOR.test(src), "news.ts must stay the shape, not the source");
  });

  it("only the adapter, its scheduler and their tests name it at all", () => {
    const allowed = new Set([
      "worker/src/research/marketaux.ts",
      "worker/src/research/marketaux.test.ts",
      "worker/src/research-pass.ts",
      "worker/src/research-pass.test.ts",
      "worker/src/research-boundary.test.ts",
      // The orchestrator reads the env var, which carries the name. It is the
      // one process that is allowed to know, because it is the one that pays.
      "worker/src/orchestrator.ts",
      "worker/src/orchestrator.test.ts",
    ]);
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const guilty = files
      .filter((f) => VENDOR.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((f) => !allowed.has(f));
    assert.deepEqual(guilty, [], "the vendor's name leaked out of the adapter");
  });

  it("and the child never imports the adapter", () => {
    // A child holds no token, so a child calling the adapter would produce a
    // `no-key` refusal per tick and a fetch attempt per agent. Both are wrong;
    // the import is what would make either possible.
    const src = readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8");
    assert.ok(!/from "\.\/research\/marketaux"/.test(src));
    assert.ok(!/from "\.\/research-pass"/.test(src));
  });
});

describe("the news token cannot reach a child", () => {
  it("CHILD_SECRET_STRIP removes it", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    for (const key of [
      "MERRYMEN_STORE_DEK",
      "MERRYMEN_SESSION_SECRET",
      "DATABASE_URL",
      "MERRYMEN_MARKETAUX_API_KEY",
    ]) {
      assert.ok(block.includes(key), key + " is not stripped from a child's environment");
    }
  });

  it("and only the orchestrator ever reads it", () => {
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const readers = files
      .filter((f) => readFileSync(f, "utf8").includes("MERRYMEN_MARKETAUX_API_KEY"))
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(readers, ["orchestrator.ts", "research-boundary.test.ts"]);
  });

  it("the adapter takes the key as an argument and never from the environment", () => {
    // The difference matters: a module that reaches into process.env works
    // wherever it is imported, including inside a child that was never meant to
    // have it. A parameter cannot be supplied by a process that does not hold it.
    const src = readFileSync(path.join(WORKER_SRC, "research", "marketaux.ts"), "utf8");
    assert.ok(!/process\.env/.test(src), "the adapter must not read the environment");
  });
});

/**
 * THE SAME TWO BOUNDARIES, HELD AGAINST THE SECOND VENDOR.
 *
 * The builder directory arrived after the news vendor and is a different kind
 * of supplier — free at the anonymous tier, keyed on a contract, no daily
 * allowance to ration. None of that changes either boundary, and the point of
 * restating them here rather than generalising the block above is that a
 * generalised test is one somebody can satisfy by adding a name to a list. A
 * second vendor with its own section has to be argued for twice.
 */
const DIRECTORY = /hey ?research|heyresearch/i;

describe("the Brain service does not know the builder directory exists", () => {
  it("no file under services/brain names it", () => {
    const files = walk(path.join(REPO, "services", "brain"), (f) =>
      /\.(py|md|toml|txt|json|yaml|yml)$/.test(f),
    );
    assert.ok(files.length > 10, "the walk found the service at all");
    const guilty = files.filter((f) => DIRECTORY.test(readFileSync(f, "utf8")));
    assert.deepEqual(guilty.map((f) => path.relative(REPO, f)), []);
  });

  it("nor does the vendor-neutral schema the rest of the worker speaks", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "builder.ts"), "utf8");
    assert.ok(!DIRECTORY.test(src), "builder.ts must stay the shape, not the source");
  });

  it("nor does the renderer that turns a record into a lens", () => {
    // The renderer is where the name would be most tempting and most damaging:
    // a block that says the directory's brand is a block that pins the prompt,
    // the persisted decision and every published thesis to one supplier.
    const src = readFileSync(path.join(WORKER_SRC, "research", "coin-builder.ts"), "utf8");
    assert.ok(!DIRECTORY.test(src), "the analyst is told a directory said it, never which one");
  });

  it("only the adapter and its own test name it at all", () => {
    const allowed = new Set([
      "worker/src/research/hey.ts",
      "worker/src/research/hey.test.ts",
      "worker/src/research-boundary.test.ts",
    ]);
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const guilty = files
      .filter((f) => DIRECTORY.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((f) => !allowed.has(f));
    assert.deepEqual(guilty, [], "the directory's name leaked out of the adapter");
  });
});

describe("the builder directory token cannot reach a child", () => {
  it("CHILD_SECRET_STRIP removes it", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    assert.ok(block.includes("MERRYMEN_HEY_API_KEY"), "the directory token is not stripped");
  });

  it("and nothing but the orchestrator may ever read it", () => {
    // Asserted BEFORE there is a reader, which is the useful moment: the first
    // caller to be written is the one that decides whether this boundary was a
    // design or a hope, and it will fail this test if it is a child.
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const readers = files
      .filter((f) => readFileSync(f, "utf8").includes("MERRYMEN_HEY_API_KEY"))
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(readers, ["orchestrator.ts", "research-boundary.test.ts"]);
  });

  it("the adapter takes the key as an argument and never from the environment", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "hey.ts"), "utf8");
    assert.ok(!/process\.env/.test(src), "the adapter must not read the environment");
  });
});

/**
 * ONE WRITER, AND THE ORDER THAT MAKES IT WORK.
 *
 * Two desks now ride research.json. They refresh on different clocks and are
 * materialised in one atomic rename, which is the only arrangement where a
 * child cannot observe a news window from one pass beside builder records from
 * another. The arrangement is invisible at both call sites — nothing in
 * `runBuilderPass` says "and somebody else will write this" except its own
 * comment — so it is pinned here instead of trusted.
 */
describe("research.json has exactly one writer, and the passes run in the order that needs", () => {
  const orchestrator = () => readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");

  it("only one place writes the file", () => {
    const calls = orchestrator().match(/writeResearchForChild\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      "a second writer would let two passes take turns clobbering each other's half",
    );
  });

  it("the builder desk refreshes BEFORE the pass that writes", () => {
    const src = orchestrator();
    const builder = src.indexOf("await runBuilderPass();");
    const news = src.indexOf("await runNewsPass();");
    assert.ok(builder > 0 && news > 0, "both passes are called");
    assert.ok(
      builder < news,
      "the builder pass writes nothing; reversing these publishes last pass's records",
    );
  });

  it("and the builder pass itself writes no file", () => {
    const src = orchestrator();
    const start = src.indexOf("async function runBuilderPass()");
    assert.ok(start > 0);
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.ok(!/writeResearchForChild/.test(body));
  });
});

describe("the child does the builder lookup nowhere", () => {
  it("it never imports the adapter or its scheduler", () => {
    // A child holds no directory token — and unlike the news vendor, this one
    // would still ANSWER without it. That is exactly what makes the import
    // dangerous rather than merely useless: a child that called the adapter
    // would quietly work, one HTTP request per agent per tick, on the trading
    // path, and nothing would fail to reveal it.
    const src = readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8");
    assert.ok(!/from "\.\/research\/hey"/.test(src));
    assert.ok(!/from "\.\/builder-pass"/.test(src));
  });

  it("the lens it does import is the pure renderer", () => {
    const src = readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8");
    assert.match(src, /from "\.\/research\/coin-builder"/);
    const renderer = readFileSync(path.join(WORKER_SRC, "research", "coin-builder.ts"), "utf8");
    assert.ok(!/fetch\(|readBoundedJson/.test(renderer), "the renderer reaches nothing");
  });
});

/**
 * THE DESK MUST ASK ABOUT EVERY CANDIDATE THE AGENT REASONS ABOUT.
 *
 * `coinAddressesFor` reads the child's `discovered_pools`; `proposeClassEntries`
 * reads the same table through `recentCandidates(CLASS_WINDOW_SEC, CLASS_LIMIT)`.
 * The first version of the orchestrator's query used a bare `LIMIT 25` with no
 * time bound, against an agent looking at the newest 40 inside six hours — so
 * the fifteen oldest candidates of every tick were never looked up.
 *
 * THAT SHORTFALL IS INVISIBLE AT RUNTIME, which is why it is pinned here rather
 * than left to review. A contract nobody asked about and a contract with no page
 * both produce no record, no block and NO DATA AVAILABLE; nothing errors, and
 * the only symptom is a lens that quietly has less to say than it should.
 *
 * The constants cannot be imported — they live in another process and
 * `CLASS_LIMIT` is a function-local — so the numbers are copied and this test is
 * what keeps the copies honest.
 */
describe("the builder desk's candidate window matches the agent's", () => {
  const numberFrom = (src: string, re: RegExp, what: string): number => {
    const m = src.match(re);
    assert.ok(m, `could not find ${what} — the test must be updated with the code`);
    // eslint-disable-next-line no-eval
    const value = Function(`"use strict";return (${m![1]})`)() as number;
    assert.ok(Number.isFinite(value), `${what} did not evaluate to a number`);
    return value;
  };

  it("the same six-hour window", () => {
    const agent = numberFrom(
      readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8"),
      /const CLASS_WINDOW_SEC = ([^;]+);/,
      "CLASS_WINDOW_SEC in index.ts",
    );
    const desk = numberFrom(
      readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8"),
      /const CLASS_CANDIDATE_WINDOW_SEC = ([^;]+);/,
      "CLASS_CANDIDATE_WINDOW_SEC in orchestrator.ts",
    );
    assert.equal(desk, agent, "the desk must not look at a different span of time");
  });

  it("and the same ceiling", () => {
    const agent = numberFrom(
      readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8"),
      /const CLASS_LIMIT = ([^;]+);/,
      "CLASS_LIMIT in index.ts",
    );
    const desk = numberFrom(
      readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8"),
      /const CLASS_CANDIDATE_LIMIT = ([^;]+);/,
      "CLASS_CANDIDATE_LIMIT in orchestrator.ts",
    );
    assert.equal(
      desk,
      agent,
      "a desk that looks up fewer candidates than the agent evaluates is a silent gap",
    );
  });

  it("and the query actually uses them rather than a literal", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const start = src.indexOf("async function coinAddressesFor");
    assert.ok(start > 0);
    const body = src.slice(start, src.indexOf("\n}", start));
    const query = body.slice(body.indexOf("FROM discovered_pools"));
    assert.match(query, /CLASS_CANDIDATE_WINDOW_SEC/, "the window must be the shared constant");
    assert.match(query, /CLASS_CANDIDATE_LIMIT/, "so must the ceiling");
  });
});
