/**
 * THE DEPLOY GUARD, phase by phase, as tables — then the real guard through
 * the real container start script.
 *
 * What these hold:
 *   - Off Railway both phases are a no-op that says so; ON Railway is read
 *     from any one of the deployment identity variables, never from a CLI
 *     token in somebody's shell.
 *   - Pre-deploy, in production only: main, a 40-hex commit, and — when asked
 *     — a compare-API proof that fails closed on every answer but "on main".
 *   - Start, web: the allowlist and nothing else. Start, fleet roles: the
 *     fleet's own service, a persistent home, this image; and the orchestrator
 *     refused while a one-shot variable is set before the rollout reads `all`.
 *   - The census prints names and never a value, counts every orchestrator
 *     `run…IfAsked` gate, and leaves standing configuration alone.
 *   - No refusal echoes what it refused.
 *   - The command line runs the checks however it is named — a symlinked
 *     path, no extension — and nothing imports it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DEPLOY_GUARD_IMAGE, EX_CONFIG, EX_USAGE, hostedPersistentHomeRefusal, isOneShotVariable, oneShotCensus,
  onRailway, runDeployGuard, START_ROLES, type GuardResult,
} from "./deploy-guard-checks";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const posix = process.platform !== "win32";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SERVICE = "227ff49a-1111-4222-8333-444455556666";
const OTHER_SERVICE = "b72f7ad9-1111-4222-8333-444455556666";

/** What Railway injects into a production deployment of the fleet service. */
const RAILWAY: NodeJS.ProcessEnv = {
  RAILWAY_PROJECT_ID: "f00dfeed-1111-4222-8333-444455556666",
  RAILWAY_ENVIRONMENT_ID: "e1e1e1e1-1111-4222-8333-444455556666",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_SERVICE_ID: SERVICE,
  RAILWAY_DEPLOYMENT_ID: "d0d0d0d0-1111-4222-8333-444455556666",
  RAILWAY_REPLICA_ID: "c0c0c0c0-1111-4222-8333-444455556666",
};
/** …plus what the operator sets on that service, correctly. */
const FLEET: NodeJS.ProcessEnv = {
  ...RAILWAY, MERRYMEN_FLEET_SERVICE_ID: SERVICE, MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_IMAGE: DEPLOY_GUARD_IMAGE,
};
const without = (env: NodeJS.ProcessEnv, ...keys: string[]) => Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));
const all = (r: GuardResult) => [...r.out, ...r.err].join("\n");

describe("on Railway or not", () => {
  it("any one deployment identity variable is enough; tokens, git and volume variables are not", () => {
    for (const key of Object.keys(RAILWAY)) assert.equal(onRailway({ [key]: "x" }), true, key);
    assert.equal(onRailway({ RAILWAY_ENVIRONMENT: "production" }), true);
    for (const key of ["RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_GIT_BRANCH", "RAILWAY_VOLUME_MOUNT_PATH", "MERRYMEN_HOSTED"]) {
      assert.equal(onRailway({ [key]: "x" }), false, key);
    }
    assert.equal(onRailway({ RAILWAY_SERVICE_ID: "" }), false, "an empty identity is no identity");
    assert.equal(onRailway({}), false);
  });
});

