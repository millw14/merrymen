"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Encode } from "../../../packages/core/src/ids";
import { SOLANA_LIVE_MIN_TRADE_USDG_RAW, SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM, SOLANA_QUOTE_MAX_AGE_MS, SOLANA_REGISTERED_AFTER_REVOKE, type SolanaPaperLimits, type SolanaQuote } from "../../../packages/core/src/solana";
import type { SolanaPaperSnapshot } from "../../../worker/src/solana-paper-store";
import type { SolanaBinding } from "@/lib/solana-binding-store";
import { privyEnabled } from "@/lib/privy-client";
import { useSolanaOwner } from "./useSolanaOwner";
import { RequestError, UNREACHABLE } from "./request-json";
import { SignIn } from "./HostedControls";
import { SolanaAutomation } from "./SolanaAutomation";
import { OWNER_CONFIRMATION_UNAVAILABLE, outcomeAfterRefusal, pacedAnswer, refusedByServer, savedNothing, signatureOf, SolanaOwnerActions, SolanaRequestError, type OwnerRecord, type OwnerWallet, type RecoverableSol } from "./SolanaOwnerActions";
import { ownerKeyExportEnabled, pageTrustsVaultProgram, releasedProgramSha256, SOLANA_UNRELEASED_PROGRAM, SolanaRecovery } from "./SolanaRecovery";
import { checkPreparedPermission, PermissionReview, PermissionTerms, permissionExpiry, secondsUntil, type PreparedPermission, type SignedPermissionTerms } from "./SolanaPermission";
import { deriveSolanaAta, deriveSolanaVaultAddress } from "../../../packages/core/src/solana-live";
import { solanaUnits as units, displaySolanaAmount as display, displaySolanaAmountOrNull } from "../lib/solana-amounts";
import { SOLANA_OTHER_SIGN_IN } from "../lib/solana-sign-in";
import { SOLANA_LIVE_CAP_DEFAULTS, SOLANA_LIVE_NOT_OPEN, SOLANA_LIVE_PAUSED, SOLANA_LIVE_PAUSED_NO_PERMISSION, SOLANA_LIVE_ROLLOUT_MISCONFIGURED, SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION,
  solanaLiveCapRefusal, solanaLiveCapsExceeded, solanaLiveCapsText, solanaLiveSavedAboveCaps, solanaLiveSessionAboveCaps, type SolanaLiveCaps } from "../lib/solana-live-caps";
import "./SolanaScreen.css";

const WSOL = "So11111111111111111111111111111111111111112";
/** The form's starting limits in paper mode: 10 and 50 USDG; 0.1 and 0.5 SOL sold, should live be chosen once limits are saved. */
const PAPER_DEFAULTS = { perTrade: "10", daily: "50", perTradeSol: "0.1", dailySol: "0.5" } as const;
type RuntimeStatus = {
  owner: string; requestedMode: "paper" | "live"; paper: SolanaPaperSnapshot | null;
  live: { ready: boolean; canExit?: boolean; cashTokenAccount?: string | null; blockers: string[]; programId: string | null; vault: string | null; session: string | null; pending: Receipt[];
    balances?: { slot: number; cashUsdg: string; wsolRaw: string } | null;
    book?: { realizedPnlUsdgRaw: string; networkFeesLamports: string; unresolvedFeeCount?: number; reservedUnknownFeeLamports?: string; quarantinedWsolRaw?: string } | null;
    history?: Receipt[]; ownerTransaction?: { signature: string; status: string; kind?: string;
      /** A revocation signed beside it (the revoke slot), with its own signature and outcome. */
      revoke?: { signature: string; status: string; kind?: string; revokeAgain?: boolean } | null } | null;
    /** Not blockers: a low shared fee payer, an owner wallet short of SOL for revoke or withdraw. */
    warnings?: string[];
    feePayer?: { lamports: string; level: FeePayerLevel } | null;
    ownerWallet?: OwnerWallet | null; recoverable?: RecoverableSol | null };
  limits: SolanaPaperLimits | null;
  automation?: { workerOnline: boolean; lastSeenAtMs: number | null };
  /**
   * The live rollout (MERRYMEN_SOLANA_LIVE_TENANTS and the live caps): whether this account may go live, and the caps a new
   * permission must fit (null while a cap setting cannot be read). Never the list itself. Absent from an older server.
   */
  liveAccess?: { onList: boolean; misconfigured: boolean; caps: SolanaLiveCaps | null };
};
type Status = { binding: SolanaBinding | null; runtime: RuntimeStatus | null };
type FeePayerLevel = "ok" | "low" | "buys-blocked" | "exits-blocked";
/** The shared network fee payer's level, in the owner's words (the runtime's blockers and warnings say what follows from it). */
const FEE_PAYER_LEVELS: Record<FeePayerLevel, string> = { ok: "funded", low: "low; trading continues and operators are alerted",
  "buys-blocked": "too low for buys; exits continue", "exits-blocked": "too low for any trade, exits included" };
/**
 * A prepared permission the owner reviews before the wallet opens. The server
 * accepts its signature for 60 seconds from prepare; the page offers to sign
 * it for less, so the signed bytes still reach the server in time.
 */
type Review = { transactionBase64: string; limits: SolanaPaperLimits; terms: SignedPermissionTerms; requiredLamports: string | null; ownerLamports: string | null; deadline: number };
const REVIEW_SIGN_WINDOW_MS = 45_000;
type Receipt = { mode?: string; requestId?: string; signature?: string; status?: string; state?: string;
  intent?: { outputMint?: string }; minOutAmount?: string; quotedOutAmount?: string; quote?: { minOutAmount?: string }; outputAmountRaw?: string };
/**
 * A preview is only good for its quote's lifetime, and only for the exact
 * trade it quoted. `movedFrom`: this is the fresh minimum a price-moved
 * refusal of that trade offered (quote.minOutAmount), below the minimum the
 * refused request carried (movedFrom). It is placed only on the owner's own
 * click, as the same trade with the same request ID and amount.
 */
type Preview = { quote: SolanaQuote; key: string; deadline: number; lifetime: number; movedFrom?: string };
/** The intent route's price-moved refusal, word for word (PRICE_MOVED in web/src/lib/solana-api.ts; a test pins the two together). */
export const SOLANA_PRICE_MOVED = "The price moved. Preview again; nothing was sent.";
/**
 * The server's answer while this account's Solana wallet was verified with another sign-in: the
 * status route's and every account route's 403, the bind route's 409. Creating or verifying a wallet
 * cannot help then (a new wallet is an orphan, a verify is refused), so the page says the way back.
 */
function otherSignIn(error: unknown): boolean {
  return error instanceof RequestError && (error.status === 403 || error.status === 409) && error.message === SOLANA_OTHER_SIGN_IN;
}
/** The market's zero-output answer: no route buys this amount (TOO_SMALL in web/src/lib/solana-api.ts; pinned the same way). */
export const SOLANA_TOO_SMALL = "This amount is too small to trade: no route returns anything for it. Nothing was sent or recorded. Try a larger amount.";
/** The slippage the server's write-off quotes a lot back with (SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS; a test keeps the two equal). */
export const SOLANA_WRITE_OFF_SLIPPAGE_BPS = 100;
/**
 * A HOSTED PAPER LOT THE OWNER MAY WRITE OFF, AND ONLY AFTER THE MARKET SAID IT IS DUST.
 *
 * A dust lot (no route buys it back) keeps its position slot, and while any
 * lot but wrapped SOL is held the paper strategy holds, so the owner can write
 * it off: POST /api/solana/paper/write-off books the whole lot at zero, only
 * on the market's own zero-output answer, and cannot be undone. The page
 * offers it only for a lot whose whole sale was just answered 400 TOO_SMALL:
 * selling the whole wrapped SOL lot in the trade form, or, for a lot the form
 * cannot sell, "Check for write-off" (a preview of selling the whole lot,
 * which records nothing). An ordinary lot never shows the offer, and nothing
 * is sent until the owner confirms. The offer holds only while the portfolio
 * still shows that exact lot. The status has no dust marker to offer it from
 * (a cross-track request asks for one); the server refuses anything that is
 * not dust (409, shown verbatim) either way.
 *
 * The check is stricter than the write-off: a paper preview is refused once
 * the book's limits (the saved ones) have expired, and while the mints'
 * safety reads are unavailable, though the write-off itself needs neither.
 * OWNER DECISION (the conservative option): the offer still needs the
 * market's zero-output answer to a check, so with expired limits the page
 * says to save new limits first. The alternative offers the write-off from a
 * status dust marker, once the status carries one.
 */
