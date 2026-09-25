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
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.platform.LocalUriHandler
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
import dev.merrymen.app.net.SettingsKeys
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.providerKey
import dev.merrymen.app.net.secretStatus
import dev.merrymen.app.ui.HOUSE_AGENT_NAME
import dev.merrymen.app.ui.LIVE_OFF_HINT
import dev.merrymen.app.ui.LIVE_OFF_UNIT
import dev.merrymen.app.ui.LIVE_ON_HINT
import dev.merrymen.app.ui.LIVE_ON_UNIT
import dev.merrymen.app.ui.PUBLIC_BOOK_OFF
import dev.merrymen.app.ui.PUBLIC_BOOK_ON
import dev.merrymen.app.ui.SETTINGS_INTEGERS
import dev.merrymen.app.ui.SETTINGS_RANGES
import dev.merrymen.app.ui.SettingsDraft
import dev.merrymen.app.ui.SettingsShown
import dev.merrymen.app.ui.liveTradingNote
import dev.merrymen.app.ui.outOfRange
import dev.merrymen.app.ui.plainBound
import dev.merrymen.app.ui.plainNumber
import dev.merrymen.app.ui.telegramStartUrl
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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

/**
 * [unit] is the `.mm-unit` slot (forms.css:45) — a 12px `--tx-2` word sitting
 * on the SAME LINE as the field, to its right, exactly as Settings.tsx:1341
 * puts "bps" beside max slippage. The bounds are not here: they are the
 * server's (NUM_FIELDS), mirrored once in [SETTINGS_RANGES].
 */
private data class NumField(
  val key: String,
  val label: String,
  val unit: String,
  val help: String,
)

private val NUMBERS = listOf(
  NumField("buyPerTickUsdg", "Size per trade", "USDG", "What it puts to work each time it trades."),
  NumField("slippageBps", "Max slippage", "bps", "Refuse a fill worse than this far off the quote."),
  NumField("maxImpactBps", "Max price impact", "bps", "Refuse a trade that would move the price more than this. 0 turns the guard off."),
  NumField("takeProfitBps", "Take profit", "bps", "Sell a leg once it is this far ahead of what it cost. 0 disables it — and it is the default strategy's only exit."),
  NumField("strategistStopLossBps", "Stop loss", "bps", "0 is off. A tight floor on a small ticket pays the chain to churn."),
  NumField("llmMaxActionUsdg", "Strategist ceiling", "USDG", "The most one model-proposed action may spend."),
)

/**
 * THE CLASS ROUTE'S FOUR NUMBERS — Settings.tsx:1270-1310, labels and hints
 * from en.ts. They had a type, a PUT-allowlist entry and a worker read, and no
 * control on the phone, so the route could not be configured from here at all.
 */
private val CLASS_NUMBERS = listOf(
  NumField("classPerEntryUsdg", "per entry (USDG)", "USDG", "Spent on a single class entry. 0 means nothing is bought, whatever the switch says."),
  NumField("classMaxPositions", "max open positions", "", "How many class positions may be held at once. 0 = no limit beyond the scout budget."),
  NumField("classMaxHoldSec", "maximum holding time (seconds)", "sec", "For bonding-curve positions: attempt an exit after this duration, even when a market price is unavailable. Quotes, liquidity and signed limits still apply."),
  NumField("classMinDepthUsdg", "minimum curve depth (USDG)", "USDG", "Real money raised into the curve, excluding the virtual seed it opens with. Below this, an entry is refused."),
)

/**
 * A checkbox row, and the two sentences that are the actual read-out.
 *
 * [on] and [off] are the `.mm-unit` state copy, taken WORD FOR WORD from
 * Settings.tsx. They are not decoration: "off — unpriceable tokens are never
 * bought" and "off" are different promises, and a bare toggle with no sentence
 * leaves the reader to guess which one a given switch is making.
 */
private data class BoolField(
  val key: String,
  val label: String,
  val on: String,
  val off: String,
  val help: String? = null,
)

