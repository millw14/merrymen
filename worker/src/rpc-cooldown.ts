/**
 * ONE NUMBER, SHARED BY EVERY CHILD IN THE CONTAINER: when to stop asking.
 *
 * The children are separate OS processes spawned by the orchestrator into the
 * same container, behind one egress IP, reading one endpoint. A circuit breaker
 * held in process memory is therefore FIFTEEN breakers, and each of them can
 * only learn that the endpoint is refusing by being refused itself. During the
 * incident this exists for, that is fourteen unnecessary refusals per round —
 * and each of those refusals is load, which is what caused the incident.
 *
 * So the breaker's one piece of state lives in a file the whole container can
 * see. This is not a new mechanism: FLEET_HALT, the heartbeat files, the
 * command files and the research files are all the orchestrator and its
 * children agreeing about something through the filesystem, for exactly the
 * reason that there is no IPC between them.
 *
 * WHY A FILE AND NOT SOMETHING BETTER. The alternative is the orchestrator
 * hosting a local proxy every child reads through — one egress point, one
 * budget, and dedupe for free. That is the better architecture and it is a
 * bigger change: it makes the orchestrator a hard dependency of every read,
 * where today it is a supervisor children survive the restart of. This file is
 * the part of that idea which needs none of it.
 *
 * IT IS AN ADVISORY, NOT A LOCK. Nothing here blocks, no child waits for
 * another, and a corrupt or missing file simply means no shared advice — which
 * is exactly where the fleet was before this existed. Every failure mode
 * degrades to per-process behaviour rather than to a stall.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * The directory every child in this container can see.
 *
 * A child's own MERRYMEN_HOME is `<fleet>/children/<tenant>`, so it is NOT the
 * shared one — writing there would give each child a private file and the
 * silent appearance of a working breaker. The orchestrator passes the fleet
 * home explicitly at spawn; self-hosted there is one process and its own home
 * is the honest answer.
 */
export function cooldownFile(home: string): string {
  const fleet = process.env.MERRYMEN_FLEET_HOME?.trim();
  return path.join(fleet && fleet.length > 0 ? fleet : home, "rpc-cooldown.json");
}

/**
 * Read the shared cooldown, or null.
 *
 * NULL FOR EVERY FAILURE, and that is the safe direction: no advice means each
 * process falls back to its own breaker, which is strictly what it had before.
 * A parse error must never become a cooldown of zero — that would be an
 * instruction to resume, invented out of a corrupt file.
 */
export function readCooldown(home: string): number | null {
  try {
    const raw = readFileSync(cooldownFile(home), "utf8");
    const j = JSON.parse(raw) as { until?: unknown };
    const until = typeof j.until === "number" && Number.isFinite(j.until) ? j.until : null;
    return until;
  } catch {
    return null;
  }
}

/**
 * Publish a cooldown for the other children.
 *
 * ATOMIC, because fifteen writers share this path and a torn read looks exactly
 * like a corrupt file — which `readCooldown` correctly turns into "no advice",
 * losing the warning at the moment it is worth most. Write-then-rename is the
 * cheapest way to make a reader see either the old number or the new one.
 *
 * BEST EFFORT. A failure to publish costs the fleet an optimisation, never a
 * read: the caller's own breaker is already set before this is called.
 */
export function publishCooldown(home: string, until: number, by: string): void {
  try {
    const file = cooldownFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ until, at: Date.now(), by }), "utf8");
    renameSync(tmp, file);
  } catch {
    /* advisory only — see the header */
  }
}

/**
 * Forget the shared cooldown. Test seam, and the operator's escape hatch.
 *
 * The file outlives every process that can see it, so "delete it and everything
 * resumes" has to be true and has to be one action. `adoptShared` caps what the
 * file can do, and this removes it outright.
 */
export function clearCooldown(home: string): void {
  try {
    rmSync(cooldownFile(home), { force: true });
  } catch {
    /* advisory only */
  }
}
