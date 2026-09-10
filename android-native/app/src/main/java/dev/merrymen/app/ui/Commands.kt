package dev.merrymen.app.ui

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
 * it risks drift, so the copy is deliberately partial and fails SAFE: an id
 * this table does not know still renders a card — naming the id and its
 * arguments — and is refused rather than guessed at. A new server command shows
 * up as something the owner can see and decline, never as a silent no-op and
 * never as an action taken on a guess.
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
  val say: (Map<String, String>) -> String,
)

/** basketSymbols arrives as "TSLA,NVDA" and the API refuses anything but a list. */
private val LIST_FIELDS = setOf("basketSymbols")

/**
 * Settings that are STRINGS even when they look like numbers. `agentName` "007"
 * and a strategy id must not be coerced to a JSON number by settingsPayload, or
 * the validator refuses the wrong-typed value — a rename to an all-digits name
 * would silently fail.
 */
private val STRING_FIELDS = setOf("agentName", "strategy")

/** The holder-only strategies, from packages/core's risk/circle config. */
val CIRCLE_STRATEGIES = setOf("even-keel", "dip-hunter")

private fun money(a: Map<String, String>, k: String) = a[k]?.let { "$$it" } ?: "the amount"

val COMMANDS: Map<String, CommandSpec> = listOf(
  CommandSpec("set-strategy", Via.SETTINGS, listOf("strategy"), weighty = true) {
    val s = it["strategy"] ?: "chosen"
    val base = "Switch me to the $s strategy. It changes what I trade and when."
    // The same caveat the web card appends: a holder-only strategy runs only
    // while you hold enough $MERRYMEN, so picking it can mean the agent sits
    // idle. Saying so on the card is the difference between an informed switch
    // and a silent stall.
    if (s in CIRCLE_STRATEGIES) {
      "$base But that one only runs while you hold enough \$MERRYMEN — below that I stay idle."
    } else {
      base
    }
  },
  CommandSpec("set-basket", Via.SETTINGS, listOf("basketSymbols"), weighty = true) {
    "Trade this basket from now on: ${it["basketSymbols"] ?: "—"}. Anything not on that list I stop buying."
  },
  CommandSpec(
    "go-paper", Via.SETTINGS, listOf("paperTradingEnabled"),
    fixed = mapOf("paperTradingEnabled" to JsonPrimitive(true)), weighty = true,
  ) { "Let me fall back to practice fills when I cannot trade for real." },
  CommandSpec(
    "go-live", Via.SETTINGS, listOf("paperTradingEnabled"),
    fixed = mapOf("paperTradingEnabled" to JsonPrimitive(false)), weighty = true,
  ) { "Stop simulating. If I cannot trade for real I will do nothing instead of practising." },
  CommandSpec("set-slippage", Via.SETTINGS, listOf("slippageBps"), weighty = true) {
    "Refuse a fill worse than ${it["slippageBps"] ?: "—"} bps off the quote."
  },
  CommandSpec("set-impact", Via.SETTINGS, listOf("maxImpactBps"), weighty = true) {
    "Refuse any trade where my own order would move the price more than ${it["maxImpactBps"] ?: "—"} bps."
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
    "Call me ${it["agentName"] ?: "that"} from now on."
  },
  CommandSpec(
    "buy", Via.ORDER, listOf("side", "symbol", "usdgAmount"),
    fixed = mapOf("side" to JsonPrimitive("buy")), weighty = true,
  ) {
    "Spend ${money(it, "usdgAmount")} buying ${it["symbol"] ?: "it"}. I'll place it — my key's " +
      "limits still decide whether it goes through."
  },
  CommandSpec(
    "sell", Via.ORDER, listOf("side", "symbol", "usdgAmount"),
    fixed = mapOf("side" to JsonPrimitive("sell")), weighty = true,
  ) {
    "Sell ${money(it, "usdgAmount")} of ${it["symbol"] ?: "it"}. A stock sell clamps down to the " +
      "position, and a bonding-curve coin has to be sold whole."
  },
  CommandSpec("snipe", Via.SNIPE, listOf("query", "usdgAmount"), weighty = true) {
    "Go after ${it["query"] ?: "that"} with ${money(it, "usdgAmount")}. I'll find which coin you mean first."
  },
  CommandSpec("open-deposit", Via.NAVIGATE, to = "/deposit") { "Show you where to send funds." },
  CommandSpec("open-withdraw", Via.NAVIGATE, to = "/withdraw", weighty = true) {
    "Take you to the withdraw screen. I cannot send it from chat — moving money out needs a " +
      "permission sealed into my key when you signed, and most keys carry none."
  },
  CommandSpec("open-settings", Via.NAVIGATE, to = "/settings") { "Open your settings." },
  CommandSpec("open-limits", Via.NAVIGATE, to = "/limits") { "Show you the spending limits sealed into my key." },
  CommandSpec("show-address", Via.NAVIGATE, to = "/grant") { "Show you my account address." },
  CommandSpec("reveal-key", Via.NAVIGATE, to = "/grant", weighty = true) {
    "Take you to your owner key on the wallet page. I will not print it in chat."
  },
  CommandSpec("resign", Via.NAVIGATE, to = "/grant#resign", weighty = true) {
    "Take you to re-sign my trading permission — free, one signature, nothing moves on-chain."
  },
).associateBy { it.id }

/**
 * The risk table, mirrored from packages/core/src/risk-level.ts.
 *
 * `set-risk` expands one word into six settings on the CLIENT — the server has
 * no endpoint that does it — so this client has to know the same numbers. If
 * they ever diverge, the web and the app would write different books under the
 * same word, which is why the values are here in full rather than approximated.
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
