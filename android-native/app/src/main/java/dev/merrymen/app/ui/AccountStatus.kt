package dev.merrymen.app.ui

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.AgentGlance
import dev.merrymen.app.net.AgentImageKind
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.Position
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.TradeRecord
import dev.merrymen.app.net.putSettingsOnce
import java.math.RoundingMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * WHAT HOME AND YOU MAY SAY ABOUT THE READER'S OWN ACCOUNT — the rules, with no
 * Compose in them, so a JVM test runs every one.
 *
 * Every function here answers one question the two screens used to answer
 * inline, and every one of them used to answer it too confidently: whose book
 * this is, what it is worth, what it made, what stops it, and what it did. The
 * web keeps the same rules in account.ts, swaps.ts, agent-status.ts and
 * lib/live-blocker.ts; each port below names its source, and where the two
 * disagree the web is the one that is right.
 */

// ── whose book is on screen ────────────────────────────────────────────────

/**
 * THE FIVE THINGS THE OWNER'S FEED READ CAN AMOUNT TO, and only the last is a
 * book.
 *
 * /api/feed answers 200 with `source: "none"` in two cases the phone used to
 * draw as the reader's own agent: a hosted reader who is signed out (the route
 * has no tenant, so it sends the house fallback — "Robin", steady-basket, QQQ
 * NVDA TSLA) and a ledger that could not be opened. The web reads that shape as
 * UNREADABLE (live.ts readStateOf); the phone read it as data and printed a
 * balance hero and "Nothing held right now." over an account nobody had read.
 */
sealed interface OwnBook {
  data object Loading : OwnBook

  /** No answer, or a refusal: LoadedBlock says which, with its own words. */
  data class Failed(val state: Loaded<Nothing>) : OwnBook

  /**
   * Nobody is signed in, so there is no book to show. [canSignIn] is the
   * repository's canOfferSignIn: hosted and signed out. Self-hosted never
   * lands here — it has no sign-in, so "none" there is the ledger.
   */
  data class SignedOut(val canSignIn: Boolean) : OwnBook

  /** The server answered for this reader and could not read their ledger. */
  data object Unreadable : OwnBook

  /** A book the server read for this session. */
  data class Mine(val feed: Feed) : OwnBook
}

/**
 * Which of [OwnBook] a feed read is. [signedIn] and [hosted] are the
 * repository's, read at the moment of rendering, so a session that ended does
 * not keep a book on screen that the server would no longer send.
 */
fun ownBookOf(feed: Loaded<Feed>, signedIn: String?, hosted: Boolean?, canOfferSignIn: Boolean): OwnBook =
  when (feed) {
    is Loaded.Idle, is Loaded.Loading -> OwnBook.Loading
    is Loaded.Refused -> OwnBook.Failed(feed)
    is Loaded.Unreachable -> OwnBook.Failed(feed)
    is Loaded.Value -> when {
      feed.value.source != "none" -> OwnBook.Mine(feed.value)
      // SIGNED IN AND STILL "none" is the ledger failing us — never an empty
      // account. Self-hosted has no sign-in, so there "none" can only be that.
      signedIn != null || hosted == false -> OwnBook.Unreadable
      else -> OwnBook.SignedOut(canSignIn = canOfferSignIn)
    }
  }

/**
 * WHETHER TO ASK THE SESSION ROUTE WHO IS SIGNED IN, after one of the owner's
 * own reads came back — BEFORE its answer is drawn.
 *
 * A 401 is the obvious case. The one that hid is a read answered AS IF NOBODY
 * WERE SIGNED IN while this app still holds an address: hosted, the feed, the
 * grants and the settings routes all answer an ended session with a 200 —
 * source "none", {exists:false}, owner "" — and never with a 401. Nothing else
 * corrects a stale address (forget hooks do not run on an expiry, by design),
 * so Home said "Couldn't read your book" with a Try again that got the same
 * answer every time, You kept Sign out and Stop, and no screen offered the
 * sign-in the owner actually needed. /api/auth/session is safe to ask; if it
 * says nobody, repo.signedIn goes to null, every screen keyed on it starts
 * again, and the sign-in appears where there is one. If it still names the
 * wallet, the "nobody" answer really was the ledger failing, and says so.
 *
 * [answeredForNobody] is the read's own shape of "nobody"; self-hosted has no
 * session to have ended, so there it is never a reason to ask.
 */
fun sessionNeedsAsking(read: ApiResult<*>, answeredForNobody: Boolean, signedIn: String?, hosted: Boolean?): Boolean =
  when (read) {
    is ApiResult.Refused -> read.status == 401
    is ApiResult.Ok -> answeredForNobody && signedIn != null && hosted != false
    is ApiResult.Unreachable -> false
  }

// ── who may be offered what ────────────────────────────────────────────────

/**
 * THE THREE ACCOUNT CONTROLS ON YOU, and when each one is TRUE here.
 *
 * [signInBanner] only where a sign-in exists and nobody is in it
 * (canOfferSignIn): a self-hosted install has no sign-in, and a "Not signed
 * in — Sign in" banner there sent its operator to a page that does not apply.
 * [stop] for whoever the server acts for — a signed-in owner hosted, or the one
 * operator of a self-hosted box, whose DELETE /api/grants needs no session.
 * [signOut] only where there is a session to end.
 */
