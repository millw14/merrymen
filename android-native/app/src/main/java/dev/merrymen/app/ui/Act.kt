package dev.merrymen.app.ui

import dev.merrymen.app.data.ChatLine
import dev.merrymen.app.data.ChatSnapshot
import dev.merrymen.app.data.ConfirmScope
import dev.merrymen.app.data.LineOrder
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.OrderFollow
import dev.merrymen.app.data.PendingCard
import dev.merrymen.app.data.Repository
import dev.merrymen.app.data.rejectRuleLabel
import dev.merrymen.app.data.usdCents
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.ChatCommand
import dev.merrymen.app.net.CustomToken
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ORDER_ID
import dev.merrymen.app.net.Proposal
import dev.merrymen.app.net.RouteAnswer
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.SnipeTarget
import dev.merrymen.app.net.dailyUsdg
import dev.merrymen.app.net.lookupSnipe
import dev.merrymen.app.net.openOrder
import dev.merrymen.app.net.orderCeiling
import dev.merrymen.app.net.perTradeUsdg
import dev.merrymen.app.net.postOrder
import dev.merrymen.app.net.putSettingsFor
import dev.merrymen.app.net.said
import dev.merrymen.app.net.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.OffsetDateTime

/**
 * THE WRITE PATHS, AND WHAT THE CHAT IS TOLD, IN ONE PLACE SO THEIR RULES ARE
 * IN ONE PLACE.
 *
 * Each write here changes something real — money, or what the agent may trade
 * — and each has a rule that is easy to get subtly wrong: an order whose answer
 * was lost is unknown and looked up, never retried; every write names the owner
 * who confirmed it; nothing is placed past a limit the phone already read.
 * The chat state beside them is what the agent knows about its own money when
 * the owner asks, and a wrong field there is how an owner gets told their real
 * money is pretend.
 */

// ── what the chat model is told ─────────────────────────────────────────────

/** How many recent moves the agent is shown — what fits the prompt's budget and what "recently" means. */
const val TAPE_SHOWN = 8

/** The stock and ETF registry, by address, from packages/core/src/tokens.ts — the tape's fallback for a side and a name. */
private val STOCKS: Map<String, String> = mapOf(
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" to "AAPL",
  "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc" to "AMD",
  "0x12f190a9f9d7d37a250758b26824b97ce941bf54" to "AMZN",
  "0xad25ac6c84d497db898fa1e8387bf6af3532a1c4" to "BABA",
  "0x822cc93ffd030293e9842c30bbd678f530701867" to "BE",
  "0x6330d8c3178a418788df01a47479c0ce7ccf450b" to "COIN",
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5" to "CRCL",
  "0x5f10a1c971b69e47e059e1dc91901b59b3fb49c3" to "CRWV",
  "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3" to "GOOGL",
  "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681" to "INTC",
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35" to "META",
  "0xe93237c50d904957cf27e7b1133b510c669c2e74" to "MSFT",
  "0xff080c8ce2e5feadaca0da81314ae59d232d4afd" to "MU",
  "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" to "NVDA",
  "0xb0992820e760d836549ba69bc7598b4af75dee03" to "ORCL",
  "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a" to "PLTR",
  "0xb90a19ff0af67f7779aff50a882a9cff42446400" to "SNDK",
  "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea" to "SPCX",
  "0x322f0929c4625ed5bad873c95208d54e1c003b2d" to "TSLA",
  "0xd917b029c761d264c6a312bbbcda868658ef86a6" to "USAR",
  "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68" to "QQQ",
  "0x92fd66527192e3e61d4ddd13322aa222de86f9b5" to "SGOV",
  "0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f" to "SLV",
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c" to "SPY",
  "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344" to "USO",
)

/** One move as the agent is shown it: when, which way, what, how much, and how it ended. */
data class ChatMove(
  /** Epoch seconds, the ledger's clock; 0 when the row's time could not be read (the web's ledgerSeconds). */
  val at: Long,
  val action: String?,
  val symbol: String?,
  val sizeUsdg: Double?,
  /** landed | refused | reverted | pending — an ALLOW-LIST, so a state nobody knows is "pending", never "landed". */
  val outcome: String,
  val outcomeText: String?,
  /** Practice: the tape books a paper trade as landed, and only this says it was not real. Not sent to the model. */
  val paper: Boolean = false,
  /** The chain hash the ledger recorded, as the ledger wrote it — the thread's key for the trade. Not sent to the model. */
  val txHash: String? = null,
)

/** A ledger time ("2026-09-24 12:00:00", UTC) as epoch seconds, or 0 — the web's ledgerSeconds. */
internal fun ledgerSeconds(raw: String?): Long {
  if (raw.isNullOrBlank()) return 0
  val iso = if (Regex("\\dZ?$").containsMatchIn(raw) && raw.contains(' ')) raw.replaceFirst(' ', 'T') + "Z" else raw
  return try {
    Instant.parse(iso).epochSecond
  } catch (e: java.time.DateTimeException) {
    try {
      OffsetDateTime.parse(iso).toEpochSecond()
    } catch (e2: java.time.DateTimeException) {
      0
    }
  }
}

private fun tradeOutcome(status: String?): String = when (status) {
  "landed", "paper" -> "landed"
  "rejected" -> "refused"
  "reverted" -> "reverted"
  else -> "pending"
}

private val RECORDED_SYMBOL = Regex("^[A-Za-z0-9$._-]{1,32}$")

/**
 * THE OWNER'S TAPE, NEWEST FIRST — the web's mineOf moves through tapeFor.
 *
 * The side is the ledger's own word first (the fill's side, then the side the
 * decision asked for, so a refusal has one too), then the stock pair; a row
 * none of those can name keeps a null side rather than a guess. Sorted HERE,
 * not trusted from the caller: the web once handed its model the oldest eight
 * and called them the latest, and reading a tape backwards fails silently.
 */
