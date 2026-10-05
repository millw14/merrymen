/**
 * THE DEPLOY GUARD'S COMMAND LINE, and nothing else:
 *
 *   node --import tsx worker/src/deploy-guard.ts --phase=predeploy
 *   node --import tsx worker/src/deploy-guard.ts --phase=start --role=<role>
 *
 * The checks, and why each exists, are in deploy-guard-checks.ts. This file
 * runs them, prints their lines and exits with their verdict — UNCONDITIONALLY.
 *
 * It does not ask whether it is the entry module, because that question has a
 * silent wrong answer, and here the wrong answer is a pass. The usual test —
 * `fileURLToPath(import.meta.url) === path.resolve(process.argv[1])`, as
 * orchestrator.ts does it — compares the path Node RESOLVED (the real path,
 * with `.ts` found for an extensionless name) against the one it was GIVEN.
 * Started through a symlinked directory, or as `worker/src/deploy-guard`, the
 * two differ: the guard concluded it had been imported, ran nothing, printed
 * nothing and exited 0 — and container-start.sh and Railway's pre-deploy step
 * both read exit 0 as approval. In orchestrator.ts the same mistake starts
 * nothing, which fails closed; in a guard it waves everything through. So the
 * checks moved out to a module with no side effects, and this file, which
 * nothing imports (deploy-guard.test.ts holds that), always runs them.
 *
 * exitCode rather than exit(): the lines are on their way out through a pipe.
 */
import { EX_CONFIG, runDeployGuard } from "./deploy-guard-checks";

runDeployGuard(process.argv.slice(2)).then((result) => {
  for (const text of result.out) console.log(text);
  for (const text of result.err) console.error(text);
  process.exitCode = result.code;
}, () => {
  // Nothing in the checks throws by design; if something does, that is a refusal.
  console.error("[deploy-guard] refused: the guard itself failed");
  process.exitCode = EX_CONFIG;
});
