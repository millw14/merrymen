package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ProposalsView
import dev.merrymen.app.ui.Acted
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.RISK_PROFILES
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.applyRisk
import dev.merrymen.app.ui.approveProposals
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.LimitCheck
import dev.merrymen.app.ui.Placed
import dev.merrymen.app.ui.TradeCard
import dev.merrymen.app.ui.TradeDesk
import dev.merrymen.app.ui.TradeOpen
import dev.merrymen.app.ui.TradeStep
import dev.merrymen.app.ui.riskLevelOf
import dev.merrymen.app.data.chatKeyFor
import dev.merrymen.app.data.receiptText
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.said
import dev.merrymen.app.net.valueOrNull
import androidx.compose.foundation.horizontalScroll
import androidx.compose.runtime.collectAsState
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------------
// PAGE CHROME
// ---------------------------------------------------------------------------

/**
 * A PUSHED SCREEN'S HEADER — the token screen's, because that is the one the web
 * gives a page you arrived at from somewhere else.
 *
 * `terminal.css:1137-1161` (`.token-top`): a three-column grid,
 * `22px minmax(0,1fr) auto`, `align-items: center`, `gap: 10px`, whose first cell
 * is `.back` — and `.back` (terminal.css:1123) is not an icon at all: it is the
 * literal character "←" (U+2190) at `color: var(--tx-2); font-size: 15px;
 * font-weight: 600; line-height: 1`. The title beside it is `.token-top h1`,
 * 17px with `letter-spacing: -0.03em`, inheriting weight 600 from the sheet's
 * generic `h1`.
 *
 * NOT `.top-title`. The 34px heading (polish.css:109) belongs to the five TAB
 * screens — Home, Feed, Alpha, Profile — which have no way back because they are
 * the top of the stack. Proposals, Trade and Risk are pushed, they carry a back
 * control, and giving them the 34px title would claim a place in the tab bar
 * they do not have.
 *
 * The 22dp back cell is the web's own width and is under Android's 44dp
 * guidance; it is 44dp TALL so the row is at least a full touch target
 * vertically. This is the same trade [dev.merrymen.app.ui.Pill] documents: the
 * drawn box is the web's, and growing it is a product decision rather than a
 * restyle. `onClickLabel` carries the web's `aria-label="Back"`.
 */
