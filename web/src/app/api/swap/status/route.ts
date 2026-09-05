/**
 * Where is my manual swap? Polled by the /swap page after submit.
 *
 * Three states, mirroring the selftest route's queued/running/done split:
 * - "queued" — the request is still in settings (worker hasn't claimed it)
 * - "running" — claimed (fields cleared) but no outcome event yet
 * - "done" — the worker wrote an event line containing the id; `ok` says
 *   whether it landed. The line is the worker's own words, unedited.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { isHostedMode, type MerrymenSettings } from "@merrymen/core";
import { homePaths } from "@merrymen/home";
import { getSettingsStore } from "@merrymen/settings-store";
import { tenantOf } from "@/lib/auth";
import { getGrantStore } from "@merrymen/grant-store";
import { withReadDb } from "@/lib/ledger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return NextResponse.json({ state: "none" });
  }

  const tenant = isHostedMode() ? tenantOf(req) : null;
  if (isHostedMode() && !tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  // Still in settings = the worker's tick hasn't claimed it yet.
  let pending: MerrymenSettings;
  if (tenant) pending = (await getSettingsStore().get(tenant)) ?? {};
  else {
    try {
      pending = JSON.parse(await readFile(homePaths.settings(), "utf8")) as MerrymenSettings;
    } catch {
      pending = {};
    }
  }
  if (pending.manualSwapId === id) return NextResponse.json({ state: "queued", id });

  // Claimed — look for the outcome in the event feed this worker writes.
  // Scoped to this tenant's agent: ids are unguessable UUIDs, but a shared
  // events table is still no place for cross-tenant reads.
  let agent: string | null = null;
  if (tenant) {
    const grant = await getGrantStore().get(tenant);
    agent = (grant?.smartAccount as string) ?? null;
    if (!agent) return NextResponse.json({ state: "running", id });
  } else {
    try {
      const g = JSON.parse(await readFile(homePaths.grant(), "utf8")) as { smartAccount?: string };
      agent = g.smartAccount ?? null;
    } catch {
      agent = null;
    }
  }
  const tag = `manual-swap ${id}`;
  interface EventRow {
    level: string;
    message: string;
    created_at: number;
  }
  const hit = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      const rows = agent
        ? ((await db
            .prepare(
              `SELECT level, message, created_at FROM events WHERE agent_id = ? AND message LIKE ? ORDER BY created_at DESC LIMIT 5`,
            )
            .all(agent, `%${tag}%`)) as EventRow[])
        : ((await db
            .prepare(
              `SELECT level, message, created_at FROM events WHERE message LIKE ? ORDER BY created_at DESC LIMIT 5`,
            )
            .all(`%${tag}%`)) as EventRow[]);
      return rows[0] ?? null;
    } catch {
      return null;
    }
  });

  if (!hit) return NextResponse.json({ state: "running", id });
  return NextResponse.json({
    state: "done",
    id,
    ok: hit.level === "ok",
    line: String(hit.message),
    at: Number(hit.created_at),
  });
}
