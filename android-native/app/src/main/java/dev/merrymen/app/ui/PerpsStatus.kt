package dev.merrymen.app.ui

import dev.merrymen.app.net.GRANTS_PERPS_NOT_SENT
import dev.merrymen.app.net.GRANT_PERP_LIGHTER
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.PerpsReport
import dev.merrymen.app.net.PerpsReportPosition
import dev.merrymen.app.net.perpsReportOf
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * THE AGENT'S PERPETUALS, AS THE PHONE MAY SPEAK OF THEM (docs/perps.md,
 * Surfaces → Mobile; the product review's mobile-no-positions-while-leveraged)
 * — the rules, with no Compose in them, so a JVM test runs every one.
 *
 * The worker writes `agents.perps` and GET /api/grants carries it as `perps`.
 * The whole point of reading it is one sentence the app must never say
 * wrongly: that nothing is held. A phone owner with open 10x positions used to
 * see "No positions reported yet." — /api/feed's positions are the SPOT book,
 * and perps never enter it (rule 11) — and nothing on the kill switch said
 * margin was still on Lighter.
 *
 * Three things are decided here: the state (none, unread or known), the banner
 * that cannot be dismissed while it is not none, and the custody words a kill
 * may use. Where this and core disagree, core is right (perps.ts
 * parsePerpsReport, custodySentence); the custody reading follows the web's own
 * port of the same report (web/src/lib/perps-view.ts perpExposureOfReport,
 * killWarning). The iOS twin is ios-native/Policy MerrymenPolicy PerpsStatus.
 */

/** What the screens show. */
sealed interface PerpsState {
  /** Nothing is, or can be, on Lighter: no banner, and the old copy stands. */
  data object None : PerpsState

  /**
   * The report could not be read. NEVER NONE: an unread venue may hold
   * positions. [recorded] is how many positions the agent's own ledger lists
   * (the worker reports those with every venue figure null); [paper] labels a
   * practice book as practice.
   */
  data class Unread(val paper: Boolean, val recorded: Int, val incident: Boolean) : PerpsState

  /** A report with its venue figures present. */
  data class Known(val k: PerpsKnown) : PerpsState
}

/**
 * core `PerpExposure`, as far as a report can state it: what a kill may say
 * about the REAL money at Lighter. Not the screens' question — a practice book
 * says nothing about a real venue account, and a read too old to describe now
 * describes nothing.
 */
sealed interface PerpsCustody {
  data object None : PerpsCustody
  data object Unread : PerpsCustody

  /**
   * Every position the report counts, and the USDG it puts at or in transit
   * to or from Lighter — both sit in Lighter's settlement contract, so both
   * are "still on Lighter".
   */
  data class Known(val positions: Int, val collateralMicro: BigInteger) : PerpsCustody
}

/**
 * [standsDownOnKill]: GET /api/grants `perpsStanddownOnKill` — whether THIS
 * server advertises its shutdown executor. False unless the server says true;
 * a supported request can still leave residual custody.
 */
data class PerpsStatus(val state: PerpsState, val custody: PerpsCustody, val standsDownOnKill: Boolean = false) {
  companion object {
    val NONE = PerpsStatus(PerpsState.None, PerpsCustody.None)
  }
}

