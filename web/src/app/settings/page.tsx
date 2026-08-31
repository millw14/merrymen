"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import { MERRYMEN_GATEWAY_ORIGIN, SLIPPAGE_BPS_MAX, isValidCustomToken, uncoveredBasketSymbols, type CustomToken, type StoredGrant } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";
import type { TelegramStatus } from "@/app/api/telegram/route";
import SetupChecklist from "./SetupChecklist";

type Draft = Record<string, string>;

function Field(props: {
  label: string;
  hint?: React.ReactNode;
  /** Optional "get a key ↗" link shown beside the label (opens the provider). */
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <label className="field settings-field">
      <span className="field-labelrow">
        <span className="field-label">{props.label}</span>
        {props.action && (
          <a className="field-getkey" href={props.action.href} target="_blank" rel="noreferrer">
            {props.action.label} ↗
          </a>
        )}
      </span>
      <span className="field-input">{props.children}</span>
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // Telegram: booleans/allowlist can't ride the string `draft`, so track separately.
  /**
   * Is this the hosted service?
   *
   * Load-bearing, not cosmetic. In hosted mode the settings API DELETES 26
   * fields from every PUT and still answers ok -- the whole AI provider block,
   * every key, the bundler, the RPC overrides. Showing those controls invites
   * the owner to fill in things that cannot take effect and then tells them it
   * saved. The house runs them; the page should say so instead of pretending
   * they are yours to set.
   */
  const [hosted, setHosted] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHosted(!!d?.hosted))
      .catch(() => setHosted(false));
  }, []);
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [tgEnabled, setTgEnabled] = useState<boolean | null>(null);
  const [tgControl, setTgControl] = useState<boolean | null>(null);
  const [tgTransfer, setTgTransfer] = useState<boolean | null>(null);
  const [tgNotify, setTgNotify] = useState<boolean | null>(null);
  const [virtualsEnabled, setVirtualsEnabled] = useState<boolean | null>(null);
  // Scout mode is a boolean, so it can't ride the string `draft`.
  const [scoutEnabled, setScoutEnabled] = useState<boolean | null>(null);
  const [discoveryEnabled, setDiscoveryEnabled] = useState<boolean | null>(null);
  const [trencherLive, setTrencherLive] = useState<boolean | null>(null);
  const [allowlist, setAllowlist] = useState<number[] | null>(null);
  const [tgTest, setTgTest] = useState<string | null>(null);
  // PC control: master + capability set + string allowlists (also can't ride `draft`).
  const [pcEnabled, setPcEnabled] = useState<boolean | null>(null);
  const [caps, setCaps] = useState<string[] | null>(null);
  const [shellList, setShellList] = useState<string[] | null>(null);
  const [appList, setAppList] = useState<string[] | null>(null);
  // Agent mode (/agent): master + free-form shell toggle (also booleans).
  const [agentEnabled, setAgentEnabled] = useState<boolean | null>(null);
  const [agentAutoShell, setAgentAutoShell] = useState<boolean | null>(null);
  // Owner-added tokens (memecoins). A list of objects, so it can't ride `draft`
  // either. null = untouched this session; the server value stands.
  const [tokens, setTokens] = useState<CustomToken[] | null>(null);
  const [newToken, setNewToken] = useState({ symbol: "", address: "", decimals: "18" });
  const [tokenError, setTokenError] = useState<string | null>(null);
  // The grant the browser holds, so the basket can say which symbols this
  // signature can actually get back out of. null = none stored yet.
  const [storedGrant, setStoredGrant] = useState<StoredGrant | null>(null);
  // AI provider model listing — fetched from the provider's models API.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const loadTelegram = () =>
    fetch("/api/telegram")
      .then((r) => (r.ok ? (r.json() as Promise<TelegramStatus>) : null))
      .then((s) => s && setTg(s))
      .catch(() => {});

  useEffect(() => {
    try {
      const raw = localStorage.getItem("merrymen.grant.v1");
      if (raw) setStoredGrant(JSON.parse(raw) as StoredGrant);
    } catch {
      /* no grant, or unreadable — the basket just won't annotate */
    }
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) setView((await res.json()) as SettingsView);
      } catch {
        /* page shows loading state */
      }
      void loadTelegram();
    })();
  }, []);

  // Debounced model fetch — triggers when provider, key, or custom URL changes.
  useEffect(() => {
    if (!view) return;
    const providerId = draft.llmProvider ?? view.values.llmProvider ?? "groq";
    const prov = view.llmProviders.find((p) => p.id === providerId);
    if (!prov) { setAvailableModels([]); setModelsError(null); return; }

    setAvailableModels([]);
    setModelsLoading(true);
    setModelsError(null);

    const timer = setTimeout(async () => {
      try {
        const body: Record<string, string> = { provider: prov.id };
        const kf = prov.id === "groq" ? "groqApiKey" : prov.id === "anthropic" ? "anthropicApiKey" : "llmApiKey";
        const keyInDraft = draft[kf]?.trim();
        if (keyInDraft) body.apiKey = keyInDraft;
        if (prov.id === "custom") {
          const bu = draft.llmBaseUrl?.trim() || (view.values.llmBaseUrl as string | undefined) || "";
          if (bu) body.baseUrl = bu;
        }
        const res = await fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as { models?: string[]; error?: string };
        if (res.ok && j.models) {
          setAvailableModels(j.models);
          setModelsError(null);
        } else {
          setAvailableModels([]);
          setModelsError(j.error ?? "failed to list models");
        }
      } catch {
        setAvailableModels([]);
        setModelsError("network error");
      } finally {
        setModelsLoading(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [view, draft.llmProvider, draft.groqApiKey, draft.anthropicApiKey, draft.llmApiKey, draft.llmBaseUrl]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const v = (k: keyof SettingsView["values"]): string => {
    if (k in draft) return draft[k as string]!;
    const stored = view?.values[k];
    return stored === undefined || stored === null ? "" : String(stored);
  };

  // URL fields (bundler/RPC) come back REDACTED from GET because they can embed
  // an API key. Render them empty (type-to-replace) with the redacted saved value
  // as the placeholder, so the masked value is never in an editable input.
  const urlPlaceholder = (k: keyof SettingsView["values"], fallback: string): string => {
    const stored = view?.values[k];
    return typeof stored === "string" && stored ? `saved: ${stored}` : fallback;
  };

  function toggleSymbol(sym: string) {
    const current = symbols ?? view?.values.basketSymbols ?? view?.defaults.basketSymbols ?? [];
    setSymbols(current.includes(sym) ? current.filter((s) => s !== sym) : [...current, sym]);
  }

  /** Add a token to the draft list. The server validates again — this is just
   *  so a typo is caught here rather than after a round-trip. */
  function addToken() {
    setTokenError(null);
    const candidate = {
      symbol: newToken.symbol.trim(),
      address: newToken.address.trim(),
      decimals: Number(newToken.decimals),
    };
    if (!isValidCustomToken(candidate)) {
      setTokenError("needs a short symbol, a full 0x… address (42 chars) and whole-number decimals");
      return;
    }
    const current = tokens ?? (view?.values.customTokens as CustomToken[] | undefined) ?? [];
    if (current.some((t) => t.address.toLowerCase() === candidate.address.toLowerCase())) {
      setTokenError(`${candidate.address.slice(0, 10)}… is already in the list`);
      return;
    }
    setTokens([...current, candidate]);
    setNewToken({ symbol: "", address: "", decimals: "18" });
  }

  function removeToken(address: string) {
    const current = tokens ?? (view?.values.customTokens as CustomToken[] | undefined) ?? [];
    setTokens(current.filter((t) => t.address.toLowerCase() !== address.toLowerCase()));
  }

  async function save() {
    setStatus("saving…");
    setErrors([]);
    const body: Record<string, unknown> = { ...draft };
    if (symbols !== null) body.basketSymbols = symbols;
    if (tokens !== null) body.customTokens = tokens;
    if (tgEnabled !== null) body.telegramEnabled = tgEnabled;
    if (tgControl !== null) body.telegramControlEnabled = tgControl;
    if (tgTransfer !== null) body.telegramTransferEnabled = tgTransfer;
    if (tgNotify !== null) body.telegramNotifyEnabled = tgNotify;
    if (virtualsEnabled !== null) body.virtualsEnabled = virtualsEnabled;
    if (scoutEnabled !== null) body.scoutEnabled = scoutEnabled;
    if (discoveryEnabled !== null) body.discoveryEnabled = discoveryEnabled;
    if (trencherLive !== null) body.trencherLiveEnabled = trencherLive;
    if (allowlist !== null) body.telegramAllowlist = allowlist;
    if (pcEnabled !== null) body.telegramPcControlEnabled = pcEnabled;
    if (caps !== null) body.telegramCapabilities = caps;
    if (shellList !== null) body.telegramShellAllowlist = shellList;
    if (appList !== null) body.telegramAppAllowlist = appList;
    if (agentEnabled !== null) body.telegramAgentEnabled = agentEnabled;
    if (agentAutoShell !== null) body.telegramAgentAutoShell = agentAutoShell;
    // Secrets: only send when the user typed something or hit clear ("").
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; errors?: string[] };
      if (!res.ok) {
        setErrors(json.errors ?? ["save failed"]);
        setStatus(null);
        return;
      }
      setStatus("saved — the worker applies it within one tick");
      setDraft({});
      setSymbols(null);
      setTgEnabled(null);
      setTgControl(null);
      setTgTransfer(null);
      setTgNotify(null);
      setVirtualsEnabled(null);
      setScoutEnabled(null);
      setDiscoveryEnabled(null);
      setAllowlist(null);
      setPcEnabled(null);
      setCaps(null);
      setShellList(null);
      setAppList(null);
      setAgentEnabled(null);
      setAgentAutoShell(null);
      setTokens(null);
      const fresh = await fetch("/api/settings");
      if (fresh.ok) setView((await fresh.json()) as SettingsView);
      void loadTelegram();
      setTimeout(() => setStatus(null), 4000);
    } catch {
      setErrors(["could not reach the settings API"]);
      setStatus(null);
    }
  }

  if (view === null) {
    return (
      <main className="grant-shell setup-look">
        <div className="grant-panel mono">loading settings…</div>
      </main>
    );
  }

  const d = view.defaults;
  const activeSymbols = symbols ?? view.values.basketSymbols ?? d.basketSymbols;
  const activeTokens =
    tokens ?? ((view.values.customTokens as CustomToken[] | undefined) ?? []);
  // Read the grant straight from localStorage — this page has no other handle on
  // it, and what matters is the signature the browser actually holds.
  const unsellable = uncoveredBasketSymbols(activeSymbols, storedGrant);
  const secretPlaceholder = (s: { set: boolean; hint: string | null }) =>
    s.set ? `saved ····${s.hint ?? ""} — type to replace` : "not set";

  // ── AI provider (bring any key) ──────────────────────────────────────────
  // One picker drives which key/model fields show. Groq & Anthropic reuse their
  // classic secret fields (old setups keep working); every other provider stores
  // its key in the generic llmApiKey.
  /**
   * HOSTED, NOT EVERY PROVIDER IS OFFERABLE.
   *
   * `llmBaseUrl` stays in HOUSE_KEY_FIELDS, so a hosted tenant cannot point our
   * egress anywhere -- which makes a custom endpoint a control that saves nothing,
   * and a local model one our servers cannot reach at all. Listing either would be
   * the same mistake as rendering thirty inert fields: an option that looks like it
   * works. A KEY is offerable hosted because it is a credential the tenant pays
   * with; an ADDRESS is not, because it is our SSRF.
   */
  const providers = view.llmProviders.filter(
    (p) => hosted !== true || (p.id !== "custom" && p.needsKey !== false),
  );
  const llmProviderVal = draft.llmProvider ?? view.values.llmProvider ?? "groq";
  const prov = providers.find((p) => p.id === llmProviderVal) ?? providers[0]!;
  const providerKeyField = prov.id === "groq" ? "groqApiKey" : prov.id === "anthropic" ? "anthropicApiKey" : "llmApiKey";
  const providerKeyView = prov.id === "groq" ? view.groqApiKey : prov.id === "anthropic" ? view.anthropicApiKey : view.llmApiKey;
  const providerModelField = prov.id === "groq" ? "groqModel" : prov.id === "anthropic" ? "llmModel" : "llmProviderModel";
  const providerNeedsKey = prov.needsKey !== false;

  const tgEnabledVal = tgEnabled ?? view.values.telegramEnabled ?? d.telegramEnabled;
  const tgControlVal = tgControl ?? view.values.telegramControlEnabled ?? d.telegramControlEnabled;
  const tgTransferVal = tgTransfer ?? view.values.telegramTransferEnabled ?? d.telegramTransferEnabled;
  const tgNotifyVal = tgNotify ?? view.values.telegramNotifyEnabled ?? d.telegramNotifyEnabled;
  const virtualsEnabledVal = virtualsEnabled ?? view.values.virtualsEnabled ?? d.virtualsEnabled;
  const scoutEnabledVal = scoutEnabled ?? view.values.scoutEnabled ?? d.scoutEnabled;
  const discoveryEnabledVal = discoveryEnabled ?? view.values.discoveryEnabled ?? d.discoveryEnabled;
  const trencherLiveVal = trencherLive ?? view.values.trencherLiveEnabled ?? d.trencherLiveEnabled;
  const allowlistVal = allowlist ?? view.values.telegramAllowlist ?? [];
  const pcEnabledVal = pcEnabled ?? view.values.telegramPcControlEnabled ?? d.telegramPcControlEnabled;
  const agentEnabledVal = agentEnabled ?? view.values.telegramAgentEnabled ?? d.telegramAgentEnabled;
  const agentAutoShellVal = agentAutoShell ?? view.values.telegramAgentAutoShell ?? d.telegramAgentAutoShell;
  const capsVal = caps ?? view.values.telegramCapabilities ?? [];
  const shellListVal = shellList ?? view.values.telegramShellAllowlist ?? [];
  const appListVal = appList ?? view.values.telegramAppAllowlist ?? [];
  const toggleCap = (c: string) =>
    setCaps(capsVal.includes(c) ? capsVal.filter((x) => x !== c) : [...capsVal, c]);
  const PC_CAPS: { id: string; label: string }[] = [
    { id: "screen", label: "📸 screen" },
    { id: "vision", label: "👁️ vision" },
    { id: "apps", label: "🚀 apps & web" },
    { id: "system", label: "⚙️ system" },
    { id: "files", label: "📂 files" },
    { id: "clipboard", label: "📋 clipboard" },
    { id: "shell", label: "🖥️ shell" },
    { id: "keyboard", label: "⌨️ keyboard" },
    { id: "voice", label: "🎙️ voice" },
    { id: "watchers", label: "👀 watchers" },
  ];

  async function testTelegram() {
    setTgTest("testing…");
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", token: draft.telegramBotToken || undefined }),
      });
      const j = (await res.json()) as { ok?: boolean; username?: string; reason?: string };
      setTgTest(j.ok ? `✓ connected as @${j.username}` : `✗ ${j.reason ?? "failed"}`);
      void loadTelegram();
    } catch {
      setTgTest("✗ could not reach the API");
    }
  }

  return (
    <>
      <header className="topbar setup-look">
        <Link href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="arrow"><LogoMark size={20} /></span>
          <span>merrymen</span>
          <span className="tagline">settings</span>
        </Link>
        <Link href="/" className="connect-btn" style={{ textDecoration: "none" }}>
          back to the band
        </Link>
      </header>

      <main className="grant-shell setup-look">
        <div className="grant-panel settings-panel">
          <h1 className="grant-title">settings</h1>
          <p className="grant-sub">
            The handful of things you need to get riding are up top; everything else lives under{" "}
            <b>Advanced</b>. Stored locally in <code>~/.merrymen/settings.json</code> and picked up
            by the worker within one tick — no restarts. Keys never leave your machine; leave a key
            blank to keep what&apos;s saved.
          </p>

          {/* Setup steps live here after the /app muster is done — a quiet, honest
              status strip read from real state, and a fast way back to fund or re-key. */}
          <SetupChecklist />

          {/* ── ESSENTIALS ─────────────────────────────────────────────── */}
          <div className="settings-section mono">essentials</div>
          <div className="grant-fields settings-grid">
            {/* THE BRAIN IS BRING-YOUR-OWN IN BOTH MODES.
                This block used to be self-hosted only, on the reasoning that the
                house pays for inference. That held until the house budget ran out:
                the shared key hit its daily cap and a tenant's chat died on a plan
                he had no way to top up, because the field was stripped before it
                reached the store. The house key is now the DEFAULT and a tenant's
                own key OVERRIDES it. Still gated on a RESOLVED `hosted` -- rendering
                before we know would flash the wrong set of controls. */}
            {hosted !== null && (
              <>
            {/* ── AI provider · bring any key ──────────────────────────── */}
              <Field
                label={hosted ? "AI provider · optional, for a smarter brain" : "AI provider · the brain"}
                action={prov.keyUrl ? { href: prov.keyUrl, label: providerNeedsKey ? "get a key" : "install" } : undefined}
                hint={`Powers plain-English chat and the AI strategist. ${prov.blurb} ${
                  hosted
                    ? "We run a free model for you, so this is optional — bring your own key for a faster, smarter one on your own quota."
                    : "Built-in strategies need no key at all."
                } Blank keeps the saved key.`}
              >
                <select value={llmProviderVal} onChange={set("llmProvider")}>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.holder ? " · 🏹 holders" : ""}
                      {p.free ? " · free" : ""}
                      {p.vision ? " · vision" : ""}
                      {p.needsKey === false ? " · local" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {providerNeedsKey && (
                <Field
                  label={`${prov.label} API key`}
                  action={prov.keyUrl ? { href: prov.keyUrl, label: "get a key" } : undefined}
                  hint={
                    hosted
                      ? "Paste your own key and your agent uses it instead of ours — your quota, your choice of model, no daily cap shared with anyone. Stored encrypted and never shown again. Blank keeps the saved key."
                      : "Paste the key for the provider you picked above. Never leaves your machine. Blank keeps the saved key."
                  }
                >
                  <input
                    type="password"
                    placeholder={secretPlaceholder(providerKeyView)}
                    value={draft[providerKeyField] ?? ""}
                    onChange={set(providerKeyField)}
                  />
                  {providerKeyView.set && (
                    <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, [providerKeyField]: "" }))}>
                      clear
                    </button>
                  )}
                </Field>
              )}
              {/* SELF-HOSTED ONLY, and deliberately. See the providers filter above:
                  the key is the tenant's money, the URL is our egress. */}
              {hosted === false && prov.id === "custom" && (
                <Field label="base URL" hint="Any OpenAI-compatible endpoint, e.g. https://your-host/v1">
                  <input type="text" placeholder="https://…/v1" value={v("llmBaseUrl")} onChange={set("llmBaseUrl")} />
                </Field>
              )}
              <Field
                label="model"
                hint={`Which model to run. Blank uses the provider default${prov.defaultModel ? ` (${prov.defaultModel})` : ""}.${modelsError ? ` Could not list models: ${modelsError}` : ""}`}
              >
                {modelsLoading ? (
                  <span className="field-loading">listing models…</span>
                ) : availableModels.length > 0 ? (
                  <select
                    value={v(providerModelField as keyof SettingsView["values"])}
                    onChange={set(providerModelField)}
                  >
                    <option value="">default{prov.defaultModel ? ` (${prov.defaultModel})` : ""}</option>
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder={prov.defaultModel || "model id"}
                    value={v(providerModelField as keyof SettingsView["values"])}
                    onChange={set(providerModelField)}
                  />
                )}
              </Field>
  
              </>
            )}
            {hosted === true && (
              <Field
                label="bundler"
                hint="The piece that puts your trades on chain. On merrymen.dev it is run for you -- nothing to paste and nothing to pay for. Self-host if you want to bring your own."
              >
                <div className="settings-subtle mono" style={{ padding: "6px 0" }}>
                  run by the house
                </div>
              </Field>
            )}
            {hosted === false && (
              <>
            <Field
                label="Pimlico API key"
                action={{ href: "https://dashboard.pimlico.io", label: "Get a free key" }}
                hint="The key needed to trade live on mainnet. Tap “Get a free key” → API Keys, paste it here — we build the bundler URL for your wallet's chain automatically. Leave it blank on a testnet wallet: a key can't enable trades there (no venues, balances read 0) and it switches off the paper book. Blank = practice mode: the agent simulates every trade but never signs."
              >
                <input
                  type="password"
                  placeholder={secretPlaceholder(view.bundlerApiKey)}
                  value={draft.bundlerApiKey ?? ""}
                  onChange={set("bundlerApiKey")}
                />
                {view.bundlerApiKey.set && (
                  <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, bundlerApiKey: "" }))}>
                    clear
                  </button>
                )}
              </Field>
                </>
            )}
            {/* The first thing an owner should be able to change, and until now
                the only way was a Telegram command -- which is why every hosted
                agent is called Robin. */}
            <Field
              label="name your merryman"
              hint="What you call your agent. It signs its own messages with this, and it is how it refers to itself in chat. Letters, numbers, spaces, up to 24 characters."
            >
              <input
                type="text"
                maxLength={24}
                placeholder={view.values.agentName || "Robin"}
                value={draft.agentName ?? ""}
                onChange={set("agentName")}
              />
            </Field>
            <Field
              label="strategy"
              hint="steady-basket = DCA + vault sweep · weekend-gap = trade the close→open gap · llm-strategist = Claude proposes, policy disposes · trencher = enters newly launched tokens on chain-read signals and exits on a stop, a target, or liquidity leaving (PAPER MODE ONLY for now). Your own bots from strategies/ appear below the line."
            >
              <select value={v("strategy") || d.strategy} onChange={set("strategy")}>
                {view.strategies.builtin.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {view.strategies.custom.length > 0 && <option disabled>── your strategies ──</option>}
                {view.strategies.custom.map((s) => (
                  <option key={s} value={s}>
                    {s} (custom)
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="settings-subtle mono">basket · equal-weighted</div>
          <div className="symbol-grid">
            {/* Owner-added tokens sit alongside the registry ones. Selecting is
                still an explicit act: adding a token means "know about this",
                putting it in the basket means "trade it". */}
            {[...view.knownSymbols, ...activeTokens.map((t) => t.symbol)].map((sym) => (
              <button
                key={sym}
                type="button"
                className={`cap symbol-chip${activeSymbols.includes(sym) ? " on" : ""}`}
                onClick={() => toggleSymbol(sym)}
              >
                {sym}
              </button>
            ))}
          </div>
          <div className="grant-note">
            {activeSymbols.length === 0
              ? "select at least one symbol (empty falls back to the default basket)"
              : `trading ${activeSymbols.join(" · ")}`}
          </div>
          {/* Selecting a symbol the signed key can't sell used to mean buying a
              position with no exit. The buy is refused now, but say why here —
              at the moment of choosing — rather than in the event feed later. */}
          {unsellable.length > 0 && (
            <div className="grant-note err">
              Your agent&apos;s key can&apos;t sell <b>{unsellable.join(", ")}</b>, so it won&apos;t
              buy {unsellable.length === 1 ? "it" : "them"} either — a position with no way out is
              worse than a missed trade. Re-sign at <Link href="/grant">/grant</Link> to include{" "}
              {unsellable.length === 1 ? "it" : "them"} (free, same wallet, same funds).
            </div>
          )}

          {/* ── OWNER-ADDED TOKENS (memecoins) ─────────────────────────────
              Deliberately separate from the basket: those are issuer-backed
              stocks with Chainlink feeds, these are whatever the owner pastes.
              Adding one here does NOT make it tradable — the tradable list is
              sealed into the signed key — so the /grant re-sign is spelled out
              rather than left to be discovered as a reverted trade. */}
          <div className="settings-subtle mono">your own tokens · memecoins &amp; anything else on 4663</div>
          {activeTokens.length > 0 && (
            <div className="token-list">
              {activeTokens.map((t) => (
                <div key={t.address.toLowerCase()} className="token-row mono">
                  <b>{t.symbol}</b>
                  <span className="token-addr">{t.address}</span>
                  <span className="token-dec">{t.decimals}dp</span>
                  <button type="button" className="copy-btn" onClick={() => removeToken(t.address)}>
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="grant-fields settings-grid">
            <Field label="symbol">
              <input
                value={newToken.symbol}
                placeholder="CATE"
                onChange={(e) => setNewToken((n) => ({ ...n, symbol: e.target.value }))}
              />
            </Field>
            <Field label="contract address">
              <input
                value={newToken.address}
                placeholder="0x…"
                onChange={(e) => setNewToken((n) => ({ ...n, address: e.target.value }))}
              />
            </Field>
            <Field label="decimals" hint="18 for most tokens — check the contract if unsure">
              <input
                value={newToken.decimals}
                inputMode="numeric"
                onChange={(e) => setNewToken((n) => ({ ...n, decimals: e.target.value }))}
              />
            </Field>
          </div>
          <button type="button" className="copy-btn" onClick={addToken}>
            add token
          </button>
          {tokenError && <div className="grant-note err">{tokenError}</div>}

          {/* The two knobs that decide whether a token gets a price at all. They
              live here, next to the tokens they govern, because the refusal
              message names them by value ("below your $25,000 floor") and an
              owner who can't find the dial can't act on that. */}
          <div className="grant-fields settings-grid" style={{ marginTop: 12 }}>
            <Field
              label="minimum pool depth (USD)"
              hint={`Refuse to price a token whose deepest route is thinner than this. Default ${d.minPoolLiquidityUsdg.toLocaleString()}. Lower it and you're accepting a price someone can push for pocket change — and that price feeds your equity and your drawdown breaker.`}
            >
              <input
                value={v("minPoolLiquidityUsdg")}
                inputMode="numeric"
                placeholder={String(d.minPoolLiquidityUsdg)}
                onChange={set("minPoolLiquidityUsdg")}
              />
            </Field>
            <Field
              label="max spot-vs-average gap (bps)"
              hint={`Refuse a price when the current pool price has run this far from its time-average — the signature of a pool being pushed right now. Default ${d.maxPriceDivergenceBps} (${d.maxPriceDivergenceBps / 100}%).`}
            >
              <input
                value={v("maxPriceDivergenceBps")}
                inputMode="numeric"
                placeholder={String(d.maxPriceDivergenceBps)}
                onChange={set("maxPriceDivergenceBps")}
              />
            </Field>
          </div>
          <div className="grant-note">
            Paste the contract address from the explorer — merrymen prices these from the Uniswap
            pool (a time-averaged price, and only when the pool is deep enough to trust), never from
            a Chainlink feed. Thin pools are refused rather than guessed at.
            <br />
            <b>Adding a token here doesn&apos;t let your merryman trade it yet.</b> The tradable list
            lives inside your signed key, so save this, then{" "}
            <Link href="/grant">re-sign at /grant</Link> — free, instant, same wallet and same funds.
          </div>

          {/* ── DISCOVERY ──────────────────────────────────────────────────
              Read-only and message-only. Worth surfacing next to the token
              editor because the action it prompts is "add a token here". */}
          <div className="settings-subtle mono">discovery · new pairs as they launch</div>
          <div className="grant-fields settings-grid">
            <label className="field settings-field">
              <span className="field-label">watch for new pairs</span>
              <span className="field-input">
                <input
                  type="checkbox"
                  checked={discoveryEnabledVal}
                  onChange={(e) => setDiscoveryEnabled(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="field-unit">
                  {discoveryEnabledVal ? "tells you when something launches" : "off"}
                </span>
              </span>
              <span className="field-hint">
                Needs a Bitquery key above (or the Merry Circle brain, whose token works for both).
                Without one this does nothing and says nothing.
              </span>
            </label>
            {/* THE FLAG THAT MADE TRENCHER LOOK BROKEN.
                It has had an API branch and no control, so an owner who picked
                trencher and went live got a candidate feed that returned nothing,
                forever, with nothing said. index.ts says the surprise out loud
                -- “the strategy stopped seeing anything at the exact moment it
                became able to act” -- and then left the only remedy unreachable. */}
            <label className="field settings-field">
              <span className="field-label">let trencher trade for real</span>
              <span className="field-input">
                <input
                  type="checkbox"
                  checked={trencherLiveVal}
                  onChange={(e) => setTrencherLive(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="field-unit">
                  {trencherLiveVal ? "trencher can open real positions" : "practice only"}
                </span>
              </span>
              <span className="field-hint">
                Off by default, and until you turn it on the trencher strategy sees no
                candidates at all once your agent can actually trade &mdash; so it looks like
                it simply never finds anything. It still cannot touch a token your grant
                does not name: turning this on removes a rail, not the wall.
              </span>
            </label>
            <Field
              label="check every (minutes)"
              hint={`How often to look. Default ${d.discoveryIntervalMin}. The shared holder gateway allows only a few calls a minute per wallet, and your merryman's brain draws on the same allowance.`}
            >
              <input
                value={v("discoveryIntervalMin")}
                inputMode="numeric"
                placeholder={String(d.discoveryIntervalMin)}
                onChange={set("discoveryIntervalMin")}
              />
            </Field>
          </div>
          <div className="grant-note">
            Bitquery indexes Robinhood Chain from genesis, including <b>Uniswap v4</b> — where new
            pairs actually launch, and which your merryman can&apos;t see by scanning. It reports
            what it finds, with the depth and whether it could price it.
            <br />
            <b>It never buys anything.</b> A pair it surfaces still needs you to add it above and
            re-sign at <Link href="/grant">/grant</Link>, exactly as if you&apos;d found it yourself.
          </div>

          {/* ── SCOUT MODE ─────────────────────────────────────────────────
              The one place merrymen will knowingly hold something it cannot
              value. The copy has to be blunt about what that costs, because
              the usual safety net genuinely does not apply here. */}
          <div className="settings-subtle mono">scout mode · buying what can&apos;t be priced yet</div>
          <p className="grant-note" style={{ marginTop: 0 }}>
            A token that just launched has no price history and almost no depth, so any price you
            could read from its pool is one someone could push. merrymen normally refuses to value
            those at all. Scout mode lets your merryman buy them anyway — <b>quarantined</b>: the
            position is carried at what it <i>cost</i>, never at a pool reading, and the total that
            may sit that way is hard-capped.
          </p>
          <div className="grant-fields settings-grid">
            <label className="field settings-field">
              <span className="field-label">scout mode</span>
              <span className="field-input">
                <input
                  type="checkbox"
                  checked={scoutEnabledVal}
                  onChange={(e) => setScoutEnabled(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="field-unit">
                  {scoutEnabledVal ? "may buy unpriceable tokens, up to the budget" : "off — unpriceable tokens are never bought"}
                </span>
              </span>
              <span className="field-hint">
                Off by default. With it off, a buy of anything merrymen couldn&apos;t price is
                refused outright.
              </span>
            </label>
            <Field
              label="scout budget (USDG)"
              hint={`Most that may sit in unpriceable positions AT ONCE, measured by what you paid. Selling out frees it again. Default ${d.scoutBudgetUsdg} — you have to name a number.`}
            >
              <input
                value={v("scoutBudgetUsdg")}
                inputMode="numeric"
                placeholder={String(d.scoutBudgetUsdg)}
                onChange={set("scoutBudgetUsdg")}
              />
            </Field>
            <Field
              label="max per token (USDG)"
              hint={`Ceiling for any single unpriceable token, counting what you already put in — so topping up can't creep past a cap one buy would have hit. Default ${d.scoutPerTokenUsdg}.`}
            >
              <input
                value={v("scoutPerTokenUsdg")}
                inputMode="numeric"
                placeholder={String(d.scoutPerTokenUsdg)}
                onChange={set("scoutPerTokenUsdg")}
              />
            </Field>
          </div>
          <div className="grant-note err">
            <b>The drawdown breaker cannot protect this money.</b> A quarantined position is carried
            at cost, so it doesn&apos;t move — if one goes to zero, your equity won&apos;t show it
            and the breaker won&apos;t fire. That isn&apos;t an oversight; it&apos;s what refusing to
            trust an untrustworthy price actually means. <b>The budget is the risk control here</b>,
            not the breaker. Set it to what you&apos;ve decided you can lose.
            {scoutEnabledVal && Number(v("scoutBudgetUsdg") || d.scoutBudgetUsdg) === 0 && (
              <>
                <br />
                <br />
                Scout mode is on but the budget is <b>0</b>, so nothing will be bought. Set a budget
                or turn it back off.
              </>
            )}
          </div>

          {/* ── TELEGRAM (essentials: token + enable) ──────────────────── */}
          <div id="telegram" className="settings-section mono">telegram · chat with your merryman</div>
          <p className="grant-note" style={{ marginTop: 0 }}>
            Create a bot with <b>@BotFather</b> in Telegram (send <code>/newbot</code>), paste its
            token below, enable, and hit <b>test</b>. Then message your bot <code>/link {tg?.linkCode ?? "……"}</code> to
            claim it. Commands and natural-language chat run inside the same policy wall — Telegram can
            never exceed your signed grant.
          </p>
          <div className="grant-fields settings-grid">
            <Field
              label="bot token"
              hint="From @BotFather. Stored locally, never sent back to the browser."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.telegramBotToken)}
                value={draft.telegramBotToken ?? ""}
                onChange={set("telegramBotToken")}
              />
              {view.telegramBotToken.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, telegramBotToken: "" }))}>
                  clear
                </button>
              )}
            </Field>
            <Field label="connection" hint="Live check against Telegram (getMe).">
              <button type="button" className="cap" style={{ cursor: "pointer" }} onClick={() => void testTelegram()}>
                test connection
              </button>
              <span className="field-unit">
                {tgTest ?? (tg?.connected ? `✓ @${tg.botUsername}` : tg?.hasToken ? "not verified" : "no token")}
              </span>
            </Field>
            <label className="field settings-field">
              <span className="field-label">enable telegram</span>
              <span className="field-input">
                <input type="checkbox" checked={tgEnabledVal} onChange={(e) => setTgEnabled(e.target.checked)} style={{ width: "auto" }} />
                <span className="field-unit">{tgEnabledVal ? "the bot is listening" : "off"}</span>
              </span>
              <span className="field-hint">Master switch for the Telegram poller.</span>
            </label>
          </div>

          {/* ── ADVANCED (collapsed by default) ────────────────────────── */}
          <details className="settings-advanced">
            <summary>⚙ Advanced — Telegram controls · remote PC control · RPC / fees / cadence / LLM</summary>

            <div className="settings-section mono">telegram · controls &amp; transfers</div>
            <div className="grant-fields settings-grid">
            <label className="field settings-field">
              <span className="field-label">allow control commands</span>
              <span className="field-input">
                <input type="checkbox" checked={tgControlVal} onChange={(e) => setTgControl(e.target.checked)} style={{ width: "auto" }} />
                <span className="field-unit">{tgControlVal ? "pause/strategy/trade/kill" : "read + chat only"}</span>
              </span>
              <span className="field-hint">Off = the bot can answer questions but not change state.</span>
            </label>
            <Field label="chat trade ceiling" hint="Max USDG per chat-triggered trade — beneath your grant caps.">
              <input
                type="number"
                min={1}
                placeholder={String(d.telegramMaxActionUsdg)}
                value={v("telegramMaxActionUsdg")}
                onChange={set("telegramMaxActionUsdg")}
              />
              <span className="field-unit">USDG</span>
            </Field>
            <label className="field settings-field">
              <span className="field-label">allow transfers</span>
              <span className="field-input">
                <input type="checkbox" checked={tgTransferVal} onChange={(e) => setTgTransfer(e.target.checked)} style={{ width: "auto" }} />
                <span className="field-unit">{tgTransferVal ? "/transfer with /confirm" : "off"}</span>
              </span>
              <span className="field-hint">
                Lets chat send USDG out, if your wallet can. Wallets signed today register no withdrawal address, so their wall carries no transfer permission and the send is refused before anything is built — only grants signed before that changed can transfer. Money leaves with your owner key: merrymen recover.
              </span>
            </label>
            <Field label="daily transfer budget" hint="Max USDG chat transfers may send per day — on top of the grant caps.">
              <input
                type="number"
                min={1}
                placeholder={String(d.telegramTransferDailyUsdg)}
                value={v("telegramTransferDailyUsdg")}
                onChange={set("telegramTransferDailyUsdg")}
              />
              <span className="field-unit">USDG</span>
            </Field>
            <label className="field settings-field">
              <span className="field-label">proactive pings</span>
              <span className="field-input">
                <input type="checkbox" checked={tgNotifyVal} onChange={(e) => setTgNotify(e.target.checked)} style={{ width: "auto" }} />
                <span className="field-unit">{tgNotifyVal ? "trade pings + warnings + daily report" : "quiet"}</span>
              </span>
              <span className="field-hint">The bot messages you first: trades landing, drawdown/gas/expiry warnings, price alerts, and the daily campfire report.</span>
            </label>
            {tgNotifyVal && (
              <Field
                label="trade pings — how often"
                hint="Batch the routine trade notifications so you're not pinged every fill. Warnings, price alerts, reminders and the daily report always come through right away."
              >
                <select value={v("telegramNotifyEveryMin") || "0"} onChange={set("telegramNotifyEveryMin")}>
                  <option value="0">Every trade</option>
                  <option value="5">A summary every 5 minutes</option>
                  <option value="15">A summary every 15 minutes</option>
                  <option value="30">A summary every 30 minutes</option>
                  <option value="60">A summary every hour</option>
                </select>
              </Field>
            )}
            <Field label="daily report hour" hint="Local hour (0–23) after which the campfire report is sent.">
              <input
                type="number"
                min={0}
                max={23}
                placeholder={String(d.telegramDigestHour)}
                value={v("telegramDigestHour")}
                onChange={set("telegramDigestHour")}
              />
              <span className="field-unit">h</span>
            </Field>
          </div>
          <div className="grant-note" style={{ marginTop: 4 }}>
            {tg?.linkCode ? (
              <>
                link code: <b className="mono">{tg.linkCode}</b> — send <code>/link {tg.linkCode}</code> from Telegram
              </>
            ) : (
              "save a token to generate your link code"
            )}
          </div>
          <div className="symbol-grid" style={{ marginTop: 6 }}>
            {allowlistVal.length === 0 && <span className="dim mono">no linked chats yet</span>}
            {allowlistVal.map((id) => (
              <span key={id} className="cap symbol-chip on">
                {id}
                <button
                  type="button"
                  onClick={() => setAllowlist(allowlistVal.filter((x) => x !== id))}
                  style={{ marginLeft: 6, background: "none", border: "none", color: "inherit", cursor: "pointer" }}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              type="text"
              inputMode="numeric"
              placeholder="add chat id…"
              className="mono"
              style={{ width: 120, background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 12, padding: "2px 6px" }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const n = Number((e.target as HTMLInputElement).value.trim());
                if (Number.isInteger(n) && !allowlistVal.includes(n)) {
                  setAllowlist([...allowlistVal, n]);
                  (e.target as HTMLInputElement).value = "";
                }
              }}
            />
          </div>

          {/* ── remote control · your PC (OpenClaw-style) ─────────────────── */}
          <div className="settings-section mono">🖥️ remote control · your PC</div>
          <div className="mainnet-warning" style={{ marginBottom: 12 }}>
            <b>This lets Telegram touch this computer.</b> With it on, an allowlisted chat can take
            screenshots, open apps, browse a folder you pick, and — if you enable them — run
            allowlisted shell commands and type keystrokes. Everything is <b>off by default</b>,
            enabled one capability at a time, and the sharp ones (shell, keyboard, files, power)
            always ask you to <code>/confirm</code> first. Only turn on what you want.
          </div>
          <label className="field settings-field">
            <span className="field-label">enable remote control</span>
            <span className="field-input">
              <input type="checkbox" checked={pcEnabledVal} onChange={(e) => setPcEnabled(e.target.checked)} style={{ width: "auto" }} />
              <span className="field-unit">{pcEnabledVal ? "ON — capabilities below apply" : "off — no PC command runs"}</span>
            </span>
            <span className="field-hint">The master switch. Off = every PC command is refused, regardless of the toggles below.</span>
          </label>

          <div className="field settings-field">
            <span className="field-label">capabilities</span>
            <div className="caps" style={{ marginTop: 4 }}>
              {PC_CAPS.map((c) => (
                <span
                  key={c.id}
                  className={`cap symbol-chip ${capsVal.includes(c.id) ? "on" : ""}`}
                  onClick={() => toggleCap(c.id)}
                  style={{ cursor: "pointer", opacity: pcEnabledVal ? 1 : 0.5 }}
                >
                  {c.label}
                </span>
              ))}
            </div>
            <span className="field-hint">Click to toggle. Only enabled groups work; the rest are refused. “vision” and “voice” need extra keys below.</span>
          </div>

          {pcEnabledVal && (capsVal.includes("shell") || capsVal.includes("keyboard")) && (
            <div className="pc-danger">
              ⚠️ <b>This is remote control of your computer.</b> <b>Keyboard</b> types keystrokes into
              whatever window is focused, and <b>shell</b> runs your allowlisted commands — together
              they can do essentially anything you can. Allowlisting an <b>interpreter</b> (python,
              node, bash, powershell, git…) hands over <b>everything that program can do</b>, not just
              one command. Only enable these on a machine you trust, keep the shell allowlist as
              narrow as possible, and note each one still asks for <code>/confirm</code> first.
            </div>
          )}

          {/* ── agent mode · /agent <task> ─────────────────────────────── */}
          <label className="field settings-field">
            <span className="field-label">🤖 agent mode · /agent</span>
            <span className="field-input">
              <input
                type="checkbox"
                checked={agentEnabledVal}
                onChange={(e) => setAgentEnabled(e.target.checked)}
                style={{ width: "auto" }}
                disabled={!pcEnabledVal}
              />
              <span className="field-unit">
                {!pcEnabledVal ? "needs remote control ON" : agentEnabledVal ? "ON — /agent works multi-step tasks" : "off"}
              </span>
            </span>
            <span className="field-hint">
              Just talk to it — “<i>clone repo X, install, build, tell me what breaks</i>” (or
              <code>/agent …</code>) — and the merryman works your PC in a tool loop (shell, files,
              screen, vision), streaming progress to the chat until it&apos;s done. It remembers
              names, projects and setup between tasks. Uses only the capability groups you enabled
              above; say <b>stop</b> to halt it.
            </span>
          </label>
          {agentEnabledVal && pcEnabledVal && (
            <>
              <label className="field settings-field">
                <span className="field-label">free-form shell for /agent</span>
                <span className="field-input">
                  <input
                    type="checkbox"
                    checked={agentAutoShellVal}
                    onChange={(e) => setAgentAutoShell(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  <span className="field-unit">{agentAutoShellVal ? "ON — beyond the allowlist, no per-command confirm" : "off — allowlist only"}</span>
                </span>
                <span className="field-hint">
                  Off: /agent may only run your allowlisted commands. On: it may compose its own
                  commands (installs, builds, git) — destructive commands and secrets paths are
                  refused always.
                </span>
              </label>
              {agentAutoShellVal && (
                <div className="pc-danger">
                  ⚠️ <b>Free-form shell is remote code execution by an AI.</b> The agent can run
                  almost any command your account can, without asking per command — and this switch
                  also unlocks <b>typing keystrokes</b> and <b>opening any URL</b>. The destructive
                  blocklist (rm/rd/format/shutdown/registry/interpreters) and the secret-value
                  redaction are a <b>seatbelt, not a cage</b>: a determined model can still do harm.
                  Only arm this on a machine you&apos;d hand to a very eager intern, and keep{" "}
                  <code>/agent stop</code> handy. With it OFF, the agent is limited to your
                  allowlisted commands and can&apos;t type or open arbitrary links.
                </div>
              )}
              <div className="grant-fields settings-grid">
                <Field label="step budget" hint="Max model↔tool steps per /agent task — the runaway brake.">
                  <input type="number" min={1} max={60} placeholder={String(d.telegramAgentMaxSteps)} value={v("telegramAgentMaxSteps")} onChange={set("telegramAgentMaxSteps")} />
                  <span className="field-unit">steps</span>
                </Field>
              </div>
            </>
          )}

          <div className="grant-fields settings-grid">
            <Field
              label="files root"
              hint="The ONE folder /ls and /get are confined to (absolute path). Blank = files off. Nothing outside it is reachable."
            >
              <input type="text" placeholder="C:\\Users\\you\\Documents\\shared" value={v("telegramFilesRoot")} onChange={set("telegramFilesRoot")} />
            </Field>
            <Field
              label="transcription key (voice)"
              hint="OpenAI-compatible key for voice notes → text. Blank = voice off. Stored locally, never shown."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.telegramTranscribeKey)}
                value={draft.telegramTranscribeKey ?? ""}
                onChange={set("telegramTranscribeKey")}
              />
            </Field>
          </div>

          <div className="field settings-field">
            <span className="field-label">shell allowlist</span>
            <div className="cap-list">
              {shellListVal.map((cmd) => (
                <span key={cmd} className="cap symbol-chip on">
                  <code>{cmd}</code>
                  <button type="button" onClick={() => setShellList(shellListVal.filter((x) => x !== cmd))} className="chip-x">✕</button>
                </span>
              ))}
              <input
                type="text"
                placeholder="exact command, e.g. git status ↵"
                style={{ width: 220, background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 12, padding: "2px 6px" }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const s = (e.target as HTMLInputElement).value.trim();
                  if (s && !shellListVal.includes(s)) {
                    setShellList([...shellListVal, s]);
                    (e.target as HTMLInputElement).value = "";
                  }
                }}
              />
            </div>
            <span className="field-hint">Only these exact commands (or command + args) may run via /run — and each still needs /confirm. Chaining/redirects are always refused.</span>
          </div>

          <div className="field settings-field">
            <span className="field-label">app allowlist</span>
            <div className="cap-list">
              {appListVal.map((app) => (
                <span key={app} className="cap symbol-chip on">
                  {app}
                  <button type="button" onClick={() => setAppList(appListVal.filter((x) => x !== app))} className="chip-x">✕</button>
                </span>
              ))}
              <input
                type="text"
                placeholder="app name, e.g. spotify ↵"
                style={{ width: 180, background: "var(--bg-2)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 12, padding: "2px 6px" }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const s = (e.target as HTMLInputElement).value.trim();
                  if (s && !appListVal.includes(s)) {
                    setAppList([...appListVal, s]);
                    (e.target as HTMLInputElement).value = "";
                  }
                }}
              />
            </div>
            <span className="field-hint">Names /open may launch. Full https:// URLs open without an allowlist.</span>
          </div>

          <div className="settings-section mono">execution &amp; keys</div>
          <div className="grant-fields settings-grid">
            <Field
              label="mainnet RPC override"
              hint="Optional. The public RPC rate-limits at 1-minute ticks; a free Alchemy/QuickNode endpoint is smoother."
            >
              <input type="url" placeholder={urlPlaceholder("rpcMainnet", "default: rpc.mainnet.chain.robinhood.com")} value={draft.rpcMainnet ?? ""} onChange={set("rpcMainnet")} />
            </Field>
            <Field label="testnet RPC override" hint="Optional.">
              <input type="url" placeholder={urlPlaceholder("rpcTestnet", "default: rpc.testnet.chain.robinhood.com")} value={draft.rpcTestnet ?? ""} onChange={set("rpcTestnet")} />
            </Field>
            <Field
              label="bundler URL override"
              hint="Advanced — only if you use Alchemy or a self-hosted bundler instead of a Pimlico key. Takes precedence over the Pimlico key; the chain id must match your wallet's chain."
            >
              <input type="url" placeholder={urlPlaceholder("bundlerUrl", "https://…/rpc?apikey=…")} value={draft.bundlerUrl ?? ""} onChange={set("bundlerUrl")} />
            </Field>
            <Field
              label="breaker contract"
              hint="Deployed BreakerRegistry address. Once set, a tripped breaker halts all trading at the wall."
            >
              <input type="text" placeholder="0x…" value={v("breakerAddress")} onChange={set("breakerAddress")} />
            </Field>
            <Field
              label="v4 adapter contract"
              hint="Deployed V4SelfSwap address for THIS chain — it opens Uniswap v4 (where new pairs launch). Does nothing until you re-sign the grant: the address is sealed into the signature."
            >
              <input type="text" placeholder="0x…" value={v("v4AdapterAddress")} onChange={set("v4AdapterAddress")} />
            </Field>
            <Field
              label="Rialto integrator key"
              hint="From Rialto's wallet-signed onboarding (docs.rialto.xyz). Enables real stock-token routing through their propAMMs."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.rialtoApiKey)}
                value={draft.rialtoApiKey ?? ""}
                onChange={set("rialtoApiKey")}
              />
              {view.rialtoApiKey.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, rialtoApiKey: "" }))}>
                  clear
                </button>
              )}
            </Field>
            <Field label="Rialto key header" hint={`Header name their API expects (default ${d.rialtoApiKeyHeader}).`}>
              <input type="text" placeholder={d.rialtoApiKeyHeader} value={v("rialtoApiKeyHeader")} onChange={set("rialtoApiKeyHeader")} />
            </Field>
          </div>

          <div className="settings-section mono">virtuals terminal</div>
          <div className="grant-fields settings-grid">
            <label className="field settings-field">
              <span className="field-label">stream to Virtuals</span>
              <span className="field-input">
                <input type="checkbox" checked={virtualsEnabledVal} onChange={(e) => setVirtualsEnabled(e.target.checked)} style={{ width: "auto" }} />
                <span className="field-unit">{virtualsEnabledVal ? "live activity → your $MERRYMEN agent page" : "off"}</span>
              </span>
              <span className="field-hint">
                Publishes landed trades and the daily report to your agent&apos;s public page on
                app.virtuals.io. <b>Outbound &amp; public</b> — off by default; nothing streams until
                you turn this on and add a key.
              </span>
            </label>
            <Field
              label="Virtuals API key"
              hint="From your agent's page on app.virtuals.io. Stays on your machine; used only to post activity logs — it can never trade or move funds."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.virtualsApiKey)}
                value={draft.virtualsApiKey ?? ""}
                onChange={set("virtualsApiKey")}
              />
              {view.virtualsApiKey.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, virtualsApiKey: "" }))}>
                  clear
                </button>
              )}
            </Field>
            <Field
              label="bitquery api key"
              action={{ href: "https://account.bitquery.io/", label: "get a key" }}
              hint="Lets your merryman SEE what it otherwise can't: Bitquery indexes Robinhood Chain from genesis, including Uniswap v4 — where new pairs and graduating tokens actually launch. Discovery only: it can tell your agent a pair exists, never authorise a trade in one. Everything it finds still has to clear the same depth and price guards."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.bitqueryApiKey)}
                value={draft.bitqueryApiKey ?? ""}
                onChange={set("bitqueryApiKey")}
              />
              {view.bitqueryApiKey.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, bitqueryApiKey: "" }))}>
                  clear
                </button>
              )}
            </Field>
            <Field
              label="merry circle token"
              action={{ href: `${MERRYMEN_GATEWAY_ORIGIN}/claim`, label: "claim one" }}
              hint="🏹 Holders only. Sign with your $MERRYMEN wallet to claim a token — then you need no Bitquery account of your own; discovery runs on the shared gateway. The same token also works as the Merrymen AI brain key, but the two are independent: use Claude for thinking and the gateway for discovery if you like. Your own Bitquery key above always takes precedence."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.merrymenToken)}
                value={draft.merrymenToken ?? ""}
                onChange={set("merrymenToken")}
              />
              {view.merrymenToken.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, merrymenToken: "" }))}>
                  clear
                </button>
              )}
            </Field>
          </div>

          <div className="settings-section mono">trading knobs</div>
          <div className="grant-fields settings-grid">
            <Field label="swap venue" hint="uniswap = permissionless v3 (QQQ has liquidity today) · rialto = meta-router (needs the Rialto key above for full execution).">
              <select value={v("swapVenue") || d.swapVenue} onChange={set("swapVenue")}>
                <option value="uniswap">uniswap</option>
                <option value="rialto">rialto</option>
              </select>
            </Field>
            <Field label="max slippage" hint="vs the pre-trade quote.">
              <input type="number" min={1} max={SLIPPAGE_BPS_MAX} placeholder={String(d.slippageBps)} value={v("slippageBps")} onChange={set("slippageBps")} />
              <span className="field-unit">bps</span>
            </Field>
            <Field label="performance fee" hint="On profit above the high-water mark only. Accrual ledger — nothing is collected yet.">
              <input type="number" min={0} max={5000} placeholder={String(d.perfFeeBps)} value={v("perfFeeBps")} onChange={set("perfFeeBps")} />
              <span className="field-unit">bps</span>
            </Field>
            <Field label="tick cadence" hint="How often the worker wakes.">
              <input type="number" min={15} max={3600} placeholder={String(d.tickSeconds)} value={v("tickSeconds")} onChange={set("tickSeconds")} />
              <span className="field-unit">sec</span>
            </Field>
            <Field label="buy per tick" hint="steady-basket: USDG deployed across the basket each tick.">
              <input type="number" min={1} placeholder={String(d.buyPerTickUsdg)} value={v("buyPerTickUsdg")} onChange={set("buyPerTickUsdg")} />
              <span className="field-unit">USDG</span>
            </Field>
            <Field label="idle cash floor" hint="steady-basket: cash kept liquid; the excess sweeps to the Morpho vault.">
              <input type="number" min={0} placeholder={String(d.idleFloorUsdg)} value={v("idleFloorUsdg")} onChange={set("idleFloorUsdg")} />
              <span className="field-unit">USDG</span>
            </Field>
            <Field label="gap budget" hint="weekend-gap: total USDG deployed per gap window.">
              <input type="number" min={1} placeholder={String(d.gapEnterBudgetUsdg)} value={v("gapEnterBudgetUsdg")} onChange={set("gapEnterBudgetUsdg")} />
              <span className="field-unit">USDG</span>
            </Field>
            <Field label="Claude / vision model" hint="Model id used when the brain is Anthropic, and for screen vision. The active provider's model is set up top under “AI provider”.">
              <input type="text" placeholder={d.llmModel} value={v("llmModel")} onChange={set("llmModel")} />
            </Field>
            <Field label="LLM decision window" hint="Minutes between model calls — decisions are windows, not ticks.">
              <input type="number" min={1} max={1440} placeholder={String(d.llmIntervalMin)} value={v("llmIntervalMin")} onChange={set("llmIntervalMin")} />
              <span className="field-unit">min</span>
            </Field>
            <Field label="LLM max per action" hint="Hard strategist ceiling per proposed trade — beneath the grant caps.">
              <input type="number" min={1} placeholder={String(d.llmMaxActionUsdg)} value={v("llmMaxActionUsdg")} onChange={set("llmMaxActionUsdg")} />
              <span className="field-unit">USDG</span>
            </Field>
          </div>

          </details>

          <button className="grant-btn" onClick={() => void save()} disabled={status === "saving…"}>
            {status ?? "save settings"}
          </button>
          {errors.length > 0 && (
            <div className="grant-error mono">
              {errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

          <div className="grant-note">
            precedence: these settings → environment variables → defaults. the worker re-reads this
            file every tick; connection changes re-arm the executor automatically. keys live only in
            ~/.merrymen/settings.json on this machine.
          </div>
        </div>
      </main>
    </>
  );
}