@Composable
private fun Head(title: String, nav: NavHostController) {
  Row(
    Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Box(
      Modifier
        .width(22.dp)
        .height(44.dp)
        .clickable(onClickLabel = "Back") { nav.popBackStack() },
      contentAlignment = Alignment.CenterStart,
    ) {
      Text(
        text = "←",
        style = TextStyle(
          fontFamily = sans(15.sp, FontWeight.W600),
          fontSize = 15.sp,
          fontWeight = FontWeight.W600,
          lineHeight = 15.sp,
        ),
        color = MerryColors.tx2,
      )
    }
    Text(
      text = title,
      style = TextStyle(
        fontFamily = sans(17.sp, FontWeight.W600),
        fontSize = 17.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.03).em,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * The page box, from the one rule that decides it on a phone.
 *
 * `polish.css:87` inside `@media (max-width: 1099px)`:
 * `padding: 16px 20px calc(100px + env(safe-area-inset-bottom)); gap: 14px`.
 * The gutter and the gap come from [PagePadH] / [PagePadTop] / [PageGap] rather
 * than being spelled again here, and the bottom clearance from
 * [BottomInsetSpacer] — the tab bar is `position: fixed`, so the content has to
 * scroll UNDER it and the clearance belongs inside the scroller.
 *
 * The padding sits INSIDE `verticalScroll` deliberately: in the browser it is
 * padding on the scroll box, so the top gap scrolls away with the header and the
 * bottom one sits after the last card. Putting it outside would pin the header
 * and stop the last card ever clearing the bar.
 */
@Composable
private fun Page(title: String, nav: NavHostController, content: @Composable ColumnScope.() -> Unit) {
  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      .padding(top = PagePadTop),
    verticalArrangement = Arrangement.spacedBy(PageGap),
  ) {
    Head(title, nav)
    content()
    BottomInsetSpacer()
  }
}

// ---------------------------------------------------------------------------
// THE BUTTON VOCABULARY THESE THREE SCREENS NEED
// ---------------------------------------------------------------------------

/**
 * `.btn` — the generic tertiary button. terminal.css:2221:
 * `padding: 10px 16px; border-radius: 12px; background: var(--raised); font-weight: 600`,
 * with no font-size of its own so it inherits the app's 15px and no colour of
 * its own so it inherits `--tx`.
 *
 * IT IS NEVER TINTED BY SIDE. Buy and Sell are pre-trade CONTROLS — nothing has
 * happened, no money has moved — and `--up` / `--down` are set as a colour in
 * this product only when it has. A green Buy and a red Sell would be the same
 * mistake as a green refusal, made one screen earlier.
 *
 * `min-height` is Android's 44dp rather than the web's computed ~40px: the CSS
 * box is a mouse target and this one is a thumb target. Nothing else moves.
 */
@Composable
private fun Btn(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .heightIn(min = 44.dp)
      .alpha(if (enabled) 1f else DISABLED_CONFIRM)
      .clip(shape)
      .background(MerryColors.raised)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 10.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(15.sp, FontWeight.W600),
        fontSize = 15.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * `.flow-primary` — the money-flow primary, at its FINAL cascade value.
 *
 * terminal.css:416-429 declares it `background: var(--lime); min-height: 50px`
 * and terminal.css:4351-4358 redeclares it at equal specificity later with
 * `background: var(--tx); min-height: 48px` — so the lime version never renders
 * anywhere and porting it would give the app an accent the web does not have.
 * The live rule: `width: 100%; min-height: 48px; padding: 14px 18px;
 * border-radius: 12px; background: var(--tx); color: var(--ink); 14px/600`.
 *
 * One per card, and only where the whole card is that one action — which is how
 * the web spends it (`FundingPanel`'s "Copy deposit address", `LimitsPanel`'s
 * "Edit signed limits"). A card with two sibling actions uses two [Btn]s.
 */
@Composable
private fun FlowPrimary(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .fillMaxWidth()
      .heightIn(min = 48.dp)
      .alpha(if (enabled) 1f else DISABLED_CONFIRM)
      .clip(shape)
      .background(MerryColors.tx)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 18.dp, vertical = 14.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W600),
        fontSize = 14.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.ink,
    )
  }
}

/**
 * `.proposal-add-all` (terminal.css:7385) and `.proposal-add` (terminal.css:7403)
 * — the two outline pills of the proposals panel, which differ in exactly three
 * things and are one composable because of it.
 *
 * Shared: `border-radius: 999px; background: transparent; color: var(--tx);
 * font-size: 13px`.
 * The batch control is `width: 100%; padding: 9px 14px; border: 1px solid
 * var(--lime)` — full width and above the list, because the sheet says a pill
 * tucked beside one coin "would read as belonging to that coin".
 * The per-coin control is `align-self: flex-start; padding: 7px 14px; border:
 * 1px solid var(--line)`.
 *
 * The disabled alphas are 0.6 and 0.55 and they are NOT rounded together: the
 * terminal keeps four different disabled opacities and the tokens spec names
 * unifying them as a loss of fidelity.
 */
@Composable
private fun OutlinePill(
  label: String,
  enabled: Boolean,
  borderColor: Color,
  disabledAlpha: Float,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  horizontalPadding: androidx.compose.ui.unit.Dp = 14.dp,
  verticalPadding: androidx.compose.ui.unit.Dp = 9.dp,
) {
  val shape = RoundedCornerShape(50)
  Box(
    modifier
      .alpha(if (enabled) 1f else disabledAlpha)
      .clip(shape)
      .border(1.dp, borderColor, shape)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = horizontalPadding, vertical = verticalPadding),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(13.sp),
        fontSize = 13.sp,
        fontWeight = FontWeight.W400,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * `.proposal-resign` — terminal.css:7447: `padding: 9px 16px; border: 0;
 * border-radius: 999px; background: var(--lime); color: var(--ink); 13px/600`.
 *
 * LIME IS A BUTTON GROUND IN EXACTLY TWO PLACES IN THE WHOLE TERMINAL, and both
 * mean the same thing: the owner must act before the agent can move. This is one
 * of them (`.desk-blocked button` is the other). It is not a decoration for a
 * button that happens to be important — spending it on an ordinary action is how
 * the signal stops meaning anything.
 *
 * Private here per the one-file rule; `Components.kt` already carries an
 * identical `LimePill` as a private of its own. They want lifting into one.
 */
@Composable
private fun ResignPill(label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
  val shape = RoundedCornerShape(50)
  Box(
    modifier
      .alpha(if (enabled) 1f else DISABLED_CONFIRM)
      .clip(shape)
      .background(MerryColors.lime)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 9.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.ink,
    )
  }
}

