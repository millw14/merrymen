package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.util.Locale

/**
 * A REAL SETTINGS EDITOR, and the correction that made it possible.
 *
 * This screen used to be a read-only blob with a "edit on the web" handoff,
 * because I believed a native form would silently unset every field it did not
 * render. That was wrong, and the mistake is worth writing down: the PUT
 * handler reads each field with `if ("name" in body)`, so it is a PATCH.
 * Omitted fields are LEFT ALONE. Sending a subset is the correct thing to do.
 *
 * What would be genuinely wrong is echoing a field back unread — above all a
 * secret, since GET returns `{set, hint}` and never the value, so replaying it
 * would overwrite a real key with a mask. So this editor sends exactly the keys
 * the owner touched, and no others: `edits` starts empty and only a control
 * that was moved puts anything in it.
 *
 * ABSENT IS NOT EMPTY when READING, either. `SettingsEnvelope.raw` falls back
 * from `values` to `defaults`, because a field the owner never edited is not
 * unset — the default applies. Reading it as empty is exactly how approving one
 * coin once replaced a whole default basket.
 *
 * ── THE LOOK IS `forms.css`, NOT MATERIAL ────────────────────────────────────
 *
 * The web has TWO form vocabularies and this screen belongs to the dense one:
 * `.terminal-form-page` in `web/src/terminal/forms.css`, which Settings and
 * Wallet share. Nothing in `polish.css` overrides it below 1100px — I checked,
 * because reading only one of the two sheets has already produced a wrong
 * answer in this project — so forms.css stands as written on a phone, with one
 * `@media (max-width: 650px)` block that collapses `.mm-grid` to a single
 * column and drops the page h1 to 26px.
 *
 * What that vocabulary is, and what this file no longer does:
 *  - A LABEL SITS ABOVE ITS CONTROL (`.mm-label`, forms.css:36, 14px/500/1.5).
 *    M3's floating label is a different design; there is no
 *    placeholder-as-label anywhere in this UI.
 *  - THE BOX IS FLAT (forms.css:39-41): min-height 46px, padding 12/14, 1px
 *    `--line`, radius 12, ground `--card`, 14px text. Not an outlined field
 *    with a notch cut out of its border.
 *  - FOCUS IS GREY, NOT LIME. forms.css:43 (`outline: 2px solid var(--tx-2)`,
 *    specificity 0,2,1) beats the global lime focus ring at terminal.css:661
 *    (0,1,1), so inputs on this page focus grey while buttons focus lime. And
 *    `--lime` itself is redefined to `--tx` inside `.terminal-form-page`
 *    (forms.css:6), so there is no lime on this screen at all.
 *  - SECTIONS ARE RULES AND HEADINGS, NOT CARDS (`.mm-section`, forms.css:23).
 *    The old `SectionCard` wrapper drew four boxes the web does not draw.
 *  - THERE ARE NO SWITCHES (Settings.tsx:717-756, 885-891, 902-947). Every
 *    on/off control is a checkbox with a sentence beside it saying what the
 *    current position MEANS. That sentence is the control's real read-out and
 *    it is kept verbatim from the web.
 *
 * THE GUTTER IS THE PAGE'S, NOT THIS FILE'S. `polish.css:87` puts 20px of
 * side padding on `.app > .body`; `.terminal-form-page` adds none. So nothing
 * here sets a horizontal padding — the screen that hosts this form owns it.
 */

/** The numeric bounds the server enforces, mirrored so the UI can say them. */
private val RANGES: Map<String, Pair<Double, Double>> = mapOf(
  "buyPerTickUsdg" to (1.0 to 100_000.0),
  "slippageBps" to (1.0 to 5_000.0),
  "maxImpactBps" to (0.0 to 10_000.0),
  "takeProfitBps" to (0.0 to 1_000_000.0),
  "strategistStopLossBps" to (0.0 to 10_000.0),
  "llmMaxActionUsdg" to (1.0 to 100_000.0),
  "tickSeconds" to (15.0 to 3_600.0),
  "paperStartUsdg" to (1.0 to 10_000_000.0),
)

/**
 * [unit] is the `.mm-unit` slot (forms.css:45) — a 12px `--tx-2` word sitting
 * on the SAME LINE as the field, to its right, exactly as Settings.tsx:1341
 * puts "bps" beside max slippage. It used to be a parenthetical inside the
 * label; the words are unchanged, they have simply moved to where the web
 * keeps them.
 */
private data class NumField(
  val key: String,
  val label: String,
  val unit: String,
  val help: String,
  val decimal: Boolean = false,
)

private val NUMBERS = listOf(
  NumField("buyPerTickUsdg", "Size per trade", "USDG", "What it puts to work each time it trades.", decimal = true),
  NumField("slippageBps", "Max slippage", "bps", "Refuse a fill worse than this far off the quote."),
  NumField("maxImpactBps", "Max price impact", "bps", "Refuse a trade that would move the price more than this. 0 turns the guard off."),
  NumField("takeProfitBps", "Take profit", "bps", "Sell a leg once it is this far ahead of what it cost. 0 disables it — and it is the default strategy's only exit."),
  NumField("strategistStopLossBps", "Stop loss", "bps", "0 is off. A tight floor on a small ticket pays the chain to churn."),
  NumField("llmMaxActionUsdg", "Strategist ceiling", "USDG", "The most one model-proposed action may spend.", decimal = true),
)

