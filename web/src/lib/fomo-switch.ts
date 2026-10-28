/**
 * HOSTED FOMO IS OPT-IN: on only when MERRYMEN_FOMO_ENABLED is exactly "1",
 * the orchestrator's own switch (worker/src/orchestrator.ts fomoSetup). Off,
 * the web builds no runtime — no fomo_* DDL, no Fomo reads or writes on the
 * shared database — the chat leaves every message to its existing handlers,
 * MCP lists no Fomo tool and Settings shows no Fomo switch, so landing this
 * code changes nothing until an operator turns it on. Self-hosted installs
 * are unaffected (their key is their own setting).
 *
 * Its own module, importing nothing, so the session route and the MCP server
 * can ask without loading the research runtime.
 */

type Env = Record<string, string | undefined>;

/** Said where a hosted deployment has not opted in to Fomo research (MERRYMEN_FOMO_ENABLED=1). */
export const FOMO_NOT_ENABLED = "Fomo research is not enabled on this deployment.";

export function hostedFomoEnabled(env: Env = process.env): boolean {
  return env.MERRYMEN_FOMO_ENABLED === "1";
}

/**
 * Whether this deployment runs Fomo research at all: hosted, only when opted
 * in; self-hosted, unless the install switched it off with "0" (its worker
 * reads the same rule, worker/src/fomo-child.ts childFomoOff).
 */
export function fomoEnabledFor(hosted: boolean, env: Env = process.env): boolean {
  return hosted ? hostedFomoEnabled(env) : env.MERRYMEN_FOMO_ENABLED !== "0";
}