/** `.proposal-add-all:disabled` and `.risk-option:disabled` — terminal.css:7398, 7594. */
private const val DISABLED_CONFIRM = 0.6f

/** `.proposal-add:disabled` — terminal.css:7421. A different value, deliberately. */
private const val DISABLED_ADD = 0.55f

// ---------------------------------------------------------------------------
// THE FIELD VOCABULARY
// ---------------------------------------------------------------------------

/**
 * A LABELLED FIELD, in the money-flow vocabulary rather than the forms one.
 *
 * `forms.css` is scoped to `.terminal-form-page`, which is Settings and Wallet
 * only; the Trade screen is not one of those, so its counterpart is the flow
 * input pair: `.limit-field label` (terminal.css:494) at 14px/600 over
 * `.limit-input` (terminal.css:507) — `border: 1px solid var(--line);
 * border-radius: 12px; background: var(--card); padding: 15px 18px; font-size:
 * 24px` for an amount — and `.create-input` (terminal.css:6714), the same box at
 * `padding: 14px; font-size: 15px` for text. Same border, same radius, same
 * ground; only the type size and the padding differ, which is why one composable
 * takes both.
 *
 * THE LABEL SITS ABOVE THE BOX AND STAYS THERE. There is no floating label
 * anywhere in this UI and no placeholder-as-label — hence `BasicTextField` with
 * a real label rather than `OutlinedTextField`, whose label animates into the
 * border and leaves the field unlabelled while it holds a value.
 *
 * FOCUS IS A BORDER COLOUR HERE, NOT AN OUTLINE. `.limit-input:focus-within`
 * (terminal.css:518) turns the border `--lime`; the global rule at
 * terminal.css:661 additionally paints a 2px lime OUTLINE 2px outside the box,
 * which CSS draws without taking layout space and Compose cannot do without
 * reserving 4dp around every field. The border colour carries it.
 *
 * The 9dp between label and box is `.mm-field`'s `gap: 9px` (forms.css:25) — the
 * one measurement borrowed from the forms sheet, because the flow rules give no
 * label-to-input gap of their own.
 */
@Composable
private fun Field(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  keyboardType: KeyboardType = KeyboardType.Text,
  textSize: TextUnit = 15.sp,
  boxPadding: PaddingValues = PaddingValues(14.dp),
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val shape = RoundedCornerShape(12.dp)

  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(9.dp)) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W600),
        fontSize = 14.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
    Box(
      Modifier
        .fillMaxWidth()
        .clip(shape)
        .background(MerryColors.card)
        .border(1.dp, if (focused) MerryColors.lime else MerryColors.line, shape)
        .padding(boxPadding),
    ) {
      BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        interactionSource = interaction,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        cursorBrush = SolidColor(MerryColors.lime),
        textStyle = TextStyle(
          // DM Sans throughout, not [dev.merrymen.app.ui.Numerals]. The web's
          // `--sans` resolves digits to Geist Numerals per GLYPH, which a text
          // field being typed into cannot do — a family that carries digits and
          // nothing else would leave a decimal point to the system fallback.
          // Figures the app PRINTS still come from Numerals; only what the owner
          // types does not.
          fontFamily = sans(textSize),
          fontSize = textSize,
          color = MerryColors.tx,
        ),
      )
    }
  }
}

/**
 * `.risk-note` (terminal.css:7595) and `.limit-field > p` (terminal.css:498) —
 * 12px at `--tx-2`, line-height 1.55 and 1.5 respectively.
 *
 * This is the register every load-bearing sentence on these three screens sits
 * in: what a cap will still do to an order, what a sell clamps to, what a
 * bonding-curve coin must be sold as, and what a signature alone can move. It is
 * quiet because none of it is an alarm — but it is `--tx-2` rather than
 * `--faint`, because it is meant to be read.
 */