/**
 * A checkbox row, and the two sentences that are the actual read-out.
 *
 * [on] and [off] are the `.mm-unit` state copy, taken WORD FOR WORD from
 * Settings.tsx. They are not decoration: "off — unpriceable tokens are never
 * bought" and "off" are different promises, and a bare toggle with no sentence
 * leaves the reader to guess which one a given switch is making. The spec is
 * explicit that a Switch may replace the checkbox but the sentence may not be
 * dropped.
 */
private data class BoolField(
  val key: String,
  val label: String,
  val on: String,
  val off: String,
  val help: String? = null,
)

/**
 * PRACTICE IS THE ONE SWITCH THE WEB SETTINGS PAGE DOES NOT HAVE — it is set in
 * the create flow (CreateAgent.tsx:157) and read here only to decide whether the
 * setup checklist asks for funds. So its two sentences are authored rather than
 * copied, and they are written to keep the distinction this product is built on:
 * a simulated fill is not a fill. The copy borrows CreateAgent's own framing —
 * "a setting, not a different network".
 */
private val PAPER = BoolField(
  key = "paperTradingEnabled",
  label = "Practice fills",
  on = "simulated fills when it cannot trade for real — marked as practice, never as money moved",
  off = "off — nothing is recorded as filled unless it filled for real",
  help = "Practice runs on live market prices. It is a setting, not a different network — your agent stays on the same chain either way.",
)

/** Settings.tsx:715-733 — the `discovery · new pairs as they launch` block. */
private val DISCOVERY = BoolField(
  key = "discoveryEnabled",
  label = "watch for new pairs",
  on = "tells you when something launches",
  off = "off",
  help = "Requires a Bitquery key or a Merry Circle token — both are set on the web, under Connections.",
)

/** Settings.tsx:776-817 — the `scout mode` block, both of its switches. */
private val SCOUT_SWITCHES = listOf(
  BoolField(
    key = "deskEnabled",
    label = "research before deciding",
    on = "the strategist looks things up before it commits",
    off = "off — one shot from a fixed set of numbers",
    help = "llm-strategist only. On, a decision becomes a short research loop: it can pull depth, " +
      "check what a position cost, and read back its own past decisions before it acts — and it " +
      "writes what it concluded, in its own words, to your feed. Off by default because it costs " +
      "up to a few model calls per window instead of one.",
  ),
  BoolField(
    key = "scoutEnabled",
    label = "scout mode",
    on = "may buy unpriceable tokens, up to the budget",
    off = "off — unpriceable tokens are never bought",
  ),
)

/** Settings.tsx:885-891 — inside the collapsed `Telegram` group. */
private val TELEGRAM = BoolField(
  key = "telegramEnabled",
  label = "enable telegram",
  on = "the bot is listening",
  off = "off",
)