fun chatMoves(feed: Feed): List<ChatMove> =
  feed.trades.map { t ->
    val buy = STOCKS[t.buyToken?.lowercase()]
    val sell = STOCKS[t.sellToken?.lowercase()]
    val recorded = t.fillSide?.takeIf { it == "buy" || it == "sell" } ?: t.action?.takeIf { it == "buy" || it == "sell" }
    val action = recorded ?: if (buy != null) "buy" else if (sell != null) "sell" else null
    val stock = when (action) {
      "buy" -> buy
      "sell" -> sell
      else -> buy ?: sell
    }
    val symbol = stock ?: t.symbol?.takeIf { RECORDED_SYMBOL.matches(it) && !it.startsWith("0x", ignoreCase = true) }
    ChatMove(
      at = ledgerSeconds(t.createdAt),
      action = action,
      symbol = symbol,
      sizeUsdg = t.amountUsdg,
      outcome = tradeOutcome(t.status),
      outcomeText = rejectRuleLabel(t.rejectRule) ?: t.rejectRule,
      paper = t.status == "paper",
      txHash = t.txHash?.takeIf { it.isNotEmpty() },
    )
  }.sortedByDescending { it.at }

private fun num(v: Double?): JsonElement = v?.takeIf { it.isFinite() }?.let(::JsonPrimitive) ?: JsonNull
private fun str(v: String?): JsonElement = v?.let(::JsonPrimitive) ?: JsonNull
private fun bool(v: Boolean?): JsonElement = v?.let(::JsonPrimitive) ?: JsonNull

/** Blockers only the owner can clear (packages/core autonomy.ts OWNER_ACTION). */
private val OWNER_ACTION = setOf("dead-policy", "grant-too-wide", "wrong-chain", "not-armed")

