package dev.merrymen.app.ui

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.SettingsSaved
import dev.merrymen.app.net.putSettingsOnce
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * ONE EDIT SESSION OF THE SETTINGS FORM — what the owner touched, and nothing
 * else — with every rule about what a save may send, where a test runs it.
 *
 * WRITING IS A PATCH. The PUT handler reads each key with `if ("name" in
 * body)`, so a key left out is left alone; the danger is the opposite one,
 * echoing back a value nobody touched (a masked secret, a default the owner
 * never chose). So [edits] starts empty and only a control that moved puts
 * anything in it, exactly as the web form's `null = untouched this session`.
 *
 * Immutable, so a screen holds it in one piece of state and a test drives it
 * without Compose.
 */
data class SettingsDraft(
  /** The keys the owner changed, as the JSON they will be sent as. */
  val edits: Map<String, JsonElement> = emptyMap(),
  /** What was typed into each number box, kept even while it is not a number yet. */
  val numberText: Map<String, String> = emptyMap(),
  /** Number boxes whose text this form cannot send, and why. A save is refused while any remain. */
  val unreadable: Map<String, String> = emptyMap(),
  /**
   * The owner asked to publish the book and has not yet said "Publish my book".
   * The request alone sends nothing: see [askPublicBook].
   */
  val publicBookAsked: Boolean = false,
) {
  val dirty: Boolean get() = edits.isNotEmpty() || unreadable.isNotEmpty()

  fun set(key: String, value: JsonElement): SettingsDraft = copy(edits = edits + (key to value))

  fun setBool(key: String, on: Boolean): SettingsDraft = set(key, JsonPrimitive(on))

  fun setText(key: String, value: String): SettingsDraft = set(key, JsonPrimitive(value))

  fun setList(key: String, values: List<String>): SettingsDraft = set(key, JsonArray(values.map { JsonPrimitive(it) }))

  /**
   * A NUMBER, SENT AS A JSON NUMBER — never the owner's keystrokes.
   *
   * The route stores a JSON number as-is and parses a STRING with its own
   * locale rules, and a string is where "25.000" once became twenty-five. So
   * this reads the text itself, with a point as the only decimal mark, and a
   * box it cannot read blocks the save and says why, rather than being sent as
   * typed or silently dropped. A blank box is untouched, not "clear to default".
   * [integer] fields refuse a fraction: a count of positions is whole.
   */
  fun setNumber(key: String, raw: String, integer: Boolean = false): SettingsDraft {
    val text = raw.trim()
    val keptText = numberText + (key to raw)
    if (text.isEmpty()) return copy(edits = edits - key, numberText = keptText, unreadable = unreadable - key)
    val readable = Regex("^-?\\d+(\\.\\d+)?$").matches(text)
    val value = if (readable) text.toBigDecimalOrNull() else null
    if (value == null) {
      return copy(edits = edits - key, numberText = keptText, unreadable = unreadable + (key to "not a number this form can read — use digits, and a point for decimals"))
    }
    if (integer && value.stripTrailingZeros().scale() > 0) {
      return copy(edits = edits - key, numberText = keptText, unreadable = unreadable + (key to "a whole number"))
    }
    val json = if (integer) JsonPrimitive(value.toLong()) else JsonPrimitive(value.toDouble())
    return copy(edits = edits + (key to json), numberText = keptText, unreadable = unreadable - key)
  }

  /**
   * PUBLISHING THE BOOK IS A CONSENT, SO IT TAKES TWO STEPS.
   *
   * Turning it on puts this agent's trade sizes, dollar P&L and holdings on
   * public pages. The first tap only shows what that reveals
   * ([PUBLIC_BOOK_ON]) beside a "Publish my book" button; nothing reaches the
   * patch until [confirmPublicBook]. Turning it OFF needs no confirmation:
   * taking something out of public view is never the step to guard.
   */
  fun askPublicBook(): SettingsDraft = copy(publicBookAsked = true)

  fun confirmPublicBook(): SettingsDraft = copy(publicBookAsked = false, edits = edits + ("publicBook" to JsonPrimitive(true)))

  fun cancelPublicBook(): SettingsDraft = copy(publicBookAsked = false)

  fun publicBookOff(): SettingsDraft = copy(publicBookAsked = false, edits = edits + ("publicBook" to JsonPrimitive(false)))

  /** Drop what was saved (or looked up and found saved), keeping only what still differs. */
  fun without(keys: Collection<String>): SettingsDraft =
    copy(edits = edits - keys.toSet(), numberText = numberText - keys.toSet())

  /** The body a save would send, or why it may not go. */
  fun submission(): SettingsSubmission {
    if (unreadable.isNotEmpty()) {
      return SettingsSubmission.Blocked(unreadable.map { (k, why) -> "${settingLabel(k)}: $why" })
    }
    if (edits.isEmpty()) return SettingsSubmission.Blocked(listOf("Nothing changed yet."))
    return SettingsSubmission.Ready(JsonObject(edits))
  }
}