/**
 * THE SWITCH THAT DECIDES WHETHER MONEY IS REAL — Settings.tsx:585-629.
 *
 * `liveTradingEnabled` is the only consent to trade real money: the worker's
 * canTradeForReal requires it, and funding the account or re-signing the
 * permission does not turn it on. This form had no control for it, only the
 * paper switch below, so an owner could not see or change whether real money
 * traded except through a chat card. Its hint changes with its state, so it is
 * drawn by [LiveTradingField], not by [CheckField].
 */
private val LIVE = BoolField(key = "liveTradingEnabled", label = "live trading", on = LIVE_ON_UNIT, off = LIVE_OFF_UNIT)

/**
 * "PRACTICE FILLS" WAS READ AS THE MODE, AND IT IS NOT ONE.
 *
 * `paperTradingEnabled` answers a different question from Live trading: not
 * "may real orders reach the chain" but "when they may not, should the agent
 * simulate instead" (core settings.ts). Labelled "Practice fills" and alone on
 * the page, an owner who unticked it expecting to go live got an agent that
 * neither traded nor practised. So it sits UNDER the Live switch and says the
 * two things it can mean, in the web's own words for them (live-blocker.ts:
 * "an agent with paper trading on is simulating, one with it off is doing
 * nothing at all").
 */
private val PAPER = BoolField(
  key = "paperTradingEnabled",
  label = "practise while not live",
  on = "on — while Live trading is off, your agent is simulating, at live prices",
  off = "off — while Live trading is off, your agent is doing nothing at all",
  help = "This never makes money real — only Live trading above does. It decides what your agent does " +
    "while it is not trading for real: practise with simulated money, or sit still.",
)

/** Settings.tsx:660-700 — the Trencher card's two switches. */
private val TRENCHER_FAST = BoolField(
  key = "trencherFastEnabled",
  label = "fast Trencher exits",
  on = "on — exits are attempted at −10%, +20%, or after 30 minutes",
  off = "off — its standard exit profile",
  help = "Applies when the strategy is Trencher. Off restores its standard exit profile.",
)

private val TRENCHER_LIVE = BoolField(
  key = "trencherLiveEnabled",
  label = "let trencher trade for real",
  on = "trencher can open real positions",
  off = "paper only",
  help = "Allows live Trencher trades in tokens covered by your trading permissions.",
)

/** Settings.tsx:1103-1117 — the `discovery · new pairs as they launch` block. */
private val DISCOVERY = BoolField(
  key = "discoveryEnabled",
  label = "watch for new pairs",
  on = "tells you when something launches",
  off = "off",
  help = "Requires a Bitquery key or a Merry Circle token — both are set on the web, under Connections.",
)

/** Settings.tsx:1176-1206 — the `scout mode` block, both of its switches. */
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

/** Settings.tsx:1255-1268 — the class route's switch. */
private val CLASS_ROUTE = BoolField(
  key = "classSnipeEnabled",
  label = "class route",
  on = "may buy newly launched coins",
  off = "off — no coin is bought unless you listed it",
  help = "Separate from sealing a vault at /grant. That says this key COULD reach one; this says go and do it.",
)

/** Settings.tsx:1386-1392 — inside the collapsed `Telegram` group. */
private val TELEGRAM = BoolField(
  key = "telegramEnabled",
  label = "enable telegram",
  on = "the bot is listening",
  off = "off",
)

/** Settings.tsx:1408-1433 — the `Telegram controls` section inside Advanced. */
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

/** Settings.tsx:716-734 — the three asset modes, and what each one means for buying. */
private val ASSET_MODES = listOf(
  SelectOption("all", "All assets"),
  SelectOption("stocks", "Stocks only"),
  SelectOption("crypto", "Crypto only"),
)

private fun assetModeHint(mode: String): String = when (mode) {
  "stocks" -> "Only tokenised equities and ETFs. Your agent will be idle while US markets are shut, and it will not buy coins even if they are in your basket."
  "crypto" -> "Only coins. Stocks in your basket stay priced and sellable — they just stop being bought."
  else -> "Everything your basket and your signed permission allow."
}

