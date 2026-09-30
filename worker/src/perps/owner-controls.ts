/** Durable owner controls. Only an extension of the exact prior history may clear a halt. */
import { mergeRecoveries, readRecoveries } from "./owner-recovery-state";
import { createHash, randomUUID } from "node:crypto";

type Row = Record<string, unknown>;
export interface OwnerEntryEvent { nonce: string; halted: boolean; parent: string; hash: string }
export interface OwnerControls { v: 1; account: string; mode: "paper" | "live"; initialHalted: boolean; events: OwnerEntryEvent[] }
export const MAX_OWNER_CONTROLS = 4096;
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
export const initialOwnerControls = (account: string, mode: "paper" | "live", halted: boolean): string => JSON.stringify({ v: 1, account: account.toLowerCase(), mode, initialHalted: halted, events: [] });
const baseHash = (c: OwnerControls) => digest([c.v, c.account, c.mode, c.initialHalted]);
const eventHash = (c: OwnerControls, e: Omit<OwnerEntryEvent, "hash">) => digest([c.account, c.mode, e.parent, e.nonce, e.halted]);

export function readOwnerControls(value: unknown, account: string, mode: unknown): OwnerControls | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("perp owner control history is unreadable");
  let c: OwnerControls;
  try { c = JSON.parse(value) as OwnerControls; } catch { throw new Error("perp owner control history is unreadable"); }
  if (!c || c.v !== 1 || c.account !== account.toLowerCase() || c.mode !== mode || !["paper", "live"].includes(c.mode) || typeof c.initialHalted !== "boolean" || !Array.isArray(c.events) || c.events.length > MAX_OWNER_CONTROLS || Object.keys(c).some(k => !["v", "account", "mode", "initialHalted", "events"].includes(k))) throw new Error("perp owner control history binding failed");
  let parent = baseHash(c);
  const nonces = new Set<string>();
  for (const e of c.events) {
    if (!e || typeof e.nonce !== "string" || !/^[a-z0-9-]{36}$/.test(e.nonce) || nonces.has(e.nonce) || typeof e.halted !== "boolean" || e.parent !== parent || Object.keys(e).some(k => !["nonce", "halted", "parent", "hash"].includes(k)) || e.hash !== eventHash(c, e)) throw new Error("perp owner control history does not verify");
    nonces.add(e.nonce); parent = e.hash;
  }
  return c;
}
export const ownerControlHead = (value: unknown, account: string, mode: unknown): string | null => { const c = readOwnerControls(value, account, mode); return c ? c.events.at(-1)?.hash ?? baseHash(c) : null; };
export const controlsHalted = (c: OwnerControls) => c.events.at(-1)?.halted ?? c.initialHalted;

export function appendEntryControl(row: Row, halted: boolean): string {
  const account = String(row.agent_id).toLowerCase(), mode = row.mode as "paper" | "live";
  let c = readOwnerControls(row.owner_controls_json, account, mode);
  if (c && controlsHalted(c) !== (Number(row.entries_halted) === 1)) throw new Error("perp owner control state contradicts its history");
  c ??= { v: 1, account, mode, initialHalted: Number(row.entries_halted) === 1, events: [] };
  if (c.events.length >= MAX_OWNER_CONTROLS) throw new Error("perp owner control history reached its safety limit; manual migration is required");
  // Even an unchanged explicit control is recorded: it is a durable owner decision.
  const e = { nonce: randomUUID(), halted, parent: c.events.at(-1)?.hash ?? baseHash(c) };
  return JSON.stringify({ ...c, events: [...c.events, { ...e, hash: eventHash(c, e) }] });
}

/** Histories are immutable prefixes. An unrelated branch is a conflict, never a clear. */
export function mergeEntryControls(a: Row, b: Row): { owner_controls_json: string | null; entries_halted: number } {
  if (String(a.agent_id).toLowerCase() !== String(b.agent_id).toLowerCase() || a.mode !== b.mode) throw new Error("perp owner controls cross account");
  const left = readOwnerControls(a.owner_controls_json, String(a.agent_id), a.mode), right = readOwnerControls(b.owner_controls_json, String(b.agent_id), b.mode);
  for (const [row, c] of [[a, left], [b, right]] as const) if (c && controlsHalted(c) !== (Number(row.entries_halted) === 1)) throw new Error("perp owner control state contradicts its history");
  if (!left && !right) return { owner_controls_json: null, entries_halted: Number(a.entries_halted) === 1 || Number(b.entries_halted) === 1 ? 1 : 0 };
  if (!left || !right) {
    const c = (left ?? right)!;
    const legacy = left ? b : a;
    // A legacy halt has no exact revision, so even an apparently old root cannot authorize clearing it.
    if (Number(legacy.entries_halted) === 1 && !controlsHalted(c)) throw new Error("perp owner controls omit the existing halt");
    return { owner_controls_json: JSON.stringify(c), entries_halted: controlsHalted(c) ? 1 : 0 };
  }
  if (baseHash(left) !== baseHash(right)) throw new Error("perp owner controls have different roots");
  for (let i = 0; i < Math.min(left.events.length, right.events.length); i++) if (left.events[i]!.hash !== right.events[i]!.hash) throw new Error("perp owner controls have conflicting branches");
  const c = left.events.length >= right.events.length ? left : right;
  return { owner_controls_json: JSON.stringify(c), entries_halted: controlsHalted(c) ? 1 : 0 };
}

/** Retain newer controls and all retired keys when restoring an older checkpoint. */
export function preserveAccountControls<T extends Row>(incoming: T, held?: Row): T {
  if (!held) {
    const recoveries = readRecoveries(incoming.recoveries_json, String(incoming.agent_id));
    if (recoveries.length) {
      const retired = JSON.parse(String(incoming.retired_pubkeys ?? "[]")) as unknown;
      if (!Array.isArray(retired) || recoveries.some(r => r.retiredKeys.some(k => !retired.includes(k)))) throw new Error("perp recovery history lost retired keys");
    }
    const c = readOwnerControls(incoming.owner_controls_json, String(incoming.agent_id), incoming.mode);
    if (c && controlsHalted(c) !== (Number(incoming.entries_halted) === 1)) throw new Error("perp owner control state contradicts its history");
    return incoming;
  }
  const keys = (r: Row): string[] => {
    const v = JSON.parse(String(r.retired_pubkeys ?? "[]"));
    if (!Array.isArray(v) || v.some(k => typeof k !== "string" || !/^0x[a-f0-9]{80}$/.test(k))) throw new Error("perp retired keys are unreadable");
    return v;
  };
  const merged = { ...incoming, ...mergeEntryControls(held, incoming), ...mergeRecoveries(held, incoming), retired_pubkeys: JSON.stringify([...new Set([...keys(held), ...keys(incoming)])].sort()) };
  preserveAccountControls(merged);
  return merged;
}