@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.6.sp,
    ),
    color = MerryColors.tx2,
  )
}

// ── PROPOSALS ───────────────────────────────────────────────────────────────

/**
 * Coins the scout has vetted, and the one-tap approval.
 *
 * WHAT APPROVING ACTUALLY DOES is said on the card rather than discovered: it
 * adds the coin to what the agent watches AND to what it may trade, and it
 * still cannot buy until the owner re-signs — because the permission is sealed
 * into the key, not into settings. `covered` is shown for the same reason: a
 * re-sign re-authorises the WHOLE list, not just the coin just added, and the
 * owner is entitled to know that before they sign.
 *
 * THE PANEL IS `.proposals` (terminal.css:7276) — `padding: 14px; border: 1px
 * solid var(--line); border-radius: var(--r); background: var(--card)`, which is
 * [SectionCard]'s default recipe, over `.proposals-note` at 12.5px/1.55 in
 * `--tx-2`. Each coin is a `.proposal` (terminal.css:7320): the same ground, a
 * 12px radius, `padding: 11px 12px` and a 6px gap.
 *
 * THE TWO CONTROLS ARE DELIBERATELY DIFFERENT BUTTONS. Adding is an outline pill
 * the owner can press all day; re-signing is the lime one, and lime is a button
 * ground in exactly two places in this product, both of them "the owner must act
 * before the agent can move". The web separates them with `.proposals-next`'s
 * hairline (`margin-top: 14px; padding-top: 12px; border-top: 1px solid
 * var(--line)`) and so does this.
 */
