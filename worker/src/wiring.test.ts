/**
 * IS THE GUARD ACTUALLY REACHED?
 *
 * Three defects shipped into a review of this repo in one afternoon, all the
 * same shape: a correct function, a passing unit test, and no call site. The
 * unit tests could not catch any of them, because each one called the guard
 * directly and supplied the argument the production caller was failing to pass.
 *
 *   - `verifyGrantBinding` grew a version dispatch, and the grants route did
 *     not pass `version`. Every claim resolved to the default, so the
 *     unknown-version refusal and the privy-not-implemented refusal were both
 *     unreachable — a grant declaring `privy-did-owner-v1` would have been
 *     verified under LEGACY rules, which is exactly the downgrade the
 *     versioning exists to prevent. `binding-version.test.ts` passed, because
 *     it calls the validator itself.
 *   - `runIdentityAuditIfAsked` was defined and never called. The env var did
 *     nothing.
 *   - The phone signer kept deriving an account with no zero-address guard
 *     while the browser signer gained one.
 *
 * So these are WIRING tests. They assert that the dangerous argument is passed,
 * that a defined entry point is invoked, and that two signers that must refuse
 * the same things actually do. Source-reading, because none of it is observable
 * without a chain and a database.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the binding version reaches the validator", () => {
  it("the grants route passes `version` to verifyGrantBinding", () => {
    const src = read("web/src/app/api/grants/route.ts");
    const call = src.slice(src.indexOf("verifyGrantBinding({"));
    const args = call.slice(0, call.indexOf("});"));
    assert.match(
      args,
      /version:\s*binding\.version/,
      "without this the dispatch is unreachable and every claim resolves to the legacy default",
    );
  });

  it("the route does not decide the version itself", () => {
    // The one place that decides which security model applies is the
    // validator. A route that normalised, defaulted or filtered the version
    // would be making that decision in two places, which is how they drift.
    const src = read("web/src/app/api/grants/route.ts");
    assert.doesNotMatch(src, /binding\.version\s*(\?\?|\|\|)/, "the route must not default the version");
    assert.doesNotMatch(src, /isBindingVersion/, "the route must not validate the version itself");
  });
});

describe("every env-gated report the orchestrator defines is actually run", () => {
  /**
   * A `run…IfAsked` that is never called is an environment variable that does
   * nothing, and it fails silently by construction: the operator sets it, sees
   * no output, and concludes the fleet had nothing to say.
   */
  it("no orchestrator entry point is defined without a call site", () => {
    const src = read("worker/src/orchestrator.ts");
    const defined = [...src.matchAll(/^async function (run\w*IfAsked)\(/gm)].map((m) => m[1]!);
    assert.ok(defined.length >= 3, `expected several env-gated reports, found ${defined.length}`);
    const orphans = defined.filter((name) => {
      // A call site is any occurrence that is not the definition itself.
      const uses = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
      return uses < 2;
    });
    assert.deepEqual(orphans, [], `defined but never called: ${orphans.join(", ")}`);
  });
});