/**
 * THE FORM, top to bottom in the web's order: whether money is real first,
 * because a strategy, a cap or a venue only matters once you know that; then
 * what it trades; then the agent; then the book; then the basket and the
 * drawers.
 *
 * Every control reads [SettingsShown] (the edit, else the stored value, else
 * the default) and writes through [onDraft], so the only thing a save can send
 * is what a control put there. [keys] is the masked-key status from the same
 * read, [telegram] the bridge status for the link code (null when unread —
 * which says "checking", never "no code"), and [hosted] the session route's
 * word on whether this is the hosted service.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsForm(
  env: SettingsEnvelope,
  keys: SettingsKeys?,
  telegram: TelegramStatus?,
  hosted: Boolean?,
  draft: SettingsDraft,
  onDraft: (SettingsDraft) -> kotlin.Unit,
  circleLocked: Set<String>,
  onWeb: (path: String, title: String) -> kotlin.Unit,
  onTelegram: () -> kotlin.Unit,
) {
  val shown = SettingsShown(env, draft)
  fun setBool(key: String): (Boolean) -> kotlin.Unit = { onDraft(draft.setBool(key, it)) }

  Column(Modifier.fillMaxWidth()) {

    // ── TRADING MODE ────────────────────────────────────────────────────────
    // Settings.tsx:568 — FIRST ON THE PAGE, because it outranks everything
    // below it.
    SectionHeading("Trading mode")
    FieldGrid {
      LiveTradingField(shown) { onDraft(draft.setBool(LIVE.key, it)) }
      CheckField(PAPER, shown.bool(PAPER.key), setBool(PAPER.key))
    }

    // ── WHAT IT TRADES ──────────────────────────────────────────────────────
    SectionHeading("What it trades")
    TrencherCard(env, shown, draft, onDraft, onWeb)
    Spacer(Modifier.height(24.dp))
    val mode = shown.str("assetMode").ifBlank { "all" }
    FieldGrid {
      Field("asset mode") {
        SelectBox(
          display = ASSET_MODES.firstOrNull { it.value == mode }?.label ?: mode,
          options = ASSET_MODES,
          selected = mode,
          onPick = { onDraft(draft.setText("assetMode", it)) },
        )
        Hint(assetModeHint(mode))
      }
    }
    // SAID BEFORE IT BITES (Settings.tsx:737-748). Narrowing the pool
    // re-splits every surviving leg's weight, so this is a dropdown that
    // moves real money for some owners.
    if (mode != "all") {
      Spacer(Modifier.height(8.dp))
      Hint(
        "Anything you already hold stays priced, valued and sellable — including its stop-loss and " +
          "take-profit. This only changes what your agent may buy." +
          if (shown.list("basketSymbols").isNotEmpty()) " If it leaves you with nothing to buy, your agent will say so rather than going quiet." else "",
      )
    }

    // ── AGENT SETTINGS ──────────────────────────────────────────────────────
    // Settings.tsx:750. The heading strings on this screen are exact: the web
    // says "Agent settings", not "Your agent".
    SectionHeading("Agent settings")
    FieldGrid {
      Field("Agent name", help = "Up to 24 letters, numbers, or spaces.") {
        InputBox(
          value = shown.str("agentName"),
          // A BLANK NAME IS UNTOUCHED, not "clear to Robin". The route reads
          // "" as a reset to the house name, and deleting the last letter on
          // the way to typing a new one is not a request for that.
          onValueChange = { typed ->
            onDraft(if (typed.isBlank()) draft.without(listOf("agentName")) else draft.setText("agentName", typed))
          },
          placeholder = env.str("agentName") ?: HOUSE_AGENT_NAME,
        )
      }

      val current = shown.str("strategy")
      Field("Strategy") {
        // THE HOLDER GATE LIVES IN THE OPTION STRING. Settings.tsx:866 appends
        // the literal " · holders only" to the option label because a <select>
        // has nowhere to hang a badge — and app/settings/honesty.test.ts counts
        // that exact string.
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
          onPick = { onDraft(draft.setText("strategy", it)) },
        )
      }

      // THE LOCK IS STATED AT THE POINT OF CHOICE, in the amber `.create-locked`
      // register — "louder than a hint and quieter than an error". This page has
      // not read /api/tier, so it says only what it can back up.
      if (current in circleLocked) {
        LockedPanel(
          strong = "This is a Merry Circle strategy.",
          body = "It only runs while you hold enough \$MERRYMEN — picking it now means the " +
            "agent stays idle until you do.",
        )
      }
    }

    // ── PUBLIC BOOK ─────────────────────────────────────────────────────────
    SectionHeading("Public book")
    PublicBookField(shown, draft, onDraft)

    // ── TRADING BASKET ──────────────────────────────────────────────────────
    // Settings.tsx:925-970. GROUPED, because one undifferentiated run of chips
    // is what an owner meant by "trading basket in settings is full of all
    // stocks": twenty-five registry symbols with his own coin unselected at
    // the end, and nothing said the two kinds were different.
    SectionHeading("Trading basket")
    val basket = shown.list("basketSymbols")
    val coins = customTokenSymbols(env, draft)
    listOf("stocks & etfs" to env.knownSymbols, "coins" to coins).forEach { (heading, syms) ->
      SubtleHead(heading)
      if (syms.isEmpty()) {
        // An empty group rendered as nothing is how an owner concludes the
        // feature does not exist. On the phone a coin arrives through "Coins
        // to consider", where the agent's own suggestions are.
        Hint("None yet — take a suggestion from your agent under Coins to consider.")
      } else {
        // `.mm-chips` (forms.css:49): flex, WRAP, gap 8px.
        FlowRow(
          modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          syms.forEach { sym ->
            Chip(sym, sym in basket) {
              val next = basket.toMutableList()
              if (sym in next) next.remove(sym) else next.add(sym)
              onDraft(draft.setList("basketSymbols", next))
            }
          }
        }
      }
    }
    Spacer(Modifier.height(12.dp))
    // EMPTY IS NOT NOTHING. Settings.tsx:971-975, verbatim: an empty basket
    // falls back to the default one rather than standing the agent down.
    Hint(
      if (basket.isEmpty()) "select at least one symbol (empty falls back to the default basket)"
      else "trading " + basket.joinToString(" · "),
    )

    // ── CUSTOM TOKENS & DISCOVERY (collapsed) ───────────────────────────────
    // Settings.tsx:989. `details.settings-group`, closed on arrival.
    Disclosure("Custom tokens & discovery") {
      SubtleHead("discovery · new pairs as they launch")
      FieldGrid {
        CheckField(DISCOVERY, shown.bool(DISCOVERY.key), setBool(DISCOVERY.key))
        OfficialCoinsField(env, shown) { onDraft(draft.setBool("officialCoinsEnabled", it)) }
      }

      SubtleHead("scout mode · buying what can't be priced yet")
      Hint(
        "Buy tokens without a reliable market price, within your scout budget. " +
          "These positions are valued at purchase cost.",
      )
      FieldGrid {
        SCOUT_SWITCHES.forEach { CheckField(it, shown.bool(it.key), setBool(it.key)) }
      }
      // A CLAIM ABOUT WHAT THE BREAKER CANNOT DO — Settings.tsx:1231-1244,
      // word for word. The second half renders only when scout is on AND the
      // budget is exactly 0. The budget is read, never written — this form has
      // no field for it.
      Danger(scoutWarning(zeroBudget = shown.bool("scoutEnabled") && env.num("scoutBudgetUsdg") == 0.0))

      SubtleHead("class route · buying a coin nobody listed")
      Hint(
        "Buy a token straight off a Pons bonding curve, held in your own vault so it can be sold " +
          "again. Needs a class vault factory in Connections and a re-signed key — and the scout " +
          "budget above still bounds it.",
      )
      FieldGrid {
        CheckField(CLASS_ROUTE, shown.bool(CLASS_ROUTE.key), setBool(CLASS_ROUTE.key))
        CLASS_NUMBERS.forEach { f -> NumberField(f, shown, draft, onDraft) }
      }
      // TWO SWITCHES RATHER THAN ONE, because they fail differently
      // (Settings.tsx:1312-1318): a route on with a size of 0 buys nothing.
      if (shown.bool(CLASS_ROUTE.key) && shown.number("classPerEntryUsdg") == 0.0) {
        Spacer(Modifier.height(12.dp))
        Danger(
          buildAnnotatedString {
            append("The class route is on but the size is ")
            withStyle(SpanStyle(fontFamily = sans(13.sp, FontWeight.W600), fontWeight = FontWeight.W600)) { append("0") }
            append(", so nothing will be bought. Two switches rather than one, because they fail differently — set a size or turn the route back off.")
          },
        )
      }
    }

    // ── TELEGRAM (collapsed) ────────────────────────────────────────────────
    // Settings.tsx:1322. THE CODE, BESIDE THE INSTRUCTION THAT NEEDS IT: two
    // beta testers stopped where the two were in different drawers.
    Disclosure("Telegram") {
      TelegramLinkLines(telegram, keys?.telegramBotToken?.set ?: env.telegramBotToken.set)
      Spacer(Modifier.height(16.dp))
      FieldGrid {
        CheckField(TELEGRAM, shown.bool(TELEGRAM.key), setBool(TELEGRAM.key))
        TextLink("Bot status and test →", onTelegram)
      }
    }

    // ── KEYS (collapsed) ────────────────────────────────────────────────────
    // THE PHONE SHOWS WHETHER A KEY IS SET, AND NEVER TAKES ONE. The server
    // sends only `{set, hint}` for a secret; typing keys stays on the web,
    // where the provider picker and its model list live.
    Disclosure("Keys") {
      KeysStatus(env, keys, hosted)
      Spacer(Modifier.height(16.dp))
      TextLink("Change on the web →") { onWeb("/settings", "Settings") }
    }

    // ── ADVANCED (collapsed) ────────────────────────────────────────────────
    // Settings.tsx:1405. `details.mm-advanced`, closed by default on the web
    // too — faithful, and it does put the slippage and stop-loss guards one
    // tap further away than they were.
    Disclosure("Advanced settings", advanced = true) {
      SectionHeading("Telegram controls")
      FieldGrid {
        TELEGRAM_CONTROLS.forEach { CheckField(it, shown.bool(it.key), setBool(it.key)) }
      }

      SectionHeading("Trading preferences")
      FieldGrid {
        NUMBERS.forEach { f -> NumberField(f, shown, draft, onDraft) }
      }
    }
  }
}

/** The symbols of the owner's own tokens: the draft's list if they changed it, else the stored one. */
private fun customTokenSymbols(env: SettingsEnvelope, draft: SettingsDraft): List<String> {
  val raw = draft.edits["customTokens"] ?: env.raw("customTokens")
  return (raw as? JsonArray)?.mapNotNull { t ->
    ((t as? JsonObject)?.get("symbol") as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
  } ?: emptyList()
}

/**
 * THE LIVE TRADING SWITCH AND EVERY SENTENCE THAT COMES WITH IT.
 *
 * The state read-out and the hint are the web's (Settings.tsx:585-608), and
 * the two warnings are drawn from [liveTradingNote] the moment the box stops
 * matching what is saved — so there is no way to tick it on without "This
 * spends real money." on screen beneath it, and no way to tick it off without
 * the one about real positions left unmanaged. Both are said BEFORE the save,
 * the last moment either can still help.
 */
@Composable
private fun LiveTradingField(shown: SettingsShown, onChange: (Boolean) -> kotlin.Unit) {
  val on = shown.bool(LIVE.key)
  Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
    CheckField(LIVE.copy(help = if (on) LIVE_ON_HINT else LIVE_OFF_HINT), on, onChange)
    liveTradingNote(shown)?.let { note ->
      Text(
        text = buildAnnotatedString {
          withStyle(SpanStyle(fontFamily = sans(12.sp, FontWeight.W600), fontWeight = FontWeight.W600, color = MerryColors.tx)) {
            append(note.lead)
          }
          append(note.body)
        },
        style = HintStyle,
        color = MerryColors.tx2,
      )
    }
  }
}