data class AccountControls(val signInBanner: Boolean, val stop: Boolean, val signOut: Boolean)

fun accountControlsOf(signedIn: String?, hosted: Boolean?, canOfferSignIn: Boolean): AccountControls =
  AccountControls(
    signInBanner = canOfferSignIn,
    stop = signedIn != null || hosted == false,
    signOut = signedIn != null,
  )

/** What the sign-in page may show, in the order it finds out. Only [Open] loads the web sign-in. */
enum class SignInPage {
  /** The stored server address has not been read yet. */
  ReadingOrigin,

  /** Self-hosted: there is no sign-in, and the page says so instead of opening a door to nowhere. */
  NoSignIn,

  /** The session route has not said whether this server is hosted, and is being asked. */
  Asking,

  /** It was asked and did not answer: nothing is opened, and Try again asks again. */
  CannotTell,

  /** Hosted: the web sign-in, in the WebView. */
  Open,
}

fun signInPageOf(originRead: Boolean, hosted: Boolean?, asked: Boolean): SignInPage = when {
  !originRead -> SignInPage.ReadingOrigin
  hosted == false -> SignInPage.NoSignIn
  hosted == null && !asked -> SignInPage.Asking
  hosted == null -> SignInPage.CannotTell
  else -> SignInPage.Open
}

/**
 * THE WELCOME PAGE'S TWO SIGN-IN DOORS, hidden only once the server has SAID it
 * is self-hosted. While it has not answered they stay, so the page can draw
 * before the network does; the sign-in page itself never opens the web flow
 * until the server says hosted ([signInPageOf]).
 */
fun welcomeOffersSignIn(hosted: Boolean?): Boolean = hosted != false

/**
 * THE AGENT'S NAME, ONLY WHEN SOMEBODY SET IT.
 *
 * `nameSource` is settings | ledger | fallback, and "fallback" is the house
 * default the route answers with when it could not read a name — every
 * signed-out reader gets "Robin" that way. Printing it as the reader's agent
 * is how a stranger was told their agent was called Robin. Null (an older
 * server that does not say) is not a vouch either. The caller shows "Your
 * agent" instead, which is the web's own word for a name it has not read.
 */
fun ownAgentName(agent: AgentGlance?): String? {
  val name = agent?.name?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return if (agent.nameSource == "settings" || agent.nameSource == "ledger") name else null
}

// ── the name chip ──────────────────────────────────────────────────────────

/** The name every agent has until its owner picks one (packages/core agent-name.ts). */
const val HOUSE_AGENT_NAME = "Robin"

/**
 * WHETHER TO OFFER "NAME YOUR AGENT" — NameChip.tsx's gate, exactly.
 *
 * Only the house name, only when it was READ as the name (settings or ledger),
 * and never once the owner said "Keep Robin" on this device. The fallback is
 * the dangerous case: the feed also answers "Robin" when it could not read the
 * store, so an agent its owner named "Shogun" would be offered a rename, and
 * one tap would overwrite Shogun.
 */
fun offersNameChip(agent: AgentGlance?, keptHere: Boolean): Boolean {
  if (keptHere || agent == null) return false
  if (agent.name != HOUSE_AGENT_NAME) return false
  return agent.nameSource == "settings" || agent.nameSource == "ledger"
}

// ── the mode chip and the heartbeat ────────────────────────────────────────

/**
 * LIVE, PAPER or IDLE, from the worker's own heartbeat (grants.mode). Nothing
 * for a mode nobody reported: an unread mode drawn as "IDLE" would tell a
 * trading owner their agent had stopped.
 */
fun modeChipOf(mode: String?): String? = when (mode) {
  "live" -> "LIVE"
  "paper" -> "PAPER"
  "idle" -> "IDLE"
  else -> null
}

/**
 * "Last heard 3m ago", from the heartbeat's epoch SECONDS. The web's own clock
 * steps (clock.ts elapsed): seconds under a minute, minutes under an hour,
 * hours under two days, then days. A heartbeat the device's clock puts in the
 * future is "just now", not a negative age. Null when never heard.
 */
fun lastHeardText(workerAliveAtSec: Long?, nowMs: Long): String? {
  val at = workerAliveAtSec ?: return null
  if (at <= 0) return null
  return "Last heard " + ago(at * 1000, nowMs)
}

/** clock.ts `elapsed`, with the words around it. */
internal fun ago(atMs: Long, nowMs: Long): String {
  val s = maxOf(0L, (nowMs - atMs) / 1000)
  if (s < 5) return "just now"
  if (s < 60) return "${s}s ago"
  val m = s / 60
  if (m < 60) return "${m}m ago"
  val h = m / 60
  if (h < 48) return "${h}h ago"
  return "${h / 24}d ago"
}

// ── what stops it trading for real ─────────────────────────────────────────

/**
 * What the account screen says about one blocker — web/src/lib/live-blocker.ts,
 * word for word, including the flags. [funding] is "sending money clears it",
 * [resign] "a fresh signature clears it", and [fault] whether anything is
 * actually wrong: a red panel telling a practising owner their agent is fine
 * is still a red panel.
 */
data class BlockerAdvice(val say: String, val funding: Boolean, val resign: Boolean, val fault: Boolean)

