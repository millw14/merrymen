package dev.merrymen.app.ui

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.Repository
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CustomToken
import dev.merrymen.app.net.Proposal
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * THE WRITE PATHS, IN ONE PLACE SO THEIR RULES ARE IN ONE PLACE.
 *
 * Each of these changes something real — money, or what the agent may trade —
 * and each has a rule that is easy to get subtly wrong. They live together so
 * the rules can be read together.
 */
sealed interface Acted {
  data class Ok(val line: String) : Acted
  data class Failed(val line: String) : Acted
  /** More than one coin answers to that name. Ask; never guess. */
  data class Ambiguous(val query: String, val candidates: List<String>, val line: String) : Acted
  /** The key does not cover it yet. A re-sign, not a failure. */
  data class NeedsSignature(val symbol: String, val line: String) : Acted
}

/** The default basket, from packages/core. The fallback of last resort so an
 *  absent defaults payload can never narrow the basket to one approved coin. */
private val DEFAULT_BASKET_SYMBOLS = listOf("QQQ", "NVDA", "TSLA")

/**
 * THE STATE SNAPSHOT THE CHAT MODEL IS BUILT AROUND.
 *
 * /api/chat's system prompt assembles itself from a client-supplied `state`, and
 * without it the agent answers blind — most consequentially about the BASKET,
 * where the prompt is explicit: a null basket means "I could not read it, say
 * so", but a MISSING basket made the model guess it was empty and tell an owner
 * their basket was empty while they were looking at it. So this mirrors
 * Agent.tsx's shape, and the one field that must be exactly right is
 * `basketSymbols`: the array when the settings carried it, JSON null when they
 * did not — never a guess.
 *
 * Built from the two reads the app already has (settings + feed). If either
 * cannot be read it returns null and the send degrades to the no-state path,
 * which is the documented fallback rather than a wrong snapshot.
 */
suspend fun buildChatState(repo: Repository): String? {
  val env = (repo.api.settings() as? ApiResult.Ok)?.value ?: return null
  val feed = (repo.api.feed() as? ApiResult.Ok)?.value
  val agent = feed?.agent
  return buildJsonObject {
    put("name", JsonPrimitive(agent?.name ?: "your agent"))
    put("equity", feed?.equityNow?.let { JsonPrimitive(it) } ?: JsonNull)
    put("strategy", JsonPrimitive(env.str("strategy") ?: agent?.strategy ?: ""))
    // THE FIELD THAT MUST NOT BE GUESSED. Present -> the array; absent -> null,
    // which the prompt reads as "unreadable, offer Settings" — not "empty".
    put(
      "basketSymbols",
      if (env.raw("basketSymbols") != null) {
        buildJsonArray { env.list("basketSymbols").forEach { add(JsonPrimitive(it)) } }
      } else {
        JsonNull
      },
    )
    put("paperTradingEnabled", env.bool("paperTradingEnabled")?.let { JsonPrimitive(it) } ?: JsonNull)
    put("workerStatus", JsonPrimitive("Unknown"))
    put(
      "positions",
      buildJsonArray {
        feed?.positions?.forEach { p ->
          add(buildJsonObject {
            put("symbol", JsonPrimitive(p.symbol))
            put("valueUsd", p.valueUsdg?.let { JsonPrimitive(it) } ?: JsonNull)
            put("priceStale", JsonPrimitive(p.priceStale))
          })
        }
      },
    )
  }.toString()
}

