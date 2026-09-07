/**
 * A SYMBOL FROM THIS ROUTE ENDS UP IN A SIGNED POLICY ALLOWLIST.
 *
 * That is what makes it different from every other place a coin's name is
 * rendered. `read-discoveries.ts` says of the index's label, verbatim: "the
 * index's own label, shown as a label and never used as identity: the worker
 * reads a symbol from the contract precisely because this string is
 * attacker-chosen and could impersonate a real ticker."
 *
 * Here it would not merely be shown. The owner reads it, decides on it, and
 * signs it into `grantTokens` — so this route reads `symbol()` from the token
 * itself, and refuses to propose a coin whose contract will not answer.
 *
 * The other half is the empty cases. "The scout picked nothing", "you have no
 * agent", "your grant already covers them all" and "we could not read the
 * store" are four different facts with four different remedies, and an empty
 * list renders identically for all of them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const RAW = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
/** Comments stripped — this file argues at length about what it refuses to do. */
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

describe("identity comes from the chain", () => {
  it("THE SYMBOL IS READ FROM THE CONTRACT, NEVER FROM THE INDEX", () => {
    assert.match(CODE, /functionName: "symbol"/);
    assert.match(CODE, /functionName: "decimals"/);
    // `row.name` may appear, but only as `indexLabel` — never as the symbol.
    assert.match(CODE, /indexLabel: row\.name/);
    assert.ok(!/symbol: row\.name/.test(CODE), "the index's label must never become identity");
  });

  it("and is sanitised to exactly what isValidCustomToken will accept", () => {
    // tokens.ts:127 is /^[A-Za-z0-9._-]{1,16}$/. A symbol that fails it either
    // bricks the grant or is silently dropped from the wall — wall.ts:285-302
    // says so: "a malformed entry either bricks the grant or silently widens it".
    assert.match(CODE, /replace\(\/\[\^A-Za-z0-9\._-\]\/g, ""\)\.slice\(0, 16\)/);
    assert.match(CODE, /decimals < 0 \|\| decimals > 36/);
  });

  it("AN UNREADABLE ERC-20 IS NOT PROPOSABLE — there is no fallback symbol", () => {
    // discovery.ts can name an unreadable token after its address because it is
    // only reporting. This value is about to be sealed into a permission, and a
    // made-up one would be a claim the chain never made.
    assert.match(CODE, /if \(!symbol \|\| !Number\.isInteger\(decimals\)/);
    assert.match(CODE, /if \(!id\) continue;/);
    assert.ok(!/token\.slice\(0, 10\)/.test(CODE), "no address-shaped stand-in symbol");
  });

  it("and an RPC failure is not cached as 'this token has no symbol'", () => {
    // The negative cache is set inside the try, on a definite answer. The catch
    // returns without writing one — an outage must not hide a coin for the life
    // of the process.
    const fn = CODE.slice(CODE.indexOf("async function identityOf("), CODE.indexOf("export interface Proposal"));
    const cat = fn.indexOf("} catch {");
    assert.ok(cat > 0);
    assert.ok(!/identity\.set/.test(fn.slice(cat)), "a failed read must not be remembered as a verdict");
  });
});

describe("it proposes, and decides nothing", () => {
  it("NOTHING HERE WRITES", () => {
    // The whole safety argument for showing this to an owner: reading it costs
    // them nothing and commits them to nothing.
    for (const write of ["\\.put\\(", "\\.set\\(tenant", "PUT", "POST", "writeFile"]) {
      assert.ok(
        !new RegExp(write).test(CODE.replace(/identity\.set\(/g, "")),
        `the proposal route must not ${write}`,
      );
    }
  });

  it("is per-caller and never cached", () => {
    // "Does your grant already cover this" is a question about one tenant.
    assert.match(CODE, /export const dynamic = "force-dynamic"/);
    assert.match(CODE, /"Cache-Control": "private, no-store"/);
    const tenantAt = CODE.indexOf("tenantOf(req)");
    const storeAt = CODE.indexOf("getGrantStore()");
    assert.ok(tenantAt > 0 && storeAt > tenantAt, "the session is read before any store");
  });

  it("only offers coins the scout actually vetted", () => {
    // A row with no verdict was passed over or never judged. Asking an owner to
    // re-sign their trading permission for a coin nothing has an opinion about
    // is worse than saying nothing.
    assert.match(CODE, /payload\.rows\.filter\(\(r\) => r\.verdict\)/);
  });

  it("and never proposes what the signature already covers", () => {
    assert.match(CODE, /grant\.grantTokens \?\? \[\]/);
    assert.match(CODE, /!covered\.has\(r\.token\.toLowerCase\(\)\)/);
  });
});

describe("four different nothings", () => {
  it("EACH EMPTY CASE HAS ITS OWN NAME", () => {
    // An empty list renders identically for all of them, and the remedies are
    // completely different: sign in, create an agent, wait, or try again.
    for (const why of ['"signed-out"', '"no-grant"', '"nothing-vetted"', '"all-covered"', '"unreadable"']) {
      assert.ok(CODE.includes(`answer(${why}`), `nothing produces ${why}`);
    }
  });

  it("an unreadable store is not an owner with no agent", () => {
    const at = CODE.indexOf("getGrantStore().get(tenant)");
    const around = CODE.slice(at, at + 260);
    assert.match(around, /catch \{[\s\S]*?return answer\("unreadable"\)/);
    assert.match(around, /if \(!grant\) return answer\("no-grant"\)/);
  });
});

describe("what the owner is told a re-sign actually does", () => {
  it("THE COVERED COUNT TRAVELS WITH THE PROPOSALS", () => {
    // Approving one coin re-seals the permission around the WHOLE customTokens
    // list — session.ts:403 mints grantTokens from all of it, with no per-token
    // opt-in at signing. An owner deciding on one coin is entitled to know that.
    assert.match(CODE, /covered: number;/);
    assert.match(CODE, /covered\.size/);
  });

  it("and whether this coin is already watched, which decides how much changes", () => {
    // In settings but not in the grant: a re-sign alone. In neither: the
    // settings write too. The sentence next to the button depends on which.
    assert.match(CODE, /watched: watched\.has\(row\.token\.toLowerCase\(\)\)/);
  });

  it("a curve coin says so, because a swap cannot route to it", () => {
    // No pool. The wall can cover the token and a swap still has nowhere to go —
    // TokenCards calls this out as two different noes, and the curve one first.
    assert.match(CODE, /onCurve: row\.onCurve/);
  });
});
