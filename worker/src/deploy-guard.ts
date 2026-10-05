/**
 * THE DEPLOY GUARD: ACCIDENT PREVENTION FOR THE HOSTED SERVICES.
 *
 * Nothing here defends against an attacker with the Railway dashboard — they
 * can change the variables this reads. It exists for the honest mistakes that
 * have the same blast radius: a production deploy from a feature branch, the
 * orchestrator role pasted onto the wrong service, a fleet role on a container
 * with no volume behind its home, an image from before the start path ran under
 * tini, and a one-shot repair variable left set from last week that runs again,
 * fleet-wide, on the next boot — over tenants a staged rollout is still holding.
 * Each of those deploys green. Each is refused here instead, loudly, by name.
 *
 * TWO PHASES, two callers:
 *
 *   --phase=predeploy   Railway's pre-deploy command on the orchestrator
 *                       service (a service setting, not railway.json):
 *                         node --import tsx worker/src/deploy-guard.ts --phase=predeploy
 *                       It runs in its own container BEFORE the new deployment
 *                       replaces the live one, so a refusal here leaves the
 *                       previous deployment serving. Production only: the
 *                       deploy must come from `main`, at a full 40-hex commit,
 *                       and — only when MERRYMEN_DEPLOY_ANCESTRY_REPO names the
 *                       repository — GitHub's public compare API must show that
 *                       commit inside main's history. That check FAILS CLOSED:
 *                       unreachable, rate-limited, private or ambiguous all
 *                       refuse; unset the variable to stop asking.
 *
 *   --phase=start --role=<role>
 *                       scripts/container-start.sh, inside each allowlisted
 *                       role's branch, after the [start] line and before the
 *                       role execs. The web role gets the allowlist check only.
 *                       The fleet roles (orchestrator, recovery-replies) must be
 *                       on the one service MERRYMEN_FLEET_SERVICE_ID names, with
 *                       MERRYMEN_PERSISTENT_HOME_REQUIRED=1 and this image's
 *                       MERRYMEN_IMAGE. Then a census prints the NAMES (never
 *                       the values) of the one-shot operator variables that are
 *                       set, and the orchestrator role is refused while any is
 *                       set and MERRYMEN_FLEET_ROLLOUT is not exactly `all`.
 *
 * Off Railway, both phases print that they skipped and exit 0: a self-hosted
 * install, a laptop and the test suite have no Railway service to be wrong
 * about. "On Railway" is read from the deployment identity Railway injects
 * into every deployment (RAILWAY_ONLY_IDENTITY below) — never from
 * RAILWAY_TOKEN, which sits in plenty of developers' shells for the CLI.
 *
 * NO ACK AND NO BREAK-GLASS. There is no variable that waves a refusal
 * through. Every refusal names the configuration to fix, and fixing it is the
 * only way past — a deliberate, visible change on the service, which is the
 * whole point. A rollback to a deployment from another branch, or to an image
 * older than this file, fails the pre-deploy step for the same reason: clear
 * the service's pre-deploy command first, on purpose.
 *
 * Exit codes: 0 ok or skipped; 78 (EX_CONFIG) a refusal; 64 (EX_USAGE) the
 * guard itself was called wrongly. Refusals go to stderr, everything else to
 * stdout, one `[deploy-guard]` line each. No environment value is ever echoed
 * except the commit, and only once it has matched 40 hex digits.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EX_USAGE = 64;
export const EX_CONFIG = 78;

/** The Dockerfile's `ENV MERRYMEN_IMAGE=…`: the image whose start path is tini → script → exec. */
export const DEPLOY_GUARD_IMAGE = "dockerfile-v1";

/** scripts/container-start.sh's allowlist, which is package.json's start:* scripts. */
export const START_ROLES = ["start:web", "start:orchestrator", "start:recovery-replies"] as const;
export type StartRole = (typeof START_ROLES)[number];
const FLEET_ROLES: ReadonlySet<string> = new Set<StartRole>(["start:orchestrator", "start:recovery-replies"]);