private fun why(r: ApiResult<*>): String = when (r) {
  is ApiResult.Refused -> r.message
  is ApiResult.Unreachable -> "couldn't reach merrymen: " + r.cause
  else -> "unknown"
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
 * deliberately. (The default is 3 symbols, not the ~24 of the full stock
 * universe — an earlier version of this note had that number wrong.)
 *
 * `??` and not `||`: an owner who deliberately saved an EMPTY basket must keep
 * it, and an empty list is not the same as an absent one.
 *
 * TWO FIELDS, ONE WRITE. Adding to `customTokens` means "know about this";
 * adding to `basketSymbols` means "trade it". They are deliberately different
 * permissions, and approving a proposal is the owner saying both at once.
 */
suspend fun approveProposals(repo: Repository, list: List<Proposal>): Acted {
  val cur = repo.api.settings()
  if (cur !is ApiResult.Ok) return Acted.Failed("could not read your settings — " + why(cur))
  val env = cur.value

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
  // A GUARD FOR THE DAY THE SERVER STOPS SENDING defaults.basketSymbols. The
  // preservation above rests entirely on that payload; if a deploy drops it,
  // the key is absent on both sides, the list reads empty, and approving one
  // coin would write a one-leg basket — the very narrowing this whole function
  // exists to prevent. When the key is absent ENTIRELY (not an owner's saved
  // empty), seed the known default rather than trust an empty read.
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

  return when (val r = repo.api.patchSettings(patch)) {
    is ApiResult.Ok ->
      if (r.value.errors.isEmpty()) {
        Acted.Ok(
          "Added. Your agent can watch and price it now — but it cannot BUY it until you " +
            "re-sign, because the permission is sealed into your key.",
        )
      } else {
        Acted.Failed(r.value.errors.joinToString("\n"))
      }
    else -> Acted.Failed(why(r))
  }
}

/**
 * PLACE AN ORDER, then follow it.
 *
 * The POST only QUEUES it: the worker claims the command on its next tick and
 * the wall decides. So "queued" is not "filled", and this returns the id so the
 * caller can poll rather than implying an outcome it does not have.
 */
suspend fun placeOrder(repo: Repository, side: String, symbol: String, usdg: Double): Pair<Acted, String?> {
  return when (val r = repo.api.order(side, symbol, usdg)) {
    is ApiResult.Ok ->
      if (r.value.queued) {
        val dup = if (r.value.duplicate) " (you had already placed this one — same order, not a second)" else ""
        Acted.Ok("Placed with your agent$dup. Your key's limits still decide whether it goes through.") to r.value.id
      } else {
        Acted.Failed(r.value.error ?: "it was not queued") to null
      }
    else -> Acted.Failed(why(r)) to null
  }
}

/**
 * SNIPE — resolve a name to a coin, then place, and ASK rather than guess.
 *
 * Four outcomes and only one of them buys anything. The other three are the
 * point of the endpoint: two coins with the same name is a question, and a coin
 * the signature does not cover is a re-sign, not an error.
 */
suspend fun snipe(repo: Repository, query: String, usdg: Double): Pair<Acted, String?> {
  val r = repo.api.snipe(query, usdg)
  if (r !is ApiResult.Ok) return Acted.Failed(why(r)) to null
  val out = r.value
  return when (out.outcome) {
    "resolved" -> {
      val t = out.target ?: return Acted.Failed("resolved to nothing") to null
      val (acted, id) = placeOrder(repo, "buy", t.symbol, out.usdgAmount ?: usdg)
      // KEEP THE ROUTE'S OWN WORDS. `say` carries which coin it matched and why
      // ("on its name, not its ticker") — context a bare "Placed" drops. When
      // the order went in, lead with that so the reader knows what was targeted.
      if (acted is Acted.Ok && !out.say.isNullOrBlank()) Acted.Ok(out.say + "\n" + acted.line) to id
      else acted to id
    }
    "ambiguous" -> Acted.Ambiguous(
      out.query ?: query,
      out.candidates.map { it.symbol + (if (it.covered) " (covered)" else "") },
      out.say ?: "More than one coin answers to that name.",
    ) to null
    "needs-signature" -> Acted.NeedsSignature(
      out.target?.symbol ?: query,
      out.say ?: "Your key does not cover that coin yet.",
    ) to null
    else -> Acted.Failed(out.say ?: out.error ?: "nothing answered to that name") to null
  }
}

/** Apply a risk level: six settings from one word. Never sends `level` itself. */
suspend fun applyRisk(repo: Repository, level: String): Acted =
  when (val r = repo.api.patchSettings(riskSettings(level))) {
    is ApiResult.Ok ->
      if (r.value.errors.isEmpty()) Acted.Ok("Set to ${riskProfile(level).name.lowercase()}.")
      else Acted.Failed(r.value.errors.joinToString("\n"))
    else -> Acted.Failed(why(r))
  }

/**
 * Run a chat command the owner has just confirmed.
 *
 * `navigate` returns the web path rather than acting: the caller decides
 * whether that is a native screen or a WebView handoff.
 */
suspend fun runCommand(
  repo: Repository,
  spec: CommandSpec,
  args: Map<String, String>,
): Pair<Acted, String?> = when (spec.via) {
  Via.SETTINGS -> when (val r = repo.api.patchSettings(settingsPayload(spec, args))) {
    is ApiResult.Ok ->
      if (r.value.errors.isEmpty()) Acted.Ok("Done.") to null
      else Acted.Failed(r.value.errors.joinToString("\n")) to null
    else -> Acted.Failed(why(r)) to null
  }
  Via.ORDER -> placeOrder(
    repo,
    spec.fixed["side"]?.jsonPrimitive?.content ?: args["side"] ?: "buy",
    args["symbol"].orEmpty(),
    args["usdgAmount"]?.toDoubleOrNull() ?: 0.0,
  )
  Via.SNIPE -> snipe(repo, args["query"].orEmpty(), args["usdgAmount"]?.toDoubleOrNull() ?: 0.0)
  Via.NAVIGATE -> Acted.Ok("") to spec.to
  // AN ID THIS BUILD DOES NOT KNOW IS REFUSED, NOT GUESSED. A newer server can
  // propose a command this client has never heard of; acting on it by pattern
  // would be acting on something nobody here has reviewed.
  Via.UNKNOWN -> Acted.Failed(
    "This version of the app doesn't know the command \"${spec.id}\". Update the app, or do it " +
      "from the web screen.",
  ) to null
}

/** Loaded is used by callers that render through LoadedBlock. */
fun Acted.asLoaded(): Loaded<String> = when (this) {
  is Acted.Ok -> Loaded.Value(line)
  is Acted.Failed -> Loaded.Refused(400, line)
  is Acted.Ambiguous -> Loaded.Value(line)
  is Acted.NeedsSignature -> Loaded.Value(line)
}