data class PerpsKnown(
  val paper: Boolean,
  val positions: List<PerpsReportPosition>,
  val openNotionalMicro: BigInteger,
  val collateralMicro: BigInteger,
  val inTransitMicro: BigInteger,
  val minLiqDistanceBps: Double?,
  val stopsMissing: Int,
  val incident: Boolean,
  val venueReadAtMs: Long?,
  /** The venue read is older than [PERPS_STALE_AFTER_MS]: shown, dated, and no longer called current. */
  val stale: Boolean,
) {
  /**
   * Something is open. [stopsMissing] counts positions the report could not
   * render (a foreign position on a market this build has no decimals for) as
   * well as unprotected ones, so a positive count with an empty list is still
   * a position; so is notional with no position yet (an open in flight).
   */
  val held: Boolean get() = positions.isNotEmpty() || stopsMissing > 0 || openNotionalMicro.signum() != 0

  /**
   * Positions the report counts but could not list: [stopsMissing] counts
   * every position without a stop SEEN resting, listed or not, and a listed
   * one shows its stop only when it was seen (worker perps/view.ts) — so what
   * the count exceeds the listed stop-less ones by was never listed.
   */
  val unlisted: Int get() = maxOf(0, stopsMissing - positions.count { it.stopTrigger == null })

  /** Every position, listed or not. */
  val count: Int get() = positions.size + unlisted

  /** Money is at the venue, or on its way in or out of it. */
  val funded: Boolean get() = collateralMicro.signum() != 0 || inTransitMicro.signum() != 0

  /**
   * Rule 12's venue term as far as this report can state it: posted, in
   * transit, and every position's unrealized P&L — or null when any position's
   * P&L was not read, because a total missing a term is not the total.
   */
  val accountMicro: BigInteger?
    get() {
      var sum = collateralMicro + inTransitMicro
      for (p in positions) sum += p.unrealizedMicro?.toBigIntegerOrNull() ?: return null
      return sum
    }
}

/**
 * The web's PERPS_REPORT_STALE_MS: three times the ~5.5 minutes a hosted report
 * may take to travel the ledger mirror. Older is no longer "now".
 */
const val PERPS_STALE_AFTER_MS: Long = 15 * 60_000L

/**
 * DOES THIS GRANT HAVE ANYTHING TO DO WITH PERPS? The web's grantMentionsPerps,
 * inclusive on purpose: the marker among `grantFeatures`, or any `perp` block
 * at all. The answer only ever makes the phone MORE careful.
 */
fun grantMentionsPerps(grant: JsonElement?): Boolean {
  val g = grant as? JsonObject ?: return false
  if (g["perp"] is JsonObject) return true
  return (g["grantFeatures"] as? JsonArray)?.any { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content == GRANT_PERP_LIGHTER } == true
}

/**
 * THE ONE READER, from a GET /api/grants answer.
 *
 *  - no agent (`exists` false) → none: the server says nothing about perps.
 *  - `perps` ABSENT → none: a server from before the report existed, which
 *    could never have opened a perp.
 *  - `perps: null` → the worker has not said yet (web lib/agent-perps.ts sends
 *    null for "not said" and "unreadable" alike). Unread when the grant
 *    mentions perps; none when it does not — without the permission the
 *    session key can neither post margin nor register a Lighter key (the wall,
 *    rule 3), so there is no real leverage to warn about, and a "could not be
 *    read" banner on every owner who never turned perps on would teach them to
 *    ignore the one that matters.
 *  - anything the strict parser refuses → unread.
 */
fun perpsStatusOf(g: GrantView, nowMs: Long): PerpsStatus {
  if (!g.exists) return if (g.perpsShutdown != null && g.perpsShutdown !is JsonNull)
    PerpsStatus(PerpsState.Unread(false, 0, false), PerpsCustody.Unread) else PerpsStatus.NONE
  return perpsReadOf(g, nowMs).copy(standsDownOnKill = g.perpsStanddownOnKill == true)
}

private fun perpsReadOf(g: GrantView, nowMs: Long): PerpsStatus {
  val grantPerps = grantMentionsPerps(g.grant)
  val accountPaper = g.mode == "paper"
  val raw = g.perps
  if (raw === GRANTS_PERPS_NOT_SENT) return PerpsStatus(PerpsState.None, if (grantPerps) PerpsCustody.Unread else PerpsCustody.None)
  if (raw == null || raw is JsonNull) {
    return if (grantPerps) PerpsStatus(PerpsState.Unread(accountPaper, 0, false), PerpsCustody.Unread) else PerpsStatus.NONE
  }
  // Something was said and cannot be read: unread on screen AND in the kill's
  // words, whatever the grant says, so the two never disagree.
  val report = perpsReportOf(raw) ?: return PerpsStatus(PerpsState.Unread(accountPaper, 0, false), PerpsCustody.Unread)
  return perpsStatusOf(report, g.mode, grantPerps, nowMs)
}

/**
 * The report's own `mode` is the perps RAIL; `off` and `refuse` still carry
 * whatever the book holds (exits-only), and which book that is follows the
 * real venue index before the heartbeat's `mode`. Only a practice book is ever called
 * paper: anything this cannot place is treated as real, because calling real
 * leverage practice is the worse mistake.
 */