/** Settings.tsx:900-947 — the `Telegram controls` section inside Advanced. */
private val TELEGRAM_CONTROLS = listOf(
  BoolField(
    key = "telegramControlEnabled",
    label = "allow control commands",
    on = "pause/strategy/trade/kill",
    off = "read + chat only",
    help = "Off = the bot can answer questions but not change state.",
  ),
  BoolField(
    key = "telegramTransferEnabled",
    label = "allow transfers",
    on = "/transfer with /confirm",
    off = "off",
    help = "Requires existing transfer permission. Otherwise, use Withdraw in Profile.",
  ),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsForm(
  env: SettingsEnvelope,
  edits: MutableMap<String, JsonElement>,
  circleLocked: Set<String>,
  onChanged: () -> Unit,
) {
  // The value to SHOW: an edit if one was made, else the stored value, else the
  // default. Never a blank that reads as "unset".
  fun showStr(key: String): String =
    (edits[key] as? JsonPrimitive)?.content ?: env.str(key) ?: ""

  fun showNum(key: String): String =
    (edits[key] as? JsonPrimitive)?.content
      ?: env.num(key)?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }
      ?: ""

  fun showBool(key: String): Boolean =
    (edits[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: env.bool(key) ?: false

  fun showList(key: String): List<String> =
    (edits[key] as? JsonArray)
      ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: env.list(key)

  fun setBool(key: String): (Boolean) -> Unit = { edits[key] = JsonPrimitive(it); onChanged() }

  Column(Modifier.fillMaxWidth()) {

    // ── AGENT SETTINGS ──────────────────────────────────────────────────────
    // Settings.tsx:410. The heading strings on this screen are exact: the web
    // says "Agent settings", not "Your agent".
    SectionHeading("Agent settings")
    FieldGrid {
      Field("Agent name", help = "Up to 24 letters, numbers, or spaces.") {
        InputBox(
          value = showStr("agentName"),
          onValueChange = { edits["agentName"] = JsonPrimitive(it); onChanged() },
        )
      }

      val current = showStr("strategy")
      Field("Strategy") {
        // THE HOLDER GATE LIVES IN THE OPTION STRING. Settings.tsx:542 appends
        // the literal " · holders only" to the option label because a <select>
        // has nowhere to hang a badge — and app/settings/honesty.test.ts counts
        // that exact string. A styled chip instead of the suffix would pass for
        // the same information and would not be.
        val options = buildList {
          env.strategies.builtin.forEach {
            add(SelectOption(it, it + if (it in circleLocked) " · holders only" else ""))
          }
          if (env.strategies.custom.isNotEmpty()) {
            add(SelectOption(null, "── your strategies ──"))
            env.strategies.custom.forEach { add(SelectOption(it, "$it (custom)")) }
          }
        }
        SelectBox(
          display = options.firstOrNull { it.value == current }?.label ?: current,
          options = options,
          selected = current,
          onPick = { edits["strategy"] = JsonPrimitive(it); onChanged() },
        )
      }

      // THE LOCK IS STATED AT THE POINT OF CHOICE, which is the whole complaint
      // that started this: an owner could pick a holder-only strategy and find
      // out it never ran only by reading a JSON endpoint.
      //
      // IT IS AMBER, NOT MONEY-RED. It used to render in `colorScheme.error`,
      // which after the palette fix is `--down` #ff5c71 — the colour of a loss.
      // Nothing here is broken and no money moved; the web has a register for
      // exactly this and it is `.create-locked` (terminal.css:7788): an amber
      // slab, "louder than a hint and quieter than an error".
      //
      // The web's copy names the reader's standing — "You hold N and it needs
      // M" — because that page has loaded /api/tier. This one has not, so it
      // says only what it can back up. Claiming "that one won't run yet" while
      // holding no balance reading would be the same shape of lie this whole
      // file exists to avoid.
      if (current in circleLocked) {
        LockedPanel(
          strong = "This is a Merry Circle strategy.",
          body = "It only runs while you hold enough \$MERRYMEN — picking it now means the " +
            "agent stays idle until you do.",
        )
      }

      CheckField(PAPER, showBool(PAPER.key), setBool(PAPER.key))
    }

    // ── TRADING BASKET ──────────────────────────────────────────────────────
    // Settings.tsx:599-621.
    SectionHeading("Trading basket")
    val basket = showList("basketSymbols")
    // `.mm-chips` (forms.css:49): flex, WRAP, gap 8px, margin 12px 0. The chips
    // used to be chunked four to a row by hand, which is a grid — symbols are
    // three to five characters wide and a grid leaves ragged holes. FlowRow is
    // stable in this Compose version; the opt-in above is harmless if the
    // marker has already been dropped from the overload we use.
    FlowRow(
      modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      env.knownSymbols.forEach { sym ->
        Chip(sym, sym in basket) {
          val next = basket.toMutableList()
          if (sym in next) next.remove(sym) else next.add(sym)
          edits["basketSymbols"] = buildJsonArray { next.forEach { add(JsonPrimitive(it)) } }
          onChanged()
        }
      }
    }
    // EMPTY IS NOT NOTHING, and this line is the only place that says so.
    // Settings.tsx:617-620, verbatim: an empty basket falls back to the default
    // one rather than standing the agent down, which is the opposite of what a
    // reader assumes from an empty row of chips.
    Hint(
      if (basket.isEmpty()) "select at least one symbol (empty falls back to the default basket)"
      else "trading " + basket.joinToString(" · "),
    )

    // ── CUSTOM TOKENS & DISCOVERY (collapsed) ───────────────────────────────
    // Settings.tsx:637. `details.settings-group`, closed on arrival.
    Disclosure("Custom tokens & discovery") {
      SubtleHead("discovery · new pairs as they launch")
      FieldGrid {
        CheckField(DISCOVERY, showBool(DISCOVERY.key), setBool(DISCOVERY.key))
      }

      SubtleHead("scout mode · buying what can't be priced yet")
      Hint(
        "Buy tokens without a reliable market price, within your scout budget. " +
          "These positions are valued at purchase cost.",
      )
      FieldGrid {
        SCOUT_SWITCHES.forEach { CheckField(it, showBool(it.key), setBool(it.key)) }
      }
      // A CLAIM ABOUT WHAT THE BREAKER CANNOT DO — Settings.tsx:840-853, kept
      // word for word. The first half always renders; the second half renders
      // only when scout is on AND the budget is exactly 0, because showing it
      // otherwise is a false alarm and hiding it then leaves a feature that is
      // silently inert. The budget is read, never written — this form has no
      // field for it.
      Danger(
        scoutWarning(
          zeroBudget = showBool("scoutEnabled") && env.num("scoutBudgetUsdg") == 0.0,
        ),
      )
    }

    // ── TELEGRAM (collapsed) ────────────────────────────────────────────────
    // Settings.tsx:856.
    Disclosure("Telegram") {
      FieldGrid { CheckField(TELEGRAM, showBool(TELEGRAM.key), setBool(TELEGRAM.key)) }
    }

    // ── ADVANCED (collapsed) ────────────────────────────────────────────────
    // Settings.tsx:897. `details.mm-advanced` wraps everything from "Telegram
    // controls" to "Trading preferences", and it is closed by default on the
    // web too. See the report: that is faithful, and it does put the slippage
    // and stop-loss guards one tap further away than they were.
    Disclosure("Advanced settings", advanced = true) {
      SectionHeading("Telegram controls")
      FieldGrid {
        TELEGRAM_CONTROLS.forEach { CheckField(it, showBool(it.key), setBool(it.key)) }
      }

      SectionHeading("Trading preferences")
      FieldGrid {
        NUMBERS.forEach { f ->
          val bounds = RANGES[f.key]
          val shown = showNum(f.key)
          val typed = shown.toDoubleOrNull()
          val outOfRange = bounds != null && typed != null &&
            (typed < bounds.first || typed > bounds.second)
          Field(
            label = f.label,
            help = f.help + (bounds?.let { " Between ${plain(it.first)} and ${plain(it.second)}." } ?: ""),
          ) {
            // `.mm-input` (forms.css:38) is a flex row: the field takes the
            // slack and the unit keeps its intrinsic width beside it.
            Row(
              modifier = Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              InputBox(
                value = shown,
                onValueChange = { raw ->
                  // Stored as a NUMBER, not a string: the server's validator
                  // checks the type, and a quoted number is rejected as the
                  // wrong shape.
                  val n = raw.trim().toDoubleOrNull()
                  if (raw.isBlank()) edits.remove(f.key) else if (n != null) edits[f.key] = JsonPrimitive(n)
                  onChanged()
                },
                modifier = Modifier.weight(1f),
                numeric = true,
                keyboardType = if (f.decimal) KeyboardType.Decimal else KeyboardType.Number,
              )
              Unit(f.unit)
            }
            // A VALUE THE SERVER WILL REFUSE, SAID BEFORE THE ROUND TRIP.
            // The web has no error style for an input — only the red
            // `.mm-danger` list under the Save button once the server has
            // spoken (Settings.tsx:1388). This borrows that same treatment
            // rather than inventing a red border, and it states the bound in
            // words because the range otherwise lives only in the help
            // popover, which is closed.
            if (outOfRange && bounds != null) {
              Danger(AnnotatedString("Must be between ${plain(bounds.first)} and ${plain(bounds.second)}."))
            }
          }
        }
      }
    }
  }
}

/** The patch: exactly what was touched, and nothing else. */
fun patchOf(edits: Map<String, JsonElement>): JsonElement =
  buildJsonObject { edits.forEach { (k, v) -> put(k, v) } }

// ═══════════════════════════════════════════════════════════════════════════
// THE FORM VOCABULARY — forms.css, one composable per rule.
//
// All private per the one-file-per-agent rule. `Field`, `InputBox`, `SelectBox`,
// `Chip`, `CheckField`, `SectionHeading`, `Disclosure` and `LockedPanel` are the
// pieces the Wallet / grant screens will want too (forms.css scopes the same
// rules to `.terminal-form-page`, which is Settings AND Wallet), so they are
// written to be lifted into Components.kt unchanged.
// ═══════════════════════════════════════════════════════════════════════════

/** `border-radius: 12px` — every input, select and textarea (forms.css:40). */
private val FieldShape = RoundedCornerShape(12.dp)

/** `border-radius: 10px` — the chip / secondary button box (forms.css:51). */
private val ChipShape = RoundedCornerShape(10.dp)

/** `.mm-label` — forms.css:36. */
private val LabelStyle = TextStyle(
  fontFamily = sans(14.sp, FontWeight.W500),
  fontSize = 14.sp,
  fontWeight = FontWeight.W500,
  lineHeight = 21.sp,
)

/** `.mm-hint` — forms.css:37, 12px / 1.65. */
private val HintStyle = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  lineHeight = 19.8.sp,
)

/** `.mm-unit` — forms.css:45, 12px `--tx-2`. */
private val UnitStyle = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  lineHeight = 18.sp,
)