@Composable
fun ProposalsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<ProposalsView>>(Loaded.Loading) }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  suspend fun load() { state = c.api.proposals().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Page("Coins to consider", nav) {
    note?.let { Notice("Watchlist", it) }
    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { v ->
      if (v.proposals.isEmpty()) {
        // FIVE REASONS FOR AN EMPTY LIST, and they are not the same sentence.
        Notice(
          title = when (v.why) {
            "signed-out" -> "Sign in to see these"
            "no-grant" -> "No agent yet"
            "all-covered" -> "Nothing new"
            "unreadable" -> "Couldn't read the scout"
            else -> "Nothing vetted yet"
          },
          body = when (v.why) {
            "signed-out" -> "These are scoped to your agent's signature."
            "no-grant" -> "Create an agent first — there is nothing to widen yet."
            "all-covered" -> "Everything the scout liked is already covered by your key."
            "unreadable" -> "That is our read failing, not an empty shortlist."
            else -> "Nothing has cleared the screen recently. That is not the same as nothing looking good."
          },
          actionLabel = if (v.why == "signed-out") "Sign in" else null,
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
      } else {
        SectionCard("Before you approve", gap = 12.dp) {
          Note(
            "Approving adds a coin to what your agent watches and may trade. It still cannot " +
              "buy until you re-sign — and re-signing re-authorises all ${v.covered} tokens your " +
              "key already covers, not just this one.",
          )
          // The batch control: full width and ABOVE everything it acts on, per
          // the sheet's own note that a pill beside one coin reads as that
          // coin's.
          OutlinePill(
            label = "Add all ${v.proposals.size}",
            enabled = !busy,
            borderColor = MerryColors.lime,
            disabledAlpha = DISABLED_CONFIRM,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
              busy = true
              scope.launch {
                val r = approveProposals(c.repo, v.proposals)
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line }
                busy = false
                load()
              }
            },
          )
          // `.proposals-next` — the re-sign lives below a hairline because it is
          // a different KIND of act from the one above it, not a louder version
          // of the same one.
          Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line).padding(top = 2.dp))
          ResignPill("Re-sign my permission") {
            nav.navigate(Routes.web("/grant#resign", "Re-sign"))
          }
        }
        v.proposals.forEach { p ->
          SectionCard(
            radius = 12.dp,
            padding = PaddingValues(horizontal = 12.dp, vertical = 11.dp),
            gap = 6.dp,
          ) {
            // `.proposal-top`: baseline-aligned, wrapping, gap 8. Its `b` is 14px
            // and takes the browser's bold, so W700 rather than the 600 a card
            // heading would get.
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.spacedBy(8.dp),
              verticalAlignment = Alignment.CenterVertically,
            ) {
              Text(
                text = p.symbol,
                style = TextStyle(
                  fontFamily = sans(14.sp, FontWeight.W700),
                  fontSize = 14.sp,
                  fontWeight = FontWeight.W700,
                ),
                color = MerryColors.tx,
              )
              // `.proposal-chip` (terminal.css:7347). The curve case is marked as
              // well as said: the sentence below can be skimmed past, a chip on
              // the name cannot.
              if (p.onCurve) CurveChip()
            }
            Row(
              Modifier.fillMaxWidth(),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
            ) {
              // `.proposal-figs` — 12px in `--faint`. A figure's LABEL is faint;
              // the figure itself keeps [Money]'s own colouring, which is what
              // renders an unknown price as "—" rather than as "$0.00".
              Text(
                text = "Price",
                style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
                color = MerryColors.faint,
              )
              Money(p.priceUsd, size = 13.sp)
            }
            p.reason?.let {
              // `.proposal-why` — 13px/1.55 at `--tx-2`.
              Text(
                text = it,
                style = TextStyle(
                  fontFamily = sans(13.sp),
                  fontSize = 13.sp,
                  lineHeight = 20.15.sp,
                ),
                color = MerryColors.tx2,
              )
            }
            if (p.onCurve) {
              Caveat(
                "Still on its launch curve — there is no pool, so an ordinary swap cannot reach it.",
              )
            }
            if (p.watched) {
              // `.proposal-done`'s register — 12.5px/1.5 at `--tx-2`. "Watched"
              // and "covered" are two different permissions and this line is the
              // only place the difference is stated.
              Text(
                text = "Already watched, but not covered by your key.",
                style = TextStyle(
                  fontFamily = sans(12.5.sp),
                  fontSize = 12.5.sp,
                  lineHeight = 18.75.sp,
                ),
                color = MerryColors.tx2,
              )
            }
            OutlinePill(
              label = "Add ${p.symbol}",
              enabled = !busy,
              borderColor = MerryColors.line,
              disabledAlpha = DISABLED_ADD,
              modifier = Modifier.padding(top = 2.dp),
              verticalPadding = 7.dp,
              onClick = {
                busy = true
                scope.launch {
                  val r = approveProposals(c.repo, listOf(p))
                  note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line }
                  busy = false
                  load()
                }
              },
            )
          }
        }
      }
    }
  }
}

/**
 * `.proposal-chip` — terminal.css:7347: `padding: 1px 7px; border: 1px solid
 * var(--line); border-radius: 999px; font-size: 11px; color: var(--faint)`.
 *
 * No fill. A coin still on its curve is not a warning and not a refusal — it is
 * a fact about where the coin lives — so it wears the quietest chip in the sheet
 * rather than the amber a stopped rule would get.
 */
@Composable
private fun CurveChip() {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 7.dp, vertical = 1.dp),
  ) {
    Text(
      text = "on its launch curve",
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp, lineHeight = 16.sp),
      color = MerryColors.faint,
    )
  }
}

/**
 * `.proposal-caveat` — terminal.css:7374: `font-size: 12px; line-height: 1.5;
 * color: var(--faint); border-left: 2px solid var(--line); padding-left: 9px`.
 *
 * The sheet's own comment: "The curve caveat reads as a caveat. Covering the
 * token does not give a swap anywhere to route, and 'add it to a grant' is
 * advice that does not work." The rail is what stops it reading as one more line
 * of description — it is a note about what approving will NOT achieve.
 */
@Composable
private fun Caveat(text: String) {
  Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
    Box(Modifier.width(2.dp).fillMaxHeight().background(MerryColors.line))
    Text(
      text = text,
      modifier = Modifier.padding(start = 9.dp),
      style = TextStyle(
        fontFamily = sans(12.sp),
        fontSize = 12.sp,
        lineHeight = 18.sp,
      ),
      color = MerryColors.faint,
    )
  }
}

