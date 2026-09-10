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
import dev.merrymen.app.ui.placeOrder
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.snipe
import kotlinx.coroutines.delay
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
private fun ResignPill(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(50)
  Box(
    modifier
      .clip(shape)
      .background(MerryColors.lime)
      .clickable(onClick = onClick)
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
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
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
                  note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
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

/**
 * Place a buy or a sell, or go after a coin by name.
 *
 * "Queued" is not "filled" and this screen never says otherwise: the worker
 * claims the order on its next tick and the wall decides. So it polls and
 * reports what actually became of it.
 *
 * BUY AND SELL ARE TWO EQUAL `.btn`s AND NEITHER IS COLOURED. They are the same
 * size and the same reach for the reason `.desk-confirm-row` gives about its own
 * pair (terminal.css:7558): the safer choice must never be the harder thing to
 * hit. And `--up` / `--down` stay off them — a control is not an outcome, and
 * this product's whole rule is that those two colours mean money moved.
 *
 * The snipe card gets a `.flow-primary` instead because the card IS that one
 * action; the buy/sell card has two, so neither of them is the card's primary.
 */
@Composable
fun TradeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var symbol by remember { mutableStateOf("") }
  var amount by remember { mutableStateOf("") }
  var query by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  var followed by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  /**
   * Poll until the worker has answered, then say what it said.
   *
   * TIME-BOUNDED TO OUTLIVE THE HOSTED TICK, not a fixed 20 tries. The hosted
   * worker claims one command per ~240s tick, so an order can sit unclaimed for
   * up to four minutes before anything happens to it; a 60s budget timed out
   * before the order was even looked at. The web polls for seven minutes, which
   * covers two ticks, and so does this.
   */
  suspend fun follow(id: String?) {
    if (id == null) return
    val deadline = 7 * 60 * 1000L
    var elapsed = 0L
    while (elapsed < deadline) {
      delay(5_000); elapsed += 5_000
      val st = c.api.orderStatus(id)
      if (st is dev.merrymen.app.net.ApiResult.Ok) {
        val s = st.value
        // "done" IS TERMINAL ONLY WITH A RESULT. The worker returns done with a
        // null result when it has nothing to say; printing "Done." there reads
        // as a settled trade the worker never reported. Keep waiting instead.
        val result = s.result
        if (s.state == "done" && !result.isNullOrBlank()) { followed = result; return }
        // "none" is also what the route answers when the ledger read fails, not
        // only "nothing queued", so it is not a fact to interpolate at the
        // reader — a neutral "checking" is the honest word.
        followed = if (s.state == "none" || s.state == "done") "Checking with your agent…"
        else "Still with your agent (${s.state})…"
      }
    }
    // A TIMEOUT IS NOT A FAILURE AND NOT A FILL. Say only what is true.
    followed = "Still waiting on your agent. It will show on your feed when it lands."
  }

  Page("Trade", nav) {
    note?.let { Notice("Your order", it) }
    followed?.let { Notice("Outcome", it) }

    SectionCard("Buy or sell a symbol", gap = 14.dp) {
      Field(
        label = "Symbol",
        value = symbol,
        onValueChange = { symbol = it.uppercase() },
      )
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
            enabled = !busy && symbol.isNotBlank() && (amount.toDoubleOrNull() ?: 0.0) > 0,
            modifier = Modifier.weight(1f),
            onClick = {
              busy = true; followed = null
              scope.launch {
                val (r, id) = placeOrder(c.repo, side, symbol, amount.toDouble())
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
                busy = false
                follow(id)
              }
            },
          )
        }
      }
      Note(
        "Your key's per-trade and per-day caps still decide whether it goes through. " +
          "A sell clamps down to the position; a bonding-curve coin must be sold whole.",
      )
    }

    SectionCard("Go after a coin by name", gap = 14.dp) {
      Field(
        label = "Name or ticker",
        value = query,
        onValueChange = { query = it },
      )
      FlowPrimary(
        label = "Find it and buy",
        enabled = !busy && query.isNotBlank() && (amount.toDoubleOrNull() ?: 0.0) > 0,
        onClick = {
          busy = true; followed = null
          scope.launch {
            val (r, id) = snipe(c.repo, query, amount.toDouble())
            note = when (r) {
              is Acted.Ok -> r.line
              is Acted.Failed -> r.line
              // TWO COINS WITH ONE NAME IS A QUESTION, NOT A PICK.
              is Acted.Ambiguous -> r.line + " — " + r.candidates.joinToString(", ")
              is Acted.NeedsSignature -> r.line
            }
            busy = false
            follow(id)
          }
        },
      )
      Note(
        "If more than one coin answers to that name it asks rather than guesses, and if your " +
          "key doesn't cover it yet it says so instead of failing.",
      )
    }
  }
}