/**
 * THE CHILD'S VERDICT, NEVER A SECOND OPINION. `liveBlocker` is resolved by the
 * worker every tick; this only maps the name it chose onto a sentence. A rule
 * this build does not know returns null rather than a guess — a newer worker
 * talking to an older app, and advice invented for it would be worse than
 * silence. BlockerMirrorTest holds this map against the web's.
 */
fun blockerAdviceOf(rule: String?): BlockerAdvice? = if (rule.isNullOrBlank()) null else BLOCKER_ADVICE[rule]

internal val BLOCKER_ADVICE: Map<String, BlockerAdvice> = mapOf(
  "no-gas" to BlockerAdvice(
    "Your agent has no ETH, and every trade pays a network fee before it reaches the chain. Send a small amount of ETH to the same address — a few dollars covers a lot of trades.",
    funding = true, resign = false, fault = true,
  ),
  "no-cash" to BlockerAdvice(
    "Your agent has no USDG to trade with. Send USDG to the address below.",
    funding = true, resign = false, fault = true,
  ),
  "dead-policy" to BlockerAdvice(
    "This agent's trading permission was signed before a fix and cannot reach the chain. Re-signing it is free and takes a moment — adding funds will not help until you do.",
    funding = false, resign = true, fault = true,
  ),
  "wrong-chain" to BlockerAdvice(
    "This agent's permission is for a different network than the one trading happens on. It needs a new grant on Robinhood Chain; funds sent here will sit unused.",
    funding = false, resign = true, fault = true,
  ),
  "grant-too-wide" to BlockerAdvice(
    "This agent's permission set covers too many tokens and venues to install on-chain, so its first operation can never be signed. Re-signing with fewer of either is free and fixes it — adding funds will not, because nothing has been spent.",
    funding = false, resign = true, fault = true,
  ),
  "not-armed" to BlockerAdvice(
    "This agent's trading key is not active yet, so it has no permission to trade with. It arms itself on the next pass — nothing to send.",
    funding = false, resign = false, fault = false,
  ),
  "live-not-enabled" to BlockerAdvice(
    "Live trading is off, so this agent places no real orders. Nothing is wrong and nothing needs sending. Turn on Live trading in Settings when you want it to trade your real funds.",
    funding = false, resign = false, fault = false,
  ),
  "no-executor" to BlockerAdvice(
    "No bundler is configured on this deployment, so nothing can be submitted to the chain. That is ours to fix, not yours.",
    funding = false, resign = false, fault = true,
  ),
)

/** Where a blocker's button goes. Null means there is nothing for the owner to press. */
enum class BlockerFix(val label: String) {
  /** The deposit ceremony, a web handoff: the address and what to send. */
  Deposit("Add funds →"),
  /** The grant screen's re-sign, a web handoff: a signature is the fix. */
  Resign("Fix it — re-sign my permission →"),
  /** Settings, where the Live trading switch and its consent are. */
  StartLive("Start live trading →"),
}

/**
 * ASK THE ADVICE, DO NOT INFER FROM `funding` — Agent.tsx's own correction.
 * `no-executor` is ours to fix and must not offer a signature; `not-armed`
 * arms itself; `live-not-enabled` is a choice, and the only control that
 * changes it is the switch in Settings.
 */
fun blockerFixOf(rule: String?): BlockerFix? {
  val advice = blockerAdviceOf(rule) ?: return null
  return when {
    advice.resign -> BlockerFix.Resign
    advice.funding -> BlockerFix.Deposit
    rule == "live-not-enabled" -> BlockerFix.StartLive
    else -> null
  }
}

/** The rules a fresh signature clears — core autonomy.ts OWNER_ACTION. */
private val OWNER_ACTION = setOf("dead-policy", "grant-too-wide", "wrong-chain", "not-armed")

/**
 * DO NOT REPEAT A VERDICT ABOUT A KEY THE OWNER HAS ALREADY REPLACED.
 *
 * The worker's last beat predates the grant now stored: the blocker was
 * resolved against the old key, and asking for the signature the owner just
 * gave is how the same signature gets made three times (App.tsx
 * blockerPredatesGrant). Only the signature-cleared rules are gated — no-gas
 * and no-cash are not about the key. Both times are the route's epoch seconds,
 * compared as it sends them; a missing one is not evidence either way.
 */
fun blockerIsStale(g: GrantView): Boolean {
  val rule = g.liveBlocker ?: return false
  if (rule !in OWNER_ACTION) return false
  val beat = g.workerAliveAt ?: return false
  val grantedAt = ((g.grant as? JsonObject)?.get("grantedAt") as? JsonPrimitive)
    ?.takeIf { !it.isString }?.content?.toDoubleOrNull() ?: return false
  return grantedAt > beat
}

// ── money, said the web's way ──────────────────────────────────────────────

/** lib/format.ts `usd`: "$1,234.56", "-$3.10", and the em dash for no figure. */
fun accountUsd(v: Double?): String {
  if (v == null || !v.isFinite()) return "—"
  val body = String.format(Locale.US, "%,.2f", kotlin.math.abs(v))
  return (if (v < 0) "-$" else "$") + body
}

/** lib/format.ts `pctPts`: "+12.34%", "-5.00%", whole points past ±100. */
fun accountPct(p: Double?): String {
  if (p == null || !p.isFinite()) return "—"
  val places = if (p >= 100 || p <= -100) 0 else 2
  val body = String.format(Locale.US, "%,.${places}f", kotlin.math.abs(p)) + "%"
  return (if (p > 0) "+" else if (p < 0) "-" else "") + body
}

