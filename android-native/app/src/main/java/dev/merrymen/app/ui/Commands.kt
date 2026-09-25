package dev.merrymen.app.ui

import dev.merrymen.app.data.usdCents
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * THE AGENT PROPOSES, THE OWNER TAPS, THE APP ACTS.
 *
 * This is the whole mechanism by which chat can change anything, and it was
 * missing from this client entirely: the API already returned `command`
 * alongside `reply` and we parsed it into a JsonElement and threw it away, so
 * the agent could say "I'll switch you to dip-hunter" and nothing ever
 * happened.
 *
 * THE MODEL NEVER ACTS. It appends a marker to its reply; the SERVER parses and
 * scrubs that marker (splitCommand, in /api/chat) and hands us `{id, args}`
 * already separated. So this client does no marker parsing at all — it renders
 * a card and waits for a human tap. That asymmetry is the security boundary,
 * and moving any part of it client-side would weaken it.
 *
 * WHY THE TABLE IS MIRRORED HERE RATHER THAN FETCHED. The registry lives in
 * web/src/lib/chat-commands.ts and there is no endpoint that serves it. Copying
 * it risks drift, so the copy fails SAFE: an id this table does not know still
 * renders a card — naming the id and its arguments — and is refused rather
 * than guessed at. A new server command shows up as something the owner can
 * see and decline, never as a silent no-op and never as an action taken on a
 * guess. CommandsMirrorTest holds the ids, their order and their routes to the
 * web file.
 */

enum class Via { SETTINGS, ORDER, SNIPE, NAVIGATE, UNKNOWN }

data class CommandSpec(
  val id: String,
  val via: Via,
  /** The settings keys this command may write. Nothing else is ever sent. */
  val writes: List<String> = emptyList(),
  /** Values the command itself decides, which the model may not override. */
  val fixed: Map<String, JsonElement> = emptyMap(),
  /** Where a navigate command goes, as a web path. */
  val to: String? = null,
  /** Weighty commands move money or change what the agent may trade. */
  val weighty: Boolean = false,
  /**
   * What a navigate command's page is called in the app's header — the name
   * the rest of the app gives the same web page, never the command's id.
   */
  val title: String? = null,
  val say: (Map<String, String>) -> String,
)

/** basketSymbols arrives as "TSLA,NVDA" and the API refuses anything but a list. */
private val LIST_FIELDS = setOf("basketSymbols")

/**
 * Settings that are STRINGS even when they look like numbers. `agentName` "007"
 * and a strategy id must not be coerced to a JSON number by settingsPayload, or
 * the validator refuses the wrong-typed value. A NEW name now needs a letter
 * (the server says so), but an agent already called "007" keeps it, and every
 * save re-sends that name — coerced to a number, it would block the whole save.
 */
private val STRING_FIELDS = setOf("agentName", "strategy")

/** The holder-only strategies (web/src/terminal/strategy.ts CIRCLE_STRATEGY_IDS). */
val CIRCLE_STRATEGIES = setOf("even-keel", "dip-hunter")

/**
 * A figure as the web's template literal prints it: `${n / 100}` gives "1"
 * for one and "0.5" for a half, never "1.0". The card's sentences are the
 * web's word for word, numbers included.
 */
internal fun jsNumber(n: Double): String = when {
  n.isNaN() -> "NaN"
  n.isInfinite() -> if (n > 0) "Infinity" else "-Infinity"
  n == Math.rint(n) && kotlin.math.abs(n) < 1e15 -> n.toLong().toString()
  else -> n.toString()
}

/** The web's `money(a.x)`: usd(Number(x)) — "$5.00", or "—" for a value that is not a number. */
private fun money(a: Map<String, String>, k: String): String =
  a[k]?.trim()?.toDoubleOrNull()?.takeIf { it.isFinite() }?.let(::usdCents) ?: "—"

/** `String(a.x)`: what the model sent, as text. A proposal only arrives complete. */
private fun arg(a: Map<String, String>, k: String): String = a[k] ?: "undefined"

/** `Number(a.x) / 100`, printed as the web prints it. */
private fun hundredths(a: Map<String, String>, k: String): String =
  jsNumber((a[k]?.trim()?.toDoubleOrNull() ?: Double.NaN) / 100)