fun perpsStatusOf(report: PerpsReport, accountMode: String?, grantPerps: Boolean, nowMs: Long): PerpsStatus {
  val paper = report.mode == "paper" || (report.mode != "live" && report.accountIndex == null && accountMode == "paper")
  // THE VENUE FIGURES ARE WHAT SAY "READ". The worker's report for a venue it
  // could not read lists the ledger's positions with every figure null
  // (worker perps/view.ts buildPerpsReport), and a reader keys "Lighter could
  // not be read" on exactly that.
  val notional = report.openNotionalMicro?.toBigIntegerOrNull()
  val collateral = report.collateralMicro?.toBigIntegerOrNull()
  val transit = report.inTransitMicro?.toBigIntegerOrNull()
  if (notional == null || collateral == null || transit == null) {
    // For an unread venue the worker counts every ledger position in
    // `stopsMissing` but lists only those it can render.
    return PerpsStatus(
      PerpsState.Unread(paper, maxOf(report.positions.size, report.stopsMissing), report.incident),
      if (paper && !grantPerps) PerpsCustody.None else PerpsCustody.Unread,
    )
  }
  val stale = report.venueReadAt?.let { nowMs - it > PERPS_STALE_AFTER_MS } ?: false
  val known = PerpsKnown(
    paper = paper,
    positions = report.positions,
    openNotionalMicro = notional,
    collateralMicro = collateral,
    inTransitMicro = transit,
    minLiqDistanceBps = report.minLiqDistanceBps,
    stopsMissing = report.stopsMissing,
    incident = report.incident,
    venueReadAtMs = report.venueReadAt,
    stale = stale,
  )
  val shown = known.held || known.funded || known.incident
  // perpExposureOfReport: a practice book → unread for a perps grant (it says
  // nothing about the real venue account), none otherwise; a stale read →
  // unread; nothing held and no venue account → none; else what the report
  // says — known and EMPTY still names the venue account.
  val custody = when {
    paper -> if (grantPerps) PerpsCustody.Unread else PerpsCustody.None
    stale -> PerpsCustody.Unread
    !shown && report.accountIndex == null -> PerpsCustody.None
    else -> PerpsCustody.Known(known.count, collateral + transit)
  }
  return PerpsStatus(if (shown) PerpsState.Known(known) else PerpsState.None, custody)
}

// ── what the banner says ───────────────────────────────────────────────────

/**
 * The banner. There is deliberately no close on it: the condition it names is
 * a standing one, and a banner an owner can swipe away is how "No positions"
 * comes back while 10x is open.
 */
data class PerpsBanner(
  val headline: String,
  val lines: List<String>,
  /** Unread, stale or an incident: the alarm tone. Held and read: the warning tone. */
  val alarm: Boolean,
  val paper: Boolean,
)

/**
 * A link to SEE them, named as that: the web desk's perps panel is read-only
 * too — no single close and no Close-all exist anywhere yet (the owner-order
 * route for them is not built), so "Manage" promised a control the owner
 * would not find.
 */
const val PERPS_MANAGE = "See them on the web dashboard"

/** The owner's desk on the web app, where the perps panel is. */
const val PERPS_DASHBOARD_PATH = "/agent"
const val PERPS_CLOSE_ALL_PATH = "/agent?perps=flatten"
const val PERPS_CLOSE_ALL = "Close all perpetual positions…"

/** The link opens an owner-bound confirmation; it never submits an order itself. */
const val PERPS_NO_CLOSE_LINE =
  "Close all opens a confirmation on the web dashboard. It requests reduce-only closes, which may realize a loss, and pauses new perpetual positions until you resume them there."

/** What a practice book is, said wherever one is shown. */
internal const val PERPS_PRACTICE_LINE = "Practice book: no real money is traded in it."

/** perpsBlockerText("perps-unknown-activity").what, word for word. */
internal const val PERPS_INCIDENT_LINE =
  "Lighter shows activity on the agent's account that the agent did not do. New positions are stopped and open ones are being closed."

