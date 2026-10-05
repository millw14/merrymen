/**
 * THE CONTAINER'S START PATH: tini → /bin/sh scripts/container-start.sh → exec node.
 *
 * The hosted image used to start with `sh -c "npm run ${MERRYMEN_START…}"`,
 * which put a shell and npm between PID 1 and node. Whether Railway's SIGTERM
 * ever reached the orchestrator's stop handler — the one that calls the fleet
 * home and releases the tenant leases — rested on whether that shell exec'd
 * its one command and whether npm passed the signal on. Neither is ours.
 *
 * Now the shape is fixed and these tests hold it:
 *
 *   - The Dockerfile's one ENTRYPOINT and one CMD are exactly tini and the
 *     script, in exec form, with no npm and no `sh -c` anywhere in either —
 *     read as Docker reads them, whatever the case or line breaks.
 *   - The script runs exactly package.json's `start:*` scripts — the same argv
 *     from the same directory — and it `exec`s them: the stub it runs reports
 *     the very PID the script was started as.
 *   - Unset MERRYMEN_START runs web, as it always did. SET BUT EMPTY, or any
 *     other value, is refused with 64 and runs nothing at all.
 *   - Every allowlisted role passes the deploy guard after its [start] line
 *     and before its exec, and a guard refusal ends the script with the
 *     guard's own status, having exec'd nothing (worker/src/deploy-guard.ts;
 *     deploy-guard.test.ts drives the real guard through the real script).
 *   - A real orchestrator, started through the real script, prints
 *     "[orchestrator] stopping" on SIGTERM and exits 0 — not killed by it.
 *   - The script is LF, and .gitattributes keeps it that way.
 *
 * No container runtime is needed: tini only forwards to its one child, and the
 * child is what is tested here, under /bin/sh and under dash (the image's sh)
 * wherever dash exists.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const SCRIPT = "scripts/container-start.sh";
const posix = process.platform !== "win32";
// The image's /bin/sh is Debian's dash. Run every behavioural case under it
// too wherever it exists, so a bashism cannot pass here and fail in the image.
const SHELLS = ["/bin/sh", "/bin/dash"].filter(existsSync);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

/**
 * The Dockerfile as Docker reads it: one entry per instruction, keyword in
 * upper case. Read line by line it would lie twice over. Docker's keywords are
 * case-insensitive — `cmd […]` IS a CMD — and a trailing backslash carries an
 * instruction onto the next line, with comment and blank lines inside it
 * dropped. A test that looked only for lines starting `CMD ` would keep
 * reading a stale line while a later `cmd`, or a CMD split across lines,
 * quietly replaced it in the image.
 */