/**
 * What Railway sets in every deployment, pre-deploy containers included. ANY
 * of them present means "on Railway": fail closed, so one renamed variable
 * cannot turn the whole guard into a skip.
 */
const RAILWAY_ONLY_IDENTITY = [
  "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT",
  "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID", "RAILWAY_REPLICA_ID",
] as const;

export function onRailway(env: NodeJS.ProcessEnv): boolean {
  return RAILWAY_ONLY_IDENTITY.some((key) => (env[key] ?? "") !== "");
}

/**
 * THE ONE-SHOT OPERATOR VARIABLES: each arms a repair, a report, a broadcast or
 * a per-tenant switch that runs once on boot and is then meant to be DELETED
 * (the orchestrator's own logs say "Remove … now"). Left set, it runs again on
 * every boot — and before the rollout reads `all`, every boot is over a fleet
 * part of which is held for review, and these do not ask which part. Several
 * are reads only; they are counted all the same, because the census is the
 * cheap moment to notice a forgotten one and a report nobody asked for is not
 * free on a held fleet either.
 *
 * Families, as operators name them: REPAIR_*, ANNOUNCE_*, TG_RECOVERY_*,
 * ENABLE/HALT/RESUME_CLASS_*. NOT counted, because they are standing
 * configuration rather than an action: MERRYMEN_ACCOUNTING_HOLD_TENANTS,
 * MERRYMEN_CLASS_* (the class-vault knobs), MERRYMEN_LIVE_INTENT_STAND_DOWN,
 * and the rollout's own controls. deploy-guard.test.ts holds every
 * orchestrator `run…IfAsked` gate to this list, so a new one-shot is counted
 * from the commit that adds it.
 */
const ONE_SHOT_EXACT: ReadonlySet<string> = new Set([
  "MERRYMEN_ACCOUNTING_RECONSTRUCT", "MERRYMEN_ACCOUNTING_DIAGNOSE", "MERRYMEN_GAS_AUDIT",
  "MERRYMEN_INSPECT_TENANT", "MERRYMEN_COHORT_VET", "MERRYMEN_IDENTITY_AUDIT", "MERRYMEN_BRAIN_DATASET",
  "MERRYMEN_RECONCILE_SHADOW", "MERRYMEN_BACKFILL_LIVE_INTENT",
]);
const ONE_SHOT_FAMILY = /^MERRYMEN_(?:REPAIR(?:_[A-Z0-9_]+)?|ANNOUNCE_[A-Z0-9_]+|TG_RECOVERY_[A-Z0-9_]+|(?:ENABLE|HALT|RESUME)_CLASS_[A-Z0-9_]+)$/;

export function isOneShotVariable(name: string): boolean {
  return ONE_SHOT_EXACT.has(name) || ONE_SHOT_FAMILY.test(name);
}

/**
 * The names of the one-shot variables PRESENT in `env`, sorted. Present, not
 * non-empty: Railway keeps a variable that was blanked instead of deleted, and
 * "set to nothing" is one paste away from "set". Names only — the values are
 * tenant addresses, confirmation digests and chat ids, none of which belongs
 * in a deploy log. Every name returned matched a fixed pattern of [A-Z0-9_].
 */
export function oneShotCensus(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) => env[name] !== undefined && isOneShotVariable(name)).sort();
}

/**
 * A FLEET HOME ON RAILWAY IS A PROVEN VOLUME. persistent-home.ts proves the
 * mount, the volume UUID and the manifest — but only when
 * MERRYMEN_PERSISTENT_HOME_REQUIRED=1 asks it to; unset or 0, it steps aside.
 * runOrchestrator() asks this before anything else and exits 78 on a refusal.
 * Off Railway this is null: a self-hosted fleet's home is the owner's disk.
 */
