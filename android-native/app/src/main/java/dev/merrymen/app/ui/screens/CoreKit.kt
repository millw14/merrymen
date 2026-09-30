package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Pixel
import dev.merrymen.app.ui.sans
import java.util.Locale

/**
 * THE FIVE TAB SCREENS, RESTYLED AGAINST THE WEB TERMINAL BELOW 1100px.
 *
 * They were one file, Core.kt, and are now one file each — HomeScreen.kt,
 * ChatScreen.kt, FeedScreen.kt, AlphaScreen.kt and ProfileScreen.kt — so that
 * work on one screen stops being a merge conflict with work on the other four.
 * This note and the furniture they share stay here.
 *
 * ONE READING RULE RUNS THROUGH EVERY NUMBER IN THOSE FILES. `terminal.css` writes
 * `:where(.terminal-host) .x`, which is specificity (0,1,0). `polish.css` writes
 * `.terminal-host .x`, which is (0,2,0), and it is imported later
 * (`app/layout.tsx:6-9`). So every declaration inside `polish.css`'s
 * `@media (max-width: 1099px)` block (lines 86-188) beats the base sheet, and a
 * value read out of terminal.css alone is the DESKTOP value. Where a rule below
 * cites polish.css, that number is final.
 *
 * WHAT THIS PASS DID NOT TOUCH. No screen here fetches, sends or decides
 * anything it did not before. The filter predicates, the like sort, the chat
 * send, the command registry lookup and every three-state read are the code that
 * was already here; only the drawing changed. Two exceptions are stated at their
 * call sites and in the hand-off notes: the fourth feed tab ("Debates") needed
 * the web's own mention predicate ported, because a tab the spec names cannot
 * ship inert; and the Alpha open state now reads named fields out of the pick
 * rows instead of printing `JsonElement.toString()`.
 */

// ---------------------------------------------------------------------------
// SHARED FURNITURE
//
// Only what two or more of the five tab screens use lives here, and it is
// `internal` because the screens are now one file each. A piece only one
// screen uses moved into that screen's file and stayed `private`.
//
// THIS FILE IS FROZEN once the split lands, because four branches build on it
// in parallel and an edit here is a merge conflict in all of them. A screen
// that wants a variant copies the helper into its own file under a NEW name:
// Kotlin reports a `private` top-level declaration that shares a name with an
// `internal` one in the same package as a conflicting overload, so a copy
// with the same name does not compile.
// ---------------------------------------------------------------------------

/** The SVG grid every lucide glyph in this file is authored on. */
internal const val ICON_VIEW = 24f

/**
 * ONE STROKED LUCIDE PATH SET, drawn rather than borrowed.
 *
 * The web draws these with `lucide-react` at `strokeWidth` 1.35-2 on a 24-unit
 * viewBox. Material's icon set has near-equivalents and they are visibly
 * different drawings — Icons.kt already records that the tab bar shipped a
 * filled house and four sparkles for a while because of exactly that swap.
 *
 * The stroke width is applied INSIDE the scaled draw scope so it scales with the
 * glyph, which is what an SVG does and what a rebuilt path would not.
 */
