/**
 * An owner's settings as other surfaces may see them: an explicit ALLOWLIST
 * projection of the sealed settings blob.
 *
 * The settings store hands back everything, including the Telegram bot token,
 * provider API keys and the Telegram allowlist. A denylist would leak the next
 * secret field someone adds; this reads named, non-secret fields only, so a new
 * field is invisible here until someone decides it is safe.
 */
import { getSettingsStore } from "@merrymen/settings-store";

export interface SettingsView {
  agentName: string | null;
  strategy: string | null;
  assetMode: "all" | "stocks" | "crypto" | null;
  basketSymbols: string[];
  liveTradingEnabled: boolean;
  paperTradingEnabled: boolean;
  publicBook: boolean;
  slippageBps: number | null;
  maxImpactBps: number | null;
  tickSeconds: number | null;
  stopLossBps: number | null;
  takeProfitBps: number | null;
  buyPerTickUsdg: number | null;
  discoveryEnabled: boolean | null;
  scoutEnabled: boolean | null;
  scoutBudgetUsdg: number | null;
  launchBuying: { enabled: boolean; perEntryUsdg: number | null; maxPositions: number | null; maxHoldSec: number | null; minDepthUsdg: number | null };
  trencherLiveEnabled: boolean | null;
  telegram: {
    enabled: boolean;
    notifyEnabled: boolean;
    notifyEveryMin: number | null;
    digestHour: number | null;
    controlEnabled: boolean;
    maxActionUsdg: number | null;
  };
  /** Extra tokens the owner added: addresses and symbols only. */
  customTokens: Array<{ symbol: string; address: string }>;
}

export interface SettingsReader {
  settingsFor(tenant: `0x${string}`): Promise<SettingsView | null>;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export function projectSettings(raw: Record<string, unknown> | null | undefined): SettingsView | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw;
  const tokens = Array.isArray(s.customTokens) ? s.customTokens : [];
  const mode = s.assetMode;
  return {
    agentName: typeof s.agentName === "string" ? s.agentName.slice(0, 64) : null,
    strategy: typeof s.strategy === "string" ? s.strategy.slice(0, 64) : null,
    assetMode: mode === "all" || mode === "stocks" || mode === "crypto" ? mode : null,
    basketSymbols: Array.isArray(s.basketSymbols) ? s.basketSymbols.filter((x): x is string => typeof x === "string").slice(0, 50) : [],
    // Consent flags fail closed: only an explicit true counts.
    liveTradingEnabled: s.liveTradingEnabled === true,
    paperTradingEnabled: s.paperTradingEnabled !== false,
    publicBook: s.publicBook === true,
    slippageBps: n(s.slippageBps),
    maxImpactBps: n(s.maxImpactBps),
    tickSeconds: n(s.tickSeconds),
    stopLossBps: n(s.strategistStopLossBps),
    takeProfitBps: n(s.takeProfitBps),
    buyPerTickUsdg: n(s.buyPerTickUsdg),
    discoveryEnabled: b(s.discoveryEnabled),
    scoutEnabled: b(s.scoutEnabled),
    scoutBudgetUsdg: n(s.scoutBudgetUsdg),
    launchBuying: {
      enabled: s.classSnipeEnabled === true && (n(s.classPerEntryUsdg) ?? 0) > 0,
      perEntryUsdg: n(s.classPerEntryUsdg),
      maxPositions: n(s.classMaxPositions),
      maxHoldSec: n(s.classMaxHoldSec),
      minDepthUsdg: n(s.classMinDepthUsdg),
    },
    trencherLiveEnabled: b(s.trencherLiveEnabled),
    telegram: {
      enabled: s.telegramEnabled === true,
      notifyEnabled: s.telegramNotifyEnabled !== false,
      notifyEveryMin: n(s.telegramNotifyEveryMin),
      digestHour: n(s.telegramDigestHour),
      controlEnabled: s.telegramControlEnabled === true,
      maxActionUsdg: n(s.telegramMaxActionUsdg),
    },
    customTokens: tokens
      .filter((t): t is { symbol: string; address: string } => !!t && typeof t === "object" && typeof (t as { symbol?: unknown }).symbol === "string" && typeof (t as { address?: unknown }).address === "string")
      .slice(0, 50)
      .map((t) => ({ symbol: t.symbol.slice(0, 16), address: t.address.toLowerCase() })),
  };
}

export const storeSettingsReader: SettingsReader = {
  async settingsFor(tenant) {
    const raw = await getSettingsStore().get(tenant.toLowerCase() as `0x${string}`);
    return projectSettings(raw as unknown as Record<string, unknown> | null);
  },
};

let reader: SettingsReader = storeSettingsReader;
export function settingsReader(): SettingsReader {
  return reader;
}
export function setSettingsReaderForTest(r: SettingsReader | null): void {
  reader = r ?? storeSettingsReader;
}