export function hostedPersistentHomeRefusal(env: NodeJS.ProcessEnv): string | null {
  if (!onRailway(env) || env.MERRYMEN_PERSISTENT_HOME_REQUIRED === "1") return null;
  return "a Railway-hosted fleet needs MERRYMEN_PERSISTENT_HOME_REQUIRED=1, so its home is proven to be the mounted volume and not the container's own disk, which the next deploy discards";
}

export interface GuardResult {
  code: number;
  /** For stdout. */
  out: string[];
  /** For stderr: the refusals. */
  err: string[];
}
export interface GuardDeps {
  /** Test seam. Production uses the global fetch. */
  fetch?: typeof fetch;
}

const line = (text: string) => `[deploy-guard] ${text}`;
const SHA40 = /^[0-9a-f]{40}$/;
/** GitHub's own limits on an owner and a repository name. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const ANCESTRY_TIMEOUT_MS = 10_000;

function refused(out: string[], reasons: string[]): GuardResult {
  return { code: EX_CONFIG, out, err: reasons.map((r) => line(`refused: ${r}`)) };
}
const skipped = (why: string): GuardResult => ({ code: 0, out: [line(`skipped: ${why}`)], err: [] });

/**
 * Is `sha` inside main's history, by GitHub's public compare API? null when it
 * is proven, else why not. `main...sha` reads "how does sha stand against
 * main": `behind` (or `identical`) with nothing ahead, and a merge base that
 * IS sha, is exactly "sha is an ancestor of main". Anything else — ahead,
 * diverged, a 404 for a private or renamed repository, a 403 rate limit on
 * Railway's shared egress, a timeout, a body we cannot read — is unproven,
 * and unproven refuses.
 */
async function ancestryRefusal(repo: string, sha: string, fetchImpl: typeof fetch): Promise<string | null> {
  if (!REPO.test(repo)) return "MERRYMEN_DEPLOY_ANCESTRY_REPO must be owner/name";
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/compare/main...${sha}?per_page=1`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "merrymen-deploy-guard", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(ANCESTRY_TIMEOUT_MS),
    });
  } catch {
    return "GitHub's compare API could not be reached, so the commit is not proven to be on main";
  }
  if (res.status !== 200) return `GitHub's compare API answered ${res.status}, so the commit is not proven to be on main`;
  let body: { status?: unknown; ahead_by?: unknown; merge_base_commit?: { sha?: unknown } | null };
  try { body = (await res.json()) as typeof body; }
  catch { return "GitHub's compare API answer could not be read, so the commit is not proven to be on main"; }
  if ((body?.status === "behind" || body?.status === "identical") && body.ahead_by === 0 && body.merge_base_commit?.sha === sha) return null;
  const status = typeof body?.status === "string" && /^[a-z]{1,16}$/.test(body.status) ? body.status : "unreadable";
  return `the commit is not inside main's history (compare status ${status})`;
}

async function predeploy(env: NodeJS.ProcessEnv, deps: GuardDeps): Promise<GuardResult> {
  if (!onRailway(env)) return skipped("not running on Railway");
  // Missing or blank reads as production: on Railway, an environment we cannot
  // name is not one we may assume is a sandbox.
  const name = (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || "").trim().toLowerCase();
  if (name && name !== "production") {
    return skipped("the pre-deploy checks apply to the production environment only");
  }
  const reasons: string[] = [];
  if (env.RAILWAY_GIT_BRANCH !== "main") {
    reasons.push("production deploys only from main, and RAILWAY_GIT_BRANCH is not main — deploy main, or merge first");
  }
  const sha = (env.RAILWAY_GIT_COMMIT_SHA ?? "").toLowerCase();
  if (!SHA40.test(sha)) {
    reasons.push("RAILWAY_GIT_COMMIT_SHA is not a 40-hex commit, so this deploy cannot be tied to main (a CLI upload or an image deploy names none)");
  }
  if (reasons.length) return refused([], reasons);
  const repo = env.MERRYMEN_DEPLOY_ANCESTRY_REPO;
  if (repo !== undefined) {
    const why = await ancestryRefusal(repo, sha, deps.fetch ?? fetch);
    if (why) return refused([], [why]);
  }
  return { code: 0, out: [line(`ok branch=main commit=${sha}${repo !== undefined ? " ancestry=proven" : ""}`)], err: [] };
}

