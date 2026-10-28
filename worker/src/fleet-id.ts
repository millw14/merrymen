/**
 * ONE PARSER FOR THE FLEET'S TENANT AND AGENT IDS (Solana integration, phase 0).
 *
 * Every fleet id has been a Robinhood Chain address, 0x and 40 hex. Each path
 * that read one (the rollout, the accounting hold, the new-tenant record, the
 * resume variables, the homes on the volume, the operator one-shots) checked
 * that shape itself and passed over anything else without a word. Solana agent
 * ids (`sol:<owner pubkey>`, docs/solana-integration.md) will not have it. A
 * kill or a hold that passed over one would leave it unnoticed, and a scope
 * list that dropped one could widen to the whole fleet.
 *
 * So each of those paths asks this, and has three answers to handle:
 *
 *   evm          the id, lowercased: the only kind this build acts for.
 *   unsupported  any other id, kept exactly as written (Solana ids are
 *                case-sensitive). The caller says so loudly and fails closed:
 *                a kill, drain or hold treats it as must-stop, and admission
 *                refuses it.
 *   null         not an id at all: not a string, or empty.
 *
 * Nothing is trimmed or case-folded here. A caller that trimmed or lowercased
 * an operator's value before checking it still does, first, so each keeps
 * exactly the 0x spellings it accepted before.
 */
import { CHAINS, canonicalId } from "../../packages/core/src/ids";

export type FleetId =
  | { kind: "evm"; id: `0x${string}` }
  | { kind: "unsupported"; raw: string };

/** A fleet id: a 0x address (lowercased), any other id (as written), or null. */
export function parseFleetId(raw: unknown): FleetId | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // canonicalId trims; a fleet id with whitespace in it is not one.
  const id = raw.trim() === raw ? canonicalId(CHAINS.robinhood, "account", raw) : null;
  return id ? { kind: "evm", id: id as `0x${string}` } : { kind: "unsupported", raw };
}

/** The 0x id, or null for anything else. */
export function evmFleetId(raw: unknown): `0x${string}` | null {
  const id = parseFleetId(raw);
  return id?.kind === "evm" ? id.id : null;
}

/**
 * An unsupported id as a log names it: quoted (so a stray newline or control
 * character cannot forge a line), cut to 80 characters, and called a Solana id
 * when it is one, bare or as `sol:<pubkey>`.
 */
export function unsupportedFleetIdLabel(raw: string): string {
  const body = raw.startsWith("sol:") ? raw.slice(4) : raw;
  const solana = body.trim() === body && canonicalId(CHAINS.solana, "account", body) !== null;
  const shown = JSON.stringify(raw.length > 80 ? `${raw.slice(0, 80)}…` : raw);
  return solana ? `Solana id ${shown}` : `id ${shown}`;
}

/**
 * AN OPERATOR VARIABLE NAMING ONE TENANT (the class switches, the inspector):
 * its id, null when unset or blank, or a refusal to log. Trimmed and
 * lowercased first, as those variables always were. The refusal names the
 * variable, never its value.
 */
export function fleetIdTarget(name: string, raw: string | undefined): { id: `0x${string}` } | { refused: string } | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  const id = evmFleetId(value);
  return id ? { id } : { refused: `${name} is not a Robinhood Chain tenant address (0x and 40 hex) — refusing to guess; this build acts for no other chain` };
}

/**
 * AN OPERATOR VARIABLE NAMING SOME TENANTS OR ACCOUNTS (a repair's scope, the
 * phantom-profit list): every id it names, lowercased, or a refusal naming the
 * first entry that is not one, by position. Blank entries are passed over, as
 * they always were.
 *
 * Any other entry that is not a 0x address refuses the whole value. Each of
 * these lists used to keep only the entries starting with 0x, so a value
 * naming none came out empty, and an empty scope reads as the whole fleet: a
 * report of every tenant, or for the high-water-mark repair, an apply to
 * every tenant.
 */
export function fleetIdScope(name: string, raw: string | undefined): { ids: ReadonlySet<`0x${string}`> } | { refused: string } {
  const ids = new Set<`0x${string}`>();
  const entries = (raw ?? "").split(",").map((entry) => entry.trim().toLowerCase());
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const id = evmFleetId(entries[i]);
    if (!id) {
      return { refused: `${name} entry ${i + 1} is not a Robinhood Chain address (0x and 40 hex) — refusing the whole list rather than run on part of it; this build acts for no other chain` };
    }
    ids.add(id);
  }
  return { ids };
}
