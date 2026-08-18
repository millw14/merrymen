"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Field, secretPlaceholder } from "@/components/setup-fields";
import { LogoMark } from "@/components/Logo";
import type { SettingsView } from "@/app/api/settings/route";
import type { TelegramStatus } from "@/app/api/telegram/route";

/**
 * First-run onboarding — a full-screen overlay on the dashboard for brand-new
 * installs (no meaningful config yet). Mirrors `merrymen onboard` in the
 * terminal, so either surface gets you riding. Every step is optional; blanks
 * are skipped and the defaults (paper mode) stand. Finishing OR skipping marks
 * settings.webOnboarded so neither surface ever nags again.
 *
 * It only shows when the server confirms the app has never been set up — if we
 * can't read settings at all we render nothing rather than block the dashboard.
 */
const STEPS = [
  { title: "gather your band", sub: "nothing here is required" },
  { title: "give it a brain", sub: "who powers chat + the strategist" },
  { title: "pick your outlaw", sub: "strategy + basket" },
  { title: "go live", sub: "optional — practice mode until you add a key" },
  { title: "a raven to telegram", sub: "optional — chat with your merryman" },
  { title: "what's next", sub: "the band is mustered" },
] as const;

function configured(v: SettingsView): boolean {
  return Boolean(
    v.values.llmProvider ||
      v.groqApiKey.set ||
      v.anthropicApiKey.set ||
      v.llmApiKey.set ||
      v.bundlerApiKey.set ||
      v.telegramBotToken.set ||
      v.values.strategy,
  );
}

