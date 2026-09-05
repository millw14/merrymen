/**
 * NOTHING THAT READS A DATABASE MAY BE BAKED INTO THE IMAGE.
 *
 * `export const revalidate = <n>` on an App-Router route or page reads like
 * "cache the response for n seconds at runtime". It is not. In Next 15 it is an
 * OPT-IN TO BUILD-TIME PRERENDERING: the handler runs once inside `docker
 * build`, its body is written to disk, and that body is what the first
 * requester after every deploy receives.
 *
 *   node_modules/next/dist/server/route-modules/app-route/helpers/
 *     is-static-gen-enabled.js
 *       revalidate !== undefined && revalidate > 0   -> prerender it
 *
 * There is no DATABASE_URL inside the image build. `withReadDb` therefore hands
 * the handler `null`, every reader returns `{ source: "none", … }` — which means
 * "the ledger could not be read", not "nobody said anything" — and that lie was
 * baked in and served. The home feed and the leaderboard were both empty for
 * the first visitor after every single deploy.
 *
 * This is a trap rather than a mistake: the directive is one word, it looks
 * like a performance tweak, and nothing about it says "runs at build time".
 * Which is exactly why it needs a test rather than a comment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const APP = path.join(process.cwd(), "web", "src", "app");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (entry === "route.ts" || entry === "page.tsx") out.push(p);
  }
  return out;
}

/** Everything that can reach the ledger, directly or through a reader. */
const READS_THE_LEDGER = /withReadDb|read-theses|read-leaderboard|read-wall-tape|read-agent|@\/lib\/ledger/;

describe("build-time prerendering never covers a database read", () => {
  const files = routeFiles(APP);

  it("finds the routes and pages, so a broken walk cannot pass vacuously", () => {
    assert.ok(files.length > 20, `expected the app tree, saw ${files.length} files`);
  });

  it("no DB-backed route or page opts into prerendering", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Comments stripped first: the files that explain this trap NAME the
      // directive, and a naive scan flags the very warning against it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (!READS_THE_LEDGER.test(code)) continue;
      const m = /export\s+const\s+revalidate\s*=\s*(\d[\d_]*)/.exec(code);
      if (m && Number(m[1]!.replace(/_/g, "")) > 0) {
        offenders.push(`${path.relative(APP, f)} (revalidate = ${m[1]})`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these read the ledger and would be prerendered at build, where there is no DATABASE_URL:\n  " +
        offenders.join("\n  "),
    );
  });

  it("the four surfaces this actually broke are dynamic", () => {
    // Named individually rather than only covered by the sweep above, because
    // these are the ones a real visitor hit: the home feed, the leaderboard
    // page, and the two public APIs behind them.
    for (const rel of [
      path.join("(app)", "page.tsx"),
      path.join("(app)", "leaderboard", "page.tsx"),
      path.join("api", "theses", "route.ts"),
      path.join("api", "leaderboard", "route.ts"),
    ]) {
      const code = readFileSync(path.join(APP, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert.match(code, /export\s+const\s+dynamic\s*=\s*"force-dynamic"/, `${rel} must be dynamic`);
    }
  });
});
