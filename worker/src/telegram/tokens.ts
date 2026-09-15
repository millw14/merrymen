/**
 * Custom-token staging for Telegram — the settings half of /addtoken,
 * /discover and /tokens (parsing lives in interpreter.ts, replies in
 * executor.ts).
 *
 * DURABILITY HAS TWO BACKINGS, and picking the wrong one is silent data loss:
 * self-host settings live in settings.json (patchSettingsFile, re-read every
 * tick), while a hosted child's settings.json is rewritten wholesale from the
 * tenant store every ~15s — a file write there is undone before the owner can
 * use it. So hosted writes go to the tenant store (the orchestrator pushes
 * them back down within a pass); self-host writes go to the file. Same shape
 * as the /link allowlist union before it.
 *
 * Nothing here touches grants, walls, or keys. A staged token is inert until
 * a dashboard re-sign covers it — the grant gate is downstream of all of this.
 */
import { isValidCustomToken, type CustomToken } from "../../../packages/core/src/tokens";
import { isHostedMode } from "../../../packages/core/src/index";
import { getSettingsStore } from "../settings-store";
import { patchSettingsFile } from "../settings";

/** Mirrors web/src/app/api/settings/route.ts — each token costs an on-chain read every tick. */
export const MAX_CUSTOM_TOKENS = 50;

export interface StagedToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

/**
 * Shape-check a candidate against the current list. Pure — no chain, no disk —
 * so the on-chain metadata (decimals, canonical symbol) arrives as an argument
 * the caller read first. Rejects duplicates by address (case-insensitive):
 * the address is the identity, the symbol is display.
 */
export function stageToken(
  existing: readonly CustomToken[],
  address: string,
  symbol: string | undefined,
  meta: { decimals: number; symbol: string } | { error: string },
): { ok: true; token: StagedToken } | { ok: false; reason: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, reason: "that isn't a contract address — 0x followed by 40 hex characters." };
  }
  const dup = existing.find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (dup) return { ok: false, reason: `already listed as ${dup.symbol} — nothing staged.` };
  if (existing.length >= MAX_CUSTOM_TOKENS) {
    return { ok: false, reason: `token list is full (${MAX_CUSTOM_TOKENS}) — remove one in settings first.` };
  }
  if ("error" in meta) return { ok: false, reason: `couldn't read that contract: ${meta.error}` };
  const sym = (symbol ?? meta.symbol ?? "").toUpperCase();
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(sym)) {
    return { ok: false, reason: "need a symbol of 1–16 chars (letters/numbers/._-): /addtoken 0x… <SYMBOL>." };
  }
  const token: StagedToken = { symbol: sym, address: address as `0x${string}`, decimals: meta.decimals };
  if (!isValidCustomToken(token)) return { ok: false, reason: "that entry fails token validation." };
  return { ok: true, token };
}

/**
 * Durable settings write for bot-initiated token/discovery changes.
 * Hosted: read-modify-write the tenant's sealed store record (the supervisor
 * pushes it back to the child within a pass). Self-host: patch settings.json
 * (re-read every tick). Returns ok:false with a reason instead of throwing —
 * the caller turns it into one honest chat line.
 */
export async function saveTokenSettings(
  tenant: `0x${string}` | null,
  patch: { customTokens?: CustomToken[]; discoveryEnabled?: boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (isHostedMode()) {
      if (!tenant) return { ok: false, reason: "no agent armed here yet — grant one in the dashboard first." };
      const store = getSettingsStore();
      const prev = (await store.get(tenant)) ?? {};
      await store.put(tenant, { ...prev, ...patch });
    } else {
      patchSettingsFile(patch);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