/** `.mm-danger` — forms.css:57, 13px / 1.6 in `--down`. */
private val DangerStyle = TextStyle(
  fontFamily = sans(13.sp),
  fontSize = 13.sp,
  lineHeight = 20.8.sp,
)

/** `.mm-section` — forms.css:23. */
private val SectionStyle = TextStyle(
  fontFamily = sans(18.sp, FontWeight.W600),
  fontSize = 18.sp,
  fontWeight = FontWeight.W600,
  letterSpacing = (-0.02).em,
)

/**
 * `.mm-subtle.mono` — forms.css:60-61. NOT monospace: the form page forces
 * `.mono` back to the inherited family, so these sub-heads render in the same
 * sans as everything else at the inherited 15px.
 */
private val SubtleStyle = TextStyle(
  fontFamily = sans(15.sp),
  fontSize = 15.sp,
  lineHeight = 20.25.sp,
)

/** `summary` — forms.css:56, 16px; `.settings-group > summary` adds weight 500. */
private fun summaryStyle(medium: Boolean) = TextStyle(
  fontFamily = sans(16.sp, if (medium) FontWeight.W500 else FontWeight.W400),
  fontSize = 16.sp,
  fontWeight = if (medium) FontWeight.W500 else FontWeight.W400,
  lineHeight = 24.sp,
)

/** `.mm-chips button` — forms.css:51, 13px. */
private val ChipTextStyle = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp)

/** The text inside the 46px box — forms.css:40, 14px `--tx`. */
private val InputStyle = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  lineHeight = 18.9.sp,
  color = MerryColors.tx,
)

/**
 * The same box, but with figures.
 *
 * `--sans` lists "Geist Numerals" first with `unicode-range: U+0030-0039`, so
 * in a browser every digit in an input comes from that face and every letter
 * from DM Sans. Compose resolves a family by weight rather than by coverage, so
 * the split is made by hand — the same call [Money] makes. `tnum, lnum` is the
 * `font-variant-numeric` the terminal sets once on `.app` (terminal.css:668)
 * and which Compose has no inherited equivalent for.
 */
private val NumberInputStyle = InputStyle.copy(
  fontFamily = numerals(FontWeight.W400),
  fontFeatureSettings = "tnum, lnum",
)

/** `.create-locked` — terminal.css:7788-7811. Amber, and none of it is a token. */
private val LockEdge = Color(0xFF6B5A1F)
private val LockGround = Color(0xFF221D0C)
private val LockStrong = Color(0xFFD8B44A)

