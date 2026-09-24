package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.ui.Coin
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.sans

// ---------------------------------------------------------------------------
// TYPE, from the two sheets that actually decide it on a phone
// ---------------------------------------------------------------------------

/** `.terminal-form-page` body copy: `font: inherit` at the host's 15px/1.35. */
internal val BodyText = TextStyle(
  fontFamily = sans(15.sp),
  fontSize = 15.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.25.sp,
)

/** `.meta` — terminal.css:705: `margin: 2px 0 0; color: var(--tx-2); font-size: 12px`. */
internal val MetaText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 16.2.sp,
)

/** `.mm-section` — forms.css:23: `font-size: 18px; font-weight: 600; letter-spacing: -.02em`. */
private val SectionHeadingText = TextStyle(
  fontFamily = sans(18.sp, FontWeight.W600),
  fontSize = 18.sp,
  fontWeight = FontWeight.W600,
  letterSpacing = (-0.02).em,
)

/** `.mm-hint` — forms.css:21, 37: `font-size: 12px; line-height: 1.65`, `--tx-2`. */
private val HintText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 19.8.sp,
)

/** `.mm-note` — forms.css:20-22: `font-size: 14px; line-height: 1.65`, `--tx-2`. */
private val NoteText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 23.1.sp,
)

/** `.rk` — forms.css:84: `color: var(--tx-2); font-size: 12px; margin-bottom: 6px`. */
internal val KeyText = TextStyle(
  fontFamily = sans(12.sp),
  fontSize = 12.sp,
  fontWeight = FontWeight.W400,
)

// ---------------------------------------------------------------------------
// SMALL SHARED PIECES
//
// Only what two or more of the routed panels use lives here, `internal`
// because each panel is now its own file. A piece only one panel uses moved
// into that panel's file and stayed `private`.
//
// THIS FILE IS FROZEN once the split lands, for the same reason as
// CoreKit.kt: parallel branches build on it. Copy a helper into your own file
// under a NEW name rather than editing it here; a `private` copy with the
// same name as an `internal` one does not compile.
// ---------------------------------------------------------------------------

/**
 * A HEX STRING THAT WILL ACTUALLY WRAP.
 *
 * `forms.css:60, 82, 85` set `overflow-wrap: anywhere` on addresses, keys and
 * boxed notices so a 42-character run breaks inside the 430px column. Compose
 * will not break inside a word at all, so the break opportunities are put in by
 * hand as zero-width spaces.
 *
 * NEVER `TextOverflow.Ellipsis` HERE. A truncated contract address is a wrong
 * contract address, and this app has an entire screen about telling one token
 * from another.
 */
internal fun breakable(text: String): String = text.chunked(4).joinToString("\u200B")

/**
 * THE BACK CONTROL, and it is a literal arrow character.
 *
 * `screens/Search.tsx:41` and `screens/Token.tsx:146` both render
 * `<button class="back" aria-label="Back">←</button>` — the visible content is
 * U+2190, not an icon. `terminal.css:1124`:
 * `color: var(--tx-2); font-size: 15px; font-weight: 600; line-height: 1`.
 *
 * The 44dp box is Android's, not the web's: `polish.css:17` and the rules
 * around it hold every tappable thing in this shell at 44px, and a 15px glyph
 * on its own is a 15px target. The glyph is drawn at the web's size inside it.
 * `contentDescription` carries the `aria-label` — TalkBack reads a bare "←" as
 * "left arrow", which is a shape, not a destination.
 */