// ── positions ──────────────────────────────────────────────────────────────

/**
 * ONE ROW OF THE OWNER'S POSITIONS: the money always, and the % beside it only
 * when the cost behind it is one the ledger vouches for (account.ts
 * positionsOf and positionFigures).
 *
 * [detail] ALWAYS carries the value. The % goes beside it, never in its place:
 * "+20%" alone says how a position is doing and nothing about how much of the
 * owner's money is in it.
 */
data class PositionLine(val symbol: String, val detail: String, val pnlPct: Double?) {
  /** "+12.34%" or null — never "0%" for a return nobody could compute. */
  val pctText: String? get() = pnlPct?.takeIf { it.isFinite() }?.let { accountPct(it) }
  val down: Boolean get() = (pnlPct ?: 0.0) < 0
}

/**
 * account.ts positionsOf over /api/feed's positions, with live.ts mineOf's
 * cost reading in front of it.
 *
 * A cost of null, zero or less is "cost unknown" — never a free position whose
 * whole mark is profit. A cost the ledger booked from a pre-trade QUOTE
 * (cost_from_quote not an explicit false) is "cost unconfirmed" and gets no %,
 * because a precise return computed from an estimate is the estimate wearing a
 * figure. A stale mark keeps its value and says "last mark", and gets no % — an
 * old price's return beside nothing that says it is old. Positions worth
 * nothing are left off, as the web leaves them off.
 */
fun positionLinesOf(positions: List<Position>): List<PositionLine> =
  positions.filter { (it.valueUsdg ?: 0.0) > 0 }.map { p ->
    val value = p.valueUsdg!!
    val cost = p.costUsdg?.takeIf { it.isFinite() && it > 0 }
    val unconfirmed = cost != null && p.costFromQuote != false
    val pct = cost?.let { (value - it) / it * 100 }
    PositionLine(
      symbol = p.symbol,
      detail = accountUsd(value) +
        (if (p.priceStale) " · last mark" else "") +
        (if (cost == null) " · cost unknown" else if (unconfirmed) " · cost unconfirmed" else ""),
      pnlPct = if (!p.priceStale && !unconfirmed && pct != null && pct.isFinite()) pct else null,
    )
  }

// ── P&L ────────────────────────────────────────────────────────────────────

/** What the book made, and whether gas it could not price is still in it. */
data class PnlLine(val usd: Double, val pct: Double, val gasUnpriced: Int) {
  val text: String
    get() = (if (usd >= 0) "+" else "-") + accountUsd(kotlin.math.abs(usd)) + " (" + accountPct(pct) + ") all time" +
      if (gasUnpriced > 0) " · gas for $gasUnpriced ${if (gasUnpriced == 1) "trade" else "trades"} not priced" else ""
}

/**
 * EQUITY − CONTRIBUTIONS − GAS, ONLY WHERE EVERY TERM IS EVIDENCE — lib/rank-pnl.ts's gate.
 *
 * No return without a deposit on record (null contributions are not zero:
 * equity minus zero is the bankroll presented as profit), without a fill that
 * landed, without a newest mark, and without the worker vouching for the
 * contribution total (`contributionsKnown` true — false is inference, null is
 * nobody looked). And NOT OVER A PAPER BOOK: the equity curve is whichever book
 * ran last, and a simulated balance minus real deposits is a number about
 * nothing — so the heartbeat has to say "live". Gas the ledger could not price
 * makes the figure gross of that gas, and the line says so.
 *
 * THE GAP THIS CANNOT CLOSE FROM HERE. The heartbeat is the mode the worker is
 * running NOW; the newest equity mark is the book it valued LAST. For the part
 * of a tick after an owner turns Live trading on and before that tick writes
 * its first live mark, the two disagree, and a practice balance can pass this
 * gate as a live one. The feed route knows which book its newest mark is (its
 * `bookMode`) and does not send it. Comparing the mark's time with the beat's
 * does not settle it either: the worker beats at the TOP of every tick, before
 * it values anything (worker/src/index.ts, "BEAT FIRST"), so every live tick
 * has the same few seconds where the newest mark is older than the beat — that
 * rule would blank a true figure on every tick to catch one false one. The fix
 * is the feed saying `bookMode`, asked of the foundation; until then the web
 * (which has no mode gate at all) shows the same figure in that window.
 */
fun pnlLineOf(feed: Feed, mode: String?): PnlLine? {
  if (mode != "live") return null
  val contributed = feed.netContributionsUsdg?.takeIf { it.isFinite() && it > 0 } ?: return null
  if ((feed.landed ?: 0) <= 0) return null
  if (feed.contributionsKnown != true) return null
  val latest = feed.equityNow?.takeIf { it.isFinite() } ?: return null
  val gas = feed.gasUsdg?.takeIf { it.isFinite() } ?: return null
  val usd = latest - contributed - gas
  return PnlLine(usd = usd, pct = usd / contributed * 100, gasUnpriced = feed.gasUnpricedTrades ?: 0)
}

// ── what is in the account, on chain ───────────────────────────────────────

/**
 * USDG from the chain's own units (6 decimals), or null when the read failed.
 * "0" is a measured zero, and the only case where "Add funds" is true
 * (account-read.ts usdgOrNull).
 */
