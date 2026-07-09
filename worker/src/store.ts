/**
 * Trade/event/equity persistence — Supabase when configured, JSONL fallback in
 * .data/ otherwise (bullone's repository-with-fallback pattern). The worker is
 * the only writer; web reads via its own API routes.
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (see supabase/schema.sql).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { StoredGrant } from "@merrymen/core";

const DATA_DIR = path.join(process.cwd(), "..", ".data");
const file = (name: string) => path.join(DATA_DIR, name);

function appendJsonl(name: string, row: object): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(file(name), JSON.stringify(row) + "\n", "utf8");
  } catch (e) {
    console.error(`[store] ${name} append failed:`, e);
  }
}

function readJsonl<T>(name: string): T[] {
  try {
    return readFileSync(file(name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

let supabase: SupabaseClient | null = null;
const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && key) {
  supabase = createClient(url, key, { auth: { persistSession: false } });
  console.log("[store] supabase configured");
} else {
  console.log("[store] no SUPABASE_SERVICE_ROLE_KEY — using .data/*.jsonl fallback");
}

export interface TradeRow {
  agent_id: string;
  kind: string;
  target: string;
  sell_token?: string;
  buy_token?: string;
  amount_usdg: number;
  user_op_hash?: string;
  tx_hash?: string;
  status: "landed" | "reverted" | "rejected";
  reject_rule?: string;
  created_at: string;
}

export async function ensureAgent(grant: StoredGrant): Promise<string> {
  if (!supabase) return grant.smartAccount; // fallback: address IS the id

  const { data: existing } = await supabase
    .from("merrymen_agents")
    .select("id")
    .eq("smart_account", grant.smartAccount)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data, error } = await supabase
    .from("merrymen_agents")
    .insert({
      smart_account: grant.smartAccount,
      owner_address: grant.owner,
      session_key_address: grant.sessionKeyAddress,
      chain_id: grant.chainId,
      caps: grant.caps,
      granted_at: new Date(grant.grantedAt * 1000).toISOString(),
      expires_at: new Date(grant.expiresAt * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[store] ensureAgent failed, falling back:", error.message);
    return grant.smartAccount;
  }
  return data.id as string;
}

export async function addEvent(
  agentId: string,
  level: "ok" | "warn" | "err",
  message: string,
): Promise<void> {
  const row = { agent_id: agentId, level, message, created_at: new Date().toISOString() };
  if (supabase) {
    const { error } = await supabase.from("merrymen_events").insert(row);
    if (!error) return;
    console.error("[store] event insert failed:", error.message);
  }
  appendJsonl("events.jsonl", row);
}

export async function addTrade(row: TradeRow): Promise<void> {
  if (supabase) {
    const { error } = await supabase.from("merrymen_trades").insert(row);
    if (!error) return;
    console.error("[store] trade insert failed:", error.message);
  }
  appendJsonl("trades.jsonl", row);
}

export async function addEquity(
  agentId: string,
  b: { ethWei: bigint; cashUsdg: number; vaultUsdg: number },
): Promise<void> {
  const row = {
    agent_id: agentId,
    eth_wei: b.ethWei.toString(),
    cash_usdg: b.cashUsdg,
    vault_usdg: b.vaultUsdg,
    equity_usdg: b.cashUsdg + b.vaultUsdg,
    at: new Date().toISOString(),
  };
  if (supabase) {
    const { error } = await supabase.from("merrymen_equity").insert(row);
    if (!error) return;
    console.error("[store] equity insert failed:", error.message);
  }
  appendJsonl("equity.jsonl", row);
}

/** Sum of landed spend in the trailing 24h — seeds the daily-cap counter across restarts. */
export async function getSpentTodayUsdg(agentId: string): Promise<number> {
  const since = Date.now() - 24 * 3600 * 1000;
  if (supabase) {
    const { data, error } = await supabase
      .from("merrymen_trades")
      .select("amount_usdg")
      .eq("agent_id", agentId)
      .eq("status", "landed")
      .gte("created_at", new Date(since).toISOString());
    if (!error && data) return data.reduce((s, r) => s + Number(r.amount_usdg), 0);
  }
  return readJsonl<TradeRow>("trades.jsonl")
    .filter(
      (t) =>
        t.agent_id === agentId &&
        t.status === "landed" &&
        new Date(t.created_at).getTime() > since,
    )
    .reduce((s, t) => s + t.amount_usdg, 0);
}