/**
 * THE SENTENCES ARE THE WEB'S, WORD FOR WORD (web/src/lib/chat-commands.ts).
 *
 * An owner who confirms "Spend $5.00 buying TSLA" on the phone must be agreeing
 * to exactly what an owner on the web agrees to. These had drifted — the
 * slippage card said "bps" where the web says "%", the sell card promised a
 * clamp and never mentioned that a curve coin sells whole, and the snipe card
 * left out that it asks rather than guesses — which is what a hand-copied
 * sentence does when nothing holds it.
 */
val COMMANDS: Map<String, CommandSpec> = listOf(
  CommandSpec("set-strategy", Via.SETTINGS, listOf("strategy"), weighty = true) {
    // A holder-only strategy runs only while you hold enough $MERRYMEN, so
    // picking it can mean the agent sits idle. Saying so on the card is the
    // difference between an informed switch and a silent stall.
    "Switch me to the ${arg(it, "strategy")} strategy. It changes what I trade and when." +
      if (it["strategy"] in CIRCLE_STRATEGIES) {
        " Note: that one only runs while you hold \$MERRYMEN — below that I stay idle, however well funded I am."
      } else {
        ""
      }
  },
  CommandSpec("set-basket", Via.SETTINGS, listOf("basketSymbols"), weighty = true) {
    "Trade this basket from now on: ${arg(it, "basketSymbols").split(",").joinToString(", ")}. " +
      "Anything not on that list I stop buying."
  },
  // ── THE TWO THAT DECIDE WHETHER REAL MONEY MOVES ────────────────────────
  //
  // Mirrors of web/src/lib/chat-commands.ts, which is the authority. They drifted
  // once and it is worth saying how, because the shape recurs: BOTH used to write
  // `paperTradingEnabled` alone, back when that was the only field there was.
  //
  // `paperTradingEnabled` is permission to SIMULATE. It is consulted only after
  // `canTradeForReal` has already failed, and it is never a term of it
  // (worker/src/exec-mode.ts). So writing it alone means "go-paper" did not stop
  // real orders and "go-live" did not start them — the first left an owner who
  // asked for practice still spending real money, and the second, once the
  // consent gate landed, left an agent that neither trades nor practises.
  //
  // `liveTradingEnabled` is the mode. It is the half both commands were asking
  // for, and the half neither of them wrote.
  CommandSpec(
    "go-paper", Via.SETTINGS, listOf("paperTradingEnabled", "liveTradingEnabled"),
    fixed = mapOf(
      "paperTradingEnabled" to JsonPrimitive(true),
      "liveTradingEnabled" to JsonPrimitive(false),
    ),
    weighty = true,
  ) {
    "Paper mode from now on: I will practise with simulated money at live prices and place no " +
      "real orders, whatever is in the account. If I am holding anything bought with real funds " +
      "I will stop managing it too — no stop-loss, no take-profit — until you turn Live trading " +
      "back on. Nothing is sold either way."
  },
  // NOT `paperTradingEnabled: false`, deliberately, and the same as the web
  // registry: falling back to practice when a leg breaks is still the kinder
  // behaviour, and it is no longer how anyone ends up trading real money by
  // accident.
  CommandSpec(
    "go-live", Via.SETTINGS, listOf("liveTradingEnabled"),
    fixed = mapOf("liveTradingEnabled" to JsonPrimitive(true)), weighty = true,
  ) {
    "Trade for real from now on, within the caps you signed — real money, real orders on " +
      "Robinhood Chain. Say \"go paper\" to put me back to practising."
  },
  CommandSpec("set-slippage", Via.SETTINGS, listOf("slippageBps"), weighty = true) {
    "Refuse a fill worse than ${hundredths(it, "slippageBps")}% off the quote."
  },
  CommandSpec("set-impact", Via.SETTINGS, listOf("maxImpactBps"), weighty = true) {
    "Refuse any trade where my own order would move the price more than ${hundredths(it, "maxImpactBps")}%."
  },
  CommandSpec("set-size", Via.SETTINGS, listOf("buyPerTickUsdg"), weighty = true) {
    "Put ${money(it, "buyPerTickUsdg")} to work each time I trade."
  },
  CommandSpec(
    "set-risk", Via.SETTINGS,
    listOf(
      "strategistStopLossBps", "takeProfitBps", "buyPerTickUsdg",
      "llmMaxActionUsdg", "slippageBps", "maxImpactBps",
    ),
    weighty = true,
  ) { a ->
    val p = riskProfile(a["level"])
    "Set me to ${p.name.lowercase()}: ${p.blurb.lowercase()} That is my sizing and my two exit " +
      "rules — sell at ${p.stopLossBps / 100}% down or ${p.takeProfitBps / 100}% up. It does NOT " +
      "touch the per-trade and per-day caps sealed into my key; only a new signature can move those."
  },
  CommandSpec("rename", Via.SETTINGS, listOf("agentName")) {
    "Call me ${arg(it, "agentName")} from now on."
  },
  // ── the two that spend money, and the one that finds a coin first ───────
  //
  // Their sentences say WHAT IS NOT YET TRUE. "I'll place it" is honest;
  // "bought" would be a claim about somebody's money made by a phone, a minute
  // before the ledger has an opinion.
  CommandSpec(
    "buy", Via.ORDER, listOf("side", "symbol", "usdgAmount"),
    fixed = mapOf("side" to JsonPrimitive("buy")), weighty = true,
  ) {
    "Spend ${money(it, "usdgAmount")} buying ${arg(it, "symbol").uppercase()}. " +
      "I'll place it — my key's limits still decide whether it goes through."
  },
  CommandSpec("snipe", Via.SNIPE, listOf("query", "usdgAmount"), weighty = true) {
    "Go after ${arg(it, "query").uppercase()} with ${money(it, "usdgAmount")}. " +
      "I'll find which coin you mean first — if more than one answers to that name I'll ask " +
      "rather than guess, and if my key doesn't cover it yet I'll tell you what it needs."
  },
  // THE SIZE CAN COME OUT DIFFERENT IN EITHER DIRECTION, and the card is the
  // last chance to say so: a stock sell clamps down to the position, and a
  // bonding-curve coin can only be sold whole.
  CommandSpec(
    "sell", Via.ORDER, listOf("side", "symbol", "usdgAmount"),
    fixed = mapOf("side" to JsonPrimitive("sell")), weighty = true,
  ) {
    "Sell ${money(it, "usdgAmount")} of ${arg(it, "symbol").uppercase()}. " +
      "If that is more than you hold I sell what is there, and if it is a coin on a bonding curve " +
      "I have to sell the whole position — I'll tell you which happened. I'll place it; my key's " +
      "limits still decide."
  },
  CommandSpec("open-deposit", Via.NAVIGATE, to = "/deposit", title = "Add funds") { "Show you where to send funds." },
  CommandSpec("open-withdraw", Via.NAVIGATE, to = "/withdraw", weighty = true, title = "Withdraw") {
    "Take you to the withdraw screen. I cannot send it from chat — moving money out needs a " +
      "permission sealed into my key when you signed, and most keys carry none."
  },
  CommandSpec("open-settings", Via.NAVIGATE, to = "/settings", title = "Settings") {
    "Open your settings, where every dial I have is listed."
  },
  CommandSpec("open-limits", Via.NAVIGATE, to = "/limits", title = "Trading limits") { "Show you the spending limits sealed into my key." },
  CommandSpec("show-address", Via.NAVIGATE, to = "/grant", title = "Wallet & permissions") { "Show you my account address." },
  CommandSpec("reveal-key", Via.NAVIGATE, to = "/grant", weighty = true, title = "Wallet & permissions") {
    "Take you to your owner key on the wallet page. I will not print it in chat — it would go " +
      "through my brain and be saved in this conversation, and that key is the money."
  },
  CommandSpec("resign", Via.NAVIGATE, to = "/grant#resign", weighty = true, title = "Re-sign") {
    "Take you to re-sign my trading permission — free, one signature, nothing moves on-chain."
  },
).associateBy { it.id }

