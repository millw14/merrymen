"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import type { SettingsView } from "@/app/api/settings/route";
import type { TelegramStatus } from "@/app/api/telegram/route";

type Draft = Record<string, string>;

function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field settings-field">
      <span className="field-label">{props.label}</span>
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
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [tgEnabled, setTgEnabled] = useState<boolean | null>(null);
  const [tgControl, setTgControl] = useState<boolean | null>(null);
  const [tgTransfer, setTgTransfer] = useState<boolean | null>(null);
  const [tgNotify, setTgNotify] = useState<boolean | null>(null);
  const [allowlist, setAllowlist] = useState<number[] | null>(null);
  const [tgTest, setTgTest] = useState<string | null>(null);

  const loadTelegram = () =>
    fetch("/api/telegram")
      .then((r) => (r.ok ? (r.json() as Promise<TelegramStatus>) : null))
      .then((s) => s && setTg(s))
      .catch(() => {});

  useEffect(() => {
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

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const v = (k: keyof SettingsView["values"]): string => {
    if (k in draft) return draft[k as string]!;
    const stored = view?.values[k];
    return stored === undefined || stored === null ? "" : String(stored);
  };

  function toggleSymbol(sym: string) {
    const current = symbols ?? view?.values.basketSymbols ?? view?.defaults.basketSymbols ?? [];
    setSymbols(current.includes(sym) ? current.filter((s) => s !== sym) : [...current, sym]);
  }

  async function save() {
    setStatus("saving…");
    setErrors([]);
    const body: Record<string, unknown> = { ...draft };
    if (symbols !== null) body.basketSymbols = symbols;
    if (tgEnabled !== null) body.telegramEnabled = tgEnabled;
    if (tgControl !== null) body.telegramControlEnabled = tgControl;
    if (tgTransfer !== null) body.telegramTransferEnabled = tgTransfer;
    if (tgNotify !== null) body.telegramNotifyEnabled = tgNotify;
    if (allowlist !== null) body.telegramAllowlist = allowlist;
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
      setAllowlist(null);
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
      <main className="grant-shell">
        <div className="grant-panel mono">loading settings…</div>
      </main>
    );
  }

  const d = view.defaults;
  const activeSymbols = symbols ?? view.values.basketSymbols ?? d.basketSymbols;
  const secretPlaceholder = (s: { set: boolean; hint: string | null }) =>
    s.set ? `saved ····${s.hint ?? ""} — type to replace` : "not set";

  const tgEnabledVal = tgEnabled ?? view.values.telegramEnabled ?? d.telegramEnabled;
  const tgControlVal = tgControl ?? view.values.telegramControlEnabled ?? d.telegramControlEnabled;
  const tgTransferVal = tgTransfer ?? view.values.telegramTransferEnabled ?? d.telegramTransferEnabled;
  const tgNotifyVal = tgNotify ?? view.values.telegramNotifyEnabled ?? d.telegramNotifyEnabled;
  const allowlistVal = allowlist ?? view.values.telegramAllowlist ?? [];

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
      <header className="topbar">
        <Link href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="arrow"><LogoMark size={20} /></span>
          <span>merrymen</span>
          <span className="tagline">settings</span>
        </Link>
        <Link href="/" className="connect-btn" style={{ textDecoration: "none" }}>
          back to the band
        </Link>
      </header>

      <main className="grant-shell">
        <div className="grant-panel settings-panel">
          <h1 className="grant-title">connections &amp; keys</h1>
          <p className="grant-sub">
            Everything here is stored locally in <code>.data/settings.json</code> (gitignored) and
            picked up by the worker within one tick — no restarts. Keys are never sent back to the
            browser. Leave a key field blank to keep what&apos;s saved; use clear to remove it.
          </p>

          <div className="settings-section mono">execution</div>
          <div className="grant-fields settings-grid">
            <Field
              label="bundler RPC URL"
              hint="ERC-4337 bundler — get one free at dashboard.pimlico.io or dashboard.alchemy.com. The chain id in the URL MUST match your grant's chain (46630 testnet · 4663 mainnet) or every op fails. Without it, the agent simulates but never signs."
            >
              <input
                type="url"
                placeholder="https://api.pimlico.io/v2/46630/rpc?apikey=…"
                value={v("bundlerUrl")}
                onChange={set("bundlerUrl")}
              />
            </Field>
            <Field
              label="mainnet RPC override"
              hint="Optional. The public RPC rate-limits at 1-minute ticks; a free Alchemy/QuickNode endpoint is smoother."
            >
              <input type="url" placeholder="default: rpc.mainnet.chain.robinhood.com" value={v("rpcMainnet")} onChange={set("rpcMainnet")} />
            </Field>
            <Field label="testnet RPC override" hint="Optional.">
              <input type="url" placeholder="default: rpc.testnet.chain.robinhood.com" value={v("rpcTestnet")} onChange={set("rpcTestnet")} />
            </Field>
            <Field
              label="breaker contract"
              hint="Deployed BreakerRegistry address. Once set, a tripped breaker halts all trading at the wall."
            >
              <input type="text" placeholder="0x…" value={v("breakerAddress")} onChange={set("breakerAddress")} />
            </Field>
          </div>

          <div className="settings-section mono">api keys</div>
          <div className="grant-fields settings-grid">
            <Field
              label="Anthropic API key"
              hint="Powers the LLM strategist. Create one at console.anthropic.com → API keys. Blank keeps the saved key."
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.anthropicApiKey)}
                value={draft.anthropicApiKey ?? ""}
                onChange={set("anthropicApiKey")}
              />
              {view.anthropicApiKey.set && (
                <button type="button" className="btn-kill settings-clear" onClick={() => setDraft((x) => ({ ...x, anthropicApiKey: "" }))}>
                  clear
                </button>
              )}
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

          <div className="settings-section mono">telegram · chat with your merryman</div>
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
                Lets chat send USDG out (always asks to /confirm; amount capped on-chain by your per-trade cap). Needs a grant created after this feature shipped.
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

          <div className="settings-section mono">strategy &amp; trading</div>
          <div className="grant-fields settings-grid">
            <Field
              label="strategy"
              hint="steady-basket = DCA + vault sweep · weekend-gap = trade the close→open gap · llm-strategist = Claude proposes, policy disposes. Your own bots from strategies/ appear below the line — scaffold one with `npx merrymen strategy new my-bot`."
            >
              <select value={v("strategy") || d.strategy} onChange={set("strategy")}>
                {view.strategies.builtin.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                {view.strategies.custom.length > 0 && (
                  <option disabled>── your strategies ──</option>
                )}
                {view.strategies.custom.map((s) => (
                  <option key={s} value={s}>
                    {s} (custom)
                  </option>
                ))}
              </select>
            </Field>
            <Field label="swap venue" hint="uniswap = permissionless v3 (QQQ has liquidity today) · rialto = meta-router (needs the key above for full execution).">
              <select value={v("swapVenue") || d.swapVenue} onChange={set("swapVenue")}>
                <option value="uniswap">uniswap</option>
                <option value="rialto">rialto</option>
              </select>
            </Field>
            <Field label="max slippage" hint="vs the pre-trade quote.">
              <input type="number" min={1} max={5000} placeholder={String(d.slippageBps)} value={v("slippageBps")} onChange={set("slippageBps")} />
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
            <Field label="LLM model" hint="Model id for the strategist.">
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

          <div className="settings-section mono">basket universe · equal-weighted</div>
          <div className="symbol-grid">
            {view.knownSymbols.map((sym) => (
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
            .data/settings.json on this machine.
          </div>
        </div>
      </main>
    </>
  );
}