sealed interface SettingsSubmission {
  data class Ready(val patch: JsonObject) : SettingsSubmission
  data class Blocked(val why: List<String>) : SettingsSubmission
}

/**
 * A SETTING AS THE FORM SHOWS IT: the edit if the owner made one, else the
 * stored value, else the default. `values ?? defaults` is doing real work —
 * officialCoinsEnabled defaults ON, so a stored-nothing read as false would
 * draw the box unticked while the worker trades the list.
 */
class SettingsShown(private val env: SettingsEnvelope, private val draft: SettingsDraft) {
  fun bool(key: String): Boolean =
    (draft.edits[key] as? JsonPrimitive)?.booleanOrNull ?: env.bool(key) ?: false

  /** What is SAVED, ignoring the draft — the side of a warning that says "before you save". */
  fun savedBool(key: String): Boolean = env.bool(key) ?: false

  fun str(key: String): String =
    (draft.edits[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: env.str(key) ?: ""

  fun numberText(key: String): String =
    draft.numberText[key] ?: env.num(key)?.let { plainNumber(it) } ?: ""

  /**
   * The value in force for a range check: the edit, else what is stored. Null
   * while the box holds text this form cannot read — there is no value to judge.
   */
  fun number(key: String): Double? {
    if (key in draft.unreadable) return null
    return (draft.edits[key] as? JsonPrimitive)?.doubleOrNull ?: env.num(key)
  }

  fun list(key: String): List<String> =
    (draft.edits[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: env.list(key)
}

/** A stored figure as the box shows it: no ".0" on a whole number, no exponent on a big one. */
fun plainNumber(v: Double): String =
  if (v % 1.0 == 0.0 && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toBigDecimal().stripTrailingZeros().toPlainString()

// ── the numeric fields ─────────────────────────────────────────────────────

/**
 * The bounds the server enforces (web/src/app/api/settings/route.ts NUM_FIELDS),
 * mirrored so a box can say them before the round trip. The server stays the
 * authority: an out-of-range value is flagged here and refused there with its
 * own sentence, never silently clamped.
 */
val SETTINGS_RANGES: Map<String, ClosedFloatingPointRange<Double>> = mapOf(
  "buyPerTickUsdg" to 1.0..100_000.0,
  // SLIPPAGE_BPS_MAX = 1_000 (packages/core settings.ts). It was 5_000 here,
  // which invited a value the server then refused.
  "slippageBps" to 1.0..1_000.0,
  "maxImpactBps" to 0.0..10_000.0,
  "takeProfitBps" to 0.0..1_000_000.0,
  "strategistStopLossBps" to 0.0..10_000.0,
  "llmMaxActionUsdg" to 1.0..100_000.0,
  "tickSeconds" to 15.0..3_600.0,
  "paperStartUsdg" to 1.0..10_000_000.0,
  // THE CLASS ROUTE. These numbers ARE the exposure an owner is choosing, which
  // is why the server bounds them as well as defaulting them.
  "classPerEntryUsdg" to 0.0..1_000_000.0,
  "classMaxPositions" to 0.0..1_000.0,
  "classMaxHoldSec" to 60.0..2_592_000.0,
  "classMinDepthUsdg" to 0.0..10_000_000.0,
)

/** The keys the server keeps whole. A fraction there is refused here rather than stored as 2.5 positions. */
val SETTINGS_INTEGERS = setOf("slippageBps", "maxImpactBps", "takeProfitBps", "strategistStopLossBps", "tickSeconds", "classMaxPositions", "classMaxHoldSec")

/** A value the server will refuse, said before the round trip; null when in range or unread. */
fun outOfRange(key: String, value: Double?): String? {
  val r = SETTINGS_RANGES[key] ?: return null
  val v = value ?: return null
  return if (v in r) null else "Must be between ${plainBound(r.start)} and ${plainBound(r.endInclusive)}."
}

/** A bound, said the way the terminal says a figure: en-US grouping. */
fun plainBound(value: Double): String =
  if (value % 1.0 == 0.0) String.format(Locale.US, "%,d", value.toLong()) else String.format(Locale.US, "%,.2f", value)

// ── the consent sentences, word for word from the web ─────────────────────

/** Settings.tsx's Live trading read-out, ON. */
const val LIVE_ON_UNIT = "ON — real orders, real money, within your signed caps"

/** Settings.tsx's Live trading read-out, OFF. */
const val LIVE_OFF_UNIT = "OFF — Paper mode: practising with simulated money at live prices"

const val LIVE_ON_HINT = "Your agent places real orders on Robinhood Chain with the funds in its account. " +
  "Turn this off and it goes back to practising immediately — no signature needed either way."

const val LIVE_OFF_HINT = "Nothing your agent does costs real money while this is off. Funding the account does " +
  "NOT turn it on, and neither does re-signing your permission: this switch is the only thing that does."

/**
 * WHICH WARNING THE LIVE SWITCH OWES THE OWNER, before they press Save.
 *
 * Ticked but saved off: the sentence that says this spends real money, shown
 * at the last moment it can still be useful. Unticked but saved on: the one
 * that says a paper agent stops managing positions bought with real funds —
 * no stop-loss, no take-profit, no exits. Neither when the box matches what is
 * saved.
 */
enum class LiveTradingNote(val lead: String, val body: String) {
  SpendsRealMoney(
    "This spends real money.",
    " Once you save, your agent can open positions with the funds in its account, up to the per-trade and " +
      "daily caps in the permission you signed. It will not exceed those caps, and you can switch back to " +
      "Paper at any time.",
  ),
  LeavesRealPositions(
    "If your agent holds positions bought with real funds, read this first.",
    " In Paper mode it stops managing them — no stop-loss, no take-profit, no exits — and the screen shows " +
      "its simulated book instead. The tokens stay in the account and nothing is sold; they are simply left " +
      "alone until you turn Live trading back on. If you want out of a real position, close it first and " +
      "switch afterwards.",
  ),
}

fun liveTradingNote(shown: SettingsShown): LiveTradingNote? {
  val on = shown.bool("liveTradingEnabled")
  val saved = shown.savedBool("liveTradingEnabled")
  return when {
    on && !saved -> LiveTradingNote.SpendsRealMoney
    !on && saved -> LiveTradingNote.LeavesRealPositions
    else -> null
  }
}

/** What the published book reveals, while it is on (Profile.tsx BookSwitch). */
const val PUBLIC_BOOK_ON = "Anyone can see this agent's trade sizes and dollar P&L, what it holds and how much, " +
  "and its name as a holder on the token pages of what it holds. Its return and the percentage on each trade " +
  "are public either way."

/** What turning it on would publish, while it is off. */
const val PUBLIC_BOOK_OFF = "Its return and the percentage on each trade are public. Turn this on to also publish " +
  "its trade sizes and dollar P&L, what it holds and how much, and its name as a holder on the token pages of " +
  "what it holds."

/** What the owner is shown instead of "Saved" when the server did not take publicBook (profile-view.ts saveBook). */
const val PUBLIC_BOOK_IGNORED = "This server can't publish a book yet, so nothing changed."

// ── what a save came to ────────────────────────────────────────────────────

/**
 * THE SIX THINGS A SAVE CAN AMOUNT TO, and only [Saved] is "Saved".
 *
 * A 200 is `{ok, appliesWithin, ignored?}`, and `ignored` names keys the
 * server dropped — the phone used to say "Saved." over them. A 409 is the
 * owner check: the form was read for one wallet and the session is another's,
 * so nothing was written. A lost answer is UNKNOWN — the write may have landed
 * — and is looked up, never sent again on its own.
 */
sealed interface SettingsSaveOutcome {
  /** [notSaved] are the keys the server ignored; everything else in the patch was stored. */
  data class Saved(val appliesWithin: String?, val notSaved: List<String>) : SettingsSaveOutcome
  /** The server's own per-field sentences; nothing was written. */
  data class Rejected(val lines: List<String>) : SettingsSaveOutcome
  data object OwnerChanged : SettingsSaveOutcome
  data object SignIn : SettingsSaveOutcome
  /** The server failed; [message] is already a sentence (the generic 5xx line or an ownerFacing one). */
  data class Failed(val message: String) : SettingsSaveOutcome
  /** We cannot say whether it was written. Read the settings back and compare. */
  data class Unknown(val why: String) : SettingsSaveOutcome
}

/** The web's sentence for the owner check on the form, which the chat's wording ("confirmed this") does not fit. */
const val SETTINGS_OWNER_CHANGED =
  "You signed in as a different wallet since this form loaded, so nothing was saved. Reload before saving."

fun settingsSaveOutcome(r: ApiResult<SettingsSaved>): SettingsSaveOutcome = when (r) {
  is ApiResult.Ok -> when {
    r.value.errors.any { it.isNotBlank() } -> SettingsSaveOutcome.Rejected(r.value.errors.filter { it.isNotBlank() })
    // A 2xx that does not say ok is not a confirmation (profile-view.ts
    // saveBook: "merrymen didn't confirm the change"). It may have been
    // written, so it is looked up like a lost answer.
    r.value.ok != true -> SettingsSaveOutcome.Unknown("merrymen answered without confirming the save")
    else -> SettingsSaveOutcome.Saved(r.value.appliesWithin?.takeIf { it.isNotBlank() }, r.value.ignored.filter { it.isNotBlank() })
  }
  is ApiResult.Refused -> when {
    r.status == 409 -> SettingsSaveOutcome.OwnerChanged
    r.status == 401 -> SettingsSaveOutcome.SignIn
    r.status >= 500 -> SettingsSaveOutcome.Failed(r.message)
    // One line per refused value, which is how the route lists them and how
    // the web renders them — joining them loses which value was refused.
    else -> SettingsSaveOutcome.Rejected(
      r.message.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        .ifEmpty { listOf("The server refused that but did not say why.") },
    )
  }
  is ApiResult.Unreachable -> SettingsSaveOutcome.Unknown(
    if (r.unreadable) "the answer could not be read" else "the answer was lost",
  )
}

/** What reading the settings back after an unknown save found. */
data class SaveLookup(
  /** Keys whose stored value now equals what was sent: they saved. */
  val saved: List<String>,
  /** Keys that do not hold what was sent: they did not save, or not yet. */
  val notSaved: List<String>,
  /** The read-back is another wallet's settings: nothing can be concluded, and nothing is compared. */
  val ownerChanged: Boolean,
)

/**
 * LOOK IT UP, DO NOT SEND IT AGAIN.
 *
 * After an answer that never came back, the only honest way to know is to read
 * the settings and compare each key sent with what is stored now. A setting is
 * one value, so a key that matches was written; one that does not was not (or
 * not yet), and stays in the draft for the owner to decide about. Numbers are
 * compared as numbers (25 and 25.0 are one value); anything this cannot compare
 * counts as not saved, which errs toward the owner checking rather than
 * believing.
 */
fun settleUnknownSave(sent: Map<String, JsonElement>, fresh: SettingsEnvelope, formOwner: String?): SaveLookup {
  if (formOwner != null && fresh.owner != null && !fresh.owner.equals(formOwner, ignoreCase = true)) {
    return SaveLookup(emptyList(), sent.keys.toList(), ownerChanged = true)
  }
  val stored = fresh.values as? JsonObject ?: JsonObject(emptyMap())
  val saved = mutableListOf<String>()
  val notSaved = mutableListOf<String>()
  for ((key, value) in sent) {
    if (sameSetting(value, stored[key] ?: (fresh.defaults as? JsonObject)?.get(key))) saved += key else notSaved += key
  }
  return SaveLookup(saved, notSaved, ownerChanged = false)
}

internal fun sameSetting(a: JsonElement?, b: JsonElement?): Boolean {
  if (a == null || b == null || a is JsonNull || b is JsonNull) return false
  if (a is JsonPrimitive && b is JsonPrimitive) {
    if (a.isString || b.isString) return a.isString && b.isString && a.content.trim() == b.content.trim()
    val an = a.content.toBigDecimalOrNull()
    val bn = b.content.toBigDecimalOrNull()
    if (an != null && bn != null) return an.compareTo(bn) == 0
    return a.content == b.content
  }
  if (a is JsonArray && b is JsonArray) return a.size == b.size && a.indices.all { sameSetting(a[it], b[it]) }
  return a == b
}

/**
 * THE NAME A KEY IS SHOWN UNDER when a save reports it — "not saved: live
 * trading" rather than a property name. A key this build does not label is
 * shown as itself: it is our own key, from our own patch, never server text.
 */
fun settingLabel(key: String): String = SETTING_LABELS[key] ?: key

private val SETTING_LABELS = mapOf(
  "liveTradingEnabled" to "live trading",
  "paperTradingEnabled" to "practise while not live",
  "assetMode" to "asset mode",
  "publicBook" to "public book",
  "trencherLiveEnabled" to "let trencher trade for real",
  "trencherFastEnabled" to "fast Trencher exits",
  "agentName" to "agent name",
  "strategy" to "strategy",
  "basketSymbols" to "trading basket",
  "discoveryEnabled" to "watch for new pairs",
  "officialCoinsEnabled" to "trade the platform coin list",
  "deskEnabled" to "research before deciding",
  "scoutEnabled" to "scout mode",
  "classSnipeEnabled" to "class route",
  "classPerEntryUsdg" to "class per entry",
  "classMaxPositions" to "class max open positions",
  "classMaxHoldSec" to "class maximum holding time",
  "classMinDepthUsdg" to "class minimum curve depth",
  "telegramEnabled" to "enable telegram",
  "telegramControlEnabled" to "allow control commands",
  "telegramTransferEnabled" to "allow transfers",
  "buyPerTickUsdg" to "size per trade",
  "slippageBps" to "max slippage",
  "maxImpactBps" to "max price impact",
  "takeProfitBps" to "take profit",
  "strategistStopLossBps" to "stop loss",
  "llmMaxActionUsdg" to "strategist ceiling",
  "tickSeconds" to "market check interval",
)

// ── sending it ─────────────────────────────────────────────────────────────

/** One press of Save: what was sent (null when nothing was), and what came of it. */
data class SettingsSave(val sent: JsonObject?, val outcome: SettingsSaveOutcome?, val blocked: List<String>)

/**
 * SAVE THE DRAFT FOR THE WALLET THE FORM WAS READ FOR.
 *
 * [env] is the read the form shows, and its `owner` goes with the save (a ""
 * too — a form read signed out names nobody, and the route refuses it for
 * whoever signs in before it lands). [signedInNow] is the app's own account of
 * the session at the press: when it already names a different wallet than the
 * form was read for, nothing is sent and the owner is told — the server would
 * refuse it anyway (409), and a request that can only be refused need not
 * leave the phone. When the app does not know (null), the server decides.
 */
suspend fun MerrymenApi.saveSettingsDraft(draft: SettingsDraft, env: SettingsEnvelope, signedInNow: String?): SettingsSave {
  val patch = when (val sub = draft.submission()) {
    is SettingsSubmission.Blocked -> return SettingsSave(null, null, sub.why)
    is SettingsSubmission.Ready -> sub.patch
  }
  val formOwner = env.owner
  if (!formOwner.isNullOrEmpty() && signedInNow != null && !formOwner.equals(signedInNow, ignoreCase = true)) {
    return SettingsSave(null, SettingsSaveOutcome.OwnerChanged, emptyList())
  }
  return SettingsSave(patch, settingsSaveOutcome(putSettingsOnce(patch, formOwner)), emptyList())
}