/** `border-top: 1px solid var(--line)` — the separator every section hangs on. */
@Composable
private fun Rule() {
  Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
}

/**
 * `.mm-section` — forms.css:23:
 * `font-size:18px; font-weight:600; letter-spacing:-.02em; padding:28px 0 16px; border-top:1px solid var(--line); margin-top:28px`
 *
 * The RULE IS THE SEPARATOR and it sits above the padding, so the gap above the
 * line is the previous block's own spacing and the gap below it is 28px.
 */
@Composable
private fun SectionHeading(text: String) {
  Column(Modifier.fillMaxWidth().padding(top = 28.dp)) {
    Rule()
    Text(
      text = text,
      modifier = Modifier.padding(top = 28.dp, bottom = 16.dp),
      style = SectionStyle,
      color = MerryColors.tx,
    )
  }
}

/**
 * `.mm-grid` — forms.css:24 with the ≤650px override at forms.css:95.
 *
 * Two columns on a desktop; ONE COLUMN on every phone, which makes the 20px
 * column gap dead and leaves only the 24px row gap. A LazyVerticalGrid here
 * would be building a layout the phone never renders.
 */
@Composable
private inline fun FieldGrid(content: @Composable ColumnScope.() -> Unit) {
  Column(
    modifier = Modifier.fillMaxWidth(),
    verticalArrangement = Arrangement.spacedBy(24.dp),
    content = content,
  )
}

/**
 * `.mm-field` + `.setting-field` — forms.css:25, 27-33.
 *
 * A column with a 9px gap, and the per-field help hung at `right:0; top:0` over
 * it. The help is a `<details>` on the web, which is why the label row reserves
 * 28px on its right: the icon is absolutely positioned and would otherwise sit
 * on top of a long label.
 */
@Composable
private fun Field(
  label: String,
  help: String? = null,
  content: @Composable ColumnScope.() -> Unit,
) {
  Box(Modifier.fillMaxWidth()) {
    Column(
      modifier = Modifier.fillMaxWidth(),
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Text(
        text = label,
        modifier = Modifier.padding(end = if (help != null) 28.dp else 0.dp),
        style = LabelStyle,
        color = MerryColors.tx,
      )
      content()
    }
    if (help != null) HelpDisclosure(label, help, Modifier.align(Alignment.TopEnd))
  }
}

/** `.mm-hint` as a standalone paragraph — forms.css:37 with :21's `--tx-2`. */
@Composable
private fun Hint(text: String) {
  Text(text = text, style = HintStyle, color = MerryColors.tx2)
}

/** `.mm-unit` — forms.css:45. */
@Composable
private fun Unit(text: String) {
  Text(text = text, style = UnitStyle, color = MerryColors.tx2)
}

/** `.mm-subtle.mono` — a sub-head inside a group. forms.css:60-61. */
@Composable
private fun SubtleHead(text: String) {
  Text(
    text = text,
    modifier = Modifier.padding(top = 20.dp, bottom = 12.dp),
    style = SubtleStyle,
    color = MerryColors.tx2,
  )
}

/**
 * `.mm-danger` — forms.css:57.
 *
 * A plain red paragraph in normal flow: no background, no border, no icon. The
 * sheet uses this one treatment for two registers — a hard failure and a
 * standing warning where nothing is broken — and deliberately gives them the
 * same weight. Do not "improve" one of them into a toast.
 */
@Composable
private fun Danger(text: AnnotatedString) {
  Text(text = text, style = DangerStyle, color = MerryColors.down)
}

/**
 * The scout-mode warning, Settings.tsx:840-853, verbatim including its bold
 * runs. `<b>` inside `.mm-danger` inherits the size and only lifts the weight —
 * and because DM Sans is a variable face here, the run also has to name the
 * weight on its family or Compose will synthesise a fake bold.
 */
private fun scoutWarning(zeroBudget: Boolean): AnnotatedString = buildAnnotatedString {
  val bold = SpanStyle(fontFamily = sans(13.sp, FontWeight.W600), fontWeight = FontWeight.W600)
  withStyle(bold) { append("The drawdown breaker cannot protect this money.") }
  append(
    " These positions stay valued at purchase cost even if they lose value, so if one goes to " +
      "zero your equity will not show it and the breaker will not fire. ",
  )
  withStyle(bold) { append("The budget is the risk control here") }
  append(", not the breaker — set it to what you have decided you can lose.")
  if (zeroBudget) {
    append("\n\nScout mode is on but the budget is ")
    withStyle(bold) { append("0") }
    append(", so nothing will be bought. Set a budget or turn it back off.")
  }
}

/**
 * THE 46px BOX — forms.css:39-41, and the grey ring at forms.css:43.
 *
 * `box-sizing: border-box` means the CSS 46px INCLUDES the 12px padding and the
 * two 1px borders. Compose adds padding to the measured size instead, so the
 * `heightIn` goes on the OUTER box that already carries the border and padding;
 * put it inside and the field grows to 72dp.
 *
 * THE RING IS DRAWN OUTSIDE THE BOUNDS, ON PURPOSE. A CSS `outline` takes no
 * layout space, so a focused field does not move and does not push its
 * neighbours. `Modifier.border` is inside the box and would eat 2dp of the
 * ground. The alternative — reserving 4dp of padding around every field — insets
 * the box from its own label by 4dp, which is visible on a 20px gutter. So the
 * ring is painted past the edge and relies on nothing above clipping: fine
 * inside a plain Column, NOT fine inside a card that calls `Modifier.clip`.
 *
 * `outline-offset: 2px` with a 2px stroke means the line occupies 2..4px outside
 * the border box, i.e. its centre is 3dp out and its corner radius is 12+3.
 */