/**
 * THE PUBLIC BOOK, AS A CONSENT (Profile.tsx BookSwitch, with a second step).
 *
 * The read-out names everything the flag publishes — trade sizes and dollar
 * P&L, holdings, and its name as a holder on token pages — because the switch
 * decides all of it. Ticking it on does not change the draft: it opens the
 * disclosure with "Publish my book" and "Not now", and only the first puts
 * `publicBook: true` in the save. Unticking needs no confirmation.
 */
@Composable
private fun PublicBookField(shown: SettingsShown, draft: SettingsDraft, onDraft: (SettingsDraft) -> kotlin.Unit) {
  val on = shown.bool("publicBook")
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    CheckField(
      BoolField(
        key = "publicBook",
        label = "publish this agent's book",
        on = "on — sizes, dollar P&L and holdings are public",
        off = "off — only its return and each trade's percentage are public",
        help = if (on) PUBLIC_BOOK_ON else PUBLIC_BOOK_OFF,
      ),
      checked = on || draft.publicBookAsked,
      onChange = { want ->
        onDraft(
          when {
            want -> draft.askPublicBook()
            // Saved private: unticking only takes back the request (or the
            // confirmed edit) — there is nothing to turn off.
            !shown.savedBool("publicBook") -> draft.cancelPublicBook().without(listOf("publicBook"))
            else -> draft.publicBookOff()
          },
        )
      },
    )
    if (draft.publicBookAsked && !on) {
      LockedPanel(
        strong = "Publish your book?",
        body = "Anyone will be able to see this agent's trade sizes and dollar P&L, what it holds and how " +
          "much, and its name as a holder on the token pages of what it holds. Nothing is published until " +
          "you confirm here and then save.",
      )
      Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        SmallButton("Publish my book", strong = true) { onDraft(draft.confirmPublicBook()) }
        SmallButton("Not now") { onDraft(draft.cancelPublicBook()) }
      }
    }
  }
}