/**
 * The risk table, mirrored from packages/core/src/risk-level.ts.
 *
 * `set-risk` expands one word into six settings on the CLIENT — the server has
 * no endpoint that does it — so this client has to know the same numbers. If
 * they ever diverge, the web and the app would write different books under the
 * same word, which is why the values are here in full rather than approximated,
 * and why RiskLevelTest reads the core file and compares.
 */
data class RiskProfile(
  val level: String,
  val name: String,
  val blurb: String,
  val stopLossBps: Int,
  val takeProfitBps: Int,
  val buyPerTickUsdg: Int,
  val llmMaxActionUsdg: Int,
  val slippageBps: Int,
  val maxImpactBps: Int,
)

val RISK_PROFILES = listOf(
  RiskProfile("careful", "Careful", "Small positions, quick to take a profit, quick to cut a loss.", 1_500, 1_200, 10, 10, 50, 150),
  RiskProfile("balanced", "Balanced", "The default. Room to be wrong, without betting the book on one name.", 2_500, 2_000, 25, 50, 100, 300),
  RiskProfile("bold", "Bold", "Bigger positions and more room before a rule sells — including through a bad week.", 3_500, 4_000, 50, 100, 200, 500),
)

fun riskProfile(level: String?): RiskProfile =
  RISK_PROFILES.firstOrNull { it.level == level?.trim()?.lowercase() } ?: RISK_PROFILES[1]

