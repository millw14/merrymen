"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { HolderLink } from "../HolderLink";
import { XPosting } from "../XPosting";
import { AgentImageField } from "../AgentImageField";
import { basketAfterAdd, basketNow } from "../basket";
import { isCircleStrategyId } from "../strategy";
import type { TierView } from "@/app/api/tier/route";
import { loadTier } from "../tier";
import { FormPage as AppShell, FormHeading as PageHeader } from "../FormPage";
import { ENERGY, MERRYMEN_GATEWAY_ORIGIN, SLIPPAGE_BPS_MAX, TELEGRAM_GROUPS_CHATTINESS, isEnergyReserveToken, isValidCustomToken, uncoveredBasketSymbols, type CustomToken, type StoredGrant, type TelegramGroupsChattiness } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";
import type { TelegramStatus } from "@/app/api/telegram/route";
import { telegramLabel, telegramRow, type TelegramRow } from "../agent-status";
import SetupChecklist from "../SetupChecklist";
import { SettingsProposal } from "../SettingsProposal";
import { count, shortDateTime } from "@/lib/format";
import { unreadableSetting } from "@/lib/parse-amount";
import { providerChange, providerModelChange, providerModelValue } from "@/lib/settings-llm-model";
import { useT } from "@/lib/i18n";
// QUARANTINED alongside /grant. A settings form is not a surface anybody shares
// from a phone, and its ~30 fields are styled against the old sheet — so it
// keeps it, and the sheet no longer reaches anything else.

type Draft = Record<string, string>;

/** What each Telegram groups level is called on the page, in core's order. */
const CHATTINESS_LABEL = {
  quiet: "settings.text.chattinessQuiet",
  normal: "settings.text.chattinessNormal",
  chatty: "settings.text.chattinessChatty",
} as const satisfies Record<TelegramGroupsChattiness, string>;

function Field(props: {
  label: string;
  hint?: React.ReactNode;
  /** Optional "get a key ↗" link shown beside the label (opens the provider). */
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="mm-field setting-field">
    <label>
      <span className="mm-labelrow">
        <span className="mm-label">{props.label}</span>
        {props.action && (
          <a className="mm-getkey" href={props.action.href} target="_blank" rel="noreferrer">
            {props.action.label} ↗
          </a>
        )}
      </span>
      <span className="mm-input">{props.children}</span>
    </label>
    {props.hint && <details className="setting-help"><summary aria-label={`About ${props.label}`}><CircleHelp size={15}/></summary><div className="mm-hint">{props.hint}</div></details>}
    </div>
  );
}

/**
 * WHAT THE PROCESS POLLING THE BOT MEASURED, beside the code it is about.
 *
 * The code is what an owner sends into the bot, so this is where they must
 * learn that nothing is reading it. In the incident behind these states the
 * page said "the bot is listening" and showed a code for days in which
 * nothing polled the bot; the owner sent that code five times and was locked
 * out. Nothing is rendered for a bot being heard, or one we cannot tell about.
 */
function TelegramListeningNote({ row }: { row: TelegramRow }) {
  const t = useT();
  let text: string | null = null;
  if (row.kind === "held") text = t("settings.tg.held", { reason: row.reason ?? "restore error" });
  else if (row.kind === "not-listening") {
    text =
      row.why === "revoked"
        ? t("settings.tg.revoked")
        : row.why === "conflict"
          ? t("settings.tg.conflict")
          : row.lastOkAt !== null
            ? t("settings.tg.notListeningSince", { when: shortDateTime(row.lastOkAt * 1000) })
            : t("settings.tg.notListeningNever");
  }
  if (!text) return null;
  // The code stays on screen below, and says when it will work.
  const codeShown = (row.kind === "held" || row.kind === "not-listening") && row.linkCode !== null;
  return (
    <div className="mm-danger" role="status">
      {text}
      {row.kind === "not-listening" && codeShown ? <> {t("settings.tg.codeWhenBack")}</> : null}
    </div>
  );
}

