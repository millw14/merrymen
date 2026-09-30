/**
 * An agent's status, as the shared ledger recorded it.
 *
 * Read-only over the mirrored `agents`, `equity` and `events` rows for the
 * agent's accounts. Every timestamp is the one the worker wrote, so a reader
 * can tell a quiet agent from a stale record. Worker liveness uses ONE rule,
 * the orchestrator watchdog's: a heartbeat is fresh when it is younger than
 * max(180 s, 2 × tick + 90 s).
 */
import { liveBlockerText, type RefuseRule } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { blockerAdvice } from "../live-blocker";
import type { SettingsView } from "./settings-view";

export type AgentStatusWord = "armed" | "active" | "killed" | "expired" | "error" | "unknown";
export type ModeWord = "paper" | "live" | "idle" | "unknown";

export interface AgentLedgerRow {
  smart_account: string;
  name: string | null;
  chain_id: number | null;
  status: string | null;
  mode: string | null;
  beat_at: number | null;
  live_blocker: string | null;
  sponsor_gas: number | null;
  epoch: number | null;
  granted_at: number | null;
  expires_at: number | null;
  contributions_known: number | null;
  contributions_why: string | null;
}

export interface FreshnessView {
  /** When the worker last reported it was alive (tick start). */
  heartbeat_at: number | null;
  heartbeat_age_s: number | null;
  /** Heartbeat younger than max(180, 2 × tick + 90) seconds. */
  worker_fresh: boolean | null;
  fresh_within_s: number;
  /** The last complete valuation (an equity mark), the best evidence of a successful cycle. */
  last_valuation_at: number | null;
  last_valuation_book: "paper" | "live" | null;
  last_decision_at: number | null;
  last_trade_at: number | null;
}

export interface AgentStatusView {
  account: string;
  name: string | null;
  chain_id: number | null;
  status: AgentStatusWord;
  mode: ModeWord;
  live_blocker: { rule: string; text: string; owner_can_fix: boolean; is_fault: boolean } | null;
  sponsor_gas: boolean | null;
  epoch: number | null;
  freshness: FreshnessView;
}

const STATUS = new Set(["armed", "active", "killed", "expired", "error"]);
const MODES = new Set(["paper", "live", "idle"]);
const KNOWN_RULES = new Set<RefuseRule>(["not-armed", "dead-policy", "grant-too-wide", "no-executor", "live-not-enabled", "wrong-chain", "no-gas", "no-cash"]);

export function freshWithin(tickSeconds: number | null | undefined): number {
  const tick = typeof tickSeconds === "number" && tickSeconds > 0 ? tickSeconds : 240;
  return Math.max(180, 2 * tick + 90);
}

export function blockerView(rule: string | null): AgentStatusView["live_blocker"] {
  if (!rule) return null;
  const advice = blockerAdvice(rule);
  const text = KNOWN_RULES.has(rule as RefuseRule) ? liveBlockerText(rule as RefuseRule) : `the worker reports "${rule.slice(0, 40)}"`;
  return { rule: rule.slice(0, 40), text, owner_can_fix: !!advice && (advice.funding || advice.resign), is_fault: advice?.fault ?? true };
}

/** Accounts are lowercase; the ledger's agent_id spelling is not normalised, so compare lowercased. */
export async function readAgentRow(db: Db, account: string): Promise<AgentLedgerRow | null> {
  return (await db.prepare(`SELECT smart_account, name, chain_id, status, mode, beat_at, live_blocker, sponsor_gas, epoch,
      granted_at, expires_at, contributions_known, contributions_why
    FROM agents WHERE lower(smart_account) = ? LIMIT 1`).get(account.toLowerCase()) as AgentLedgerRow | undefined) ?? null;
}

export async function readFreshness(db: Db, account: string, row: AgentLedgerRow | null, tickSeconds: number | null, now: number): Promise<FreshnessView> {
  const a = account.toLowerCase();
  const equity = await db.prepare("SELECT at, mode FROM equity WHERE lower(agent_id) = ? ORDER BY at DESC LIMIT 1").get(a) as { at: number; mode: string | null } | undefined;
  const decision = await db.prepare("SELECT MAX(at) AS at FROM decisions WHERE lower(agent_id) = ?").get(a) as { at: number | null } | undefined;
  const trade = await db.prepare("SELECT MAX(created_at) AS at FROM trades WHERE lower(agent_id) = ? AND status IN ('landed','paper')").get(a) as { at: number | null } | undefined;
  const within = freshWithin(tickSeconds);
  const beat = row?.beat_at ?? null;
  const age = beat === null ? null : Math.max(0, now - beat);
  return {
    heartbeat_at: beat,
    heartbeat_age_s: age,
    worker_fresh: age === null ? null : age <= within,
    fresh_within_s: within,
    last_valuation_at: equity?.at ?? null,
    last_valuation_book: equity?.mode === "paper" || equity?.mode === "live" ? equity.mode : null,
    last_decision_at: decision?.at ?? null,
    last_trade_at: trade?.at ?? null,
  };
}

export async function readAgentStatus(db: Db, account: string, settings: SettingsView | null, now: number): Promise<AgentStatusView> {
  const row = await readAgentRow(db, account);
  const freshness = await readFreshness(db, account, row, settings?.tickSeconds ?? null, now);
  return {
    account: account.toLowerCase(),
    name: row?.name ?? settings?.agentName ?? null,
    chain_id: row?.chain_id ?? null,
    status: row?.status && STATUS.has(row.status) ? (row.status as AgentStatusWord) : "unknown",
    mode: row?.mode && MODES.has(row.mode) ? (row.mode as ModeWord) : "unknown",
    live_blocker: blockerView(row?.live_blocker ?? null),
    sponsor_gas: row?.sponsor_gas === null || row?.sponsor_gas === undefined ? null : row.sponsor_gas === 1,
    epoch: row?.epoch ?? null,
    freshness,
  };
}
