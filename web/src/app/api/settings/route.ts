/**
 * Settings API — the web UI's write path to .data/settings.json, which the
 * worker re-reads every tick.
 *
 * Secrets NEVER travel back to the browser: GET returns { set, hint } for
 * key fields (hint = last 4 chars). On PUT, a secret field that is absent or
 * undefined means "keep what's stored"; empty string means "clear"; any other
 * string replaces it. Non-secret fields: null/empty clears back to default.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths, merrymenHome } from "@/lib/home";
import {
  SECRET_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
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
  anthropicApiKey: SecretView;
  rialtoApiKey: SecretView;
  telegramBotToken: SecretView;
  telegramTranscribeKey: SecretView;
  // everything else, verbatim (undefined = using env/default)
  values: Omit<MerrymenSettings, "anthropicApiKey" | "rialtoApiKey" | "telegramBotToken" | "telegramTranscribeKey">;
  defaults: typeof SETTINGS_DEFAULTS;
  knownSymbols: string[];
  strategies: { builtin: string[]; custom: string[] };
}

const STRATEGIES_DIR = homePaths.strategies();
const BUILTIN_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist"];

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

export async function GET() {
  const stored = await readStored();
  const { anthropicApiKey, rialtoApiKey, telegramBotToken, telegramTranscribeKey, ...values } = stored;
  const view: SettingsView = {
    anthropicApiKey: mask(anthropicApiKey),
    rialtoApiKey: mask(rialtoApiKey),
    telegramBotToken: mask(telegramBotToken),
    telegramTranscribeKey: mask(telegramTranscribeKey),
    values,
    defaults: SETTINGS_DEFAULTS,
    knownSymbols: STOCK_TOKENS.map((t) => t.symbol),
    strategies: { builtin: BUILTIN_STRATEGIES, custom: await listCustomStrategies() },
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
  llmIntervalMin: [1, 1_440],
  llmMaxActionUsdg: [1, 100_000],
  telegramMaxActionUsdg: [1, 100_000],
  telegramTransferDailyUsdg: [1, 1_000_000],
  telegramDigestHour: [0, 23],
};
const BOOL_FIELDS = [
  "telegramEnabled",
  "telegramControlEnabled",
  "telegramTransferEnabled",
  "telegramNotifyEnabled",
  "telegramPcControlEnabled",
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
  // PC files root — an absolute path (or blank to disable file ops).
  if ("telegramFilesRoot" in body) {
    const v = body.telegramFilesRoot;
    if (v === "" || v === null || v === undefined) setOrClear("telegramFilesRoot", undefined);
    else if (typeof v === "string" && v.trim().length <= 400) setOrClear("telegramFilesRoot", v.trim());
    else errors.push("telegramFilesRoot: must be a path");
  }
  if ("telegramTranscribeBase" in body) {
    const v = body.telegramTranscribeBase;
    if (v === "" || v === null || v === undefined) setOrClear("telegramTranscribeBase", undefined);
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
      const bad = v.filter((s) => typeof s !== "string" || !KNOWN_SYMBOLS.has(s));
      if (bad.length > 0) errors.push(`basketSymbols: unknown symbols ${bad.join(", ")}`);
      else if (v.length > 10) errors.push("basketSymbols: at most 10 legs");
      else setOrClear("basketSymbols", v as string[]);
    } else {
      errors.push("basketSymbols: must be an array of symbols");
    }
  }

  if (errors.length > 0) return NextResponse.json({ errors }, { status: 400 });

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return NextResponse.json({ ok: true, appliesWithin: "one worker tick" });
}