fun usdgFromUnits(raw: String?): Double? {
  val s = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return s.toBigDecimalOrNull()?.movePointLeft(6)?.toDouble()?.takeIf { it.isFinite() }
}

/** ETH from wei, to six places, trailing zeros dropped: "0.0042 ETH". Null when unread. */
fun ethFromWei(raw: String?): String? {
  val s = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val eth = s.toBigDecimalOrNull()?.movePointLeft(18) ?: return null
  val shown = eth.setScale(6, RoundingMode.DOWN).stripTrailingZeros()
  val plain = if (shown.signum() == 0) "0" else shown.toPlainString()
  return "$plain ETH"
}

/**
 * WHAT A BALANCE LINE SAYS: the figure, or "couldn't read" — never "$0.00" for
 * a read that did not come back, which told funded owners on a slow node to
 * add funds (grant-balances.ts).
 */
const val BALANCE_UNREAD = "couldn't read"

/**
 * THE VAULT FIGURE IN "IN THE ACCOUNT", ONLY FOR A LIVE BOOK.
 *
 * The chain read of the vault is a share count, not USDG, so the dollar figure
 * comes from the feed's newest equity mark — and on the paper rail that mark is
 * the PRACTICE ledger's (the worker values `balances` from the paper book there
 * and writes its vault into the mark). Drawn under the chain balances, right
 * after "Real funds, on chain", a paper owner with real Morpho shares read
 * "In vaults $0.00" as a fact about their real account. So: only when the
 * heartbeat says live, and nothing for paper, idle or an unread mode. The one
 * tick after a flip to live has the gap [pnlLineOf] describes.
 */
fun accountVaultUsdOf(g: GrantView?, feed: Feed): Double? {
  if (g == null || !g.exists || g.mode != "live") return null
  return feed.equity.lastOrNull()?.vaultUsdg?.takeIf { it.isFinite() }
}

// ── the owner's own tape ───────────────────────────────────────────────────

/** Where the owner's tape stops: desk-trades.ts DESK_TAPE_LIMIT. A tape this full may have been cut. */
const val OWN_TAPE_LIMIT = 30

/** A trade, or a move of cash that is not one — swaps.ts SwapOp. */
enum class TapeOp { Trade, VaultIn, VaultOut, Transfer, Other }

enum class TapeStatus { Filled, Pending, Refused, Reverted }

/** How a row that is not a trade is named: its pill, and the line in place of a coin (swaps.ts OP_WORDS). */
fun tapeOpWords(op: TapeOp): Pair<String, String>? = when (op) {
  TapeOp.Trade -> null
  TapeOp.VaultIn -> "Vault" to "Moved to a vault"
  TapeOp.VaultOut -> "Vault" to "Taken back from a vault"
  TapeOp.Transfer -> "Transfer" to "Sent out of the account"
  TapeOp.Other -> "Other" to "Not a trade"
}

/**
 * One operation on the owner's tape — swaps.ts SwapRow, from /api/feed's
 * trades. [side] is null when nothing recorded which way it went: a "Swap",
 * never a guess. [at] is epoch seconds, null when unread. [realizedUsd] is
 * only ever a vouched figure on a filled sell. [reason] is the wall's refusal
 * in words; [why] is the decision's own reason, which the route sends to the
 * owner only.
 */
data class TapeRow(
  val op: TapeOp,
  val side: String?,
  val status: TapeStatus,
  val symbol: String?,
  val displayName: String?,
  val at: Long?,
  val paper: Boolean,
  val sizeUsdg: Double?,
  val realizedUsd: Double?,
  val reason: String?,
  val why: String?,
) {
  val pill: String get() = when (side) { "buy" -> "Buy"; "sell" -> "Sell"; else -> "Swap" }

  /** A size only where it is a real one: the owner's own desk, and never a measured zero. */
  val sizeText: String? get() = sizeUsdg?.takeIf { it.isFinite() && it > 0 }?.let { accountUsd(it) }

  /** A sell's realized dollars, only when the tape vouched for them (swaps.ts pnlChip). */
  val realizedText: String?
    get() = realizedUsd?.takeIf { side == "sell" && it.isFinite() }
      ?.let { (if (it >= 0) "+" else "−") + accountUsd(kotlin.math.abs(it)) }
}

/** The worker's trade kinds: the intents that buy or sell something (swaps.ts TRADE_KINDS). */
private val TRADE_KINDS = setOf("swap", "curve-trade", "equity-order")

internal fun opOfKind(kind: String?): TapeOp = when {
  kind == null -> TapeOp.Other
  kind in TRADE_KINDS -> TapeOp.Trade
  kind == "vault-deposit" -> TapeOp.VaultIn
  kind == "vault-withdraw" -> TapeOp.VaultOut
  kind == "transfer" -> TapeOp.Transfer
  else -> TapeOp.Other
}

/**
 * WHAT HAPPENED TO IT, AS AN ALLOW-LIST (live.ts tradeOutcome). `trades.status`
 * is written 'submitted' while an operation is in flight, and a negation
 * reported those as filled. A paper fill is filled — on paper, and the row
 * says Paper.
 */
internal fun statusOf(status: String?): TapeStatus = when (status) {
  "landed", "paper" -> TapeStatus.Filled
  "rejected" -> TapeStatus.Refused
  "reverted" -> TapeStatus.Reverted
  else -> TapeStatus.Pending
}

