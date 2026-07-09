/**
 * Agent history for the dashboard: events + trades + equity series.
 * Reads Supabase when configured, else the worker's .data/*.jsonl fallback.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const DATA_DIR = path.join(process.cwd(), "..", ".data");

export interface FeedEvent {
  level: "ok" | "warn" | "err";
  message: string;
  created_at: string;
}
export interface EquityPoint {
  cash_usdg: number;
  vault_usdg: number;
  equity_usdg: number;
  at: string;
}
export interface FeedResponse {
  source: "supabase" | "files";
  events: FeedEvent[];
  equity: EquityPoint[];
}

async function readJsonl<T>(name: string, limit: number): Promise<T[]> {
  try {
    const raw = await readFile(path.join(DATA_DIR, name), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

export async function GET() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key) {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const [events, equity] = await Promise.all([
      supabase
        .from("merrymen_events")
        .select("level,message,created_at")
        .order("created_at", { ascending: false })
        .limit(40),
      supabase
        .from("merrymen_equity")
        .select("cash_usdg,vault_usdg,equity_usdg,at")
        .order("at", { ascending: false })
        .limit(288),
    ]);
    if (!events.error && !equity.error) {
      return NextResponse.json({
        source: "supabase",
        events: (events.data ?? []) as FeedEvent[],
        equity: ((equity.data ?? []) as EquityPoint[]).reverse(),
      } satisfies FeedResponse);
    }
  }

  const [events, equity] = await Promise.all([
    readJsonl<FeedEvent>("events.jsonl", 40),
    readJsonl<EquityPoint>("equity.jsonl", 288),
  ]);
  return NextResponse.json({
    source: "files",
    events: events.reverse(),
    equity,
  } satisfies FeedResponse);
}