private fun grantField(g: GrantView, key: String): Double? =
  ((g.grant as? JsonObject)?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()

/**
 * THE WORKER'S STATUS AS A WORD — core's autonomyOf label: BLOCKED, CHECKING,
 * PAPER, LIVE or IDLE, or null when the grants were not read ("Unknown").
 *
 * The web hands the model this label, and the old phone hard-coded "Unknown",
 * so the agent could not answer "you say running, why no trades?".
 */
fun autonomyLabel(grants: GrantView?, nowMs: Long): String? {
  if (grants == null || !grants.exists) return null
  val rule = grants.liveBlocker
  val expiresAt = grantField(grants, "expiresAt")
  if (expiresAt != null && expiresAt * 1000 < nowMs) return "BLOCKED"
  val grantedAt = grantField(grants, "grantedAt")
  val alive = grants.workerAliveAt
  // A verdict about a key the owner has already replaced is not news.
  if (rule in OWNER_ACTION && grantedAt != null && alive != null && alive > 0 && grantedAt > alive) return "CHECKING"
  if (rule in OWNER_ACTION) return "BLOCKED"
  return when (grants.mode) {
    "paper" -> "PAPER"
    "live" -> "LIVE"
    else -> "IDLE"
  }
}

/**
 * THE STATE THE CHAT MODEL IS BUILT AROUND — the web's chatStateOf, field for
 * field (terminal/chat-payload.ts, and account.ts chatPositionsOf).
 *
 * The chat is stateless on the server: this object IS what the agent knows
 * about its own money when the owner asks. The fields that must be exactly
 * right:
 *   - `liveTradingEnabled` IS THE MODE. The server prompt calls reading
 *     `paperTradingEnabled` as the mode "the one mistake here that costs real
 *     money", and the old phone sent only paperTradingEnabled — true for nearly
 *     every agent, live ones included.
 *   - `basketSymbols` is the array when settings carried it, JSON null when
 *     they did not — never a guessed empty list.
 *   - a settings read that failed makes EVERY settings figure null, never a
 *     default dressed as the owner's choice; the same for the feed's figures
 *     and the grant's.
 *   - a position's `unrealisedPct` is null unless its cost is vouched for
 *     (cost_from_quote exactly false). The plan asked for stale prices to null
 *     it too; the web does not, and the prompt already tells the model a stale
 *     price is last session's number, so this follows the web.
 */
fun chatStateOf(feed: Feed?, settings: SettingsEnvelope?, grants: GrantView?, nowMs: Long): JsonObject {
  val mine = feed?.takeIf { it.source != "none" && (it.agent?.name != null || it.equity.isNotEmpty()) }
  fun pick(k: String): JsonElement? {
    val s = settings ?: return null
    return (s.values as? JsonObject)?.get(k)?.takeUnless { it is JsonNull }
      ?: (s.defaults as? JsonObject)?.get(k)?.takeUnless { it is JsonNull }
  }
  fun pickNumber(k: String): JsonElement = (pick(k) as? JsonPrimitive)?.takeIf { !it.isString }
    ?.content?.toDoubleOrNull()?.let(::num) ?: JsonNull
  val last = mine?.equity?.lastOrNull()
  val moves = mine?.let(::chatMoves)
  return buildJsonObject {
    put("name", str(mine?.let { it.agent?.name ?: "Your agent" }))
    put("equity", num(mine?.equity?.lastOrNull { it.equityUsdg?.isFinite() == true }?.equityUsdg))
    put("strategy", pick("strategy") ?: str(mine?.agent?.strategy))
    put("basketSymbols", pick("basketSymbols") ?: JsonNull)
    put("paperTradingEnabled", pick("paperTradingEnabled") ?: JsonNull)
    put("liveTradingEnabled", pick("liveTradingEnabled") ?: JsonNull)
    put("workerStatus", JsonPrimitive(autonomyLabel(grants, nowMs) ?: "Unknown"))
    put("liveBlocker", str(grants?.liveBlocker))
    put(
      "positions",
      mine?.let {
        buildJsonArray {
          it.positions.forEach { p ->
            val cost = p.costUsdg?.takeIf { c -> c.isFinite() && c > 0 }
            val confirmed = cost != null && p.costFromQuote == false
            val value = p.valueUsdg
            val pnl = if (cost == null || value == null) null else (value - cost) / cost * 100
            add(buildJsonObject {
              put("symbol", JsonPrimitive(p.symbol))
              put("valueUsd", num(value))
              put("costUsd", num(cost))
              put("costConfirmed", if (cost == null) JsonNull else JsonPrimitive(confirmed))
              put("unrealisedPct", if (pnl == null || !confirmed) JsonNull else num(Math.round(pnl * 10) / 10.0))
              put("priceStale", JsonPrimitive(p.priceStale))
              put("stopLossBps", p.stopFloorBps?.takeIf { b -> b > 0 }?.let(::JsonPrimitive) ?: JsonNull)
              put("stopWhy", str(p.stopFloorWhy?.takeIf { w -> w.isNotBlank() }))
            })
          }
        }
      } ?: JsonNull,
    )
    put("cashUsd", num(last?.cashUsdg))
    put("vaultUsd", num(last?.vaultUsdg))
    // The two rules that sell WITHOUT asking the model. Null is "not armed",
    // which is a different answer from a level of zero.
    put("stopLossBps", pickNumber("strategistStopLossBps"))
    put("takeProfitBps", pickNumber("takeProfitBps"))
    put(
      "moves",
      moves?.let { list ->
        buildJsonArray {
          list.take(TAPE_SHOWN).forEach { m ->
            add(buildJsonObject {
              put("at", JsonPrimitive(m.at))
              put("action", str(m.action))
              put("symbol", str(m.symbol))
              put("sizeUsdg", num(m.sizeUsdg))
              put("outcome", JsonPrimitive(m.outcome))
              put("outcomeText", str(m.outcomeText))
            })
          }
        }
      } ?: JsonNull,
    )
    put("movesShown", moves?.let { JsonPrimitive(minOf(it.size, TAPE_SHOWN)) } ?: JsonNull)
    put("movesTotal", moves?.let { JsonPrimitive(it.size) } ?: JsonNull)
    put("perTrade", num(grants?.perTradeUsdg))
    put("perDay", num(grants?.dailyUsdg))
    // The web says `stopped` for any mode but live and paper. Unread grants are
    // not a stopped agent: null, not a claim.
    put("stopped", bool(grants?.let { it.mode != "live" && it.mode != "paper" }))
  }
}

// ── what to ask next ────────────────────────────────────────────────────────

/**
 * THE MOST A CHIP MAY SUGGEST: the smaller of the per-trade cap sealed into the
 * key and the owner's ceiling on a chat order — the web's amountCeiling.
 *
 * Null when either was not read: a size nobody checked against the wall is one
 * the wall may refuse. A ceiling of 0 is "no chat ceiling", so the sealed cap
 * alone clamps. ROUNDED DOWN TO THE CENT, with a hair of slack because 8.2 ×
 * 100 comes out a hair below 820, and then checked so the result never exceeds
 * the limit: a ceiling of 9.999 printed as "$10.00 (max)" was an order the
 * route refused.
 */
fun amountCeiling(perTrade: Double?, ceiling: Double?): Double? {
  if (perTrade == null || ceiling == null || !perTrade.isFinite() || perTrade <= 0) return null
  val limit = if (ceiling > 0) minOf(perTrade, ceiling) else perTrade
  var cents = Math.floor(limit * 100 + 1e-6).toLong()
  if (cents / 100.0 > limit) cents -= 1
  return if (cents > 0) cents / 100.0 else null
}

private val ASKS_AMOUNT = Regex("""\bhow much\b|\bwhat size\b|\bhow big\b|\bwhich amount\b|\bhow many dollars\b""", RegexOption.IGNORE_CASE)
private val STEPS = listOf(5.0, 10.0, 25.0, 50.0, 100.0, 250.0)

/** Does this line of the agent's ask the owner for an amount — the one answer that draws amount chips? */
fun asksAmount(line: String?): Boolean = line != null && ASKS_AMOUNT.containsMatchIn(line)

/** A chip only ever SENDS A MESSAGE; any trade still goes through the card. */
data class ChatChip(val label: String, val message: String)

/**
 * TWO TO FOUR THINGS WORTH ASKING NEXT — the web's chatChips.
 *
 * When the agent has just asked "how much?", sizes, each below the clamp, and
 * the clamp itself marked (max) — so the max is never an amount the server
 * would refuse. Otherwise the questions this agent's state raises.
 */
fun chatChips(
  liveBlocker: String?,
  stopped: Boolean,
  latestSymbol: String?,
  holding: List<String>,
  lastAgent: String?,
  perTrade: Double?,
  ceiling: Double?,
): List<ChatChip> {
  val chips = mutableListOf<ChatChip>()
  val clamp = amountCeiling(perTrade, ceiling)
  if (asksAmount(lastAgent) && clamp != null) {
    STEPS.filter { it < clamp }.take(2).forEach { chips += ChatChip(usdCents(it), usdCents(it)) }
    chips += ChatChip("${usdCents(clamp)} (max)", usdCents(clamp))
  }
  val context = mutableListOf<ChatChip>()
  if (liveBlocker != null || stopped || latestSymbol == null) {
    context += ChatChip("Why can't you trade?", "Why can't you trade right now?")
  }
  if (latestSymbol != null) context += ChatChip("Why $latestSymbol?", "Why did you trade $latestSymbol?")
  context += if (holding.isNotEmpty()) {
    ChatChip("What do you hold?", "What do you hold, and how is it doing?")
  } else {
    ChatChip("My strategy", "Explain your trading strategy.")
  }
  context += ChatChip("Trading limits", "Explain my trading limits.")
  for (chip in context) {
    if (chips.size >= 4 || (chips.size >= 2 && chips.any { it.label.startsWith("$") })) break
    chips += chip
  }
  return chips.take(4)
}

/**
 * The chips for the thread as it stands: the latest recorded buy or sell, what
 * is held, the agent's last words (a failure is not words it said), the cap
 * and the ceiling. Nothing read, nothing offered but the questions.
 */
fun chipsFor(snapshot: ChatSnapshot?, lines: List<ChatLine>, ceiling: Double?): List<ChatChip> {
  val feed = snapshot?.feed
  val grants = snapshot?.grants
  val latest = feed?.let(::chatMoves)?.firstOrNull { it.action == "buy" || it.action == "sell" }
  return chatChips(
    liveBlocker = grants?.liveBlocker,
    stopped = grants != null && grants.mode != "live" && grants.mode != "paper",
    latestSymbol = latest?.symbol,
    holding = feed?.positions?.map { it.symbol }.orEmpty(),
    lastAgent = lines.lastOrNull { it.role == "agent" && it.failed == null }?.text,
    perTrade = grants?.perTradeUsdg,
    ceiling = ceiling,
  )
}

// ── a reply that did not arrive, in the agent's voice ───────────────────────

private val LLM_KINDS = setOf("key-rejected", "rate-limited", "provider-down", "unreachable", "model-missing", "other")
private val PROVIDER = Regex("^[A-Za-z0-9][\\w .-]{0,39}$")

/** A kind this build does not know is "other" — said as a reason it does not recognise, which is true. */
fun llmKindOf(kind: String?): String = kind?.takeIf { it in LLM_KINDS } ?: "other"

/** A provider name that is not a short plain name is not repeated. */
fun providerOf(provider: String?): String? = provider?.takeIf { PROVIDER.matches(it) }

/**
 * IS ASKING AGAIN WORTH A RETRY? Yes for everything that passes — a network, a
 * timeout, a stream cut short, a server that did not answer. Not for a model
 * failure that will fail the same way until somebody changes something, and
 * not for an address that is not an address: a button that cannot work, beside
 * a sentence telling the owner it might, is worse than none.
 */
fun retryHelps(failure: String, kind: String?): Boolean = when (failure) {
  "no-address" -> false
  "llm-error" -> llmKindOf(kind) in setOf("rate-limited", "provider-down", "unreachable")
  else -> true
}

/**
 * A REPLY THAT DID NOT ARRIVE, SAID AS THE AGENT WOULD SAY IT — the web's
 * failureLine. Never the provider's own words: the route's `detail` is
 * redacted debug text the server marks never-rendered, and the phone used to
 * print it after the raw `why` ("llm-error — groq 401 …"). A model failure is
 * said by its kind, and "try again" only where trying again can work.
 */
fun failureLine(failure: String, status: Int? = null, kind: String? = null, provider: String? = null): String {
  when (failure) {
    "signed-out" -> return "I can't hear you — your sign-in has lapsed. Sign in again and ask me once more."
    "no-llm" -> return "I've no brain connected yet, so I can't answer in my own words. Connect an AI provider in Settings, then ask me again."
    "timeout" -> return "I took too long to answer and gave up waiting. Try again."
    "cut-off" -> return "My answer was cut off before I finished, so I haven't kept half of it. Try again."
    "network" -> return "I couldn't reach you just now — the connection dropped before my answer arrived. Try again."
    "server" -> return "I couldn't get an answer through just now${if (status != null) " (the server said $status)" else ""}. Try again."
    "no-address" -> return "I can't reach merrymen from here: the Server address in Settings isn't a web address — fix it there."
    "llm-error" -> Unit
    else -> return "I got an answer back that I can't read, so I haven't shown it. Try again."
  }
  val who = providerOf(provider)
  val whose = who ?: "its provider"
  val aside = if (who != null) ", $who," else ""
  return when (llmKindOf(kind)) {
    "key-rejected" -> "My brain couldn't answer: $whose refused the API key it's set up with. Asking again won't help until that key is replaced."
    "model-missing" -> "My brain couldn't answer: $whose says the model it's set to use isn't available. Asking again won't help until the model is changed."
    "rate-limited" -> "My brain is being rate-limited by $whose right now. Give it a moment and try again."
    "provider-down" -> "My brain's provider$aside is having trouble on its side. Try again in a few minutes."
    "unreachable" -> "I couldn't reach my brain's provider$aside just now. Try again in a minute."
    else -> "My brain couldn't answer that time, for a reason I don't recognise. If asking again gets the same, its setup needs a look."
  }
}

// ── the card: real money or paper, and the limits ──────────────────────────

/**
 * REAL MONEY OR PAPER, said on every card that places an order.
 *
 * From the worker's own heartbeat (grants.mode), the same verdict that decides
 * how the order runs. Unread or anything else is said as unknown and to be
 * treated as real — never assumed to be practice.
 */
fun moneyLine(mode: String?): String = when (mode) {
  "live" -> "Real money: I'm trading live, so this is a real order on Robinhood Chain."
  "paper" -> "Paper: I'm practising right now, so this is simulated money at live prices — no real order goes out."
  else -> "I can't tell right now whether this would be real money or paper, so treat it as real money."
}

/** Whether an order's size fits the limits the phone has read. */
sealed interface LimitCheck {
  data object Within : LimitCheck
  /** A limit was not read. The order may still go — the server checks — and the card says so. */
  data class Unread(val note: String) : LimitCheck
  /** Past a limit that WAS read. Nothing is sent; [line] names the limit exactly. */
  data class Over(val line: String) : LimitCheck
}

/** The note a card carries when a limit could not be read (the plan's words). */
const val LIMIT_UNREAD = "I couldn't read your limit, the server will check it."

/**
 * WILL THIS SIZE BE REFUSED? Checked before anything is sent, so an over-limit
 * order is refused here with the limit in the sentence rather than by a 400
 * the owner then has to decode.
 *
 * A BUY is held to [amountCeiling] — the sealed per-trade cap and the chat
 * ceiling, to the cent. A SELL is held to the ceiling only: the orders route
 * applies the ceiling to both sides, but the per-trade cap is the chain's
 * bound on the USDG a buy spends, and the worker exempts a sell to cash from it
 * (worker/src/policy.ts isUnsizedExit) — refusing a sell on it here would stop
 * an owner leaving a position the wall lets them leave.
 */
fun orderLimit(side: String, usdg: Double, perTrade: Double?, ceiling: Double?): LimitCheck {
  val chatCap = ceiling?.takeIf { it > 0 }?.let { amountCeiling(it, 0.0) }
  val sealedCap = if (side == "buy") perTrade?.let { amountCeiling(it, 0.0) } else null
  val tightest = listOfNotNull(sealedCap, chatCap).minOrNull()
  if (tightest != null && usdg > tightest + 1e-9) {
    return LimitCheck.Over(
      if (tightest == sealedCap) {
        "That's more than the ${usdCents(tightest)} per-trade cap sealed into my key, so I won't place it. " +
          "Ask for ${usdCents(tightest)} or less — a bigger cap needs a new signature."
      } else {
        "That's over your ${usdCents(tightest)} limit for an order placed from the app, so I won't place it. " +
          "Ask for ${usdCents(tightest)} or less, or raise the limit in Settings."
      },
    )
  }
  val unread = ceiling == null || (side == "buy" && perTrade == null)
  return if (unread) LimitCheck.Unread(LIMIT_UNREAD) else LimitCheck.Within
}

// ── carrying out a confirmed card ───────────────────────────────────────────

/** What placing came to, for a screen that placed it (the Trade screen) — the thread hears it too. */
sealed interface Placed {
  val line: String
  /** A row exists and is being followed. Not filled — placed. */
  data class Queued(val id: String, override val line: String) : Placed
  /** The answer was lost. Looked up once; [following] is the open order found, if any. Never "failed". */
  data class Unknown(override val line: String, val following: String?) : Placed
  /** Refused — by the route in its own words, or here before anything was sent. */
  data class Refused(override val line: String) : Placed
}

private fun JsonObject?.long(key: String): Long? =
  (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.takeIf { it.isFinite() }?.toLong()

private fun JsonObject?.flag(key: String): Boolean =
  (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.content == "true"

private fun JsonObject?.errorsOf(): String? =
  (this?.get("errors") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    ?.filter { it.isNotBlank() }?.takeIf { it.isNotEmpty() }?.joinToString(" ")

/** Said when the owner changed after the card was made: nothing is sent for anybody. */
const val OWNER_CHANGED_LOCAL =
  "I didn't place that — the wallet signed in here changed after you confirmed, so nothing was sent. Ask again if you still want it."

/**
 * AN ORDER WHOSE PLACING NEVER ANSWERED IS NOT A REFUSAL.
 *
 * The connection can drop after the server wrote the row, so nothing here is
 * known — and the card goes, because tapping it again may be a second order at
 * a second price. The key is asked ONCE what is open on it, for the owner who
 * confirmed: an open order is followed to its answer like any other; otherwise
 * the owner is told plainly that it is unknown and where to look. Never sent
 * again from here.
 */
private suspend fun orderLost(api: MerrymenApi, scope: ConfirmScope): Placed {
  scope.clearCard()
  scope.say("owner", "✓ Confirmed")
  val open = if (scope.alive()) api.openOrder(scope.owner) else null
  if (open != null) {
    val line = "I lost the line while placing that, but there is an order open on my key now — I'll tell you how it ends."
    scope.say("agent", line, LineOrder(open))
    scope.followOrder(open, null)
    return Placed.Unknown(line, open)
  }
  val line = "I couldn't confirm that order reached my key — the connection dropped before I heard back. " +
    "Check your trades before asking again."
  scope.say("agent", line)
  return Placed.Unknown(line, null)
}

/**
 * PLACE ONE ORDER through the one channel orders take, for the owner who
 * confirmed it, and say what is true the moment it exists — placed, not
 * filled — then follow it to its answer in the app's scope.
 *
 * Nothing goes out once the owner has changed ([ConfirmScope.alive]), and what
 * goes out names that owner, so the route refuses a session another wallet
 * took over (409). A refusal is said in the route's own words and the chat
 * card stays for another tap — never an automatic one.
 */
suspend fun placeConfirmedOrder(
  api: MerrymenApi,
  scope: ConfirmScope,
  side: String,
  symbol: String,
  usdg: Double,
  words: (duplicate: Boolean) -> String,
): Placed {
  if (!scope.alive()) {
    scope.say("agent", OWNER_CHANGED_LOCAL)
    return Placed.Refused(OWNER_CHANGED_LOCAL)
  }
  // Whatever goes wrong on the way is an answer we did not get: looked up, never retried.
  val answer = try {
    api.postOrder(side, symbol, usdg, scope.owner)
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: Exception) {
    RouteAnswer.Lost
  }
  return when (val placed = answer) {
    is RouteAnswer.NotSent -> {
      val line = "That didn't go through: ${placed.why}"
      scope.say("agent", line)
      Placed.Refused(line)
    }
    RouteAnswer.Lost -> orderLost(api, scope)
    is RouteAnswer.Said -> {
      val body = placed.body
      val id = body.text("id")?.takeIf { ORDER_ID.matches(it) }
      when {
        // A 200 is a row that exists, but one whose id cannot be read cannot be
        // followed — so it is looked for, exactly like an answer that was lost.
        placed.ok && id == null -> orderLost(api, scope)
        !placed.ok -> {
          val line = "That didn't go through: " + (body.text("error") ?: "that was refused (${placed.status})")
          scope.say("agent", line)
          Placed.Refused(line)
        }
        else -> {
          val line = words(body.flag("duplicate"))
          val expiresInMs = body.long("expiresInMs")
          scope.say("owner", "✓ Confirmed")
          scope.say(
            "agent", line,
            LineOrder(id!!, serverPlacedAt = OrderFollow.serverPlacedAt(body.long("expiresAt"), expiresInMs)),
          )
          scope.clearCard()
          scope.followOrder(id, OrderFollow.followWindowMs(expiresInMs))
          Placed.Queued(id, line)
        }
      }
    }
  }
}

/** What a snipe's lookup came to. Only [Found] can lead to an order — after its own card. */
sealed interface Looked {
  val line: String
  data class Found(val target: SnipeTarget, val usdg: Double, override val line: String) : Looked
  data class Said(override val line: String) : Looked
}

private val SNIPE_SYMBOL = Regex("^[A-Za-z0-9$._-]{1,24}$")
private val SNIPE_ADDRESS = Regex("^0x[0-9a-fA-F]{40}$")

/**
 * GO AFTER A COIN BY NAME — resolve it, and ASK rather than guess.
 *
 * Four outcomes and none of them places anything here. Two coins with one name
 * is a question (the route's sentence lists their addresses), a coin the key
 * does not cover is a re-sign, and nothing found is said as a fact about our
 * search. And RESOLVED IS NOT BOUGHT: the web places the order the moment the
 * lookup answers, which means the owner confirmed a NAME and got whichever
 * coin the index matched to it. Here the coin it found — symbol and address —
 * goes on a card of its own, with the amount and whether it is real money, and
 * only that tap places it. A deliberate departure from the web, in the safe
 * direction: a lookup is free, a wrong coin is not.
 */
suspend fun lookupConfirmedSnipe(api: MerrymenApi, scope: ConfirmScope, query: String, usdg: Double): Looked {
  if (!scope.alive()) {
    scope.say("agent", OWNER_CHANGED_LOCAL)
    return Looked.Said(OWNER_CHANGED_LOCAL)
  }
  return when (val found = api.lookupSnipe(query, usdg, scope.owner)) {
    is RouteAnswer.NotSent -> Looked.Said("That didn't go through: ${found.why}").also { scope.say("agent", it.line) }
    // A lookup places nothing, so a lost answer costs only the asking — and
    // the card stays for exactly that.
    RouteAnswer.Lost -> Looked.Said("I couldn't look that coin up — no answer came back, and nothing was placed. Try again.")
      .also { scope.say("agent", it.line) }
    is RouteAnswer.Said -> {
      val out = found.body
      val say = out.text("say")
      val target = out?.get("target") as? JsonObject
      val symbol = target.text("symbol")?.takeIf { SNIPE_SYMBOL.matches(it) }
      val address = target.text("address")?.takeIf { SNIPE_ADDRESS.matches(it) }
      when {
        !found.ok && say == null ->
          Looked.Said("That didn't go through: " + (out.text("error") ?: "that was refused (${found.status})"))
            .also { scope.say("agent", it.line) }
        found.ok && out.text("outcome") == "resolved" && symbol != null && address != null -> {
          val short = target.text("short") ?: "${address.take(6)}…${address.takeLast(4)}"
          val coin = SnipeTarget(symbol, address, short, covered = true)
          val named = if (out.text("matchedOn") == "name") " — matched on its name, not its ticker" else ""
          val line = "Found it — $symbol at $short$named. Nothing is placed yet: confirm it and I'll buy ${usdCents(usdg)} of it."
          scope.say("owner", "✓ Confirmed")
          scope.say("agent", line)
          scope.propose(
            ChatCommand("buy", mapOf("symbol" to JsonPrimitive(symbol), "usdgAmount" to JsonPrimitive(usdg))),
            coin,
          )
          Looked.Found(coin, usdg, line)
        }
        else -> {
          val line = say ?: "I could not tell how that went."
          scope.say("owner", "✓ Confirmed")
          scope.say("agent", line)
          scope.clearCard()
          Looked.Said(line)
        }
      }
    }
  }
}

/**
 * A SETTINGS CARD — read-modify-write at tap time, only the command's declared
 * keys, for the owner who confirmed (409 OWNER_CHANGED_SETTING writes nothing).
 * A lost answer may have landed: said as unknown, the settings re-read, and the
 * card left, because setting the same value twice is safe.
 */
suspend fun runSettingsCard(api: MerrymenApi, scope: ConfirmScope, spec: CommandSpec, args: Map<String, String>) {
  if (!scope.alive()) {
    scope.say("agent", "I didn't change that — the wallet signed in here changed after you confirmed, so nothing was saved.")
    return
  }
  when (val put = api.putSettingsFor(settingsPayload(spec, args), scope.owner)) {
    is RouteAnswer.NotSent -> scope.say("agent", "That didn't go through: ${put.why}")
    RouteAnswer.Lost -> {
      scope.say(
        "agent",
        "I couldn't tell whether that change was saved — the connection dropped before I heard back. " +
          "Asking again is safe: it only sets the same value.",
      )
      scope.refreshSettings()
    }
    is RouteAnswer.Said -> {
      if (!put.ok) {
        scope.say("agent", "That didn't go through: " + (put.body.errorsOf() ?: put.body.text("error") ?: "that was refused (${put.status})"))
        return
      }
      // A KEY THE SERVER DID NOT KNOW WAS NOT SAVED, whatever the 200 says.
      val ignored = (put.body?.get("ignored") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }.orEmpty()
      scope.say("owner", "✓ Confirmed")
      if (ignored.isNotEmpty()) {
        scope.say("agent", "Only part of that was saved: the server didn't recognise ${ignored.joinToString(", ")}, so that did not change.")
      } else {
        scope.say("agent", "Done — ${spec.say(args)}")
      }
      scope.clearCard()
      scope.refreshSettings()
    }
  }
}

/** The amount a card carries, or null when it is not a positive, finite number. */
private fun amountOf(args: Map<String, String>): Double? =
  args["usdgAmount"]?.trim()?.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }

/**
 * DO THE THING THE OWNER JUST CONFIRMED — the chat's card, carried out once.
 *
 * The model proposed it; this runs only from a tap. An id this build does not
 * know is never run (the card shows it and disables the button). An order
 * past a limit the phone has read is refused here, before anything is sent.
 * [onNavigate] gets a navigate command's web path and its page's title.
 */
suspend fun runConfirmedCard(
  api: MerrymenApi,
  card: PendingCard,
  perTrade: Double?,
  ceiling: Double?,
  onNavigate: (String, String) -> Unit,
) {
  val spec = COMMANDS[card.command.id] ?: return
  val scope = card.scope
  val args = card.command.argText()
  if (!scope.alive()) {
    scope.clearCard()
    return
  }
  when (spec.via) {
    Via.NAVIGATE -> {
      scope.clearCard()
      spec.to?.let { onNavigate(it, spec.title ?: spec.id) }
    }
    Via.SNIPE -> {
      val usdg = amountOf(args)
      if (usdg == null) {
        scope.say("agent", "That isn't an amount I can trade, so nothing was looked up or placed.")
        return
      }
      lookupConfirmedSnipe(api, scope, args["query"].orEmpty(), usdg)
    }
    Via.ORDER -> {
      val side = spec.fixed["side"]?.jsonPrimitive?.content ?: return
      val symbol = args["symbol"].orEmpty().trim().uppercase()
      val usdg = amountOf(args)
      if (usdg == null || symbol.isEmpty()) {
        scope.say("agent", "That isn't an order I can place — it needs a coin and an amount — so nothing was sent.")
        return
      }
      val over = orderLimit(side, usdg, perTrade, ceiling) as? LimitCheck.Over
      if (over != null) {
        scope.say("agent", over.line)
        return
      }
      val found = card.found
      if (found != null) {
        val said = "${found.symbol} at ${found.short ?: found.address}."
        placeConfirmedOrder(api, scope, side, symbol, usdg) { duplicate ->
          if (duplicate) "$said I already had that one queued, so I have not placed it twice."
          else "$said Placed, not filled — my key's limits still decide, and I will tell you which."
        }
      } else {
        placeConfirmedOrder(api, scope, side, symbol, usdg) { duplicate ->
          if (duplicate) "That exact order is already queued — I have not placed a second one."
          else "Placed it — ${spec.say(args)} It is with my key now; the limits you signed decide whether it goes through, and I will tell you which."
        }
      }
    }
    Via.SETTINGS -> runSettingsCard(api, scope, spec, args)
    Via.UNKNOWN -> Unit
  }
}

// ── proposals and risk: settings writes outside the chat ────────────────────

sealed interface Acted {
  data class Ok(val line: String) : Acted
  data class Failed(val line: String) : Acted
}

/** The default basket, from packages/core. The fallback of last resort so an
 *  absent defaults payload can never narrow the basket to one approved coin. */
private val DEFAULT_BASKET_SYMBOLS = listOf("QQQ", "NVDA", "TSLA")

/** Why a read or a write did not come back, in one line — never "couldn't reach" for an answer that arrived. */
private fun why(r: ApiResult<*>): String = when (r) {
  is ApiResult.Refused -> r.message
  is ApiResult.Unreachable -> r.said
  else -> "unknown"
}

/**
 * What a settings PUT that did not come back OK means for the owner. A lost
 * answer is unknown, never "failed": the write may have landed. A refusal is
 * the server's reason — 409 is the session having changed since the values
 * were read, and nothing was saved.
 */
private fun settingsWriteFailed(r: ApiResult<*>): Acted.Failed = when {
  r is ApiResult.Refused && r.status == 409 ->
    Acted.Failed("Your session changed since this was set up — nothing was saved. " + r.message)
  r is ApiResult.Unreachable ->
    Acted.Failed("I couldn't tell whether that saved — ${r.said}. Look again before changing it twice.")
  else -> Acted.Failed(why(r))
}

/**
 * APPROVE A PROPOSED COIN — a read-modify-write, and the read is the dangerous half.
 *
 * `values.basketSymbols` is only set once an owner has EDITED their basket. For
 * everyone else it is absent and the agent trades the DEFAULT basket
 * implicitly. Reading it as an empty list therefore does not mean "no basket",
 * it means "the default basket", and writing that back replaces the default
 * basket (QQQ, NVDA, TSLA) with the single coin just approved. The web client
 * shipped exactly that bug; this is the same `?? defaults ?? empty` chain,
 * deliberately.
 *
 * `??` and not `||`: an owner who deliberately saved an EMPTY basket must keep
 * it, and an empty list is not the same as an absent one.
 *
 * TWO FIELDS, ONE WRITE. Adding to `customTokens` means "know about this";
 * adding to `basketSymbols` means "trade it". They are deliberately different
 * permissions, and approving a proposal is the owner saying both at once.
 *
 * FOR THE WALLET THE LIST WAS SHOWN TO. [shownFor] is who was signed in when
 * the proposals were read; if the settings now answer for anybody else, the
 * coins one wallet was shown are not written onto another's agent, and nothing
 * is saved. And the GET's `owner` goes back with the PUT, so a wallet that
 * signs in between the two gets a 409 and nothing written. The web sends
 * neither yet; the server takes the second.
 */
suspend fun approveProposals(repo: Repository, list: List<Proposal>, shownFor: String? = null): Acted {
  val cur = repo.api.settings()
  if (cur !is ApiResult.Ok) return Acted.Failed("could not read your settings — " + why(cur))
  val env = cur.value
  val readFor = env.owner
  if (shownFor != null && readFor != null && !readFor.equals(shownFor, ignoreCase = true)) {
    return Acted.Failed(
      "Your session changed since these were shown — nothing was saved. Look at the list again for the wallet signed in now.",
    )
  }

  val tokens = ((env.values as? JsonObject)?.get("customTokens") as? JsonArray)
    ?.mapNotNull { row ->
      val o = row as? JsonObject ?: return@mapNotNull null
      val sym = o["symbol"]?.jsonPrimitive?.content ?: return@mapNotNull null
      val addr = o["address"]?.jsonPrimitive?.content ?: return@mapNotNull null
      CustomToken(sym, addr, o["decimals"]?.jsonPrimitive?.content?.toIntOrNull() ?: 18)
    }
    ?.toMutableList() ?: mutableListOf()

  // The chain that matters: owner's value, else the DEFAULT, else empty.
  val basket = env.list("basketSymbols").toMutableList()
  // A GUARD FOR THE DAY THE SERVER STOPS SENDING defaults.basketSymbols: when
  // the key is absent ENTIRELY (not an owner's saved empty), seed the known
  // default rather than trust an empty read.
  if (basket.isEmpty() && env.raw("basketSymbols") == null) {
    basket.addAll(DEFAULT_BASKET_SYMBOLS)
  }

  for (p in list) {
    if (tokens.none { it.address.equals(p.token, ignoreCase = true) }) {
      tokens.add(CustomToken(p.symbol, p.token, p.decimals))
    }
    if (!basket.contains(p.symbol)) basket.add(p.symbol)
  }

  val patch = buildJsonObject {
    put("customTokens", buildJsonArray {
      tokens.forEach {
        add(buildJsonObject {
          put("symbol", JsonPrimitive(it.symbol))
          put("address", JsonPrimitive(it.address))
          put("decimals", JsonPrimitive(it.decimals))
        })
      }
    })
    put("basketSymbols", buildJsonArray { basket.forEach { add(JsonPrimitive(it)) } })
  }

  return when (val r = repo.api.patchSettings(patch, owner = env.owner)) {
    is ApiResult.Ok ->
      if (r.value.errors.isNotEmpty()) {
        Acted.Failed(r.value.errors.joinToString("\n"))
      } else if (r.value.ignored.isNotEmpty()) {
        Acted.Failed("Not saved: the server didn't recognise ${r.value.ignored.joinToString(", ")}.")
      } else {
        Acted.Ok(
          "Added. Your agent can watch and price it now — but it cannot BUY it until you " +
            "re-sign, because the permission is sealed into your key.",
        )
      }
    else -> settingsWriteFailed(r)
  }
}

/**
 * APPLY A RISK LEVEL: six settings from one word, never `level` itself.
 *
 * [owner] is the wallet the screen READ the current level for (the envelope's
 * `owner`), so the tap writes to the agent the owner was looking at — a wallet
 * that signed in since is refused (409) and nothing is written. When the
 * screen's read failed there is no such wallet yet, so the settings are read
 * first for it.
 */
suspend fun applyRisk(repo: Repository, level: String, owner: String?): Acted {
  val who = owner ?: when (val cur = repo.api.settings()) {
    is ApiResult.Ok -> cur.value.owner
    else -> return Acted.Failed("could not read your settings — " + why(cur))
  }
  return when (val r = repo.api.patchSettings(riskSettings(level), owner = who)) {
    is ApiResult.Ok ->
      if (r.value.errors.isNotEmpty()) Acted.Failed(r.value.errors.joinToString("\n"))
      else if (r.value.ignored.isNotEmpty()) Acted.Failed("Not saved: the server didn't recognise ${r.value.ignored.joinToString(", ")}.")
      else Acted.Ok("Saved. ${riskProfile(level).blurb}")
    else -> settingsWriteFailed(r)
  }
}

/** Loaded is used by callers that render through LoadedBlock. */
fun Acted.asLoaded(): Loaded<String> = when (this) {
  is Acted.Ok -> Loaded.Value(line)
  is Acted.Failed -> Loaded.Refused(400, line)
}

// ── the Trade screen: a card first, always ──────────────────────────────────

/**
 * WHAT THE TRADE SCREEN ASKS THE OWNER TO CONFIRM — the chat card's contract,
 * for an order typed rather than proposed.
 *
 * The screen used to POST /api/orders on the tap of Buy, and "Find it and buy"
 * bought whatever coin the lookup matched, unseen. Now every order is a card
 * first: the registry's sentence (side, coin, amount), real money or paper,
 * and the limit check, with [scope] bound to the owner the card was made for.
 */
data class TradeCard(
  /** buy | sell | snipe. A snipe's card places nothing; the coin it finds gets a card of its own. */
  val kind: String,
  /** The symbol, or for a snipe what was typed. */
  val subject: String,
  val usdg: Double,
  val sentence: String,
  val money: String,
  val limit: LimitCheck,
  val scope: ConfirmScope,
  val found: SnipeTarget? = null,
) {
  val canConfirm: Boolean get() = limit !is LimitCheck.Over
}

/** What opening a card came to: the card, or why there is none. */
sealed interface TradeOpen {
  data class Card(val card: TradeCard) : TradeOpen
  data class No(val line: String) : TradeOpen
}

/** What confirming came to: an order placed (or its answer lost), a found coin's own card, or a line. */
sealed interface TradeStep {
  data class Done(val placed: Placed) : TradeStep
  data class Next(val card: TradeCard) : TradeStep
  data class Said(val line: String) : TradeStep
}

private val TRADE_SYMBOL = Regex("^[A-Z0-9]{1,12}$")

/**
 * THE TRADE SCREEN'S FLOW, WITHOUT THE SCREEN, so a test can hold it to the
 * rules: opening a card READS (the ceiling and the grant — never a write),
 * confirming it is the only thing that places, and it places through the same
 * placeConfirmedOrder the chat uses, so the order is said and followed in the
 * thread whichever screen the owner is on.
 */
class TradeDesk(private val api: MerrymenApi, private val scopeNow: () -> ConfirmScope?) {
  suspend fun open(kind: String, subject: String, usdg: Double?): TradeOpen {
    val scope = scopeNow() ?: return TradeOpen.No("Sign in to trade — an order is placed for the wallet that confirms it.")
    if (usdg == null || !usdg.isFinite() || usdg <= 0) return TradeOpen.No("That isn't an amount I can trade.")
    val what = if (kind == "snipe") subject.trim() else subject.trim().uppercase()
    if (what.isEmpty() || (kind != "snipe" && !TRADE_SYMBOL.matches(what))) {
      return TradeOpen.No("That isn't a symbol I can look up — letters and digits, up to 12.")
    }
    val ceiling = api.orderCeiling()
    val grants = api.grants().let { (it as? ApiResult.Ok)?.value }
    return TradeOpen.Card(cardFor(kind, what, usdg, grants?.perTradeUsdg, ceiling, grants?.mode, scope, null))
  }

  /** Carry out [card] for its own owner. A snipe's lookup returns the found coin's card, never an order. */
  suspend fun confirm(card: TradeCard): TradeStep {
    if (!card.canConfirm) return TradeStep.Said((card.limit as LimitCheck.Over).line)
    val scope = card.scope
    if (card.kind == "snipe") {
      return when (val looked = lookupConfirmedSnipe(api, scope, card.subject, card.usdg)) {
        is Looked.Found -> {
          val ceiling = api.orderCeiling()
          val grants = api.grants().let { (it as? ApiResult.Ok)?.value }
          TradeStep.Next(cardFor("buy", looked.target.symbol, card.usdg, grants?.perTradeUsdg, ceiling, grants?.mode, scope, looked.target))
        }
        is Looked.Said -> TradeStep.Said(looked.line)
      }
    }
    val found = card.found
    val placed = placeConfirmedOrder(api, scope, card.kind, card.subject, card.usdg) { duplicate ->
      when {
        found != null && duplicate -> "${found.symbol} at ${found.short ?: found.address}. I already had that one queued, so I have not placed it twice."
        found != null -> "${found.symbol} at ${found.short ?: found.address}. Placed, not filled — my key's limits still decide, and I will tell you which."
        duplicate -> "That exact order is already queued — I have not placed a second one."
        else -> "Placed it — ${card.sentence} It is with my key now; the limits you signed decide whether it goes through, and I will tell you which."
      }
    }
    return TradeStep.Done(placed)
  }

  private fun cardFor(
    kind: String,
    subject: String,
    usdg: Double,
    perTrade: Double?,
    ceiling: Double?,
    mode: String?,
    scope: ConfirmScope,
    found: SnipeTarget?,
  ): TradeCard {
    val spec = COMMANDS.getValue(kind)
    val args = if (kind == "snipe") {
      mapOf("query" to subject, "usdgAmount" to usdg.toString())
    } else {
      mapOf("symbol" to subject, "usdgAmount" to usdg.toString())
    }
    return TradeCard(
      kind = kind,
      subject = subject,
      usdg = usdg,
      sentence = spec.say(args),
      money = moneyLine(mode),
      limit = orderLimit(if (kind == "sell") "sell" else "buy", usdg, perTrade, ceiling),
      scope = scope,
      found = found,
    )
  }
}