/**
 * THE TRENCHER CARD — Settings.tsx:640-705: what the mode is, the switch that
 * lets it spend real money right beside that explanation (it used to live 445
 * lines further down, in a closed drawer), and the fast-exit profile.
 *
 * "Prepare Trencher mode" fills the draft exactly as the web's button does —
 * crypto, the platform coins, discovery, the owner's coins in the basket, fast
 * exits, the trencher strategy and a 15-second tick — and saves nothing: the
 * owner still reads the form and presses Save.
 */
@Composable
private fun TrencherCard(
  env: SettingsEnvelope,
  shown: SettingsShown,
  draft: SettingsDraft,
  onDraft: (SettingsDraft) -> kotlin.Unit,
  onWeb: (String, String) -> kotlin.Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Text("Trencher mode · fast memecoin setup", style = LabelStyle, color = MerryColors.tx)
    Hint(
      "Your Merryman tracks active memecoin pools with at least \$100,000 in daily volume, 20 distinct buyers, " +
        "recent activity and both buys and sells. Brain reviews eligible coins in the background about once a " +
        "minute; execution and exit checks run every 15 seconds. New buys need a fresh Brain approval. Brain can " +
        "also sell early. The fast profile attempts exits at −10%, +20%, or after 30 minutes, even while Brain is " +
        "unavailable. Liquidity loss can trigger an earlier exit.",
    )
    Hint(
      "Entries remain \$5, subject to your budget and signed limits. Only discovered, priced pools that pass the " +
        "liquidity, age and valuation checks qualify. With Autonomous Trencher permission, it finds verified pool " +
        "tokens itself; no custom-token list is required. Existing positions remain monitored for exits.",
    )
    SmallButton("Prepare Trencher mode") {
      val basket = (shown.list("basketSymbols") + customTokenSymbols(env, draft)).distinct()
      onDraft(
        draft.setText("assetMode", "crypto")
          .setBool("officialCoinsEnabled", true)
          .setBool("discoveryEnabled", true)
          .setList("basketSymbols", basket)
          .setBool(TRENCHER_FAST.key, true)
          .setText("strategy", "trencher")
          .setNumber("tickSeconds", "15", integer = true),
      )
    }
    CheckField(TRENCHER_FAST, shown.bool(TRENCHER_FAST.key)) { onDraft(draft.setBool(TRENCHER_FAST.key, it)) }
    CheckField(TRENCHER_LIVE, shown.bool(TRENCHER_LIVE.key)) { onDraft(draft.setBool(TRENCHER_LIVE.key, it)) }
    Hint(
      "Save changes below, then update your trading permission and select Autonomous Trencher. It is available " +
        "only after the verified vault deployment is configured. Without that permission, the existing route can " +
        "trade only individually authorized tokens. Brain must be connected and the recorded portfolio must pass " +
        "its accounting checks. For real trades, enable live trading and “let trencher trade for real” " +
        "explicitly. Volatile coins can move beyond exit thresholds before a fill; timing and prices are not " +
        "guaranteed.",
    )
    TextLink("Update trading permission →") { onWeb("/grant", "Wallet & permissions") }
  }
}