fun perpsBannerOf(s: PerpsStatus): PerpsBanner? = when (val st = s.state) {
  PerpsState.None -> null
  is PerpsState.Unread -> {
    val lines = buildList {
      if (st.recorded > 0) add("The agent's own records list ${plural(st.recorded, "position", "positions")}.")
      if (st.incident) add(PERPS_INCIDENT_LINE)
      add(if (st.paper) PERPS_PRACTICE_LINE else "Any stops resting at Lighter keep working whether or not it can be read.")
      add(PERPS_NO_CLOSE_LINE)
    }
    PerpsBanner(
      headline = if (st.paper) {
        "Paper perpetuals could not be read — you may have open paper leveraged positions"
      } else {
        "Lighter could not be read — you may have open leveraged positions"
      },
      lines = lines,
      alarm = true,
      paper = st.paper,
    )
  }
  is PerpsState.Known -> {
    val k = st.k
    val lines = mutableListOf<String>()
    val headline = when {
      k.held -> {
        // docs: "Leveraged positions on Lighter: N, $X notional, nearest
        // liquidation Y% away". The count is left out only when there is none
        // to give (an open still in flight), never printed as 0 beside
        // notional that says otherwise.
        val parts = buildList {
          if (k.count > 0) add(k.count.toString())
          add("${perpsDollars(k.openNotionalMicro)} notional")
          add(perpsLiquidationText(k.minLiqDistanceBps))
        }
        if (k.unlisted > 0) {
          lines += "${plural(k.unlisted, "position", "positions")} could not be listed here and ${if (k.unlisted == 1) "is" else "are"} not in that notional."
        }
        if (k.stopsMissing > 0) {
          lines += "${plural(k.stopsMissing, "position has", "positions have")} no stop seen resting${if (k.paper) "" else " at Lighter"}."
        }
        if (k.incident) lines += PERPS_INCIDENT_LINE
        lines += PERPS_NO_CLOSE_LINE
        (if (k.paper) "Paper leveraged positions: " else "Leveraged positions on Lighter: ") + parts.joinToString(", ")
      }
      k.funded -> {
        if (k.inTransitMicro.signum() != 0) lines += "${perpsDollars(k.inTransitMicro)} of it is in transit between Lighter and your smart account."
        if (k.incident) lines += PERPS_INCIDENT_LINE
        val total = perpsDollars(k.collateralMicro + k.inTransitMicro)
        if (k.paper) "Paper perpetuals: $total of practice margin, no position open" else "USDG on Lighter: $total, no leveraged position open"
      }
      // Only the incident is left to say, and it is the headline.
      else -> PERPS_INCIDENT_LINE
    }
    if (k.stale) lines += "Last read over 15 minutes ago, so this may not be current."
    if (k.paper) lines += PERPS_PRACTICE_LINE
    PerpsBanner(headline = headline, lines = lines, alarm = k.incident || k.stale, paper = k.paper)
  }
}

/** One row per position the report lists: "BTC-PERP · Long · 3x · liquidation 44000.0". */
fun perpsPositionRows(s: PerpsStatus): List<String> {
  val k = (s.state as? PerpsState.Known)?.k ?: return emptyList()
  return k.positions.map { p ->
    listOfNotNull(
      p.market,
      if (p.side == "short") "Short" else "Long",
      p.leverage?.let(::perpsLeverageText),
      p.liqPrice?.let { "liquidation $it" } ?: "liquidation not read",
    ).joinToString(" · ")
  }
}

/**
 * THE "AT LIGHTER" ROW, where the account's money is listed: null when there
 * is nothing to list (an agent without perps gets no $0.00 row). A practice
 * book is labelled as one — its margin never left the paper ledger, so "At
 * Lighter" would be a claim about real money.
 */
fun perpsAtLighterOf(s: PerpsStatus): Pair<String, String>? = when (val st = s.state) {
  PerpsState.None -> null
  is PerpsState.Unread -> (if (st.paper) "Paper perps" else "At Lighter") to BALANCE_UNREAD
  is PerpsState.Known -> {
    val k = st.k
    val label = if (k.paper) "Paper perps" else "At Lighter"
    label to (k.accountMicro?.let(::perpsDollars) ?: "${perpsDollars(k.collateralMicro + k.inTransitMicro)} posted, P&L not read")
  }
}