export function OnboardWizard() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // ── brain step state ──
  const [providerId, setProviderId] = useState("groq");
  const [keyInput, setKeyInput] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // ── strategy / basket / go-live / telegram state ──
  const [strategy, setStrategy] = useState("steady-basket");
  const [basket, setBasket] = useState<string[]>([]);
  const [bundlerKey, setBundlerKey] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgTest, setTgTest] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (alive && res.ok) setView((await res.json()) as SettingsView);
      } catch {
        /* leave null → render nothing */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Once we know the real defaults, prime the strategy + basket.
  useEffect(() => {
    if (!view) return;
    setStrategy(view.values.strategy || view.defaults.strategy);
    setBasket((view.values.basketSymbols ?? view.defaults.basketSymbols).slice());
  }, [view]);

  const prov = useMemo(() => {
    const id = view ? (view.llmProviders.find((p) => p.id === providerId) ? providerId : "groq") : "groq";
    return view?.llmProviders.find((p) => p.id === id) ?? view?.llmProviders[0];
  }, [view, providerId]);

  const providerKeyField = prov?.id === "groq" ? "groqApiKey" : prov?.id === "anthropic" ? "anthropicApiKey" : "llmApiKey";
  const providerKeyView = prov?.id === "groq" ? view?.groqApiKey : prov?.id === "anthropic" ? view?.anthropicApiKey : view?.llmApiKey;
  const providerModelField = prov?.id === "groq" ? "groqModel" : prov?.id === "anthropic" ? "llmModel" : "llmProviderModel";
  const providerNeedsKey = prov?.needsKey !== false;

  // Debounced model fetch — triggers when provider, key, or custom URL changes.
  useEffect(() => {
    if (!view || !prov) return;
    setAvailableModels([]);
    setModelsLoading(true);
    setModelsError(null);
    const timer = setTimeout(async () => {
      try {
        const body: Record<string, string> = { provider: prov.id };
        const kf = prov.id === "groq" ? "groqApiKey" : prov.id === "anthropic" ? "anthropicApiKey" : "llmApiKey";
        if (keyInput.trim()) body.apiKey = keyInput.trim();
        if (prov.id === "custom" && customBaseUrl.trim()) body.baseUrl = customBaseUrl.trim();
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
          setModelsError(j.error ?? "could not list models");
        }
      } catch {
        setAvailableModels([]);
        setModelsError("network error");
      } finally {
        setModelsLoading(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [view, prov, keyInput, customBaseUrl]);

  const toggleSymbol = (sym: string) =>
    setBasket((cur) => (cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym]));

  async function testTg() {
    setTgTest("testing…");
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", token: tgToken.trim() || undefined }),
      });
      const j = (await res.json()) as { ok?: boolean; username?: string; reason?: string };
      setTgTest(j.ok ? `✓ connected as @${j.username}` : `✗ ${j.reason ?? "failed"}`);
    } catch {
      setTgTest("✗ could not reach the API");
    }
  }

  async function finish(skip: boolean) {
    setSaving(true);
    setErrors([]);
    const body: Record<string, unknown> = { webOnboarded: true };
    if (!skip) {
      body.llmProvider = providerId;
      if (keyInput.trim()) body[providerKeyField] = keyInput.trim();
      if (providerId === "custom" && customBaseUrl.trim()) body.llmBaseUrl = customBaseUrl.trim();
      if (modelChoice.trim()) body[providerModelField] = modelChoice.trim();
      body.strategy = strategy;
      body.basketSymbols = basket;
      if (bundlerKey.trim()) body.bundlerApiKey = bundlerKey.trim();
      if (tgToken.trim()) {
        body.telegramBotToken = tgToken.trim();
        body.telegramEnabled = true;
      }
    }
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json()) as { ok?: boolean; errors?: string[] };
      if (!res.ok) {
        setErrors(j.errors ?? ["save failed"]);
        setSaving(false);
        return;
      }
      setTimeout(() => setView((v) => (v ? { ...v, webOnboarded: true } : v)), 600);
      setDone(true);
    } catch {
      setErrors(["could not reach the settings API"]);
      setSaving(false);
    }
  }

  if (!view) return null;
  if (view.webOnboarded || configured(view)) return null;

  const d = view.defaults;
  const steps = STEPS.length;
  const cur = Math.min(step, steps - 1);

  // ── step bodies ─────────────────────────────────────────────────────

  const welcomeStep = (
    <div className="onboard-copy">
      <p>
        Your merrymen reads a single file — <code>~/.merrymen/settings.json</code> — and <b>everything
        here is optional</b>. Press skip and you ride in <b>paper mode</b>: real live prices, simulated
        fills, zero funds. Add keys later here or in <Link href="/settings#telegram">/settings</Link> whenever
        you want to go live.
      </p>
      <ul className="onboard-perks">
        <li>your keys stay on your machine — yield privately</li>
        <li>every trade is simulated first, then gated by a signed policy wall</li>
        <li>paper mode needs no keys at all</li>
      </ul>
    </div>
  );

  const renderBrain = (
    <div className="onboard-copy">
      <p>
        Pick who powers plain-English chat + the AI strategist. Free: Groq, Google, Cerebras. Local
        (no key): Ollama.
      </p>
      <div className="onboard-fields">
        <Field label="AI provider · the brain">
          <select value={prov?.id ?? "groq"} onChange={(e) => { setProviderId(e.target.value); setModelChoice(""); }}>
            {view.llmProviders.map((p) => (
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
            label={`${prov?.label ?? "provider"} API key`}
            action={prov?.keyUrl ? { href: prov.keyUrl, label: "get a key" } : undefined}
            hint="Paste the key for the provider you picked. Never leaves your machine. Blank keeps what's saved."
          >
            <input type="password" placeholder={secretPlaceholder(providerKeyView ?? { set: false, hint: null })} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          </Field>
        )}
        {providerId === "custom" && (
          <Field label="base URL" hint="Any OpenAI-compatible endpoint, e.g. https://your-host/v1">
            <input type="text" placeholder="https://…/v1" value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} />
          </Field>
        )}
        <Field
          label="model"
          hint={`Blank uses the provider default${prov?.defaultModel ? ` (${prov.defaultModel})` : ""}.${modelsError ? ` Could not list models: ${modelsError}` : ""}`}
        >
          {modelsLoading ? (
            <span className="field-loading">listing models…</span>
          ) : availableModels.length > 0 ? (
            <select value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
              <option value="">default{prov?.defaultModel ? ` (${prov.defaultModel})` : ""}</option>
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input type="text" placeholder={prov?.defaultModel || "model id"} value={modelChoice} onChange={(e) => setModelChoice(e.target.value)} />
          )}
        </Field>
      </div>
    </div>
  );

  const renderStrategy = (
    <div className="onboard-copy">
      <div className="onboard-fields">
        <Field
          label="strategy"
          hint="steady-basket = DCA + vault sweep · weekend-gap = trade the close→open gap · llm-strategist = the model proposes, policy disposes · trencher = tracks newly launched tokens (paper only for now)."
        >
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {view.strategies.builtin.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
            {view.strategies.custom.length > 0 && <option disabled>── your strategies ──</option>}
            {view.strategies.custom.map((s) => (
              <option key={s} value={s}>{s} (custom)</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="settings-subtle mono">basket · equal-weighted</div>
      <div className="symbol-grid">
        {view.knownSymbols.map((sym) => (
          <button key={sym} type="button" className={`cap symbol-chip${basket.includes(sym) ? " on" : ""}`} onClick={() => toggleSymbol(sym)}>
            {sym}
          </button>
        ))}
      </div>
      <div className="grant-note">{basket.length === 0 ? "select at least one symbol (empty falls back to the default basket)" : `trading ${basket.join(" · ")}`}</div>
    </div>
  );

  const renderGoLive = (
    <div className="onboard-copy">
      <p>
        To place real trades, merrymen needs one key: a free <b>Pimlico</b> key that relays your agent&apos;s
        transactions on-chain. Grab it at <Link href="https://dashboard.pimlico.io" target="_blank" rel="noreferrer">dashboard.pimlico.io</Link> → API Keys.
        <b> Leave it blank to stay in practice mode.</b>
      </p>
      <div className="onboard-fields">
        <Field label="Pimlico API key" action={{ href: "https://dashboard.pimlico.io", label: "get a free key" }}>
          <input type="password" placeholder="not set — blank = practice mode" value={bundlerKey} onChange={(e) => setBundlerKey(e.target.value)} />
        </Field>
      </div>
    </div>
  );

  const renderTelegram = (
    <div className="onboard-copy">
      <p>Create a bot with <b>@BotFather</b> (send <code>/newbot</code>), paste its token, hit <b>test</b>, and you&apos;ll link it right from the dashboard after this.</p>
      <div className="onboard-fields">
        <Field label="bot token" hint="From @BotFather. Stored locally, never sent back to the browser.">
          <input
            type="password"
            placeholder={secretPlaceholder(view.telegramBotToken)}
            value={tgToken}
            onChange={(e) => setTgToken(e.target.value)}
          />
        </Field>
        <Field label="connection">
          <button type="button" className="cap" style={{ cursor: "pointer" }} onClick={() => void testTg()}>test</button>
          <span className="field-unit">{tgTest ?? "not verified yet"}</span>
        </Field>
      </div>
      <div className="grant-note">Leave it blank and skip — you can add Telegram anytime in /settings.</div>
    </div>
  );

  const renderWhatsNext = (
    <div className="onboard-copy">
      <p>Your band is mustered. A few one-time steps to go live on-chain, all optional:</p>
      <ul className="onboard-perks">
        <li><Link href="/grant">create your agent wallet</Link> — pick testnet 46630 (practice) or mainnet 4663 (real funds)</li>
        <li>testnet gas from the sheriff&apos;s vault: <Link href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">faucet.testnet.chain.robinhood.com</Link></li>
        <li>check the rig anytime: <code>merrymen doctor</code> · prove the loop: <code>merrymen selftest</code></li>
        <li>tune everything later in <Link href="/settings">/settings</Link></li>
      </ul>
    </div>
  );

  const bodies = [welcomeStep, renderBrain, renderStrategy, renderGoLive, renderTelegram, renderWhatsNext];
  const last = step === steps - 1;

  return (
    <div className="onboard-backdrop setup-look">
      <div className="onboard-panel">
        <div className="onboard-brand">
          <span className="arrow"><LogoMark size={18} /></span>
          <span>merrymen</span>
        </div>

        <div className="onboard-progress" aria-hidden="true">
          <span className={`onboard-chunk${done ? " on" : ""}`} />
          {Array.from({ length: steps }).map((_, i) => (
            <span key={i} className={`onboard-dot${step === i && !done ? " on" : ""}${i < step || done ? " past" : ""}`} />
          ))}
        </div>

        {done ? (
          <>
            <h1 className="onboard-title">the band is mustered. 🏹</h1>
            <p className="grant-sub">{errors.length ? "…but something didn&apos;t save:" : "your board is set and riding in paper mode — go live whenever you like."}</p>
            {errors.length > 0 && <div className="grant-note err">{errors.join(", ")}</div>}
            <Link href="/" className="onboard-next">to the band →</Link>
          </>
        ) : (
          <>
            <div className="onboard-step">
              <span className="onboard-stepno">{step + 1} / 6</span>
              <h1 className="onboard-title">{STEPS[cur].title}</h1>
              <p className="grant-sub">{STEPS[cur].sub}</p>
            </div>

            {bodies[cur]}

            {errors.length > 0 && <div className="grant-note err">{errors.join(", ")}</div>}

            <div className="onboard-nav">
              {step === 0 && (
                <>
                  <button className="onboard-btn ghost" disabled={saving} onClick={() => void finish(true)}>skip for now (paper mode)</button>
                  <span className="onboard-grow" />
                  <button className="onboard-btn" disabled={saving} onClick={() => setStep(1)}>let&apos;s go →</button>
                </>
              )}
              {step > 0 && !done && (
                <>
                  <button className="onboard-btn ghost" disabled={saving} onClick={() => setStep((s) => s - 1)}>← back</button>
                  <span className="onboard-grow" />
                  {last ? (
                    <button className="onboard-btn" disabled={saving} onClick={() => void finish(false)}>{saving ? "saving…" : "save & to the band 🏹"}</button>
                  ) : (
                    <button className="onboard-btn" disabled={saving} onClick={() => setStep((s) => s + 1)}>next →</button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}