describe("the identity audit observes and does not repair", () => {
  /**
   * observe -> understand -> decide -> migrate -> constrain.
   *
   * The failure this forbids is a bootstrap routine that sees bad state and
   * quietly normalises it: the collision disappears, the constraint applies,
   * and nobody ever learns which of two people owned the agent. So the audit
   * reads and prints, and that is all it is allowed to do.
   */
  const auditBody = () => {
    const src = read("worker/src/orchestrator.ts");
    const start = src.indexOf("async function runIdentityAuditIfAsked");
    assert.ok(start > 0, "the audit runner must exist");
    const rest = src.slice(start + 10);
    const next = rest.search(/^async function /m);
    return next < 0 ? src.slice(start) : src.slice(start, start + 10 + next);
  };

  it("issues no statement that can write", () => {
    const body = auditBody();
    for (const verb of ["INSERT", "UPDATE", "DELETE", "CREATE ", "ALTER", "DROP", "TRUNCATE", "COPY "]) {
      assert.ok(!body.includes(verb), `the audit must not ${verb.trim()}`);
    }
    assert.ok(!/\.exec\(/.test(body), "exec() is the write path on this db wrapper");
  });

  it("goes to the database directly rather than through a store that bootstraps DDL", () => {
    // getIdentityStore() would run CREATE TABLE / CREATE UNIQUE INDEX in its
    // lazy constructor — which is exactly the migration this audit exists to
    // decide about, and it would run it before anyone had read the result.
    const body = auditBody();
    assert.ok(!body.includes("getIdentityStore"), "the audit must not open the store it is auditing");
    assert.ok(body.includes("makePgDb("), "it reads with a plain connection");
  });

  it("prints no raw identity material", () => {
    // Tenant addresses are already in every orchestrator log line. A Privy DID
    // is not, and printing one beside a tenant joins a social login to an
    // on-chain identity for anyone who can read the fleet's logs.
    const audit = read("worker/src/identity-audit.ts");
    assert.match(audit, /report\("privy did", dids, true\)/, "DIDs must be fingerprinted");
    assert.match(audit, /report\("provider\+subject", subjects, true\)/, "subjects must be fingerprinted");
    assert.match(audit, /function fingerprint\(/);
  });

  it("does not share a pass with the reports that would drown it", () => {
    // Two production runs lost the audit entirely: its lines sat at the tail of
    // the same burst as the shadow dataset's several hundred, and the log store
    // dropped them. Nothing errored. A report whose absence is indistinguishable
    // from a clean fleet is worse than no report at all.
    const src = read("worker/src/orchestrator.ts");
    assert.match(src, /IDENTITY_AUDIT_AFTER_PASSES/, "the audit needs a pass of its own");
    const auditPass = Number(/const IDENTITY_AUDIT_AFTER_PASSES = (\d+);/.exec(src)?.[1]);
    const cohortPass = Number(/const COHORT_VET_AFTER_PASSES = (\d+);/.exec(src)?.[1]);
    assert.ok(Number.isFinite(auditPass) && Number.isFinite(cohortPass));
    assert.notEqual(auditPass, cohortPass, "the audit must not run in the reports' pass");
    assert.ok(auditPass < cohortPass, "and it should run first, while the stream is quiet");
  });

  it("reports every census the rollout decision depends on", () => {
    const audit = read("worker/src/identity-audit.ts");
    for (const census of [
      "current account",
      "account history",
      "privy did",
      "provider+subject",
      "installed grants",
      "zero-address residue",
      "owner is tenant",
      "empty identity keys",
      "binding versions",
    ]) {
      assert.ok(audit.includes(`"${census}"`), `the audit must report: ${census}`);
    }
  });
});


describe("an escape that collapsed into a control character", () => {
  /**
   * THE SAME ACCIDENT, THREE TIMES IN THIS REPO.
   *
   * A word-boundary escape written through one escaping layer too few becomes
   * the literal byte it names. The source still LOOKS right in an editor, the
   * regex compiles, and it quietly requires a control character beside the word
   * — so it matches nothing. web/src/lib/status-line.test.ts lost five of its
   * eight banned words that way, and its own comment records that the same
   * thing had already happened to it once before. worker/src/revert.ts carries
   * a comment ABOUT the trap that fell into it.
   *
   * No source file has a legitimate reason to contain a raw control byte, so
   * this is a cheap permanent guard over the whole tree.
   */
  /**
   * Files that contain a control byte ON PURPOSE, each with the reason.
   *
   * Shrink-only, like mounted.test.ts KNOWN_DEBT: an entry here is a claim that
   * the byte is test DATA rather than a collapsed escape, and it has to be true.
   */
  const DELIBERATE: Record<string, string> = {
    // A prompt-injection fixture whose whole point is that the nasty string
    // carries a real control character, plus a character-class range written
    // with literal bytes. Both are input to a sanitiser, not escapes that lost
    // a backslash.
    "worker/src/venues/pons-meta.test.ts": "control bytes are the injection fixture",
  };

  it("no source file contains a raw control character", () => {
    const roots = ["web/src", "worker/src", "packages/core/src", "mobile/src"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/.tsx?$/.test(e.name)) {
          const src = read(rel);
          // Tab, newline and carriage return are the only ones that belong.
          const bad = [...src].filter((ch) => {
            const c = ch.charCodeAt(0);
            return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f;
          });
          if (bad.length && !(rel in DELIBERATE)) {
            offenders.push(`${rel} (${bad.map((b) => `0x${b.charCodeAt(0).toString(16)}`).join(", ")})`);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    assert.deepEqual(offenders, [], `a collapsed escape leaves a control byte: ${offenders.join("; ")}`);
  });
});


describe("a NEXT_PUBLIC_ variable reaches the build that inlines it", () => {
  /**
   * NEXT_PUBLIC_* IS SUBSTITUTED DURING `next build`, NOT READ AT RUNTIME.
   *
   * A variable set on the Railway service arrives at runtime, which is too
   * late: the browser bundle has already been written with an empty string.
   * The feature it gates is simply off, the deploy is green, and nothing in
   * any log mentions it. The Privy login shipped exactly that way.
   *
   * Railway exposes service variables to a Dockerfile build only where an ARG
   * declares them, so every NEXT_PUBLIC_ name the code reads must appear as an
   * ARG before `npm run build`.
   */
  it("every NEXT_PUBLIC_ the web app reads is declared as a build ARG", () => {
    const wanted = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/.tsx?$/.test(e.name) && !/.test.tsx?$/.test(e.name)) {
          for (const m of read(rel).matchAll(/process.env.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) wanted.add(m[1]!);
        }
      }
    };
    walk("web/src");
    const docker = read("Dockerfile");
    const buildStage = docker.slice(0, docker.indexOf("RUN npm run build"));
    // A plain substring, deliberately. The obvious spelling here is a RegExp
    // with a word boundary — and `\b` inside a template literal is the
    // BACKSPACE escape, not a word boundary, so that version silently matches
    // nothing. This suite already guards the tree against that collapse; it
    // happened once more while writing this very line.
    const missing = [...wanted].filter((v) => !buildStage.includes(`ARG ${v}`));
    assert.deepEqual(
      missing,
      [],
      `these are read in the browser bundle but never reach the build, so they inline as "": ${missing.join(", ")}`,
    );
  });

  it("no ARG in the build stage carries a secret", () => {
    // An ARG is baked into the image layer and readable by anyone who can pull
    // it. Only genuinely public values may be declared here.
    const docker = read("Dockerfile");
    const buildStage = docker.slice(0, docker.indexOf("RUN npm run build"));
    const args = [...buildStage.matchAll(/^ARG ([A-Z0-9_]+)/gm)].map((m) => m[1]!);
    const secretish = args.filter((a) => !a.startsWith("NEXT_PUBLIC_"));
    assert.deepEqual(secretish, [], `build args must be public by construction: ${secretish.join(", ")}`);
  });
});

describe("the two signers refuse the same things", () => {
  /**
   * The phone and the dashboard seal the SAME wall — worker/src/wall.test.ts
   * and signer-lockstep.test.ts exist for that reason. A guard added to one and
   * not the other means the two disagree about what a signature may carry, and
   * the disagreement is invisible until a phone seals something the browser
   * would have refused.
   */
  const web = () => read("web/src/lib/session.ts");
  const phone = () => read("mobile/src/crypto/signGrant.ts");

  it("both assert the sudo-only account before the wall is pinned to it", () => {
    for (const [what, src] of [["web", web()], ["phone", phone()]] as const) {
      const guard = src.indexOf('assertDerivedAccount(sudoOnlyAccount.address');
      const wall = src.indexOf("buildWallPolicies({");
      assert.ok(guard > 0, `${what} does not assert the sudo-only derivation`);
      assert.ok(wall > guard, `${what} pins the wall before asserting the address it pins to`);
    }
  });

  it("both assert the permissioned account before the equality that two zeros satisfy", () => {
    for (const [what, src] of [["web", web()], ["phone", phone()]] as const) {
      const guard = src.indexOf("assertDerivedAccount(account.address");
      const equality = src.indexOf("account.address.toLowerCase() !== sudoOnlyAccount.address.toLowerCase()");
      assert.ok(guard > 0, `${what} does not assert the permissioned derivation`);
      assert.ok(equality > guard, `${what} compares two possibly-zero addresses before asserting them`);
    }
  });
});