/**
 * "At Lighter" among the account's own balances — REAL money only. A practice
 * book's margin never left the paper ledger, and under "In the account" it
 * would read as a fact about the real account (the vault row's rule,
 * accountVaultUsdOf); the banner says the paper figure, labelled.
 */
fun perpsAtLighterRowOf(s: PerpsStatus?): String? {
  val st = s?.state ?: return null
  val paper = (st as? PerpsState.Unread)?.paper ?: (st as? PerpsState.Known)?.k?.paper ?: return null
  return if (paper) null else perpsAtLighterOf(s)?.second
}

/**
 * What the spot positions list says when it is empty. Only a known none may
 * say "No positions": held leverage is elsewhere, unread may be anywhere, and
 * a status not read yet ([s] null) rules nothing out.
 */
fun perpsEmptyPositions(s: PerpsStatus?): String = when (val st = s?.state) {
  null -> "No spot positions reported yet. Your agent's status has not been read, so leveraged positions are not ruled out."
  PerpsState.None -> "No positions reported yet."
  is PerpsState.Unread -> "No spot positions reported yet. Lighter could not be read, so leveraged positions are not ruled out."
  is PerpsState.Known -> if (st.k.held) "No spot positions reported yet. Its leveraged positions are shown above." else "No positions reported yet."
}

/** The list's heading: "Positions" wherever the empty line above may say "No positions". */
fun perpsPositionsHeading(s: PerpsStatus?): String = when (val st = s?.state) {
  PerpsState.None -> "Positions"
  is PerpsState.Known -> if (st.k.held) "Spot positions" else "Positions"
  else -> "Spot positions"
}

// ── the kill ───────────────────────────────────────────────────────────────

/**
 * WHAT A KILL DOES TO PERPS, said before the owner confirms it — the web's
 * killWarning, word for word, for what THIS server's kill does (rule 13). With
 * a supported stand-down it requests reduce-only closes and withdrawal, both
 * of which may fail or leave a residual. Without one, positions stay on their
 * resting stops. Null when nothing is at Lighter.
 */
fun perpsKillWarning(s: PerpsStatus?): String? {
  val status = s ?: return null
  val positions: Int? = when (val c = status.custody) {
    PerpsCustody.None -> return null
    PerpsCustody.Unread -> null
    is PerpsCustody.Known -> c.positions
  }
  if (status.standsDownOnKill) {
    val what = when {
      positions == null -> "any perpetual positions there (Lighter could not be read)"
      positions == 1 -> "its open perpetual position on Lighter"
      positions > 1 -> "its $positions open perpetual positions on Lighter"
      else -> "any perpetual positions on Lighter"
    }
    return "Stopping the agent requests a stand-down: the worker attempts to close $what at market with reduce-only orders, which can realize a loss, " +
      "and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains."
  }
  val held = when {
    positions == null -> "Lighter could not be read, so any perpetual positions there stay open"
    positions == 1 -> "Its open perpetual position on Lighter stays open"
    positions > 1 -> "Its $positions open perpetual positions on Lighter stay open"
    else -> "Any perpetual positions on Lighter stay open"
  }
  return "Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet. $held, " +
    "protected only by the stops resting at Lighter — they expire after at most 28 days and nothing re-places them once " +
    "the agent is stopped — and collateral stays at Lighter. Before stopping, use Close or Close all on the desk to review an exit request; " +
    "a close is only complete when the worker reports the remaining book."
}

/**
 * WHERE THE MONEY IS, once the stop was accepted: the DELETE answer's own
 * `custody` when it sent one (self-hosted builds it from the stand-down's
 * result, which this app cannot read once the grant is gone), else core's
 * custodySentence over the last read. Null when there is nothing to say about
 * Lighter — and only then may the caller's own words about the smart account
 * stand.
 */
fun perpsStopCustody(s: PerpsStatus?, server: String?): String? {
  server?.takeIf { it.isNotBlank() }?.let { return it }
  val c = s?.custody ?: return null
  val sentence = perpsCustodySentence(c) ?: return null
  // Figures from before the stop are dated as such: with a stand-down it has
  // begun changing them by the time anyone reads this; without one (hosted),
  // nothing at Lighter was closed, and that is said first.
  val lead = if (s.standsDownOnKill) "" else "Nothing at Lighter was closed. "
  return lead + (if (c is PerpsCustody.Known) "As last read before the stop: $sentence" else sentence)
}