function instructions(docker: string): { keyword: string; args: string }[] {
  const out: { keyword: string; args: string }[] = [];
  let pending: string | null = null;
  for (const line of docker.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    if (pending !== null && line.trim() === "") continue;
    const joined: string = pending === null ? line : `${pending} ${line}`;
    if (/\\\s*$/.test(joined)) { pending = joined.replace(/\\\s*$/, ""); continue; }
    pending = null;
    const m = /^\s*([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(joined);
    if (m) out.push({ keyword: m[1]!.toUpperCase(), args: (m[2] ?? "").trim() });
  }
  assert.equal(pending, null, "the Dockerfile ends inside a backslash continuation");
  return out;
}

/**
 * The image's one instruction of a kind. EXACTLY one, not "the last": the
 * last would win in the image, so a second CMD or ENTRYPOINT anywhere is a
 * place for the start path to change without this file noticing.
 */
function soleExecForm(docker: string, instruction: "CMD" | "ENTRYPOINT"): unknown {
  const found = instructions(docker).filter((i) => i.keyword === instruction);
  assert.equal(found.length, 1, `the Dockerfile must have exactly one ${instruction}, found: ${found.map((i) => i.args).join(" | ") || "none"}`);
  const raw = found[0]!.args;
  // Shell form (`CMD foo bar`) is wrapped in `/bin/sh -c` by Docker itself —
  // the exact thing this path exists to remove — so only the JSON form parses.
  try { return JSON.parse(raw); }
  catch { assert.fail(`${instruction} must be exec form (a JSON array), not shell form: ${raw}`); }
}

describe("the Dockerfile starts node under tini, through the script", () => {
  const docker = read("Dockerfile");

  it("ENTRYPOINT is tini alone, without -g, and CMD is the script under /bin/sh", () => {
    // Without -g on purpose: the orchestrator decides how its tenant workers
    // stop, so tini signals only its one child.
    assert.deepEqual(soleExecForm(docker, "ENTRYPOINT"), ["/usr/bin/tini", "--"]);
    assert.deepEqual(soleExecForm(docker, "CMD"), ["/bin/sh", `/app/${SCRIPT}`]);
  });

  it("a second CMD or ENTRYPOINT is caught however it is spelled", () => {
    // The very override these reads exist for: appended later, in lower case
    // or split across lines, it would win in the image and bring npm back.
    for (const instruction of ["CMD", "ENTRYPOINT"] as const) {
      for (const extra of [
        `${instruction.toLowerCase()} ["sh", "-c", "npm run start:web"]`,
        `  ${instruction[0]}${instruction.slice(1).toLowerCase()} ["sh", "-c", "npm run start:web"]`,
        `${instruction} \\\n  # a comment inside the continuation\n  ["sh", "-c", \\\n   "npm run start:web"]`,
      ]) {
        assert.throws(() => soleExecForm(`${docker}\n${extra}\n`, instruction), new RegExp(`exactly one ${instruction}`), extra);
      }
    }
    // …and one split across lines still reads as the array Docker sees.
    assert.deepEqual(soleExecForm(`FROM x\ncmd ["/bin/sh", \\\n  # note\n\n  "/app/x"]\n`, "CMD"), ["/bin/sh", "/app/x"]);
  });

  it("the CMD and ENTRYPOINT carry no npm and no `sh -c`", () => {
    for (const instruction of ["CMD", "ENTRYPOINT"] as const) {
      const words = soleExecForm(docker, instruction) as string[];
      assert.ok(!words.some((w) => /\bnpm\b|\bnpx\b/.test(w)), `${instruction} runs npm: ${JSON.stringify(words)}`);
      assert.ok(!words.includes("-c"), `${instruction} runs a command string through a shell: ${JSON.stringify(words)}`);
    }
  });

  it("the image installs tini and carries the start-path marker", () => {
    assert.match(docker, /^RUN apt-get update[\s\S]*?apt-get install -y --no-install-recommends tini\b/m);
    assert.match(docker, /^ENV MERRYMEN_IMAGE=dockerfile-v1$/m);
  });

  it("the build runs tini and parses the script, at the very paths the start uses", () => {
    // Nothing in CI builds this image and railway.json has no healthcheck, so
    // a tini or a script that is missing or broken at START would still build
    // green, replace the live deployment, and crash-loop every role. These two
    // RUNs move that failure into the BUILD, where the previous deployment
    // keeps serving — but only if they name the paths the ENTRYPOINT and CMD
    // actually start, which is what this holds.
    const steps = instructions(docker);
    const [tini] = soleExecForm(docker, "ENTRYPOINT") as string[];
    const [shell, script] = soleExecForm(docker, "CMD") as string[];
    const install = steps.find((i) => i.keyword === "RUN" && /\bapt-get install -y --no-install-recommends tini\b/.test(i.args));
    assert.ok(install, "no RUN installs tini");
    assert.ok(install.args.replace(/\s+/g, " ").endsWith(`&& ${tini} --version`), `the tini install does not end by running ${tini}: ${install.args}`);
    const copy = steps.findIndex((i) => i.keyword === "COPY" && i.args === ". .");
    const parse = steps.findIndex((i) => i.keyword === "RUN" && i.args === `${shell} -n ${script}`);
    assert.ok(copy >= 0 && parse > copy, `the build must run \`${shell} -n ${script}\` after \`COPY . .\` put it there`);
  });

  it("the CMD's path is where COPY puts the script, and .dockerignore keeps it", () => {
    // WORKDIR /app + `COPY . .` puts the repo's scripts/ at /app/scripts/.
    assert.match(docker, /^WORKDIR \/app$/m);
    assert.match(docker, /^COPY \. \.$/m);
    assert.ok(existsSync(join(ROOT, SCRIPT)), `${SCRIPT} is missing`);
    const ignored = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    assert.ok(!ignored.some((l) => /(^|\/)scripts(\/|$)|\.sh$/.test(l)), `.dockerignore drops the start script: ${ignored.join(", ")}`);
  });
});

describe("the script's bytes", () => {
  it("has LF endings only", () => {
    const bytes = readFileSync(join(ROOT, SCRIPT));
    assert.equal(bytes.indexOf(0x0d), -1, `${SCRIPT} contains a carriage return — dash would read \`exec node\\r\``);
  });

  it(".gitattributes pins *.sh to LF in every checkout", () => {
    assert.match(read(".gitattributes"), /^\*\.sh\s+text\s+eol=lf$/m);
  });
});

/** The deploy guard's argv, as the script must run it for a role. */
const GUARD_ARGS = (role: string) => `--import tsx worker/src/deploy-guard.ts --phase=start --role=${role}`;

/**
 * A copy of the script in a scratch "app root" whose `node` and `next` are
 * stubs on PATH. The stubs print their PID, cwd and argv, so a run says which
 * program the script became, from where, with what — without starting either.
 *
 * The `node` stub answers the deploy guard's invocation on its own `guard`
 * line, and exits with STUB_GUARD_EXIT (default 0): the guard runs and RETURNS
 * before the exec, so it is a call the script makes, not the program it
 * becomes, and it stays out of the ran/arg lines compared against npm below.
 */
function sandbox() {
  const app = tempDir("merrymen-container-start-");
  mkdirSync(join(app, "scripts"));
  mkdirSync(join(app, "web"));
  mkdirSync(join(app, "stub-bin"));
  copyFileSync(join(ROOT, SCRIPT), join(app, SCRIPT));
  for (const name of ["node", "next"]) {
    const stub = join(app, "stub-bin", name);
    const guard = name === "node"
      ? `if [ "$3" = worker/src/deploy-guard.ts ]; then echo "guard cwd=$(pwd -P) args=$*"; exit "\${STUB_GUARD_EXIT:-0}"; fi\n`
      : "";
    writeFileSync(stub, `#!/bin/sh\n${guard}echo "pid=$$"\necho "ran=${name} cwd=$(pwd -P)"\nfor a in "$@"; do echo "arg=$a"; done\n`);
    chmodSync(stub, 0o755);
  }
  // Deliberately NOT process.env: nothing from the developer's shell (a
  // DATABASE_URL, a MERRYMEN_START) may leak into what these runs decide.
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: `${join(app, "stub-bin")}:${process.env.PATH}`, ...extra });
  // Started from somewhere else on purpose: the script must find its root itself.
  const elsewhere = tempDir("merrymen-container-cwd-");
  const run = (shell: string, extra?: Record<string, string>) => {
    const r = spawnSync(shell, [join(app, SCRIPT)], { cwd: elsewhere, env: env(extra), encoding: "utf8", timeout: 10_000 });
    return { status: r.status, pid: r.pid, stdout: r.stdout, stderr: r.stderr };
  };
  /** What `npm run <role>` would have run: the package.json line, by sh -c, from the root. */
  const runNpmScript = (line: string, extra?: Record<string, string>) =>
    spawnSync("/bin/sh", ["-c", line], { cwd: app, env: env(extra), encoding: "utf8", timeout: 10_000 }).stdout;
  return { app, run, runNpmScript };
}
/** The script without its comment lines, which talk about `exec` and roles freely. */
const scriptCode = () => read(SCRIPT).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
/** How many `exec <program>` commands — not `exec 2>&1`-style redirections. */
const execs = (code: string) => [...code.matchAll(/^\s*exec\s+[A-Za-z/]/gm)].length;

