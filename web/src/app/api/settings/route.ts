/**
 * Settings API — the web UI's write path to .data/settings.json, which the
 * worker re-reads every tick.
 *
 * Secrets NEVER travel back to the browser: GET returns { set, hint } for
 * key fields (hint = last 4 chars). On PUT, a secret field that is absent or
 * undefined means "keep what's stored"; empty string means "clear"; any other
 * string replaces it. Non-secret fields: null/empty clears back to default.
 */

import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths, merrymenHome } from "@/lib/home";
import {
  LLM_PROVIDER_IDS,
  LLM_PROVIDERS,
  SECRET_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  isValidCustomToken,
  type LlmProviderInfo,
  type MerrymenSettings,
} from "@merrymen/core";

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
  strategies: { builtin: string[]; custom: string[] };
  /** True once first-run setup was finished/skipped on any surface. */
  webOnboarded: boolean;
  /** The AI providers the brain can run on — powers the Settings picker. */
  llmProviders: LlmProviderInfo[];
}

const STRATEGIES_DIR = homePaths.strategies();
// Free + Merry Circle (holder-gated) builtins — both selectable; the worker runs
// the Circle ones only for $MERRYMEN holders. Mirrors worker/src/strategies/registry.ts.
const BUILTIN_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter"];

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

async function readStored(): Promise<MerrymenSettings> {
  try {
    // BOM-strip: hand-edited or PowerShell-written files may carry a UTF-8 BOM.
    return JSON.parse((await readFile(SETTINGS_FILE, "utf8")).replace(/^﻿/, "")) as MerrymenSettings;
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

export async function GET() {
  const stored = await readStored();
  const { bundlerApiKey, groqApiKey, anthropicApiKey, llmApiKey, rialtoApiKey, telegramBotToken, telegramTranscribeKey, virtualsApiKey, bitqueryApiKey, merrymenToken, ...values } = stored;
  // These URL fields can embed API keys — redact before they leave the server.
  const safeValues = {
    ...values,
    bundlerUrl: redactUrl(values.bundlerUrl),
    rpcMainnet: redactUrl(values.rpcMainnet),
    rpcTestnet: redactUrl(values.rpcTestnet),
    telegramTranscribeBase: redactUrl(values.telegramTranscribeBase),
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
    strategies: { builtin: BUILTIN_STRATEGIES, custom: await listCustomStrategies() },
    llmProviders: LLM_PROVIDERS,
    webOnboarded: safeValues.webOnboarded === true,
  };
  return NextResponse.json(view);
}

const KNOWN_SYMBOLS = new Set(STOCK_TOKENS.map((t) => t.symbol));
const URL_FIELDS = ["bundlerUrl", "rpcMainnet", "rpcTestnet"] as const;
const NUM_FIELDS: Record<string, [number, number]> = {
  slippageBps: [1, 5_000],
  perfFeeBps: [0, 5_000],
  tickSeconds: [15, 3_600],
  buyPerTickUsdg: [1, 100_000],
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
  // Scout ceilings. 0 is a meaningful floor — it's the off switch for the
  // budget independently of the enable flag, so both have to allow it.
  discoveryIntervalMin: [1, 1440],
  scoutBudgetUsdg: [0, 1_000_000],
  scoutPerTokenUsdg: [0, 1_000_000],
};
const BOOL_FIELDS = [
  "paperTradingEnabled",
  "telegramEnabled",
  "telegramControlEnabled",
  "telegramTransferEnabled",
  "telegramNotifyEnabled",
  "telegramPcControlEnabled",
  "telegramAgentEnabled",
  "telegramAgentAutoShell",
  "virtualsEnabled",
  "scoutEnabled",
  "discoveryEnabled",
  // First-run marker: true = finished/skipped on any surface; false/empty
  // clears it (re-shows the onboarding surfaces).
  "webOnboarded",
] as const;
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

  const errors: string[] = [];
  const stored = await readStored();
  const next: MerrymenSettings = { ...stored };

  const setOrClear = <K extends keyof MerrymenSettings>(key: K, value: MerrymenSettings[K] | undefined) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };

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
    if (v === "" || v === null || v === undefined) {
      setOrClear(k, undefined);
    } else {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= min && n <= max) setOrClear(k, n as never);
      else errors.push(`${key}: must be a number between ${min} and ${max}`);
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
  if ("strategy" in body) {
    const v = body.strategy;
    if (v === "" || v === null || v === undefined) {
      setOrClear("strategy", undefined);
    } else if (typeof v === "string" && BUILTIN_STRATEGIES.includes(v)) {
      setOrClear("strategy", v as MerrymenSettings["strategy"]);
    } else if (typeof v === "string" && (await listCustomStrategies()).includes(v)) {
      setOrClear("strategy", v as MerrymenSettings["strategy"]);
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
    else errors.push("groqModel: must be a model id like llama-3.3-70b-versatile");
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

  // ── booleans (telegram toggles) ─────────────────────────────────────────
  for (const key of BOOL_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === undefined) setOrClear(key, undefined);
    else if (typeof v === "boolean") setOrClear(key, v as never);
    else errors.push(`${key}: must be true or false`);
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
      const customSymbols = Array.isArray(custom)
        ? custom.filter(isValidCustomToken).map((t) => t.symbol)
        : [];
      const selectable = new Set([...KNOWN_SYMBOLS, ...customSymbols]);
      const bad = v.filter((s) => typeof s !== "string" || !selectable.has(s));
      if (bad.length > 0) errors.push(`basketSymbols: unknown symbols ${bad.join(", ")}`);
      else if (v.length > 10) errors.push("basketSymbols: at most 10 legs");
      else setOrClear("basketSymbols", v as string[]);
    } else {
      errors.push("basketSymbols: must be an array of symbols");
    }
  }

  if (errors.length > 0) return NextResponse.json({ errors }, { status: 400 });

  await mkdir(DATA_DIR, { recursive: true });
  // settings.json holds plaintext API keys (bundler/Groq/Anthropic/Telegram/…) —
  // owner-only perms (0600), not the default world-readable 0644. Write to a
  // temp file then rename, so a crash mid-write can never leave a truncated
  // settings.json that the worker would silently read as defaults.
  const tmp = `${SETTINGS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, SETTINGS_FILE);
  await chmod(SETTINGS_FILE, 0o600).catch(() => {});
  return NextResponse.json({ ok: true, appliesWithin: "one worker tick" });
}
