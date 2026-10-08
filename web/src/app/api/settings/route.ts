/**
 * Settings API — the web UI's write path to .data/settings.json, which the
 * worker re-reads every tick.
 *
 * Secrets NEVER travel back to the browser: GET returns { set, hint } for
 * key fields (hint = last 4 chars). On PUT, a secret field that is absent or
 * undefined means "keep what's stored"; empty string means "clear"; any other
 * string replaces it. Non-secret fields: null/empty clears back to default.
 */

import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths, merrymenHome } from "@merrymen/home";
import {
  HOSTED_FORBIDDEN_SETTING_FIELDS,
  LLM_PROVIDER_IDS,
  LLM_PROVIDERS,
  PERPS_DRIVERS,
  PERPS_STYLE_CATALOG,
  PERPS_LIVE_CONSENT_VERSION,
  PERPS_MARKETS_MAX,
  PERPS_NUM_BOUNDS,
  SECRET_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  SLIPPAGE_BPS_MAX,
  STOCK_TOKENS,
  TELEGRAM_GROUPS_CHATTINESS,
  isHostedMode,
  isPerpKey,
  isPerpsStyle,
  perpsStyleForDriver,
  isValidCustomToken,
  officialCoinsFor,
  perpsNumberOk,
  robinhoodChain,
  type LlmProviderInfo,
  type MerrymenSettings,
  type PerpsNumKey,
} from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { OWNER_CHANGED_SETTING, ownerMismatch } from "@/lib/order-owner";
import { parseAmount, settingDecimals } from "@/lib/parse-amount";
import { getSettingsStore } from "@merrymen/settings-store";
import { hasStoredGrant } from "@merrymen/grant-store";
import { agentNameSave } from "@/lib/settings-agent-name";
import { withoutEnergyReserve, withoutReserveBasket } from "@/lib/energy-reserve";

export const dynamic = "force-dynamic";

const DATA_DIR = merrymenHome();
const SETTINGS_FILE = homePaths.settings();

export interface SecretView {
  set: boolean;
  hint: string | null;
}

export interface SettingsView {
  // secrets, masked
  bundlerApiKey: SecretView;
  groqApiKey: SecretView;
  anthropicApiKey: SecretView;
  llmApiKey: SecretView;
  rialtoApiKey: SecretView;
  telegramBotToken: SecretView;
  telegramTranscribeKey: SecretView;
  virtualsApiKey: SecretView;
  bitqueryApiKey: SecretView;
  merrymenToken: SecretView;
  // everything else, verbatim (undefined = using env/default)
  values: Omit<MerrymenSettings, "bundlerApiKey" | "groqApiKey" | "anthropicApiKey" | "llmApiKey" | "rialtoApiKey" | "telegramBotToken" | "telegramTranscribeKey" | "virtualsApiKey" | "bitqueryApiKey" | "merrymenToken">;
  defaults: typeof SETTINGS_DEFAULTS;
  knownSymbols: string[];
  /**
   * THE VERIFIED COINS ACTUALLY LISTED ON THIS CHAIN, which is a different fact
   * from whether the setting is on. official-coins.ts: "An empty list is the
   * honest state for a chain with no verified listing, and is a different fact
   * from official coins are turned off — which is a setting." The screen had
   * only the setting, so it affirmed "coins are in your basket" on a chain where
   * the list is empty. A constant read; it costs nothing.
   */
  officialCoins: string[];
  strategies: { builtin: string[]; custom: string[] };
  /** The AI providers the brain can run on — powers the Settings picker. */
  llmProviders: LlmProviderInfo[];
  /**
   * WHOSE SETTINGS THESE ARE — the signed-in tenant the values were read for,
   * hosted; null self-hosted, where the box has one operator.
   *
   * The Settings form sends it back with its save, and the PUT refuses a body
   * that names someone other than the session (409 OWNER_CHANGED_SETTING).
   * Another tab can sign a different wallet in unseen, and without this the
   * form open on screen — loaded for one wallet — saved its edits to the other
   * wallet's agent: "Trade for real" turned on for an agent its owner never
   * looked at, while this tab said "Changes saved". Carried in the same answer
   * as the values, so the claim is exactly whose values the form shows.
   *
   * "" when hosted and signed out: the form showed nobody's values, so its
   * save names nobody, and the PUT refuses it for whichever wallet signs in
   * before it goes out (a 7-day session can lapse with the page open).
   */
  owner: string | null;
}

const STRATEGIES_DIR = homePaths.strategies();
// Free + Merry Circle (holder-gated) builtins — both selectable; the worker runs
// the Circle ones only for $MERRYMEN holders. Mirrors worker/src/strategies/registry.ts.
const BUILTIN_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter", "perps-only"];

