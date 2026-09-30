package dev.merrymen.app.data

import dev.merrymen.app.net.OrderPoll
import dev.merrymen.app.net.OrderReceipt
import kotlinx.coroutines.CancellationException
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

/**
 * WAIT FOR AN ORDER'S ANSWER, AND SAY ONLY WHAT THE SERVER SAID.
 *
 * A port of web/src/terminal/order-follow.ts, with its clock, its pause and its
 * poll passed in so a test can run eleven minutes of it in a millisecond.
 *
 * THE BUG IT REPLACES. The phone polled for a fixed seven minutes and then said
 * "It will show on your feed when it lands". But each order carries its own
 * window — two ticks plus a ferry pass, 8m15s at the hosted 240s tick — and
 * the server only calls an unclaimed order "expired" after that window AND a
 * two-minute grace. So the phone gave up on orders that were still going to be
 * picked up, never knew the word "expired" (nothing was sent), and looped on a
 * "done" that carried no result.
 *
 * WHAT IT DOES NOW. It keeps asking every five seconds until the server gives a
 * TERMINAL answer — done or expired — and repeats it. The deadline is the
 * order's own window as POST measured it, plus the grace, plus a minute of
 * slack, all counted on THIS phone's clock from when the reply arrived: the
 * server's `expiresAt` is its own epoch, and a phone clock eleven minutes fast
 * would give up before asking once if the two were compared. If the window
 * passes with no answer it says THAT, from the last thing the server reported,
 * and never turns silence into "nothing was sent" — a worker that took an
 * order and has not reported back may still have filled it.
 */
object OrderFollow {
  /** How often to ask. */
  const val FOLLOW_EVERY_MS = 5_000L

  /** The server's grace past an order's deadline before it calls it expired (lib/order-state.ts). */
  const val ORDER_STALE_GRACE_MS = 2 * 60_000L

  /** One ferry pass to carry a late answer up, and a couple of polls to read it. */
  const val FOLLOW_SLACK_MS = 60_000L

  /**
   * How long to wait when the server gave no window — a duplicate from an older
   * server, or an order found by looking it up. Longer than any window the route
   * issues at the hosted tick, because stopping early is the failure being fixed.
   */
  const val FALLBACK_WAIT_MS = 15 * 60_000L

  /** The sentence for a TERMINAL answer, or null while the order is still open. */
  fun orderAnswer(p: OrderPoll?): String? {
    if (p == null) return null
    if (p.state == "done") {
      // The worker's own words, which read the ledger row. Nothing here infers
      // an outcome. A done with nothing said is still done — asking again would
      // loop until the deadline and then claim not to know.
      val said = p.result?.takeIf { it.isNotBlank() }
      return said ?: "My worker closed that order without saying how it went. Check your trades before asking again."
    }
    if (p.state == "expired") {
      // The server says this only for an order nothing claimed, past its own
      // deadline and grace — which is what makes "nothing was sent" true.
      return "That order expired before my worker picked it up, so nothing was sent. Ask again if you still want it."
    }
    return null
  }

  /**
   * The window passed with no terminal answer. From the LAST thing the server
   * reported, and never as a failure: an order the worker has may still fill,
   * and one we could not read about is one we know nothing about.
   */
  fun unansweredLine(last: OrderPoll?): String = when (last?.state) {
    "running" ->
      "My worker has that order and has not answered yet, so I cannot say how it went — it may still fill. " +
        "Check your trades before asking again."
    // Only reachable for an order the server gave no window to: with one, the
    // server itself turns an unclaimed order into "expired" before this runs.
    "queued" ->
      "That order is still waiting for my worker to pick it up — nothing has gone out yet, but it still can. " +
        "Check your trades before asking again."
    else ->
      "I could not get an answer about that order, so I cannot say whether it went through. " +
        "Check your trades before asking again."
  }

  /** The order's window as POST measured it, or null when the reply did not say (or said nonsense). */
  fun followWindowMs(expiresInMs: Long?): Long? = expiresInMs?.takeIf { it >= 0 }

  /**
   * WHEN THE SERVER PLACED THE ORDER, ON THE SERVER'S CLOCK — POST computes
   * `expiresAt` and `expiresInMs` from one `now`, so their difference is it.
   * Never waited on; kept with the line that placed the order so the ledger's
   * clock can be read against it.
   */
  fun serverPlacedAt(expiresAt: Long?, expiresInMs: Long?): Long? {
    if (expiresAt == null || expiresInMs == null || expiresInMs < 0) return null
    val placed = expiresAt - expiresInMs
    return placed.takeIf { it > 0 }
  }

