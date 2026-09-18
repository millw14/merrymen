/** Liveness for tray/supervisors: is the DB reachable, a grant valid, the worker alive?
 *
 * No new state — heartbeat.json (worker beats each tick), grant.json (sealed
 * policy), and merrymen.db (open read-only) are all existing sources. The
 * desktop tray reads this for staleness instead of guessing; external
 * supervisors can poll it too. Public on loopback by design (same perimeter
 * as every other dashboard route — see middleware.ts).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
// Relative, not the @merrymen/home alias: tsx --test resolves no tsconfig
// paths, and routes importing the alias are untestable outside Next. The
// packaged layout (…/merrymen/web) is identical for both.
import { homePaths } from "../../../../../worker/src/home";

export const dynamic = "force-dynamic";

interface HealthBody {
  ok: boolean;
  db: boolean;
  grant: boolean;
  workerAliveSec: number | null;
}

export async function GET(): Promise<NextResponse<HealthBody>> {
  let db = false;
  try {
    const handle = new DatabaseSync(homePaths.db(), { readOnly: true });
    handle.prepare("SELECT 1").get();
    handle.close();
    db = true;
  } catch {
    db = false;
  }

  let grant = false;
  try {
    const g = JSON.parse(await readFile(homePaths.grant(), "utf8")) as { serialized?: string; smartAccount?: string };
    grant = !!(g.serialized && g.smartAccount);
  } catch {
    grant = false;
  }

  let workerAliveSec: number | null = null;
  try {
    const beat = JSON.parse(await readFile(homePaths.heartbeat(), "utf8")) as { at?: number };
    if (typeof beat.at === "number") {
      workerAliveSec = Math.max(0, Math.floor(Date.now() / 1000) - beat.at);
    }
  } catch {
    workerAliveSec = null;
  }

  return NextResponse.json({ ok: db, db, grant, workerAliveSec });
}