/** live.ts recordedSymbol: a ticker-shaped symbol, never an address and never markup. */
internal fun recordedSymbol(raw: String?): String? =
  raw?.takeIf { Regex("^[A-Za-z0-9$._-]{1,32}$").matches(it) && !it.startsWith("0x", ignoreCase = true) }

/**
 * A coin names itself on chain, so its name is ADMITTED rather than echoed
 * (swaps.ts admitName): printable, short, not an address, and not the symbol
 * again.
 */
internal fun admitName(raw: String?, symbol: String?): String? {
  val named = raw?.trim().orEmpty()
  if (named.isEmpty() || named.length > 64) return null
  if (named.any { it.code < 0x20 || it.code == 0x7f }) return null
  if (named.startsWith("0x", ignoreCase = true)) return null
  return if (symbol != null && named.equals(symbol, ignoreCase = true)) null else named
}

/**
 * The ledger's "2026-09-24 12:00:00" (UTC, lib/ledger.ts fmtEpoch) as epoch
 * seconds. Null when it will not parse — the web's version returns 0 there,
 * which dates a row to 1970; no age is the honest answer.
 */
internal fun ledgerSeconds(raw: String?): Long? {
  val s = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val iso = if (s.contains(' ') && !s.contains('T')) s.replace(' ', 'T') + (if (s.endsWith("Z")) "" else "Z") else s
  return try {
    Instant.parse(iso).epochSecond
  } catch (e: Exception) {
    null
  }
}

/**
 * THE OWNER'S TAPE, from /api/feed's trades (live.ts mineOf, then swaps.ts
 * swapRowsOfDesk).
 *
 * The side is the ledger's own word: the fill's side, else the side the
 * decision asked for (a refusal filled nothing and still had one). The web
 * then matches the pair against its stock table; this client has no copy of
 * that table, so a row neither names is kept as a "Swap" rather than guessed.
 * A refusal's reason is the reject-rule's sentence ([rejectRuleLabel]), else the
 * rule itself — the owner's own tape, where a name is more use than silence.
 */
fun tapeRowsOf(trades: List<TradeRecord>): List<TapeRow> = trades.map { t ->
  val status = statusOf(t.status)
  val side = when {
    t.fillSide == "buy" || t.fillSide == "sell" -> t.fillSide
    t.action == "buy" || t.action == "sell" -> t.action
    else -> null
  }
  val symbol = recordedSymbol(t.symbol)
  val realized = t.realizedPnlUsdg?.takeIf { it.isFinite() }
  TapeRow(
    op = opOfKind(t.kind),
    side = side,
    status = status,
    symbol = symbol,
    displayName = admitName(t.displayName, symbol),
    at = ledgerSeconds(t.createdAt),
    paper = t.status == "paper",
    sizeUsdg = t.amountUsdg,
    realizedUsd = if (side == "sell" && status == TapeStatus.Filled && t.realizedVouched == true) realized else null,
    reason = if (status == TapeStatus.Refused || status == TapeStatus.Reverted) {
      rejectRuleLabel(t.rejectRule) ?: t.rejectRule?.takeIf { it.isNotBlank() }
    } else {
      null
    },
    why = t.reason?.trim()?.takeIf { it.isNotEmpty() },
  )
}

/** One line of the tape as drawn: a row, or every refusal of one reason folded where the newest sits. */
sealed interface TapeItem {
  data class Row(val row: TapeRow) : TapeItem

  /**
   * [cutAt] is where the tape was CUT (its oldest row, epoch seconds) when it
   * came back full; anything older was never read, so a count reaching back
   * past it is a floor.
   */
  data class Tried(
    val status: TapeStatus,
    val count: Int,
    val reason: String?,
    val newestAt: Long?,
    val oldestAt: Long?,
    val cutAt: Long?,
  ) : TapeItem
}

/**
 * NEWEST FIRST, WITH EVERY REFUSAL OF ONE REASON FOLDED INTO ONE LINE — swaps.ts
 * swapItems.
 *
 * Thirty ops-cap refusals used to push the owner's actual fills off the screen.
 * They are still all here and still all say why — hiding a refusal from its
 * owner is the one thing this may not do — just not thirty times. Folded by
 * reason across the whole tape, not only when consecutive: the web's rule.
 */
fun tapeItemsOf(rows: List<TapeRow>, tapeFull: Boolean): List<TapeItem> {
  val cutAt = if (tapeFull) rows.mapNotNull { it.at }.minOrNull() else null
  val sorted = rows.sortedByDescending { it.at ?: Long.MIN_VALUE }
  val out = mutableListOf<TapeItem>()
  val groups = LinkedHashMap<String, Int>()
  for (r in sorted) {
    if (r.status != TapeStatus.Refused && r.status != TapeStatus.Reverted) {
      out += TapeItem.Row(r)
      continue
    }
    val key = r.status.name + "|" + (r.reason ?: "")
    val at = groups[key]
    if (at == null) {
      groups[key] = out.size
      out += TapeItem.Tried(r.status, 1, r.reason, r.at, r.at, cutAt)
    } else {
      val g = out[at] as TapeItem.Tried
      val oldest = when {
        r.at == null -> g.oldestAt
        g.oldestAt == null || r.at < g.oldestAt -> r.at
        else -> g.oldestAt
      }
      out[at] = g.copy(count = g.count + 1, oldestAt = oldest)
    }
  }
  return out
}