fun riskSettings(level: String?): JsonObject {
  val p = riskProfile(level)
  return buildJsonObject {
    put("strategistStopLossBps", JsonPrimitive(p.stopLossBps))
    put("takeProfitBps", JsonPrimitive(p.takeProfitBps))
    put("buyPerTickUsdg", JsonPrimitive(p.buyPerTickUsdg))
    put("llmMaxActionUsdg", JsonPrimitive(p.llmMaxActionUsdg))
    put("slippageBps", JsonPrimitive(p.slippageBps))
    put("maxImpactBps", JsonPrimitive(p.maxImpactBps))
  }
}

/**
 * WHICH RUNG THE OWNER'S DIALS SIT ON — core's levelOf, read the way the web's
 * risk panel reads it: the owner's saved `values` alone, all six matching
 * exactly.
 *
 * Null for a hand-tuned book, and null is shown as "set by hand", never
 * rounded to the nearest rung: a screen that highlighted the closest level
 * would invite one tap that silently moves five dials. Not `values ?? defaults`
 * — the web's panel does not fill from defaults either, and the house default
 * dials (no stop-loss armed) are not a rung anyway.
 */
fun riskLevelOf(values: JsonElement?): String? {
  val v = values as? JsonObject ?: return null
  fun n(k: String) = (v[k] as? JsonPrimitive)?.content?.trim()?.toDoubleOrNull()
  return RISK_PROFILES.firstOrNull { p ->
    n("strategistStopLossBps") == p.stopLossBps.toDouble() &&
      n("takeProfitBps") == p.takeProfitBps.toDouble() &&
      n("buyPerTickUsdg") == p.buyPerTickUsdg.toDouble() &&
      n("llmMaxActionUsdg") == p.llmMaxActionUsdg.toDouble() &&
      n("slippageBps") == p.slippageBps.toDouble() &&
      n("maxImpactBps") == p.maxImpactBps.toDouble()
  }?.level
}

/**
 * The settings body for a command — only its declared keys, `fixed` last.
 *
 * Mirrors commandPayload. Two rules are load-bearing: an argument the command
 * does not declare is DROPPED (a model must not be able to write a field by
 * naming it), and `fixed` is applied after the model's arguments so that for
 * go-live and go-paper the value is the command's meaning rather than the
 * model's to choose.
 */
fun settingsPayload(spec: CommandSpec, args: Map<String, String>): JsonObject = buildJsonObject {
  if (spec.id == "set-risk") {
    // Derived from one word, and `level` itself is deliberately not written:
    // it is not a setting, and the API rejects unknown keys.
    riskSettings(args["level"]).forEach { (k, v) -> put(k, v) }
    return@buildJsonObject
  }
  for (key in spec.writes) {
    val raw = args[key] ?: continue
    if (key in LIST_FIELDS) {
      put(key, buildJsonArray {
        raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.forEach { add(JsonPrimitive(it)) }
      })
    } else {
      // Numbers must go as numbers: the validator checks the type and a quoted
      // number is refused as the wrong shape. But a STRING field that happens to
      // parse as a number (agentName "007") must stay a string, or the same
      // type check refuses it — coerce by the field's kind, not by whether the
      // text parses.
      val n = if (key in STRING_FIELDS) null else raw.toDoubleOrNull()
      put(key, if (n != null) JsonPrimitive(n) else JsonPrimitive(raw))
    }
  }
  spec.fixed.forEach { (k, v) -> put(k, v) }
}