@Composable
private fun InputBox(
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  placeholder: String? = null,
  numeric: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val style = if (numeric) NumberInputStyle else InputStyle
  BasicTextField(
    value = value,
    onValueChange = onValueChange,
    modifier = modifier.fillMaxWidth(),
    textStyle = style,
    singleLine = true,
    cursorBrush = SolidColor(MerryColors.tx),
    keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
    interactionSource = interaction,
    decorationBox = { inner ->
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .heightIn(min = 46.dp)
          .then(if (focused) Modifier.drawBehind { focusRing() } else Modifier)
          .clip(FieldShape)
          .background(MerryColors.card)
          .border(1.dp, MerryColors.line, FieldShape)
          .padding(horizontal = 14.dp, vertical = 12.dp),
        contentAlignment = Alignment.CenterStart,
      ) {
        // The placeholder is `--tx-2` and not `--faint`. The web authors no
        // `::placeholder` rule at all and rides the Chromium dark default
        // (~54% white); anything dimmer than `--tx-2` on this page starts to
        // hide sentences that carry state, which is how "not set" and
        // "saved ····ab12" become the same grey smudge.
        if (value.isEmpty() && placeholder != null) {
          Text(text = placeholder, style = style, color = MerryColors.tx2)
        }
        inner()
      }
    },
  )
}

/** `outline: 2px solid var(--tx-2); outline-offset: 2px` — forms.css:43. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.focusRing() {
  val out = 3.dp.toPx()
  drawRoundRect(
    color = MerryColors.tx2,
    topLeft = Offset(-out, -out),
    size = Size(size.width + out * 2, size.height + out * 2),
    cornerRadius = CornerRadius(15.dp.toPx()),
    style = Stroke(width = 2.dp.toPx()),
  )
}

/** One row of a `<select>`; a null [value] is the disabled separator option. */
private data class SelectOption(val value: String?, val label: String)

/**
 * A NATIVE `<select>` IN THE SAME 46px BOX — forms.css:39-41.
 *
 * The web sets no `appearance: none`, so the chevron is UA-drawn under
 * `color-scheme: dark`. There is no Compose equivalent, and M3's own menu
 * surface is the wrong colour here: `DropdownMenu` paints itself with
 * `surfaceContainer`, which this app never maps, so it would arrive in
 * Material's default purple-grey. The list is therefore a plain `Popup` in the
 * form vocabulary — `--card` ground, 1px `--line`, radius 12 — sized to the
 * field it belongs to.
 */
@Composable
private fun SelectBox(
  display: String,
  options: List<SelectOption>,
  selected: String,
  onPick: (String) -> Unit,
  modifier: Modifier = Modifier,
) {
  var open by remember { mutableStateOf(false) }
  var boxWidth by remember { mutableStateOf(0) }
  var boxHeight by remember { mutableStateOf(0) }
  val density = LocalDensity.current

  Box(modifier.fillMaxWidth()) {
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .onSizeChanged { boxWidth = it.width; boxHeight = it.height }
        .heightIn(min = 46.dp)
        .clip(FieldShape)
        .background(MerryColors.card)
        .border(1.dp, MerryColors.line, FieldShape)
        .clickable(role = Role.Button) { open = true }
        .padding(horizontal = 14.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = display,
        modifier = Modifier.weight(1f),
        style = InputStyle,
        color = MerryColors.tx,
      )
      Chevron()
    }

    if (open) {
      Popup(
        alignment = Alignment.TopStart,
        offset = IntOffset(0, boxHeight + with(density) { 6.dp.roundToPx() }),
        onDismissRequest = { open = false },
        properties = PopupProperties(focusable = true),
      ) {
        Column(
          Modifier
            .width(with(density) { boxWidth.toDp() })
            .shadow(12.dp, FieldShape)
            .clip(FieldShape)
            .background(MerryColors.card)
            .border(1.dp, MerryColors.line, FieldShape)
            .padding(vertical = 4.dp),
        ) {
          options.forEach { opt ->
            val value = opt.value
            val isOn = value != null && value == selected
            Row(
              modifier = Modifier
                .fillMaxWidth()
                .then(
                  if (value != null) {
                    Modifier.selectable(selected = isOn, role = Role.RadioButton) {
                      onPick(value); open = false
                    }
                  } else {
                    Modifier
                  },
                )
                // `.cap.on` / `button[aria-pressed=true]` — forms.css:52. The
                // one selected treatment this vocabulary has.
                .background(if (isOn) MerryColors.line else Color.Transparent)
                .heightIn(min = 46.dp)
                .padding(horizontal = 14.dp, vertical = 12.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text(
                text = opt.label,
                style = InputStyle,
                color = if (value == null) MerryColors.tx2 else MerryColors.tx,
              )
            }
          }
        }
      }
    }
  }
}

/**
 * `.mm-chips button` / `.mm-toggle` inside `.mm-chips` — forms.css:47, 50-52:
 * `padding:10px 14px; min-height:40px; border:1px solid var(--line); border-radius:10px; background:var(--card); font-size:13px`,
 * and selected swaps the border to `--tx-2` and the ground to `--line`.
 *
 * The 40dp box is under Android's 48dp guidance and is kept anyway, because it
 * is what the web draws and a taller chip breaks the row rhythm — the same call
 * `Pill` in Components.kt already makes. The state is announced as well as
 * shaded: the web puts `aria-pressed` on these precisely so "in the basket" is
 * said and not only coloured.
 */