/**
 * THE PLATFORM COIN LIST — Settings.tsx:1124-1154. THE ONE TOGGLE HERE THAT
 * STARTS ON, and THREE STATES, NOT TWO: off; on with coins listed; and on with
 * none listed on this chain, which is a different fact from "off" and used to
 * be printed as "coins are in your basket". `officialCoins` null means the
 * server did not send the list — then the count is not claimed either way.
 */
@Composable
private fun OfficialCoinsField(env: SettingsEnvelope, shown: SettingsShown, onChange: (Boolean) -> kotlin.Unit) {
  val listed = env.officialCoins
  val on = shown.bool("officialCoinsEnabled")
  val unit = when {
    !on -> "stocks only"
    listed == null -> "on"
    listed.isNotEmpty() -> "${listed.size} in your basket: ${listed.joinToString(", ")}"
    else -> "on — but none are listed on this chain yet"
  }
  val lead = if (listed != null && listed.isNotEmpty()) {
    "Verified coins we publish, watched and traded without you adding them. Coins trade"
  } else {
    "When we publish verified coins on this chain they appear here automatically. There are none yet, so this setting changes nothing today. Coins trade"
  }
  CheckField(
    BoolField(
      key = "officialCoinsEnabled",
      label = "trade the platform coin list",
      on = unit,
      off = unit,
      help = "$lead around the clock, so your agent keeps working when the stock market is shut. Your caps, " +
        "budgets and trading permissions still apply — and a coin listed after you signed needs a free re-sign " +
        "at /grant before your key can touch it.",
    ),
    on,
    onChange,
  )
}