/**
 * "Refused 12× today: past today's number of trades" — swaps.ts triedLine.
 *
 * THE SPAN IS READ OFF THE ROWS: "today" only when the oldest of them fell on
 * the reader's own calendar day, else "since <day>". AND THE COUNT IS EXACT
 * ONLY IF THE TAPE REACHES BACK PAST THAT SPAN: a tape cut at 10:00 this
 * morning cannot know about 09:00, so it says "12+×".
 */
fun triedLine(item: TapeItem.Tried, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
  val verb = if (item.status == TapeStatus.Reverted) "Reverted on chain" else "Refused"
  val todayStart = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().atStartOfDay(zone).toEpochSecond()
  val oldest = item.oldestAt
  val spanStart = when {
    oldest == null -> null
    oldest >= todayStart -> todayStart
    else -> Instant.ofEpochSecond(oldest).atZone(zone).toLocalDate().atStartOfDay(zone).toEpochSecond()
  }
  val span = when {
    oldest == null -> ""
    oldest >= todayStart -> " today"
    else -> " since " + DAY.format(Instant.ofEpochSecond(oldest).atZone(zone))
  }
  val floor = item.cutAt != null && (spanStart == null || item.cutAt >= spanStart)
  return "$verb ${item.count}${if (floor) "+" else ""}×$span" + (item.reason?.let { ": $it" } ?: "")
}

private val DAY = DateTimeFormatter.ofPattern("MMM d", Locale.US)

/**
 * WHAT THE WALL SAID, in words — worker/src/thesis-policy.ts rejectRuleLabel,
 * the same map the public tape renders, so the owner's desk and a stranger's
 * feed cannot disagree about one refusal. Null outside the set; the caller
 * decides whether a raw rule is shown instead. RejectLabelMirrorTest holds this
 * against the worker's map.
 */
fun rejectRuleLabel(rule: String?): String? = if (rule == null) null else REJECT_LABELS[rule]

internal val REJECT_LABELS: Map<String, String> = mapOf(
  "per-trade-cap" to "past the per-trade cap",
  "deposit-cap" to "past the per-trade cap, which a vault deposit is measured against too",
  "daily-cap" to "past today's spending cap",
  "ops-cap" to "past today's number of trades",
  "drawdown-breaker" to "the drawdown breaker was tripped",
  "asset-allowlist" to "that asset is not in its signed permissions",
  "target-allowlist" to "that venue is not in its signed permissions",
  "transfer-recipient-allowlist" to "that recipient is not in its signed permissions",
  "no-gas" to "the account had no gas",
  "no-route" to "no route to trade it",
  "no-quote" to "no price could be quoted",
  "no-liquidity" to "not enough liquidity to fill",
  "slippage" to "the price moved too far between quote and fill",
  "insufficient-balance" to "it did not hold what it tried to spend",
  "curve-graduated" to "that launch had already graduated",
  "no-curve-adapter" to "this grant carries no adapter for that launchpad",
  "curve-provenance" to "the launch could not be verified",
  "no-exit" to "its signed permission cannot sell that token, so the buy was refused before anything was sent",
  "not-armed" to "it has no signed trading key yet",
  "dead-policy" to "its signature seals a policy contract that is not on this chain",
  "grant-too-wide" to "its permission set is too wide to install on-chain",
  "no-executor" to "no bundler is configured to submit anything",
  "live-not-enabled" to "its owner has not turned on live trading, so it places no real orders",
  "wrong-chain" to "its key was signed for a different network",
  "no-cash" to "the account held no USDG to trade with",
)

// ── Telegram and Trencher, as a reading ────────────────────────────────────

/**
 * WHAT WE KNOW ABOUT THE TELEGRAM BRIDGE — agent-status.ts telegramRow.
 *
 * UNREAD IS NOT AN ANSWER. A failed /api/telegram used to fall through to "no
 * token" on the web's settings screen: a measured absence printed for a read
 * that never came back. Everything past [Unread] is a measurement.
 */
sealed interface TelegramRow {
  data object Unread : TelegramRow
  data object NoToken : TelegramRow
  /** A token is saved but the master switch is off, so nothing is listening. */
  data object Off : TelegramRow
  /** Token saved; Telegram has not confirmed it. */
  data object Unverified : TelegramRow
  /** The bot is real and reachable, but nobody has claimed it. A null code is a wait, not an absence. */
  data class Unlinked(val linkCode: String?, val botUsername: String?) : TelegramRow
  data class Linked(val botUsername: String?, val chats: Int) : TelegramRow
}

fun telegramRowOf(tg: TelegramStatus?): TelegramRow = when {
  tg == null -> TelegramRow.Unread
  !tg.hasToken -> TelegramRow.NoToken
  // Before `connected`, deliberately: a switched-off bridge with a good token
  // is not "unverified", and telling somebody to check their token when the
  // real problem is a checkbox wastes their afternoon.
  !tg.enabled -> TelegramRow.Off
  !tg.connected -> TelegramRow.Unverified
  // ownerId is the only proof anybody has claimed the bot.
  tg.ownerId == null -> TelegramRow.Unlinked(tg.linkCode, tg.botUsername)
  else -> TelegramRow.Linked(tg.botUsername, tg.allowlist.size)
}