@Composable
private fun Chip(text: String, selected: Boolean, onToggle: () -> kotlin.Unit) {
  Box(
    modifier = Modifier
      .heightIn(min = 40.dp)
      .clip(ChipShape)
      .background(if (selected) MerryColors.line else MerryColors.card)
      .border(1.dp, if (selected) MerryColors.tx2 else MerryColors.line, ChipShape)
      .toggleable(value = selected, role = Role.Checkbox) { onToggle() }
      .padding(horizontal = 14.dp, vertical = 10.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(text = text, style = ChipTextStyle, color = MerryColors.tx)
  }
}

/**
 * AN ON/OFF CONTROL, WHICH IS A CHECKBOX AND A SENTENCE.
 *
 * Settings.tsx wraps each of these in a `<label class="mm-field">`, so the whole
 * block — label, box, state sentence and hint — is the hit area. That is kept:
 * a 16dp checkbox on its own is a 16dp target, and the sentence beside it is
 * the part worth reading, so the sentence is part of the button.
 *
 * The green is `accent-color: var(--up)` (forms.css:44) — the same #3dd68c the
 * terminal uses for a gain. It is the web's own choice for a checkbox and it is
 * kept, but it stops here: nothing that reports what happened to a trade may
 * borrow it.
 */
@Composable
private fun CheckField(field: BoolField, checked: Boolean, onChange: (Boolean) -> kotlin.Unit) {
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .toggleable(value = checked, role = Role.Checkbox, onValueChange = onChange),
    verticalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(text = field.label, style = LabelStyle, color = MerryColors.tx)
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      CheckBox16(checked)
      // THE STATE READ-OUT. Two different sentences, not one label with a
      // colour: "off" and "off — unpriceable tokens are never bought" are
      // different promises and the reader is entitled to the second one.
      Text(
        text = if (checked) field.on else field.off,
        style = UnitStyle,
        color = MerryColors.tx2,
      )
    }
    field.help?.let { Hint(it) }
  }
}

/**
 * `input[type=checkbox]` — forms.css:44: 16px square, `accent-color: var(--up)`.
 *
 * Drawn rather than an M3 `Checkbox`, which insists on a 20dp mark inside a
 * 40dp minimum and would not sit at 16dp beside a 12px sentence. Unchecked it
 * wears the input recipe (`--card` on a `--line` hairline) so it reads as part
 * of the same family; the web leaves that state to the UA and has no authored
 * value for it.
 */
@Composable
private fun CheckBox16(checked: Boolean) {
  val shape = RoundedCornerShape(3.dp)
  Box(
    modifier = Modifier
      .size(16.dp)
      .clip(shape)
      .background(if (checked) MerryColors.up else MerryColors.card)
      .then(if (checked) Modifier else Modifier.border(1.dp, MerryColors.line, shape)),
  ) {
    if (checked) {
      Canvas(Modifier.size(16.dp)) {
        val w = size.width
        val h = size.height
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        val path = PathParser().parsePathString(
          "M" + (w * 0.22f) + " " + (h * 0.53f) +
            "L" + (w * 0.42f) + " " + (h * 0.73f) +
            "L" + (w * 0.78f) + " " + (h * 0.30f),
        ).toPath()
        drawPath(path = path, color = MerryColors.ink, style = stroke)
      }
    }
  }
}

/**
 * `.create-locked` — terminal.css:7788-7811:
 * `margin:12px 0 0; padding:12px 14px; border:1px solid #6b5a1f; border-left-width:3px; border-radius:10px; background:#221d0c`,
 * with its `strong` a block at 13px in #d8b44a and its `p` at 12px/1.55 in
 * `--tx-2`.
 *
 * The sheet's own comment says what the register is for: "louder than a hint
 * and quieter than an error, because nothing is broken — they simply have not
 * qualified yet". The asymmetric left border has no Compose modifier, so it is
 * painted over the 1dp border and the text is inset by 3+14 the way content-box
 * sizing puts it.
 */
@Composable
private fun LockedPanel(strong: String, body: String) {
  val shape = RoundedCornerShape(10.dp)
  Column(
    modifier = Modifier
      .fillMaxWidth()
      .padding(top = 12.dp)
      .clip(shape)
      .background(LockGround)
      .border(1.dp, LockEdge, shape)
      .drawBehind { drawRect(color = LockEdge, size = Size(3.dp.toPx(), size.height)) }
      .padding(start = 17.dp, end = 14.dp, top = 12.dp, bottom = 12.dp),
  ) {
    Text(
      text = strong,
      modifier = Modifier.padding(bottom = 4.dp),
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 17.55.sp,
      ),
      color = LockStrong,
    )
    Text(
      text = body,
      style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.6.sp),
      color = MerryColors.tx2,
    )
  }
}

/**
 * `details.settings-group` (forms.css:34-35) and `details.mm-advanced`
 * (forms.css:55), which differ only in their spacing and the summary's weight.
 *
 * Both are CLOSED ON ARRIVAL, as they are on the web. `rememberSaveable` keeps
 * the reader's choice across a save round trip — folding "Advanced settings"
 * back up the moment the form reloads is how somebody loses the field they were
 * halfway through reading.
 */