// ── TRADE ───────────────────────────────────────────────────────────────────

private val SUGGESTED_SYMBOL = Regex("^[A-Z0-9]{1,12}$")

/**
 * Place a buy or a sell, or go after a coin by name — ALWAYS THROUGH A CARD.
 *
 * This screen used to POST /api/orders on the tap of Buy, which is the
 * one-click order the product refuses everywhere else, and "Find it and buy"
 * bought whatever coin the lookup matched without the owner ever seeing it.
 * Now each tap opens a card (TradeDesk): the registry's sentence naming side,
 * coin and amount, whether it is real money or paper, and the limits the phone
 * has read — an amount past the per-trade cap or the chat ceiling is refused
 * on the card with the limit named. Only "Yes, place it" places anything, and
 * a snipe's lookup only ever leads to a second card naming the coin it found
 * and its address.
 *
 * "Queued" is not "filled" and this screen never says otherwise. The order is
 * said and followed in the chat thread, in the app's scope, so it is followed
 * to its answer whichever screen the owner is on; this screen shows that
 * answer too while it is open.
 *
 * BUY AND SELL ARE TWO EQUAL `.btn`s AND NEITHER IS COLOURED: a control is not
 * an outcome, and `--up` / `--down` mean money moved.
 */
@Composable
fun TradeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val desk = remember(c) { TradeDesk(c.api) { c.chat.cardScope() } }
  var symbol by remember { mutableStateOf("") }
  var amount by remember { mutableStateOf("") }
  var query by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  var card by remember { mutableStateOf<TradeCard?>(null) }
  var watching by remember { mutableStateOf<String?>(null) }
  var suggestions by remember { mutableStateOf<List<String>>(emptyList()) }
  val thread by c.chat.thread.collectAsState()
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val scope = rememberCoroutineScope()

  // THE SYMBOLS WORTH OFFERING: the basket as it stands (the owner's, else the
  // default) and what is held. Still free text — a chip only fills the field.
  LaunchedEffect(Unit) {
    val env = c.api.settings().valueOrNull()
    val feed = c.api.feed().valueOrNull()?.takeIf { it.source != "none" }
    suggestions = (env?.list("basketSymbols").orEmpty() + feed?.positions?.map { it.symbol }.orEmpty())
      .map { it.trim().uppercase() }
      .filter { SUGGESTED_SYMBOL.matches(it) }
      .distinct()
  }

  // What became of the order this screen placed, as the thread heard it — for
  // this owner's thread only.
  val key = chatKeyFor(hosted, signedIn)
  val outcome = watching?.let { id ->
    if (thread.key != key) null else thread.messages.lastOrNull { it.order?.id == id && it.order.outcome }
  }

  fun open(kind: String, subject: String) {
    busy = true
    note = null
    card = null
    scope.launch {
      when (val o = desk.open(kind, subject, amount.trim().toDoubleOrNull())) {
        is TradeOpen.Card -> card = o.card
        is TradeOpen.No -> note = o.line
      }
      busy = false
    }
  }

  Page("Trade", nav) {
    note?.let { Notice("Your order", it) }
    outcome?.let { line ->
      val receipt = line.order?.receipt?.let(::receiptText)
      Notice("Outcome", listOfNotNull(receipt, line.text).joinToString("\n"))
    }

    card?.let { pending ->
      TradeConfirm(
        card = pending,
        busy = busy,
        onDismiss = { card = null },
        onConfirm = {
          busy = true
          // IN THE APP'S SCOPE, NOT THE SCREEN'S. A placement cancelled because
          // the owner tapped back would be a POST whose answer nobody reads — an
          // order that may exist, never followed and never said.
          c.appScope.launch {
            when (val step = desk.confirm(pending)) {
              is TradeStep.Next -> card = step.card
              is TradeStep.Said -> {
                card = null
                note = step.line
              }
              is TradeStep.Done -> {
                card = null
                note = step.placed.line
                watching = when (val p = step.placed) {
                  is Placed.Queued -> p.id
                  is Placed.Unknown -> p.following
                  is Placed.Refused -> null
                }
              }
            }
            busy = false
          }
        },
      )
    }

    SectionCard("Buy or sell a symbol", gap = 14.dp) {
      Field(
        label = "Symbol",
        value = symbol,
        onValueChange = { symbol = it.uppercase() },
      )
      if (suggestions.isNotEmpty()) {
        Row(
          Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          suggestions.forEach { s ->
            OutlinePill(
              label = s,
              enabled = true,
              borderColor = if (s == symbol) MerryColors.lime else MerryColors.line,
              disabledAlpha = DISABLED_ADD,
              verticalPadding = 7.dp,
              onClick = { symbol = s },
            )
          }
        }
      }
      Field(
        label = "Amount (USDG)",
        value = amount,
        onValueChange = { amount = it },
        keyboardType = KeyboardType.Decimal,
        // `.limit-input` — the money box: bigger type and more room than a name
        // gets, because it is the field an owner checks twice.
        textSize = 24.sp,
        boxPadding = PaddingValues(horizontal = 18.dp, vertical = 15.dp),
      )
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("buy", "sell").forEach { side ->
          Btn(
            label = side.replaceFirstChar { it.uppercase() },
            enabled = !busy && card == null && symbol.isNotBlank() && (amount.trim().toDoubleOrNull() ?: 0.0) > 0,
            modifier = Modifier.weight(1f),
            onClick = { open(side, symbol) },
          )
        }
      }
      Note(
        "Nothing is placed until you confirm. Your key's per-trade and per-day caps still decide whether it goes " +
          "through. A sell clamps down to the position; a bonding-curve coin must be sold whole.",
      )
    }

    SectionCard("Go after a coin by name", gap = 14.dp) {
      Field(
        label = "Name or ticker",
        value = query,
        onValueChange = { query = it },
      )
      FlowPrimary(
        label = "Find it",
        enabled = !busy && card == null && query.isNotBlank() && (amount.trim().toDoubleOrNull() ?: 0.0) > 0,
        onClick = { open("snipe", query) },
      )
      Note(
        "It looks the coin up first and shows you which one it found — its address too — before anything is " +
          "bought. If more than one coin answers to that name it asks rather than guesses.",
      )
    }
  }
}