/** `onSaved`: after a save the server accepted — App hands it the chat's re-read, so the chips already on screen offer the ceiling just set. */
export default function SettingsPage({onFund, slug, onSaved}:{onFund:()=>void; slug: string | null; onSaved?: () => void}) {
  const t = useT();
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [symbols, setSymbols] = useState<string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const [trencherPrepared, setTrencherPrepared] = useState(false);
  const [settingsVerified, setSettingsVerified] = useState(false);
  // The "saved" note clears itself after a few seconds; the timer is dropped
  // when the screen goes away, so it never fires into an unmounted form.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current); }, []);
  const [errors, setErrors] = useState<string[]>([]);
  /**
   * THE BOT IS CLAIMED BY ANOTHER AGENT: what the server said, while the owner
   * decides whether to move it here. Null when there is nothing to decide.
   * The draft is kept as it was, so "Move it here" re-sends the same save.
   */
  const [botClaimed, setBotClaimed] = useState<string | null>(null);
  /** The last save moved the bot here: nobody is linked to it here yet, so say so until the next save. */
  const [botMoved, setBotMoved] = useState(false);
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
  // Telegram groups (docs/tg-groups.md "Settings"): two switches that default
  // ON and a level. Dashboard-only — the chat refuses all three — so this form
  // is where an owner changes them. Null = untouched this session.
  const [tgGroups, setTgGroups] = useState<boolean | null>(null);
  const [tgGroupCoins, setTgGroupCoins] = useState<boolean | null>(null);
  const [tgChattiness, setTgChattiness] = useState<TelegramGroupsChattiness | null>(null);
  const [virtualsEnabled, setVirtualsEnabled] = useState<boolean | null>(null);
  // Scout mode is a boolean, so it can't ride the string `draft`.
  const [deskEnabled, setDeskEnabled] = useState<boolean | null>(null);
  const [scoutEnabled, setScoutEnabled] = useState<boolean | null>(null);
  const [classSnipe, setClassSnipe] = useState<boolean | null>(null);
  /** The owner's consent to spend real money. Null = untouched this session. */
  const [liveTrading, setLiveTrading] = useState<boolean | null>(null);
  /** Which kinds of thing the agent may BUY. Null = untouched this session. */
  const [assetMode, setAssetMode] = useState<"all" | "stocks" | "crypto" | null>(null);
  const [discoveryEnabled, setDiscoveryEnabled] = useState<boolean | null>(null);
  const [trencherLive, setTrencherLive] = useState<boolean | null>(null);
  const [trencherFast, setTrencherFast] = useState<boolean | null>(null);
  const [officialCoins, setOfficialCoins] = useState<boolean | null>(null);
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
  /**
   * SHOULD THE AGENT TRADE THIS ONE, as well as know about it?
   *
   * Defaulted ON, and shown right beside the address box rather than assumed.
   * Adding a token and trading it are two different writes — `customTokens` says
   * "know about this", `basketSymbols` says "trade it" — and the second was
   * offered nowhere an owner would find it: the chip renders unselected at the
   * end of twenty-five identical stock chips, and the rule itself lived only in
   * a JSX comment. An owner pasted an address, saved, re-signed, and asked the
   * group why his agent still traded only stocks. He had done nothing wrong.
   *
   * NOT made automatic, because `strategies/registry.ts` is deliberate about it:
   * "a token added to be tracked must not start being bought on its own." That
   * rule protects an owner from the PLATFORM widening what gets bought. A person
   * typing forty-two hex characters and pressing a button is not the platform —
   * so the choice is theirs, made visible, made here, and reversible.
   */
  const [tradeNewToken, setTradeNewToken] = useState(true);
  const [tokenError, setTokenError] = useState<string | null>(null);
  // The grant the browser holds, so the basket can say which symbols this
  // signature can actually get back out of. null = none stored yet.
  const [storedGrant, setStoredGrant] = useState<StoredGrant | null>(null);
  // AI provider model listing — fetched from the provider's models API.
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Model-list failure, in words a non-developer can act on. Built here (not
  // in the render) so the render below stays one literal line — see the pin
  // in house-key-and-basket.test.ts. `missing_key` never reaches this: it
  // renders as the neutral hint, not an error.
  const modelsErrorMessage = (
    code: string,
    source: string | null,
    provider: { label: string; keyUrl: string },
  ): string => {
    if (code === "key_rejected") {
      const whose =
        source === "typed" ? t("settings.msg.keyJustTyped") : source === "house" ? t("settings.msg.keySharedKey") : t("settings.msg.theSavedKey");
      const where = provider.keyUrl ? t("settings.msg.keyCheckAt", { host: provider.keyUrl.replace(/^https?:\/\//, "") }) : "";
      return t("settings.msg.keyRefused", { provider: provider.label, whose, where });
    }
    return t("settings.msg.keyUnreachable", { provider: provider.label });
  };
  /**
   * This account standing against the Circle rule.
   *
   * The CREATE flow warns; this one never did — and this is the flow a beta
   * tester with an existing agent actually uses. A bare dropdown of raw ids let
   * somebody switch to a strategy their tier will not run and answered ok.
   */
  const [tier, setTier] = useState<TierView | null>(null);
  useEffect(() => {
    void loadTier().then(setTier);
  }, []);

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
      setLoadError(false);
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("Settings unavailable");
        setView((await res.json()) as SettingsView);
      } catch {
        setLoadError(true);
      }
      void loadTelegram();
    })();
  }, [loadAttempt]);

  // A LINK TO ONE SETTING OPENS THE GROUP IT SITS IN. The chat's "Open
  // Settings" button and the pages that point here link to a control by its
  // id (#launchpad-buying, #trencher-mode, #telegram, #x-posting). A control
  // inside a collapsed group made that a link to a page that seemed not to have
  // it: an owner told launchpad buying was "on the dashboard" could not find
  // it, because it sat closed inside "Custom tokens & discovery". Run once the
  // form is on screen (the ids do not exist before), and on every later hash.
  const formShown = view !== null;
  useEffect(() => {
    if (!formShown) return;
    const reveal = () => {
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      const group = target.closest("details");
      if (group && !group.open) group.open = true;
      target.scrollIntoView?.({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [formShown]);

  // Debounced model fetch — triggers when provider, key, or custom URL changes.
  // No client-side gate on key presence: the server may still serve the list
  // from the shared house key, which the client cannot see. A response with no
  // key behind it comes back as missing_key and renders as the neutral hint
  // below — never as an error for something the user never did.
  useEffect(() => {
    if (!view) return;
    const providerId = draft.llmProvider ?? view.values.llmProvider ?? "groq";
    const prov = view.llmProviders.find((p) => p.id === providerId);
    if (!prov) { setAvailableModels([]); setModelsError(null); return; }

    setAvailableModels([]);
    setModelsLoading(true);
    setModelsError(null);

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const body: Record<string, string | boolean> = { provider: prov.id };
        const kf = prov.id === "groq" ? "groqApiKey" : prov.id === "anthropic" ? "anthropicApiKey" : "llmApiKey";
        const keyInDraft = draft[kf]?.trim();
        if (keyInDraft) body.apiKey = keyInDraft;
        else if (draft[kf] !== undefined) body.useSavedKey = false;
        if (prov.id === "custom") {
          const bu = draft.llmBaseUrl?.trim() || (view.values.llmBaseUrl as string | undefined) || "";
          if (bu) body.baseUrl = bu;
        }
        const res = await fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const j = (await res.json()) as { models?: string[]; error?: string; code?: string; keySource?: string };
        if (controller.signal.aborted) return;
        if (res.ok && j.models) {
          setAvailableModels(j.models);
          setModelsError(null);
        } else {
          setAvailableModels([]);
          const code = j.code ?? "provider_error";
          setModelsError(code === "missing_key" ? code : modelsErrorMessage(code, j.keySource ?? null, prov));
        }
      } catch {
        if (controller.signal.aborted) return;
        setAvailableModels([]);
        setModelsError(modelsErrorMessage("provider_error", null, prov));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    }, 500);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [view, draft.llmProvider, draft.groqApiKey, draft.anthropicApiKey, draft.llmApiKey, draft.llmBaseUrl]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  /**
   * A NUMERIC SETTING, HELD AS TEXT.
   *
   * These fields were `<input type="number">`, and that control hands
   * JavaScript an EMPTY STRING for anything its own locale cannot parse. Empty
   * means "clear to default" at the server, so a German owner typing 25,50 did
   * not get an error — they silently reset the setting, and the screen said
   * "Changes saved".
   *
   * It is also the reason `<html lang>` could not become dynamic while these
   * existed: Firefox resolves a number input's decimal separator from the page
   * language, so translating the UI would have changed which strings these
   * fields accept and which collapsed to "".
   *
   * THE SHAPE IS CHECKED HERE AND THE BOUNDS ARE NOT. Mirroring the server's
   * thirty min/max pairs into the browser is the duplication route.ts's own
   * comments warn about three times over. "I cannot read that" and "that is
   * too large" are different questions, and only the first is the screen's.
   */
  const [numError, setNumError] = useState<Record<string, string>>({});
  const setNum = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft((d) => ({ ...d, [k]: raw }));
    setNumError((n) => {
      const why = unreadableSetting(k, raw);
      if (why === (n[k] ?? null)) return n;
      const next = { ...n };
      if (why) next[k] = why;
      else delete next[k];
      return next;
    });
  };

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
    return typeof stored === "string" && stored ? t("settings.msg.savedRedacted", { value: stored }) : fallback;
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
      setTokenError(t("settings.msg.needsAShortSymbol"));
      return;
    }
    // $MERRYMEN IS ENERGY, NOT A COIN TO TRADE. Every signer drops it from the
    // sealed tokens and the worker never watches it, so adding it here would
    // only produce a token that can never be covered, whatever gets re-signed.
    if (isEnergyReserveToken(candidate.address)) {
      setTokenError(t("settings.msg.energyIsNotACoin"));
      return;
    }
    const current = tokens ?? (view?.values.customTokens as CustomToken[] | undefined) ?? [];
    if (current.some((t) => t.address.toLowerCase() === candidate.address.toLowerCase())) {
      setTokenError(t("settings.msg.tokenAlreadyListed", { address: candidate.address.slice(0, 10) }));
      return;
    }
    setTokens([...current, candidate]);
    // THE SECOND WRITE, which never happened here. `Proposals.tsx` has always
    // done both in one click; this screen wrote only `customTokens`, so a token
    // was added and never selected, and the basket stayed on its stocks-only
    // default. `basketNow` rather than `values.basketSymbols ?? []` because an
    // unset basket is the DEFAULT basket, not an empty one — reading it as
    // empty would narrow the agent's whole universe to the coin just added.
    // `symbols` first: an edit made in this session has not been saved yet, and
    // rebuilding from `view` would silently throw it away.
    setSymbols(
      basketAfterAdd({
        saved: symbols ?? basketNow({ values: view?.values, defaults: view?.defaults }),
        symbol: candidate.symbol,
        trade: tradeNewToken,
      }),
    );
    setNewToken({ symbol: "", address: "", decimals: "18" });
  }

  function removeToken(address: string) {
    const current = tokens ?? (view?.values.customTokens as CustomToken[] | undefined) ?? [];
    setTokens(current.filter((t) => t.address.toLowerCase() !== address.toLowerCase()));
  }

  /** `moveBot`: the owner answered "Move it here" to a bot another agent holds. */
  async function save(opts: { moveBot?: boolean } = {}) {
    if (saveInFlight.current) return;
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setSettingsVerified(false);
    setStatus("saving…");
    setErrors([]);
    setBotClaimed(null);
    setBotMoved(false);
    // An unreadable field would be sent as typed and rejected, or — worse, if
    // it were ever blanked first — sent as "" and read as "clear to default".
    const unreadable = Object.entries(numError);
    if (unreadable.length > 0) {
      setStatus(null);
      setErrors(unreadable.map(([k, why]) => `${k}: ${why}`));
      return;
    }
    const body: Record<string, unknown> = { ...draft };
    if (symbols !== null) body.basketSymbols = symbols;
    if (tokens !== null) body.customTokens = tokens;
    if (tgEnabled !== null) body.telegramEnabled = tgEnabled;
    if (tgControl !== null) body.telegramControlEnabled = tgControl;
    if (tgTransfer !== null) body.telegramTransferEnabled = tgTransfer;
    if (tgNotify !== null) body.telegramNotifyEnabled = tgNotify;
    // Guarded like every toggle here, and it matters more for these two than
    // for most: both default ON, so an unguarded send would write whatever the
    // form happened to hold for every owner who saved anything at all.
    if (tgGroups !== null) body.telegramGroupsEnabled = tgGroups;
    if (tgGroupCoins !== null) body.telegramGroupCoinsEnabled = tgGroupCoins;
    if (tgChattiness !== null) body.telegramGroupsChattiness = tgChattiness;
    if (virtualsEnabled !== null) body.virtualsEnabled = virtualsEnabled;
    if (deskEnabled !== null) body.deskEnabled = deskEnabled;
    if (scoutEnabled !== null) body.scoutEnabled = scoutEnabled;
    if (classSnipe !== null) body.classSnipeEnabled = classSnipe;
    if (liveTrading !== null) body.liveTradingEnabled = liveTrading;
    if (assetMode !== null) body.assetMode = assetMode;
    if (discoveryEnabled !== null) body.discoveryEnabled = discoveryEnabled;
    if (trencherLive !== null) body.trencherLiveEnabled = trencherLive;
    if (trencherFast !== null) body.trencherFastEnabled = trencherFast;
    if (officialCoins !== null) body.officialCoinsEnabled = officialCoins;
    if (allowlist !== null) body.telegramAllowlist = allowlist;
    if (pcEnabled !== null) body.telegramPcControlEnabled = pcEnabled;
    if (caps !== null) body.telegramCapabilities = caps;
    if (shellList !== null) body.telegramShellAllowlist = shellList;
    if (appList !== null) body.telegramAppAllowlist = appList;
    if (agentEnabled !== null) body.telegramAgentEnabled = agentEnabled;
    if (agentAutoShell !== null) body.telegramAgentAutoShell = agentAutoShell;
    if (opts.moveBot) body.moveBot = true;
    // Secrets: only send when the user typed something or hit clear ("").
    saveInFlight.current = true;
    let accepted = false;
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // FOR THE WALLET THESE VALUES WERE READ FOR (SettingsView.owner): a
        // different wallet signed in by another tab since is refused by the
        // route, not written to. Sent whenever the view names one — "" too,
        // a form read signed out, which no session is.
        body: JSON.stringify(view && view.owner !== null ? { ...body, owner: view.owner } : body),
      });
      const json = (await res.json()) as { ok?: boolean; errors?: string[]; error?: string; botMoved?: boolean };
      // ANOTHER AGENT HOLDS THIS BOT. Not an error in the form: a question for
      // the owner, asked beside the button they pressed. Nothing was saved.
      if (res.status === 409 && json.error === "bot_claimed") {
        setBotClaimed(json.errors?.[0] ?? t("settings.msg.botClaimedFallback"));
        setStatus(null);
        return;
      }
      if (!res.ok) {
        setErrors(json.errors ?? [t("settings.msg.saveFailed")]);
        setStatus(null);
        return;
      }
      accepted = true;
      // Keep the draft until the server's values can replace it. Otherwise a
      // failed read shows the old settings immediately after claiming a save.
      const fresh = await fetch("/api/settings");
      if (!fresh.ok) throw new Error("Settings readback unavailable");
      const savedView = (await fresh.json()) as SettingsView;
      if (savedView.owner !== view?.owner) throw new Error("Settings owner changed");
      setView(savedView);
      setStatus("Changes saved");
      setSettingsVerified(true);
      // A moved bot answers here now, but nobody is linked to it here yet.
      setBotMoved(json.botMoved === true);
      onSaved?.();
      setDraft({});
      setSymbols(null);
      setTgEnabled(null);
      setTgControl(null);
      setTgTransfer(null);
      setTgNotify(null);
      // Cleared with the rest, so after a save the screen shows the SERVER's
      // Telegram groups values — not "THE SEVEN THAT WERE LEFT BEHIND" below
      // over again.
      setTgGroups(null);
      setTgGroupCoins(null);
      setTgChattiness(null);
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
      // THE SEVEN THAT WERE LEFT BEHIND.
      //
      // Everything above is cleared so the verified readback is what the screen
      // shows. These were not, so after a save they kept displaying the LOCAL
      // value while `view` held the server's — and the two differ exactly when
      // a write did not land. A hosted tenant toggling a field the API strips
      // reads "Changes saved" and goes on seeing their own toggle until a
      // reload; the strip is deliberate (route.ts deletes the RCE fields before
      // any handler sees them) but the screen then disagrees with the server
      // about whether an agent may spend real money, which this form may not do.
      setTrencherLive(null);
      setTrencherFast(null);
      setLiveTrading(null);
      setAssetMode(null);
      setDeskEnabled(null);
      setClassSnipe(null);
      setOfficialCoins(null);
      void loadTelegram();
      if (statusTimer.current) clearTimeout(statusTimer.current);
      statusTimer.current = setTimeout(() => setStatus(null), 4000);
    } catch {
      setErrors([accepted
        ? t("settings.msg.saveAcceptedUnverified")
        : t("settings.msg.couldNotReachThe")]);
      setStatus(null);
    } finally {
      saveInFlight.current = false;
    }
  }

  if (view === null) {
    return (
      <AppShell>
        <PageHeader title={t("settings.msg.settings")} />
        <div className="mm-wrap">
          {loadError ? <><p role="alert" className="mm-note">{t("settings.text.couldNotLoadYour")}</p><button className="mm-btn" onClick={()=>setLoadAttempt(x=>x+1)}>{t("settings.text.tryAgain")}</button></> : <p role="status" className="mm-note">{t("settings.text.loadingSettings")}</p>}
        </div>
      </AppShell>
    );
  }

  const d = view.defaults;
  const hasUnsavedChanges = Object.keys(draft).length > 0 || [
    symbols, tokens, tgEnabled, tgControl, tgTransfer, tgNotify, tgGroups,
    tgGroupCoins, tgChattiness, virtualsEnabled, deskEnabled, scoutEnabled,
    classSnipe, liveTrading, assetMode, discoveryEnabled, trencherLive,
    trencherFast, officialCoins, allowlist, pcEnabled, caps, shellList,
    appList, agentEnabled, agentAutoShell,
  ].some(value => value !== null);
  const activeSymbols = symbols ?? view.values.basketSymbols ?? d.basketSymbols;
  /** What is actually listed on this chain — not whether the setting is on. */
  const listedCoins = view.officialCoins ?? [];
  const activeTokens =
    tokens ?? ((view.values.customTokens as CustomToken[] | undefined) ?? []);
  // Read the grant straight from localStorage — this page has no other handle on
  // it, and what matters is the signature the browser actually holds.
  // WITH THE OWNER'S OWN TOKENS, so the banner can fire for a memecoin — the
  // token most likely to have been added after the grant was signed, and the one
  // this warning could never reach. Unlike Wallet.tsx and the worker's coverage
  // note, this screen has no `tokenCoverage` union of its own to double-report.
  const unsellable = uncoveredBasketSymbols(activeSymbols, storedGrant, activeTokens);
  const secretPlaceholder = (s: { set: boolean; hint: string | null }) =>
    s.set ? t("settings.msg.savedWithHint", { hint: s.hint ?? "" }) : t("settings.msg.notSet");

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
  const providerModelVal = providerModelValue({ ...view.values, ...draft }, prov.id);
  const setProviderModel = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, ...providerModelChange(prov.id, e.target.value) }));
  const providerNeedsKey = prov.needsKey !== false;

  const tgEnabledVal = tgEnabled ?? view.values.telegramEnabled ?? d.telegramEnabled;
  const tgControlVal = tgControl ?? view.values.telegramControlEnabled ?? d.telegramControlEnabled;
  const tgTransferVal = tgTransfer ?? view.values.telegramTransferEnabled ?? d.telegramTransferEnabled;
  const tgNotifyVal = tgNotify ?? view.values.telegramNotifyEnabled ?? d.telegramNotifyEnabled;
  // `?? d.…` doing real work, as for officialCoinsEnabled: both switches
  // default ON, so an owner who never saved them has no stored value, and
  // falling through to `false` would show them off while the bot talked.
  const tgGroupsVal = tgGroups ?? view.values.telegramGroupsEnabled ?? d.telegramGroupsEnabled;
  const tgGroupCoinsVal = tgGroupCoins ?? view.values.telegramGroupCoinsEnabled ?? d.telegramGroupCoinsEnabled;
  const tgChattinessVal = tgChattiness ?? view.values.telegramGroupsChattiness ?? d.telegramGroupsChattiness;
  const virtualsEnabledVal = virtualsEnabled ?? view.values.virtualsEnabled ?? d.virtualsEnabled;
  const deskEnabledVal = deskEnabled ?? view.values.deskEnabled ?? d.deskEnabled;
  const scoutEnabledVal = scoutEnabled ?? view.values.scoutEnabled ?? d.scoutEnabled;
  const classSnipeVal = classSnipe ?? view.values.classSnipeEnabled ?? d.classSnipeEnabled;
  const liveTradingVal = liveTrading ?? view.values.liveTradingEnabled ?? d.liveTradingEnabled;
  const assetModeVal = assetMode ?? view.values.assetMode ?? d.assetMode;
  const discoveryEnabledVal = discoveryEnabled ?? view.values.discoveryEnabled ?? d.discoveryEnabled;
  const trencherLiveVal = trencherLive ?? view.values.trencherLiveEnabled ?? d.trencherLiveEnabled;
  // `?? d.officialCoinsEnabled` is doing real work here, not defensive padding:
  // this is the one setting whose default is ON, so an owner who has never saved
  // it has NO stored value, and falling through to `false` would render the
  // checkbox unticked while the worker traded the list. The control would then be
  // lying about the system's actual behaviour.
  const officialCoinsVal = officialCoins ?? view.values.officialCoinsEnabled ?? d.officialCoinsEnabled;
  const trencherPresetSelected = (draft.strategy ?? view.values.strategy ?? d.strategy) === "trencher"
    && assetModeVal === "crypto" && discoveryEnabledVal && officialCoinsVal
    && (trencherFast ?? view.values.trencherFastEnabled ?? d.trencherFastEnabled)
    && Number(draft.tickSeconds ?? view.values.tickSeconds ?? d.tickSeconds) === 15;
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
    { id: "screen", label: t("settings.msg.screen") },
    { id: "vision", label: t("settings.msg.vision") },
    { id: "apps", label: t("settings.msg.appsWeb") },
    { id: "system", label: t("settings.msg.system") },
    { id: "files", label: t("settings.msg.files") },
    { id: "clipboard", label: t("settings.msg.clipboard") },
    { id: "shell", label: t("settings.msg.shell") },
    { id: "keyboard", label: t("settings.msg.keyboard") },
    { id: "voice", label: t("settings.msg.voice") },
    { id: "watchers", label: t("settings.msg.watchers") },
  ];

  async function testTelegram() {
    setTgTest(t("settings.msg.testingState"));
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", token: draft.telegramBotToken || undefined }),
      });
      const j = (await res.json()) as { ok?: boolean; username?: string; reason?: string };
      setTgTest(j.ok ? t("settings.msg.tgTestOk", { user: j.username ?? "" }) : t("settings.msg.tgTestFail", { reason: j.reason ?? t("settings.msg.failedWord") }));
      void loadTelegram();
    } catch {
      setTgTest(t("settings.msg.tgTestUnreachable"));
    }
  }

  return (
    <AppShell>
      {/* The rail, the tape, the tab bar and the search — none of which this
          page has ever had. Clicking Settings in the rail used to drop the
          reader onto a screen with no navigation at all and a brand mark as
          the only way back. */}
      <PageHeader title={t("settings.msg.settings")} />

      {/* SAY IT, THEN APPROVE IT. The first thing on the page is the way most
          owners will change anything: describe it, see the before and after,
          tap Approve. It is also where the agent's "Review & approve" button
          from Telegram and Chat lands (#proposal, ?propose=…). The form below
          is unchanged for anyone who would rather set a dial by hand. */}
      <div id="proposal">
        <SettingsProposal
          values={view.values as Record<string, unknown>}
          defaults={view.defaults as unknown as Record<string, unknown>}
          owner={view.owner}
          symbols={[...view.knownSymbols, ...(view.values.customTokens ?? []).map((tk) => tk.symbol.toUpperCase())]}
          hosted={view.owner !== null}
          onApplied={() => setLoadAttempt((x) => x + 1)}
        />
      </div>

      <fieldset className="mm-wrap" disabled={status === "saving…"} style={{ border: 0, minWidth: 0, margin: 0, padding: 0 }}>
        <p className="mm-note">
            {t("settings.text.leaveAnApiKey")}
        </p>

        {/* Setup steps live here after the /app muster is done — a quiet, honest
            status strip read from real state, and a fast way back to fund or re-key. */}
        <SetupChecklist onFund={onFund} paper={view.values.paperTradingEnabled ?? view.defaults.paperTradingEnabled}/>

          {/* ── PAPER OR LIVE ───────────────────────────────────────────────
              THE SWITCH THAT DID NOT EXIST.

              Two other screens have been telling owners to "turn paper trading
              on in Settings" for months. There was no control here — not for
              paper, not for live — so the only way to change how an agent
              treated real money was a chat command most owners never found.
              Worse, it would not have helped: until `liveTradingEnabled` was
              added, nothing anywhere withheld permission to trade for real, and
              a funded agent on mainnet traded real money whatever its owner had
              chosen in the create wizard.

              FIRST ON THE PAGE because it outranks everything below it. A
              strategy, a cap or a venue only matters once you know whether the
              money is real. */}
          <div className="mm-section">{t("settings.section.tradingMode")}</div>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.liveTrading")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={liveTradingVal}
                  onChange={(e) => setLiveTrading(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {liveTradingVal
                    ? t("settings.msg.onRealOrdersReal")
                    : t("settings.msg.offPaperModePractising")}
                </span>
              </span>
              <span className="mm-hint">
                {liveTradingVal
                  ? t("settings.msg.yourAgentPlacesReal")
                  : t("settings.msg.nothingYourAgentDoes")}
              </span>
            </label>
          </div>
          {!liveTradingVal && (view.values.liveTradingEnabled ?? d.liveTradingEnabled) && (
            /* TURNING IT OFF IS NOT A NEUTRAL ACT IF REAL MONEY IS ALREADY OUT.
               On the paper rail the tick values the PAPER BOOK — positions come
               from `paperPositionsOf(bookRow.shares)` and nothing reads the
               chain — so tokens bought with real funds become invisible to the
               agent: no stop-loss, no take-profit, no exit of any kind, and a
               screen showing a tidy simulated book over the top of them.
               Nothing warns about it anywhere else, and switching back is the
               only thing that restores it. */
            <p className="mm-hint" style={{ marginTop: 8 }}>
              <b>{t("settings.text.ifYourAgentHolds")}</b> {t("settings.text.inPaperModeIt")}
            </p>
          )}
          {liveTradingVal && !(view.values.liveTradingEnabled ?? d.liveTradingEnabled) && (
            /* SAID BEFORE IT IS TRUE, not after. The owner has ticked the box
               but not yet pressed save, which is the last moment this sentence
               can still be useful to them. */
            <p className="mm-hint" style={{ marginTop: 8 }}>
              <b>{t("settings.text.thisSpendsRealMoney")}</b> {t("settings.text.onceYouSaveYour")}
            </p>
          )}

          {/* ── WHAT IT TRADES ──────────────────────────────────────────────
              Asked for by several owners at once: "there should be an option
              mode for stocks only, crypto only, combo, or meme coin only", and
              "it's great to toggle between stocks and crypto mode — sometimes
              trading stocks is better when crypto bear is here".

              FOUR CARDS, THREE MODES. `instrumentClassOf` can only tell an
              equity from everything else, so shipping "crypto" and "meme coins"
              as separate modes would be two names for one filter. The fourth
              card writes `crypto` plus the switches that already govern buying
              things nobody can price, and says so on the card rather than
              implying a classification that does not exist.

              A FILTER OVER WHAT MAY BE BOUGHT, never over what is watched. A
              class you switch off stays priced, valued and sellable — see
              assetModeAllows in core for why the other way round would brick a
              live account. */}
          <div className="mm-section">{t("settings.section.whatItTrades")}</div>
          <div id="trencher-setup" className="mm-hint" aria-labelledby="trencher-mode">
            <b id="trencher-mode">{t("settings.text.trencherModeFastMemecoin")}</b>
            <p>{t("settings.text.yourMerrymanTracksActive")}</p>
            <p>{t("settings.text.entriesRemain5Subject")}</p>
            <button type="button" className="mm-btn" disabled={status === "saving…"} onClick={() => {
              setAssetMode("crypto");
              setOfficialCoins(true);
              setDiscoveryEnabled(true);
              setSymbols([...new Set([...activeSymbols, ...activeTokens.map(token => token.symbol)])]);
              setTrencherFast(true);
              setDraft(previous => ({ ...previous, strategy: "trencher", tickSeconds: "15" }));
              setNumError(({ tickSeconds: _replaced, ...rest }) => rest);
              setTrencherPrepared(true);
              setSettingsVerified(false);
              setStatus(null);
              setErrors([]);
            }}>{t("settings.text.prepareTrencherMode")}</button>
            {trencherPrepared && hasUnsavedChanges && <p role="status">{trencherPresetSelected
              ? t("settings.text.trencherPresetReady")
              : t("settings.text.unsavedSettingsSave")}</p>}
            <label className="mm-field">
              <span className="mm-input"><input type="checkbox" style={{ width: "auto" }}
                checked={trencherFast ?? view.values.trencherFastEnabled ?? d.trencherFastEnabled}
                onChange={event => setTrencherFast(event.target.checked)} />{t("settings.text.useFastTrencherExits")}</span>
              <span className="mm-hint">{t("settings.hint.appliesWhenTheStrategy")}</span>
            </label>
            {/* THE FLAG THAT MADE TRENCHER LOOK BROKEN, NOW BESIDE ITS OWN EXPLANATION.

                It has had an API branch and no control, so an owner who picked
                trencher and went live got a candidate feed that returned nothing,
                forever, with nothing said. index.ts says the surprise out loud
                -- “the strategy stopped seeing anything at the exact moment it
                became able to act” -- and then left the only remedy unreachable.

                Giving it a control fixed the first half of that and left the
                second: the checkbox lived ~445 lines below this card, inside a
                COLLAPSED "Custom tokens & discovery" drawer, while the prose
                explaining Trencher sat up here. Every route into this feature —
                the release notice, the home strip, the chat — deep-links to
                #trencher-mode, which is this card, which did not contain the one
                switch that decides whether any of it spends money.

                It is still OFF by default and still bounded by the signed wall;
                this moves where it is read, not what it permits. */}
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.letTrencherTradeFor")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={trencherLiveVal}
                  onChange={(e) => setTrencherLive(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {trencherLiveVal ? t("settings.msg.trencherCanOpenReal") : t("settings.msg.paperOnly")}
                </span>
              </span>
              <span className="mm-hint">{t("settings.hint.allowsLiveTrencherTrades")}</span>
            </label>
            {activeTokens.length === 0 && (view.officialCoins?.length ?? 0) === 0 && <p>
              {t("settings.text.youDoNotNeed")}
            </p>}
            <button type="button" className="mm-btn primary" onClick={() => void save()} disabled={status === "saving…"}>{t("settings.msg.saveSettings")}</button>
            <p className="mm-hint">{t("settings.text.savesAllChangesPage")}</p>
            {status === "saving…" && <p role="status">{t("settings.msg.savingSettingsLong")}</p>}
            {settingsVerified && !hasUnsavedChanges && <p role="status">{t("settings.text.settingsSavedLead")}<Link href="/grant#resign">{t("settings.link.reviewTradingPermission")}</Link>{t("settings.text.checkTrencherAccessTail")}</p>}
            {errors.length > 0 && <div className="mm-danger" role="alert">{errors.map((error, i) => <div key={i}>{error}</div>)}</div>}
            {botClaimed && <p className="mm-danger" role="alert">{botClaimed} {t("settings.text.nothingSavedResolve")}</p>}
            <p>{t("settings.text.afterSavingReviewPre")}{t("settings.text.andSelectAutonomousTrencher")}</p>
            <p>{t("settings.text.alreadySavedRenewed")}</p>
          </div>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.assetMode")}</span>
              <span className="mm-input">
                <select
                  value={assetModeVal}
                  onChange={(e) => setAssetMode(e.target.value as "all" | "stocks" | "crypto")}
                >
                  <option value="all">{t("settings.text.allAssets")}</option>
                  <option value="stocks">{t("settings.text.stocksOnly")}</option>
                  <option value="crypto">{t("settings.text.cryptoOnly")}</option>
                </select>
              </span>
              <span className="mm-hint">
                {assetModeVal === "stocks"
                  ? t("settings.msg.onlyTokenisedEquitiesAnd")
                  : assetModeVal === "crypto"
                    ? t("settings.msg.onlyCoinsStocksIn")
                    : t("settings.msg.everythingYourBasketAnd")}
              </span>
            </label>
          </div>
          {assetModeVal !== "all" && (
            /* SAID BEFORE IT BITES. Narrowing the pool re-splits every surviving
               leg's weight, and even-keel acts on a 500bps band — so this is a
               dropdown that moves real money for some owners. */
            <p className="mm-hint" style={{ marginTop: 8 }}>
              {t("settings.text.anythingYouAlreadyHold")} <b>{t("settings.text.buyVerb")}</b>.
              {activeSymbols.length > 0 && t("settings.msg.ifItLeavesYou")}
            </p>
          )}

          {/* ── ESSENTIALS ─────────────────────────────────────────────── */}
          {/* GROUPED AND CLOSED, like the groups below it. An owner said the
              page should be "wayyyy easier"; most of this block is the AI
              provider's plumbing, and the parts most owners change — the
              strategy, the name — can be changed by saying so at the top. */}
          <details className="settings-group" id="agent-settings"><summary>{t("settings.section.agentSettings")}{t("settings.text.agentSettingsTail")}</summary>
          <div className="mm-section">{t("settings.section.agentSettings")}</div>
          <div className="mm-grid">
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
                label={t("settings.label.aiProvider")}
                action={prov.keyUrl ? { href: prov.keyUrl, label: providerNeedsKey ? t("settings.msg.getAKey") : t("settings.msg.installAction") } : undefined}
                hint={hosted ? t("settings.msg.optionalOwnProvider") : t("settings.msg.requiredForChatAnd")}
              >
                <select value={llmProviderVal} onChange={(e) => setDraft((d) => ({ ...d, ...providerChange(e.target.value) }))}>
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
                  label={t("settings.msg.providerApiKey", { provider: prov.label })}
                  action={prov.keyUrl ? { href: prov.keyUrl, label: t("settings.msg.getAKey") } : undefined}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder={secretPlaceholder(providerKeyView)}
                    value={draft[providerKeyField] ?? ""}
                    onChange={set(providerKeyField)}
                  />
                  {(providerKeyView.set || !!draft[providerKeyField]) && (
                    <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, [providerKeyField]: "" }))}>
                      {hosted ? t("settings.msg.useSharedKey") : t("settings.msg.clearKey")}
                    </button>
                  )}
                </Field>
              )}
              {/* SELF-HOSTED ONLY, and deliberately. See the providers filter above:
                  the key is the tenant's money, the URL is our egress. */}
              {hosted === false && prov.id === "custom" && (
                <Field label={t("settings.label.baseUrl")} hint={t("settings.hint.anyOpenaiCompatibleEndpoint")}>
                  <input type="text" placeholder="https://…/v1" value={v("llmBaseUrl")} onChange={set("llmBaseUrl")} />
                </Field>
              )}
              <Field
                label={t("settings.label.model")}
                hint={t("settings.hint.leaveBlankProviderDefault", { model: prov.defaultModel ? ` (${prov.defaultModel})` : "" })}
              >
                {modelsLoading ? (
                  <span className="mm-loading">{t("settings.text.listingModels")}</span>
                ) : availableModels.length > 0 ? (
                  <select
                    value={providerModelVal}
                    onChange={setProviderModel}
                  >
                    <option value="">{t("settings.msg.defaultModelOption", { model: prov.defaultModel ? ` (${prov.defaultModel})` : "" })}</option>
                    {providerModelVal && !availableModels.includes(providerModelVal) && (
                      <option value={providerModelVal}>{t("settings.msg.savedModelNotListed", { model: providerModelVal })}</option>
                    )}
                    {availableModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder={prov.defaultModel || t("settings.msg.modelId")}
                    value={providerModelVal}
                    onChange={setProviderModel}
                  />
                )}
              </Field>
  
              </>
            )}
            {hosted === false && (
              <>
            <Field
                label={t("settings.label.pimlicoApiKey")}
                action={{ href: "https://dashboard.pimlico.io", label: t("settings.msg.getAFreeKey") }}
                hint={t("settings.hint.requiredForRealTrading")}
              >
                <input
                  type="password"
                  placeholder={secretPlaceholder(view.bundlerApiKey)}
                  value={draft.bundlerApiKey ?? ""}
                  onChange={set("bundlerApiKey")}
                />
                {view.bundlerApiKey.set && (
                  <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, bundlerApiKey: "" }))}>
                    {t("settings.msg.clearShort")}
                  </button>
                )}
              </Field>
                </>
            )}
            {/* The first thing an owner should be able to change, and until now
                the only way was a Telegram command -- which is why every hosted
                agent is called Robin. */}
            <Field
              label={t("settings.label.agentName")}
              hint={t("settings.hint.upTo24Letters")}
            >
              <input
                type="text"
                maxLength={24}
                placeholder={view.values.agentName || "Robin"}
                value={draft.agentName ?? ""}
                onChange={set("agentName")}
              />
            </Field>
            <AgentImageField
              kind="avatar"
              slug={slug}
              label={t("settings.label.profilePicture")}
              hint={t("settings.hint.pngJpegOrWebp")}
            />
            <AgentImageField
              kind="banner"
              slug={slug}
              label={t("settings.label.banner")}
              hint={t("settings.hint.pngJpegOrWebp2")}
            />
            <Field
              label={t("settings.label.strategy")}
            >
              <select value={v("strategy") || d.strategy} onChange={set("strategy")}>
                {view.strategies.builtin.map((s) => (
                  <option key={s} value={s}>
                    {/* MARKED IN THE LIST ITSELF. A dropdown has nowhere to put
                        a badge, so the requirement goes in the option label —
                        the only thing somebody reads before choosing.
                        (Written without the tag name on purpose: the control
                        census in app/settings/honesty.test.ts counts the literal
                        string, and it is more useful dumb than clever.) */}
                    {s}
                    {isCircleStrategyId(s) ? t("settings.msg.holdersOnlySuffix") : ""}
                  </option>
                ))}
                {view.strategies.custom.length > 0 && <option disabled>{t("settings.text.yourStrategies")}</option>}
                {view.strategies.custom.map((s) => (
                  <option key={s} value={s}>
                    {t("settings.msg.customStrategyOption", { name: s })}
                  </option>
                ))}
              </select>
            </Field>
            {/* AND THE READER'S STANDING, at the moment of choosing.
                The create flow warns and this one never did — which is the flow
                a tester with an existing agent actually uses. Selecting a
                holder-only strategy here answered {ok:true} and left them to
                discover days later that nothing had happened. */}
            {isCircleStrategyId(v("strategy") || d.strategy || "") &&
              tier &&
              tier.why !== "sign-in" &&
              !tier.bonusStrategies && (
                <div className="create-locked" role="status">
                  <strong>{t("settings.text.thatOneWonT")}</strong>
                  {tier.why === "unreadable" ? (
                    <p>
                      {t("settings.text.weCouldnTRead")}
                    </p>
                  ) : (
                    /* THE COMBINED FIGURE, the one the worker counts — the
                       owner's wallet and this agent's account together — and
                       a dash for a count nobody read, never `?? 0`. */
                    <p>
                      {t("settings.text.holdingShortfall", { have: count(tier.tokens), need: count(tier.needTokens) })}
                    </p>
                  )}
                </div>
              )}
          </div>

          {/* Model-list status: missing_key renders as the neutral hint (nothing
              was attempted); anything else renders the single literal line the
              pin in house-key-and-basket.test.ts requires, with the composed
              sentence — never raw provider text. */}
          {modelsError === "missing_key" && (
            <p role="status" className="mm-hint">
              {t("settings.msg.enterApiKeyForModels", { provider: prov.label })}
            </p>
          )}
          {modelsError && modelsError !== "missing_key" && (
            <p role="status" className="mm-danger">
              {t("settings.msg.modelListFailed", { error: modelsError })}
            </p>
          )}
          </details>
          <details className="settings-group" id="trading-basket"><summary>{t("settings.section.tradingBasket")}{t("settings.text.tradingBasketTail")}</summary>
          <div className="mm-section">{t("settings.section.tradingBasket")}</div>
          {/* GROUPED, because one undifferentiated run of chips is what an owner
              meant by "trading basket in settings is full of all stocks". It was
              twenty-five registry symbols with his own coin unselected at the
              end, and nothing said the two kinds were different or that the last
              one was his. Two headed groups cost nothing and answer that. */}
          {(
            [
              [t("settings.msg.stocksEtfs"), view.knownSymbols],
              [t("settings.msg.coins"), activeTokens.map((t) => t.symbol)],
            ] as const
          ).map(([heading, syms]) => (
            <div key={heading}>
              <div className="mm-subtle mono" style={{ marginTop: 10 }}>
                {heading.toLowerCase()}
              </div>
              {syms.length === 0 ? (
                /* An empty group rendered as nothing is how an owner concludes
                   the feature does not exist. Say it is empty and where to
                   start. */
                <div className="mm-hint">{t("settings.hint.noneYetAddOne")}</div>
              ) : (
                <div className="mm-chips">
                  {syms.map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      className={`mm-toggle${activeSymbols.includes(sym) ? " on" : ""}`}
                      /* In the basket or not, said rather than only shaded. */
                      aria-pressed={activeSymbols.includes(sym)}
                      onClick={() => toggleSymbol(sym)}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="mm-hint">
            {activeSymbols.length === 0
              ? t("settings.msg.selectAtLeastOne")
              : t("settings.msg.tradingListPreview", { list: activeSymbols.join(" · ") })}
          </div>
          {/* Selecting a symbol the signed key can't sell used to mean buying a
              position with no exit. The buy is refused now, but say why here —
              at the moment of choosing — rather than in the event feed later. */}
          {unsellable.length > 0 && (
            <div className="mm-danger">
              {t("settings.text.updateYour")}<Link href="/grant">{t("settings.text.tradingPermissions")}</Link>{t("settings.text.toBuyOrSell")}<b>{unsellable.join(", ")}</b>.
            </div>
          )}
          </details>

          {/* ── OWNER-ADDED TOKENS (memecoins) ─────────────────────────────
              Deliberately separate from the basket: those are issuer-backed
              stocks with Chainlink feeds, these are whatever the owner pastes.
              Adding one here does NOT make it tradable — the tradable list is
              sealed into the signed key — so the /grant re-sign is spelled out
              rather than left to be discovered as a reverted trade. */}
          <details className="settings-group"><summary>{t("settings.text.customTokensDiscovery")}</summary>
          {activeTokens.length > 0 && (
            <div className="mm-rows">
              {activeTokens.map((tok) => (
                <div key={tok.address.toLowerCase()} className="mm-row mono">
                  <b>{tok.symbol}</b>
                  <span className="addr">{tok.address}</span>
                  <span className="dim">{tok.decimals}dp</span>
                  <button type="button" className="copy-btn" onClick={() => removeToken(tok.address)}>
                    {t("settings.msg.removeTokenBtn")}
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mm-grid">
            <Field label={t("settings.label.symbol")}>
              <input
                value={newToken.symbol}
                placeholder="CATE"
                onChange={(e) => setNewToken((n) => ({ ...n, symbol: e.target.value }))}
              />
            </Field>
            <Field label={t("settings.label.contractAddress")}>
              <input
                value={newToken.address}
                placeholder="0x…"
                onChange={(e) => setNewToken((n) => ({ ...n, address: e.target.value }))}
              />
            </Field>
            <Field label={t("settings.label.decimals")} hint={t("settings.hint.18ForMostTokens")}>
              <input
                value={newToken.decimals}
                inputMode="numeric"
                onChange={(e) => setNewToken((n) => ({ ...n, decimals: e.target.value }))}
              />
            </Field>
          </div>
          {/* THE SECOND GATE, MADE VISIBLE. Adding a token means "know about
              this"; trading it is a separate decision that lived only in a code
              comment and in an unselected chip at the end of twenty-five stock
              chips. Offered here, defaulted on, one click to decline. */}
          <label className="ack-row" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={tradeNewToken}
              onChange={(e) => setTradeNewToken(e.target.checked)}
            />
            <span>
              {t("settings.text.tradeThisOneToo")}
            </span>
          </label>
          <button type="button" className="copy-btn" onClick={addToken}>
            {t("settings.text.addToken")}
          </button>
          {tokenError && <div className="mm-danger">{tokenError}</div>}

          {/* The two knobs that decide whether a token gets a price at all. They
              live here, next to the tokens they govern, because the refusal
              message names them by value ("below your $25,000 floor") and an
              owner who can't find the dial can't act on that. */}
          <div className="mm-grid" style={{ marginTop: 12 }}>
            <Field
              label={t("settings.label.minimumPoolDepthUsd")}
              hint={t("settings.hint.minimumLiquidityRequiredTo")}
            >
              <input
                value={v("minPoolLiquidityUsdg")}
                inputMode="numeric"
                placeholder={String(d.minPoolLiquidityUsdg)}
                onChange={setNum("minPoolLiquidityUsdg")} aria-invalid={!!numError.minPoolLiquidityUsdg}
              />
            </Field>
            <Field
              label={t("settings.label.maxSpotVsAverage")}
              hint={t("settings.hint.maximumDifferenceBetweenThe")}
            >
              <input
                value={v("maxPriceDivergenceBps")}
                inputMode="numeric"
                placeholder={String(d.maxPriceDivergenceBps)}
                onChange={setNum("maxPriceDivergenceBps")} aria-invalid={!!numError.maxPriceDivergenceBps}
              />
            </Field>
          </div>
          {/* ALL THREE STEPS, because naming two of them is how an owner ends
              up doing everything he was told and getting nowhere. This said
              "save your tokens, then update trading permissions" and omitted
              the basket entirely — the one gate that was invisible. */}
          <div className="mm-hint">{t("settings.hint.threeThingsHaveTo")}<b>{t("settings.text.inYourTradingBasket")}</b> {t("settings.text.aboveTheCheckboxDoes")} <b>{t("settings.text.savedWord")}</b>{t("settings.text.andYourFrag")}<Link href="/grant">{t("settings.text.tradingPermission")}</Link>{" "}{t("settings.text.coversItReSign")}</div>

          {/* ── DISCOVERY ──────────────────────────────────────────────────
              Read-only and message-only. Worth surfacing next to the token
              editor because the action it prompts is "add a token here". */}
          <div className="mm-subtle mono">{t("settings.text.discoveryNewPairsAs")}</div>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.watchForNewPairs")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={discoveryEnabledVal}
                  onChange={(e) => setDiscoveryEnabled(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {discoveryEnabledVal ? t("settings.msg.tellsYouWhenLaunches") : t("settings.msg.offState")}
                </span>
              </span>
              <span className="mm-hint">{t("settings.hint.requiresABitqueryKey")}</span>
            </label>
            {/* THE ONE TOGGLE ON THIS SCREEN THAT STARTS ON.
                Everything around it opts INTO something discovered; this opts OUT
                of a list the platform curates and stands behind, which is why it
                defaults the other way. Its job here is to be findable: without a
                control, "off" is unreachable and the checkbox is the only place
                an owner learns the list exists at all. */}
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.tradeThePlatformCoin")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={officialCoinsVal}
                  onChange={(e) => setOfficialCoins(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {/* THREE STATES, NOT TWO. This read off the SETTING and said
                      "coins are in your basket" whenever it was on — which is the
                      default — while OFFICIAL_COINS[4663] is empty, so there are
                      none. official-coins.ts already names the distinction the UI
                      was collapsing: "An empty list is the honest state for a chain
                      with no verified listing, and is a different fact from
                      'official coins are turned off' — which is a setting." */}
                  {!officialCoinsVal
                    ? t("settings.text.stocksOnly")
                    : listedCoins.length > 0
                      ? t("settings.msg.officialCoinsInBasket", { count: String(listedCoins.length), list: listedCoins.join(", ") })
                      : t("settings.msg.onButNoneAre")}
                </span>
              </span>
              <span className="mm-hint">
                {listedCoins.length > 0
                  ? t("settings.msg.verifiedCoinsWePublish")
                  : t("settings.msg.whenWePublishVerified")}{" "}
                {t("settings.text.verifiedCoinsTrailing")}
              </span>
            </label>
            <Field
              label={t("settings.label.checkEveryMinutes")}
            >
              <input
                value={v("discoveryIntervalMin")}
                inputMode="numeric"
                placeholder={String(d.discoveryIntervalMin)}
                onChange={setNum("discoveryIntervalMin")} aria-invalid={!!numError.discoveryIntervalMin}
              />
            </Field>
          </div>
          <div className="mm-hint">{t("settings.hint.discoverySendsAlertsAutonomous")}<Link href="/grant">{t("settings.text.tradingPermission")}</Link>{t("settings.text.theIndividualTokenRoute")}</div>

          {/* ── SCOUT MODE ─────────────────────────────────────────────────
              The one place merrymen will knowingly hold something it cannot
              value. The copy has to be blunt about what that costs, because
              the usual safety net genuinely does not apply here. */}
          <div className="mm-subtle mono">{t("settings.text.scoutModeBuyingWhat")}</div>
          <p className="mm-hint" style={{ marginTop: 0 }}>
            {t("settings.text.buyTokensWithoutA")}
          </p>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.researchBeforeDeciding")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={deskEnabledVal}
                  onChange={(e) => setDeskEnabled(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {deskEnabledVal
                    ? t("settings.msg.theStrategistLooksThings")
                    : t("settings.msg.offOneShotFrom")}
                </span>
              </span>
              <span className="mm-hint">{t("settings.hint.llmStrategistOnlyOn")}</span>
            </label>
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.scoutMode")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={scoutEnabledVal}
                  onChange={(e) => setScoutEnabled(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {scoutEnabledVal ? t("settings.msg.mayBuyUnpriceable") : t("settings.msg.offUnpriceableTokensAre")}
                </span>
              </span>
            </label>
            <Field
              label={t("settings.label.scoutBudgetUsdg")}
              hint={t("settings.hint.maximumPurchaseCostOf")}
            >
              <input
                value={v("scoutBudgetUsdg")}
                inputMode="numeric"
                placeholder={String(d.scoutBudgetUsdg)}
                onChange={setNum("scoutBudgetUsdg")} aria-invalid={!!numError.scoutBudgetUsdg}
              />
            </Field>
            <Field
              label={t("settings.label.maxPerTokenUsdg")}
              hint={t("settings.hint.maximumTotalPurchaseCost")}
            >
              <input
                value={v("scoutPerTokenUsdg")}
                inputMode="numeric"
                placeholder={String(d.scoutPerTokenUsdg)}
                onChange={setNum("scoutPerTokenUsdg")} aria-invalid={!!numError.scoutPerTokenUsdg}
              />
            </Field>
          </div>
          <div className="mm-danger">
            <b>{t("settings.text.theDrawdownBreakerCannot")}</b> {t("settings.text.thesePositionsStayValued")}{" "}
            <b>{t("settings.text.theBudgetIsThe")}</b>{t("settings.text.notTheBreakerTail")}
            {scoutEnabledVal && Number(v("scoutBudgetUsdg") || d.scoutBudgetUsdg) === 0 && (
              <>
                <br />
                <br />
                {t("settings.text.scoutModeIsOn")} <b>0</b>{t("settings.text.soNothingWillBe")}
              </>
            )}
          </div>

          {/* ── THE CLASS ROUTE ────────────────────────────────────────────
              Four settings that had a type, a PUT-allowlist entry and a worker
              read, and NO control — so the only way to configure the route was
              to call the API by hand, and `classSnipeEnabled` could not be
              turned on at all. The factory field alone sat in Connections,
              which made the page look like the feature was reachable when
              nothing downstream of it could be set.

              Deliberately BELOW the scout block and after its warning: a class
              buy is gated by the scout budget, so an owner who has not read
              that paragraph is not ready to read this one.

              CALLED WHAT THE CHAT CALLS IT. The agent says "launchpad buying"
              (chat-tools.ts settings, setting-spec.ts DASHBOARD_ONLY) and the
              iOS app says it too; this block said only "class route", so an
              owner sent here looking for launchpad buying found nothing by
              that name. #launchpad-buying is where the chat's button lands,
              and the effect above opens this group for it. */}
          <div className="mm-subtle mono" id="launchpad-buying">{t("settings.text.launchpadBuyingPre")} · {t("settings.text.classRouteBuyingA")}</div>
          <p className="mm-hint" style={{ marginTop: 0 }}>
            {t("settings.text.buyATokenStraight")}
          </p>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.classRoute")}</span>
              <span className="mm-input">
                <input
                  type="checkbox"
                  checked={classSnipeVal}
                  onChange={(e) => setClassSnipe(e.target.checked)}
                  style={{ width: "auto" }}
                />
                <span className="mm-unit">
                  {classSnipeVal ? t("settings.msg.mayBuyNewCoins") : t("settings.msg.offNoCoinIs")}
                </span>
              </span>
              <span className="mm-hint">{t("settings.hint.separateFromSealingA")}</span>
            </label>
            <Field
              label={t("settings.label.perEntryUsdg")}
              hint={t("settings.hint.spentOnASingle")}
            >
              <input
                value={v("classPerEntryUsdg")}
                inputMode="numeric"
                placeholder={String(d.classPerEntryUsdg)}
                onChange={setNum("classPerEntryUsdg")} aria-invalid={!!numError.classPerEntryUsdg}
              />
            </Field>
            <Field
              label={t("settings.label.maxOpenPositions")}
              hint={t("settings.hint.howManyClassPositions")}
            >
              <input
                value={v("classMaxPositions")}
                inputMode="numeric"
                placeholder={String(d.classMaxPositions)}
                onChange={setNum("classMaxPositions")} aria-invalid={!!numError.classMaxPositions}
              />
            </Field>
            <Field label={t("settings.label.maximumHoldingTimeSeconds")} hint={t("settings.hint.forBondingCurvePositions")}>
              <input type="text" inputMode="numeric" value={v("classMaxHoldSec")} placeholder={String(d.classMaxHoldSec)} onChange={setNum("classMaxHoldSec")} aria-invalid={!!numError.classMaxHoldSec} />
            </Field>
            <Field
              label={t("settings.label.minimumCurveDepthUsdg")}
              hint={t("settings.hint.realMoneyRaisedInto")}
            >
              <input
                value={v("classMinDepthUsdg")}
                inputMode="numeric"
                placeholder={String(d.classMinDepthUsdg)}
                onChange={setNum("classMinDepthUsdg")} aria-invalid={!!numError.classMinDepthUsdg}
              />
            </Field>
          </div>
          {classSnipeVal && Number(v("classPerEntryUsdg") || d.classPerEntryUsdg) === 0 && (
            <div className="mm-danger">
              {t("settings.text.theClassRouteIs")} <b>0</b>{t("settings.text.soNothingWillBe2")}
            </div>
          )}

          </details>
          <details className="settings-group" id="telegram"><summary>{t("settings.text.telegram")}</summary>
          {/* THE CODE, BESIDE THE INSTRUCTION THAT NEEDS IT.

              These were in two different collapsed drawers: this sentence
              here, and the actual link code far below inside "Advanced
              settings". Two beta testers stopped exactly there — "I'm stuck
              at this point, no code from /link" — and the incident is written
              up at length in the API route. The placeholder made it worse by
              rendering "……" as though a code existed and was merely hidden.

              A missing code is a WAIT, not an absence: the agent mints one on
              its next pass after a token is saved, so the copy says that
              rather than claiming there is no code. */}
          <p className="mm-hint" style={{ marginTop: 0 }}>
            {t("settings.text.createABotWith")}
          </p>
          <TelegramListeningNote row={telegramRow(tg)} />
          {tg?.linkCode ? (
            <p className="mm-hint">{t("settings.hint.thenSend")}<code>/link {tg.linkCode}</code>{t("settings.hint.linkCodeToBot")}{" "}
              {tg.botUsername ? (
                <a href={`https://t.me/${tg.botUsername}?start=${tg.linkCode}`} target="_blank" rel="noreferrer">{t("settings.text.openTelegram")}</a>
              ) : null}
              <br />
              {t("strip.tg.codeWarning")}
            </p>
          ) : (
            <p className="mm-hint">
              {/* NO CODE BECAUSE ANOTHER AGENT HAS THIS BOT, which this one
                  will never pick up; or because the agent has not picked
                  it up YET: the code on file was minted for the bot saved
                  before, and would not link this one
                  (lib/telegram-listening.ts). Neither is "check back". */}
              {tg?.botElsewhere
                ? t("settings.tg.elsewhere")
                : tg?.linkPending && tg.enabled
                ? t("settings.tg.pickingUp")
                : view.telegramBotToken.set
                  ? t("settings.msg.noLinkCodeYet")
                  : t("settings.msg.yourLinkCodeAppears")}
            </p>
          )}
          <div className="mm-grid">
            <Field
              label={t("settings.label.botToken")}
              hint={t("settings.hint.getYourBotToken")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.telegramBotToken)}
                value={draft.telegramBotToken ?? ""}
                onChange={set("telegramBotToken")}
              />
              {view.telegramBotToken.set && (
                <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, telegramBotToken: "" }))}>
                  {t("settings.msg.clearShort")}
                </button>
              )}
            </Field>
            <Field label={t("settings.label.connection")}>
              <button type="button" className="mm-tag" style={{ cursor: "pointer" }} onClick={() => void testTelegram()}>
                {t("settings.text.testConnection")}
              </button>
              {/* AN UNREAD BRIDGE IS NOT A MISSING TOKEN.

                  `loadTelegram` only calls `setTg` on a truthy response, so a
                  failed or non-ok /api/telegram leaves `tg` null — and the
                  ternary that used to be here fell through to the literal
                  "no token", telling an owner whose network hiccupped that
                  they had never saved the token they were looking at. The
                  reading now lives in agent-status.ts, where a test executes
                  it and the home strip shares the same words. */}
              <span className="mm-unit">{tgTest ?? telegramLabel(telegramRow(tg))}</span>
            </Field>
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.enableTelegram")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgEnabledVal} onChange={(e) => setTgEnabled(e.target.checked)} style={{ width: "auto" }} />
                {/* WHAT THE SWITCH SAYS, NOT WHAT WAS HEARD. "the bot is
                    listening" was printed here for a bot nothing had polled in
                    days; whether it is heard is the connection field above. */}
                <span className="mm-unit">{tgEnabledVal ? t("settings.msg.onState") : t("settings.msg.offState")}</span>
              </span>
            </label>
          </div>

          {/* TELEGRAM GROUPS (docs/tg-groups.md). Never the web room's name —
              that belongs to the public room — and dashboard-only: the chat
              answers "groups off" with a button to here, because a group is a
              chat anyone in it can type into. Saved by "Save changes" like the
              toggles above, and reset after it. */}
          <div className="mm-section" id="telegram-groups">{t("settings.section.telegramGroups")}</div>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.hangOutInTelegramGroups")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgGroupsVal} onChange={(e) => setTgGroups(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{tgGroupsVal ? t("settings.msg.answersWhenCalled") : t("settings.msg.silentInGroups")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.hangOutInTelegramGroups")}</span>
            </label>
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.lookAtCoinsPeoplePost")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgGroupCoinsVal} onChange={(e) => setTgGroupCoins(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{tgGroupCoinsVal ? t("settings.msg.looksThenBrain") : t("settings.msg.leavesCoinsAlone")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.lookAtCoinsPeoplePost")}</span>
            </label>
            <Field label={t("settings.label.howChattyInGroups")} hint={t("settings.hint.howChattyInGroups")}>
              <select value={tgChattinessVal} onChange={(e) => setTgChattiness(e.target.value as TelegramGroupsChattiness)}>
                {TELEGRAM_GROUPS_CHATTINESS.map((level) => (
                  <option key={level} value={level}>{t(CHATTINESS_LABEL[level])}</option>
                ))}
              </select>
            </Field>
          </div>
          {/* WHAT IT CAN HEAR, from the getMe /api/telegram already makes.

              Three states, not two. `false` is BotFather's privacy mode ON —
              the default — and then a group bot hears only commands and
              replies to itself, so it cannot join in, remember the chat or
              see a posted coin. `true` is off. Anything else (no token, getMe
              failed, an older server) is UNKNOWN, and gets the steps with no
              verdict: telling an owner privacy is on when nobody knows sends
              them to BotFather for nothing. The flag reports the BotFather
              setting only — a bot added before it changed still has to be
              removed and added back — so even "off" says so. */}
          <p className="mm-hint" id="telegram-privacy-mode">
            {tg?.canReadAllGroupMessages === true ? (
              t("settings.text.privacyModeOff")
            ) : (
              <>
                {tg?.canReadAllGroupMessages === false ? t("settings.text.privacyModeOn") : t("settings.text.privacyModeUnknown")}{" "}
                {t("settings.text.privacyModeSteps")}
              </>
            )}
            {tg?.canJoinGroups === false && <><br />{t("settings.text.joinGroupsOff")}</>}
          </p>

          </details>
          {/* POSTING ON X — hosted only, and only on a RESOLVED `hosted`, so a
              self-hosted page never flashes a section it cannot use. The whole
              section is its own component (terminal/XPosting.tsx): it reads
              and writes /api/x/*, never this form's `draft`, and nothing here
              is saved by "Save changes". The owner it sends is the one this
              form was read for (SettingsView.owner). */}
          {hosted === true && (
            <details className="settings-group" id="x-posting"><summary>{t("settings.text.postingOnX")}</summary>
              <XPosting owner={view.owner} hosted={hosted} />
            </details>
          )}

          {/* ── ADVANCED (collapsed by default) ────────────────────────── */}
          <details className="mm-advanced">
            <summary>{t("settings.text.advancedSettings")}</summary>

            <div className="mm-section">{t("settings.section.telegramControls")}</div>
            <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.allowControlCommands")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgControlVal} onChange={(e) => setTgControl(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{tgControlVal ? t("settings.msg.controlCommandList") : t("settings.msg.readChatOnly")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.offTheBotCan")}</span>
            </label>
            <Field label={t("settings.label.chatTradeCeiling")} hint={t("settings.hint.maxUsdgPerChat")}>
              <input
                type="text" inputMode="decimal"
                placeholder={String(d.telegramMaxActionUsdg)}
                value={v("telegramMaxActionUsdg")}
                onChange={setNum("telegramMaxActionUsdg")} aria-invalid={!!numError.telegramMaxActionUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.allowTransfers")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgTransferVal} onChange={(e) => setTgTransfer(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{tgTransferVal ? t("settings.msg.transferWithConfirm") : t("settings.msg.offState")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.requiresExistingTransferPermission")}</span>
            </label>
            <Field label={t("settings.label.dailyTransferBudget")} hint={t("settings.hint.maxUsdgChatTransfers")}>
              <input
                type="text" inputMode="decimal"
                placeholder={String(d.telegramTransferDailyUsdg)}
                value={v("telegramTransferDailyUsdg")}
                onChange={setNum("telegramTransferDailyUsdg")} aria-invalid={!!numError.telegramTransferDailyUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.proactivePings")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={tgNotifyVal} onChange={(e) => setTgNotify(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{tgNotifyVal ? t("settings.msg.tradePingsWarnings") : t("settings.msg.quietWord")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.theBotMessagesYou")}</span>
            </label>
            {tgNotifyVal && (
              <Field
                label={t("settings.label.tradePingsHowOften")}
                hint={t("settings.hint.batchTheRoutineTrade")}
              >
                <select value={v("telegramNotifyEveryMin") || "0"} onChange={set("telegramNotifyEveryMin")}>
                  <option value="0">{t("settings.text.everyTrade")}</option>
                  <option value="5">{t("settings.text.aSummaryEvery5")}</option>
                  <option value="15">{t("settings.text.aSummaryEvery15")}</option>
                  <option value="30">{t("settings.text.aSummaryEvery30")}</option>
                  <option value="60">{t("settings.text.aSummaryEveryHour")}</option>
                </select>
              </Field>
            )}
            <Field label={t("settings.label.dailyReportHour")} hint={t("settings.hint.localHour023")}>
              <input
                type="text" inputMode="numeric"
                placeholder={String(d.telegramDigestHour)}
                value={v("telegramDigestHour")}
                onChange={setNum("telegramDigestHour")} aria-invalid={!!numError.telegramDigestHour} />
              <span className="mm-unit">{t("settings.unit.h")}</span>
            </Field>
          </div>
          <div className="mm-hint" style={{ marginTop: 4 }}>
            {tg?.linkCode ? (
              <>
                {t("settings.text.linkCode")} <b className="mono">{tg.linkCode}</b> {t("settings.text.send")} <code>/link {tg.linkCode}</code> {t("settings.text.fromTelegram")}
              </>
            ) : tg?.botElsewhere ? (
              t("settings.tg.elsewhereShort")
            ) : tg?.linkPending && tg.enabled ? (
              t("settings.tg.pickingUp")
            ) : (
              t("settings.msg.saveATokenTo")
            )}
          </div>
          {/* The same warning where the code is repeated: this one is read on
              its own, far from the first. */}
          <TelegramListeningNote row={telegramRow(tg)} />
          <div className="mm-chips" style={{ marginTop: 6 }}>
            {allowlistVal.length === 0 && <span className="dim mono">{t("settings.text.noLinkedChatsYet")}</span>}
            {allowlistVal.map((id) => (
              <span key={id} className="mm-toggle on">
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
              placeholder={t("settings.msg.addChatId")}
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
          <div className="mm-section">{t("settings.section.computerAccess")}</div>
          <div className="mm-danger" style={{ marginBottom: 12 }}>
            <b>{t("settings.text.thisLetsTelegramTouch")}</b> {t("settings.text.withItOnAn")} <b>{t("settings.text.offByDefault")}</b>{t("settings.text.enabledOneCapabilityAt")} <code>{t("settings.text.confirm")}</code> {t("settings.text.firstOnlyTurnOn")}
          </div>
          <label className="mm-field">
            <span className="mm-label">{t("settings.label.enableRemoteControl")}</span>
            <span className="mm-input">
              <input type="checkbox" checked={pcEnabledVal} onChange={(e) => setPcEnabled(e.target.checked)} style={{ width: "auto" }} />
              <span className="mm-unit">{pcEnabledVal ? t("settings.msg.onCapabilitiesApply") : t("settings.msg.offNoPcCommand")}</span>
            </span>
            <span className="mm-hint">{t("settings.hint.theMasterSwitchOff")}</span>
          </label>

          <div className="mm-field">
            <span className="mm-label">{t("settings.label.capabilities")}</span>
            <div className="caps" style={{ marginTop: 4 }}>
              {PC_CAPS.map((c) => (
                /*
                 * A BUTTON, AND IT SAYS WHETHER IT IS ON.
                 *
                 * This was a <span> with an onClick: not reachable by keyboard,
                 * not announced as a control, and carrying no pressed state — so
                 * whether SHELL AND KEYBOARD ACCESS TO THE OWNER'S MACHINE were
                 * armed was communicated by colour and opacity alone. Nothing in
                 * this file used aria-pressed or aria-checked anywhere.
                 *
                 * It keeps its classes, so it looks exactly as it did; the
                 * neighbouring basket chips are already buttons with the same
                 * ones.
                 */
                <button
                  key={c.id}
                  type="button"
                  className={`mm-toggle ${capsVal.includes(c.id) ? "on" : ""}`}
                  aria-pressed={capsVal.includes(c.id)}
                  onClick={() => toggleCap(c.id)}
                  style={{ cursor: "pointer", opacity: pcEnabledVal ? 1 : 0.5 }}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <span className="mm-hint">{t("settings.hint.clickToToggleOnly")}</span>
          </div>

          {pcEnabledVal && (capsVal.includes("shell") || capsVal.includes("keyboard")) && (
            <div className="mm-danger">
              ⚠️ <b>{t("settings.text.thisIsRemoteControl")}</b> <b>{t("settings.text.keyboard")}</b> {t("settings.text.typesKeystrokesIntoWhatever")} <b>{t("settings.text.shellWord")}</b> {t("settings.text.runsYourAllowlistedCommands")} <b>{t("settings.text.interpreterWord")}</b> {t("settings.text.pythonNodeBashPowershell")} <b>{t("settings.text.everythingThatProgramCan")}</b>{t("settings.text.notJustOneCommand")} <code>{t("settings.text.confirm")}</code> {t("settings.text.first")}
            </div>
          )}

          {/* ── agent mode · /agent <task> ─────────────────────────────── */}
          <label className="mm-field">
            <span className="mm-label">{t("settings.label.agentModeAgent")}</span>
            <span className="mm-input">
              <input
                type="checkbox"
                checked={agentEnabledVal}
                onChange={(e) => setAgentEnabled(e.target.checked)}
                style={{ width: "auto" }}
                disabled={!pcEnabledVal}
              />
              <span className="mm-unit">
                {!pcEnabledVal ? t("settings.msg.needsRemoteControlOn") : agentEnabledVal ? t("settings.msg.onAgentMultistep") : t("settings.msg.offState")}
              </span>
            </span>
            <span className="mm-hint">{t("settings.hint.sendATaskWith")}<code>{t("settings.text.agent")}</code>{t("settings.text.itUsesYourEnabled")} <b>{t("settings.text.stopWord")}</b> {t("settings.text.toHaltIt")}
            </span>
          </label>
          {agentEnabledVal && pcEnabledVal && (
            <>
              <label className="mm-field">
                <span className="mm-label">{t("settings.label.freeFormShellFor")}</span>
                <span className="mm-input">
                  <input
                    type="checkbox"
                    checked={agentAutoShellVal}
                    onChange={(e) => setAgentAutoShell(e.target.checked)}
                    style={{ width: "auto" }}
                  />
                  <span className="mm-unit">{agentAutoShellVal ? t("settings.msg.onBeyondAllowlist") : t("settings.msg.offAllowlistOnly")}</span>
                </span>
                <span className="mm-hint">{t("settings.hint.offAgentMayOnly")}</span>
              </label>
              {agentAutoShellVal && (
                <div className="mm-danger">
                  <b>{t("settings.text.freeFormShellIs")}</b> {t("settings.text.yourAgentCanControl")} <b>{t("settings.text.seatbeltNotACage")}</b>{t("settings.text.theyNarrowTheDamage")} <code>{t("settings.text.agentStop")}</code> {t("settings.text.toHaltIt")}
                </div>
              )}
              <div className="mm-grid">
                <Field label={t("settings.label.stepBudget")} hint={t("settings.hint.maximumStepsPerTask")}>
                  <input type="text" inputMode="numeric" placeholder={String(d.telegramAgentMaxSteps)} value={v("telegramAgentMaxSteps")} onChange={setNum("telegramAgentMaxSteps")} aria-invalid={!!numError.telegramAgentMaxSteps} />
                  <span className="mm-unit">{t("settings.unit.steps")}</span>
                </Field>
              </div>
            </>
          )}

          <div className="mm-grid">
            <Field
              label={t("settings.label.filesRoot")}
              hint={t("settings.hint.folderAvailableToLs")}
            >
              <input type="text" placeholder={t("settings.msg.cUsersYouDocuments")} value={v("telegramFilesRoot")} onChange={set("telegramFilesRoot")} />
            </Field>
            <Field
              label={t("settings.label.transcriptionKeyVoice")}
              hint={t("settings.hint.transcriptionApiKeyFor")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.telegramTranscribeKey)}
                value={draft.telegramTranscribeKey ?? ""}
                onChange={set("telegramTranscribeKey")}
              />
            </Field>
          </div>

          <div className="mm-field">
            <span className="mm-label">{t("settings.label.shellAllowlist")}</span>
            <div className="mm-chips">
              {shellListVal.map((cmd) => (
                <span key={cmd} className="mm-toggle on">
                  <code>{cmd}</code>
                  <button type="button" onClick={() => setShellList(shellListVal.filter((x) => x !== cmd))} className="mm-chip-x">✕</button>
                </span>
              ))}
              <input
                type="text"
                placeholder={t("settings.msg.exactCommandEG")}
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
            <span className="mm-hint">{t("settings.hint.onlyTheseExactCommands")}</span>
          </div>

          <div className="mm-field">
            <span className="mm-label">{t("settings.label.appAllowlist")}</span>
            <div className="mm-chips">
              {appListVal.map((app) => (
                <span key={app} className="mm-toggle on">
                  {app}
                  <button type="button" onClick={() => setAppList(appListVal.filter((x) => x !== app))} className="mm-chip-x">✕</button>
                </span>
              ))}
              <input
                type="text"
                placeholder={t("settings.msg.appNameEG")}
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
            <span className="mm-hint">{t("settings.hint.namesOpenMayLaunch")}</span>
          </div>

          <div className="mm-section">{t("settings.section.merryCircle")}</div>
          {/* The tier reads a $MERRYMEN balance. By default that is the wallet you
              sign in with, which is the only address the server can verify without
              being told. Holding the token elsewhere is a real case and needs a
              proof, not a text box — see /api/holder. */}
          <HolderLink />
          {/* WHAT THE TOKEN IS FOR, said where it is linked. Text only — this
              section's controls are HolderLink's, and the census in
              app/settings/honesty.test.ts counts every one. ONLY WHILE THE
              DEPLOYMENT GATES ENERGY (tier.energyGate, as CreateAgent asks):
              the gate is off until an operator turns it on, and a throttle
              described while nothing is limited is a false reason to buy. */}
          {tier?.energyGate && (
            <p className="mm-hint">
              {t("settings.text.energyGateExplain", { tokens: count(ENERGY.fullTokens) })}
            </p>
          )}
          <div className="mm-section">{t("settings.section.connections")}</div>
          <div className="mm-grid">
            <Field
              label={t("settings.label.mainnetRpcOverride")}
              hint={t("settings.hint.optionalCustomConnectionTo")}
            >
              <input type="url" placeholder={urlPlaceholder("rpcMainnet", t("settings.msg.defaultRpcMainnetChain"))} value={draft.rpcMainnet ?? ""} onChange={set("rpcMainnet")} />
            </Field>
            <Field label={t("settings.label.testnetRpcOverride")} hint={t("settings.hint.optional")}>
              <input type="url" placeholder={urlPlaceholder("rpcTestnet", t("settings.msg.defaultRpcTestnetChain"))} value={draft.rpcTestnet ?? ""} onChange={set("rpcTestnet")} />
            </Field>
            <Field
              label={t("settings.label.bundlerUrlOverride")}
              hint={t("settings.hint.overridesThePimlicoConnection")}
            >
              <input type="url" placeholder={urlPlaceholder("bundlerUrl", "https://…/rpc?apikey=…")} value={draft.bundlerUrl ?? ""} onChange={set("bundlerUrl")} />
            </Field>
            <Field
              label={t("settings.label.breakerContract")}
              hint={t("settings.hint.breakerregistryContractOnYour")}
            >
              <input type="text" placeholder="0x…" value={v("breakerAddress")} onChange={set("breakerAddress")} />
            </Field>
            <Field
              label={t("settings.label.v4AdapterContract")}
              hint={t("settings.hint.v4selfswapContractOnYour")}
            >
              <input type="text" placeholder="0x…" value={v("v4AdapterAddress")} onChange={set("v4AdapterAddress")} />
            </Field>
            <Field
              label={t("settings.label.ponsCurveAdapterContract")}
              hint={t("settings.hint.ponsselftradeContractOnYour")}
            >
              <input type="text" placeholder="0x…" value={v("ponsAdapterAddress")} onChange={set("ponsAdapterAddress")} />
            </Field>
            <Field
              label={t("settings.label.classVaultFactoryContract")}
              hint={t("settings.hint.ponsclassvaultfactoryOnYourWallet")}
            >
              <input
                type="text"
                placeholder="0x…"
                value={v("ponsClassVaultFactory")}
                onChange={set("ponsClassVaultFactory")}
              />
            </Field>
            <Field
              label={t("settings.label.rialtoIntegratorKey")}
              hint={t("settings.hint.requiredToTradeThrough")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.rialtoApiKey)}
                value={draft.rialtoApiKey ?? ""}
                onChange={set("rialtoApiKey")}
              />
              {view.rialtoApiKey.set && (
                <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, rialtoApiKey: "" }))}>
                  {t("settings.msg.clearShort")}
                </button>
              )}
            </Field>
            <Field label={t("settings.label.rialtoKeyHeader")} hint={t("settings.hint.rialtoHeaderName", { header: d.rialtoApiKeyHeader })}>
              <input type="text" placeholder={d.rialtoApiKeyHeader} value={v("rialtoApiKeyHeader")} onChange={set("rialtoApiKeyHeader")} />
            </Field>
          </div>

          <div className="mm-section">{t("settings.section.virtuals")}</div>
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-label">{t("settings.label.streamToVirtuals")}</span>
              <span className="mm-input">
                <input type="checkbox" checked={virtualsEnabledVal} onChange={(e) => setVirtualsEnabled(e.target.checked)} style={{ width: "auto" }} />
                <span className="mm-unit">{virtualsEnabledVal ? t("settings.msg.liveActivityPage") : t("settings.msg.offState")}</span>
              </span>
              <span className="mm-hint">{t("settings.hint.publishesLandedTradesAnd")}<b>{t("settings.text.outboundPublic")}</b> {t("settings.text.offByDefaultNothing")}
              </span>
            </label>
            <Field
              label={t("settings.label.virtualsApiKey")}
              hint={t("settings.hint.getThisFromYour")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.virtualsApiKey)}
                value={draft.virtualsApiKey ?? ""}
                onChange={set("virtualsApiKey")}
              />
              {view.virtualsApiKey.set && (
                <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, virtualsApiKey: "" }))}>
                  {t("settings.msg.clearShort")}
                </button>
              )}
            </Field>
            <Field
              label={t("settings.label.bitqueryApiKey")}
              action={{ href: "https://account.bitquery.io/", label: t("settings.msg.getAKey") }}
              hint={t("settings.hint.requiredForTokenDiscovery")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.bitqueryApiKey)}
                value={draft.bitqueryApiKey ?? ""}
                onChange={set("bitqueryApiKey")}
              />
              {view.bitqueryApiKey.set && (
                <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, bitqueryApiKey: "" }))}>
                  {t("settings.msg.clearShort")}
                </button>
              )}
            </Field>
            <Field
              label={t("settings.label.merryCircleToken")}
              action={{ href: `${MERRYMEN_GATEWAY_ORIGIN}/claim`, label: t("settings.msg.claimOne") }}
              hint={t("settings.hint.claimWithYourMerrymen")}
            >
              <input
                type="password"
                placeholder={secretPlaceholder(view.merrymenToken)}
                value={draft.merrymenToken ?? ""}
                onChange={set("merrymenToken")}
              />
              {view.merrymenToken.set && (
                <button type="button" className="mm-btn danger sm" onClick={() => setDraft((x) => ({ ...x, merrymenToken: "" }))}>
                  {t("settings.msg.clearShort")}
                </button>
              )}
            </Field>
          </div>

          <div className="mm-section">{t("settings.section.tradingPreferences")}</div>
          <div className="mm-grid">
            <Field label={t("settings.label.swapVenue")} hint={t("settings.hint.rialtoRequiresAnIntegrator")}>
              <select value={v("swapVenue") || d.swapVenue} onChange={set("swapVenue")}>
                <option value="uniswap">uniswap</option>
                <option value="rialto">rialto</option>
              </select>
            </Field>
            <Field label={t("settings.label.maxSlippage")} hint={t("settings.hint.vsThePreTrade")}>
              <input type="text" inputMode="numeric" placeholder={String(d.slippageBps)} value={v("slippageBps")} onChange={setNum("slippageBps")} aria-invalid={!!numError.slippageBps} />
              <span className="mm-unit">{t("settings.unit.bps")}</span>
            </Field>
            <Field label={t("settings.label.performanceFee")} hint={t("settings.hint.calculatedOnNewPeak")}>
              <input type="text" inputMode="numeric" placeholder={String(d.perfFeeBps)} value={v("perfFeeBps")} onChange={setNum("perfFeeBps")} aria-invalid={!!numError.perfFeeBps} />
              <span className="mm-unit">{t("settings.unit.bps")}</span>
            </Field>
            <Field label={t("settings.label.marketCheckInterval")} hint={t("settings.hint.anActiveBookIs")}>
              <input type="text" inputMode="numeric" placeholder={String(d.tickSeconds)} value={v("tickSeconds")} onChange={setNum("tickSeconds")} aria-invalid={!!numError.tickSeconds} />
              <span className="mm-unit">{t("settings.unit.sec")}</span>
            </Field>
            <Field label={t("settings.label.buyAmountPerCheck")} hint={t("settings.hint.amountSpreadAcrossThe")}>
              <input type="text" inputMode="decimal" placeholder={String(d.buyPerTickUsdg)} value={v("buyPerTickUsdg")} onChange={setNum("buyPerTickUsdg")} aria-invalid={!!numError.buyPerTickUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
            <Field
              label={t("settings.label.takeProfit")}
              hint={t("settings.hint.steadyBasketSellA")}
            >
              <input type="text" inputMode="numeric" placeholder={String(d.takeProfitBps)} value={v("takeProfitBps")} onChange={setNum("takeProfitBps")} aria-invalid={!!numError.takeProfitBps} />
              <span className="mm-unit">{t("settings.unit.bps")}</span>
            </Field>
            <Field label={t("settings.label.idleCashFloor")} hint={t("settings.hint.steadyBasketCashKept")}>
              <input type="text" inputMode="decimal" placeholder={String(d.idleFloorUsdg)} value={v("idleFloorUsdg")} onChange={setNum("idleFloorUsdg")} aria-invalid={!!numError.idleFloorUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
            <Field label={t("settings.label.gapBudget")} hint={t("settings.hint.weekendGapTotalUsdg")}>
              <input type="text" inputMode="decimal" placeholder={String(d.gapEnterBudgetUsdg)} value={v("gapEnterBudgetUsdg")} onChange={setNum("gapEnterBudgetUsdg")} aria-invalid={!!numError.gapEnterBudgetUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
            <Field label={t("settings.label.claudeVisionModel")} hint={t("settings.hint.modelForAnthropicAnd")}>
              <input type="text" placeholder={d.llmModel} value={llmProviderVal === "anthropic" ? providerModelVal : v("llmModel")} onChange={llmProviderVal === "anthropic" ? setProviderModel : set("llmModel")} />
            </Field>
            <Field label={t("settings.label.strategistDecisionInterval")}>
              <input type="text" inputMode="numeric" placeholder={String(d.llmIntervalMin)} value={v("llmIntervalMin")} onChange={setNum("llmIntervalMin")} aria-invalid={!!numError.llmIntervalMin} />
              <span className="mm-unit">{t("settings.unit.min")}</span>
            </Field>
            <Field label={t("settings.label.llmMaxPerAction")} hint={t("settings.hint.hardStrategistCeilingPer")}>
              <input type="text" inputMode="decimal" placeholder={String(d.llmMaxActionUsdg)} value={v("llmMaxActionUsdg")} onChange={setNum("llmMaxActionUsdg")} aria-invalid={!!numError.llmMaxActionUsdg} />
              <span className="mm-unit">{t("settings.unit.usdg")}</span>
            </Field>
          </div>

          </details>

          <button className="mm-btn primary" onClick={() => void save()} disabled={status === "saving…"}>
            {hasUnsavedChanges && status === "Changes saved" ? t("settings.msg.saveChanges") : status === "saving…" ? t("settings.msg.savingState") : status === "Changes saved" ? t("settings.msg.changesSaved") : status ?? t("settings.msg.saveChanges")}
          </button>
          {botClaimed && (
            <div className="mm-note" role="alert">
              <p style={{ marginTop: 0 }}>{botClaimed}</p>
              <p className="mm-hint">{t("settings.text.nothingSavedYet")}</p>
              <button className="mm-btn danger sm" onClick={() => void save({ moveBot: true })} disabled={status === "saving…"}>
                {t("settings.msg.moveItHere")}
              </button>{" "}
              {/* KEEPING IT THERE TAKES THE TOKEN OUT OF THE FORM. Left in the
                  draft, it rode along with every later save, each one was
                  refused the same way, and whatever else the owner changed
                  was never saved. The rest of the draft stays for the next Save. */}
              <button
                className="mm-btn sm"
                onClick={() => {
                  setDraft(({ telegramBotToken: _kept, ...rest }) => rest);
                  setBotClaimed(null);
                }}
              >
                {t("settings.msg.keepItThere")}
              </button>
            </div>
          )}
          {botMoved && (
            <p className="mm-note" role="status">
              {t("settings.text.botMovedNote")}
            </p>
          )}
          {errors.length > 0 && (
            <div className="mm-danger mono">
              {errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

      </fieldset>
    </AppShell>
  );
}