/**
 * The branches of the script's role `case`, read the way sh reads them: every
 * item between `case $role in` and its `esac`, split on `;;`, each with ALL of
 * its `|`-separated patterns. Anything this cannot read — a second role case,
 * a nested one, an item with no pattern — fails the test rather than being
 * skipped, so the allowlist cannot grow a branch this file does not see.
 */
function roleBranches(code: string): { labels: string[]; body: string }[] {
  const heads = [...code.matchAll(/^\s*case\s+"?\$\{?role\}?"?\s+in\s*$/gm)];
  assert.equal(heads.length, 1, `${SCRIPT} must pick the role in exactly one \`case $role in\``);
  const start = heads[0]!.index! + heads[0]![0].length;
  const end = code.slice(start).search(/^\s*esac\s*$/m);
  assert.ok(end >= 0, `the role case in ${SCRIPT} has no esac`);
  const body = code.slice(start, start + end);
  assert.doesNotMatch(body, /^\s*case\s/m, "the role case must not nest another case");
  return body.split(";;").map((item) => item.trim()).filter(Boolean).map((item) => {
    const close = item.indexOf(")");
    assert.ok(close > 0, `a role case item without a pattern: ${item}`);
    return {
      labels: item.slice(0, close).replace(/^\(/, "").split("|").map((l) => l.trim()),
      body: item.slice(close + 1).trim(),
    };
  });
}

/** The stub's report without its PID, which no two processes share. */
const invocation = (stdout: string) => stdout.split("\n").filter((l) => /^(ran|arg)=/.test(l)).join("\n");
const stubPid = (stdout: string) => Number(/^pid=(\d+)$/m.exec(stdout)?.[1]);

describe("the script runs package.json's start scripts, and only those", { skip: !posix }, () => {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  const startRoles = Object.keys(scripts).filter((k) => k.startsWith("start:")).sort();

  it("its allowlist is exactly the package.json start:* scripts, and everything else is refused", () => {
    const code = scriptCode();
    const branches = roleBranches(code);
    // The refusal is the LAST branch, alone, and starts nothing. sh takes the
    // first pattern that matches, so a `*` any earlier would swallow every
    // role after it.
    const refusal = branches.at(-1);
    assert.deepEqual(refusal?.labels, ["*"], "the role case must end in a lone `*)` refusal");
    assert.match(refusal!.body, /\bexit 64$/, "the `*)` branch must end in exit 64");
    assert.equal(execs(refusal!.body), 0, "the `*)` branch must not start anything");
    // EVERY pattern of every other branch, whatever it looks like. Collecting
    // only the labels that start with `start:` is how a `dev:worker)` branch —
    // a bare tenant worker carrying the orchestrator service's DATABASE_URL
    // and DEK, with no lease — could sit beside them and pass this test.
    const allowed = branches.slice(0, -1);
    assert.deepEqual(allowed.flatMap((b) => b.labels).sort(), startRoles, "a start:* script and the container's allowlist have drifted apart");
    for (const b of allowed) {
      assert.equal(b.labels.length, 1, `one role per branch, not ${b.labels.join("|")}`);
      assert.equal(execs(b.body), 1, `${b.labels[0]} must exec exactly one program`);
    }
    // And nothing is exec'd OUTSIDE those branches: a role started by an `if`
    // ahead of the case would never reach the allowlist at all.
    assert.equal(execs(code), allowed.length, `${SCRIPT} execs a program outside its allowlisted roles`);
  });

  it("every allowlisted branch passes the deploy guard before it execs, and the refusal never runs it", () => {
    // Read from the code as well as run below: a branch added later without
    // the guard would otherwise only show up as a missing line in one case.
    const branches = roleBranches(scriptCode());
    for (const b of branches.slice(0, -1)) {
      const lines = b.body.split("\n").map((l) => l.trim());
      const guard = lines.indexOf("guard"), exec = lines.findIndex((l) => /^exec\s/.test(l));
      assert.ok(guard >= 0 && guard < exec, `${b.labels[0]} must run \`guard\` before its exec`);
      assert.equal(lines.filter((l) => l === "guard").length, 1, `${b.labels[0]} runs the guard more than once`);
    }
    assert.doesNotMatch(branches.at(-1)!.body, /^\s*guard\s*$/m, "the refusal must not run the guard: nothing runs for a refused role");
  });

  for (const shell of SHELLS) {
    for (const role of startRoles) {
      for (const port of [undefined, "4321"]) {
        it(`${shell}: ${role}${port ? ` (PORT=${port})` : ""} execs the same argv from the same directory as npm did`, () => {
          const box = sandbox();
          const extra: Record<string, string> = { MERRYMEN_START: role, ...(port ? { PORT: port } : {}) };
          const r = box.run(shell, extra);
          assert.equal(r.status, 0, r.stderr);
          const expected = box.runNpmScript(scripts[role]!, extra);
          assert.ok(invocation(expected), `the package.json line for ${role} ran neither stub: ${scripts[role]}`);
          assert.equal(invocation(r.stdout), invocation(expected));
          // EXEC, not fork: the program the script became has the script's own
          // PID, so the signal tini forwards to its child lands on node.
          assert.equal(stubPid(r.stdout), r.pid, `${role} forked instead of exec'ing`);
          assert.match(r.stdout, new RegExp(`^\\[start\\] role=${role} commit=unknown$`, "m"));
        });
      }
    }

    for (const role of startRoles) {
      it(`${shell}: ${role} passes the deploy guard from the app root, after its [start] line and before its exec`, () => {
        const box = sandbox();
        const r = box.run(shell, { MERRYMEN_START: role });
        assert.equal(r.status, 0, r.stderr);
        const lines = r.stdout.split("\n");
        const started = lines.indexOf(`[start] role=${role} commit=unknown`);
        const guards = lines.filter((l) => l.startsWith("guard "));
        const ran = lines.findIndex((l) => l.startsWith("ran="));
        assert.deepEqual(guards, [`guard cwd=${box.app} args=${GUARD_ARGS(role)}`]);
        const guard = lines.indexOf(guards[0]!);
        assert.ok(started >= 0 && started < guard && guard < ran, `[start], guard, exec out of order:\n${r.stdout}`);
      });

      it(`${shell}: ${role} stops with the guard's status when the guard refuses, having exec'd nothing`, () => {
        const r = sandbox().run(shell, { MERRYMEN_START: role, STUB_GUARD_EXIT: "78" });
        assert.equal(r.status, 78, `${r.stdout}${r.stderr}`);
        assert.doesNotMatch(r.stdout, /^ran=/m, `${role} started after a guard refusal:\n${r.stdout}`);
        assert.match(r.stdout, /^guard /m);
      });
    }

    it(`${shell}: MERRYMEN_START unset runs the web role`, () => {
      const box = sandbox();
      const r = box.run(shell);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^\[start\] role=start:web commit=unknown$/m);
      assert.equal(invocation(r.stdout), [`ran=next cwd=${join(box.app, "web")}`, "arg=start", "arg=-H", "arg=0.0.0.0", "arg=-p", "arg=3100"].join("\n"));
      assert.equal(stubPid(r.stdout), r.pid);
    });

    it(`${shell}: MERRYMEN_START set but empty is refused with 64, and nothing runs`, () => {
      const r = sandbox().run(shell, { MERRYMEN_START: "" });
      assert.equal(r.status, 64);
      assert.equal(r.stdout, "", "a refused role must not print a [start] line or run anything");
      assert.match(r.stderr, /^\[start\] refused: MERRYMEN_START is set but empty/m);
    });

    it(`${shell}: any other value is refused with 64, and is not echoed`, () => {
      for (const value of ["start", "build", "dev:web", "dev:worker", "start:orchestrator|dev:web", "start:web ", " start:web", "START:WEB", "start:web;id", "start:orchestrator\n", "$(id)", "start:*"]) {
        const r = sandbox().run(shell, { MERRYMEN_START: value });
        assert.equal(r.status, 64, `${JSON.stringify(value)} was not refused: ${r.stdout}${r.stderr}`);
        assert.equal(r.stdout, "", `${JSON.stringify(value)} ran something`);
        assert.match(r.stderr, /^\[start\] refused: MERRYMEN_START is not one of: start:web start:orchestrator start:recovery-replies$/m);
      }
      const r = sandbox().run(shell, { MERRYMEN_START: "$(id)" });
      assert.ok(!r.stderr.includes("$(id)") && !r.stderr.includes("uid="), r.stderr);
    });

    it(`${shell}: the [start] line names the commit only when it is a hex SHA`, () => {
      const box = sandbox();
      assert.match(box.run(shell, { RAILWAY_GIT_COMMIT_SHA: SHA }).stdout, new RegExp(`^\\[start\\] role=start:web commit=${SHA}$`, "m"));
      for (const value of ["", "not a sha; rm -rf", `${SHA}\n[start] role=start:orchestrator commit=forged`]) {
        const r = box.run(shell, { RAILWAY_GIT_COMMIT_SHA: value });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("[start]")).join("\n"), "[start] role=start:web commit=unknown");
      }
    });
  }
});