@Composable
private fun Disclosure(
  summary: String,
  advanced: Boolean = false,
  content: @Composable ColumnScope.() -> kotlin.Unit,
) {
  var open by rememberSaveable(summary) { mutableStateOf(false) }
  Column(
    Modifier
      .fillMaxWidth()
      .padding(top = if (advanced) 32.dp else 28.dp, bottom = if (advanced) 32.dp else 0.dp),
  ) {
    Rule()
    Row(
      modifier = Modifier
        .fillMaxWidth()
        .clickable(role = Role.Button) { open = !open }
        .semantics { stateDescription = if (open) "expanded" else "collapsed" }
        .heightIn(min = 48.dp)
        .padding(top = (if (advanced) 20.dp else 16.dp) + 8.dp, bottom = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      // The web keeps the UA disclosure triangle on these two summaries — only
      // the per-field help removes its marker (forms.css:31-32).
      Marker(open)
      Text(text = summary, style = summaryStyle(!advanced), color = MerryColors.tx)
    }
    if (open) {
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(top = if (advanced) 0.dp else 16.dp, bottom = if (advanced) 20.dp else 0.dp),
        content = content,
      )
    }
  }
}

/** The `<summary>` triangle: pointing right when closed, down when open. */
@Composable
private fun Marker(open: Boolean) {
  Canvas(Modifier.size(9.dp).rotate(if (open) 90f else 0f)) {
    val path = PathParser().parsePathString(
      "M0 0 L${size.width * 0.85f} ${size.height / 2f} L0 ${size.height} Z",
    ).toPath()
    drawPath(path = path, color = MerryColors.tx2)
  }
}

/** The `<select>` chevron the UA draws, at the right end of the box. */
@Composable
private fun Chevron() {
  Canvas(Modifier.size(12.dp)) {
    val path = PathParser().parsePathString(
      "M${size.width * 0.15f} ${size.height * 0.35f}" +
        "L${size.width * 0.5f} ${size.height * 0.68f}" +
        "L${size.width * 0.85f} ${size.height * 0.35f}",
    ).toPath()
    drawPath(
      path = path,
      color = MerryColors.tx2,
      style = Stroke(width = 1.6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
  }
}

/**
 * `.setting-help` — forms.css:30-33.
 *
 * A `<details>` pinned to the top-right corner of the field: a 24px hit area
 * holding a lucide CircleHelp at 15px in `--tx-2`, opening a 240px panel
 * (max 75vw) on `--card` with a 1px `--line` hairline, radius 12 and
 * `box-shadow: 0 12px 28px #0005`.
 *
 * WHAT I APPROXIMATED. Compose has no z-index inside a Column and no
 * viewport-relative sizing, so the panel is a `Popup` anchored to the icon and
 * the 75vw cap is computed from `LocalConfiguration`. The 28px-blur 33%-black
 * shadow does not come out of `shadowElevation`; `Modifier.shadow(12.dp)` is
 * close and is not the same drawing.
 */
@Composable
private fun HelpDisclosure(label: String, help: String, modifier: Modifier = Modifier) {
  var open by remember { mutableStateOf(false) }
  val density = LocalDensity.current
  val cap = (LocalConfiguration.current.screenWidthDp * 0.75f).dp
  Box(
    modifier = modifier
      .size(24.dp)
      .clickable(onClickLabel = "About $label", role = Role.Button) { open = !open }
      .semantics { stateDescription = if (open) "expanded" else "collapsed" },
    contentAlignment = Alignment.Center,
  ) {
    CircleHelp()
    if (open) {
      Popup(
        alignment = Alignment.TopEnd,
        offset = IntOffset(0, with(density) { 24.dp.roundToPx() }),
        onDismissRequest = { open = false },
        properties = PopupProperties(focusable = true),
      ) {
        Column(
          Modifier
            .width(minOf(240.dp, cap))
            .shadow(12.dp, FieldShape)
            .clip(FieldShape)
            .background(MerryColors.card)
            .border(1.dp, MerryColors.line, FieldShape)
            .padding(14.dp),
        ) {
          Text(text = help, style = HintStyle, color = MerryColors.tx2)
        }
      }
    }
  }
}

/**
 * lucide `CircleHelp` at `size={15}`, hand-transcribed on a 24-unit viewBox the
 * way [LucideGlyph] in Components.kt transcribes the empty-state set. The
 * trailing `M12 17h.01` is a zero-length path in the original — a round-capped
 * dot — so it is drawn as a filled circle rather than a stroke that may not
 * render at all.
 */
@Composable
private fun CircleHelp() {
  Canvas(Modifier.size(15.dp)) {
    val s = size.minDimension / 24f
    val stroke = Stroke(width = 2f * s, cap = StrokeCap.Round, join = StrokeJoin.Round)
    drawCircle(
      color = MerryColors.tx2,
      radius = 10f * s,
      center = Offset(12f * s, 12f * s),
      style = stroke,
    )
    val path = PathParser().parsePathString("M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3").toPath()
    scale(s, s, pivot = Offset.Zero) {
      drawPath(path = path, color = MerryColors.tx2, style = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
    drawCircle(color = MerryColors.tx2, radius = 1f * s, center = Offset(12f * s, 17f * s))
  }
}

/** A bound, said the way the terminal says a figure: en-US grouping, no decimals. */
private fun plain(value: Double): String =
  if (value % 1.0 == 0.0) String.format(Locale.US, "%,d", value.toLong())
  else String.format(Locale.US, "%,.2f", value)