/**
 * A NUMBER BOX: the typed text is shown as typed, a value this form cannot read
 * is said in red and blocks the save, and a value the server will refuse is
 * said before the round trip. The stored value is the placeholder, so a box
 * emptied on the way to a new figure still says what is in force.
 */
@Composable
private fun NumberField(f: NumField, shown: SettingsShown, draft: SettingsDraft, onDraft: (SettingsDraft) -> kotlin.Unit) {
  val range = SETTINGS_RANGES[f.key]
  val integer = f.key in SETTINGS_INTEGERS
  Field(
    label = f.label,
    help = f.help + (range?.let { " Between ${plainBound(it.start)} and ${plainBound(it.endInclusive)}." } ?: ""),
  ) {
    // `.mm-input` (forms.css:38) is a flex row: the field takes the slack
    // and the unit keeps its intrinsic width beside it.
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      InputBox(
        value = shown.numberText(f.key),
        onValueChange = { raw -> onDraft(draft.setNumber(f.key, raw, integer)) },
        modifier = Modifier.weight(1f),
        placeholder = shown.number(f.key)?.let { "saved: " + plainNumber(it) },
        numeric = true,
        keyboardType = if (integer) KeyboardType.Number else KeyboardType.Decimal,
      )
      if (f.unit.isNotBlank()) Unit(f.unit)
    }
    val problem = draft.unreadable[f.key]?.let { "Can't send this: $it." } ?: outOfRange(f.key, shown.number(f.key))
    if (problem != null) Danger(AnnotatedString(problem))
  }
}