@Composable
internal fun BackControl(onBack: () -> Unit, modifier: Modifier = Modifier) {
  Box(
    modifier
      .size(44.dp)
      .clickable(onClick = onBack)
      .semantics { contentDescription = "Back" },
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
}

/**
 * THE PAGE HEADER FOR EVERY PUSHED SCREEN — back above, title below.
 *
 * There is no app bar anywhere in the mobile shell: `App.tsx:310` gates
 * `<DesktopHeader>` behind `desktop &&`, and every screen writes its own header
 * as the first child of the scrolling content, so the title scrolls away with
 * the page. This composable is that header.
 *
 * BACK COMES FIRST AND IT IS ITS OWN ROW. `Search.tsx:41` and `Token.tsx:146`
 * both put `.back` as the LEADING control, and `terminal.css:2326`
 * (`.sheet .back { margin-bottom: 28px }`) gives it a 28px gap before what
 * follows. The version this replaced put a "Back" word on the RIGHT of the
 * title as a trailing action, which is neither the position nor the affordance
 * the web uses.
 *
 * The 28px is spent partly by the 44dp touch target: the 15px glyph sits
 * centred in it, so roughly 14.5dp of the gap is already inside the control and
 * the explicit margin makes up the rest.
 *
 * THE TITLE IS 34sp. `polish.css:109-110` inside `@media (max-width: 1099px)`:
 * `font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -.04em`.
 * The base sheet's 22px is the desktop size. See [PageTitle].
 *
 * Kept `internal` and kept at this exact signature because `screens/Token.kt`
 * calls it. It carries the page gutter itself so a caller can drop it at the
 * top of an unpadded scroller.
 */
@Composable
internal fun Header(title: String, nav: NavHostController) {
  Column(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop),
  ) {
    BackControl({ nav.popBackStack() }, Modifier.padding(bottom = 14.dp))
    PageTitle(title)
  }
}

/**
 * `.mm-section` — forms.css:23:
 * `font-size: 18px; font-weight: 600; letter-spacing: -.02em; padding: 28px 0 16px; border-top: 1px solid var(--line); margin-top: 28px`
 *
 * The RULE IS THE SEPARATOR and it sits above the padding, so the order here is
 * 28dp of margin, the hairline, 28dp of padding, the words, 16dp. Drawing the
 * line under the heading instead — which is the instinct — puts the divider on
 * the wrong side of the thing it divides.
 */
@Composable
internal fun PanelSectionHeading(text: String) {
  Column(Modifier.fillMaxWidth()) {
    Spacer(Modifier.height(28.dp))
    Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
    Text(
      text = text,
      modifier = Modifier.padding(top = 28.dp, bottom = 16.dp),
      style = SectionHeadingText,
      color = MerryColors.tx,
    )
  }
}

/** `.mm-note` — a status line. Grey, because a failed READ is not a red thing here. */
@Composable
internal fun NoteLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(text, modifier, style = NoteText, color = MerryColors.tx2)
}

/** `.mm-hint` — the sentence under a control. */
@Composable
internal fun HintLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(text, modifier, style = HintText, color = MerryColors.tx2)
}

/**
 * `.tok` — terminal.css:979-1010. The list row this terminal uses for a token
 * or an agent, and it is NOT A CARD:
 *
 * `display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: 12px; align-items: center; width: 100%; min-height: 64px; padding: 10px 0`
 *
 * with `.tok strong` clipped to one line, `.meta` at 12px `--tx-2` 2px under
 * it, and `.px` right-aligned at weight 600 with tabular figures.
 *
 * NO BORDER, NO GROUND, NO RADIUS. Wrapping each row in a `SectionCard` — which
 * is what these screens did — draws a box the web does not draw and turns a
 * scannable list into a stack of panels. `Components.kt`'s own note says the
 * same thing: reach for a card only where the screen's spec has one.
 */
@Composable
internal fun TokRow(
  seed: String,
  title: String,
  sub: String?,
  modifier: Modifier = Modifier,
  under: (@Composable ColumnScope.() -> Unit)? = null,
  right: (@Composable ColumnScope.() -> Unit)? = null,
) {
  Row(
    modifier
      .fillMaxWidth()
      .heightIn(min = 64.dp)
      .padding(vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // A TOKEN, NOT AN AGENT. See Coin() — the web draws a flat #ecece4 disc
    // here, not the hue-gradient face it generates for a desk.
    Coin(seed, size = 40.dp)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        text = title,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = BodyText,
        color = MerryColors.tx,
      )
      if (!sub.isNullOrBlank()) {
        Text(
          text = sub,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
          style = MetaText,
          color = MerryColors.tx2,
        )
      }
      under?.invoke(this)
    }
    if (right != null) {
      Column(
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(3.dp),
        content = right,
      )
    }
  }
}