async function listCustomStrategies(): Promise<string[]> {
  try {
    const files = await readdir(STRATEGIES_DIR);
    return files
      .filter((f) => /\.(ts|mts|mjs|js)$/.test(f) && !f.startsWith("."))
      .map((f) => f.replace(/\.(ts|mts|mjs|js)$/, ""))
      .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

async function readStored(tenant?: `0x${string}` | null): Promise<MerrymenSettings> {
  // Hosted: a tenant's settings live in the per-tenant store, not the global
  // settings.json (which the child workers each have their own copy of).
  if (tenant) return (await getSettingsStore().get(tenant)) ?? {};
  try {
    // BOM-strip: hand-edited or PowerShell-written files may carry a UTF-8 BOM.
    return JSON.parse((await readFile(SETTINGS_FILE, "utf8")).replace(/^\ufeff/, "")) as MerrymenSettings;
  } catch {
    return {};
  }
}

function mask(value: string | undefined): SecretView {
  if (!value) return { set: false, hint: null };
  return { set: true, hint: value.length > 4 ? value.slice(-4) : "••••" };
}

/** ASCII sentinel that cannot appear in a real URL path — encoding-robust
 * (a unicode marker can get mangled across clients and defeat the keep-guard). */
const REDACT_MARK = "[key hidden]";
/**
 * Bundler/RPC URLs routinely embed an API key (Pimlico: ?apikey=…; Alchemy:
 * /v2/<KEY> in the path). Never return them verbatim — show scheme+host so the
 * user recognizes the provider, hide the rest behind the sentinel. The PUT
 * handler treats an incoming value carrying the sentinel as "keep", so this
 * round-trips safely (and the UI shows it as a placeholder, not an editable value).
 */
function redactUrl(u: unknown): string | undefined {
  if (typeof u !== "string" || u === "") return u as undefined;
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}/${REDACT_MARK}`;
  } catch {
    return REDACT_MARK;
  }
}

export async function GET(req: Request) {
  // Hosted: show the signed-in tenant's own settings (a signed-out caller sees
  // defaults — nothing personal, no secrets). Self-hosted: the single file.
  const tenant = isHostedMode() ? tenantOf(req) : null;
  const stored: MerrymenSettings = isHostedMode() && !tenant ? {} : await readStored(tenant);
  const { bundlerApiKey, groqApiKey, anthropicApiKey, llmApiKey, rialtoApiKey, telegramBotToken, telegramTranscribeKey, virtualsApiKey, bitqueryApiKey, merrymenToken, ...values } = stored;
  const servedTokens = withoutEnergyReserve(values.customTokens);
  // These URL fields can embed API keys — redact before they leave the server.
  const safeValues = {
    ...values,
    bundlerUrl: redactUrl(values.bundlerUrl),
    rpcMainnet: redactUrl(values.rpcMainnet),
    rpcTestnet: redactUrl(values.rpcTestnet),
    telegramTranscribeBase: redactUrl(values.telegramTranscribeBase),
    // Every signer builds its wall from this list — an old iOS engine or a
    // stale tab would seal $MERRYMEN from it and be refused (energy-reserve.ts).
    customTokens: servedTokens,
    // AND THE BASKET SYMBOL ONLY THAT RESERVE ENTRY SUPPLIED, or every client
    // that saves both fields is refused for a coin its own list no longer
    // has (energy-reserve.ts withoutReserveBasket). Read-side, like the above.
    basketSymbols: withoutReserveBasket(values.basketSymbols, values.customTokens, selectableSymbols(servedTokens)),
  };
  const view: SettingsView = {
    bundlerApiKey: mask(bundlerApiKey),
    groqApiKey: mask(groqApiKey),
    anthropicApiKey: mask(anthropicApiKey),
    llmApiKey: mask(llmApiKey),
    rialtoApiKey: mask(rialtoApiKey),
    telegramBotToken: mask(telegramBotToken),
    telegramTranscribeKey: mask(telegramTranscribeKey),
    virtualsApiKey: mask(virtualsApiKey),
    bitqueryApiKey: mask(bitqueryApiKey),
    merrymenToken: mask(merrymenToken),
    values: safeValues,
    defaults: SETTINGS_DEFAULTS,
    knownSymbols: STOCK_TOKENS.map((t) => t.symbol),
    officialCoins: officialCoinsFor(robinhoodChain.id).map((c) => c.symbol),
    strategies: { builtin: BUILTIN_STRATEGIES, custom: await listCustomStrategies() },
    llmProviders: LLM_PROVIDERS,
    owner: isHostedMode() ? (tenant ?? "") : null,
  };
  return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
}

const KNOWN_SYMBOLS = new Set(STOCK_TOKENS.map((t) => t.symbol));
/** What a basket may name: the registry's stocks plus these custom tokens' symbols — the PUT's own rule. */
function selectableSymbols(custom: unknown): Set<string> {
  const customSymbols = Array.isArray(custom) ? custom.filter(isValidCustomToken).map((t) => t.symbol) : [];
  return new Set([...KNOWN_SYMBOLS, ...customSymbols]);
}
const URL_FIELDS = ["bundlerUrl", "rpcMainnet", "rpcTestnet"] as const;

const NUM_FIELDS: Record<string, [number, number]> = {
  // Imported, never a literal. This entry and the worker's own clamp are two
  // enforcement points for one rule, and they read 5_000 and 5_000 while the
  // rule they were meant to express was never written down anywhere.
  slippageBps: [1, SLIPPAGE_BPS_MAX],
  // 0 is a MEANINGFUL low bound here, not a typo: it is the impact guard's
  // off switch, and the guard's own rejection message tells owners to raise
  // this setting — which was impossible while it was missing from this list.
  maxImpactBps: [0, 10_000],
  perfFeeBps: [0, 5_000],
  tickSeconds: [15, 3_600],
  buyPerTickUsdg: [1, 100_000],
  // SELL A LEG ONCE IT IS THIS FAR AHEAD OF WHAT IT COST. 0 disables it, which
  // is the default — this is the only exit the default strategy has, and until
  // an owner names a number it accumulates and never realises anything.
  //
  // ABSENT FROM THIS LIST IS THE SAME AS NOT EXISTING. The setting was added to
  // core and read by the worker, and a PUT carrying it was silently dropped
  // here — so it was unreachable from the app and could only ever have been set
  // by an env var nobody has. Same failure `maxImpactBps` records two lines up.
  takeProfitBps: [0, 1_000_000],
  // The strategist floor. 0 is off and the default; 10_000 bps is 100%, which
  // is also off. A tight floor on a small ticket pays the chain to churn — gas
  // is 0.44-0.78 USDG a leg, so a 10 USDG round trip is 9-16% of notional.
  strategistStopLossBps: [0, 10_000],
  idleFloorUsdg: [0, 1_000_000],
  gapEnterBudgetUsdg: [1, 1_000_000],
  paperStartUsdg: [1, 10_000_000],
  llmIntervalMin: [1, 1_440],
  llmMaxActionUsdg: [1, 100_000],
  telegramMaxActionUsdg: [1, 100_000],
  telegramTransferDailyUsdg: [1, 1_000_000],
  telegramDigestHour: [0, 23],
  telegramNotifyEveryMin: [0, 1440],
  telegramAgentMaxSteps: [1, 60],
  // Manipulation guards for DEX-priced tokens. The floor may be lowered to 0,
  // but that is the owner explicitly accepting a price anyone can push.
  minPoolLiquidityUsdg: [0, 100_000_000],
  maxPriceDivergenceBps: [10, 10_000],
  // The size floor for a memecoin. 0 is the off switch and the default, so a
  // tenant who never touches it sees exactly the discovery feed they saw before.
  memecoinMinFdvUsd: [0, 1_000_000_000_000],
  // Scout ceilings. 0 is a meaningful floor — it's the off switch for the
  // budget independently of the enable flag, so both have to allow it.
  discoveryIntervalMin: [1, 1440],
  // How many model calls one research session may make before it must decide.
  // Bounded here as well as defaulted, because this number IS the cost of
  // deskEnabled and an owner turning that on should be able to size it.
  deskMaxSteps: [1, 12],
  scoutBudgetUsdg: [0, 1_000_000],
  scoutPerTokenUsdg: [0, 1_000_000],
  // THE CLASS ROUTE. Bounded here as well as defaulted, for the reason
  // deskMaxSteps is: these numbers ARE the exposure an owner is choosing.
  //
  // And present here at all because this handler is the only writer of the
  // hosted tenant store — a field missing from this file is silently dropped
  // while the PUT returns {ok:true}, which is exactly what happened to
  // ponsAdapterAddress and made its deploy script and runbook impossible to
  // follow.
  classPerEntryUsdg: [0, 1_000_000],
  classMaxPositions: [0, 1_000],
  classMaxHoldSec: [60, 30 * 86_400],
  classMinDepthUsdg: [0, 10_000_000],
  // The class exit by curve progress: the worker's clamp (settings.ts, 1-100)
  // and the chat spec's bounds. It was missing, so a change approved from an
  // assistant or saved from a client came back {ok:true, ignored:[…]} and
  // the owner's exit never moved (spec-coverage.test.ts holds the two lists equal).
  classExitAtGraduationPct: [1, 100],
  // PERPETUALS (docs/perps.md "Settings"). Spread from core, NEVER retyped:
  // the worker clamps with the same table, so the two enforcement points
  // cannot come to read different numbers. Each also carries a GRID (whole
  // leverage, counts and bps; hundredths of a USDG or a percent), checked in
  // the loop below, because perps.ts refuses a fractional bps at open time and
  // a value this route stored would then be an agent that silently stops.
  ...(Object.fromEntries(
    Object.entries(PERPS_NUM_BOUNDS).map(([k, b]) => [k, [b.min, b.max]]),
  ) as Record<PerpsNumKey, [number, number]>),
};
/** A key of NUM_FIELDS that is a perps number (so its grid applies), or null. */
function perpsNumKey(key: string): PerpsNumKey | null {
  return Object.hasOwn(PERPS_NUM_BOUNDS, key) ? (key as PerpsNumKey) : null;
}
const BOOL_FIELDS = [
  "paperTradingEnabled",
  // THE CONSENT FLAG, and it must be here or the "Start live trading" control
  // is a button that returns {ok:true} and changes nothing — the exact silent
  // drop this file's own comment above warns about, on the one field where
  // failing silently means an owner believes they went live and did not.
  //
  // Tenant-settable ON PURPOSE, and therefore deliberately absent from core's
  // host-only allowlist beside sponsorGasEnabled: this is the owner's decision
  // about the owner's money, and the one thing the house must not decide for
  // them.
  "liveTradingEnabled",
  // LET THE STRATEGIST RESEARCH BEFORE IT DECIDES, instead of answering in one
  // shot from a fixed blob of numbers — it can pull depth, check what a
  // position cost, and read back its own past decisions before it commits.
  //
  // Unreachable from the app until now: in core, read by the worker, and absent
  // from this list, so a PUT carrying it came back ignored. It is the setting
  // that turns an agent from one that answers into one that THINKS, and no
  // owner could turn it on. Third field tonight with the same shape —
  // takeProfitBps and this one were both real capabilities nobody could reach.
  //
  // Off by default and it stays off by default: it costs up to `deskMaxSteps`
  // model calls per window instead of one, and the scout consumed a day's
  // shared token allowance on 2026-08-31 doing exactly this kind of loop.
  "deskEnabled",
  "telegramEnabled",
  "telegramControlEnabled",
  "telegramTransferEnabled",
  "telegramNotifyEnabled",
  "telegramPcControlEnabled",
  "telegramAgentEnabled",
  "telegramAgentAutoShell",
  "virtualsEnabled",
  "trencherLiveEnabled",
  "trencherFastEnabled",
  "scoutEnabled",
  // BUYING A TOKEN NOBODY ENUMERATED. See MerrymenSettings.classSnipeEnabled
  // for what this actually permits. It is a SECOND decision on top of sealing a
  // class vault at /grant — the signature says the key could reach class
  // tokens, this says go and do it — and both are required.
  "classSnipeEnabled",
  // THE ONLY ONE HERE THAT IS ON BY DEFAULT, so this entry is what lets an owner
  // turn something OFF rather than on — and a field missing from this list is
  // dropped with an {ok:true}, which for an opt-OUT means the owner's refusal is
  // discarded and the page tells them it saved. See
  // MerrymenSettings.officialCoinsEnabled.
  "officialCoinsEnabled",
  "discoveryEnabled",
  // TELEGRAM GROUPS (docs/tg-groups.md "Settings"). Both default ON, so — like
  // officialCoinsEnabled above — this entry is what makes OFF reachable: missing
  // here, an owner's "stop looking at coins people post" would come back
  // {ok:true, ignored} while the bot kept looking. Dashboard-only by design
  // (the chat refuses them, DASHBOARD_ONLY.telegramGroups), and tenant-settable:
  // how the owner's bot behaves in the owner's groups is the owner's call.
  "telegramGroupsEnabled",
  "telegramGroupCoinsEnabled",
  // PAPER PERPETUALS, the first of the two dashboard acts (docs/perps.md rule
  // 1). A plain switch: it risks no money by itself — real perps need the
  // consent record below, which is NOT here, because a boolean alone must never
  // be enough for that one. Off is never refused, and only ever stops opens.
  "perpsEnabled",
] as const;
/**
 * Switches whose OFF is written even when the rest of the save is refused
 * (see `offs` in PUT): paper perps, and the account's own live rail — "turning
 * any perps or live switch off is never refused" (docs/perps.md rule 8a). The
 * real-money perps consent is not a BOOL_FIELD; its withdrawal is recorded
 * where it is decided.
 */
const OFF_IS_NEVER_REFUSED: ReadonlySet<string> = new Set(["perpsEnabled", "liveTradingEnabled"]);
/** Telegram PC string-array allowlists: (field, per-entry maxLen). */
const STR_ARRAY_FIELDS: Record<string, number> = {
  telegramCapabilities: 24,
  telegramShellAllowlist: 200,
  telegramAppAllowlist: 128,
};

export async function PUT(req: Request) {
  let body: Partial<Record<keyof MerrymenSettings, unknown>>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: ["body is not JSON"] }, { status: 400 });
  }
  // THE OWNER WHO CONFIRMED, when a chat card sent this (lib/order-owner.ts).
  // Not a setting: taken off before anything below reads the body, so it is
  // never stored and never reported as an unknown key.
  const claimedOwner = (body as { owner?: unknown } | null)?.owner;
  if (body && typeof body === "object") delete (body as Record<string, unknown>).owner;
  // THE PERPS CONSENT STAMP IS THIS ROUTE'S OWN, taken off before anything
  // reads the body for the reason `owner` is: never stored from a request, and
  // never reported as an unknown key. A client that echoes back the stored value
  // changes nothing; one that sends another would backdate a consent, or keep an
  // old one looking fresh. It is written below, from this server's clock, only
  // at the moment consent is given.
  if (body && typeof body === "object") delete (body as Record<string, unknown>).perpsLiveConsentAt;

  let tenant: `0x${string}` | null = null;
  if (isHostedMode()) {
    // ── hosted settings lockdown ─────────────────────────────────────────
    // This route has no auth self-hosted (the localhost middleware is the
    // perimeter), so on a public URL it must gain one AND refuse the fields a
    // tenant may not own. Without the auth check, anyone could repoint the
    // bundler or flip on PC-control; without the field strip, an authenticated
    // tenant still could.
    tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ errors: ["not signed in"] }, { status: 401 });
    // FOR THE OWNER WHO CONFIRMED IT, OR NOT AT ALL — before any field is read
    // or written. Another tab can sign a different wallet in unseen, and a
    // chat card's change would otherwise be made to that wallet's agent. A
    // body that names nobody (the Settings screen's own form) is judged as before.
    if (ownerMismatch(claimedOwner, tenant)) return NextResponse.json({ errors: [OWNER_CHANGED_SETTING] }, { status: 409 });
    // Drop every house-key + remote-execution field before the handler sees it.
    // Silent strip, not a 4xx: a normal save echoes back masked/empty secret
    // fields, and rejecting the whole payload for their mere presence would break
    // saving strategy/basket. The forbidden fields simply do not take effect.
    for (const k of HOSTED_FORBIDDEN_SETTING_FIELDS) delete (body as Record<string, unknown>)[k];
  }

  const errors: string[] = [];
  const stored = await readStored(tenant);
  const next: MerrymenSettings = { ...stored };

  // Every settings key this request actually processed. Used at the end to
  // name what was DROPPED — see the note above the `ignored` computation.
  const touched = new Set<string>();
  const setOrClear = <K extends keyof MerrymenSettings>(key: K, value: MerrymenSettings[K] | undefined) => {
    touched.add(key as string);
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  // THE "OFF"S THIS BODY CARRIES, each as the change it makes. Turning a perps
  // or live switch off is never refused (docs/perps.md rules 1 and 8a), and
  // this handler is otherwise all-or-nothing: without these, an off beside an
  // unrelated bad value — the natural "untick every market and switch perps
  // off", or a stale number echoed back — came back 400 with real perps still
  // on. So when anything else in the save is refused, these alone are written
  // (over what was stored, never over the rest of the body) and the 400 says so.
  const offs: Array<{ key: string; apply: (s: MerrymenSettings) => void }> = [];

  // ── secrets: absent = keep, "" = clear, string = replace ────────────────
  for (const key of SECRET_SETTING_KEYS) {
    if (!(key in body) || body[key] === undefined) continue;
    const v = body[key];
    if (v === "" || v === null) setOrClear(key, undefined);
    else if (typeof v === "string" && v.trim().length >= 8) setOrClear(key, v.trim());
    else errors.push(`${key}: too short to be a real key`);
  }

  // ── URLs ────────────────────────────────────────────────────────────────
  for (const key of URL_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key];
    // GET redacts credential-carrying URLs behind a sentinel; if that echoes
    // back, keep the stored one — never overwrite a real URL with its redacted
    // display form.
    if (typeof v === "string" && v.includes(REDACT_MARK)) continue;
    if (v === "" || v === null || v === undefined) {
      setOrClear(key, undefined);
    } else if (typeof v === "string" && /^https?:\/\/.+/.test(v.trim())) {
      setOrClear(key, v.trim());
    } else {
      errors.push(`${key}: must be an http(s) URL`);
    }
  }

  // ── numbers ─────────────────────────────────────────────────────────────
  for (const [key, [min, max]] of Object.entries(NUM_FIELDS)) {
    const k = key as keyof MerrymenSettings;
    if (!(k in body)) continue;
    const v = body[k];
    const perps = perpsNumKey(key);
    // What a refusal says. A perps number names its grid too, so "2.5" for a
    // leverage reads as the whole-number rule it broke, not as out of range.
    const rule = perps
      ? `must be ${PERPS_NUM_BOUNDS[perps].decimals === 0 ? "a whole number" : "a number with at most 2 decimals"} between ${min} and ${max}`
      : `must be a number between ${min} and ${max}`;
    if (v === "" || v === null || v === undefined) {
      setOrClear(k, undefined);
    } else if (typeof v === "number") {
      // Already a number, so it came from a JSON client rather than a typed
      // field. There is no separator to interpret.
      if (perps ? perpsNumberOk(perps, v) : Number.isFinite(v) && v >= min && v <= max) setOrClear(k, v as never);
      else errors.push(`${key}: ${rule}`);
    } else if (perps) {
      // A typed perps number: the same locale-aware reading as below, at the
      // key's own grid rather than the suffix guess, then the same core check
      // the worker applies.
      const parsed = parseAmount(String(v), { maxDecimals: PERPS_NUM_BOUNDS[perps].decimals, min, max });
      if (parsed.ok && perpsNumberOk(perps, parsed.value)) setOrClear(k, parsed.value as never);
      else if (!parsed.ok && parsed.reason === "ambiguous") errors.push(`${key}: "${String(v)}" reads as either ${parsed.readings.join(" or ")}`);
      else errors.push(`${key}: ${rule}`);
    } else {
      // WAS `Number(v)`, AND THAT IS THE ONE PATH IN THIS APP THAT STORED A
      // WRONG NUMBER RATHER THAN REFUSING. Ten of the fields feeding this loop
      // are plain text inputs, so the owner's raw keystrokes arrive here
      // untouched — and `Number("25.000")` is 25, which sits well inside
      // minPoolLiquidityUsdg's [0, 100_000_000]. A German, Spanish, Italian,
      // Dutch, Brazilian or Turkish owner setting the price-manipulation guard
      // to twenty-five thousand stored twenty-five, in range, no error, while
      // the screen said "Changes saved".
      const parsed = parseAmount(String(v), { maxDecimals: settingDecimals(key), min, max });
      if (parsed.ok) setOrClear(k, parsed.value as never);
      else if (parsed.reason === "ambiguous") {
        // Two honest readings. Naming both is the only answer that does not
        // involve guessing which one the owner meant.
        errors.push(`${key}: "${String(v)}" reads as either ${parsed.readings.join(" or ")}`);
      } else errors.push(`${key}: must be a number between ${min} and ${max}`);
    }
  }

  // ── owner-added tokens (memecoins) ──────────────────────────────────────
  // Validated on the way in AND again in the worker's resolver — this endpoint
  // is the only thing between a webpage and the agent's token set, and an
  // address here eventually reaches a policy allowlist. Malformed entries are
  // REJECTED with an error rather than silently dropped, so a typo'd address is
  // visible instead of quietly ignored.
  if ("customTokens" in body) {
    const v = body.customTokens;
    if (v === "" || v === null || v === undefined) {
      setOrClear("customTokens", undefined);
    } else if (!Array.isArray(v)) {
      errors.push("customTokens: must be a list");
    } else if (v.length > 50) {
      errors.push("customTokens: at most 50 tokens (each costs an on-chain read every tick)");
    } else {
      const clean: { symbol: string; address: string; decimals: number }[] = [];
      const seen = new Set<string>();
      for (const [i, raw] of v.entries()) {
        if (!isValidCustomToken(raw)) {
          errors.push(`customTokens[${i}]: needs a symbol, a 0x address and decimals`);
          continue;
        }
        const key = raw.address.toLowerCase();
        if (seen.has(key)) {
          errors.push(`customTokens[${i}]: duplicate address ${raw.address}`);
          continue;
        }
        seen.add(key);
        clean.push({ symbol: raw.symbol, address: raw.address, decimals: raw.decimals });
      }
      if (!errors.length) setOrClear("customTokens", clean);
    }
  }

  // ── enums ───────────────────────────────────────────────────────────────
  if ("agentName" in body) {
    // The rule, the normalisation and the grandfathering of a stored "007"
    // live in lib/settings-agent-name.ts, where a test runs them. `stored` is
    // what this tenant's settings hold NOW, read above — never `next`, which
    // this same save may already have changed.
    const save = agentNameSave(body.agentName, stored);
    if (save.kind === "clear") setOrClear("agentName", undefined);
    else if (save.kind === "error") errors.push(save.message);
    else setOrClear("agentName", save.name);
  }

  if ("xHandle" in body) {
    // X's own rule: 1-15 of [A-Za-z0-9_]. One leading @ is stripped because that
    // is how people write it and refusing over a sigil is pedantry; anything else
    // is REFUSED rather than sanitised, so we never store a handle the owner did
    // not type. It is unverified either way — nothing checks they own it — which
    // is exactly why nothing may ever look an agent up by it.
    const v = body.xHandle;
    const norm = typeof v === "string" ? v.trim().replace(/^@/, "") : v;
    if (norm === "" || norm === null || norm === undefined) {
      setOrClear("xHandle", undefined);
    } else if (typeof norm !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(norm)) {
      errors.push("x handle: letters, numbers and underscores, up to 15 characters");
    } else {
      setOrClear("xHandle", norm);
    }
  }

  if ("strategy" in body) {
    const v = body.strategy;
    if (v === "" || v === null || v === undefined) {
      setOrClear("strategy", undefined);
    } else if (v === "perps-only" && stored.strategy !== "perps-only") {
      // This mode has no spot producer. Only a new account may select it:
      // replacing an armed spot strategy could remove its intrinsic exits.
      let grantPresent = true;
      try {
        if (tenant) grantPresent = await hasStoredGrant(tenant);
        else {
          try { await readFile(homePaths.grant(), "utf8"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") grantPresent = false; else throw error; }
        }
      } catch { /* Unknown existing authority refuses a strategy replacement. */ }
      if (grantPresent) errors.push("perps-only is for new accounts; keep your current spot strategy and configure Perpetuals separately");
      else setOrClear("strategy", "perps-only");
    } else if (typeof v === "string" && BUILTIN_STRATEGIES.includes(v)) {
      setOrClear("strategy", v as MerrymenSettings["strategy"]);
    } else if (!isHostedMode() && typeof v === "string" && (await listCustomStrategies()).includes(v)) {
      // Custom strategy files are self-hosted ONLY. Hosted, the loader refuses to
      // execute them (registry.ts fail-closed); rejecting the name here too means
      // the control plane never even stores it — the write-time half of the gate.
      setOrClear("strategy", v as MerrymenSettings["strategy"]);
    } else if (isHostedMode()) {
      errors.push("strategy: only built-in strategies are available on hosted merrymen");
    } else {
      errors.push(`strategy: not a builtin and no strategies/${String(v)}.ts file exists`);
    }
  }
  if ("swapVenue" in body) {
    const v = body.swapVenue;
    if (v === "" || v === null || v === undefined) setOrClear("swapVenue", undefined);
    else if (["uniswap", "rialto"].includes(v as string))
      setOrClear("swapVenue", v as MerrymenSettings["swapVenue"]);
    else errors.push("swapVenue: unknown venue");
  }

  // ── strings with light validation ──────────────────────────────────────
  if ("breakerAddress" in body) {
    const v = body.breakerAddress;
    if (v === "" || v === null || v === undefined) setOrClear("breakerAddress", undefined);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()))
      setOrClear("breakerAddress", v.trim());
    else errors.push("breakerAddress: must be a 0x… address");
  }
  if ("v4AdapterAddress" in body) {
    const v = body.v4AdapterAddress;
    if (v === "" || v === null || v === undefined) setOrClear("v4AdapterAddress", undefined);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()))
      setOrClear("v4AdapterAddress", v.trim());
    else errors.push("v4AdapterAddress: must be a 0x… address");
  }
  // THE PONS ADAPTER. Absent from this allowlist until now, which made the
  // deploy script's own instruction ("paste the address into /settings") and
  // docs/owner-runbook-pons.md impossible to follow: this handler is the only
  // writer of the hosted tenant store, and an unknown key returned {ok:true}
  // with the field silently dropped. See the unknown-key rejection below —
  // silent success is why a documented-but-unwired field went unnoticed.
  if ("ponsAdapterAddress" in body) {
    const v = body.ponsAdapterAddress;
    if (v === "" || v === null || v === undefined) setOrClear("ponsAdapterAddress", undefined);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()))
      setOrClear("ponsAdapterAddress", v.trim());
    else errors.push("ponsAdapterAddress: must be a 0x… address");
  }
  // THE CLASS VAULT FACTORY, which follows the note above rather than
  // rediscovering it: the field is here so /settings can actually write it, and
  // it is the FACTORY rather than a vault because a vault is CREATE2-salted with
  // one smart account — the signer derives each account's own from this.
  if ("ponsClassVaultFactory" in body) {
    const v = body.ponsClassVaultFactory;
    if (v === "" || v === null || v === undefined) setOrClear("ponsClassVaultFactory", undefined);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()))
      setOrClear("ponsClassVaultFactory", v.trim());
    else errors.push("ponsClassVaultFactory: must be a 0x… address");
  }
  // $MERRYMEN holder wallet — a read-only address for the Merry Circle fee tier.
  if ("holderAddress" in body) {
    const v = body.holderAddress;
    if (v === "" || v === null || v === undefined) setOrClear("holderAddress", undefined);
    else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim()))
      setOrClear("holderAddress", v.trim());
    else errors.push("holderAddress: must be a 0x… address");
  }
  if ("rialtoApiKeyHeader" in body) {
    const v = body.rialtoApiKeyHeader;
    if (v === "" || v === null || v === undefined) setOrClear("rialtoApiKeyHeader", undefined);
    else if (typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(v.trim()))
      setOrClear("rialtoApiKeyHeader", v.trim());
    else errors.push("rialtoApiKeyHeader: must be a plain header name");
  }
  if ("llmModel" in body) {
    const v = body.llmModel;
    if (v === "" || v === null || v === undefined) setOrClear("llmModel", undefined);
    else if (typeof v === "string" && /^[a-z0-9.-]{3,64}$/.test(v.trim()))
      setOrClear("llmModel", v.trim());
    else errors.push("llmModel: must be a model id like claude-opus-4-8");
  }
  // Groq model — the settings-page model field writes this when Groq is the
  // selected provider, so it must be persisted here (else the change is dropped).
  if ("groqModel" in body) {
    const v = body.groqModel;
    if (v === "" || v === null || v === undefined) setOrClear("groqModel", undefined);
    else if (typeof v === "string" && /^[a-z0-9.-]{3,64}$/.test(v.trim()))
      setOrClear("groqModel", v.trim());
    else errors.push("groqModel: must be a model id like qwen/qwen3.8-27b");
  }
  // AI provider selection — an id from the catalog (or "custom"), blank = legacy auto.
  if ("llmProvider" in body) {
    const v = body.llmProvider;
    if (v === "" || v === null || v === undefined) setOrClear("llmProvider", undefined);
    else if (typeof v === "string" && LLM_PROVIDER_IDS.includes(v)) setOrClear("llmProvider", v);
    else errors.push(`llmProvider: must be one of ${LLM_PROVIDER_IDS.join(", ")}`);
  }
  // Custom provider base URL — an OpenAI-compatible endpoint. Not credential-bearing
  // (the key rides the Authorization header), so it's shown/edited in the clear.
  if ("llmBaseUrl" in body) {
    const v = body.llmBaseUrl;
    if (v === "" || v === null || v === undefined) setOrClear("llmBaseUrl", undefined);
    else if (typeof v === "string" && /^https?:\/\/.+/.test(v.trim())) setOrClear("llmBaseUrl", v.trim());
    else errors.push("llmBaseUrl: must be an http(s) URL");
  }
  // Model id for the selected provider — looser than llmModel: vendor ids carry
  // slashes and uppercase (e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo).
  if ("llmProviderModel" in body) {
    const v = body.llmProviderModel;
    if (v === "" || v === null || v === undefined) setOrClear("llmProviderModel", undefined);
    else if (typeof v === "string" && /^[A-Za-z0-9._/:-]{2,96}$/.test(v.trim())) setOrClear("llmProviderModel", v.trim());
    else errors.push("llmProviderModel: must be a model id (letters, digits, . _ / : -)");
  }
  // PC files root — an absolute path (or blank to disable file ops).
  if ("telegramFilesRoot" in body) {
    const v = body.telegramFilesRoot;
    if (v === "" || v === null || v === undefined) setOrClear("telegramFilesRoot", undefined);
    else if (typeof v === "string" && v.trim().length <= 400) setOrClear("telegramFilesRoot", v.trim());
    else errors.push("telegramFilesRoot: must be a path");
  }
  if ("telegramTranscribeBase" in body) {
    const v = body.telegramTranscribeBase;
    if (typeof v === "string" && v.includes(REDACT_MARK)) {
      /* redacted echo — keep the stored value */
    } else if (v === "" || v === null || v === undefined) setOrClear("telegramTranscribeBase", undefined);
    else if (typeof v === "string" && /^https?:\/\/.+/.test(v.trim())) setOrClear("telegramTranscribeBase", v.trim());
    else errors.push("telegramTranscribeBase: must be an http(s) URL");
  }

  /**
   * ── asset mode ────────────────────────────────────────────────────────
   *
   * ITS OWN BRANCH, because it is a string enum and fits neither `BOOL_FIELDS`
   * nor `NUM_FIELDS`. A field missing from every branch here is "silently
   * dropped while the PUT returns {ok:true}" — this file's own warning, earned
   * three times already — and this is the one where the owner would be told
   * their agent had changed what it trades when it had not.
   *
   * Deliberately NOT in `HOSTED_FORBIDDEN_SETTING_FIELDS`: which kinds of thing
   * to trade is the owner's decision about the owner's money, unlike the house
   * keys and the sponsorship flag that list exists to protect.
   */
  if ("assetMode" in body) {
    const v = body.assetMode;
    if (v === null || v === undefined || v === "") setOrClear("assetMode", undefined);
    else if (v === "all" || v === "stocks" || v === "crypto") setOrClear("assetMode", v as never);
    else errors.push("assetMode: must be all, stocks or crypto");
  }

  /**
   * ── Telegram groups: how often it joins in ───────────────────────────
   *
   * ITS OWN BRANCH for the reason assetMode has one: a string enum fits
   * neither table, and a key no branch reads is dropped with {ok:true}.
   * Validated against core's one list, the same one the worker resolves with,
   * so a level this route accepts is never one the worker quietly reads as
   * "normal". Anything else is REFUSED rather than stored — the resolver would
   * silently fall back, and the screen would go on showing a level that is not
   * the one in force. Null or "" clears back to the default.
   */
  if ("telegramGroupsChattiness" in body) {
    const v = body.telegramGroupsChattiness;
    if (v === null || v === undefined || v === "") setOrClear("telegramGroupsChattiness", undefined);
    else if (typeof v === "string" && (TELEGRAM_GROUPS_CHATTINESS as readonly string[]).includes(v)) setOrClear("telegramGroupsChattiness", v as never);
    else errors.push("telegramGroupsChattiness: must be quiet, normal or chatty");
  }

  /**
   * ── the public book ──────────────────────────────────────────────────
   *
   * ITS OWN BRANCH, not a line in `BOOL_FIELDS`, because it is a DISCLOSURE
   * consent rather than a behaviour switch: turning it on puts this agent's
   * sizes and dollar P&L on a public URL. read-agent.ts had read it for months
   * while this handler had no branch, so an owner could not publish their book
   * at all — the PUT said {ok:true} and dropped the field.
   *
   * A real boolean or nothing. "false" is truthy to any reader that forgets
   * `=== true`, so a string is refused rather than coerced. Null clears back to
   * the default, which is private.
   *
   * Tenant-settable on purpose, like liveTradingEnabled: it is the owner's
   * decision about the owner's agent, and nothing the house may decide for them.
   */
  if ("publicBook" in body) {
    const v = body.publicBook;
    if (v === null || v === undefined) setOrClear("publicBook", undefined);
    else if (typeof v === "boolean") setOrClear("publicBook", v);
    else errors.push("publicBook: must be true or false");
  }

  // ── booleans (telegram toggles) ─────────────────────────────────────────
  for (const key of BOOL_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === undefined) setOrClear(key, undefined);
    else if (typeof v === "boolean") {
      setOrClear(key, v as never);
      // Only a switch that is on has an off to keep (every one defaults off).
      if (v === false && OFF_IS_NEVER_REFUSED.has(key) && stored[key] === true) offs.push({ key, apply: (s) => void (s[key] = false as never) });
    } else errors.push(`${key}: must be true or false`);
  }

  // ── telegram allowlist (numeric chat IDs) ───────────────────────────────
  if ("telegramAllowlist" in body) {
    const v = body.telegramAllowlist;
    if (v === null || v === undefined) {
      setOrClear("telegramAllowlist", undefined);
    } else if (Array.isArray(v)) {
      const ids = v.map((x) => (typeof x === "number" ? x : Number(x)));
      if (ids.some((n) => !Number.isFinite(n) || !Number.isInteger(n))) {
        errors.push("telegramAllowlist: chat IDs must be integers");
      } else if (ids.length > 50) {
        errors.push("telegramAllowlist: at most 50 chat IDs");
      } else {
        setOrClear("telegramAllowlist", ids as never);
      }
    } else {
      errors.push("telegramAllowlist: must be an array of chat IDs");
    }
  }

  // ── telegram PC string allowlists (capabilities / shell / app) ──────────
  for (const [key, maxLen] of Object.entries(STR_ARRAY_FIELDS)) {
    const k = key as keyof MerrymenSettings;
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === undefined) {
      setOrClear(k, undefined);
    } else if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((s) => s !== "");
      if (items.some((s) => s.length > maxLen)) errors.push(`${key}: each entry must be ≤ ${maxLen} chars`);
      else if (items.length > 50) errors.push(`${key}: at most 50 entries`);
      else setOrClear(k, items as never);
    } else {
      errors.push(`${key}: must be an array of strings`);
    }
  }

  // ── basket symbols ──────────────────────────────────────────────────────
  if ("basketSymbols" in body) {
    const v = body.basketSymbols;
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
      setOrClear("basketSymbols", undefined);
    } else if (Array.isArray(v)) {
      // Owner-added tokens are selectable too — a memecoin you added and can't
      // put in the basket is a memecoin nothing will ever trade. Validate
      // against the registry PLUS whatever customTokens this same request is
      // saving (or, absent that, what's already stored), so adding a token and
      // selecting it in one save works.
      const custom = ("customTokens" in body ? body.customTokens : stored.customTokens) ?? [];
      const selectable = selectableSymbols(custom);
      // A SYMBOL ONLY THE ENERGY RESERVE SUPPLIED IS DROPPED, NOT REFUSED. GET
      // no longer serves the reserve, so a client built on an older view (or a
      // stored basket that outlived its reserve entry) still sends MERRYMEN
      // with nothing left to select it by — refusing it left the owner a basket
      // they could not edit from any client (energy-reserve.ts).
      const legs = withoutReserveBasket(v as unknown[], [
        ...(Array.isArray(stored.customTokens) ? stored.customTokens : []),
        ...(Array.isArray(body.customTokens) ? body.customTokens : []),
      ], selectable) ?? [];
      const bad = legs.filter((s) => typeof s !== "string" || !selectable.has(s));
      if (bad.length > 0) errors.push(`basketSymbols: unknown symbols ${bad.join(", ")}`);
      else if (legs.length > 10) errors.push("basketSymbols: at most 10 legs");
      else setOrClear("basketSymbols", legs.length > 0 ? (legs as string[]) : undefined);
    } else {
      errors.push("basketSymbols: must be an array of symbols");
    }
  }

  /**
   * ── perpetuals: the driver ───────────────────────────────────────────
   *
   * ITS OWN BRANCH for the reason assetMode has one: a string enum fits neither
   * table, and a key no branch reads is dropped with {ok:true}. Validated
   * against core's one list, the one the worker resolves with. Null or ""
   * clears back to the default.
   */
  if ("perpsDriver" in body) {
    const v = body.perpsDriver;
    if (v === null || v === undefined || v === "") setOrClear("perpsDriver", undefined);
    else if (typeof v === "string" && (PERPS_DRIVERS as readonly string[]).includes(v)) setOrClear("perpsDriver", v as never);
    else errors.push(`perpsDriver: must be ${PERPS_DRIVERS.join(", ")}`);
  }

  if ("perpsStyle" in body) {
    const value = body.perpsStyle;
    if (value === null || value === undefined || value === "") setOrClear("perpsStyle", undefined);
    else if (isPerpsStyle(value)) setOrClear("perpsStyle", value);
    else errors.push(`perpsStyle: must be ${PERPS_STYLE_CATALOG.map(style => style.id).join(", ")}`);
  }
  if (("perpsStyle" in body || "perpsDriver" in body) &&
      !errors.some(error => error.startsWith("perpsStyle:") || error.startsWith("perpsDriver:")) &&
      !perpsStyleForDriver(next.perpsStyle ?? SETTINGS_DEFAULTS.perpsStyle, next.perpsDriver ?? SETTINGS_DEFAULTS.perpsDriver)) {
    errors.push("perpsStyle: this profile requires the deterministic perp-trend driver; Brain and strategist use Swing trend.");
  }

  /**
   * ── perpetuals: the markets ──────────────────────────────────────────
   *
   * Modelled on basketSymbols, and stricter in one place on purpose: AN
   * UNKNOWN KEY IS AN ERROR, NEVER DROPPED (docs/perps.md "Settings"). A basket
   * leg quietly dropped trades a little less; a perps list quietly shortened
   * reads "Changes saved" over a market set the owner did not choose. Keys only
   * — `BTC-PERP`, never `BTC`, which is a spot symbol and would be the
   * cross-wiring rule 11 forbids. Duplicates are refused rather than folded, so
   * what is stored is exactly what was sent.
   *
   * An EMPTY list is refused too, not read as "clear": unticking every market
   * and getting BTC and ETH back would be the default silently standing in for
   * a choice. Stopping perps is the switch's job, and null clears to the default
   * for the client that means that.
   */
  if ("perpsMarkets" in body) {
    const v = body.perpsMarkets;
    if (v === null || v === undefined) setOrClear("perpsMarkets", undefined);
    else if (!Array.isArray(v)) errors.push("perpsMarkets: must be a list of market keys like BTC-PERP");
    else if (v.length === 0) {
      // Beside the switch going off, an empty list is that same gesture (the
      // Perpetuals section unticked while switching off): the off says it all,
      // and the stored list is left for the day perps come back on.
      if (body.perpsEnabled === false) touched.add("perpsMarkets");
      else errors.push("perpsMarkets: pick at least one market (to stop perpetuals, switch them off instead)");
    }
    else {
      const shown = (k: unknown) => (typeof k === "string" ? k : JSON.stringify(k));
      const unknown = v.filter((k) => !isPerpKey(k));
      const twice = [...new Set(v.filter((k, i) => v.indexOf(k) !== i))];
      if (unknown.length > 0) errors.push(`perpsMarkets: unknown markets ${unknown.map(shown).join(", ")} (keys look like BTC-PERP)`);
      else if (twice.length > 0) errors.push(`perpsMarkets: listed more than once: ${twice.map(shown).join(", ")}`);
      else if (v.length > PERPS_MARKETS_MAX) errors.push(`perpsMarkets: at most ${PERPS_MARKETS_MAX} markets`);
      else setOrClear("perpsMarkets", v as string[]);
    }
  }

  // ONE OPEN IS NEVER LARGER THAN ALL OPENS TOGETHER. Judged on what this save
  // would leave stored (defaults filling the gaps), and only when it touches
  // either number — a stored pair from an older build must not make every
  // unrelated save fail. Skipped when either value was itself refused above,
  // so the owner reads one error, not two. The worker reads an inversion that
  // reaches it anyway in the restrictive direction.
  if (
    ("perpsPerTradeUsdg" in body || "perpsMaxOpenNotionalUsdg" in body) &&
    !errors.some((e) => e.startsWith("perpsPerTradeUsdg:") || e.startsWith("perpsMaxOpenNotionalUsdg:"))
  ) {
    const perTrade = next.perpsPerTradeUsdg ?? SETTINGS_DEFAULTS.perpsPerTradeUsdg;
    const open = next.perpsMaxOpenNotionalUsdg ?? SETTINGS_DEFAULTS.perpsMaxOpenNotionalUsdg;
    if (open < perTrade) {
      errors.push(`perpsMaxOpenNotionalUsdg: must be at least the per-trade limit (${perTrade} USDG) — one position can't be bigger than all of them together`);
    }
  }

  /**
   * ── perpetuals: the real-money consent ───────────────────────────────
   *
   * NOT A LINE IN BOOL_FIELDS, because a boolean is not a consent (docs/perps.md
   * rule 1). `perpsLiveEnabled: true` is accepted only in a request that also
   * carries `perpsLiveConsentVersion` equal to PERPS_LIVE_CONSENT_VERSION — the
   * text the Settings page showed — and `perpsRegionAttested: true`; this route
   * then stamps `perpsLiveConsentAt` from its own clock. The four are one
   * record, written together.
   *
   * WITHDRAWING IS NEVER REFUSED. `perpsLiveEnabled` false or null, or any part
   * of the consent withdrawn (attestation false or null, version null), clears
   * the whole record and nothing else in the body is consulted for it — a
   * malformed version beside an "off" must not keep an owner in, and neither
   * must a `perpsLiveEnabled: true` a client echoes back beside the unticked
   * attestation of an owner who has moved somewhere Lighter excludes. The
   * withdrawal is written even if something else in the save is refused
   * (`offs`). Off only stops opens; exits follow the venue (rule 8a).
   *
   * A BODY THAT REPEATS WHAT IS STORED CHANGES NOTHING, and is not refused: a
   * client round-tripping the settings blob on an unrelated save must neither
   * fail nor re-stamp the consent time. That includes a stored consent for an
   * older text — it is left exactly as it is, and the worker, which honours
   * only the current version, is what stops it counting. Anything else that
   * mentions these keys without giving consent is an error, named.
   */
  const CONSENT_KEYS = ["perpsLiveEnabled", "perpsLiveConsentVersion", "perpsRegionAttested"] as const;
  if (CONSENT_KEYS.some((k) => k in body)) {
    for (const k of CONSENT_KEYS) if (k in body) touched.add(k);
    const live = body.perpsLiveEnabled;
    const version = body.perpsLiveConsentVersion;
    const attested = body.perpsRegionAttested;
    const revoke = (to: false | undefined) => {
      setOrClear("perpsLiveEnabled", to);
      setOrClear("perpsLiveConsentVersion", undefined);
      setOrClear("perpsLiveConsentAt", undefined);
      setOrClear("perpsRegionAttested", undefined);
      // Only a record that exists has a withdrawal to keep.
      const hadRecord = (["perpsLiveEnabled", "perpsLiveConsentVersion", "perpsLiveConsentAt", "perpsRegionAttested"] as const).some((k) => stored[k] !== undefined);
      if (hadRecord) {
        offs.push({
          key: "perpsLiveEnabled",
          apply: (s) => {
            if (to === false) s.perpsLiveEnabled = false;
            else delete s.perpsLiveEnabled;
            delete s.perpsLiveConsentVersion;
            delete s.perpsLiveConsentAt;
            delete s.perpsRegionAttested;
          },
        });
      }
    };
    const switchOnRefusal = () =>
      version !== PERPS_LIVE_CONSENT_VERSION
        ? `perpsLiveEnabled: real-money perpetuals are switched on only with the current consent (version ${PERPS_LIVE_CONSENT_VERSION}), confirmed in Settings → Perpetuals on the dashboard`
        : "perpsLiveEnabled: real-money perpetuals are switched on only after you confirm you are not in a region Lighter excludes (the US, the UK, Canada, Switzerland, the UAE, Singapore or a sanctioned country)";
    const repeatsStored = (k: (typeof CONSENT_KEYS)[number]) => !(k in body) || (body[k] ?? undefined) === (stored[k] ?? undefined);

    // Withdrawals first, before any value beside them is type-checked.
    if ("perpsLiveEnabled" in body && (live === false || live === null || live === undefined)) {
      revoke(live === false ? false : undefined);
    } else if ("perpsLiveEnabled" in body && live !== true) {
      errors.push("perpsLiveEnabled: must be true or false");
    } else if (attested === false || attested === null || version === null) {
      // Part of the consent withdrawn: the whole record goes, WHATEVER the
      // switch beside it says. Only when there was no consent to withdraw is a
      // `perpsLiveEnabled: true` here an attempt to switch on without one —
      // and refused as that, by name.
      const wasOn = stored.perpsLiveEnabled === true;
      revoke(wasOn ? false : undefined);
      if (live === true && !wasOn) errors.push(switchOnRefusal());
    } else if (attested !== undefined && attested !== null && typeof attested !== "boolean") {
      errors.push("perpsRegionAttested: must be true or false");
    } else if (version !== undefined && version !== null && !(typeof version === "number" && Number.isSafeInteger(version) && version >= 1)) {
      errors.push("perpsLiveConsentVersion: must be the consent's version number");
    } else if (live === true) {
      if (stored.perpsLiveEnabled === true && repeatsStored("perpsLiveConsentVersion") && repeatsStored("perpsRegionAttested")) {
        // Already on, and the body only echoes the record: nothing to write.
      } else if (version !== PERPS_LIVE_CONSENT_VERSION || attested !== true) {
        errors.push(switchOnRefusal());
      } else {
        setOrClear("perpsLiveEnabled", true);
        setOrClear("perpsLiveConsentVersion", PERPS_LIVE_CONSENT_VERSION);
        setOrClear("perpsRegionAttested", true);
        setOrClear("perpsLiveConsentAt", Date.now());
      }
    } else if (repeatsStored("perpsLiveConsentVersion") && repeatsStored("perpsRegionAttested")) {
      // No switch in the body, and the consent keys echo what is stored.
    } else {
      errors.push(
        `${"perpsRegionAttested" in body ? "perpsRegionAttested" : "perpsLiveConsentVersion"}: recorded only when real-money perpetuals are switched on, together with perpsLiveEnabled: true`,
      );
    }
  }

  // NAME WHAT WE DROPPED, so a documented-but-unwired field cannot hide again.
  //
  // This handler is an allowlist with no else, and it is the ONLY writer of the
  // hosted tenant store. A key it does not know about produced {ok:true} and
  // vanished. Not hypothetical: deploy-ponsselftrade.ts and the Pons runbook both
  // told the owner to save `ponsAdapterAddress` here, and for as long as that
  // branch was missing the instruction was impossible to follow and said so to
  // nobody.
  //
  // REPORTED, NOT REJECTED, deliberately. A 400 on unknown keys is the stricter
  // fix and would break every client that round-trips a settings blob containing
  // a field this build does not know — an older dashboard tab open against a
  // newer server, every hosted tenant at once. Trading a silent drop for a
  // fleet-wide save failure is a bad trade. Visibility is the property that was
  // actually missing.
  //
  // A key that FAILED validation is not ignored — it is in `errors`, which is
  // already loud — so those are excluded rather than reported twice.
  const errored = new Set(errors.map((e) => e.split(":")[0]?.trim()).filter(Boolean));
  const ignored = Object.keys(body).filter((k) => !touched.has(k) && !errored.has(k));
  if (ignored.length > 0) {
    console.warn(`[settings] ignored unknown keys: ${ignored.join(", ")}`);
  }

  const persist = async (settings: MerrymenSettings) => {
    if (tenant) {
      // Hosted: the tenant's own settings go to the per-tenant store (sealed at
      // rest), and the orchestrator hands the child worker a settings.json from it
      // within a reconcile tick.
      await getSettingsStore().put(tenant, settings);
    } else {
      await mkdir(DATA_DIR, { recursive: true });
      // settings.json holds plaintext API keys (bundler/Groq/Anthropic/Telegram/…) —
      // owner-only perms (0600), not the default world-readable 0644.
      await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(SETTINGS_FILE, 0o600).catch(() => {});
    }
  };

  if (errors.length > 0) {
    if (offs.length === 0) return NextResponse.json({ errors }, { status: 400 });
    // The offs, and nothing else, over what was stored (see `offs`).
    const offOnly: MerrymenSettings = { ...stored };
    for (const off of offs) off.apply(offOnly);
    await persist(offOnly);
    const saved = [...new Set(offs.map((o) => o.key))];
    return NextResponse.json(
      { errors, saved, note: `Switched off (${saved.join(", ")}) — that was saved. Nothing else in this save was, because of the errors above.` },
      { status: 400 },
    );
  }

  await persist(next);
  return NextResponse.json({
    ok: true,
    appliesWithin: "one worker tick",
    // Present only when something was dropped, so a caller can tell the
    // difference between 'saved' and 'saved, minus the field you cared about'.
    ...(ignored.length > 0 ? { ignored } : {}),
  });
}