type DustLot = { mint: string; amountRaw: string; confirming: boolean };
const RAW = /^(0|[1-9][0-9]*)$/;
type WrittenOffBook = Partial<SolanaPaperSnapshot> & Pick<SolanaPaperSnapshot, "cashRaw" | "positions">;
/**
 * The paper book in a write-off's 200 answer ({ paper, writtenOff }), if it
 * can be shown as is: its cash and every lot in base units, and no lot of
 * `mint`, which the write-off removed whole. Null for anything else.
 */
function writtenOffBook(answered: unknown, mint: string): WrittenOffBook | null {
  if (answered === null || typeof answered !== "object") return null;
  const book = answered as { cashRaw?: unknown; positions?: unknown; version?: unknown };
  if (typeof book.cashRaw !== "string" || !RAW.test(book.cashRaw) || !Array.isArray(book.positions)) return null;
  const lots = book.positions as unknown[];
  for (const lot of lots) {
    const fields: { mint?: unknown; amountRaw?: unknown; decimals?: unknown } = lot !== null && typeof lot === "object" ? lot : {};
    if (typeof fields.mint !== "string" || fields.mint === mint || typeof fields.amountRaw !== "string" || !RAW.test(fields.amountRaw) || !Number.isInteger(fields.decimals)) return null;
  }
  if (book.version !== undefined && !Number.isSafeInteger(book.version)) return null;
  return answered as WrittenOffBook;
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0)); }
/** The saved expiry is absolute; the form shows the whole hours left, so an untouched form matches it. */
function hoursLeft(expiresAtMs: number): string {
  const remaining = expiresAtMs - Date.now();
  return remaining > 0 ? String(Math.min(168, Math.max(1, Math.ceil(remaining / 3_600_000)))) : "24";
}

/**
 * THE SOLANA ROUTES' FETCH: requestJson, KEEPING THE BODY'S FIELDS.
 *
 * The same deadline, cancellation, sentences and status 0 for no answer as
 * requestJson (request-json.ts), except that a refusal is a
 * SolanaRequestError carrying the answer's validated notSaved and
 * freshMinOutAmount, which requestJson drops. (A cross-track request asks for
 * RequestError to keep the body, so this can go back to requestJson.)
 */
export async function solanaRequestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const deadline = AbortSignal.timeout(20_000), caller = init.signal, controller = new AbortController();
  const cancel = () => controller.abort(caller?.reason), expire = () => controller.abort(deadline.reason);
  if (caller?.aborted) cancel(); else caller?.addEventListener("abort", cancel, { once: true });
  deadline.addEventListener("abort", expire, { once: true });
  try {
    let response: Response;
    try { response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal }); }
    catch { throw new SolanaRequestError(UNREACHABLE, 0); }
    const isJson = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
    // A body that promised JSON and broke off half way is the same as no body.
    const data: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
    if (!response.ok) {
      // The server's sentence for a 4xx or an explicitly owner-facing 5xx, as requestJson reads it.
      const d: { error?: unknown; errors?: unknown; why?: unknown; ownerFacing?: unknown } = data !== null && typeof data === "object" ? data : {};
      const owned = response.status >= 500 && d.ownerFacing !== true ? null
        : typeof d.error === "string" && d.error ? d.error : Array.isArray(d.errors) && d.errors.length ? d.errors.join(" ") : typeof d.why === "string" && d.why ? d.why : null;
      if (response.status >= 500 && owned === null && data !== undefined) console.warn(`[merrymen] ${url} answered ${response.status}:`, data);
      throw new SolanaRequestError(owned ?? `merrymen answered with an error (${response.status}). Try again in a moment.`, response.status, data);
    }
    if (data === undefined) throw new SolanaRequestError("merrymen sent back something that isn't data. Try again in a moment.", response.status);
    return data as T;
  } finally {
    caller?.removeEventListener("abort", cancel);
    deadline.removeEventListener("abort", expire);
  }
}

export function SolanaScreen() {
  return <section className="solana-screen" aria-labelledby="solana-title">
    <header><p className="solana-eyebrow">Solana · mainnet</p><h1 id="solana-title">Your Solana account</h1><p>Practice at live prices, or authorize a bounded trading session for real funds.</p></header>
    {privyEnabled() ? <ConnectedSolana /> : <p role="status">Protected wallet sign-in must be configured before using Solana.</p>}
  </section>;
}

