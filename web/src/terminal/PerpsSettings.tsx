"use client";

/**
 * SETTINGS → PERPETUALS — the section where an owner lets their Merryman trade
 * perpetual futures on Lighter, first on paper and then, separately, with real
 * money (docs/perps.md rule 1: "off until the owner turns it on, twice, from
 * the dashboard"). Dashboard-only: the chat, Telegram, MCP and partners cannot
 * set any of it (DASHBOARD_ONLY.perps), so this is the one place it is set.
 *
 * ── THE TWO SWITCHES ARE THEIR OWN SAVES ─────────────────────────────────
 *
 * Each switch writes the moment it is pressed, and shows ONLY what the server
 * confirmed — it moves when the re-read settings say it moved (the XPosting
 * precedent), because a switch that reads "on" for a write that failed is an
 * owner who believes their agent is, or has stopped, trading leverage.
 *
 * OFF IS ONE CLICK AND ALWAYS LANDS. Neither off rides the page's "Save
 * changes", where an unrelated bad field would refuse the whole save; the PUT
 * writes an off even beside a refusal (route.ts `offs`), and says so. Off only
 * stops opens — venue state, not these switches, keeps exits running (rule 8a).
 *
 * REAL MONEY IS A CONSENT, NOT A CHECKBOX. Pressing the real-money switch on
 * sends NOTHING: it opens the consent — rule 4's worst case in plain words,
 * what the signed wall bounds and what it does not, liquidation, funding, that
 * Lighter publishes positions, the venue and its terms, the excluded regions —
 * and only the consent's own button writes, and only once the regional
 * attestation is ticked. What it sends is the whole record: the switch, core's
 * PERPS_LIVE_CONSENT_VERSION (the text on screen is that version's) and the
 * attestation. The route stamps the time from its own clock. It also refuses
 * to open until practice perpetuals are SAVED on, so the second act can never
 * be the first.
 *
 * ── THE FIELDS SAVE WITH THEIR OWN BUTTON ────────────────────────────────
 *
 * Driver, markets and the ten numbers are a draft with "Save perpetuals
 * settings" beneath them, sending only what was touched — never a switch or a
 * consent key, so saving a stop distance can never re-consent anyone. Bounds
 * and grids are core's PERPS_NUM_BOUNDS, the table the PUT and the worker
 * read; a refusal is shown beside its field before anything is sent.
 *
 * ── UNKNOWN IS NEVER ZERO ────────────────────────────────────────────────
 *
 * The status line is `agents.perps`, the worker's report, read through GET
 * /api/grants and core's whitelist parser. A failed read, a missing report and
 * an unreadable Lighter account each say so; none of them renders as "no
 * positions". Market reachability is the same: the report does not carry each
 * market's live minimum order, so the screen says it is "checked when the
 * agent next reads the venue" rather than quoting a number from the day this
 * was written. Paper is always called paper.
 */
import Link from "next/link";
import { PerpsResume } from "./PerpsResume";
import { useEffect, useRef, useState } from "react";
import {
  PERPS_DRIVERS,
  PERPS_MARKETS_MAX,
  PERPS_NUM_BOUNDS,
  perpsBlockerText,
  type PerpMarketClass,
  type PerpsDriver,
  type PerpsNumKey,
} from "@merrymen/core";
import { count } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages/en";
import {
  EMPTY_PERPS_DRAFT,
  PERPS_NUM_KEYS,
  PERPS_NUM_UNIT,
  liveConsentCounts,
  liveConsentStale,
  perpMarketGroups,
  perpMarketsInForce,
  perpsDraftBlocked,
  perpsDraftBody,
  perpsDraftDirty,
  perpsDraftProblems,
  perpsEffectiveCap,
  perpsAutonomyReadiness,
  perpsLiveOffBody,
  perpsLiveOnBody,
  perpsNumInForce,
  perpsStatusView,
  readPerpsGrant,
  sessionGapMarkets,
  stopAtLeverage,
  withOwner,
  type PerpsDefaults,
  type PerpsDraft,
  type PerpsGrantRead,
  type PerpsStored,
} from "./perps-settings";