/** The strip's words for it (en.ts strip.tg.*). */
fun telegramStripValue(row: TelegramRow): String = when (row) {
  TelegramRow.Unread -> "checking…"
  TelegramRow.NoToken -> "not set up"
  TelegramRow.Off -> "token saved, but switched off"
  TelegramRow.Unverified -> "token saved, not verified yet"
  is TelegramRow.Unlinked -> if (row.linkCode != null) "ready to connect" else "starting up"
  is TelegramRow.Linked -> row.botUsername?.let { "connected as @$it" } ?: "connected"
}

/**
 * A t.me link that CARRIES the code into the chat — only when both halves have
 * the shape Telegram gives them. A username or a code with anything else in it
 * is not built into a link; the owner still gets the code to type.
 */
fun telegramStartUrl(botUsername: String?, linkCode: String?): String? {
  val bot = botUsername?.takeIf { Regex("^[A-Za-z0-9_]{3,64}$").matches(it) } ?: return null
  val code = linkCode?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) } ?: return null
  return "https://t.me/$bot?start=$code"
}

/**
 * WHAT THE TRENCHER RAIL IS SET TO DO — agent-status.ts trencherRow. A reading
 * of the SETTINGS, not of what the agent is doing, and the copy says so.
 */
enum class TrencherRow(val value: String) {
  Unread("checking…"),
  Off("not your strategy"),
  /** Chosen, but asset mode is stocks, so no coin can ever be considered — the refusal nothing else shows. */
  NoCrypto("on, but your asset mode is stocks only — no coins can be considered"),
  Paper("on, practice money only"),
  Live("on, trading real money"),
}

fun trencherRowOf(strategy: String?, trencherLiveEnabled: Boolean?, assetMode: String?, read: Boolean): TrencherRow = when {
  !read -> TrencherRow.Unread
  strategy != "trencher" -> TrencherRow.Off
  assetMode == "stocks" -> TrencherRow.NoCrypto
  trencherLiveEnabled == true -> TrencherRow.Live
  else -> TrencherRow.Paper
}


// ── pictures ───────────────────────────────────────────────────────────────

/**
 * THE NEWEST VERSION OF EACH AGENT PICTURE THIS APP HAS WRITTEN — agent-image-state.ts.
 *
 * Only successful server writes are published: the version is the route's own
 * cache-buster, so every image of that agent on screen re-reads the stored
 * picture instead of an HTTP cache's copy. A null version means removed. Keyed
 * by the agent's public slug, which is no wallet's secret, so it is not a
 * forget hook's business. The face renderer reads this too once it is the
 * one drawing faces on these screens.
 */
object AgentImageRevisions {
  private val state = MutableStateFlow<Map<String, String?>>(emptyMap())
  val versions: StateFlow<Map<String, String?>> = state.asStateFlow()

  fun key(slug: String, kind: AgentImageKind): String = slug.lowercase(Locale.ROOT) + ":" + kind.wire

  fun publish(slug: String, kind: AgentImageKind, version: String?) {
    state.value = state.value + (key(slug, kind) to version)
  }
}

// ── naming the agent ───────────────────────────────────────────────────────

/** What became of "Choose my own": named, or a sentence saying why nothing changed (or might have). */
sealed interface NameSave {
  data class Named(val name: String) : NameSave
  data class Said(val text: String) : NameSave
}

/**
 * NAME THE OWNER'S AGENT — a settings write, bound to [readFor], the wallet the
 * page was read for, exactly as the Settings form binds its save.
 *
 * Hosted with no [readFor] the page does not know whose agent it is, and
 * nothing is sent. Self-hosted there is no session and no owner to send. The
 * route's own name rule is shown verbatim when it refuses; a key it ignored is
 * not "Named"; and a lost answer is looked up in the feed — which says what
 * the agent is called now — never sent again.
 */
suspend fun MerrymenApi.saveOwnAgentName(typed: String, readFor: String?, hosted: Boolean?): NameSave {
  val name = typed.trim()
  if (name.isEmpty()) return NameSave.Said("Type a name first.")
  if (hosted != false && readFor == null) {
    return NameSave.Said("Couldn't tell whose agent this is, so nothing was sent. Reload and try again.")
  }
  val owner = if (hosted == false) null else readFor
  return when (val o = settingsSaveOutcome(putSettingsOnce(JsonObject(mapOf("agentName" to JsonPrimitive(name))), owner))) {
    is SettingsSaveOutcome.Saved ->
      if ("agentName" in o.notSaved) NameSave.Said("This server didn't take the name, so nothing changed.")
      else NameSave.Named(name)
    // The route's own rule, verbatim ("name: …").
    is SettingsSaveOutcome.Rejected -> NameSave.Said(o.lines.joinToString("\n"))
    SettingsSaveOutcome.OwnerChanged -> NameSave.Said(SETTINGS_OWNER_CHANGED)
    SettingsSaveOutcome.SignIn -> NameSave.Said("Sign in to name your agent. Nothing was saved.")
    is SettingsSaveOutcome.Failed -> NameSave.Said(o.message)
    is SettingsSaveOutcome.Unknown -> {
      val now = (feed() as? ApiResult.Ok)?.value?.agent
      if (now?.name == name && (now.nameSource == "settings" || now.nameSource == "ledger")) {
        NameSave.Named(name)
      } else {
        NameSave.Said("Couldn't tell whether the name saved — ${o.why}, and it isn't showing yet. Look again in a moment before trying again.")
      }
    }
  }
}