/**
 * THE TRADE SCREEN'S CARD — the same contract as the chat's: the sentence from
 * the registry, real money or paper, the limit, and two equal buttons.
 */
@Composable
private fun TradeConfirm(card: TradeCard, busy: Boolean, onDismiss: () -> Unit, onConfirm: () -> Unit) {
  SectionCard(gap = 8.dp) {
    card.found?.let { Note("Found: ${it.symbol} at ${it.short ?: it.address}") }
    Text(
      text = card.sentence,
      style = TextStyle(fontFamily = sans(13.5.sp), fontSize = 13.5.sp, lineHeight = 21.6.sp),
      color = MerryColors.tx,
    )
    Note(card.money)
    when (val limit = card.limit) {
      is LimitCheck.Over -> Text(
        text = limit.line,
        style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.sp),
        color = MerryColors.down,
      )
      is LimitCheck.Unread -> Note(limit.note)
      LimitCheck.Within -> Unit
    }
    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ResignPill(
        label = when {
          busy -> "Doing it…"
          card.kind == "snipe" -> "Yes, look it up"
          else -> "Yes, place it"
        },
        enabled = card.canConfirm && !busy,
        onClick = onConfirm,
      )
      OutlinePill(
        label = "Not now",
        enabled = !busy,
        borderColor = MerryColors.line,
        disabledAlpha = DISABLED_ADD,
        onClick = onDismiss,
      )
    }
  }
}

// ── RISK ────────────────────────────────────────────────────────────────────

/**
 * One tap for sizing and both exit rules — opening on the rung the owner is on.
 *
 * AND WHAT IT CANNOT REACH, said on the screen: the per-trade and per-day caps
 * live in the signature and are enforced on-chain. No settings write moves
 * them — only a new signature does.
 *
 * THE CURRENT RUNG IS READ, NOT REMEMBERED. The screen opened blank, so an
 * owner on Careful saw three unselected options and could not tell which one
 * they were on. It reads /api/settings and matches all six saved dials against
 * the table (riskLevelOf); a hand-tuned book matches nothing and says so,
 * rather than highlighting the nearest rung.
 *
 * A TAP WRITES FOR THE WALLET THE SCREEN WAS READ FOR: the envelope's `owner`
 * goes with the PUT, so a wallet that signed in since gets a 409 and nothing
 * written.
 *
 * THE CONTROL IS `.risk-option`, the web's own element for this question
 * (`HostedControls.tsx`), styled by terminal.css:7576-7594: the whole row is the
 * tap target and selection is a lime border. Three rungs rather than a slider:
 * "a slider implies a continuum between the rungs that does not exist".
 */