// ── RISK ────────────────────────────────────────────────────────────────────

/**
 * One tap for sizing and both exit rules.
 *
 * AND WHAT IT CANNOT REACH, said on the screen: the per-trade and per-day caps
 * live in the signature and are enforced on-chain. No settings write moves
 * them — only a new signature does — and a risk control that quietly implied
 * otherwise would be the most expensive kind of wrong.
 *
 * THE CONTROL IS `.risk-option`, WHICH IS THE WEB'S OWN ELEMENT FOR THIS EXACT
 * QUESTION — `HostedControls.tsx:142-171` renders the same three profiles from
 * the same `RISK_PROFILES` table, and terminal.css:7576-7594 styles them:
 * `.risk-options { display: flex; flex-direction: column; gap: 8px }` over
 * `.risk-option { padding: 11px 14px; border: 1px solid var(--line);
 * border-radius: 14px; background: transparent; text-align: left; gap: 3px }`,
 * with `b` at 14px/600, `span` at 12.5px/1.5 in `--tx-2`, `.on` changing only
 * `border-color` to `--lime`, and `:disabled` at opacity .6.
 *
 * SO THE WHOLE ROW IS THE TAP TARGET AND SELECTION IS A BORDER. There is no
 * "Choose" / "Selected" button beside each card any more — the web has never had
 * one, and a control whose label says "Selected" is a second place the selected
 * state can disagree with the first. Note the ground is TRANSPARENT: these sit
 * on the page, not on a card, which is what keeps three of them from reading as
 * three separate sections.
 *
 * The sheet's reason for three rungs rather than a slider is worth keeping in
 * view: "a slider implies a continuum between the rungs that does not exist, and
 * invites somebody to land between two coherent sets of numbers."
 */
@Composable
fun RiskScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var current by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Page("How much risk?", nav) {
    note?.let { Notice("Risk", it) }

    // `.risk-options` — a column at gap 8, not a stack of cards at the page gap.
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      RISK_PROFILES.forEach { p ->
        RiskOption(
          name = p.name,
          blurb = p.blurb,
          // The numbers this level actually writes. DM Sans rather than
          // [dev.merrymen.app.ui.Numerals]: it is a sentence containing figures,
          // not a column of them, so nothing here has to line up with anything
          // above it.
          figures = "Sells at ${p.stopLossBps / 100}% down or ${p.takeProfitBps / 100}% up · " +
            "$${p.buyPerTickUsdg} a trade · slippage ${p.slippageBps / 100.0}%",
          selected = current == p.level,
          enabled = !busy,
          onClick = {
            busy = true
            scope.launch {
              val r = applyRisk(c.repo, p.level)
              note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
              if (r is Acted.Ok) current = p.level
              busy = false
            }
          },
        )
      }
    }

    SectionCard("What this does not touch", gap = 12.dp) {
      Note(
        "Your per-trade and per-day caps are sealed into your key and enforced on-chain. " +
          "Nothing on this screen can move them — only a new signature can.",
      )
      // `LimitsPanel` (HostedControls.tsx:176) makes "Edit signed limits" its
      // `.flow-primary` — the signature-requiring action is the PRIMARY here and
      // is not dressed as a danger. What marks it as consequential is the
      // sentence above it, which is why that sentence is not optional.
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