/**
 * The link code and what to do with it, in one place (Settings.tsx:1337-1356).
 * A missing code is a WAIT, not an absence: the agent mints one on its next
 * pass after a token is saved. An unread bridge says so, never "no code".
 */
@Composable
private fun TelegramLinkLines(tg: TelegramStatus?, tokenSet: Boolean) {
  val uri = LocalUriHandler.current
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Hint("Create a bot with @BotFather and add its token on the web.")
    val code = tg?.linkCode
    when {
      tg == null -> Hint("Checking the bridge for a link code…")
      code != null -> {
        Hint("Then send this to your bot to connect it:")
        Text("/link $code", style = InputStyle, color = MerryColors.tx)
        telegramStartUrl(tg.botUsername, code)?.let { url ->
          TextLink("Open Telegram →") { runCatching { uri.openUri(url) } }
        }
        // A BEARER CREDENTIAL. `/link <code>` is accepted from any chat, first
        // come, and grants control of this agent.
        Hint("Anyone who has this code can control your agent — do not share or screenshot it.")
      }
      tokenSet -> Hint("No link code yet. Your agent mints one on its next pass with this token set — check back shortly.")
      else -> Hint("Your link code appears here once a token is saved.")
    }
  }
}

/**
 * THE MASKED KEYS, as status lines. Hosted, the bundler is the house's and is
 * not shown (Settings.tsx renders the Pimlico field only when `hosted ===
 * false`); the AI key is optional there, because the shared key is the default.
 */
@Composable
private fun KeysStatus(env: SettingsEnvelope, keys: SettingsKeys?, hosted: Boolean?) {
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Hint("Keys are typed on the web, never on the phone. This shows only whether each is saved.")
    if (keys != null) {
      val (provider, view) = keys.providerKey(env)
      KeyLine("$provider API key", secretStatus(view))
      if (hosted == true) Hint("Optional. Add your own provider for chat and the Strategist.")
      KeyLine("Telegram bot token", secretStatus(keys.telegramBotToken))
      if (hosted == false) KeyLine("Pimlico API key", secretStatus(keys.bundlerApiKey))
    } else {
      KeyLine("AI provider key", secretStatus(env.llmApiKey))
      KeyLine("Telegram bot token", secretStatus(env.telegramBotToken))
      if (hosted == false) KeyLine("Pimlico API key", secretStatus(env.bundlerApiKey))
    }
  }
}

@Composable
private fun KeyLine(label: String, status: String) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
    Text(label, style = LabelStyle, color = MerryColors.tx, modifier = Modifier.weight(1f))
    Text(status, style = UnitStyle, color = MerryColors.tx2)
  }
}

/** A plain text control in the form's own register: `--tx`, 13px, 44dp tall. */
@Composable
private fun TextLink(label: String, onClick: () -> kotlin.Unit) {
  Box(
    Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick),
    contentAlignment = Alignment.CenterStart,
  ) {
    Text(label, style = ChipTextStyle.copy(fontWeight = FontWeight.W600, fontFamily = sans(13.sp, FontWeight.W600)), color = MerryColors.tx)
  }
}

/**
 * `.mm-btn` (forms.css:51-53), small: the chip box when quiet, the `--tx`
 * ground when [strong] — which is only ever the confirming step of a consent.
 */
@Composable
private fun SmallButton(label: String, strong: Boolean = false, onClick: () -> kotlin.Unit) {
  Box(
    Modifier
      .heightIn(min = 40.dp)
      .clip(ChipShape)
      .background(if (strong) MerryColors.tx else MerryColors.card)
      .then(if (strong) Modifier else Modifier.border(1.dp, MerryColors.line, ChipShape))
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 14.dp, vertical = 10.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      label,
      style = ChipTextStyle.copy(fontWeight = FontWeight.W600, fontFamily = sans(13.sp, FontWeight.W600)),
      color = if (strong) MerryColors.ink else MerryColors.tx,
    )
  }
}


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
