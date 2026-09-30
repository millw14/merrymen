/**
 * WHO THE OWNER'S AGENT IS, as /api/feed tells their own desk: its name, its
 * public id, its strategy and basket — and where the name was read from.
 *
 * Kept out of the route so the rules can be run rather than read. Every source
 * it touches is passed in (`IdentitySources`), so a test can stand in for the
 * settings store, the file and the identity store without a deploy — and the
 * route, which runs only on the server, is the one place that knows whether
 * this is the hosted deploy (client-env.test.ts keeps isHostedMode there).
 */
import { DEFAULT_AGENT_NAME, SETTINGS_DEFAULTS, type MerrymenSettings } from "@merrymen/core";

// The basket the WORKER actually defaults to when none is configured.
// TRADEABLE_SYMBOLS (14) was the registry of what CAN be traded, not the
// default holding — so a tenant on defaults was shown 14 symbols while their
// agent traded three.
export const DEFAULT_BASKET = [...SETTINGS_DEFAULTS.basketSymbols];

/**
 * WHERE THE NAME CAME FROM.
 *
 *   settings  the owner configured it
 *   ledger    nothing is configured (the settings WERE read) and the ledger
 *             recorded it — so a "Robin" here really is the stock name
 *   fallback  the settings or the ledger could not be read, and the name is
 *             whatever was left. A "Robin" here says nothing about the agent.
 *
 * The one-tap "Name your agent" chip offers a new name only to a Robin that
 * was measured. On a fallback it would offer to overwrite a name the owner
 * already chose, because a failed read made it look unnamed.
 */
export type NameSource = "settings" | "ledger" | "fallback";

export interface FeedIdentity {
  slug?: string | null;
  name: string;
  nameSource: NameSource;
  strategy: string;
  basket: string[];
}

interface IdentitySettings {
  strategy: string;
  basket: string[];
  agentName: string | null;
  /** Whether the settings were read. False is the fallback, and says nothing. */
  read: boolean;
}

export const IDENTITY_FALLBACK: IdentitySettings = {
  strategy: "steady-basket",
  basket: DEFAULT_BASKET,
  agentName: null,
  read: false,
};

/** The three identity fields out of a settings blob, whatever store it came from. */
function pickIdentity(s: MerrymenSettings): IdentitySettings {
  return {
    strategy: typeof s.strategy === "string" && s.strategy ? s.strategy : "steady-basket",
    basket: Array.isArray(s.basketSymbols) && s.basketSymbols.length ? s.basketSymbols : DEFAULT_BASKET,
    agentName: typeof s.agentName === "string" && s.agentName ? s.agentName : null,
    read: true,
  };
}

/** Everything identity is read from. The route passes the real ones. */
export interface IdentitySources {
  hosted: () => boolean;
  /** The tenant's sealed settings; null when they have saved none. */
  settingsOf: (tenant: `0x${string}`) => Promise<MerrymenSettings | null | undefined>;
  /** The self-hosted settings file's text. Throws as readFileSync does. */
  settingsFile: () => string;
  slugOf: (tenant: `0x${string}`) => Promise<string | null>;
}

/**
 * The configured strategy, basket and name — from WHERE THIS TENANT'S SETTINGS
 * ACTUALLY LIVE.
 *
 * THE BUG THIS EXISTS TO FIX, because it made a working feature look broken.
 * Hosted, a tenant's settings are written to the per-tenant sealed store
 * (`getSettingsStore().put(tenant, …)` in api/settings), and NOTHING ever writes
 * the web container's own `~/.merrymen/settings.json`. This function used to
 * read that file unconditionally, so on the hosted deploy the read always threw
 * and every tenant got the fallback below: name null → the console fell back to
 * the ledger's "Robin", and strategy/basket were the defaults no matter what
 * they had configured. An owner could rename their agent, watch the save
 * succeed, reload, and be asked to name it again — four times over, in the
 * report that found this. The write was never the problem; nobody read it back.
 *
 * Self-hosted the file IS the store, which is why this passed local testing.
 * The `!tenant` early return is load-bearing: it must not fall through to the
 * file read, or a signed-out caller would be shown container-global config.
 *
 * A self-hosted install with no settings file has configured nothing, which is
 * a fact about it rather than a failed read.
 */
export async function readIdentitySettings(
  tenant: `0x${string}` | null,
  src: IdentitySources,
): Promise<IdentitySettings> {
  if (src.hosted()) {
    if (!tenant) return IDENTITY_FALLBACK;
    try {
      return pickIdentity((await src.settingsOf(tenant)) ?? {});
    } catch {
      return IDENTITY_FALLBACK;
    }
  }
  let raw: string;
  try {
    raw = src.settingsFile();
  } catch (e) {
    return (e as { code?: string } | null)?.code === "ENOENT" ? pickIdentity({}) : IDENTITY_FALLBACK;
  }
  try {
    // BOM-strip: hand-edited or PowerShell-written files may carry a UTF-8 BOM.
    return pickIdentity(JSON.parse(raw.replace(/^﻿/, "")) as MerrymenSettings);
  } catch {
    return IDENTITY_FALLBACK;
  }
}

/**
 * The agent's name: what the owner CONFIGURED, else what the ledger recorded —
 * and which of those it was.
 *
 * The two can disagree for a while, and the settings value has to win. The
 * worker reconciles a configured name into the soul at arm time, so between
 * saving one and the worker's next arm the ledger still holds the old name —
 * and preferring the ledger there makes a rename that genuinely succeeded
 * revert to "Robin" on the next page load, which reads exactly like a failed
 * save. Settings is where the owner's intent lives; the soul is the runtime
 * seat that catches up to it.
 *
 * `fromLedger` is null when the ledger's name was not read.
 */
export function resolveAgentName(
  configured: string | null,
  settingsRead: boolean,
  fromLedger: string | null,
): { name: string; nameSource: NameSource } {
  if (configured) return { name: configured, nameSource: "settings" };
  if (fromLedger) return { name: fromLedger, nameSource: settingsRead ? "ledger" : "fallback" };
  return { name: DEFAULT_AGENT_NAME, nameSource: "fallback" };
}

/** Name + where it came from + public id + strategy + basket, the configured name preferred. */
export async function identityOf(
  fromLedger: string | null,
  tenant: `0x${string}` | null,
  src: IdentitySources,
): Promise<FeedIdentity> {
  const { agentName, read, strategy, basket } = await readIdentitySettings(tenant, src);
  const slug = tenant ? await src.slugOf(tenant).catch(() => null) : null;
  return { ...resolveAgentName(agentName, read, fromLedger), slug, strategy, basket };
}