/** Lighter's terms, named on the consent (docs/perps.md rule 1). */
export const LIGHTER_TERMS_URL = "https://lighter.xyz/terms";

/** The strategy `perpsDriver: "strategist"` needs (the lane resolves it to manual otherwise). */
const LLM_STRATEGIST = "llm-strategist";

const DRIVER_LABEL = {
  "perp-trend": "settings.perps.driver.perpTrend",
  strategist: "settings.perps.driver.strategist",
  manual: "settings.perps.driver.manual",
} as const satisfies Record<PerpsDriver, MessageKey>;

const DRIVER_HINT = {
  "perp-trend": "settings.perps.driver.perpTrendHint",
  strategist: "settings.perps.driver.strategistHint",
  manual: "settings.perps.driver.manualHint",
} as const satisfies Record<PerpsDriver, MessageKey>;

const CLASS_LABEL = {
  crypto: "settings.perps.class.crypto",
  equity: "settings.perps.class.equity",
  etf: "settings.perps.class.etf",
  metal: "settings.perps.class.metal",
  "pre-ipo": "settings.perps.class.preIpo",
  meme: "settings.perps.class.meme",
} as const satisfies Record<PerpMarketClass, MessageKey>;

const NUM_LABEL = {
  perpsMaxLeverage: "settings.perps.label.perpsMaxLeverage",
  perpsPerTradeUsdg: "settings.perps.label.perpsPerTradeUsdg",
  perpsMaxOpenNotionalUsdg: "settings.perps.label.perpsMaxOpenNotionalUsdg",
  perpsMaxCollateralUsdg: "settings.perps.label.perpsMaxCollateralUsdg",
  perpsMaxOpensPerDay: "settings.perps.label.perpsMaxOpensPerDay",
  perpsStopLossPct: "settings.perps.label.perpsStopLossPct",
  perpsStopSlipBps: "settings.perps.label.perpsStopSlipBps",
  perpsTakeProfitPct: "settings.perps.label.perpsTakeProfitPct",
  perpsLiqBufferPct: "settings.perps.label.perpsLiqBufferPct",
  perpsMaxSlippageBps: "settings.perps.label.perpsMaxSlippageBps",
} as const satisfies Record<PerpsNumKey, MessageKey>;

const NUM_HINT = {
  perpsMaxLeverage: "settings.perps.hint.perpsMaxLeverage",
  perpsPerTradeUsdg: "settings.perps.hint.perpsPerTradeUsdg",
  perpsMaxOpenNotionalUsdg: "settings.perps.hint.perpsMaxOpenNotionalUsdg",
  perpsMaxCollateralUsdg: "settings.perps.hint.perpsMaxCollateralUsdg",
  perpsMaxOpensPerDay: "settings.perps.hint.perpsMaxOpensPerDay",
  perpsStopLossPct: "settings.perps.hint.perpsStopLossPct",
  perpsStopSlipBps: "settings.perps.hint.perpsStopSlipBps",
  perpsTakeProfitPct: "settings.perps.hint.perpsTakeProfitPct",
  perpsLiqBufferPct: "settings.perps.hint.perpsLiqBufferPct",
  perpsMaxSlippageBps: "settings.perps.hint.perpsMaxSlippageBps",
} as const satisfies Record<PerpsNumKey, MessageKey>;

const UNIT_KEY = {
  x: "settings.perps.unit.x",
  usdg: "settings.unit.usdg",
  perDay: "settings.perps.unit.perDay",
  pct: "settings.perps.unit.pct",
  bps: "settings.unit.bps",
} as const satisfies Record<(typeof PERPS_NUM_UNIT)[PerpsNumKey], MessageKey>;

export interface PerpsSettingsProps {
  /** The stored settings, as GET /api/settings read them (SettingsView.values). */
  values: PerpsStored;
  /** SettingsView.defaults. */
  defaults: PerpsDefaults;
  /** SettingsView.owner — sent back with every write, as the page's own save does. */
  owner: string | null;
  /** Resolved hosted flag; null while the page does not know yet. */
  hosted: boolean | null;
  /** After a write the server accepted: re-read the settings so the switches show the server's answer. */
  onSaved: () => void | Promise<void>;
}