function start(env: NodeJS.ProcessEnv, role: StartRole): GuardResult {
  if (!onRailway(env)) return skipped("not running on Railway");
  if (!FLEET_ROLES.has(role)) return { code: 0, out: [line(`ok role=${role}`)], err: [] };
  const reasons: string[] = [];
  const fleet = env.MERRYMEN_FLEET_SERVICE_ID ?? "", service = env.RAILWAY_SERVICE_ID ?? "";
  if (!fleet) {
    reasons.push("MERRYMEN_FLEET_SERVICE_ID is not set — a fleet role runs only on the one Railway service that variable names");
  } else if (service !== fleet) {
    reasons.push("this is not the fleet's service: RAILWAY_SERVICE_ID differs from MERRYMEN_FLEET_SERVICE_ID — a second fleet would race the first for every tenant");
  }
  if (env.MERRYMEN_PERSISTENT_HOME_REQUIRED !== "1") {
    reasons.push("MERRYMEN_PERSISTENT_HOME_REQUIRED is not 1 — a fleet role never runs on a home that is not the proven volume");
  }
  if (env.MERRYMEN_IMAGE !== DEPLOY_GUARD_IMAGE) {
    reasons.push(`MERRYMEN_IMAGE is not ${DEPLOY_GUARD_IMAGE} — this is not the image whose start path delivers SIGTERM to node`);
  }
  const census = oneShotCensus(env);
  const out = [line(`census one-shot: ${census.length ? census.join(" ") : "none"}`)];
  // Exactly `all`, as written: a value the rollout parser might also read as
  // all ("ALL", " all") is not one this guard has to guess about.
  if (role === "start:orchestrator" && census.length && env.MERRYMEN_FLEET_ROLLOUT !== "all") {
    reasons.push("one-shot operator variables are set (named in the census above) while MERRYMEN_FLEET_ROLLOUT is not all — delete them before the orchestrator starts over a partly held fleet");
  }
  if (reasons.length) return refused(out, reasons);
  out.push(line(`ok role=${role}`));
  return { code: 0, out, err: [] };
}

/**
 * The whole guard, without touching the process: the caller prints the lines
 * and exits with the code. Arguments are exactly `--phase=predeploy`, or
 * `--phase=start --role=<role>` in that order; anything else is a usage error,
 * and nothing passed in is echoed back.
 */
export async function runDeployGuard(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, deps: GuardDeps = {}): Promise<GuardResult> {
  if (argv.length === 1 && argv[0] === "--phase=predeploy") return predeploy(env, deps);
  if (argv.length === 2 && argv[0] === "--phase=start" && argv[1]?.startsWith("--role=")) {
    const role = argv[1].slice("--role=".length);
    if ((START_ROLES as readonly string[]).includes(role)) return start(env, role as StartRole);
    return { code: EX_USAGE, out: [], err: [line(`refused: --role is not one of: ${START_ROLES.join(" ")}`)] };
  }
  return { code: EX_USAGE, out: [], err: [line("refused: usage is --phase=predeploy, or --phase=start --role=<start:* role>")] };
}

// Run when invoked directly (`node --import tsx worker/src/deploy-guard.ts …`);
// orchestrator.ts imports hostedPersistentHomeRefusal without tripping this.
// exitCode rather than exit(): the lines are on their way out through a pipe.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDeployGuard(process.argv.slice(2)).then((result) => {
    for (const text of result.out) console.log(text);
    for (const text of result.err) console.error(text);
    process.exitCode = result.code;
  }, () => {
    // Nothing above throws by design; if something does, that is a refusal.
    console.error(line("refused: the guard itself failed"));
    process.exitCode = EX_CONFIG;
  });
}