  /**
   * When to stop asking, as a moment on THIS phone's clock: measured from [now]
   * — when the POST's reply is in hand — so the wait can only come out longer
   * than the server's, never shorter. Fixed once and kept with the order, so a
   * follow resumed after a cold start waits out the same end.
   */
  fun followDeadline(expiresInMs: Long?, now: Long): Long =
    now + (if (expiresInMs != null) maxOf(0L, expiresInMs) + ORDER_STALE_GRACE_MS else FALLBACK_WAIT_MS) + FOLLOW_SLACK_MS

  /**
   * Follow [id] to its answer or to [giveUpAt], however long ago that was fixed.
   *
   * IT ASKS AT LEAST ONCE. A follow resumed after its deadline — the app opened
   * an hour later — would otherwise say "I could not get an answer" without
   * having asked, about an order whose answer has long been on the server.
   *
   * [alive] is "is this still that owner's thread": once it is not, the follow
   * stops without saying anything, so one wallet's outcome never lands in the
   * next wallet's conversation. [say] gets the sentence and the terminal poll
   * it came from — null when the window ran out, so nothing unanswered can
   * pass for a receipt.
   */
  suspend fun followUntil(
    id: String,
    giveUpAt: Long,
    poll: suspend (String) -> OrderPoll?,
    sleep: suspend (Long) -> Unit,
    now: () -> Long,
    alive: () -> Boolean,
    say: (String, OrderPoll?) -> Unit,
  ) {
    var last: OrderPoll? = null
    var asked = false
    while (now() < giveUpAt || !asked) {
      sleep(FOLLOW_EVERY_MS)
      if (!alive()) return
      asked = true
      val read = try {
        poll(id)
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        continue // a dropped poll is not an outcome
      }
      if (read != null) last = read
      val answer = orderAnswer(read)
      if (answer != null) {
        say(answer, read)
        return
      }
    }
    if (alive()) say(unansweredLine(last), null)
  }
}

// ── the receipt, templated from ledger fields ───────────────────────────────

/** The shared wording for a coin nobody could name. Never a guess in its place. */
const val UNLABELLED = "Token label unavailable"

private val STATUS_WORD = mapOf("filled" to "Filled", "refused" to "Refused", "failed" to "Failed", "expired" to "Expired")

/**
 * THE WALL'S RULES IN WORDS — a mirror of worker/src/thesis-policy.ts `R`,
 * which is what the public tape prints, so the owner's receipt and a
 * stranger's tape cannot describe one refusal two ways. OrderMirrorTest reads
 * the worker's file and fails when this drifts. An unknown slug is not in here
 * and the receipt names the slug itself rather than dropping it.
 */
val REJECT_RULE_LABELS: Map<String, String> = mapOf(
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

fun rejectRuleLabel(rule: String?): String? = rule?.let { REJECT_RULE_LABELS[it] }

/**
 * Dollars to the cent, the web's `usd` (en-US, two places, half away from
 * zero as Intl rounds). "$5.00", "$1,234.50".
 */
fun usdCents(v: Double): String {
  val f = NumberFormat.getCurrencyInstance(Locale.US)
  f.minimumFractionDigits = 2
  f.maximumFractionDigits = 2
  f.roundingMode = RoundingMode.HALF_UP
  return f.format(v)
}

/** "0x1234…abcd", the web's shortAddress for a coin with no symbol. */
private fun shortAddr(a: String) = if (a.length > 10) "${a.take(6)}…${a.takeLast(4)}" else a

/**
 * A RECEIPT'S TWO HALVES: the pill ("Buy" / "Sell", or null) and the line —
 * "$5.00 CASHCAT · Filled". The size prints only when the worker read one; the
 * coin is its symbol, else its short address, else the words for not knowing;
 * a refusal carries its rule in the tape's words. The web's receiptParts.
 */
fun receiptParts(r: OrderReceipt): Pair<String?, String> {
  val coin = r.symbol ?: r.token?.let(::shortAddr) ?: UNLABELLED
  val what = listOfNotNull(r.usdgActual?.let(::usdCents), coin).joinToString(" ")
  val why = if (r.status == "refused" && r.rejectRule != null) " — " + (rejectRuleLabel(r.rejectRule) ?: r.rejectRule) else ""
  val side = when (r.side) {
    "buy" -> "Buy"
    "sell" -> "Sell"
    else -> null
  }
  return side to "$what · ${STATUS_WORD[r.status] ?: r.status.orEmpty()}$why"
}

/** The whole receipt as one line: "[Buy] $5.00 CASHCAT · Filled". */
fun receiptText(r: OrderReceipt): String {
  val (side, line) = receiptParts(r)
  return (if (side != null) "[$side] " else "") + line
}