@Composable
internal fun StrokeGlyph(
  vararg data: String,
  tint: Color,
  size: Dp,
  stroke: Float = 2f,
  modifier: Modifier = Modifier,
) {
  val paths = remember(data) { data.map { PathParser().parsePathString(it).toPath() } }
  Canvas(modifier.size(size)) {
    val s = this.size.minDimension / ICON_VIEW
    scale(s, s, pivot = Offset.Zero) {
      paths.forEach {
        drawPath(
          path = it,
          color = tint,
          style = Stroke(width = stroke, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
      }
    }
  }
}

/**
 * `money()` — `live.ts:307-310`, ported for the two places this file needs the
 * STRING rather than the [Money] composable: the pixel balance, which has to
 * split the figure at the decimal point, and the wire's size, which is guarded
 * before the formatter is ever reached.
 *
 * Null is the caller's problem here, deliberately: the two call sites answer it
 * differently and neither of them may be given a default.
 */
internal fun moneyText(v: Double): String = "$" + String.format(Locale.US, "%,.2f", v)

/**
 * THE MOBILE FEED TAB'S SELECTED GREEN — `polish.css:115`, a literal `#38dda0`.
 *
 * It is NOT `--up` #3dd68c, though they are near-identical. `--up` means money
 * moved; putting it on a navigation control would spend the one colour in this
 * product that is a claim about a number on "which filter you happen to be on".
 * Kept as its own constant so a later palette edit cannot merge the two.
 */
internal val TabGreen = Color(0xFF38DDA0)

/** `.tag`'s ground — `terminal.css:1705`. Warmer than `--card`, and not a token. */
internal val TabTagGround = Color(0xFF1C1D16)

/**
 * A 20px section heading — `.week-label` / `.board-head h2` / `.alpha-inside h2`
 * at `polish.css:71`, `:79`, `:96`: 20px, weight 600, `letter-spacing: -.02em`.
 */
@Composable
internal fun TabSectionHeading(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = sans(20.sp, FontWeight.W600),
      fontSize = 20.sp,
      fontWeight = FontWeight.W600,
      letterSpacing = (-0.02).em,
    ),
    color = MerryColors.tx,
  )
}

/** Body prose at an explicit size and line-height, in one of the three greys. */
@Composable
internal fun Prose(
  text: String,
  size: TextUnit,
  lineHeight: TextUnit,
  color: Color,
  weight: FontWeight = FontWeight.W400,
  modifier: Modifier = Modifier,
  align: TextAlign? = null,
) {
  if (text.isBlank()) return
  Text(
    text = text,
    modifier = modifier,
    textAlign = align,
    style = TextStyle(
      fontFamily = sans(size, weight),
      fontSize = size,
      fontWeight = weight,
      lineHeight = lineHeight,
    ),
    color = color,
  )
}

/**
 * THE PORTFOLIO FIGURE — 56px of Geist Pixel, the one display face in this
 * product, spent on exactly four figures across the whole terminal.
 *
 * `polish.css:94` gives 56px and `line-height: 1.1`; `terminal.css:792` gives the
 * family, weight 400, `letter-spacing: -.02em` and `white-space: nowrap`.
 * `terminal.css:801` puts the cents in a `sup` at an ABSOLUTE 22px in `--tx-2`.
 *
 * A NULL EQUITY RENDERS "—" AND NOTHING ELSE. `money(null)` is the em dash, and
 * Home then splits that string, which yields no fractional part, so no
 * superscript is emitted either (`Home.tsx:99-117`). This is the highest-stakes
 * rule on the screen: a client that formats a `Double?` with a `?: 0.0` turns an
 * unread balance into "$0.00", which is how somebody gets told they hold nothing
 * on the strength of a rate limit. A READ zero still says "$0.00" — that falls
 * out of the same path and must not be special-cased back.
 *
 * CSS `vertical-align: super` raises by about 0.33em of the PARENT (56px is
 * ~18.5px); Compose's `BaselineShift.Superscript` is 0.5em of the SPAN (22px is
 * 11px). 18.5/22 is about 0.84, so the shift is stated rather than taken from
 * the constant.
 */
@Composable
internal fun PixelBalance(
  value: Double?,
  size: TextUnit = 56.sp,
  cents: TextUnit = 22.sp,
  lineHeight: TextUnit = 61.6.sp,
) {
  val body = TextStyle(
    fontFamily = Pixel,
    fontSize = size,
    fontWeight = FontWeight.W400,
    lineHeight = lineHeight,
    letterSpacing = (-0.02).em,
  )
  if (value == null) {
    Text("—", style = body, color = MerryColors.tx, maxLines = 1, softWrap = false)
    return
  }
  val text = moneyText(value)
  val dot = text.lastIndexOf('.')
  Text(
    text = buildAnnotatedString {
      if (dot < 0) {
        append(text)
      } else {
        append(text.substring(0, dot))
        withStyle(
          SpanStyle(
            fontSize = cents,
            color = MerryColors.tx2,
            baselineShift = BaselineShift(0.84f),
            letterSpacing = (-0.02).em,
          ),
        ) { append(text.substring(dot)) }
      }
    },
    style = body,
    color = MerryColors.tx,
    maxLines = 1,
    softWrap = false,
  )
}