describe("--phase=start", () => {
  const start = (role: string, env: NodeJS.ProcessEnv) => runDeployGuard(["--phase=start", `--role=${role}`], env);
  const cases: { name: string; role: string; env: NodeJS.ProcessEnv; code: number; err?: RegExp[]; out?: RegExp }[] = [
    // Off Railway: nothing to be wrong about, whatever else is set.
    { name: "off Railway, a misconfigured orchestrator is skipped", role: "start:orchestrator", env: { MERRYMEN_REPAIR_HWM: "apply" }, code: 0, out: /^\[deploy-guard\] skipped: not running on Railway$/m },
    { name: "off Railway, the listener is skipped", role: "start:recovery-replies", env: {}, code: 0, out: /skipped: not running on Railway/ },
    { name: "off Railway, web is skipped", role: "start:web", env: {}, code: 0, out: /skipped: not running on Railway/ },
    // Web on Railway: the allowlist only — none of the fleet's requirements.
    { name: "web on Railway with none of the fleet's variables", role: "start:web", env: { ...RAILWAY, MERRYMEN_REPAIR_HWM: "apply" }, code: 0, out: /^\[deploy-guard\] ok role=start:web$/m },
    // The fleet roles, correctly configured.
    { name: "the orchestrator on its service", role: "start:orchestrator", env: FLEET, code: 0, out: /census one-shot: none\n\[deploy-guard\] ok role=start:orchestrator$/ },
    { name: "the listener on its service", role: "start:recovery-replies", env: FLEET, code: 0, out: /census one-shot: none\n\[deploy-guard\] ok role=start:recovery-replies$/ },
    { name: "the listener with one-shots set: printed, not refused", role: "start:recovery-replies", env: { ...FLEET, MERRYMEN_REPAIR_HWM: "apply" }, code: 0, out: /census one-shot: MERRYMEN_REPAIR_HWM\n.*ok role=start:recovery-replies$/ },
    { name: "the orchestrator with one-shots once the rollout is all", role: "start:orchestrator", env: { ...FLEET, MERRYMEN_REPAIR_HWM: "apply", MERRYMEN_FLEET_ROLLOUT: "all" }, code: 0, out: /census one-shot: MERRYMEN_REPAIR_HWM\n.*ok role=start:orchestrator$/ },
    // The service.
    { name: "no MERRYMEN_FLEET_SERVICE_ID", role: "start:orchestrator", env: without(FLEET, "MERRYMEN_FLEET_SERVICE_ID"), code: EX_CONFIG, err: [/MERRYMEN_FLEET_SERVICE_ID is not set/] },
    { name: "an empty MERRYMEN_FLEET_SERVICE_ID", role: "start:recovery-replies", env: { ...FLEET, MERRYMEN_FLEET_SERVICE_ID: "" }, code: EX_CONFIG, err: [/MERRYMEN_FLEET_SERVICE_ID is not set/] },
    { name: "the orchestrator on another service", role: "start:orchestrator", env: { ...FLEET, RAILWAY_SERVICE_ID: OTHER_SERVICE }, code: EX_CONFIG, err: [/this is not the fleet's service/] },
    { name: "the listener on another service", role: "start:recovery-replies", env: { ...FLEET, RAILWAY_SERVICE_ID: OTHER_SERVICE }, code: EX_CONFIG, err: [/this is not the fleet's service/] },
    { name: "no RAILWAY_SERVICE_ID at all", role: "start:orchestrator", env: without(FLEET, "RAILWAY_SERVICE_ID"), code: EX_CONFIG, err: [/this is not the fleet's service/] },
    { name: "a service id that differs only in case", role: "start:orchestrator", env: { ...FLEET, MERRYMEN_FLEET_SERVICE_ID: SERVICE.toUpperCase() }, code: EX_CONFIG, err: [/this is not the fleet's service/] },
    // The persistent home: exactly "1".
    ...[undefined, "", "0", "true", " 1", "1 "].map((value) => ({
      name: `MERRYMEN_PERSISTENT_HOME_REQUIRED=${JSON.stringify(value)}`, role: "start:recovery-replies",
      env: value === undefined ? without(FLEET, "MERRYMEN_PERSISTENT_HOME_REQUIRED") : { ...FLEET, MERRYMEN_PERSISTENT_HOME_REQUIRED: value },
      code: EX_CONFIG, err: [/MERRYMEN_PERSISTENT_HOME_REQUIRED is not 1/],
    })),
    // The image.
    { name: "an image without the start-path marker", role: "start:orchestrator", env: without(FLEET, "MERRYMEN_IMAGE"), code: EX_CONFIG, err: [/MERRYMEN_IMAGE is not dockerfile-v1/] },
    { name: "another image", role: "start:orchestrator", env: { ...FLEET, MERRYMEN_IMAGE: "nixpacks" }, code: EX_CONFIG, err: [/MERRYMEN_IMAGE is not dockerfile-v1/] },
    // The rollout: exactly "all", or no one-shots.
    ...[undefined, "", "none", "ALL", " all", "all ", `0x${"ab".repeat(20)}:trade`].map((rollout) => ({
      name: `one-shots with MERRYMEN_FLEET_ROLLOUT=${JSON.stringify(rollout)}`, role: "start:orchestrator",
      env: { ...FLEET, MERRYMEN_GAS_AUDIT: "all", ...(rollout === undefined ? {} : { MERRYMEN_FLEET_ROLLOUT: rollout }) },
      code: EX_CONFIG, err: [/one-shot operator variables are set .* while MERRYMEN_FLEET_ROLLOUT is not all/],
    })),
    { name: "a blanked one-shot still counts", role: "start:orchestrator", env: { ...FLEET, MERRYMEN_REPAIR: "" }, code: EX_CONFIG, err: [/one-shot operator variables are set/] },
    // Everything wrong at once: every reason, so one redeploy fixes them all.
    { name: "everything wrong at once", role: "start:orchestrator", env: { ...RAILWAY, MERRYMEN_INSPECT_TENANT: "0xabc" }, code: EX_CONFIG,
      err: [/MERRYMEN_FLEET_SERVICE_ID is not set/, /MERRYMEN_PERSISTENT_HOME_REQUIRED is not 1/, /MERRYMEN_IMAGE is not/, /one-shot operator variables are set/] },
  ];
  for (const c of cases) {
    it(`${c.role}: ${c.name}`, async () => {
      const r = await start(c.role, c.env);
      assert.equal(r.code, c.code, all(r));
      if (c.out) assert.match(r.out.join("\n"), c.out);
      if (c.code === 0) assert.deepEqual(r.err, []);
      else {
        assert.equal(r.err.length, c.err!.length, r.err.join("\n"));
        c.err!.forEach((pattern, i) => assert.match(r.err[i]!, new RegExp(`^\\[deploy-guard\\] refused: ${pattern.source}`)));
        assert.doesNotMatch(r.out.join("\n"), /\bok\b/, "a refusal must not also print ok");
      }
    });
  }

  it("a refused fleet role still prints the census first, naming what to delete", async () => {
    const r = await start("start:orchestrator", { ...FLEET, MERRYMEN_REPAIR_HWM: "apply", MERRYMEN_ANNOUNCE_ID: "x" });
    assert.equal(r.code, EX_CONFIG);
    assert.deepEqual(r.out, ["[deploy-guard] census one-shot: MERRYMEN_ANNOUNCE_ID MERRYMEN_REPAIR_HWM"]);
  });

  it("an unknown role is a usage error on or off Railway, and is not echoed", async () => {
    for (const env of [{}, FLEET]) {
      for (const role of ["start:evil", "dev:worker", "start:web ", "", "$(id)"]) {
        const r = await start(role, env);
        assert.equal(r.code, EX_USAGE, role);
        assert.deepEqual(r.err, ["[deploy-guard] refused: --role is not one of: start:web start:orchestrator start:recovery-replies"]);
        assert.deepEqual(r.out, []);
      }
    }
  });
});

describe("--phase=predeploy", () => {
  const PROD = { ...RAILWAY, RAILWAY_GIT_BRANCH: "main", RAILWAY_GIT_COMMIT_SHA: SHA };
  const predeploy = (env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) => runDeployGuard(["--phase=predeploy"], env, { fetch: fetchImpl });
  const noFetch = (() => { throw new Error("the guard asked GitHub without being configured to"); }) as unknown as typeof fetch;

  it("off Railway it is skipped", async () => {
    const r = await predeploy({ RAILWAY_GIT_BRANCH: "feature" }, noFetch);
    assert.deepEqual(r, { code: 0, out: ["[deploy-guard] skipped: not running on Railway"], err: [] });
  });

  it("outside production it is skipped; an unnamed environment is production", async () => {
    for (const name of ["staging", "pr-261"]) {
      const r = await predeploy({ ...RAILWAY, RAILWAY_ENVIRONMENT_NAME: name, RAILWAY_GIT_BRANCH: "feature" }, noFetch);
      assert.deepEqual(r, { code: 0, out: ["[deploy-guard] skipped: the pre-deploy checks apply to the production environment only"], err: [] }, name);
    }
    for (const name of ["production", "Production", " production ", "", " "]) {
      assert.equal((await predeploy({ ...RAILWAY, RAILWAY_ENVIRONMENT_NAME: name, RAILWAY_GIT_BRANCH: "feature", RAILWAY_GIT_COMMIT_SHA: SHA }, noFetch)).code, EX_CONFIG, name);
    }
    // Neither name variable: still on Railway (by its ids), so production.
    const r = await predeploy({ RAILWAY_SERVICE_ID: SERVICE, RAILWAY_GIT_BRANCH: "feature", RAILWAY_GIT_COMMIT_SHA: SHA }, noFetch);
    assert.equal(r.code, EX_CONFIG);
    // The legacy name alone decides when it is the only one.
    assert.equal((await predeploy({ RAILWAY_SERVICE_ID: SERVICE, RAILWAY_ENVIRONMENT: "staging" }, noFetch)).code, 0);
  });

  it("main at a 40-hex commit passes, and says which", async () => {
    assert.deepEqual(await predeploy(PROD, noFetch), { code: 0, out: [`[deploy-guard] ok branch=main commit=${SHA}`], err: [] });
    // Railway reports lower case; upper case is the same commit, logged lower.
    assert.deepEqual((await predeploy({ ...PROD, RAILWAY_GIT_COMMIT_SHA: SHA.toUpperCase() }, noFetch)).out, [`[deploy-guard] ok branch=main commit=${SHA}`]);
  });

  it("any other branch is refused, and not echoed", async () => {
    for (const branch of [undefined, "", "codex/recovery-casual-replies", "Main", "main ", " main", "refs/heads/main", "main\n[deploy-guard] ok"]) {
      const env = branch === undefined ? without(PROD, "RAILWAY_GIT_BRANCH") : { ...PROD, RAILWAY_GIT_BRANCH: branch };
      const r = await predeploy(env, noFetch);
      assert.equal(r.code, EX_CONFIG, JSON.stringify(branch));
      assert.deepEqual(r.out, []);
      assert.deepEqual(r.err, ["[deploy-guard] refused: production deploys only from main, and RAILWAY_GIT_BRANCH is not main — deploy main, or merge first"]);
    }
  });

  it("a deploy without a full hex commit is refused, and not echoed", async () => {
    for (const sha of [undefined, "", SHA.slice(0, 12), `${SHA}0`, `${SHA.slice(0, 39)}g`, ` ${SHA}`, `${SHA}\n`]) {
      const env = sha === undefined ? without(PROD, "RAILWAY_GIT_COMMIT_SHA") : { ...PROD, RAILWAY_GIT_COMMIT_SHA: sha };
      const r = await predeploy(env, noFetch);
      assert.equal(r.code, EX_CONFIG, JSON.stringify(sha));
      assert.equal(r.err.length, 1);
      assert.match(r.err[0]!, /^\[deploy-guard\] refused: RAILWAY_GIT_COMMIT_SHA is not a 40-hex commit/);
    }
    // Both wrong: both said.
    assert.equal((await predeploy({ ...RAILWAY }, noFetch)).err.length, 2);
  });

  describe("the optional ancestry check through GitHub's compare API", () => {
    const REPO = "millw14/merrymen";
    const asked: string[] = [];
    const answer = (status: number, body: unknown) => (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const proof = (status: string, extra: Record<string, unknown> = {}) => ({ status, ahead_by: 0, behind_by: 3, merge_base_commit: { sha: SHA }, ...extra });

    it("is not asked for unless MERRYMEN_DEPLOY_ANCESTRY_REPO names the repository", async () => {
      assert.equal((await predeploy(PROD, noFetch)).code, 0);
    });

    it("passes when the commit is main's head or behind it, asking about exactly that commit", async () => {
      for (const status of ["identical", "behind"]) {
        asked.length = 0;
        const r = await predeploy({ ...PROD, MERRYMEN_DEPLOY_ANCESTRY_REPO: REPO }, answer(200, proof(status)));
        assert.deepEqual(r, { code: 0, out: [`[deploy-guard] ok branch=main commit=${SHA} ancestry=proven`], err: [] }, status);
        assert.deepEqual(asked, [`https://api.github.com/repos/${REPO}/compare/main...${SHA}?per_page=1`]);
      }
    });

    it("fails closed on every other answer", async () => {
      const env = { ...PROD, MERRYMEN_DEPLOY_ANCESTRY_REPO: REPO };
      const refusals: [string, typeof fetch, RegExp][] = [
        ["ahead", answer(200, proof("ahead", { ahead_by: 2 })), /not inside main's history \(compare status ahead\)/],
        ["diverged", answer(200, proof("diverged", { ahead_by: 1, merge_base_commit: { sha: "f".repeat(40) } })), /compare status diverged/],
        ["behind, but something ahead", answer(200, proof("behind", { ahead_by: 1 })), /compare status behind/],
        ["behind, another merge base", answer(200, proof("behind", { merge_base_commit: { sha: "e".repeat(40) } })), /compare status behind/],
        ["behind, no merge base", answer(200, proof("behind", { merge_base_commit: null })), /compare status behind/],
        ["an unknown status, not echoed", answer(200, proof("Behind; rm -rf /")), /compare status unreadable/],
        ["not an object", answer(200, "null"), /compare status unreadable/],
        ["not JSON", answer(200, "<html>"), /answer could not be read/],
        ["404: private, renamed or unknown", answer(404, { message: "Not Found" }), /answered 404/],
        ["403: rate limited", answer(403, { message: "API rate limit exceeded" }), /answered 403/],
        ["500", answer(500, proof("behind")), /answered 500/],
        ["unreachable", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, /could not be reached/],
      ];
      for (const [name, fetchImpl, pattern] of refusals) {
        const r = await predeploy(env, fetchImpl);
        assert.equal(r.code, EX_CONFIG, name);
        assert.deepEqual(r.out, [], name);
        assert.equal(r.err.length, 1, name);
        assert.match(r.err[0]!, pattern, name);
        assert.ok(!r.err[0]!.includes("rm -rf"), "an answer's text is never echoed");
      }
    });

    it("refuses a repository that is not owner/name without asking anything", async () => {
      for (const repo of ["", "merrymen", "millw14/merrymen/../x", "millw14/merry men", "-x/y", "millw14/merrymen?x=1", "https://github.com/millw14/merrymen"]) {
        const r = await predeploy({ ...PROD, MERRYMEN_DEPLOY_ANCESTRY_REPO: repo }, noFetch);
        assert.equal(r.code, EX_CONFIG, repo);
        assert.deepEqual(r.err, ["[deploy-guard] refused: MERRYMEN_DEPLOY_ANCESTRY_REPO must be owner/name"]);
      }
    });

    it("never runs before main and the commit have passed", async () => {
      assert.equal((await predeploy({ ...PROD, RAILWAY_GIT_BRANCH: "feature", MERRYMEN_DEPLOY_ANCESTRY_REPO: REPO }, noFetch)).code, EX_CONFIG);
    });
  });
});

describe("usage", () => {
  it("anything but the two exact shapes is a usage error, on or off Railway", async () => {
    for (const argv of [[], ["--phase=start"], ["--phase=predeploy", "--role=start:web"], ["--role=start:web", "--phase=start"],
      ["--phase=start", "--role=start:web", "--extra"], ["--phase", "predeploy"], ["--phase=deploy"], ["--phase=start", "start:web"]]) {
      for (const env of [{}, FLEET]) {
        const r = await runDeployGuard(argv, env, { fetch: (() => { throw new Error("no"); }) as unknown as typeof fetch });
        assert.equal(r.code, EX_USAGE, argv.join(" "));
        assert.deepEqual(r.out, []);
        assert.deepEqual(r.err, ["[deploy-guard] refused: usage is --phase=predeploy, or --phase=start --role=<start:* role>"]);
      }
    }
  });
});

describe("the one-shot census", () => {
  /** The operator runbook's env audit, by name. */
  const RUNBOOK = [
    "MERRYMEN_REPAIR", "MERRYMEN_REPAIR_ACCOUNT", "MERRYMEN_REPAIR_RUN_ID", "MERRYMEN_REPAIR_RESUME", "MERRYMEN_REPAIR_HWM",
    "MERRYMEN_REPAIR_HWM_ONLY", "MERRYMEN_REPAIR_HWM_PHANTOM_PROFIT", "MERRYMEN_REPAIR_CLASS_PNL", "MERRYMEN_REPAIR_CLASS_PNL_ONLY",
    "MERRYMEN_REPAIR_CLASS_CASH_ROW", "MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY", "MERRYMEN_ACCOUNTING_RECONSTRUCT", "MERRYMEN_ACCOUNTING_DIAGNOSE",
    "MERRYMEN_GAS_AUDIT", "MERRYMEN_ANNOUNCE_ID", "MERRYMEN_ANNOUNCE_CONFIRM", "MERRYMEN_ANNOUNCE_BODY_SHA256",
    "MERRYMEN_ENABLE_CLASS_FOR", "MERRYMEN_ENABLE_CLASS_PRESET", "MERRYMEN_HALT_CLASS_ENTRIES_FOR", "MERRYMEN_RESUME_CLASS_ENTRIES_FOR",
    "MERRYMEN_INSPECT_TENANT", "MERRYMEN_COHORT_VET", "MERRYMEN_IDENTITY_AUDIT", "MERRYMEN_BRAIN_DATASET",
    "MERRYMEN_TG_RECOVERY_ID", "MERRYMEN_TG_RECOVERY_CHAT_ID", "MERRYMEN_TG_RECOVERY_CONFIRM", "MERRYMEN_TG_RECOVERY_BODY_SHA256",
    "MERRYMEN_RECONCILE_SHADOW", "MERRYMEN_BACKFILL_LIVE_INTENT",
  ];
  /** Standing configuration and the rollout's own controls: never counted. */
  const STANDING = [
    "MERRYMEN_ACCOUNTING_HOLD_TENANTS", "MERRYMEN_CLASS_SNIPE", "MERRYMEN_CLASS_VAULT_FACTORY", "MERRYMEN_CLASS_MAX_POSITIONS",
    "MERRYMEN_LIVE_INTENT_STAND_DOWN", "MERRYMEN_FLEET_ROLLOUT", "MERRYMEN_FLEET_RECOVERY_REPORT_ONLY", "MERRYMEN_FLEET_RECOVERY_REPLIES",
    "MERRYMEN_RESUME_PREVIEW", "MERRYMEN_RESUME_APPROVE", "MERRYMEN_RESUME_REVOKE", "MERRYMEN_RELEASE_HOME_HALT", "MERRYMEN_REHALT_HOME",
    "MERRYMEN_ADOPT_HOME_HALT_SHA256", "MERRYMEN_INITIAL_HANDOVER", "MERRYMEN_HOME", "MERRYMEN_TG_GROUPS", "MERRYMEN_REPAIRS",
    "MERRYMEN_ANNOUNCE", "MERRYMEN_ENABLE_CLASS", "merrymen_repair_hwm", "MERRYMEN_REPAIR_hwm", "DATABASE_URL",
  ];

  it("counts the runbook's one-shots and nothing standing", () => {
    for (const name of RUNBOOK) assert.equal(isOneShotVariable(name), true, name);
    for (const name of STANDING) assert.equal(isOneShotVariable(name), false, name);
  });

  it("counts every orchestrator run…IfAsked gate, so a new one-shot is counted from the commit that adds it", () => {
    // The gate is the first MERRYMEN_ variable each function names: every one
    // of them returns early unless that variable is set.
    const src = read("worker/src/orchestrator.ts");
    const gates = [...src.matchAll(/^async function (run\w+IfAsked)\(/gm)].map((m) => {
      const name = /MERRYMEN_[A-Z0-9_]+/.exec(src.slice(m.index! + m[0].length))?.[0];
      return [m[1]!, name] as const;
    });
    assert.ok(gates.length >= 15, `found only ${gates.length} run…IfAsked functions — has the pattern changed?`);
    for (const [fn, name] of gates) assert.ok(name && isOneShotVariable(name), `${fn} is gated on ${name}, which the census does not count`);
  });

  it("names, sorted, and never a value", async () => {
    const values = new Map<string, string>();
    const env: NodeJS.ProcessEnv = { ...FLEET };
    [...RUNBOOK, ...STANDING].forEach((name, i) => {
      const value = `value-${i}-0x${"9".repeat(40)}-${name.length}`;
      values.set(name, value);
      env[name] = value;
    });
    assert.deepEqual(oneShotCensus(env), [...RUNBOOK].sort());
    const r = await runDeployGuard(["--phase=start", "--role=start:orchestrator"], env);
    assert.equal(r.code, EX_CONFIG);
    assert.equal(r.out[0], `[deploy-guard] census one-shot: ${[...RUNBOOK].sort().join(" ")}`);
    const printed = all(r);
    for (const [name, value] of values) assert.ok(!printed.includes(value), `the value of ${name} was printed`);
    assert.ok(!printed.includes("9".repeat(40)));
  });
});

describe("a Railway-hosted orchestrator's persistent home", () => {
  it("is required on Railway, exactly as 1, and not this check's business elsewhere", () => {
    assert.equal(hostedPersistentHomeRefusal({}), null);
    assert.equal(hostedPersistentHomeRefusal({ MERRYMEN_PERSISTENT_HOME_REQUIRED: "0" }), null);
    assert.equal(hostedPersistentHomeRefusal({ ...RAILWAY, MERRYMEN_PERSISTENT_HOME_REQUIRED: "1" }), null);
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      const env = value === undefined ? { ...RAILWAY } : { ...RAILWAY, MERRYMEN_PERSISTENT_HOME_REQUIRED: value };
      assert.match(hostedPersistentHomeRefusal(env) ?? "", /needs MERRYMEN_PERSISTENT_HOME_REQUIRED=1/, JSON.stringify(value));
    }
  });
});

describe("the guard agrees with the image and the start script", () => {
  it("DEPLOY_GUARD_IMAGE is the Dockerfile's MERRYMEN_IMAGE", () => {
    assert.deepEqual([...read("Dockerfile").matchAll(/^ENV MERRYMEN_IMAGE=(\S+)$/gm)].map((m) => m[1]), [DEPLOY_GUARD_IMAGE]);
  });

  it("START_ROLES are package.json's start:* scripts", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    assert.deepEqual([...START_ROLES].sort(), Object.keys(scripts).filter((k) => k.startsWith("start:")).sort());
  });

  it("nothing imports the command line, which runs the guard on load; the checks are imported instead", () => {
    const importsOf = (target: string) => new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)["'][^"']*/${target}(?:\\.[cm]?[jt]sx?)?["']`);
    const sources = ["worker", "web/src", "packages", "scripts", "sdk", "browser", "cli", "services"].flatMap((dir) =>
      (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
        .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.split(/[\\/]/).includes("node_modules"))
        .map((f) => join(dir, f)));
    assert.deepEqual(sources.filter((f) => importsOf("deploy-guard").test(read(f))), []);
    assert.ok(sources.some((f) => f === join("worker", "src", "orchestrator.ts") && importsOf("deploy-guard-checks").test(read(f))),
      "the scan should at least find orchestrator.ts importing the checks");
  });
});

describe("the real guard, as the container runs it", { skip: !posix }, () => {
  const scratch: string[] = [];
  after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
  const tempDir = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(os.tmpdir(), prefix)));
    scratch.push(dir);
    return dir;
  };
  // Deliberately NOT process.env: no DATABASE_URL or Railway variable from the
  // developer's shell may reach what these runs decide.
  const base = (dir: string) => ({ PATH: process.env.PATH!, HOME: dir });
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--import", "tsx", "worker/src/deploy-guard.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });

  it("exits with its verdict and prints one line per finding", () => {
    const dir = tempDir("merrymen-deploy-guard-cli-");
    const off = cli(["--phase=start", "--role=start:orchestrator"], base(dir));
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, "[deploy-guard] skipped: not running on Railway\n");
    const refused = cli(["--phase=start", "--role=start:orchestrator"], { ...base(dir), ...FLEET, RAILWAY_SERVICE_ID: OTHER_SERVICE, MERRYMEN_COHORT_VET: "1" });
    assert.equal(refused.status, EX_CONFIG);
    assert.equal(refused.stdout, "[deploy-guard] census one-shot: MERRYMEN_COHORT_VET\n");
    assert.equal(refused.stderr.trim().split("\n").length, 2, refused.stderr);
    const predeploy = cli(["--phase=predeploy"], { ...base(dir), ...RAILWAY, RAILWAY_GIT_BRANCH: "main", RAILWAY_GIT_COMMIT_SHA: SHA });
    assert.equal(predeploy.status, 0, predeploy.stderr);
    assert.equal(predeploy.stdout, `[deploy-guard] ok branch=main commit=${SHA}\n`);
    const usage = cli([], base(dir));
    assert.equal(usage.status, EX_USAGE);
  });

  it("runs however it is named: through a symlinked app root, and without its extension", () => {
    // The command line used to ask whether it was the entry module, and the
    // answer was "no" — no output, exit 0 — whenever the path it was given
    // was not the path Node resolved. Each of these must still refuse.
    const dir = tempDir("merrymen-deploy-guard-link-");
    const link = join(dir, "app");
    symlinkSync(ROOT, link);
    const env = { ...base(dir), RAILWAY_SERVICE_ID: OTHER_SERVICE, MERRYMEN_REPAIR_HWM: "apply" };
    for (const entry of [join(link, "worker/src/deploy-guard.ts"), "worker/src/deploy-guard"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", entry, "--phase=start", "--role=start:orchestrator"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(r.status, EX_CONFIG, `${entry}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "[deploy-guard] census one-shot: MERRYMEN_REPAIR_HWM\n", entry);
    }
  });

  it("a refused orchestrator never starts: the script stops with 78 after its [start] line, and the home stays untouched", () => {
    const dir = tempDir("merrymen-deploy-guard-start-");
    const home = join(dir, "home");
    mkdirSync(home, { mode: 0o700 });
    const secret = `apply-${"7".repeat(40)}`;
    const r = spawnSync("/bin/sh", [join(ROOT, "scripts/container-start.sh")], {
      cwd: dir,
      env: { ...base(dir), ...FLEET, RAILWAY_SERVICE_ID: OTHER_SERVICE, MERRYMEN_START: "start:orchestrator", MERRYMEN_HOSTED: "1",
        MERRYMEN_HOME: home, RAILWAY_GIT_COMMIT_SHA: SHA, MERRYMEN_REPAIR_HWM: secret },
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(r.status, EX_CONFIG, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, `[start] role=start:orchestrator commit=${SHA}\n[deploy-guard] census one-shot: MERRYMEN_REPAIR_HWM\n`);
    assert.match(r.stderr, /^\[deploy-guard\] refused: this is not the fleet's service/m);
    assert.match(r.stderr, /^\[deploy-guard\] refused: one-shot operator variables are set/m);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\[orchestrator\]/, "the orchestrator ran after a refusal");
    assert.ok(!`${r.stdout}${r.stderr}`.includes(secret), "a one-shot value reached the log");
    assert.deepEqual(readdirSync(home), []);
  });
});