/** The DELETE /api/grants answer's own custody sentence, when it carried one. */
fun perpsCustodyOfStopAnswer(answer: JsonElement?): String? =
  ((answer as? JsonObject)?.get("custody") as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

/**
 * The web's HOSTED_RECOVER_PATH (the service this app talks to), without the
 * backticks a phone would print: the web dashboard's Withdraw shows what is at
 * Lighter, and the unwind is the CLI with the owner key (rule 13: "the recover
 * path for the owner's platform").
 */
internal const val PERPS_RECOVER = "open Withdraw on the web dashboard, which shows what is at Lighter, then run merrymen recover"

/** custodySentence's unread sentence, word for word. */
internal const val PERPS_UNREAD_CUSTODY =
  "Lighter could not be read, so what is still there is unknown: positions, their resting stops and USDG may remain on Lighter. " +
    "To see it and unwind it with your owner key, $PERPS_RECOVER."

/**
 * core custodySentence for the exposure a report can state (resting orders,
 * pool shares, spot balances and pending withdrawals are not in it, and other
 * accounts under the L1 address are NOT READ — so the sentence says that, and
 * never that Lighter reads empty). Null for none.
 */
fun perpsCustodySentence(c: PerpsCustody): String? = when (c) {
  PerpsCustody.None -> null
  PerpsCustody.Unread -> PERPS_UNREAD_CUSTODY
  is PerpsCustody.Known -> {
    val held = buildList {
      if (c.positions > 0) add(plural(c.positions, "open position", "open positions"))
      if (c.collateralMicro.signum() != 0) add("${perpsUsdg(c.collateralMicro)} of collateral")
    }
    buildList {
      if (held.isNotEmpty()) add("Still on Lighter: ${held.joinToString(", ")}.")
      add("Other Lighter accounts under your smart account could not be read, so whether they hold anything is unknown.")
      if (c.positions > 0) add("Any stops resting at Lighter stay in place until those positions close.")
      add("To unwind it yourself with your owner key, $PERPS_RECOVER.")
    }.joinToString(" ")
  }
}

// ── words and figures ──────────────────────────────────────────────────────

private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

/** "3x", "2.5x" — the report's leverage, cut to hundredths and never rounded up into more. */
internal fun perpsLeverageText(v: Double): String =
  BigDecimal.valueOf(v).setScale(2, RoundingMode.DOWN).stripTrailingZeros().toPlainString() + "x"

/**
 * Liquidation distance to a tenth of a percent, rounded TOWARD the liquidation:
 * showing a position further from it than it is would be the understatement
 * this banner exists to prevent.
 */
internal fun perpsLiquidationText(bps: Double?): String {
  if (bps == null || !bps.isFinite()) return "nearest liquidation not read"
  if (bps <= 0) return "a position at or past its liquidation price"
  val tenths = Math.floor(bps / 10)
  return "nearest liquidation " + String.format(Locale.US, "%.1f", tenths / 10) + "% away"
}

/** Cents, rounded UP in magnitude like core's usdgText: exposure text may overstate by under a cent, never understate. */
private fun cents(micro: BigInteger): BigDecimal = BigDecimal(micro.abs()).divide(BigDecimal(10_000), 0, RoundingMode.UP)

/** micro-USDG as "$1,234.57". */
internal fun perpsDollars(micro: BigInteger): String {
  val c = cents(micro)
  val body = String.format(Locale.US, "%,.2f", c.movePointLeft(2))
  return (if (micro.signum() < 0 && c.signum() != 0) "-$" else "$") + body
}

/** The same figure in core's own unit: "1,234.57 USDG". */
internal fun perpsUsdg(micro: BigInteger): String {
  val c = cents(micro)
  val body = String.format(Locale.US, "%,.2f", c.movePointLeft(2))
  return (if (micro.signum() < 0 && c.signum() != 0) "-" else "") + body + " USDG"
}