type Busy = "paper" | "live" | "fields" | null;
/** A save's outcome, shown beside the control that made it. */
type Note = { at: "switch" | "consent" | "fields"; ok: boolean; lines: string[] };

export function PerpsSettings(props: PerpsSettingsProps) {
  // Consent, unsaved limits and the venue report belong to the owner who read
  // them. A changed session must begin with a fresh section, before any click.
  return <PerpsSettingsForOwner key={`${props.hosted}:${props.owner?.toLowerCase() ?? "none"}`} {...props} />;
}

function PerpsSettingsForOwner({ values, defaults, owner, hosted, onSaved }: PerpsSettingsProps) {
  const t = useT();
  const [grants, setGrants] = useState<PerpsGrantRead>({ state: "loading" });
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [attested, setAttested] = useState(false);
  const [draft, setDraft] = useState<PerpsDraft>(EMPTY_PERPS_DRAFT);
  const [statusRevision, setStatusRevision] = useState(0);
  const [readAt, setReadAt] = useState(Date.now);
  const limitsSection = useRef<HTMLDetailsElement | null>(null);
  const consentTitle = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Setup continues on the worker's clock. Keep its progress visible without
  // a page reload, including after the owner returns from re-signing.
  useEffect(() => {
    let current = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const schedule = () => {
      if (current) timer = setTimeout(() => {
        if (document.visibilityState === "hidden") schedule();
        else void load();
      }, 15_000);
    };
    const load = async () => {
      if (!current || inFlight) return;
      inFlight = true;
      if (timer) clearTimeout(timer);
      const abort = new AbortController();
      active = abort;
      const deadline = setTimeout(() => abort.abort(), 10_000);
      try {
        const query = hosted && owner ? `?owner=${encodeURIComponent(owner)}` : "";
        // Bound both response headers and body reading. A fresh controller on
        // every attempt lets a timed-out request recover on the next poll.
        const read = await Promise.race([
          (async () => {
            const res = await fetch(`/api/grants${query}`, { cache: "no-store", signal: abort.signal });
            return res.ok ? readPerpsGrant(await res.json()) : { state: "unread" } as const;
          })(),
          new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(new Error("status read ended")), { once: true })),
        ]);
        if (current) { setGrants(read); setReadAt(Date.now()); }
      } catch {
        if (current) setGrants({ state: "unread" });
      } finally {
        clearTimeout(deadline);
        active = null;
        inFlight = false;
        schedule();
      }
    };
    void load();
    window.addEventListener("focus", load);
    return () => {
      current = false;
      active?.abort();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", load);
    };
  }, [hosted, owner, statusRevision]);

  // THE CONSENT OPENS ON ITS TITLE, NOT ITS BUTTON: focus lands on the words,
  // so a repeated keypress on the switch reads the consent instead of giving it
  // (the XPosting lesson). The button is disabled until the box is ticked too.
  useEffect(() => {
    if (consentOpen) consentTitle.current?.focus();
  }, [consentOpen]);

  const paperOn = values.perpsEnabled ?? defaults.perpsEnabled;
  const liveOn = liveConsentCounts(values);

  // Practice switched off (here, or in another tab and re-read) while the
  // consent is open: the second act no longer has its first, so it closes
  // rather than record a consent for perpetuals that are off.
  useEffect(() => {
    if (!paperOn) {
      setConsentOpen(false);
      setAttested(false);
    }
  }, [paperOn]);
  const liveStale = liveConsentStale(values);
  const accountLive = values.liveTradingEnabled ?? defaults.liveTradingEnabled;
  const strategy = values.strategy ?? defaults.strategy;
  const status = perpsStatusView(grants);

  async function put(body: Record<string, unknown>): Promise<{ ok: boolean; wrote: boolean; lines: string[] }> {
    let res: Response;
    try {
      res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withOwner(body, owner)),
      });
    } catch {
      return { ok: false, wrote: false, lines: [t("settings.perps.unreachable")] };
    }
    const json = (await res.json().catch(() => null)) as { errors?: unknown; saved?: unknown; note?: unknown } | null;
    if (res.ok) return { ok: true, wrote: true, lines: [t("settings.perps.saved")] };
    const errors = Array.isArray(json?.errors) ? json.errors.filter((e): e is string => typeof e === "string") : [];
    // A refused save that still wrote its offs says so in `note` — shown, and
    // re-read, because a switch that went off must stop reading "on".
    const wrote = Array.isArray(json?.saved) && json.saved.length > 0;
    return { ok: false, wrote, lines: [t("settings.perps.notSaved"), ...errors, ...(typeof json?.note === "string" ? [json.note] : [])] };
  }

  async function write(at: Note["at"], which: Exclude<Busy, null>, body: Record<string, unknown>): Promise<boolean> {
    setBusy(which);
    setNote(null);
    const r = await put(body);
    // A response for the old owner cannot refresh or annotate the new page.
    if (!mounted.current) return false;
    if (r.wrote) {
      try {
        await onSaved();
      } catch {
        /* the page keeps its last read; the note below still says what happened */
      }
    }
    if (!mounted.current) return false;
    setNote({ at, ok: r.ok, lines: r.lines });
    if (r.wrote) setStatusRevision(n => n + 1);
    setBusy(null);
    return r.ok;
  }

  function openConsent() {
    setNote(null);
    setAttested(false);
    setConsentOpen(true);
  }

  function closeConsent() {
    setConsentOpen(false);
    setAttested(false);
  }

  async function giveConsent() {
    // The button is disabled until the box is ticked; this is the same rule
    // said twice, so a stray call can never send a consent without it.
    if (!attested) return;
    if (await write("consent", "live", perpsLiveOnBody())) closeConsent();
  }

  // ── the draft ───────────────────────────────────────────────────────────
  const driverVal: PerpsDriver = draft.driver ?? values.perpsDriver ?? defaults.perpsDriver;
  const marketsVal = draft.markets ?? perpMarketsInForce(values, defaults);
  const problems = perpsDraftProblems(draft, values, defaults);
  const dirty = perpsDraftDirty(draft);
  const numText = (k: PerpsNumKey): string => {
    const typed = draft.nums[k];
    if (typed !== undefined) return typed;
    const stored = values[k];
    return typeof stored === "number" ? String(stored) : "";
  };
  const inForce = (k: PerpsNumKey) => perpsNumInForce(k, draft.nums[k], values, defaults);

  function toggleMarket(key: string) {
    const next = marketsVal.includes(key) ? marketsVal.filter((m) => m !== key) : [...marketsVal, key];
    setDraft((d) => ({ ...d, markets: next }));
  }

  async function saveDraft() {
    if (!dirty || perpsDraftBlocked(problems)) return;
    if (await write("fields", "fields", perpsDraftBody(draft))) setDraft(EMPTY_PERPS_DRAFT);
  }

  const noteView = (at: Note["at"]) =>
    note?.at === at ? (
      <div className={note.ok ? "mm-hint" : "mm-danger mono"} role={note.ok ? "status" : "alert"}>
        {note.lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    ) : null;

  // ── what real perpetuals also need ─────────────────────────────────────
  // Said in the consent and beside a live switch that is on, because the
  // switch is necessary and never sufficient: the account's own live rail and
  // a grant carrying the perps permission are separate acts (rule 1), and the
  // operator may only restrict.
  const grantLine =
    grants.state === "loading" ? null : grants.state === "unread" ? (
      t("settings.perps.needs.grantUnread")
    ) : !grants.exists ? (
      <>
        {t("settings.perps.needs.grantNone")} <Link href="/grant#resign">{t("settings.perps.needs.resign")}</Link>
      </>
    ) : grants.granted ? (
      t("settings.perps.needs.grantYes")
    ) : (
      <>
        {t("settings.perps.needs.grantNo")} <Link href="/grant#resign">{t("settings.perps.needs.resign")}</Link>
      </>
    );
  const offer = grants.state === "read" ? grants.optIn : null;
  const needs = (
    <div className="perps-needs">
      <b>{t("settings.perps.needs.title")}</b>
      <ul>
        <li>{accountLive ? t("settings.perps.needs.liveTradingOn") : <>{t("settings.perps.needs.liveTradingOff")} <Link href="/settings#trading-mode">{t("settings.perps.setup.reviewMode")}</Link></>}</li>
        {grantLine !== null && <li>{grantLine}</li>}
      </ul>
      {offer === false && <p>{t("settings.perps.needs.notOffered")}</p>}
      {offer === null && hosted === true && <p>{t("settings.perps.needs.mayNotBeOffered")}</p>}
    </div>
  );

  // ── the status line ─────────────────────────────────────────────────────
  const statusLines: string[] = [];
  if (status.kind === "loading") statusLines.push(t("settings.perps.status.loading"));
  else if (status.kind === "unread") statusLines.push(t("settings.perps.status.unread"));
  else if (status.kind === "not-reported") statusLines.push(t("settings.perps.status.notReported"));
  else {
    const modeKey = {
      off: "settings.perps.status.off",
      paper: "settings.perps.status.paper",
      live: "settings.perps.status.live",
      refuse: "settings.perps.status.refuse",
    } as const satisfies Record<typeof status.mode, MessageKey>;
    statusLines.push(t(modeKey[status.mode]));
    if (status.blocker) {
      statusLines.push(status.blocker.what);
      if (status.blocker.remedy) statusLines.push(status.blocker.remedy);
    }
    // THE BOOK, NOT THE RAIL: practice positions held while perps are off are
    // still "paper positions"; an unplaced book gets neither label. And an
    // unread venue never reads "Open positions: 0" — it gives the worker's
    // last-held count, said as that (perpsStatusView).
    const positionsKey = status.lighterUnread
      ? status.book === "paper"
        ? "settings.perps.status.positionsPaperUnread"
        : "settings.perps.status.positionsUnread"
      : status.book === "paper"
        ? "settings.perps.status.positionsPaper"
        : status.book === null && status.positions > 0
          ? "settings.perps.status.positionsBookUnknown"
          : "settings.perps.status.positions";
    statusLines.push(t(positionsKey, { count: count(status.positions) }));
    if (status.lighterUnread) statusLines.push(t(status.book === "paper" ? "settings.perps.status.paperUnread" : "settings.perps.status.lighterUnread"));
    if (status.stopsMissing > 0) statusLines.push(t("settings.perps.status.stopsMissing", { count: count(status.stopsMissing) }));
    if (status.incident) statusLines.push(t("settings.perps.status.incident"));
  }

  // ── reachability and the stop, from the values in force ────────────────
  const signed = grants.state === "read" ? grants.signedPerTradeUsdg : null;
  const cap = perpsEffectiveCap(signed, inForce("perpsPerTradeUsdg"));
  let capLine: string | null = null;
  if (grants.state === "unread") capLine = t("settings.perps.reach.capUnread");
  else if (grants.state === "read") {
    if (!grants.exists) capLine = t("settings.perps.reach.capNoGrant");
    else if (cap === null || signed === null) capLine = t("settings.perps.reach.capUnread");
    else capLine = t("settings.perps.reach.cap", { cap: count(cap), signed: count(signed) });
  }
  // The one reachability fact the report carries: the worker found EVERY
  // market an open could go to below the signed cap (perps/view.ts). Said
  // here, beside the markets, as well as in the status line — per market it
  // stays "checked when the agent next reads the venue".
  const belowMin =
    grants.state === "read" && grants.report?.blocker === "perps-cap-below-min" ? perpsBlockerText("perps-cap-below-min") : null;
  const gap = sessionGapMarkets(marketsVal);
  const leverage = inForce("perpsMaxLeverage");
  const stop = stopAtLeverage({
    stopPct: inForce("perpsStopLossPct"),
    slipBps: inForce("perpsStopSlipBps"),
    leverage,
    liqBufferPct: inForce("perpsLiqBufferPct"),
  });
  const full = marketsVal.length >= PERPS_MARKETS_MAX;
  const readiness = perpsAutonomyReadiness(values, defaults, grants, readAt);
  const ownerHalted = grants.state === "read" && (grants.report?.entriesHalted === true ||
    (grants.report?.entriesHalted === undefined && grants.report?.blocker === "perps-entries-halted"));
  function reviewLimits() {
    if (!limitsSection.current) return;
    limitsSection.current.open = true;
    limitsSection.current.scrollIntoView?.({ block: "start" });
  }

  return (
    <>
      <div className="mm-section" id="perpetuals">
        {t("settings.perps.section")}
      </div>
      <p className="mm-hint" style={{ marginTop: 0 }}>
        {t("settings.perps.intro")}
      </p>

      <div className="mm-hint perps-status" role="status">
        <b>{t("settings.perps.status.title")}</b>
        {statusLines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        {grants.state === "read" && grants.report?.blocker === "perps-no-collateral" && <p><Link href="/deposit">{t("settings.perps.setup.addFunds")}</Link></p>}
        <button type="button" className="mm-btn" onClick={() => setStatusRevision(n => n + 1)}>{t("settings.perps.status.refresh")}</button>
      </div>

      <section className="mm-hint perps-readiness" aria-label="Automatic perpetual trading">
        <b>{t("settings.perps.setup.title")}</b>
        <p>{t(DRIVER_LABEL[readiness.driver])}. {t(DRIVER_HINT[readiness.driver])}</p>
        {readiness.enabled && readiness.driver !== "manual" && <p>{t("settings.perps.setup.automatic")}</p>}
        {readiness.manual && <p role="status">{t("settings.perps.setup.manual")}</p>}
        {readiness.strategistMismatch && <p role="status">{t("settings.perps.driver.strategistMismatch", { strategy })}</p>}
        {readiness.noTrendMarkets && <p role="status">{t("settings.perps.setup.noTrendMarkets")}</p>}
        {readiness.authority && <p role="status">
          {readiness.authority === "short" ? t("settings.perps.setup.authorityShort", { hours: readiness.requiredHours, remaining: Math.floor(readiness.remainingHours ?? 0) }) : t("settings.perps.setup.authorityUnread", { hours: readiness.requiredHours })}
          {" "}<Link href="/grant#resign">{t("settings.perps.setup.reviewGrant")}</Link>
        </p>}
        {readiness.enabled && <>
          <p>{readiness.minimums.length ? t("settings.perps.setup.minimums") : t("settings.perps.setup.minimumsUnread")}</p>
          <ul>{readiness.minimums.map(m => <li key={m.market}>
            {m.market}: {count(m.minimumUsdg)} USDG {t("settings.perps.setup.minimum")}
            {m.fits === false ? ` — ${t("settings.perps.setup.capShort", { cap: count(readiness.cap) })}` : ""}
          </li>)}</ul>
          {readiness.minimums.some(m => m.fits === false) && <p role="status">
            {t("settings.perps.setup.minimumAction")} {" "}<Link href="/grant#resign">{t("settings.perps.setup.reviewGrant")}</Link>
          </p>}
        </>}
        <button type="button" className="mm-btn" onClick={reviewLimits}>{t("settings.perps.setup.reviewLimits")}</button>
      </section>

      {ownerHalted && status.kind === "report" && status.book !== null && (
        <PerpsResume key={`${owner}:${status.book}`} owner={owner} hosted={hosted} mode={status.book} incident={grants.state === "read" && grants.report?.incident === true} />
      )}

      <div className="mm-grid">
        <label className="mm-field">
          <span className="mm-label">{t("settings.perps.label.paper")}</span>
          <span className="mm-input">
            <input
              type="checkbox"
              checked={paperOn}
              disabled={busy !== null}
              onChange={(e) => void write("switch", "paper", { perpsEnabled: e.target.checked })}
              style={{ width: "auto" }}
            />
            <span className="mm-unit">
              {busy === "paper"
                ? t("settings.perps.saving")
                : !paperOn
                  ? t("settings.perps.paper.off")
                  : accountLive
                    ? t("settings.perps.paper.onLiveAccount")
                    : t("settings.perps.paper.on")}
            </span>
          </span>
          <span className="mm-hint">{t("settings.perps.paper.hint")}</span>
        </label>
        <label className="mm-field">
          <span className="mm-label">{t("settings.perps.label.live")}</span>
          <span className="mm-input">
            <input
              type="checkbox"
              checked={liveOn}
              // ON NEEDS PRACTICE SAVED ON FIRST; OFF IS NEVER BLOCKED. A live
              // switch that is on can always be pressed, whatever else is true.
              disabled={busy !== null || (!liveOn && !paperOn)}
              onChange={(e) => (e.target.checked ? openConsent() : void write("switch", "live", perpsLiveOffBody()))}
              style={{ width: "auto" }}
            />
            <span className="mm-unit">
              {busy === "live" ? t("settings.perps.saving") : liveOn ? t("settings.perps.live.on") : t("settings.perps.live.off")}
            </span>
          </span>
          <span className="mm-hint">{!liveOn && !paperOn ? t("settings.perps.live.needsPaper") : t("settings.perps.live.offHint")}</span>
        </label>
      </div>
      <p className="mm-hint">{t("settings.perps.switchesSave")}</p>
      {liveStale && (
        <p className="mm-hint" role="status">
          <b>{t("settings.perps.live.stale")}</b>
        </p>
      )}
      {liveOn && <div className="mm-hint">{needs}</div>}
      {noteView("switch")}

      {consentOpen && (
        <div className="mm-hint perps-consent" role="group" aria-labelledby="perps-consent-title" style={{ marginTop: 8 }}>
          <b id="perps-consent-title" tabIndex={-1} ref={consentTitle}>
            {t("settings.perps.consent.title")}
          </b>
          <div className="mm-danger">{t("settings.perps.consent.worstCase")}</div>
          <p>{t("settings.perps.consent.bounds")}</p>
          <p>{t("settings.perps.consent.leverage")}</p>
          <p>{t("settings.perps.consent.funding")}</p>
          <p>{t("settings.perps.consent.public")}</p>
          <p>{t("settings.perps.consent.withdrawal")}</p>
          <p>
            {t("settings.perps.consent.venue")}{" "}
            <a href={LIGHTER_TERMS_URL} target="_blank" rel="noreferrer">
              {t("settings.perps.consent.terms")} ↗
            </a>
          </p>
          <p>{t("settings.perps.consent.regions")}</p>
          {needs}
          <label className="ack-row">
            <input type="checkbox" checked={attested} disabled={busy !== null} onChange={(e) => setAttested(e.target.checked)} />
            <span>{t("settings.perps.consent.attest")}</span>
          </label>
          <div className="resign-actions">
            <button type="button" className="mm-btn primary" disabled={!attested || busy !== null} onClick={() => void giveConsent()}>
              {busy === "live" ? t("settings.perps.saving") : t("settings.perps.consent.confirm")}
            </button>
            <button type="button" className="mm-btn" disabled={busy !== null} onClick={closeConsent}>
              {t("settings.perps.consent.cancel")}
            </button>
          </div>
          {!attested && <p className="mm-hint">{t("settings.perps.consent.tickFirst")}</p>}
          {noteView("consent")}
        </div>
      )}

      <details className="settings-group" id="perpetuals-limits" ref={limitsSection}>
        <summary>{t("settings.perps.group")}</summary>
        <p className="mm-hint" style={{ marginTop: 0 }}>
          {t("settings.perps.groupSaves")}
        </p>

        <div className="mm-grid">
          <label className="mm-field">
            <span className="mm-label">{t("settings.perps.label.driver")}</span>
            <span className="mm-input">
              <select value={driverVal} onChange={(e) => setDraft((d) => ({ ...d, driver: e.target.value as PerpsDriver }))}>
                {PERPS_DRIVERS.map((id) => (
                  <option key={id} value={id}>
                    {t(DRIVER_LABEL[id])}
                  </option>
                ))}
              </select>
            </span>
            <span className="mm-hint">{t(DRIVER_HINT[driverVal])}</span>
          </label>
        </div>
        {driverVal === "strategist" && strategy !== LLM_STRATEGIST && (
          <p className="mm-hint" role="status">
            <b>{t("settings.perps.driver.strategistMismatch", { strategy })}</b>
          </p>
        )}

        <div className="mm-field">
          <span className="mm-label">{t("settings.perps.label.markets", { count: marketsVal.length, max: PERPS_MARKETS_MAX })}</span>
          {perpMarketGroups().map((g) => (
            <div key={g.cls}>
              <div className="mm-subtle mono" style={{ marginTop: 10 }}>
                {t(CLASS_LABEL[g.cls])}
              </div>
              <div className="mm-chips">
                {g.markets.map((m) => {
                  const on = marketsVal.includes(m.key);
                  return (
                    <button
                      key={m.key}
                      type="button"
                      className={`mm-toggle${on ? " on" : ""}`}
                      aria-pressed={on}
                      // At the cap, only what is on can be pressed — to untick it.
                      disabled={!on && full}
                      onClick={() => toggleMarket(m.key)}
                    >
                      {m.key}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <span className="mm-hint">{t("settings.perps.markets.hint", { max: PERPS_MARKETS_MAX })}</span>
          {problems.markets === "empty" && (
            <span className="mm-danger" role="alert">
              {t("settings.perps.markets.none")}
            </span>
          )}
          {full && <span className="mm-hint">{t("settings.perps.markets.full")}</span>}
        </div>
        {gap.length > 0 && (
          <div className="mm-danger" role="status">
            {t("settings.perps.markets.sessionGap", { markets: gap.join(", ") })}
          </div>
        )}

        <div className="mm-hint perps-reach">
          <b>{t("settings.perps.reach.title")}</b>
          {capLine !== null && <div>{capLine}</div>}
          {belowMin && (
            <div className="mm-danger" role="status">
              {belowMin.what}
              {belowMin.remedy ? ` ${belowMin.remedy}` : ""}
            </div>
          )}
          <ul>
            {marketsVal.map((k) => (
              <li key={k}>
                <b className="mono">{k}</b> — {t("settings.perps.reach.unchecked")}
              </li>
            ))}
          </ul>
        </div>

        <div className="mm-grid">
          {PERPS_NUM_KEYS.map((k) => {
            const b = PERPS_NUM_BOUNDS[k];
            const bad = problems.nums[k];
            const range =
              b.decimals === 0
                ? t("settings.perps.num.whole", { min: count(b.min), max: count(b.max) })
                : t("settings.perps.num.decimal", { min: count(b.min), max: count(b.max) });
            const error = bad
              ? bad.reason === "ambiguous"
                ? t("settings.perps.num.ambiguous", {
                    raw: draft.nums[k] ?? "",
                    a: count(bad.readings[0] ?? null),
                    b: count(bad.readings[1] ?? null),
                  })
                : range
              : k === "perpsMaxOpenNotionalUsdg" && problems.openBelowTrade !== null
                ? t("settings.perps.num.openBelowTrade", { perTrade: count(problems.openBelowTrade) })
                : null;
            return (
              <label className="mm-field" key={k}>
                <span className="mm-label">{t(NUM_LABEL[k])}</span>
                <span className="mm-input">
                  <input
                    type="text"
                    inputMode={b.decimals === 0 ? "numeric" : "decimal"}
                    name={k}
                    value={numText(k)}
                    placeholder={String(defaults[k])}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setDraft((d) => ({ ...d, nums: { ...d.nums, [k]: raw } }));
                    }}
                    aria-invalid={error !== null}
                  />
                  <span className="mm-unit">{t(UNIT_KEY[PERPS_NUM_UNIT[k]])}</span>
                </span>
                <span className="mm-hint">
                  {t(NUM_HINT[k])} {range}
                </span>
                {error !== null && (
                  <span className="mm-danger" role="alert">
                    {error}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <p className="mm-hint perps-stop">
          {t("settings.perps.stop.atLeverage", {
            stop: count(inForce("perpsStopLossPct")),
            lev: count(leverage),
            margin: count(stop.marginPct),
            worst: count(stop.worstMarginPct),
            liq: count(stop.liqBoundPct),
          })}
        </p>
        {stop.everyOpenRefused && (
          <div className="mm-danger" role="status">
            {t("settings.perps.stop.refused", { lev: count(leverage) })}
          </div>
        )}

        <button
          type="button"
          className="mm-btn primary"
          disabled={busy !== null || !dirty || perpsDraftBlocked(problems)}
          onClick={() => void saveDraft()}
        >
          {busy === "fields" ? t("settings.perps.saving") : t("settings.perps.save")}
        </button>
        {noteView("fields")}
      </details>
    </>
  );
}
