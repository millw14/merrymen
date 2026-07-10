/**
 * Settings API — the web UI's write path to .data/settings.json, which the
 * worker re-reads every tick.
 *
 * Secrets NEVER travel back to the browser: GET returns { set, hint } for
 * key fields (hint = last 4 chars). On PUT, a secret field that is absent or
 * undefined means "keep what's stored"; empty string means "clear"; any other
 * string replaces it. Non-secret fields: null/empty clears back to default.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  SECRET_SETTING_KEYS,
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  type MerrymenSettings,
} from "@merrymen/core";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "..", ".data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export interface SecretView {
  set: boolean;
  hint: string | null;
}

export interface SettingsView {
  // secrets, masked
  anthropicApiKey: SecretView;
  rialtoApiKey: SecretView;
  // everything else, verbatim (undefined = using env/default)
  values: Omit<MerrymenSettings, "anthropicApiKey" | "rialtoApiKey">;
  defaults: typeof SETTINGS_DEFAULTS;
  knownSymbols: string[];
}

async function readStored(): Promise<MerrymenSettings> {
  try {
    return JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as MerrymenSettings;
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
  const { anthropicApiKey, rialtoApiKey, ...values } = stored;
  const view: SettingsView = {
    anthropicApiKey: mask(anthropicApiKey),
    rialtoApiKey: mask(rialtoApiKey),
    values,
    defaults: SETTINGS_DEFAULTS,
    knownSymbols: STOCK_TOKENS.map((t) => t.symbol),
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
    if (v === "" || v === null || v === undefined) setOrClear("strategy", undefined);
    else if (["steady-basket", "weekend-gap", "llm-strategist"].includes(v as string))
      setOrClear("strategy", v as MerrymenSettings["strategy"]);
    else errors.push("strategy: unknown strategy");
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