function ConnectedSolana() {
  const signer = useSolanaOwner();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // What the owner should read that is not a failure (role=status): a pacing answer (429: wait and try
  // again), a price move with no usable fresh minimum, a lot the market quotes nothing for, a write-off done.
  const [notice, setNotice] = useState("");
  // The account's wallet was verified with another sign-in (otherSignIn): no wallet to create or verify here.
  const [otherLogin, setOtherLogin] = useState(false);
  const [dust, setDust] = useState<DustLot | null>(null);
  // The USDG deposit address the page derived itself, for a program its pin trusts; the funding card shows only that.
  const [depositAccount, setDepositAccount] = useState<string | null>(null);
  const [mode, setMode] = useState<"paper" | "live">("paper"), [consent, setConsent] = useState(false);
  // Paper's defaults; choosing live with nothing saved or typed starts from the live caps instead (chooseMode).
  const [perTrade, setPerTrade] = useState<string>(PAPER_DEFAULTS.perTrade), [daily, setDaily] = useState<string>(PAPER_DEFAULTS.daily);
  const [perTradeSol, setPerTradeSol] = useState<string>(PAPER_DEFAULTS.perTradeSol), [dailySol, setDailySol] = useState<string>(PAPER_DEFAULTS.dailySol);
  const [ops, setOps] = useState("20"), [drawdown, setDrawdown] = useState("20"), [duration, setDuration] = useState("24");
  const [initialCash, setInitialCash] = useState("1000"), [side, setSide] = useState<"buy" | "sell">("buy"), [amount, setAmount] = useState("1");
  const [preview, setPreview] = useState<Preview | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [, setQuoteClock] = useState(0);
  // `signature` is what the server records these bytes by; `sent`: an earlier submission reached the server, or may have.
  const [registration, setRegistration] = useState<{ signature: string | null; sent: boolean; secret: string; signedTransactionBase64: string; limits: SolanaPaperLimits } | null>(null);
  const [savedDuration, setSavedDuration] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null), [reviewLapsed, setReviewLapsed] = useState(false);
  const [, setReviewClock] = useState(0);
  // The reviewed permission's session seed: kept out of React state and zeroed when the review ends.
  const reviewSeed = useRef<Uint8Array | null>(null);
  // True while the owner's wallet is open on the reviewed bytes (signRegistration).
  const signingReview = useRef(false);
  const discardReview = useCallback(() => { reviewSeed.current?.fill(0); reviewSeed.current = null; setReview(null); }, []);
  const request = useRef<{ key: string; id: string } | null>(null);
  const accountEpoch = useRef(0), inFlight = useRef(false);
  const statusRevision = useRef<number | null>(null);
  const identity = useRef(signer.did);
  identity.current = signer.did;
  const tokenSource = useRef(signer.getAccessToken);
  tokenSource.current = signer.getAccessToken;
  const api = useCallback(async <T,>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const requestedIdentity = identity.current;
    const requestedEpoch = accountEpoch.current;
    if (!requestedIdentity) throw new Error("Sign in before opening your Solana account.");
    const token = await tokenSource.current();
    if (requestedIdentity !== identity.current || requestedEpoch !== accountEpoch.current) throw new Error("Your signing account changed. Refresh before continuing.");
    if (!token) throw new Error("Your sign-in expired. Sign in again.");
    const result = await solanaRequestJson<T>(`/api/solana/${path}`, { signal,
      headers: { Authorization: `Bearer ${token}`, "X-Merrymen-Privy-Did": requestedIdentity, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    if (requestedIdentity !== identity.current || requestedEpoch !== accountEpoch.current) throw new Error("Your signing account changed. Refresh before continuing.");
    return result;
  }, []);
  /** Reads and shows the account; returns what it read, or null if the account changed meanwhile. */
  const load = useCallback(async (signal?: AbortSignal): Promise<Status | null> => {
    const epoch = accountEpoch.current;
    const next = await api<Status>("status", undefined, signal);
    if (epoch !== accountEpoch.current || signal?.aborted) return null;
    if (statusRevision.current !== null && statusRevision.current !== next.binding?.revision) { setPreview(null); discardReview(); }
    statusRevision.current = next.binding?.revision ?? null;
    setStatus(next); setOtherLogin(false);
    if (next.binding) {
      setMode(next.binding.requestedMode);
      if (next.binding.limits) {
        setPerTrade(display(next.binding.limits.perTradeUsdg)); setDaily(display(next.binding.limits.dailyUsdg));
        setOps(String(next.binding.limits.maxOpsPerDay)); setDrawdown(String(next.binding.limits.maxDrawdownBps / 100));
        if (next.binding.limits.perTradeWsol && next.binding.limits.dailyWsol) {
          setPerTradeSol(display(next.binding.limits.perTradeWsol, 9)); setDailySol(display(next.binding.limits.dailyWsol, 9));
        }
        const hours = hoursLeft(next.binding.limits.expiresAtMs);
        setDuration(hours); setSavedDuration(hours);
      } else setSavedDuration(null);
    }
    return next;
  }, [api, discardReview]);
  const refresh = useCallback(async (signal?: AbortSignal) => { await load(signal); }, [load]);
  /** The server's saved owner transaction, read afresh: which signed bytes it holds, and their outcome. */
  const readRecord = useCallback(async (): Promise<OwnerRecord> => {
    const next = await load();
    if (!next) throw new Error("Your signing account changed. Refresh before continuing.");
    return next.runtime?.live.ownerTransaction ?? null;
  }, [load]);
  useEffect(() => {
    accountEpoch.current++;
    setStatus(null); setError(""); setNotice(""); setOtherLogin(false); setDust(null); setConsent(false); setPreview(null); setReceipt(null); setRegistration(null); request.current = null; statusRevision.current = null;
    discardReview(); setReviewLapsed(false);
    if (!signer.authenticated) return;
    const abort = new AbortController();
    // The first read can be paced too (the status route allows a burst, then one read every few seconds): a wait, not a failure.
    void refresh(abort.signal).catch((e: unknown) => {
      if (abort.signal.aborted) return;
      if (otherSignIn(e)) { setOtherLogin(true); return; }
      const paced = pacedAnswer(e);
      if (paced !== null) setNotice(paced); else setError(e instanceof Error ? e.message : "Could not load your Solana account.");
    });
    return () => { accountEpoch.current++; abort.abort(); };
  }, [signer.did, signer.authenticated, refresh, discardReview]);
  const act = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    const epoch = accountEpoch.current;
    try { await fn(); } catch (e) {
      if (epoch !== accountEpoch.current) return;
      // Said once, in the wallet card, which then offers no wallet to create or verify.
      if (otherSignIn(e)) { setOtherLogin(true); return; }
      // Paced before anything ran: the server's own words say to wait. The page
      // keeps what it holds (a preview, signed bytes) for the next try.
      const paced = pacedAnswer(e);
      if (paced !== null) setNotice(paced);
      else setError(e instanceof Error ? e.message : "The Solana request did not finish. Refresh before retrying.");
    }
    finally { inFlight.current = false; setBusy(false); }
  };
  const binding = status?.binding;
  const sameWallet = !!binding && signer.address === binding.owner;
  // THE LIVE ROLLOUT, as status reports it. The server decides every case itself (the runtime refuses a live save, a
  // permission or a buy it does not admit); the page only says why and offers no live switch it would refuse.
  const liveAccess = status?.runtime?.liveAccess;
  // An account that went live (a registered permission or a live book) keeps live mode for its exits, as the server lets it.
  const wentLive = !!status?.runtime?.live.session || !!status?.runtime?.live.book;
  // Its permission expired or replaced on Solana, such an account cannot sell either: the server then says so (the _NO_PERMISSION
  // variants, never "exits still work"), and the page says the same.
  const saidByServer = (text: string) => !!status?.runtime?.live.blockers.includes(text);
  const paused = saidByServer(SOLANA_LIVE_PAUSED_NO_PERMISSION) ? SOLANA_LIVE_PAUSED_NO_PERMISSION : SOLANA_LIVE_PAUSED;
  const misconfigured = saidByServer(SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION) ? SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION : SOLANA_LIVE_ROLLOUT_MISCONFIGURED;
  const liveClosed = !liveAccess ? null : liveAccess.misconfigured ? misconfigured : !liveAccess.onList ? (wentLive ? paused : SOLANA_LIVE_NOT_OPEN) : null;
  // The caps a new live permission must fit: only while this account may register one.
  const liveCaps = !liveClosed && liveAccess?.caps ? liveAccess.caps : null;
  // Its registered permission allows more than the caps (the server says so, as a buys-only blocker): its live limits may keep
  // what the owner signed, so a re-save never narrows its exits. Only the server knows that permission's limits, so the page
  // leaves such a save to it (checkLiveSettings), and still asks for limits within the caps before a new permission.
  const signedAboveCaps = !!liveCaps && saidByServer(solanaLiveSessionAboveCaps(liveCaps));
  /**
   * Switching mode, limits the form shows only as the other mode started them (none saved, none typed) become the new mode's
   * starting limits. Paper starts at its own defaults (paper is never capped); live at the caps in force (status's liveAccess), or
   * the default caps from a server that reports none, so a first live save fits them. Saved or typed limits are never replaced;
   * the SOL sold limits, saved only with live mode, start at the caps beside saved paper limits too.
   */
  const chooseMode = (next: "paper" | "live") => {
    if (next !== mode) {
      const caps = liveAccess?.caps ?? SOLANA_LIVE_CAP_DEFAULTS;
      const live = { perTrade: display(caps.perTradeUsdg), daily: display(caps.dailyUsdg), perTradeSol: display(caps.perTradeWsol, 9), dailySol: display(caps.dailyWsol, 9) };
      const [from, to] = next === "live" ? [PAPER_DEFAULTS, live] : [live, PAPER_DEFAULTS];
      if (!binding?.limits && perTrade === from.perTrade && daily === from.daily) { setPerTrade(to.perTrade); setDaily(to.daily); }
      if (!binding?.limits?.perTradeWsol && perTradeSol === from.perTradeSol && dailySol === from.dailySol) { setPerTradeSol(to.perTradeSol); setDailySol(to.dailySol); }
    }
    setMode(next); setConsent(false); invalidate();
  };
  const policy = (): SolanaPaperLimits => {
    const maxOpsPerDay = Number(ops), maxDrawdownBps = Number(units(drawdown, 2)), hours = Number(duration);
    if (!Number.isInteger(maxOpsPerDay) || maxOpsPerDay < 1 || maxOpsPerDay > 96
      || !Number.isInteger(maxDrawdownBps) || maxDrawdownBps < 1 || maxDrawdownBps > 10_000
      || !Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("Choose 1–96 trades per day, a drawdown of 0.01–100%, and a duration up to 168 hours.");
    // Live sessions bound every sale by the SOL it puts in, not only the USDG it returns.
    const sell = mode === "live" ? { perTradeWsol: units(perTradeSol, 9), dailyWsol: units(dailySol, 9) } : {};
    if (sell.perTradeWsol && BigInt(sell.perTradeWsol) > BigInt(sell.dailyWsol)) throw new Error("The SOL sold per trade cannot exceed the SOL sold per 24 hours.");
    if (mode === "live" && BigInt(units(perTrade, 6)) < SOLANA_LIVE_MIN_TRADE_USDG_RAW) throw new Error(SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM);
    const limits = { perTradeUsdg: units(perTrade, 6), dailyUsdg: units(daily, 6), maxOpsPerDay, maxDrawdownBps, expiresAtMs: Date.now() + Math.floor(hours * 3_600_000), ...sell };
    // Above a live cap: refused here, in the server's own words, before anything is sent (unless the permission registered allows more).
    const capped = mode === "live" && liveCaps && !signedAboveCaps ? solanaLiveCapRefusal(limits, liveCaps, "save") : null;
    if (capped) throw new Error(capped);
    return limits;
  };
  /** The form shows exactly the saved mode and limits: nothing typed is waiting to be saved. */
  const formMatchesSaved = (): boolean => {
    const saved = binding?.limits;
    if (!binding || !saved || mode !== binding.requestedMode || duration !== savedDuration) return false;
    try {
      return units(perTrade, 6) === saved.perTradeUsdg && units(daily, 6) === saved.dailyUsdg && Number(ops) === saved.maxOpsPerDay
        && units(drawdown, 2) === String(saved.maxDrawdownBps)
        && (mode !== "live" || (units(perTradeSol, 9) === saved.perTradeWsol && units(dailySol, 9) === saved.dailyWsol));
    } catch { return false; }
  };
  /** Why a new permission cannot be registered with what the page shows, or null. */
  const registerBlock = (): string | null => {
    const saved = binding?.limits;
    if (liveClosed) return liveClosed;
    if (!saved) return "Save live mode and its limits before registering a trading permission.";
    if (liveCaps && solanaLiveCapsExceeded(saved, liveCaps).length) return solanaLiveSavedAboveCaps(liveCaps);
    if (saved.expiresAtMs <= Date.now()) return `Your saved limits expired at ${permissionExpiry(saved.expiresAtMs)}. Save new limits before registering.`;
    if (!saved.perTradeWsol || !saved.dailyWsol) return "Save how much SOL a live trade and a live day may sell before registering.";
    if (!formMatchesSaved()) return "The form has unsaved changes. A permission is always signed with your saved limits: save your changes, or refresh to discard them, before registering.";
    return null;
  };
  const invalidate = () => { setPreview(null); setReceipt(null); request.current = null; };
  // Re-render when the previewed quote expires, so its minimum stops being offered.
  useEffect(() => {
    if (!preview) return;
    const wait = preview.deadline - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setQuoteClock((tick) => tick + 1), wait + 1);
    return () => clearTimeout(timer);
  }, [preview]);
  const quoteFresh = !!preview && Date.now() < preview.deadline;
  // A reviewed permission not signed in time is discarded: its bytes would reach the server too late.
  // Not while the wallet is open on it: the owner may be signing, and the
  // server's own 60-second window decides those bytes (signRegistration).
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { if (signingReview.current) return; discardReview(); setReviewLapsed(true); }, Math.max(0, review.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [review, discardReview]);
  // The review says how long is left to sign: re-render it every second while it is open, so it counts down.
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => setReviewClock((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [review]);
  // A deposit address is shown only when the page derives the same one itself: the bound owner's
  // vault of a program its own pin trusts (pageTrustsVaultProgram), never the server's word alone.
  const depositProgram = status?.runtime?.live.programId ?? null, depositOwner = binding?.owner ?? null;
  useEffect(() => {
    let current = true;
    setDepositAccount(null);
    if (!depositProgram || !depositOwner || !pageTrustsVaultProgram(depositProgram)) return;
    void (async () => {
      const vault = await deriveSolanaVaultAddress(depositProgram, depositOwner);
      const account = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
      if (current) setDepositAccount(account);
    })().catch(() => undefined);
    return () => { current = false; };
  }, [depositProgram, depositOwner]);
  const previewTrade = async () => {
    const intent = tradeIntent(), key = request.current!.key;
    // Timed on this clock from before the request, so a skewed device clock
    // cannot stretch the quote's lifetime and latency only shortens it.
    const started = Date.now();
    let result: { preview: SolanaQuote | { quote: SolanaQuote } };
    try { result = await api<{ preview: SolanaQuote | { quote: SolanaQuote } }>("intent", { action: "preview", mode, intent }); }
    catch (e) { if (offerWholeLot(e, intent)) return; throw e; }
    const quote = "quote" in result.preview ? result.preview.quote : result.preview;
    if (quote.inputMint !== intent.inputMint || quote.outputMint !== intent.outputMint || quote.inAmount !== intent.amountRaw || !RAW.test(quote.minOutAmount)) throw new Error("The preview does not match this trade. Preview again.");
    const lifetime = Math.min(SOLANA_QUOTE_MAX_AGE_MS, Math.max(0, quote.expiresAtMs - quote.quotedAtMs));
    setPreview({ quote, key, deadline: started + lifetime, lifetime }); setReceipt(null);
  };
  const placeTrade = async () => {
    const intent = tradeIntent();
    // Only the quote the owner just saw, for exactly this trade: an expired or
    // different preview needs a new one before anything is sent.
    if (!preview || Date.now() >= preview.deadline || preview.key !== request.current?.key) {
      setPreview(null); throw new Error("This quote expired. Preview the trade again to see a current minimum before placing it.");
    }
    // Timed from before the request, as a preview is: latency only shortens a fresh minimum's window.
    const started = Date.now();
    let result: { receipt: Receipt };
    // The previewed minimum travels with the trade: the server refuses it, sending
    // nothing, when the fresh quote it would be placed at guarantees less.
    try { result = await api<{ receipt: Receipt }>("intent", { action: "trade", mode, intent: { ...intent, minOutAmount: preview.quote.minOutAmount } }); }
    catch (e) {
      if (offerWholeLot(e, intent)) { setPreview(null); return; }
      if (!(e instanceof RequestError) || e.status !== 409 || e.message !== SOLANA_PRICE_MOVED) throw e;
      // Refused before anything was signed, sent or recorded, and this minimum can
      // no longer be met: the stale preview goes, so it is never sent again. What
      // the fresh quote guaranteed (only a canonical amount below the refused
      // minimum) is offered for exactly this trade, for the preview's lifetime,
      // and placed only on the owner's click; if the price moves again, the
      // server refuses again. The floor stays exact: nothing is applied by itself.
      const fresh = e instanceof SolanaRequestError ? e.freshMinOutAmount : null;
      const offered = fresh !== null && BigInt(fresh) < BigInt(preview.quote.minOutAmount);
      setPreview(offered ? { quote: { ...preview.quote, minOutAmount: fresh }, key: preview.key, lifetime: preview.lifetime, deadline: started + preview.lifetime, movedFrom: preview.quote.minOutAmount } : null);
      if (!offered) setNotice(e.message);
      return;
    }
    setReceipt(result.receipt); await refresh();
  };
  const tokenLabel = (mint: string) => mint === SOLANA_USDG_MINT ? "USDG" : "wrapped SOL";
  const paperLots = status?.binding?.requestedMode === "paper" ? status.runtime?.paper?.positions ?? [] : [];
  /** The market's zero-output answer to selling exactly a whole paper lot: that lot is dust. */
  const zeroOutputFor = (e: unknown, sale: { mode: string; inputMint: string; outputMint: string; amountRaw: string }) => e instanceof RequestError && e.status === 400 && e.message === SOLANA_TOO_SMALL
    && sale.mode === "paper" && sale.outputMint === SOLANA_USDG_MINT ? paperLots.find((lot) => lot.mint === sale.inputMint && lot.amountRaw === sale.amountRaw) ?? null : null;
  /** A whole-lot sale the market answered with zero output: offer the lot for write-off instead of a "try a larger amount" it cannot follow. */
  const offerWholeLot = (e: unknown, sale: { mode: string; inputMint: string; outputMint: string; amountRaw: string }): boolean => {
    const lot = zeroOutputFor(e, sale);
    if (!lot) return false;
    setDust({ mint: lot.mint, amountRaw: lot.amountRaw, confirming: false });
    setNotice("No route buys back this whole lot, so it cannot be sold. Nothing was sent or recorded. You can write it off in your paper portfolio.");
    return true;
  };
  /** For a lot the trade form cannot sell: a preview of selling all of it, which records nothing. Only its zero-output answer offers the write-off. */
  const checkDust = async (lot: { mint: string; amountRaw: string }) => {
    const sale = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: crypto.randomUUID(), inputMint: lot.mint, outputMint: SOLANA_USDG_MINT,
      amountRaw: lot.amountRaw, slippageBps: SOLANA_WRITE_OFF_SLIPPAGE_BPS };
    try { await api("intent", { action: "preview", mode: "paper", intent: sale }); }
    catch (e) { if (offerWholeLot(e, sale)) return; throw e; }
    setDust(null); setNotice("A route still buys this whole lot back, so it is not dust and cannot be written off.");
  };
  /**
   * Books the confirmed dust lot at zero: the server checks the market's zero-output answer again first.
   *
   * Its 200 is final: the lot is gone and cannot come back. So the page says so,
   * and shows the book the answer carries, before it reads the status again. A
   * read that is paced (the status route answers 429 after a burst) or does not
   * arrive is reported after the success, never instead of it: the owner is
   * never told the write-off failed, nor shown the lot as still held.
   */
  const writeOffDust = async () => {
    const lot = dust;
    if (!lot?.confirming) throw new Error("Check the lot again before writing it off.");
    let answer: { paper?: unknown };
    try { answer = await api<{ paper?: unknown }>("paper/write-off", { mint: lot.mint }); }
    catch (e) {
      // A refusal ends the offer (the lot may not be dust, or changed); a paced request keeps it to try again.
      if (!(e instanceof RequestError && e.status === 429)) setDust(null);
      throw e;
    }
    const epoch = accountEpoch.current;
    setDust(null); showWrittenOff(answer.paper, lot.mint);
    const done = "The lot was written off at zero and removed from your paper portfolio.";
    setNotice(done);
    try { await refresh(); }
    catch (e) {
      if (epoch !== accountEpoch.current) return;
      setNotice(`${done} Your account could not be read again just now: ${e instanceof Error ? e.message : "the status did not load."}`);
    }
  };
  /**
   * Shows the paper book a write-off answered with: well formed, without the
   * lot, and no older than the book shown. Otherwise the shown book drops just
   * that lot, which is what the server's 200 says it removed (a write-off never
   * splits a lot); the next status read shows the server's book either way.
   */
  const showWrittenOff = (answered: unknown, mint: string) => {
    const book = writtenOffBook(answered, mint);
    setStatus((shown) => {
      const current = shown?.runtime?.paper;
      if (!shown?.runtime || !current) return shown;
      const fresh = !!book && !(typeof book.version === "number" && typeof current.version === "number" && book.version < current.version);
      const paper = fresh ? { ...current, ...book, trades: Array.isArray(book.trades) ? book.trades : current.trades }
        : { ...current, positions: current.positions.filter((position) => position.mint !== mint) };
      return { ...shown, runtime: { ...shown.runtime, paper: paper as SolanaPaperSnapshot } };
    });
  };
  /** What the recorded trade itself guaranteed, not the earlier preview. */
  const receiptAmounts = (trade: Receipt): string | null => {
    const out = trade.intent?.outputMint ?? (side === "buy" ? WSOL : SOLANA_USDG_MINT), decimals = out === SOLANA_USDG_MINT ? 6 : 9, label = tokenLabel(out);
    if (trade.mode === "paper" && trade.outputAmountRaw && RAW.test(trade.outputAmountRaw) && trade.quote?.minOutAmount && RAW.test(trade.quote.minOutAmount))
      return `Simulated output: ${display(trade.outputAmountRaw, decimals)} ${label}, against a quoted minimum of ${display(trade.quote.minOutAmount, decimals)} ${label}.`;
    if (trade.mode !== "paper" && trade.minOutAmount && RAW.test(trade.minOutAmount) && trade.quotedOutAmount && RAW.test(trade.quotedOutAmount))
      return `Quoted output: ${display(trade.quotedOutAmount, decimals)} ${label}. Minimum enforced on chain: ${display(trade.minOutAmount, decimals)} ${label}.`;
    return null;
  };
  const tradeIntent = () => {
    const amountRaw = units(amount, side === "buy" ? 6 : 9);
    const key = JSON.stringify([mode, side, amountRaw]);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    return { kind: "spl-swap", chain: CHAINS.solana, mode, requestId: request.current.id,
      inputMint: side === "buy" ? SOLANA_USDG_MINT : WSOL, outputMint: side === "buy" ? WSOL : SOLANA_USDG_MINT,
      amountRaw, slippageBps: 50 };
  };
  const bind = async () => {
    if (!signer.address) throw new Error("Wait for your Solana wallet to connect.");
    const owner = signer.address;
    const challenge = await api<{ nonce: string; message: string }>(`bind?owner=${encodeURIComponent(owner)}`);
    const signature = await signer.signBinding(challenge.message);
    await api("bind", { owner, nonce: challenge.nonce, signature }); await refresh();
  };
  /**
   * Step 1 of registering: the server prepares the permission for a fresh
   * session key, and the page decodes the bytes. Nothing is signed: the owner
   * reviews the limits and the priority fee they encode first (PermissionReview).
   */
  const prepareRegistration = async () => {
    if (!sameWallet || !binding) throw new Error("Connect the Solana wallet bound to this account.");
    // Exactly the saved limits shown in the live card; the server encodes the saved ones.
    const shown = binding.limits, programId = status?.runtime?.live.programId, blocked = registerBlock();
    if (blocked || !shown || !programId) throw new Error(blocked ?? "Wait for the vault program to be verified before registering.");
    // The program comes from the server; the page registers only for one its own pin trusts.
    if (!pageTrustsVaultProgram(programId)) throw new Error(SOLANA_UNRELEASED_PROGRAM);
    discardReview(); setReviewLapsed(false);
    const vault = await deriveSolanaVaultAddress(programId, binding.owner);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    try {
      const sessionPublicKey = base58Encode(ed25519.getPublicKey(seed));
      // Timed on this clock from before the request, so latency only shortens the window.
      const started = Date.now();
      const { setup } = await api<{ setup: PreparedPermission }>("setup", { stage: "prepare", sessionPublicKey });
      // The wallet only opens for bytes that encode what this page showed.
      const terms = checkPreparedPermission(setup, { owner: binding.owner, programId, vault, session: sessionPublicKey }, shown);
      reviewSeed.current = seed;
      setReview({ transactionBase64: setup.transactionBase64, limits: shown, terms, requiredLamports: setup.requiredLamports ?? null, ownerLamports: setup.ownerLamports ?? null,
        deadline: started + REVIEW_SIGN_WINDOW_MS });
    } finally { if (reviewSeed.current !== seed) seed.fill(0); }
  };
  /** Step 2: the owner signs exactly the reviewed bytes, then they are submitted and activated. */
  const signRegistration = async () => {
    const shown = review, seed = reviewSeed.current;
    if (!shown || !seed) throw new Error("Register again to prepare a permission to review.");
    if (Date.now() >= shown.deadline) {
      discardReview(); setReviewLapsed(true);
      throw new Error("This prepared permission was not signed in time, so it was discarded. Nothing was signed. Register again to prepare a new one.");
    }
    // Copied before the wallet opens, so a change of account that ends the
    // review (and zeroes its seed) cannot change the key being registered.
    const secret = base64(seed);
    // While the wallet is open the review timer leaves the review alone: the
    // page never says "nothing was signed" while the owner may be signing.
    // Signed bytes are submitted even if the deadline passed meanwhile: the
    // server's 60-second window decides, and its refusal of a first
    // submission discards them with an accurate message (submitRegistration).
    // A wallet that refuses or closes leaves the review in place to sign
    // again, unless its deadline passed meanwhile: then it lapses now.
    signingReview.current = true;
    let signature: Uint8Array;
    try { signature = await signer.signSetup(fromBase64(shown.transactionBase64)); }
    catch (e) {
      if (Date.now() >= shown.deadline) { discardReview(); setReviewLapsed(true); }
      throw e;
    } finally { signingReview.current = false; }
    const signed = base64(signature);
    const pending = { secret, signedTransactionBase64: signed, signature: signatureOf(signed), sent: false, limits: shown.limits };
    // Keep the bounded session seed and exact signed bytes before submit:
    // a lost response must retry this registration, never create a new one.
    setRegistration(pending); discardReview(); setReviewLapsed(false);
    await submitRegistration(pending);
  };
  /** Retries the signed registration this page holds. */
  const setupLive = async () => {
    if (!sameWallet || !binding) throw new Error("Connect the Solana wallet bound to this account.");
    const pending = registration;
    if (!pending) throw new Error("Register again to prepare a permission to review.");
    if (pending.limits.expiresAtMs <= Date.now()) {
      // The vault refuses to activate an expired permission, so its key can never be used.
      setRegistration(null);
      throw new Error(`This permission expired at ${permissionExpiry(pending.limits.expiresAtMs)} before it was activated, so its session key has been discarded. Register again to sign a new permission.`);
    }
    await submitRegistration(pending);
  };
  const submitRegistration = async (signedRegistration: NonNullable<typeof registration>) => {
    let pending = signedRegistration;
    // Submitting the saved bytes again is idempotent: the server reports the
    // outcome of the transaction it saved. A refusal of the first submission
    // that says this request saved nothing (savedNothing) proves the server
    // never saved them, so they and their seed are dropped. Any other refusal,
    // and every refused retry, is decided by the server's record, never
    // assumed to be "not accepted": the bytes may already be broadcast.
    let submitted: { signature: string; status: string };
    try {
      ({ registration: submitted } = await api<{ registration: { signature: string; status: string } }>("setup", { stage: "submit", signedTransactionBase64: pending.signedTransactionBase64 }));
    } catch (e) {
      if (!refusedByServer(e)) { setRegistration({ ...pending, sent: true }); throw e; }
      if (!pending.sent && savedNothing(e)) {
        setRegistration(null);
        throw new Error(`${e.message} The signed permission was not accepted, so it has been discarded and nothing was activated. Register again to review and sign a new permission.`);
      }
      const outcome = await outcomeAfterRefusal(readRecord, pending.signature);
      if (outcome === "unknown") {
        setRegistration({ ...pending, sent: true });
        throw new Error(`${e.message} ${pending.sent ? "An earlier submission of this signed permission may already be on Solana" : "The server could not say whether it saved this signed permission"}, so it and its session key were kept. Finish permission registration again shortly.`);
      }
      if (outcome === "pending") {
        setRegistration({ ...pending, sent: true });
        throw new Error(`${e.message} The server holds this signed permission and still records it as awaiting final confirmation, so its session key was kept. Finish permission registration again shortly.`);
      }
      if (outcome === "unheld") {
        // Resubmitting can never be checked or sent again; whether an earlier
        // submission landed is the server's status to show, not this page's guess.
        setRegistration(null);
        if (!pending.sent) throw new Error(`${e.message} The server holds no record of this signed permission, so it and its session key have been discarded. Register again to review and sign a new permission.`);
        throw new Error(`${e.message} The server holds no record of this signed permission, so it and its session key were cleared from this page. Refresh to check whether a permission is active, then register again if needed.`);
      }
      submitted = { signature: pending.signature!, status: outcome };
    }
    if (submitted.status === "failed") { setRegistration(null); throw new Error("The permission transaction failed. No session was activated. Register again to sign a new permission."); }
    pending = { ...pending, signature: submitted.signature, sent: true }; setRegistration(pending);
    if (submitted.status !== "finalized") throw new Error("The permission is awaiting final confirmation on Solana. Keep this page open and finish registration in a moment.");
    try { await api("setup", { stage: "activate", signature: pending.signature, sessionSecretKey: pending.secret }); }
    catch (e) {
      if (!refusedByServer(e)) throw e;
      // For good: a revocation landed after this permission was prepared, and epochs only rise, so it is
      // never activated. Keeping its session key would only offer a retry that cannot succeed.
      if (e instanceof RequestError && e.message === SOLANA_REGISTERED_AFTER_REVOKE) {
        setRegistration(null);
        throw new Error(`${e.message} Its session key has been discarded from this page.`);
      }
      // The server answers activation from its record of this permission and
      // the vault as its RPC sees it, which can lag the finalized permission.
      // The key is dropped only when the server no longer holds the permission.
      const outcome = await outcomeAfterRefusal(readRecord, pending.signature);
      if (outcome === "failed") { setRegistration(null); throw new Error("The permission transaction failed. No session was activated. Register again to sign a new permission."); }
      if (outcome === "unheld") {
        setRegistration(null);
        throw new Error(`${e.message} The server no longer holds this permission, so it cannot be activated and its session key has been discarded. Register again to sign a new permission.`);
      }
      throw new Error(`${e.message} This permission is confirmed on Solana but is not active yet, so its session key was kept. Finish permission registration again shortly.`);
    }
    setRegistration(null); await refresh();
  };
  const liveBook = status?.runtime?.live.book;
  // A vault the server has read, funded or registered: what an owner key backup protects.
  const live = status?.runtime?.live, vaultSeen = !!live && (!!live.balances || !!live.book || !!live.session);
  const programTrusted = !!live?.programId && pageTrustsVaultProgram(live.programId);
  // The recovery card: only a live binding whose vault the server has read,
  // never a paper binding, never before the status has loaded.
  // OWNER DECISION (the stricter option, as briefed): a paper binding gets no
  // card even when its account still has a live book or session from trading
  // live before. Its owner controls (revoke and withdraw) stay on this page
  // in paper mode. The alternative shows the card for a paper binding with a
  // live book or session (a vault funded while live keeps its funds after the
  // switch back): replace `binding.requestedMode === "live" && vaultSeen` with
  // `(binding.requestedMode === "live" ? vaultSeen : !!live.book || !!live.session)`
  // and update the test that pins it.
  const recoveryVault = !!binding && !!live?.vault && !!live.programId && binding.requestedMode === "live" && vaultSeen;
  // Off by default; only the bound owner of a vault the server has read.
  // OWNER DECISION: the whole card stays behind the key export flag, step 2's
  // `merrymen solana-recover` commands included, even the read-only plan.
  // Without an exported owner key there is nothing to sign with outside
  // Merrymen, so a default build names no recovery tool (owner controls say
  // so when a pending owner record cannot be settled). The alternative shows
  // step 2's read-only plan to every live owner and keeps only the Privy
  // export button (and the signing command) behind the flag. A hosted build
  // needs the flag as a Docker build argument (solana-glue-build's Dockerfile).
  const recoveryCard = ownerKeyExportEnabled() && sameWallet && recoveryVault && signer.address && live?.programId && live.vault
    ? { owner: signer.address, programId: live.programId, vault: live.vault } : null;
  if (!signer.authenticated) return <div className="solana-card"><p>Sign in with the same account you use for Robinhood Chain.</p><SignIn onDone={() => { void refresh().catch(() => undefined); }} /></div>;
  return <>
    {error && <p role="alert" className="solana-error">{error}</p>}
    {notice && <p role="status" className="solana-notice">{notice}</p>}
    <div className="solana-card"><h2>Wallet ownership</h2>
      {otherLogin && <p role="alert" className="solana-error">{SOLANA_OTHER_SIGN_IN}</p>}
      {binding ? <><p className="solana-address">{binding.owner}</p><p>{sameWallet ? "Verified wallet connected." : "Connect the exact embedded wallet shown above before signing a permission."}</p></>
        : !otherLogin && <><p>{signer.address ?? (signer.ready ? "Create your protected Solana wallet, then verify that it belongs to this account." : "Connecting your protected wallet…")}</p>
          <button disabled={busy || !signer.ready || signer.ambiguous} onClick={() => void act(signer.address ? bind : signer.create)}>{signer.address ? "Verify Solana wallet" : "Create Solana wallet"}</button>
          {signer.ambiguous && <p role="alert">Multiple embedded Solana wallets are connected. Select the intended owner before continuing.</p>}</>}
      <button className="solana-secondary" disabled={busy} onClick={() => void act(() => refresh())}>Refresh account</button>
    </div>
    {binding && <>
      <form className="solana-card" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        await api("settings", { mode, limits: policy(), revision: binding.revision, liveConsent: consent }); invalidate(); await refresh();
      }); }}><h2>Solana trading mode</h2>
        <fieldset disabled={busy}><legend>Choose how this account trades</legend>
          <label><input type="radio" name="solana-mode" checked={mode === "paper"} onChange={() => chooseMode("paper")} /> Paper · simulated funds</label>
          {/* No live switch while this account may not go live; one that went live keeps it for its exits, and a saved live mode stays shown. */}
          {(!liveClosed || wentLive || binding.requestedMode === "live") && <label><input type="radio" name="solana-mode" checked={mode === "live"} onChange={() => chooseMode("live")} /> Live · real funds</label>}
        </fieldset>
        {liveClosed && <p role="status">{liveClosed}</p>}
        <div className="solana-fields">
          <label>USDG per trade<input inputMode="decimal" value={perTrade} onChange={(e) => setPerTrade(e.target.value)} /></label>
          <label>USDG per 24 hours<input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} /></label>
          <label>Trades per 24 hours<input type="number" min="1" max="96" value={ops} onChange={(e) => setOps(e.target.value)} /></label>
          <label>Maximum drawdown (%)<input inputMode="decimal" value={drawdown} onChange={(e) => setDrawdown(e.target.value)} /></label>
          <label>Permission duration (hours)<input type="number" min="1" max="168" value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
          {mode === "live" && <>
            <label>SOL sold per trade<input inputMode="decimal" value={perTradeSol} onChange={(e) => setPerTradeSol(e.target.value)} /></label>
            <label>SOL sold per 24 hours<input inputMode="decimal" value={dailySol} onChange={(e) => setDailySol(e.target.value)} /></label>
          </>}
        </div>
        {mode === "live" && liveCaps && <p>Live limits on this platform are {solanaLiveCapsText(liveCaps)}.</p>}
        {mode === "live" && <p>Sales back to USDG count against these USDG limits as buys do, and against the SOL sold limits. So a buy is refused once it would leave too little of them to sell your whole SOL position within the same 24 hours: a day&apos;s buys stop at about half the USDG limit. Withdrawing is never limited.</p>}
        {mode === "live" && <p>Each live trade must be worth at least 1 USDG; only a sale of your whole SOL position may be smaller. Set at least 1 USDG per trade, and SOL sold per trade worth at least 1 USDG: registering checks it against the independent SOL price.</p>}
        {mode === "live" && <label><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I authorize real Solana trades within these limits after registering the permission with my wallet.</label>}
        <button disabled={busy || (mode === "live" && !consent)}>Save Solana mode and limits</button>
        <p>Saved preference: {binding.requestedMode}. A saved live preference becomes executable only after a verified wallet permission.</p>
      </form>
      {binding.requestedMode === "paper" ? <div className="solana-card"><h2>Paper portfolio</h2>
        {status?.runtime?.paper ? <><p className="solana-value">{display(status.runtime.paper.cashRaw)} USDG</p><p>Simulated cash. {status.runtime.paper.positions.length} open position(s).</p>
          {status.runtime.paper.positions.map((position) => {
            const label = position.mint === WSOL ? "Wrapped SOL" : position.mint, amountShown = display(position.amountRaw, position.decimals);
            const offered = dust && dust.mint === position.mint && dust.amountRaw === position.amountRaw ? dust : null;
            return <div key={position.mint}><p>{label}: {amountShown}
              {/* The trade form sells only wrapped SOL; any other lot can be checked for dust here. */}
              {position.mint !== WSOL && !offered && <> <button type="button" className="solana-secondary" disabled={busy} onClick={() => void act(() => checkDust(position))}>Check for write-off</button></>}</p>
              {offered && (offered.confirming
                ? <div className="solana-warning" role="group" aria-label="Confirm the write-off"><p>Write off this whole lot of {amountShown} {position.mint === WSOL ? "wrapped SOL" : "tokens"}? It is booked at zero: removed from your paper portfolio at no value, which frees its position slot. This cannot be undone.</p>
                  <button type="button" disabled={busy} onClick={() => void act(writeOffDust)}>Write off at zero</button>
                  <button type="button" className="solana-secondary" disabled={busy} onClick={() => setDust(null)}>Keep it</button></div>
                : <p>No route buys back this whole lot: the market quotes nothing for it, so it cannot be sold. <button type="button" disabled={busy} onClick={() => setDust({ ...offered, confirming: true })}>Write off…</button></p>)}</div>;
          })}
          {/* The check is a paper preview, which the server refuses once the book's limits (the saved ones) have expired; its write-off does not need them. */}
          {status.runtime.paper.positions.length > 0 && binding.limits && binding.limits.expiresAtMs <= Date.now()
            && <p role="status">Your saved limits expired at {permissionExpiry(binding.limits.expiresAtMs)}. Checking a lot for write-off previews selling all of it, which needs current limits: save new limits above, then check it.</p>}
          <p>Network fees and account rent are excluded from paper results.</p>
          {!!status.runtime.paper.trades?.length && <details><summary>Recent simulated trades</summary><ul>{status.runtime.paper.trades.slice(0, 20).map((trade) => <li key={trade.requestId}>{trade.side === "buy" ? "Buy" : "Sell"} · {trade.requestId} · simulated</li>)}</ul></details>}
          </> : <><label>Starting simulated USDG<input inputMode="decimal" value={initialCash} onChange={(e) => setInitialCash(e.target.value)} /></label>
            <button disabled={busy || !binding.limits} onClick={() => void act(async () => { await api("paper", { initialCashRaw: units(initialCash, 6) }); await refresh(); })}>Create paper portfolio</button></>}
      </div> : <div className="solana-card"><h2>Live permission</h2>
        <p>{status?.runtime?.live.ready ? "Registered permission ready." : "Live trading is not active yet."}</p>
        {binding.limits?.perTradeWsol && binding.limits.dailyWsol && <p>Sales are limited to {display(binding.limits.perTradeWsol, 9)} SOL per trade and {display(binding.limits.dailyWsol, 9)} SOL per 24 hours, whatever the price.</p>}
        {!!status?.runtime?.live.blockers.length && <ul aria-label="What stops live trading">{status.runtime.live.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}
        {!!live?.warnings?.length && <ul role="status" aria-label="Warnings" className="solana-warning">{live.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {live?.feePayer && Object.hasOwn(FEE_PAYER_LEVELS, live.feePayer.level) && <p>Shared network fee payer: {FEE_PAYER_LEVELS[live.feePayer.level]}{displaySolanaAmountOrNull(live.feePayer.lamports, 9) !== null && ` (${displaySolanaAmountOrNull(live.feePayer.lamports, 9)} SOL)`}. Merrymen pays your trades&apos; network fees from it; your owner wallet pays only for owner transactions.</p>}
        {status?.runtime?.live.vault && <p>Vault: <span className="solana-address">{status.runtime.live.vault}</span>{status.runtime.live.programId && <> · Program: <span className="solana-address">{status.runtime.live.programId}</span></>}</p>}
        {live?.programId && !programTrusted && <p role="status">{SOLANA_UNRELEASED_PROGRAM}</p>}
        {/* The deposit address only while this account may buy: a deposit is for buying, and while buying is paused (off the live
            list, a breaker, the settings differing) it could not be traded. Withdraw is offered either way. */}
        {status?.runtime?.live.cashTokenAccount && status.runtime.live.cashTokenAccount === depositAccount && status.runtime.live.canExit && (!status.runtime.live.ready || liveClosed)
          && <p>Buying is paused for this account, so no deposit address is shown: USDG sent now could not be traded. Exits, revoke and withdraw still work.</p>}
        {status?.runtime?.live.cashTokenAccount && status.runtime.live.cashTokenAccount === depositAccount && status.runtime.live.ready && !liveClosed && <div><h3>Fund the Solana vault</h3><p>Send USDG on Solana to this verified USDG token account:</p><p className="solana-address">{status.runtime.live.cashTokenAccount}</p><p>Deposit USDG only. Direct wrapped SOL deposits have no recorded cost basis and cannot be traded by this session.</p></div>}
        {status?.runtime?.live.balances && <><p className="solana-value">{display(status.runtime.live.balances.cashUsdg)} USDG</p><p>{display(status.runtime.live.balances.wsolRaw, 9)} wrapped SOL · observed at slot {status.runtime.live.balances.slot}</p></>}
        {liveBook && <p>Recorded realized P&amp;L: {display(liveBook.realizedPnlUsdgRaw)} USDG. Network fees: {display(liveBook.networkFeesLamports, 9)} SOL.</p>}
        {liveBook?.quarantinedWsolRaw && liveBook.quarantinedWsolRaw !== "0" && <p role="status">{display(liveBook.quarantinedWsolRaw, 9)} wrapped SOL arrived outside your recorded trades. It is held aside: never traded, never counted in performance, and you can withdraw it.</p>}
        {liveBook && (liveBook.unresolvedFeeCount ?? 0) > 0 && <p role="status">Network fees are incomplete for {liveBook.unresolvedFeeCount} expired submission(s). Their swaps are proven not executed; the recorded fee total excludes unknown fees. Reserved fee allowance: {display(liveBook.reservedUnknownFeeLamports ?? "0", 9)} SOL.</p>}
        {status?.runtime?.live.ownerTransaction && <p>Owner transaction: {status.runtime.live.ownerTransaction.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(status.runtime.live.ownerTransaction.signature)}`}>View owner transaction</a>
          {status.runtime.live.ownerTransaction.revoke && <> Revocation signed beside it: {status.runtime.live.ownerTransaction.revoke.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(status.runtime.live.ownerTransaction.revoke.signature)}`}>View revocation</a></>}</p>}
        {!!status?.runtime?.live.pending.length && <p role="status">{status.runtime.live.pending.length} trade(s) awaiting final confirmation. Refresh to reconcile the saved request.</p>}
        {!!status?.runtime?.live.history?.length && <details><summary>Recent live requests</summary><ul>{status.runtime.live.history.slice(0, 20).map((trade) => <li key={trade.requestId}>{trade.requestId}: {trade.status}{trade.signature && <> · <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(trade.signature)}`}>Transaction</a></>}</li>)}</ul></details>}
        <p>The initial live market is USDG ↔ wrapped SOL. Deposit only after the program and vault have been verified.</p>
        {registration ? <PermissionTerms heading="The permission you signed" limits={registration.limits} />
          : review ? <PermissionReview limits={review.limits} terms={review.terms} requiredLamports={review.requiredLamports} ownerLamports={review.ownerLamports}
            secondsLeft={Math.max(1, Math.round((review.deadline - Date.now()) / 1000))} />
          : binding.limits && <PermissionTerms heading="Your wallet will be asked to sign these saved limits" limits={binding.limits} />}
        {registration && <p>Keep this page open while finalization completes. Retry activation with the existing registration.</p>}
        {!registration && !review && reviewLapsed && <p role="status">The prepared permission was not signed in time, so it was discarded. Nothing was signed. Register again to prepare a new one.</p>}
        {!registration && binding.limits && registerBlock() && <p role="status">{registerBlock()}</p>}
        {!registration && review ? <>
          <button disabled={busy || !sameWallet || !!registerBlock()} onClick={() => void act(signRegistration)}>Sign permission with my wallet</button>
          <button className="solana-secondary" disabled={busy} onClick={discardReview}>Discard prepared permission</button></>
          : <button disabled={busy || !sameWallet || !binding.limits || !status?.runtime?.live.programId || (!registration && (!!registerBlock() || !programTrusted))} onClick={() => void act(registration ? setupLive : prepareRegistration)}>{registration ? "Finish permission registration" : "Register bounded trading permission"}</button>}
      </div>}
      <form className="solana-card" onSubmit={(event) => { event.preventDefault(); void act(previewTrade); }}><h2>USDG ↔ wrapped SOL</h2>
        <label>Direction<select disabled={busy} value={side} onChange={(e) => { setSide(e.target.value as "buy" | "sell"); invalidate(); }}><option value="buy">Buy wrapped SOL</option><option value="sell">Sell wrapped SOL</option></select></label>
        <label>{side === "buy" ? "USDG to spend" : "Wrapped SOL to sell"}<input disabled={busy} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); invalidate(); }} /></label>
        <p>Slippage limit: 0.5%. Saved mode: {binding.requestedMode}.</p>
        <button disabled={busy || !!receipt || mode !== binding.requestedMode || !binding.limits || (mode === "live" && !(side === "sell" ? status?.runtime?.live.canExit : status?.runtime?.live.ready))}>Preview trade</button>
        {preview && (receipt || quoteFresh ? <>{preview.movedFrom && !receipt
          ? <p role="status">The price moved, so nothing was sent. The current quote guarantees at least {display(preview.quote.minOutAmount, preview.quote.outputMint === SOLANA_USDG_MINT ? 6 : 9)} {tokenLabel(preview.quote.outputMint)}, below the {display(preview.movedFrom, preview.quote.outputMint === SOLANA_USDG_MINT ? 6 : 9)} {tokenLabel(preview.quote.outputMint)} you previewed. Place the same trade at this new minimum, or preview again.</p>
          : <p>Minimum received: {display(preview.quote.minOutAmount, preview.quote.outputMint === SOLANA_USDG_MINT ? 6 : 9)} {tokenLabel(preview.quote.outputMint)}.</p>}
          {!receipt && <p>This {preview.movedFrom ? "minimum" : "quote"} is valid for about {secondsUntil(preview.deadline)}. The trade is quoted again when placed, with the same 0.5% slippage limit; the receipt shows the minimum actually enforced.</p>}
          <button type="button" disabled={busy || !!receipt || !quoteFresh || mode !== binding.requestedMode} onClick={() => void act(placeTrade)}>{mode === "paper" ? "Simulate trade" : "Place live trade"}{preview.movedFrom ? " at the new minimum" : ""}</button></>
          : <p role="status">This quote expired. Preview again to see a current minimum before trading.</p>)}
        {receipt && <p role="status">{receipt.mode === "paper" ? "Simulated trade recorded." : `Live request recorded${receipt.status ? `: ${receipt.status}` : ""}.`} {receipt.signature && <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(receipt.signature)}`}>View transaction</a>}</p>}
        {receipt && receiptAmounts(receipt) && <p>{receiptAmounts(receipt)}</p>}
        {receipt && <button type="button" className="solana-secondary" disabled={busy} onClick={invalidate}>Start a new trade</button>}
      </form>
      <SolanaAutomation key={`strategy-${signer.did}`} binding={binding} api={api} refresh={refresh} workerOnline={status?.runtime?.automation?.workerOnline ?? false} />
      <SolanaOwnerActions key={`owner-${signer.did}`} available={sameWallet && !!status?.runtime?.live.programId} owner={sameWallet ? binding.owner : null} programId={live?.programId ?? null}
        api={api} sign={signer.signSetup} refresh={refresh} readRecord={readRecord}
        serverTransaction={live?.ownerTransaction ?? null} ownerWallet={live?.ownerWallet ?? null} recoverable={live?.recoverable ?? null}
        confirmationUnavailable={!!live?.blockers.includes(OWNER_CONFIRMATION_UNAVAILABLE)}
        recovery={recoveryCard ? (releasedProgramSha256(recoveryCard.programId) ? "send" : "plan") : null} />
      {recoveryCard && <SolanaRecovery key={`recovery-${signer.did}`} owner={recoveryCard.owner}
        programId={recoveryCard.programId} vault={recoveryCard.vault} exportKey={signer.exportKey} />}
    </>}
  </>;
}