describe("SIGTERM reaches the orchestrator's stop handler", { skip: !posix }, () => {
  /**
   * The real script and the real orchestrator, under the shell the test runs
   * on — what tini's child is in the image. FLEET_HALT is present and there is
   * no DATABASE_URL, so it starts, stays halted with nothing to supervise, and
   * touches no network and no database: the only question is what SIGTERM does.
   */
  it("prints \"[orchestrator] stopping\" and exits 0, rather than dying of the signal", { timeout: 90_000 }, async () => {
    const dir = tempDir("merrymen-container-sigterm-");
    const home = join(dir, "home");
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "FLEET_HALT"), "", { mode: 0o600 });
    // Its own process group, so cleanup can reach anything a broken exec left
    // behind — a forked node would outlive a killed shell and keep looping.
    const proc = spawn("/bin/sh", [join(ROOT, SCRIPT)], {
      cwd: dir,
      // Deliberately NOT process.env: a DATABASE_URL in the developer's shell
      // must never reach a supervisor started by a test.
      env: { PATH: process.env.PATH, HOME: dir, MERRYMEN_HOME: home, MERRYMEN_HOSTED: "1", MERRYMEN_START: "start:orchestrator", RAILWAY_GIT_COMMIT_SHA: SHA },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes("[orchestrator] starting")) {
        if (proc.exitCode !== null || proc.signalCode !== null) assert.fail(`the orchestrator exited before starting:\n${stdout}${stderr}`);
        if (Date.now() > deadline) assert.fail(`the orchestrator never started:\n${stdout}${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Its handler is installed right after the "starting" line; give it a beat.
      await new Promise((r) => setTimeout(r, 500));
      proc.kill("SIGTERM");
      const { code, signal } = await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no exit 15s after SIGTERM:\n${stdout}${stderr}`)), 15_000)),
      ]);
      assert.match(stdout, /\[orchestrator\] stopping — calling the whole fleet home/, `${stdout}${stderr}`);
      assert.equal(signal, null, "the process was killed by SIGTERM instead of handling it — the script did not exec node");
      assert.equal(code, 0, `${stdout}${stderr}`);
      assert.ok(stdout.indexOf(`[start] role=start:orchestrator commit=${SHA}`) === 0, `the [start] line must come first:\n${stdout}`);
    } finally {
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone, which is the expected case */ }
    }
  });
});