@Composable
fun RiskScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var read by remember { mutableStateOf<Loaded<SettingsEnvelope>>(Loaded.Loading) }
  var current by remember { mutableStateOf<String?>(null) }
  var saved by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    read = c.api.settings().toLoaded()
    current = riskLevelOf((read as? Loaded.Value)?.value?.values)
  }

  Page("How much risk?", nav) {
    note?.let { Notice("Risk", it) }
    when (val r = read) {
      is Loaded.Refused -> Notice("Risk", "I couldn't read your current dials — ${r.message}")
      is Loaded.Unreachable -> Notice(
        "Risk",
        "I couldn't read your current dials, so none is marked. " + ApiResult.Unreachable(r.cause, r.unreadable).said,
      )
      else -> Unit
    }

    // `.risk-options` — a column at gap 8, not a stack of cards at the page gap.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      RISK_PROFILES.forEach { p ->
        RiskOption(
          name = p.name,
          blurb = p.blurb,
          // The numbers this level actually writes. DM Sans rather than
          // [dev.merrymen.app.ui.Numerals]: it is a sentence containing figures,
          // not a column of them.
          figures = "Sells at ${p.stopLossBps / 100}% down or ${p.takeProfitBps / 100}% up · " +
            "$${p.buyPerTickUsdg} a trade · slippage ${p.slippageBps / 100.0}%",
          selected = current == p.level,
          enabled = !busy,
          onClick = {
            busy = true
            note = null
            scope.launch {
              val owner = (read as? Loaded.Value)?.value?.owner
              when (val r = applyRisk(c.repo, p.level, owner)) {
                is Acted.Ok -> {
                  current = p.level
                  saved = p.level
                  note = r.line
                }
                is Acted.Failed -> note = r.line
              }
              busy = false
            }
          },
        )
      }
    }
    if (read is Loaded.Value && current == null && saved == null) {
      Note("Your dials are set by hand right now — picking a level replaces them.")
    }

    SectionCard("What this does not touch", gap = 12.dp) {
      Note(
        "This sets how I size and when I sell. Your per-trade and per-day caps are sealed into your key and " +
          "enforced on-chain — nothing on this screen can move them, only a new signature can.",
      )
      // `LimitsPanel` makes "Edit signed limits" its `.flow-primary` — the
      // signature-requiring action is the PRIMARY here and is not dressed as a
      // danger. The sentence above it is what marks it as consequential.
      FlowPrimary(
        label = "Edit signed limits",
        enabled = true,
        onClick = { nav.navigate(Routes.web("/grant#resign", "Signed limits")) },
      )
    }
  }
}

/** One rung. See [RiskScreen] for the provenance of every number in here. */
@Composable
private fun RiskOption(
  name: String,
  blurb: String,
  figures: String,
  selected: Boolean,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(14.dp)
  Column(
    Modifier
      .fillMaxWidth()
      .alpha(if (enabled) 1f else DISABLED_CONFIRM)
      .clip(shape)
      .border(1.dp, if (selected) MerryColors.lime else MerryColors.line, shape)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 14.dp, vertical = 11.dp),
    verticalArrangement = Arrangement.spacedBy(3.dp),
  ) {
    Text(
      text = name,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W600),
        fontSize = 14.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
    Text(
      text = blurb,
      style = TextStyle(
        fontFamily = sans(12.5.sp),
        fontSize = 12.5.sp,
        lineHeight = 18.75.sp,
      ),
      color = MerryColors.tx2,
    )
    Text(
      text = figures,
      style = TextStyle(
        fontFamily = sans(12.sp),
        fontSize = 12.sp,
        lineHeight = 18.sp,
      ),
      color = MerryColors.faint,
    )
  }
}
