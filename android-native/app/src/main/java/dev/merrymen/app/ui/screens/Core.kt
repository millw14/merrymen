package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.ChatCommand
import dev.merrymen.app.net.ChatTurnWire
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Thesis
import dev.merrymen.app.net.TierView
import dev.merrymen.app.ui.Acted
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.CommandSpec
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Neutral
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Pixel
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.Via
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.buildChatState
import dev.merrymen.app.ui.runCommand
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.shortAddress
import dev.merrymen.app.ui.toneOf
import dev.merrymen.app.ui.verbOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.math.MathContext
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * THE FIVE TAB SCREENS, RESTYLED AGAINST THE WEB TERMINAL BELOW 1100px.
 *
 * ONE READING RULE RUNS THROUGH EVERY NUMBER IN THIS FILE. `terminal.css` writes
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
// SHARED PRIVATE FURNITURE
//
// All of it is `private` per the one-file rule. Several pieces plainly belong in
// Components.kt — [FlowPrimary], [Tag], [HostedNote], [StrokeGlyph] and
// [moneyText] are already wanted by three screens each. They are listed in the
// hand-off notes rather than lifted here.
// ---------------------------------------------------------------------------

/** The SVG grid every lucide glyph in this file is authored on. */
private const val ICON_VIEW = 24f

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
private fun StrokeGlyph(
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

/** lucide `Search`, size 22 on Home's heading row (`terminal.css:742-748`). */
@Composable
private fun SearchGlyph(tint: Color, size: Dp = 22.dp) {
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / ICON_VIEW
    val handle = PathParser().parsePathString("m21 21-4.3-4.3").toPath()
    scale(s, s, pivot = Offset.Zero) {
      drawCircle(tint, radius = 8f, center = Offset(11f, 11f), style = Stroke(width = 2f))
      drawPath(handle, tint, style = Stroke(width = 2f, cap = StrokeCap.Round))
    }
  }
}

/** lucide `ChevronRight`, 18px, at the end of every account row. */
@Composable
private fun ChevronRight(tint: Color, size: Dp = 18.dp) =
  StrokeGlyph("m9 18 6-6-6-6", tint = tint, size = size)

/** lucide `ChevronDown`, 16px, stroke 1.75 — the sort control's only chrome. */
@Composable
private fun ChevronDown(tint: Color, size: Dp = 16.dp) =
  StrokeGlyph("m6 9 6 6 6-6", tint = tint, size = size, stroke = 1.75f)

/** lucide `ArrowUp`, 19px, stroke 1.8 — the composer's send glyph. */
@Composable
private fun ArrowUp(tint: Color, size: Dp = 19.dp) =
  StrokeGlyph("m5 12 7-7 7 7", "M12 19V5", tint = tint, size = size, stroke = 1.8f)

/**
 * lucide `LockKeyhole`, size 32, in the literal `#38dda0` polish.css:150 sets.
 *
 * That hex is NOT `--up` #3dd68c and NOT `--lime`. It is the mobile Alpha gate's
 * own accent and it must never touch a figure — a padlock in the money-up green
 * would make "you cannot see this" read as "this went up".
 */
@Composable
private fun LockKeyholeGlyph(tint: Color, size: Dp = 32.dp) {
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / ICON_VIEW
    val shackle = PathParser().parsePathString("M7 10V7a5 5 0 0 1 10 0v3").toPath()
    scale(s, s, pivot = Offset.Zero) {
      drawRoundRect(
        color = tint,
        topLeft = Offset(3f, 10f),
        size = Size(18f, 12f),
        cornerRadius = CornerRadius(2f, 2f),
        style = Stroke(width = 2f, join = StrokeJoin.Round),
      )
      drawPath(shackle, tint, style = Stroke(width = 2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
      drawCircle(tint, radius = 1f, center = Offset(12f, 16f))
    }
  }
}

/** The three lucide glyphs the "Inside Alpha" teaser lists, at lucide size 22. */
private object InsideIcons {
  val activity = arrayOf("M22 12h-4l-3 9L9 3l-3 9H2")
  val fileText = arrayOf(
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v5h5",
    "M16 13H8",
    "M16 17H8",
    "M10 9H8",
  )
  val externalLink = arrayOf(
    "M15 3h6v6",
    "M10 14 21 3",
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  )
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
private fun moneyText(v: Double): String = "$" + String.format(Locale.US, "%,.2f", v)

/** `toLocaleString("en-US")` on a whole number — the Alpha threshold's "100,000". */
private fun groupedInt(n: Int): String = String.format(Locale.US, "%,d", n)

/**
 * `coinPrice()` — `live.ts:263-270`, five branches, ported exactly.
 *
 * A NULL PRICE IS AN EM DASH AND NEVER "$0.00". `$0` is reserved for a price we
 * read that was genuinely zero; the dash is us never having got an answer.
 *
 * `toPrecision(3)` is SIGNIFICANT FIGURES, not decimals, so it is BigDecimal with
 * a MathContext rather than a "%.3f". Rendered with `toPlainString()`, which is
 * where this diverges from JavaScript: `toPrecision` flips to exponential notation
 * below 1e-6 and this does not. A sub-micro-dollar price therefore reads
 * "$0.00000123" here and "1.23e-6" in a browser. Stated rather than hidden.
 */
private fun coinPrice(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  if (n == 0.0) return "$0"
  if (n < 0.01) return "$" + BigDecimal(n).round(MathContext(3)).toPlainString()
  if (n >= 100) return "$" + String.format(Locale.US, "%,.2f", n)
  if (n >= 1) return "$" + String.format(Locale.US, "%.2f", n)
  return "$" + String.format(Locale.US, "%.4f", n)
}

/** `compactUsd()` — `live.ts:255-261`. Lowercase k, uppercase M and B. */
private fun compactUsd(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  val a = abs(n)
  return when {
    a >= 1e9 -> "$" + String.format(Locale.US, "%.1f", n / 1e9) + "B"
    a >= 1e6 -> "$" + String.format(Locale.US, "%.1f", n / 1e6) + "M"
    a >= 1e3 -> "$" + (n / 1e3).roundToInt() + "k"
    else -> "$" + n.roundToInt()
  }
}

/**
 * THE TIMESTAMP, from `clock.ts:19-28` — "now" under a minute, then `{n}m`,
 * `{n}h` under 48 hours, then `{n}d`.
 *
 * THE UNIT GUARD IS `ageOf`'s, NOT `whenOf`'s. `wire.tsx` feeds `beat.at`
 * straight into `elapsed(at, Date.now())`, which assumes milliseconds — but
 * `live.ts:317` reads the same field with `raw < 1e12 ? raw * 1000 : raw`,
 * because the published rows have carried seconds. The defensive form is the one
 * that cannot render "56 years ago", so it is the one here.
 */
private fun agoText(at: Long, nowMs: Long): String {
  val ms = if (at < 1_000_000_000_000L) at * 1000 else at
  val s = ((nowMs - ms) / 1000).coerceAtLeast(0L)
  if (s < 60) return "now"
  val m = s / 60
  if (m < 60) return "${m}m"
  val h = m / 60
  if (h < 48) return "${h}h"
  return "${h / 24}d"
}

/** Milliseconds of quiet that earn a lull marker — `beat.ts:282`, `LULL_MS`. */
private const val LULL_MS = 3L * 3_600_000L

/** Normalised to milliseconds by the same guard [agoText] uses. */
private fun atMs(at: Long): Long = if (at < 1_000_000_000_000L) at * 1000 else at

/**
 * THE MOBILE FEED TAB'S SELECTED GREEN — `polish.css:115`, a literal `#38dda0`.
 *
 * It is NOT `--up` #3dd68c, though they are near-identical. `--up` means money
 * moved; putting it on a navigation control would spend the one colour in this
 * product that is a claim about a number on "which filter you happen to be on".
 * Kept as its own constant so a later palette edit cannot merge the two.
 */
private val TabGreen = Color(0xFF38DDA0)

/** `polish.css:153` — the locked Alpha CTA's ink. Only ever on that button. */
private val GateInk = Color(0xFF07150E)

/** `.tag`'s ground — `terminal.css:1705`. Warmer than `--card`, and not a token. */
private val TagGround = Color(0xFF1C1D16)

/** `.wire-beat.sell .wire-parts` — `terminal.css:2939`. A warm near-black, not `--card`. */
private val SellGround = Color(0xFF14110F)

/** `polish.css:75` — the sign-out red, which is deliberately NOT `--down`. */
private val SignOutRed = Color(0xFFF47777)

/**
 * `.tag` — `terminal.css:1703`: 12px, weight 500, `letter-spacing: .03em`,
 * `line-height: 1`, `--tx-2` on #1c1d16, `padding: 3px 6px 2px`, radius 2px.
 *
 * NOTE THE ASYMMETRIC VERTICAL PADDING and the 2px radius: this is a squared-off
 * label, not a pill. The pill shape in this product means "a filter you can
 * press", and a strategy name is not one.
 */
@Composable
private fun Tag(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier
      .clip(RoundedCornerShape(2.dp))
      .background(TagGround)
      .padding(start = 6.dp, end = 6.dp, top = 3.dp, bottom = 2.dp),
    style = TextStyle(
      fontFamily = sans(12.sp, FontWeight.W500),
      fontSize = 12.sp,
      fontWeight = FontWeight.W500,
      letterSpacing = 0.03.em,
      lineHeight = 12.sp,
    ),
    color = MerryColors.tx2,
  )
}

/**
 * `.flow-primary` — `terminal.css:416` as amended by `terminal.css:4351`:
 * full width, min-height 48px, `padding: 14px 18px`, radius 12px, 14px/600,
 * `background: var(--tx); color: var(--ink)`.
 *
 * The base rule says `--lime` and the LATER one replaces it with `--tx`. The
 * terminal's only primary button is off-white on near-black ink; there is no
 * accent-filled button anywhere in the mobile shell except the confirm card's
 * YES and the blocker's re-sign, both of which authorise an act.
 */
@Composable
private fun FlowPrimary(
  label: String,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  ground: Color = MerryColors.tx,
  ink: Color = MerryColors.ink,
  minHeight: Dp = 48.dp,
  size: TextUnit = 14.sp,
) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .fillMaxWidth()
      .heightIn(min = minHeight)
      .clip(shape)
      .background(ground)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 18.dp, vertical = 14.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      textAlign = TextAlign.Center,
      style = TextStyle(
        fontFamily = sans(size, FontWeight.W600),
        fontSize = size,
        fontWeight = FontWeight.W600,
      ),
      color = ink,
    )
  }
}

/**
 * `.hosted-note` — `terminal.css:6691-6701`: `padding: 10px 12px`, 1px `--line`
 * border with the LEFT edge at 3px in `--faint`, radius 8px, 13px/1.5 `--tx-2`.
 *
 * THE HOUSE VOCABULARY FOR "THE PAGE RENDERED, AND HERE IS THE PART OF IT THAT
 * DID NOT". It is not amber (that means "you chose something you cannot use
 * yet") and it is not red (that means "the thing you did failed"). Compose
 * borders are uniform, so the 3px rule is drawn separately inside the 1px one.
 */
@Composable
private fun HostedNote(text: String, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(8.dp)
  Box(
    modifier
      .fillMaxWidth()
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .drawBehind { drawRect(MerryColors.faint, size = Size(3.dp.toPx(), size.height)) }
      .padding(horizontal = 12.dp, vertical = 10.dp),
  ) {
    Text(
      text = text,
      modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
      style = TextStyle(
        fontFamily = sans(13.sp),
        fontSize = 13.sp,
        fontWeight = FontWeight.W400,
        lineHeight = 19.5.sp,
      ),
      color = MerryColors.tx2,
    )
  }
}

/** `.flow-error` — `terminal.css:373`: 12px `--down`, line-height 1.5, role=alert. */
@Composable
private fun FlowError(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier.semantics { liveRegion = LiveRegionMode.Assertive },
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.sp,
    ),
    color = MerryColors.down,
  )
}

/**
 * A 20px section heading — `.week-label` / `.board-head h2` / `.alpha-inside h2`
 * at `polish.css:71`, `:79`, `:96`: 20px, weight 600, `letter-spacing: -.02em`.
 */
@Composable
private fun SectionHeading(text: String, modifier: Modifier = Modifier) {
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

/** `.account-section-title h2` — `polish.css:134`: 19px, weight 600. */
@Composable
private fun AccountHeading(text: String, count: String? = null) {
  Row(
    Modifier.fillMaxWidth().padding(bottom = 12.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = text,
      style = TextStyle(
        fontFamily = sans(19.sp, FontWeight.W600),
        fontSize = 19.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.02).em,
      ),
      color = MerryColors.tx,
    )
    // `polish.css:135` strips the chip styling the base sheet gave this: it is a
    // bare 12px faint number, not a pill.
    if (count != null) {
      Text(
        text = count,
        style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp),
        color = MerryColors.faint,
      )
    }
  }
}

/** Body prose at an explicit size and line-height, in one of the three greys. */
@Composable
private fun Prose(
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

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------

/**
 * HOME — one scrolling column, no cards, no dividers, no surface fills.
 *
 * `polish.css:65`: `.home-page { display:flex; flex-direction:column; gap:28px }`,
 * inside the body's own `padding: 16px 20px …` (`polish.css:87`) with the top
 * raised to 20px by `polish.css:177-180`. Every block here sits directly on
 * `--bg`; the only filled things on the whole web screen are the Deposit button,
 * the two market pills and the tiny strategy tags.
 *
 * THE 28px IS SPELT AS EXPLICIT TOP PADDING rather than as an
 * `Arrangement.spacedBy`, because the header block's own internal rhythm is 18px
 * (`polish.css:68`) and 20/8px (`.home-balance-label`), and one arrangement
 * value would flatten all three into one.
 *
 * WHAT THIS SCREEN FETCHES IS WHAT IT FETCHED BEFORE: `/api/feed` and
 * `/api/tier`, once, on first composition.
 */
@Composable
fun HomeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var feed by remember { mutableStateOf<Loaded<Feed>>(Loaded.Loading) }
  var tier by remember { mutableStateOf<Loaded<TierView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()

  suspend fun load() {
    feed = c.api.feed().toLoaded()
    tier = c.api.tier().toLoaded()
  }
  LaunchedEffect(Unit) { load() }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      // `.body:has(> .home-page) { padding-top: 20px }` — polish.css:180 wins
      // over the shorthand's 16px on source order at equal specificity.
      .padding(top = 20.dp),
  ) {
    // `.home-heading` — flex, space-between, margin-bottom 18px.
    Row(
      Modifier.fillMaxWidth().padding(bottom = 18.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      PageTitle("Home")
      // `.icon-btn` — terminal.css:742-748: a 40x40 box holding a 22px glyph.
      // 40dp is under Android's 48dp guidance; the box is left at the web's size
      // so the heading's rhythm is not changed by a touch-target decision.
      Box(
        Modifier
          .size(40.dp)
          .clickable(role = Role.Button) { nav.navigate(Routes.SEARCH) }
          .semantics { contentDescription = "Search tokens or agents" },
        contentAlignment = Alignment.Center,
      ) { SearchGlyph(MerryColors.tx) }
    }

    CircleLockBanner(tier, nav)

    LoadedBlock(
      feed,
      onSignIn = { nav.navigate(Routes.SIGN_IN) },
      onRetry = { scope.launch { load() } },
    ) { f ->
      HomeHero(f)

      // THE WORKER'S OWN WARNING, which for a long time rendered nowhere at all.
      f.events.firstOrNull { it.level == "warn" || it.level == "err" || it.level == "error" }
        ?.message?.let {
          Notice(title = "From your agent", body = it, modifier = Modifier.padding(top = 28.dp))
        }

      HomePositions(f)
      HomeGo(nav)
    }
    BottomInsetSpacer()
  }
}

/**
 * The header block's lower half: who the agent is, then the portfolio figure.
 *
 * `polish.css:90-94`, in order: `.hero-who { margin:0; gap:12px }`, the face at
 * 40x40, the name at 18px, the owner line at 13px, and the balance at 56px with
 * `line-height: 1.1` and no margin of its own.
 */
@Composable
private fun HomeHero(f: Feed) {
  val agent = f.agent
  Column(Modifier.fillMaxWidth()) {
    if (agent != null) {
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Avatar(name = agent.name ?: "an agent", size = 40.dp)
        Column(Modifier.weight(1f)) {
          Text(
            text = agent.name ?: "an agent",
            style = TextStyle(
              fontFamily = sans(18.sp, FontWeight.W600),
              fontSize = 18.sp,
              fontWeight = FontWeight.W600,
              letterSpacing = (-0.02).em,
            ),
            color = MerryColors.tx,
          )
          // AN ABSENT OWNER GETS NO LINE AT ALL — `ui.tsx:102`. Not "owned by
          // anonymous", not an em dash: there is nothing to say, so nothing is
          // said. The handle is plain text and never a link, because nothing on
          // this payload proves the association.
          agent.owner?.takeIf { it.isNotBlank() }?.let { owner ->
            Prose(
              text = "owned by " + (shortAddress(owner) ?: owner),
              size = 13.sp,
              lineHeight = 17.55.sp,
              color = MerryColors.faint,
              modifier = Modifier.padding(top = 2.dp),
            )
          }
        }
      }
    } else {
      // `.hero.empty` — Home.tsx:126-128, exact copy including the full stop.
      Prose(
        text = "This one trades.",
        size = 22.sp,
        lineHeight = 26.4.sp,
        color = MerryColors.tx,
        weight = FontWeight.W700,
      )
    }

    // `.home-balance-label` — polish.css:68: 14px `--tx-2`, 20px above, 8px below.
    Prose(
      text = "Portfolio balance",
      size = 14.sp,
      lineHeight = 18.9.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
    )
    PixelBalance(f.equityNow)

    // The mode chip is a fact about the RAIL, not a performance claim — so it is
    // a `.tag`, the same squared-off label the leaderboard puts a strategy in,
    // and never a tinted pill.
    agent?.strategy?.takeIf { it.isNotBlank() }?.let {
      Row(Modifier.padding(top = 12.dp)) { Tag(it) }
    }
    if (agent?.basket?.isNotEmpty() == true) {
      Prose(
        text = "Trading " + agent.basket.joinToString(", "),
        size = 13.sp,
        lineHeight = 18.85.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 8.dp),
      )
    }
  }
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
private fun PixelBalance(
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

/**
 * Positions, drawn the way the web draws a token list on Home: a 20px heading
 * and then borderless rows separated by whitespace only.
 *
 * `polish.css:102`: `.home-mobile-market .tok { padding: 16px 0 }` with
 * `min-height: 64px` from `terminal.css:979`, and NO divider, NO background and
 * NO border between rows. Reaching for a `SectionCard` here would draw a box the
 * web does not draw.
 */
@Composable
private fun HomePositions(f: Feed) {
  Column(Modifier.fillMaxWidth().padding(top = 28.dp)) {
    SectionHeading("Positions", Modifier.padding(bottom = 12.dp))
    if (f.positions.isEmpty()) {
      Prose("Nothing held right now.", 13.sp, 18.85.sp, MerryColors.tx2)
      return@Column
    }
    f.positions.forEach { p ->
      Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(vertical = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        // The coin mark, seeded on the symbol exactly as `ui.tsx:258-272` does.
        Avatar(name = p.symbol, size = 40.dp)
        Column(Modifier.weight(1f)) {
          Text(
            text = p.symbol,
            maxLines = 1,
            style = TextStyle(
              fontFamily = sans(16.sp, FontWeight.W700),
              fontSize = 16.sp,
              fontWeight = FontWeight.W700,
            ),
            color = MerryColors.tx,
          )
          // A STALE MARK IS NOT A WRONG ONE and it is not an error either — it
          // is the last good reading, said as such. `.meta`, 13px `--tx-2`.
          if (p.priceStale) {
            Prose(
              text = "price stale — last good mark",
              size = 13.sp,
              lineHeight = 18.85.sp,
              color = MerryColors.tx2,
              modifier = Modifier.padding(top = 2.dp),
            )
          }
        }
        // `Money` renders "—" for an unread value and never "$0.00".
        Money(p.valueUsdg, bold = true)
      }
    }
  }
}

/**
 * The navigation this screen already carried, in the terminal's own chip row.
 *
 * `.hosted-account-links a/button` — `polish.css:48-49`, which sits OUTSIDE every
 * media query and is therefore live on a phone: `min-height: 44px; padding: 8px
 * 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--tx);
 * font-size: 12px`.
 *
 * The web's Home has no such block. These links are kept because deleting
 * working navigation is not a restyle; the chip row is the closest live
 * vocabulary the sheet has for "a handful of places to go".
 */
@Composable
private fun HomeGo(nav: NavHostController) {
  Column(Modifier.fillMaxWidth().padding(top = 28.dp)) {
    SectionHeading("Go", Modifier.padding(bottom = 12.dp))
    // Two rows of two rather than a flow, so the wrap point is authored rather
    // than left to whatever the longest label happens to be.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      LinkChip("Markets", Modifier.weight(1f)) { nav.navigate(Routes.MARKETS) }
      LinkChip("Leaderboard", Modifier.weight(1f)) { nav.navigate(Routes.LEADERBOARD) }
    }
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      LinkChip("Trade", Modifier.weight(1f)) { nav.navigate(Routes.TRADE) }
      LinkChip("Settings", Modifier.weight(1f)) { nav.navigate(Routes.SETTINGS) }
    }
  }
}

@Composable
private fun LinkChip(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .heightIn(min = 44.dp)
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 12.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(12.sp, FontWeight.W600),
        fontSize = 12.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * The eye-catching warning a tester asked for.
 *
 * "The app should warn more eye-catching when someone has chosen a holder-only
 * strategy and don't have access to it. For me it's being tricky to figure that
 * out, I had to go to /api/circle to check that and that's not good for
 * normies."
 *
 * Three arms, because there are three answers: unreadable is OUR failure and
 * must never render as "you don't hold enough", and signed-out is a door. The
 * copy and the branch conditions are untouched by the restyle; only the 28dp of
 * clearance under it is new, so it sits in the page rhythm rather than against
 * the block below.
 */
@Composable
private fun CircleLockBanner(tier: Loaded<TierView>, nav: NavHostController) {
  val t = (tier as? Loaded.Value)?.value ?: return
  when {
    t.why == "unreadable" -> Notice(
      title = "Couldn't read your \$MERRYMEN balance",
      body = "That's our chain read failing, not your wallet. It should clear on its own.",
      modifier = Modifier.padding(bottom = 28.dp),
    )
    t.why == "ok" && !t.bonusStrategies -> Notice(
      title = "Holder-only strategies are locked",
      body = "even-keel and dip-hunter run only while you hold ${t.needTokens} \$MERRYMEN" +
        // NULL TOKENS IS "—", NOT "0". A self-hosted origin (and any read that
        // did not resolve a balance) sends no token count; `?: 0` printed "you
        // hold 0", a confident zero the sibling screens never allow. Omit the
        // clause entirely when the balance is unknown.
        (t.tokens?.let { " — you hold $it. Adding cash won't change it." } ?: "."),
      actionLabel = "See the Circle",
      onAction = { nav.navigate(Routes.CIRCLE) },
      modifier = Modifier.padding(bottom = 28.dp),
    )
  }
}

// ---------------------------------------------------------------------------
// FEED
// ---------------------------------------------------------------------------

/** Who a post's own words named. `wire.tsx`'s `Mention`, minus the styling. */
private data class Mention(val handle: String, val slug: String)

/** What the rail draws, top to bottom — `beat.ts:124`. Presentation, not domain. */
private sealed interface Lane {
  data class Beat(val t: Thesis, val mentions: List<Mention>) : Lane
  object Lull : Lane
}

/**
 * WHO NAMED WHOM — read off the page, never inferred. `Feed.tsx:166-185`.
 *
 * A post is part of a debate when its own published words contain the `@handle`
 * of another agent that also posted in the same window. Both sides are already
 * on screen, so nothing here is an attribution we did not read: it is not
 * "replying to", which would claim an intent the rows do not carry.
 *
 * THE `@` IS REQUIRED. Agent handles are short words, and matching a bare one
 * would make every thesis mentioning "value" a reply to @value.
 *
 * THIS IS THE ONE PIECE OF FILTERING LOGIC THIS RESTYLE ADDED, and it is added
 * because the fourth tab the mobile sheet renders is "Debates" — a tab that
 * ships inert is worse than no tab. It is a port of `repliesIn`, not an
 * invention, it runs in memory over the rows already loaded, and it triggers no
 * fetch. Flagged in the hand-off notes.
 */
private fun mentionsOf(rows: List<Thesis>): List<List<Mention>> {
  val byHandle = LinkedHashMap<String, Mention>()
  for (t in rows) {
    val slug = t.slug ?: continue
    val h = (t.handle ?: "").trim().removePrefix("@").lowercase(Locale.ROOT)
    if (h.isNotEmpty()) byHandle[h] = Mention(h, slug)
  }
  if (byHandle.size < 2) return rows.map { emptyList() }
  return rows.map { t ->
    // The web reads `kind === "view" ? head : ""` plus the reason. A row with a
    // buy/sell action and a symbol is the trade arm; everything else is a view.
    val isTrade = (t.action == "buy" || t.action == "sell") && t.symbol != null
    val text = ((if (isTrade) "" else t.head) + " " + (t.reason ?: "")).lowercase(Locale.ROOT)
    byHandle.values.filter { it.slug != t.slug && text.contains("@" + it.handle) }
  }
}

/**
 * `lanesOf` — `beat.ts:284-296`. A lull marker goes between two consecutive
 * posts three hours or more apart.
 *
 * The gap is `prev.at - this.at` exactly as the web computes it, which assumes
 * the newest post is first — the order this list already arrives in. If it ever
 * arrives ascending the marker simply never fires, which is the harmless
 * direction to be wrong in.
 */
private fun lanesOf(rows: List<Thesis>, mentions: List<List<Mention>>): List<Lane> {
  val out = ArrayList<Lane>(rows.size)
  rows.forEachIndexed { i, t ->
    val prev = rows.getOrNull(i - 1)
    val a = t.at
    val b = prev?.at
    if (a != null && b != null && atMs(b) - atMs(a) >= LULL_MS) out.add(Lane.Lull)
    out.add(Lane.Beat(t, mentions.getOrElse(i) { emptyList() }))
  }
  return out
}

/**
 * THE FEED — a flat list of beats on the page ground, and nothing else.
 *
 * THERE ARE NO CARDS HERE. `.wire` (terminal.css:2776) is a bare flex column
 * with no gap, and `.wire-beat` (terminal.css:2796 + polish.css:117) has no
 * background, no border, no radius and no divider: rows are separated purely by
 * their own 22px of top and bottom padding. The client drew a bordered
 * [dev.merrymen.app.ui.SectionCard] per row, which is the single largest
 * structural difference this pass removed.
 *
 * The filter is NOT pills either. `polish.css:113-115` replaces the base pill row
 * with a four-column underline tab strip; see [FeedTabs]. Sorting is a separate
 * control (`Feed.tsx:100`), so the "Most liked" pill moved into [SortControl] —
 * the sort itself is the same expression it always was.
 *
 * NOTHING ABOUT WHAT THIS SCREEN READS CHANGED: `/api/theses` once, plus the
 * throttled `Social.refresh()` for the counts and this reader's own likes.
 */
@Composable
fun FeedScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var page by remember { mutableStateOf<Loaded<List<Thesis>>>(Loaded.Loading) }
  var filter by remember { mutableStateOf("All") }
  var byLikes by remember { mutableStateOf(false) }
  val likes by c.social.likes.collectAsState()
  val scope = rememberCoroutineScope()

  suspend fun load() { page = c.api.theses().toLoaded().let { s ->
    when (s) {
      is Loaded.Value -> Loaded.Value(s.value.theses)
      is Loaded.Refused -> s
      is Loaded.Unreachable -> s
      else -> Loaded.Loading
    }
  } }
  // The counts and this reader's own likes travel on separate routes from the
  // posts, and both are throttled inside Social — coming back to this tab does
  // not re-poll them.
  LaunchedEffect(Unit) { load(); c.social.refresh() }

  // `wire.tsx:48` — `useNow(30_000)`. The timestamps are relative, so they have
  // to be recomputed; driving them from a 30s tick rather than per frame is the
  // web's own choice and it is what keeps a scrolling list from re-laying out.
  var now by remember { mutableStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) {
      delay(30_000)
      now = System.currentTimeMillis()
    }
  }

  // THE LIST IS DERIVED HERE, IN THE COMPOSABLE SCOPE, and not inside the
  // LazyColumn's builder. A `LazyListScope` lambda is ordinary Kotlin, and
  // snapshot state read only from inside it does not reliably re-run when that
  // state changes — so `filter`, `byLikes` and `likes` are read out here, where
  // a change is observed, and the builder below closes over plain values.
  //
  // The filter predicates and the sort are the ones this screen already had.
  // Remembered against its inputs so the 30-second timestamp tick does not
  // re-run the mention scan and the sort over the whole window every half minute.
  val rows = (page as? Loaded.Value)?.value
  val lanes: List<Lane>? = remember(rows, filter, byLikes, likes) { rows?.let { all ->
    val mentions = mentionsOf(all)
    val kept = ArrayList<Thesis>(all.size)
    val keptMentions = ArrayList<List<Mention>>(all.size)
    all.forEachIndexed { i, t ->
      val m = mentions.getOrElse(i) { emptyList() }
      val keep = when (filter) {
        "Trades" -> t.action == "buy" || t.action == "sell"
        "Theses" -> t.action == null || t.action == "hold" || t.outcome == "view"
        "Debates" -> m.isNotEmpty()
        else -> true
      }
      if (keep) { kept.add(t); keptMentions.add(m) }
    }
    // SORTED IN A COPY, and only where the numbers were actually read. A stable
    // sort keeps equal-count posts in their published order rather than
    // shuffling them under the reader on every poll.
    val order = if (byLikes && likes.read) {
      kept.indices.sortedByDescending { i -> kept[i].postId?.let { likes.counts[it] } ?: 0 }
    } else {
      kept.indices.toList()
    }
    lanesOf(order.map { kept[it] }, order.map { keptMentions[it] })
  } }

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(
      start = PagePadH,
      end = PagePadH,
      // `.body:has(> .feed-page) { padding-top: 20px }` — polish.css:180.
      top = 20.dp,
      bottom = LocalBottomInset.current,
    ),
  ) {
    item {
      // `.feed-head` — polish.css:112: `margin: 0 0 16px; min-height: 44px`.
      Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(bottom = 16.dp),
        contentAlignment = Alignment.CenterStart,
      ) { PageTitle("Feed") }
    }

    item {
      FeedTabs(selected = filter) { filter = it }
    }

    // A CONTROL THAT CANNOT ANSWER IS NOT SHOWN. Sorting by likes exists only
    // where likes do — a self-hosted install has no such route.
    if (likes.supported) {
      item { SortControl(byLikes) { byLikes = it } }
    }

    // Sorting by a number we could not read would silently sort by nothing.
    if (byLikes && !likes.read) {
      item {
        Text(
          text = "Likes unavailable.",
          modifier = Modifier
            .padding(vertical = 15.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 20.25.sp),
          color = MerryColors.tx,
        )
      }
    }

    when {
      // Loading, refused and unreachable are LoadedBlock's own three
      // renderings, and they stay three. The content lambda is empty because
      // the rows themselves are drawn by the branches below.
      lanes == null -> item {
        LoadedBlock(
          page,
          onSignIn = { nav.navigate(Routes.SIGN_IN) },
          onRetry = { scope.launch { load() } },
        ) { }
      }

      lanes.isEmpty() -> item {
        // FILTERED-EMPTY IS NOT QUIET. The read succeeded and the rows are
        // there; one tab matched none of them, and saying "nothing here yet"
        // would blame the agents for the reader's own filter.
        //
        // The web checks the tab BEFORE it consults the read state
        // (`Feed.tsx:102-110`), which lets a failed read assert "No trades in
        // this window." — an emptiness claim on a read that never happened.
        // This branch is only reachable when `page` is a `Value`, so the read
        // has succeeded by construction and that defect cannot be reproduced.
        if (filter == "All") {
          Empty("Nothing here yet", "When agents trade or publish a view, it lands here.")
        } else {
          Empty(
            title = when (filter) {
              "Trades" -> "No trades in this window."
              "Theses" -> "Nobody has published a view here yet."
              else -> "No agent has named another one yet."
            },
            body = "",
            actionLabel = "Show everything",
            // The action resets the tab. It does NOT refetch.
            onAction = { filter = "All" },
          )
        }
      }

      // Real lazy items: the rail is drawn per row (see [beatRail]) precisely so
      // the list does not have to be one composed block to stay continuous.
      else -> items(lanes) { lane ->
        when (lane) {
          is Lane.Lull -> LullMarker()
          is Lane.Beat -> ThesisRow(
            t = lane.t,
            mentions = lane.mentions,
            now = now,
            onOpen = { lane.t.slug?.let { nav.navigate(Routes.agent(it)) } },
            onAgent = { slug -> nav.navigate(Routes.agent(slug)) },
          )
        }
      }
    }
  }
}

/**
 * THE FILTER — a four-column underline tab strip, not a row of pills.
 *
 * `polish.css:113`: `display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
 * gap: 0; border-bottom: 1px solid var(--line); margin: 0 0 8px`.
 * `polish.css:114`: each button `min-height: 48px; padding: 10px 4px; border: 0;
 * border-bottom: 3px solid transparent; border-radius: 0; font-size: 15px;
 * color: var(--tx-2)` — regular weight, inherited.
 * `polish.css:115`: the pressed one keeps a TRANSPARENT background and changes
 * only two things — the label to `#38dda0` and the bottom border to the same.
 *
 * FOUR TABS, AND THERE IS NO "TOP". `Feed.tsx:29-34` lists All / Trades /
 * Theses / Debates; the `top` id exists in the type, in `emptyFor()` and in
 * `keepBeat()`, but `PILLS` never contains it and `const pills = PILLS` is
 * unconditional, so it can never render.
 *
 * The selected colour is [TabGreen] and not `--up`; see that constant.
 */
@Composable
private fun FeedTabs(selected: String, onSelect: (String) -> Unit) {
  val tabs = listOf("All", "Trades", "Theses", "Debates")
  Row(
    Modifier
      .fillMaxWidth()
      // `margin: 0 0 8px` is OUTSIDE the border, so the padding is applied
      // first and the hairline is drawn inside it.
      .padding(bottom = 8.dp)
      .drawBehind {
        val t = 1.dp.toPx()
        drawRect(MerryColors.line, Offset(0f, size.height - t), Size(size.width, t))
      },
  ) {
    tabs.forEach { tab ->
      val on = tab == selected
      Box(
        Modifier
          .weight(1f)
          .heightIn(min = 48.dp)
          .clickable(role = Role.Tab) { onSelect(tab) }
          .drawBehind {
            if (!on) return@drawBehind
            val t = 3.dp.toPx()
            drawRect(TabGreen, Offset(0f, size.height - t), Size(size.width, t))
          }
          .padding(horizontal = 4.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = tab,
          maxLines = 1,
          textAlign = TextAlign.Center,
          // Size and weight do NOT change on selection. Only the colour and the
          // underline do; bolding the active tab would be a second signal the
          // sheet does not have.
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, fontWeight = FontWeight.W400),
          color = if (on) TabGreen else MerryColors.tx2,
        )
      }
    }
  }
}

/**
 * THE SORT, which is a separate control from the filter and is not a pill.
 *
 * `Feed.tsx:100` renders a bare native `select` with two options, "Latest" and
 * "Most liked", labelled "Sort posts". `.feed-sort-row` and `.feed-sort` have
 * ZERO rules in any loaded sheet — the element inherits `font: inherit; color:
 * inherit` (15px, `--tx`) and otherwise renders as the browser's own dark
 * dropdown. (The similar-looking `.feed-order` rules at polish.css:53-54 belong
 * to a different class that `Feed.tsx` does not use.)
 *
 * THERE IS NO FAITHFUL TARGET HERE, so this is an interpretation and is stated
 * as one: a 15sp label plus a 16px chevron, no border and no ground, opening a
 * two-item menu. An `OutlinedTextField`-shaped dropdown would invent chrome the
 * web has none of.
 */
@Composable
private fun SortControl(byLikes: Boolean, onPick: (Boolean) -> Unit) {
  var open by remember { mutableStateOf(false) }
  Box {
    Row(
      Modifier
        .heightIn(min = 44.dp)
        .clickable(role = Role.Button) { open = true }
        .semantics { contentDescription = "Sort posts" },
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = if (byLikes) "Most liked" else "Latest",
        style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp),
        color = MerryColors.tx,
      )
      ChevronDown(MerryColors.tx2)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      DropdownMenuItem(
        text = { Text("Latest", style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp)) },
        onClick = { onPick(false); open = false },
      )
      DropdownMenuItem(
        text = { Text("Most liked", style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp)) },
        onClick = { onPick(true); open = false },
      )
    }
  }
}

/** `--rail: calc(var(--mark) / 2)` — terminal.css:2779. Half of the 22px mark. */
private val RAIL_X = 11.dp

/**
 * THE HAIRLINE THE FACES SIT ON — `.wire::before`, terminal.css:2785-2794.
 *
 * A 1px line at x = 11px running the height of the LIST, at opacity 0.35, filled
 * with `linear-gradient(180deg, transparent, var(--line) 12%, var(--line) 88%,
 * transparent)` — it fades in over its first 12% and out over its last 12%.
 *
 * WHAT WAS LOST, SAID PLAINLY. There is no element in a Compose list whose
 * height is the list's content height, and a `drawBehind` on the LazyColumn
 * covers only the viewport — which would make the two fades re-appear at every
 * scroll position, i.e. a gradient that follows the reader. So the rail is drawn
 * at CONSTANT alpha inside each row instead. The line is continuous because the
 * rows are contiguous; what is gone is the fade at the very top and the very
 * bottom of the whole list.
 */
private fun Modifier.beatRail(): Modifier = drawBehind {
  val w = 1.dp.toPx()
  drawRect(
    color = MerryColors.line,
    topLeft = Offset(RAIL_X.toPx() - w / 2f, 0f),
    size = Size(w, size.height),
    alpha = 0.35f,
  )
}

/**
 * THE QUIET STRETCH — `.wire-lull`, terminal.css:2818-2832.
 *
 * An 8px empty row (padding 4px 0, no content, aria-hidden) carrying a DASHED
 * 1px segment on the rail: `repeating-linear-gradient(180deg, var(--bg) 0 3px,
 * var(--line) 3px 6px)` at opacity 0.35 — three pixels of background, three of
 * line. It says nothing happened for three hours; it must not look like the
 * solid rail, which says something did.
 */
@Composable
private fun LullMarker() {
  Spacer(
    Modifier
      .fillMaxWidth()
      .height(8.dp)
      .drawBehind {
        val dash = 3.dp.toPx()
        val x = RAIL_X.toPx()
        drawLine(
          color = MerryColors.line,
          start = Offset(x, 0f),
          end = Offset(x, size.height),
          strokeWidth = 1.dp.toPx(),
          alpha = 0.35f,
          // Phase by one dash so the segment OPENS with the 3px of background
          // the CSS gradient opens with.
          pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), dash),
        )
      },
  )
}

/** The inline slots the feed sentence needs: a bordered chip and a 6px gap. */
private const val PAPER_SLOT = "paper"
private const val GAP_SLOT = "gap6"

/**
 * A DASHED ROUNDED BORDER, which `Modifier.border` cannot draw.
 *
 * `terminal.css:6758` makes the pretend-fill marker DASHED and read-token.ts says
 * why: "a pretend fill must not look like a real one". A solid border in a
 * dimmer grey reads as de-emphasised, not as not-real, so this exists rather
 * than that shortcut. Components.kt has the same helper, private; it wants
 * lifting once rather than living in two files.
 */
private fun Modifier.dashedBorder(color: Color, width: Dp, radius: Dp): Modifier = drawBehind {
  val w = width.toPx()
  val dash = 3.dp.toPx()
  drawRoundRect(
    color = color,
    topLeft = Offset(w / 2f, w / 2f),
    size = Size(size.width - w, size.height - w),
    cornerRadius = CornerRadius(radius.toPx(), radius.toPx()),
    style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f)),
  )
}

/**
 * `.tag.unsettled` — terminal.css:6760-6768, and `wire.tsx:152` renders it as the
 * literal lowercase word "paper".
 *
 * `background: #1c1d16; color: var(--faint); border: 1px DASHED var(--faint);
 * border-radius: 5px; padding: 1px 5px; font-size: 11px; weight: 500;
 * letter-spacing: .03em; line-height: 1; margin-left: 6px`.
 *
 * THIS MAY NOT BE DROPPED FOR LAYOUT REASONS. It is the only thing on this
 * screen separating a pretend fill from a real one, `paperTradingEnabled`
 * defaults TRUE across the fleet so it is on most rows, and it is pinned by
 * honesty.test.ts. It is also the lowest-contrast element in the row — 11px of
 * #898c80 on #1c1d16 — which is precisely why it must not also be moved behind
 * an overflow or deferred to a detail screen.
 */
@Composable
private fun PaperChip() {
  Box(Modifier.fillMaxSize().padding(start = 6.dp), contentAlignment = Alignment.CenterStart) {
    Box(
      Modifier
        .clip(RoundedCornerShape(5.dp))
        .background(TagGround)
        .dashedBorder(MerryColors.faint, 1.dp, 5.dp)
        .padding(horizontal = 5.dp, vertical = 1.dp),
    ) {
      Text(
        text = "paper",
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(11.sp, FontWeight.W500),
          fontSize = 11.sp,
          fontWeight = FontWeight.W500,
          letterSpacing = 0.03.em,
          lineHeight = 11.sp,
        ),
        color = MerryColors.faint,
      )
    }
  }
}

/**
 * ONE BEAT — two columns, aligned to the TOP, and no box around any of it.
 *
 * `terminal.css:2796-2803`: `grid-template-columns: var(--mark) minmax(0,1fr);
 * column-gap: var(--gap); align-items: start` with `--mark: 22px` and
 * `--gap: 10px`. `polish.css:117` overrides the row padding to
 * `padding-block: 22px`, so adjacent rows sit 44px apart with nothing drawn
 * between them.
 *
 * `minmax(0, 1fr)` is exactly `Modifier.weight(1f)`, including the min-width-0
 * behaviour that lets a long sentence wrap instead of overflowing.
 *
 * THE ROW'S TAP AND THE LIKE ARE SIBLINGS, NOT NESTED (`wire.tsx:211-215`). The
 * clickable is on the avatar, the sentence and the parts box separately — never
 * on the whole Row — so the heart and the mention links keep their own taps.
 */
@Composable
private fun ThesisRow(
  t: Thesis,
  mentions: List<Mention>,
  now: Long,
  onOpen: () -> Unit,
  onAgent: (String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().beatRail().padding(vertical = 22.dp),
    verticalAlignment = Alignment.Top,
  ) {
    // `.wire-mark .face { box-shadow: 0 0 0 2px var(--bg) }` — terminal.css:2814.
    // A spread ring, not a border: `Modifier.border` would eat 2dp of the face,
    // so the ring is a larger `--bg` circle drawn behind it. It is what makes the
    // rail appear to pass BEHIND the avatar rather than stopping at it.
    Box(
      Modifier
        .size(22.dp)
        .drawBehind { drawCircle(MerryColors.bg, radius = size.minDimension / 2f + 2.dp.toPx()) }
        .clickable(role = Role.Button, onClick = onOpen),
    ) {
      // The badge is `.stack-badge .coin` and it renders even for a symbol-less
      // row on the web (`symbol={beat.symbol ?? ""}` at wire.tsx:125, which
      // draws a "?" chip on hueOf("")). That is a quirk of the current code, not
      // a state anybody designed, so the badge is omitted when there is no
      // token rather than reproduced as a question mark.
      Avatar(
        name = t.name ?: t.handle ?: "an agent",
        size = 22.dp,
        badgeSymbol = t.symbol,
      )
    }
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) {
      BeatSentence(t, now, onOpen)

      // The take, when it adds something the line did not already say.
      // `.wire-why` at polish.css:118: 16px, line-height 1.55, `--tx-2`, with
      // 5px above and 8px below. The predicate is the one this client already
      // used and is deliberately unchanged.
      val take = t.reason ?: t.head
      take.takeIf { it.isNotBlank() }?.let {
        Prose(
          text = it,
          size = 16.sp,
          lineHeight = 24.8.sp,
          color = MerryColors.tx2,
          modifier = Modifier.padding(top = 5.dp, bottom = 8.dp),
        )
      }

      if (t.symbol != null) PartsBox(t, onOpen)

      if (mentions.isNotEmpty()) MentionsLine(mentions, onAgent)

      // Null on an unslugged post, which renders no heart at all — a post with
      // no public identity has nothing stable for a like to attach to.
      LikeButton(t.postId)
    }
  }
}

/**
 * THE SENTENCE, in one wrapping paragraph, in this exact order:
 * bold handle, verb, SYMBOL, the paper chip, "— outcomeText", the timestamp.
 *
 * `.wire-line` at polish.css:117 is 16px/1.5 in `--tx-2` (the base sheet's
 * 13px/1.3 is the desktop size). `.wire-line strong` (terminal.css:2866) is
 * `--tx` at weight 700 with `letter-spacing: -.01em`. `.wire-refused`
 * (terminal.css:7750) is 12px in the SAME `--tx-2` as the rest of the line, and
 * `.wire-when` (terminal.css:2874 + polish.css:120) is 12px in `--faint` with
 * `margin-left: 6px`.
 *
 * THE VERB IS NOT COLOUR-CODED. No selector tints "bought", "tried to buy",
 * "would buy" or "is buying" differently — every outcome colour in the design
 * lives on the parts box. The previous version tinted the verb, which
 * double-encoded the claim; the tint is gone and the words are untouched.
 *
 * THE HANDLE IS PRINTED VERBATIM AND IS NEVER A LINK. `wire.tsx:136` renders the
 * raw `x_handle` with no "@" prepended and no anchor. The owner line with the
 * verified tick (`NameBlock`) is not part of a feed row on the web at all, so it
 * is no longer drawn here — and because the handle is plain text rather than a
 * link, nothing on this row vouches for an association nobody checked.
 *
 * THE REFUSAL CLAUSE IS NOT TRUNCATABLE. "tried to buy" without "— past today's
 * spending cap" invites the reader to blame the agent for a limit they set
 * themselves; ellipsising the tail of this sentence to make rows uniform height
 * would silently return the row to claiming a purchase.
 */
@Composable
private fun BeatSentence(t: Thesis, now: Long, onOpen: () -> Unit) {
  val small = sans(12.sp)
  val refusal = t.outcomeText
    ?.takeIf { t.outcome == "refused" || t.outcome == "reverted" || t.outcome == "dropped" }

  val text = buildAnnotatedString {
    withStyle(
      SpanStyle(
        color = MerryColors.tx,
        fontWeight = FontWeight.W700,
        letterSpacing = (-0.01).em,
      ),
    ) { append(t.handle?.trim()?.takeIf { it.isNotBlank() } ?: t.name ?: "an agent") }
    append(" ")
    // The verb carries the outcome. "tried to buy", never "bought", for a trade
    // the wall turned back.
    append(verbOf(t.action, t.outcome, t.shadow))
    t.symbol?.let {
      append(" ")
      append(it.uppercase(Locale.ROOT))
    }
    if (t.paper) appendInlineContent(PAPER_SLOT, "paper")
    if (refusal != null) {
      append(" ")
      withStyle(SpanStyle(fontFamily = small, fontSize = 12.sp)) { append("— $refusal") }
    }
    append(" ")
    appendInlineContent(GAP_SLOT, " ")
    t.at?.let {
      withStyle(SpanStyle(fontFamily = small, fontSize = 12.sp, color = MerryColors.faint)) {
        append(agoText(it, now))
      }
    }
  }

  Text(
    text = text,
    modifier = Modifier
      .fillMaxWidth()
      .clickable(role = Role.Button, onClick = onOpen)
      // `.wire-hit { padding-top: 3px }` and `.wire-beat .wire-hit
      // { padding-bottom: 4px }` — terminal.css:2846, :2907. The gaps in this
      // column are deliberately unequal, so they are explicit paddings rather
      // than one arrangement value.
      .padding(top = 3.dp, bottom = 4.dp),
    style = TextStyle(
      fontFamily = sans(16.sp),
      fontSize = 16.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 24.sp,
    ),
    color = MerryColors.tx2,
    inlineContent = mapOf(
      // The chip needs a border and a ground, which a SpanStyle cannot give it,
      // so it is inline CONTENT rather than a span. The placeholder is
      // hand-sized: "paper" at 11sp plus 10px of padding, 2px of border and the
      // 6px left margin.
      PAPER_SLOT to InlineTextContent(
        Placeholder(width = 52.sp, height = 18.sp, PlaceholderVerticalAlign.Center),
      ) { PaperChip() },
      // `.wire-when { margin-left: 6px }`, which a text run cannot express.
      GAP_SLOT to InlineTextContent(
        Placeholder(width = 6.sp, height = 1.sp, PlaceholderVerticalAlign.Center),
      ) { Spacer(Modifier.fillMaxSize()) },
    ),
  )
}

/**
 * THE PARTS BOX, and the 2px bar that is the whole visual difference between a
 * trade that moved money and one that did not.
 *
 * `.wire-parts` (terminal.css:2925): `padding: 9px 11px; border-radius: 12px;
 * background: var(--card)`, no border. `.buy` adds `box-shadow: inset 2px 0 0
 * var(--up)`; `.sell` swaps the ground to #14110f and insets `var(--down)`; and
 * `.turned` (terminal.css:7179) — written LATER at equal specificity, which is
 * how it wins — puts the ground back to `--card` and neutralises the bar.
 *
 * Compose has no inset shadow. The bar is drawn BEFORE the background inside the
 * same 12dp clip, so the rounded corners cut it exactly as the CSS inset does; a
 * leading Divider or a left border would square them.
 *
 * WHERE THIS IS DELIBERATELY STRICTER THAN THE WEB. `wire.tsx:115-120` computes
 * `turned` from refused/reverted/dropped only, so a SHADOW row — verb "would
 * buy", nothing ever near an executor — still carries the full green bar beside
 * a real dollar figure, and so does a PENDING one. That is the exact defect the
 * `.turned` rule was written to fix, left unfixed for two arms. This uses
 * [toneOf], the vocabulary Components.kt already states for the whole app: only
 * `landed` earns `--up` or `--down`, and everything else gets the near-invisible
 * `--line` bar. Stated, not silent.
 *
 * A NULL SIZE RENDERS NOTHING AT ALL — not "—", not "$0.00". `wire.tsx:186`
 * guards the element before `money()` can return its dash, so the figures column
 * is simply absent. This is not the em-dash rule being broken: no figure is
 * claimed here at all, which is a third thing again.
 */
@Composable
private fun PartsBox(t: Thesis, onOpen: () -> Unit) {
  val isTrade = t.action == "buy" || t.action == "sell"
  val tone = toneOf(t.action, t.outcome)
  val accent = when {
    !isTrade -> null
    tone == Neutral -> MerryColors.line
    else -> tone
  }
  val ground = if (accent == MerryColors.down) SellGround else MerryColors.card
  val shape = RoundedCornerShape(12.dp)

  Row(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .drawBehind {
        accent?.let { drawRect(it, size = Size(2.dp.toPx(), size.height)) }
      }
      .background(ground)
      .clickable(role = Role.Button, onClick = onOpen)
      .padding(horizontal = 11.dp, vertical = 9.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // `.wire-seat` — a 16px coin then the uppercased symbol at 12px/600 `--tx`.
    Row(
      Modifier.weight(1f),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Avatar(name = t.symbol.orEmpty(), size = 16.dp)
      Text(
        text = t.symbol.orEmpty().uppercase(Locale.ROOT),
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(12.sp, FontWeight.W600),
          fontSize = 12.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
    }
    // `.wire-part-fig` — right-aligned, gap 1px, flex-shrink 0. The 24h delta the
    // web draws under this figure is the TOKEN's move rather than the trade's
    // result, it is not on this payload, and inventing it here would put a green
    // or red number under a refused row. So the column holds the size or nothing.
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
      t.sizeUsdg?.let {
        Text(
          text = moneyText(it),
          maxLines = 1,
          style = TextStyle(
            fontFamily = numerals(FontWeight.W600),
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.tx,
        )
      }
    }
  }
}

/**
 * "MENTIONS", NEVER "REPLYING TO" — `wire.tsx:197-209`, pinned by
 * honesty.test.ts:159-172.
 *
 * One is a fact about the words on this post; the other is an intent the rows do
 * not carry and nobody read. `.wire-mentions` (terminal.css:7230) is 11px in
 * `--faint` with the handles at `--tx-2`.
 *
 * THE UNDERLINE IS THE WRONG COLOUR AND THAT IS SAID RATHER THAN HIDDEN. The
 * sheet draws it in `--line` at a 2px offset (`text-decoration-color`); Compose's
 * `TextDecoration.Underline` always uses the text colour and takes no offset, so
 * these are underlined in `--tx-2`. Drawing it by hand at the baseline is the
 * alternative and was judged not worth the measurement pass.
 */
@Composable
private fun MentionsLine(mentions: List<Mention>, onAgent: (String) -> Unit) {
  Row(
    Modifier.fillMaxWidth().padding(top = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "mentions ",
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
      color = MerryColors.faint,
    )
    mentions.forEachIndexed { i, m ->
      if (i > 0) {
        Text(
          text = ", ",
          style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
          color = MerryColors.faint,
        )
      }
      Text(
        text = "@" + m.handle,
        modifier = Modifier.clickable(role = Role.Button) { onAgent(m.slug) },
        style = TextStyle(
          fontFamily = sans(11.sp),
          fontSize = 11.sp,
          textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline,
        ),
        color = MerryColors.tx2,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// CHAT
// ---------------------------------------------------------------------------

/**
 * CHAT — a fixed-height three-zone column, and only one side is a bubble.
 *
 * `polish.css:156-157`: the chat body is `padding-top: 12px; padding-bottom:
 * calc(92px + safe-area); gap: 10px`, and `.desk-page` itself runs at
 * `gap: 16px`. `terminal.css:3828-3847` makes the conversation the ONLY flexible
 * child, with a 220px floor pinned by desk-scroll.test.ts.
 *
 * THE AGENT SIDE HAS NO BUBBLE AT ALL (`polish.css:168-171`): a 36px face, a
 * 12px gap, the name at 17px/600, then the reply as 16px/1.55 `--tx-2` sitting
 * directly on `--bg`. Only the reader's own message is a raised pill, right
 * aligned, with the tail on the bottom RIGHT. Wrapping either side in a
 * Material Card would be the opposite of the design.
 *
 * WHAT THIS SCREEN DOES NOT HAVE AND WHY. The web's header is the agent's
 * identity — face, name, strategy and a status dot — and this screen fetches no
 * agent, so it carries a 20px label instead of inventing a name or adding a
 * read. The web's three suggestion chips send prepared prompts; adding them
 * would be adding sends, which is out of scope for a restyle. Both are in the
 * hand-off notes.
 */
@Composable
fun ChatScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val turns = remember { mutableStateListOf<ChatTurnWire>() }
  var draft by remember { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  /**
   * THE ONE THING THE AGENT HAS ASKED PERMISSION TO DO.
   *
   * Deliberately NOT part of a turn: turns are a transcript, and a confirmation
   * card restored from one would be an offer to act, made by nobody, about a
   * decision taken minutes ago. It lives as long as it is on screen.
   */
  var pending by remember { mutableStateOf<ChatCommand?>(null) }
  var acting by remember { mutableStateOf(false) }
  var outcome by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(
    Modifier
      .fillMaxSize()
      // The web gets this from the browser; here the composer has to ride the
      // keyboard or it is typed into blind.
      .imePadding()
      .padding(horizontal = PagePadH)
      .padding(top = 12.dp),
  ) {
    // `.desk-header h1` — polish.css:159: 20px, weight 600, tracking -0.02em.
    // Deliberately not the 34px page title: on the web this slot is the agent's
    // NAME, and a 34px "Chat" would be a heading the terminal does not have.
    Text(
      text = "Chat",
      modifier = Modifier.padding(bottom = 16.dp),
      style = TextStyle(
        fontFamily = sans(20.sp, FontWeight.W600),
        fontSize = 20.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.02).em,
      ),
      color = MerryColors.tx,
    )

    LazyColumn(
      modifier = Modifier.weight(1f).heightIn(min = 220.dp),
      contentPadding = PaddingValues(bottom = 8.dp),
    ) {
      itemsIndexed(turns) { i, turn ->
        // `terminal.css:4573` — 30px above each turn; 22px between a question
        // and the reply to it (terminal.css:3473).
        val top = if (i == 0) 0.dp else if (turn.role == "user") 30.dp else 22.dp
        if (turn.role == "user") {
          // AN EMPTY QUESTION DRAWS NO BUBBLE. `followOrder` writes turns with
          // `question: ""` and the web renders the element unconditionally,
          // which floats a 32px empty pill on the right for turns whose whole
          // content is the outcome sentence. Not reproduced.
          if (turn.content.isNotBlank()) UserBubble(turn.content, Modifier.padding(top = top))
        } else {
          AgentReply(turn.content, Modifier.padding(top = top))
        }
      }
    }

    // ---- the dock: in flow, not floating -----------------------------------
    // `terminal.css:3878-3888` un-fixes the base sheet's `position: fixed` for a
    // phone, so this is simply the last row of the column: no elevation, no
    // scrim, no blur.
    outcome?.let {
      Notice("Your agent", it, modifier = Modifier.padding(bottom = 10.dp))
    }
    pending?.let { cmd -> ConfirmCard(
      cmd = cmd,
      acting = acting,
      onDismiss = { pending = null; outcome = null },
    ) { spec, args ->
      acting = true
      scope.launch {
        val (result, path) = runCommand(c.repo, spec, args)
        acting = false
        pending = null
        when (result) {
          is Acted.Ok -> {
            // THE SECOND VALUE IS ONLY A WEB PATH FOR A NAVIGATE COMMAND. For an
            // ORDER or a SNIPE runCommand returns the placed order's ID there,
            // not a path — so navigating on `path != null` sent a confirmed buy
            // off to a WebView instead of showing "placed". Gate the handoff on
            // the command's own kind; the order id is not needed here.
            if (spec.via == Via.NAVIGATE && path != null) nav.navigate(Routes.web(path, spec.id))
            else outcome = result.line.ifBlank { "Done." }
          }
          is Acted.Failed -> outcome = result.line
          is Acted.Ambiguous -> outcome = result.line + " — " + result.candidates.joinToString(", ")
          is Acted.NeedsSignature -> outcome = result.line
        }
      }
    } }

    // A PLAIN LINE, NEVER AN ANIMATION. The reply is not streamed — the web
    // shows one static sentence and swaps it for the whole answer. Dots or a
    // shimmering skeleton would imply tokens are arriving that are not, and
    // would make a 45-second timeout look like progress.
    if (sending) {
      Prose(
        text = "Your agent is thinking…",
        size = 15.sp,
        lineHeight = 20.25.sp,
        color = MerryColors.tx,
        modifier = Modifier.padding(vertical = 15.dp),
      )
    }

    // `.flow-error` — 12px `--down`. The four sentences the send path already
    // distinguishes (a 401, an unconfigured provider, an empty reply, an
    // unreachable server) are untouched; only their rendering changed, from a
    // titled notice at the top of the screen to the web's line above the
    // composer.
    error?.let { FlowError(it, Modifier.padding(vertical = 12.dp)) }

    Composer(
      draft = draft,
      onDraft = { draft = it },
      sending = sending,
      onSend = {
        val msg = draft.trim()
        draft = ""
        sending = true
        error = null
        // HISTORY IS THE CONVERSATION BEFORE THIS MESSAGE. Snapshot it first,
        // then add the turn for display — capturing after the add sent the
        // current message twice (as `message` and as the last history turn),
        // which the model reads as the user repeating themselves.
        val history = turns.toList()
        turns.add(ChatTurnWire("user", msg))
        scope.launch {
          // Give the agent the state its prompt is built around — above all the
          // basket, so it stops guessing that an unread basket is empty. Null on
          // a failed read, which degrades to the no-state path rather than a lie.
          val state = buildChatState(c.repo)
          when (val r = c.api.chat(ChatBody(message = msg, state = state, history = history)).toLoaded()) {
            is Loaded.Value -> {
              // `reply: null` with a `why` is the server declining to speak,
              // not an empty answer. Say which.
              val text = r.value.reply
              if (text.isNullOrBlank()) {
                error = listOfNotNull(r.value.why, r.value.detail).joinToString(" — ")
                  .ifBlank { "no reply" }
              } else {
                turns.add(ChatTurnWire("assistant", text))
              }
              // THE PROPOSAL, WHICH THIS CLIENT USED TO PARSE AND DISCARD.
              pending = r.value.command
              outcome = null
            }
            is Loaded.Refused -> error = r.message
            is Loaded.Unreachable -> error = "couldn't reach merrymen: " + r.cause
            else -> Unit
          }
          sending = false
        }
      },
    )
    BottomInsetSpacer()
  }
}

/**
 * THE READER'S OWN MESSAGE — `.desk-question`, terminal.css:3764-3768 and 4500.
 *
 * Right aligned, `width: fit-content`, `max-width: 88%`, ground `--raised`, no
 * border, radii 16 / 16 / 4 / 16 — the tail is on the bottom RIGHT — with
 * `padding: 12px 16px` and text at 14px/1.5 in full `--tx`.
 *
 * NOTE THE ASYMMETRY WITH THE REPLY: the question stays 14px while polish.css
 * raises the agent's answer to 16px. That is not a mistake to normalise; the
 * thing worth reading is the reply.
 */
@Composable
private fun UserBubble(text: String, modifier: Modifier = Modifier) {
  BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
    val cap = maxWidth * 0.88f
    Box(
      Modifier
        .widthIn(max = cap)
        .clip(
          RoundedCornerShape(
            topStart = 16.dp,
            topEnd = 16.dp,
            bottomEnd = 4.dp,
            bottomStart = 16.dp,
          ),
        )
        .background(MerryColors.raised)
        .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
      Text(
        text = text,
        style = TextStyle(
          fontFamily = sans(14.sp),
          fontSize = 14.sp,
          fontWeight = FontWeight.W400,
          lineHeight = 21.sp,
        ),
        color = MerryColors.tx,
      )
    }
  }
}

/**
 * THE AGENT'S ANSWER — a face, a name and prose on the page ground.
 *
 * `polish.css:168-171`: the row is a flex row with a 36px face and a 12px gap
 * (the `grid-template-columns` declaration on the same selector is INERT,
 * because `display` is still `flex` from terminal.css:3466 and polish never
 * changes it). The name is 17px/600 `--tx`; the paragraph is 16px/1.55 `--tx-2`.
 *
 * A QUIRK KEPT ON PURPOSE: the web's reply avatars inherit `.face.sm`'s 7px
 * initials into a 36px circle, because polish.css:169 overrides only the box.
 * That is almost certainly unintended and it is illegible, so [Avatar]'s own
 * ratio is used instead — an explicit departure, not an oversight.
 */
@Composable
private fun AgentReply(text: String, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Avatar(name = "Your agent", size = 36.dp)
    Column(Modifier.weight(1f)) {
      Text(
        text = "Your agent",
        style = TextStyle(
          fontFamily = sans(17.sp, FontWeight.W600),
          fontSize = 17.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
      Prose(
        text = text,
        size = 16.sp,
        lineHeight = 24.8.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 4.dp),
      )
    }
  }
}

/**
 * THE COMPOSER — `polish.css:174-176` over terminal.css:3780-3796, 4506-4535.
 *
 * A rounded field: `min-height: 58px; border: 1px solid var(--line);
 * border-radius: 16px; padding: 10px 12px; background: var(--card)`, contents
 * BOTTOM aligned with a 10px gap, the field at 16px/1.5 and the button 40x40 at
 * radius 10.
 *
 * THE SEND BUTTON IS NOT LIME. It is `--tx` (near-white) on `--ink`, and
 * disabled it is `--raised` with a `--faint` glyph (terminal.css:3481 beats
 * 3789 on specificity, so a blank draft shows a dark grey square rather than a
 * white one). Lime on this screen is reserved for the two controls that
 * AUTHORISE something — the confirm card's YES and the blocker's re-sign. A
 * harmonised accent-coloured send button would make sending a message look like
 * confirming an action.
 *
 * THERE IS EFFECTIVELY NO FOCUS HIGHLIGHT either: terminal.css:4531-4537 puts the
 * border back to `--line` on `:focus-within`, overriding the lime at 3478. So
 * nothing changes colour here when the field is focused.
 */
@Composable
private fun Composer(
  draft: String,
  onDraft: (String) -> Unit,
  sending: Boolean,
  onSend: () -> Unit,
) {
  val shape = RoundedCornerShape(16.dp)
  val enabled = draft.isNotBlank() && !sending
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 58.dp)
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.Bottom,
  ) {
    Box(Modifier.weight(1f).heightIn(min = 38.dp, max = 120.dp), contentAlignment = Alignment.CenterStart) {
      if (draft.isEmpty()) {
        // COULD NOT BE MATCHED: there is no `::placeholder` rule in any loaded
        // sheet, so the web takes the browser's dark-scheme default (roughly the
        // text colour at 54%). `--faint` is the house-consistent choice and is a
        // decision rather than a match.
        Prose(
          text = "Message your agent…",
          size = 16.sp,
          lineHeight = 24.sp,
          color = MerryColors.faint,
          modifier = Modifier.padding(8.dp),
        )
      }
      BasicTextField(
        value = draft,
        onValueChange = onDraft,
        modifier = Modifier
          .fillMaxWidth()
          .padding(8.dp)
          .semantics { contentDescription = "Message your agent" },
        textStyle = TextStyle(
          fontFamily = sans(16.sp),
          fontSize = 16.sp,
          lineHeight = 24.sp,
          color = MerryColors.tx,
        ),
        cursorBrush = SolidColor(MerryColors.tx),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (enabled) onSend() }),
      )
    }
    Box(
      Modifier
        .size(40.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(if (enabled) MerryColors.tx else MerryColors.raised)
        .clickable(enabled = enabled, role = Role.Button, onClick = onSend)
        .semantics { contentDescription = "Send message" },
      contentAlignment = Alignment.Center,
    ) {
      ArrowUp(if (enabled) MerryColors.ink else MerryColors.faint)
    }
  }
}

/**
 * THE CONFIRMATION CARD — the human tap that is the whole security boundary.
 *
 * The model may PROPOSE; only this button acts. That asymmetry is why the chat
 * can be given a command vocabulary at all, and it is why nothing here runs
 * automatically, however confident the reply sounded.
 *
 * AN UNKNOWN ID IS SHOWN AND REFUSED, NOT HIDDEN. A newer server can propose a
 * command this build has never heard of; rendering nothing would make the agent
 * look like it had done something, and guessing at it would be acting on
 * something nobody reviewed. So it is named, and the button says no. THE WEB
 * DISAGREES HERE AND ANDROID IS RIGHT — `Agent.tsx:835` renders nothing at all
 * for an id it cannot describe, and a proposal that vanishes silently reads as
 * an action already taken. Kept, and dressed as the spec asks: ordinary
 * (non-weighty) chrome, the refusal line at 12px in `--down`, the YES disabled.
 *
 * THE SENTENCE COMES FROM THE LOCAL REGISTRY AND NEVER FROM THE WIRE. Model-
 * written text could describe one action and request another; `COMMANDS[id].say`
 * is the difference between a confirmation and a remote-execution hole.
 *
 * THE CARD IS GREEN-FAMILY, NOT RED — terminal.css:7509-7524: radius 16px,
 * `padding: 12px 14px`, border 1px lime at 45% alpha, ground lime at 8%. It is
 * an OFFER, not an alarm. `.is-weighty` (terminal.css:7526) changes exactly two
 * things: the border goes to 75% and an INSET 3px lime bar is drawn down the
 * left inside the rounded clip. `color-mix(in srgb, X n%, transparent)` is
 * exactly `Color.copy(alpha = n/100)` because the ground behind it is opaque.
 *
 * NO TITLE. The web card has no heading at all — the previous "Your agent wants
 * to" line was this client's own addition and it is gone.
 *
 * DECLINING IS NOT THE SMALLER TARGET. terminal.css:7557 states it: "Declining
 * is not a lesser button, it is the safe one — same size, same reach, so it is
 * never the harder thing to hit." Both buttons are the same pill, the same
 * padding and the same type; only the fill differs.
 */
@Composable
private fun ConfirmCard(
  cmd: ChatCommand,
  acting: Boolean,
  onDismiss: () -> Unit,
  onConfirm: (CommandSpec, Map<String, String>) -> Unit,
) {
  val args = cmd.argText()
  val known = COMMANDS[cmd.id]
  val spec = known ?: CommandSpec(cmd.id, Via.UNKNOWN) { "" }
  val weighty = known?.weighty == true
  val shape = RoundedCornerShape(16.dp)

  Column(
    Modifier
      .fillMaxWidth()
      .padding(bottom = 10.dp)
      .clip(shape)
      .background(MerryColors.lime.copy(alpha = 0.08f))
      .drawBehind {
        // `box-shadow: inset 3px 0 0 var(--lime)` — Compose has no inset shadow,
        // so the bar is drawn inside the clip where the CSS puts it.
        if (weighty) drawRect(MerryColors.lime, size = Size(3.dp.toPx(), size.height))
      }
      .border(1.dp, MerryColors.lime.copy(alpha = if (weighty) 0.75f else 0.45f), shape)
      .padding(horizontal = 14.dp, vertical = 12.dp)
      .semantics(mergeDescendants = true) { contentDescription = "Confirm this action" },
  ) {
    // `.desk-confirm-say` — 13.5px, line-height 1.6, full `--tx`. Compose takes
    // fractional sp; do not round it to 14.
    Text(
      text = known?.say?.invoke(args)
        // The honest fallback: name the id and its arguments rather than
        // inventing a sentence for something we do not model.
        ?: "run \"${cmd.id}\"" + if (args.isEmpty()) "" else " with " +
          args.entries.joinToString(", ") { "${it.key}=${it.value}" },
      style = TextStyle(
        fontFamily = sans(13.5.sp),
        fontSize = 13.5.sp,
        fontWeight = FontWeight.W400,
        lineHeight = 21.6.sp,
      ),
      color = MerryColors.tx,
    )
    if (known == null) {
      FlowError(
        text = "This version of the app doesn't know that command, so it won't run it.",
        modifier = Modifier.padding(top = 6.dp),
      )
    }
    Row(
      Modifier.padding(top = 11.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      ConfirmPill(
        label = if (acting) "Doing it…" else if (spec.via == Via.NAVIGATE) "Take me there" else "Yes, do it",
        enabled = known != null && !acting,
        ground = MerryColors.lime,
        ink = MerryColors.ink,
        border = null,
        onClick = { onConfirm(spec, args) },
      )
      // DECLINING IS NOT AN ERROR. It clears the offer and says nothing else: an
      // owner who says no has not hit a failure and must not be shown one.
      ConfirmPill(
        label = "Not now",
        enabled = !acting,
        ground = Color.Transparent,
        ink = MerryColors.tx,
        border = MerryColors.line,
        onClick = onDismiss,
      )
    }
  }
}

/**
 * `.desk-confirm-row button` — terminal.css:7545-7563: radius 999px,
 * `padding: 8px 15px`, 13px/600. Disabled is `opacity: .55` and NOTHING ELSE —
 * the terminal never expresses disabled with a colour, and there is no spinner
 * anywhere on this card.
 */
@Composable
private fun ConfirmPill(
  label: String,
  enabled: Boolean,
  ground: Color,
  ink: Color,
  border: Color?,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier
      .alpha(if (enabled) 1f else 0.55f)
      .clip(shape)
      .background(ground)
      .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
      .padding(horizontal = 15.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
      ),
      color = ink,
    )
  }
}

// ---------------------------------------------------------------------------
// ALPHA
// ---------------------------------------------------------------------------

/** The payload's own field readers. JsonNull answers `null` to all four. */
private fun JsonObject.str(k: String): String? =
  (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.num(k: String): Double? =
  (this[k] as? JsonPrimitive)?.content?.toDoubleOrNull()

private fun JsonObject.int(k: String): Int? = num(k)?.let { if (it.isFinite()) it.toInt() else null }

private fun JsonObject.flag(k: String): Boolean? =
  (this[k] as? JsonPrimitive)?.content?.toBooleanStrictOrNull()

/** How many the scout looked at and passed. A count when locked, a list when not. */
private fun passedCount(passed: JsonElement?): Int = when (passed) {
  is JsonArray -> passed.size
  is JsonPrimitive -> passed.content.toIntOrNull() ?: 0
  else -> 0
}

/**
 * ALPHA — an ungapped column, and one of two completely different bodies.
 *
 * `polish.css:148` sets `.alpha-page { gap: 0 }`, overriding both `.page`'s 22px
 * and the base 18px — so every separation on this screen comes from an element's
 * own margin. They are reproduced as explicit paddings rather than as one
 * arrangement value, which would flatten the 18px standfirst margin, the 24px
 * under the gate and the 14px between teaser rows into a single number.
 *
 * NOTHING IN THIS AREA HAS A `min-width: 1100px` RULE, so the phone rendering IS
 * the whole Alpha design.
 *
 * THE TIER BADGE IS NOT DRAWN. `.alpha-tier` renders `{emoji} {name}` beside the
 * title, but only for an OPEN Alpha in hosted mode — and this client's
 * `AlphaView` carries no tier at all. An absent badge on an open Alpha means
 * self-hosted, never "Traveller" and never "unknown tier", so the slot is left
 * empty rather than filled with a guess.
 */
@Composable
fun AlphaScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<dev.merrymen.app.net.AlphaView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.alpha().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      // `.body:has(> .alpha-page) { padding-top: 20px }` — polish.css:180.
      .padding(top = 20.dp),
  ) {
    // `.board-head` — a space-between row; with one child, a left-aligned title.
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) { PageTitle("Alpha") }

    // `.alpha-page > .alpha-intro` — polish.css:145: 17px/1.5 `--tx-2`,
    // `margin: 0 0 18px`. (polish.css:31's 21px is the non-mobile instance.)
    Prose(
      text = "The research behind the trade.",
      size = 17.sp,
      lineHeight = 25.5.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(top = 8.dp, bottom = 18.dp),
    )

    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { a ->
      if (a.locked) {
        // THE BODY IS NOT HERE TO HIDE. The server omits `picks` entirely when
        // locked; there is nothing to blur, which is the point.
        AlphaGate(a, nav)
        InsideAlpha(picks = a.pickCount, passed = passedCount(a.passed))
      } else if (a.pickRows.isEmpty()) {
        // AN OUTAGE IS NOT A QUIET DAY. When the index could not be read the
        // route sends an empty list WITH indexUnreachable — the same empty
        // shape as "considered everything and passed", but a different fact.
        // Saying "nothing cleared the screen" for our own failed read states
        // something about the market we did not learn.
        if (a.indexUnreachable) {
          Notice(
            title = "Couldn't read the desk just now",
            body = "That's our data feed failing, not a quiet market. It should clear on its own.",
          )
        } else {
          Empty(
            "Nothing vetted yet",
            "Nothing has cleared the screen recently. That is not the same as nothing looking good.",
          )
        }
      } else {
        AlphaKept(a, nav)
      }
    }
    BottomInsetSpacer()
  }
}

/**
 * THE LOCKED GATE — `polish.css:149-155`.
 *
 * `padding: 24px 18px; margin: 0 0 24px; gap: 14px; border: 1px solid
 * var(--line); border-radius: 18px`, centred both ways — and explicitly NO
 * background fill, so `--bg` shows through. Filling it with `--card` would turn
 * the one transparent panel in the product into another card.
 *
 * The padlock and the CTA are `#38dda0` on `#07150e` (polish.css:150, :153).
 * That green is close enough to `--up` to be mistaken for the money-up colour at
 * a glance, so it is kept strictly to those two things and never touches a
 * figure or a chip.
 *
 * WHY THE THREE ARMS ARE NOT ONE. `sign-in`, `balance` and `unreachable` are
 * three different facts with three different remedies, and on the web they
 * differ by a single 15px sentence in the same colour and size as the sentence
 * above it — almost no visual weight for the distinction that matters most here.
 * So the `unreachable` sentence gets the `.hosted-note` treatment: the house
 * vocabulary for "this page rendered, and here is the part of it that did not".
 * It is deliberately NOT the amber locked panel, which in this codebase means
 * "you chose something you cannot use yet" — the balance case, not ours.
 *
 * THE CTA'S LABEL AND DESTINATION ARE THIS CLIENT'S, UNCHANGED. The web's second
 * arm reads "Verify wallet holdings" and re-fetches `/api/alpha`; this one says
 * "See the Circle" and opens the Circle screen. Changing the action was out of
 * scope for a restyle, so the label that describes it stayed with it.
 */
@Composable
private fun AlphaGate(a: dev.merrymen.app.net.AlphaView, nav: NavHostController) {
  val shape = RoundedCornerShape(18.dp)
  val symbol = a.symbol ?: "MERRYMEN"
  Column(
    Modifier
      .fillMaxWidth()
      .padding(bottom = 24.dp)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 18.dp, vertical = 24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    LockKeyholeGlyph(TabGreen)
    Text(
      text = "An edge for holders.",
      textAlign = TextAlign.Center,
      style = TextStyle(
        fontFamily = sans(22.sp, FontWeight.W700),
        fontSize = 22.sp,
        fontWeight = FontWeight.W700,
        lineHeight = 26.4.sp,
      ),
      color = MerryColors.tx,
    )
    Prose(
      text = when (a.why) {
        "sign-in" -> "Sign in to see whether your wallet qualifies."
        // The BARE symbol, from the payload. The gate's copy differs from the
        // Circle banner's, which does carry the $ prefix.
        else -> "Hold $symbol in your signed-in wallet to unlock Alpha." +
          // Dead today: the locked payload carries no holdings figure at all, by
          // design, so the gate can never say "you hold X". Kept null-safe
          // rather than deleted, and never filled in from /api/tier.
          (a.tokens?.let { " You hold $it." } ?: "")
      },
      size = 15.sp,
      lineHeight = 22.5.sp,
      color = MerryColors.tx2,
      align = TextAlign.Center,
    )

    // `.alpha-threshold` — polish.css:77-79 and :155: `margin: 4px 0 8px;
    // gap: 5px`, the figure at 44px with `letter-spacing: -.04em`, the symbol at
    // 14px `--tx-2`. The only tier number anywhere on this screen.
    a.needTokens?.let { need ->
      Column(
        Modifier.padding(top = 4.dp, bottom = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(5.dp),
      ) {
        Text(
          text = groupedInt(need),
          maxLines = 1,
          style = TextStyle(
            fontFamily = numerals(FontWeight.W400),
            fontSize = 44.sp,
            lineHeight = 48.4.sp,
            letterSpacing = (-0.04).em,
          ),
          color = MerryColors.tx,
        )
        Prose(symbol, 14.sp, 18.9.sp, MerryColors.tx2)
      }
    }

    if (a.why == "unreachable") {
      HostedNote("Couldn't verify your holdings — that's our read failing, not your wallet.")
    }

    FlowPrimary(
      label = if (a.why == "sign-in") "Sign in" else "See the Circle",
      onClick = {
        if (a.why == "sign-in") nav.navigate(Routes.SIGN_IN) else nav.navigate(Routes.CIRCLE)
      },
      ground = TabGreen,
      ink = GateInk,
      minHeight = 50.dp,
      size = 15.sp,
    )
  }
}

/**
 * "Inside Alpha" — the teaser under the gate. `Alpha.tsx:118-130`, polish.css:80-84.
 *
 * THE COUNTS LINE RENDERS ONLY WHEN picks + passed IS ABOVE ZERO
 * (`Alpha.tsx:127`). "0 vetted · 0 looked at and passed" would advertise an
 * empty desk to somebody being asked for a hundred thousand tokens, which is
 * exactly what that guard exists to prevent.
 *
 * The bold numerals inherit `--tx-2` rather than `--tx`, because the rule that
 * would brighten them (`.alpha-count b`, terminal.css:6964) does not match the
 * class the TSX actually writes (`alpha-counts`). Matched to the live web and
 * flagged rather than silently "fixed" — the two clients have to agree.
 */
@Composable
private fun InsideAlpha(picks: Int, passed: Int) {
  Column(Modifier.fillMaxWidth()) {
    SectionHeading("Inside Alpha", Modifier.padding(bottom = 14.dp))

    if (picks + passed > 0) {
      // `.alpha-inside > p` — border-top 1px `--line`, padding-top 16px,
      // margin-top 20px. Because the counts line precedes the list in DOM order,
      // that hairline sits BETWEEN the heading and this line.
      Box(
        Modifier
          .fillMaxWidth()
          .padding(top = 20.dp)
          .drawBehind { drawRect(MerryColors.line, size = Size(size.width, 1.dp.toPx())) }
          .padding(top = 16.dp, bottom = 20.dp),
      ) {
        Text(
          text = buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.W700)) { append(picks.toString()) }
            append(" vetted · ")
            withStyle(SpanStyle(fontWeight = FontWeight.W700)) { append(passed.toString()) }
            append(" looked at and passed")
          },
          style = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp, lineHeight = 19.5.sp),
          color = MerryColors.tx2,
        )
      }
    }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
      InsideRow(InsideIcons.activity, "Tokens our agents researched")
      InsideRow(InsideIcons.fileText, "Short takes with the reasoning attached")
      // The em dash carries no spaces around it — the sheet's copy, verbatim.
      InsideRow(InsideIcons.externalLink, "What our agents kept—and passed on")
    }
  }
}

@Composable
private fun InsideRow(paths: Array<String>, label: String) {
  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    StrokeGlyph(*paths, tint = MerryColors.tx2, size = 22.dp)
    Prose(label, 15.sp, 22.5.sp, MerryColors.tx)
  }
}

/**
 * THE OPEN DESK — "Kept", the rows, then what was looked at and passed.
 *
 * `.strip > h3` (terminal.css:2581): 13px/600 `--tx` with the count beside it at
 * 12px/400 `--faint`. `.alpha-list` is a flex column at `gap: 10px`, and its
 * ORDER IS MEANINGFUL — it is the route's own ranking, so it is preserved.
 *
 * WHAT CHANGED HERE BESIDES THE STYLING. This screen used to render each pick as
 * `SectionCard { Text(pick.toString()) }`, i.e. a raw `JsonElement` printed into
 * a card. The fields are now read by name and drawn as the sheet draws them. No
 * extra request is made and nothing is derived: a field the payload does not
 * carry simply does not render, which is the same answer the web gives.
 */
@Composable
private fun AlphaKept(a: dev.merrymen.app.net.AlphaView, nav: NavHostController) {
  val passed = (a.passed as? JsonArray)?.toList() ?: emptyList()
  var open by remember { mutableStateOf(false) }

  Column(Modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(bottom = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Text(
        text = "Kept",
        modifier = Modifier.alignByBaseline(),
        style = TextStyle(
          fontFamily = sans(13.sp, FontWeight.W600),
          fontSize = 13.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
      Text(
        text = a.pickRows.size.toString(),
        modifier = Modifier.alignByBaseline(),
        style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp),
        color = MerryColors.faint,
      )
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      a.pickRows.forEach { AlphaRow(it, passed = false, nav = nav) }
    }

    if (passed.isNotEmpty()) {
      // A native `details`, which Compose has none of. The web shows the
      // BROWSER's own disclosure triangle here — no marker suppression exists
      // for this selector — so a small filled caret is drawn rather than
      // borrowing Material's ExpandMore, which is visibly heavier.
      Row(
        Modifier
          .fillMaxWidth()
          .clickable(role = Role.Button) { open = !open }
          .padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Caret(open, MerryColors.tx2)
        Prose("Looked at and passed", 13.sp, 19.5.sp, MerryColors.tx2)
        Text(
          text = passed.size.toString(),
          style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 13.sp),
          color = MerryColors.faint,
        )
      }
      if (open) {
        Column(
          Modifier.padding(top = 10.dp),
          verticalArrangement = Arrangement.spacedBy(10.dp),
        ) { passed.forEach { AlphaRow(it, passed = true, nav = nav) } }
      }
    }
  }
}

/** An 11dp filled triangle standing in for a platform disclosure marker. */
@Composable
private fun Caret(open: Boolean, tint: Color) {
  Canvas(Modifier.size(11.dp)) {
    val w = size.width
    val h = size.height
    val p = androidx.compose.ui.graphics.Path().apply {
      if (open) {
        moveTo(0f, h * 0.25f); lineTo(w, h * 0.25f); lineTo(w / 2f, h * 0.8f)
      } else {
        moveTo(w * 0.25f, 0f); lineTo(w * 0.8f, h / 2f); lineTo(w * 0.25f, h)
      }
      close()
    }
    drawPath(p, tint)
  }
}

/**
 * ONE COIN THE SCOUT LOOKED AT — `.alpha-row`, terminal.css:6999-7016.
 *
 * `padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px;
 * background: var(--card)`, and a PASSED row is identical except that the ground
 * goes transparent. The sheet's own comment: "Passed coins are still fully
 * legible — dimmed, never hidden."
 *
 * DO NOT IMPLEMENT PASSED AS `Modifier.alpha(0.5f)`. A blanket fade would also
 * dim the "—" placeholders, the "pre-grad" string and the chips, which are
 * exactly the distinctions those rows exist to preserve — the point of this half
 * of the page is that somebody can disagree with the scout.
 *
 * THE TAP IS ON THE HEADER ROW ONLY (terminal.css:7018-7031), never on the whole
 * card: nesting the figures inside one button swallows their text into its
 * accessible name.
 */
@Composable
private fun AlphaRow(el: JsonElement, passed: Boolean, nav: NavHostController) {
  val o = el as? JsonObject ?: return
  val shape = RoundedCornerShape(12.dp)
  val token = o.str("token")
  val onCurve = o.flag("onCurve") == true
  val graduated = o.flag("graduated") == true
  val chg = o.num("change24hPct")
  val verdict = o["verdict"] as? JsonObject

  Column(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(if (passed) Color.Transparent else MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 14.dp, vertical = 12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Row(
      Modifier
        .fillMaxWidth()
        .then(
          if (token != null) {
            Modifier.clickable(role = Role.Button) { nav.navigate(Routes.token(token)) }
          } else {
            Modifier
          },
        ),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Row(
        Modifier.weight(1f),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = o.str("name") ?: o.str("symbol") ?: token ?: "unnamed",
          style = TextStyle(
            fontFamily = sans(14.sp, FontWeight.W600),
            fontSize = 14.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.tx,
        )
        // TWO DIFFERENT NOES, and the curve one comes first. A coin on its
        // launch curve has no pool at all, so "add it to a grant" is advice that
        // cannot work — the owner would pay for a re-sign and still not be able
        // to touch it.
        if (onCurve) AlphaChip("on its curve", MerryColors.faint, MerryColors.line)
        if (graduated) AlphaChip("graduated", MerryColors.up, MerryColors.up.copy(alpha = 0.4f))
      }
      // A NULL CHANGE IS GREY, NOT GREEN. `Alpha.tsx:202` computes
      // `(change ?? 0) >= 0` and paints `--up` even while the text reads "—";
      // live.ts:283-298 exists to stop exactly that and says why: the screen
      // said "we don't know" in words and "it went up" in colour, and colour is
      // what a reader takes in first. Green is a claim. The flat branch is used
      // here and the web bug is reported rather than replicated.
      Text(
        text = if (chg == null || !chg.isFinite()) {
          "—"
        } else {
          (if (chg >= 0) "+" else "") + String.format(Locale.US, "%.1f", chg) + "%"
        },
        maxLines = 1,
        style = TextStyle(
          fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
          fontSize = 13.sp,
        ),
        color = when {
          chg == null || !chg.isFinite() -> MerryColors.faint
          chg < 0 -> MerryColors.down
          else -> MerryColors.up
        },
      )
    }

    // A MISSING VERDICT MEANS NOBODY FORMED ONE — never that the coin failed
    // something. No placeholder, no zero pips, no empty five-slot track.
    if (verdict != null) {
      val reason = verdict.str("reason")
      val conviction = (verdict.int("conviction") ?: 1).coerceIn(1, 5)
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
          Modifier
            .padding(top = 4.dp)
            .semantics { contentDescription = "conviction $conviction of 5" },
          horizontalArrangement = Arrangement.spacedBy(1.dp),
        ) {
          // MARKS, NOT A SCORE OUT OF FIVE — terminal.css:7085: "a rating is a
          // claim this is not making", so there is no track and no unfilled
          // remainder. Drawn rather than typed: the sheet's glyph is U+25AE, DM
          // Sans has no such character, and Android renders visible tofu where a
          // browser silently falls back to a system face.
          repeat(conviction) {
            Box(Modifier.size(width = 3.dp, height = 10.dp).background(MerryColors.lime))
          }
        }
        if (reason != null) Prose(reason, 13.sp, 20.15.sp, MerryColors.tx2)
      }
    }

    // `.alpha-figs` — five spans in a fixed order, labels in `--faint`, values in
    // `--tx-2`, all tabular. Wrapped by hand into two rows so this file does not
    // take a dependency on the experimental FlowRow.
    val depth = if (onCurve) {
      // A CURVE'S RESERVE IS MOSTLY A VIRTUAL SEED IT DOES NOT HOLD — about
      // $4,100 of it — so a dollar figure here would be a false claim about
      // sellable depth. The literal string, always.
      "pre-grad"
    } else {
      compactUsd(o.num("reserveUsd"))
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Fig("px", coinPrice(o.num("priceUsd")))
        // FDV, AND IT SAYS FDV. The index substitutes fully-diluted value
        // whenever circulating supply is unknown, and calling that "market cap"
        // makes every young coin look bigger and safer than it is.
        Fig("fdv", compactUsd(o.num("fdvUsd")))
        Fig("depth", depth)
      }
      Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Fig("24h", compactUsd(o.num("volume24hUsd")))
        Fig("buyers", o.int("buyers24h")?.toString() ?: "—")
      }
    }

    ResearchLine(o["research"] as? JsonObject)
  }
}

/** `.alpha-chip` — 11px, `padding: 1px 7px`, radius 999px, a 1px border. */
@Composable
private fun AlphaChip(text: String, ink: Color, edge: Color) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier.clip(shape).border(1.dp, edge, shape).padding(horizontal = 7.dp, vertical = 1.dp),
  ) {
    Text(
      text = text,
      maxLines = 1,
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
      color = ink,
    )
  }
}

/** One `label value` pair on the figures line: the label 5px from its value. */
@Composable
private fun Fig(label: String, value: String) {
  Row(verticalAlignment = Alignment.CenterVertically) {
    Text(
      text = label,
      modifier = Modifier.padding(end = 5.dp),
      style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
      color = MerryColors.faint,
    )
    Text(
      text = value,
      maxLines = 1,
      style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp),
      color = MerryColors.tx2,
    )
  }
}

/**
 * The site read, as facts rather than prose — `Alpha.tsx:271-284`.
 *
 * Never the launcher's own words: those are an instruction channel, which is why
 * the scout is fed counts and booleans and never the page text.
 *
 * NULLS ARE SKIPPED, NEVER DASHED. "We did not visit" is already said once for
 * the page, and repeating it per coin turns an absence into an accusation — so
 * this is the one line on the screen the general "null renders —" rule does not
 * reach. With no parts at all, nothing renders.
 */
@Composable
private fun ResearchLine(f: JsonObject?) {
  if (f == null) return
  val parts = ArrayList<String>()
  if (f.flag("publishedNothing") == true) parts.add("published nothing")
  if (f.flag("siteReachable") == false) parts.add("site down")
  if (f.flag("siteReachable") == true) {
    parts.add("site up")
    when (f.flag("siteNamesContract")) {
      true -> parts.add("names the contract")
      false -> parts.add("never names the contract")
      else -> Unit
    }
    f.int("siteHypeWords")?.let { parts.add("$it hype words") }
    f.int("siteOutboundDomains")?.let { parts.add("$it outbound") }
  }
  if (parts.isEmpty()) return
  Text(
    text = parts.joinToString(" · "),
    style = TextStyle(
      fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
      fontSize = 11.sp,
    ),
    color = MerryColors.faint,
  )
}

// ---------------------------------------------------------------------------
// PROFILE / YOU
// ---------------------------------------------------------------------------

/**
 * YOU — a flat, borderless page with exactly one card on it.
 *
 * `polish.css:122`: `.account-page { display: flex; flex-direction: column;
 * gap: 24px; padding: 0 }`, and `polish.css:133` strips the border, padding and
 * margin off every `.account-section`. Whitespace is the ONLY divider.
 *
 * ONE ELEMENT ON THIS SCREEN IS A CARD — the agent row (`polish.css:136`) — plus
 * the grouped account rows, which are one card built out of several. The balance
 * block, the sections and the header are backgroundless and borderless; the base
 * sheet's rules that boxed them are flattened to `border-radius: 0` by later
 * unconditional rules. Material's Card and Button will silently box all of it,
 * which changes what reads as "a thing the system knows" versus "a page of
 * prose", so nothing here uses them.
 *
 * THE TITLE STAYS "You". `You.tsx:50` says "Profile", but the tab this screen
 * sits on is labelled "You" in Shell.kt and Shell is out of scope for this pass;
 * a page heading that disagreed with the tab that opened it would be worse than
 * the mismatch with the web. Noted in the hand-off.
 */
@Composable
fun ProfileScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val identityKnown by c.repo.identityKnown.collectAsState()
  var feed by remember { mutableStateOf<Loaded<Feed>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { feed = c.api.feed().toLoaded() }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      // `.body:has(> .account-page) { padding-top: 20px }` — polish.css:180.
      .padding(top = 20.dp),
    verticalArrangement = Arrangement.spacedBy(24.dp),
  ) {
    PageTitle("You")

    // ONLY WHEN WE KNOW YOU ARE SIGNED OUT. While the gate is shut, identity is
    // unknown (the session route 401s "gated" like everything else), and a
    // "Sign in" banner would send the reader to a web sign-in behind the same
    // closed door. When identity is unknown the feed's own LoadedBlock below
    // shows the gate notice with "Open settings" instead.
    if (identityKnown && signedIn == null) {
      Notice(
        title = "Not signed in",
        body = "Signing in proves you control your owner key. It moves no funds and grants no permissions.",
        actionLabel = "Sign in",
        onAction = { nav.navigate(Routes.SIGN_IN) },
      )
    }

    LoadedBlock(feed) { f ->
      AccountPerson(f)
      AccountBalance(f, nav)
      YourAgent(f, nav)
    }

    // The three controls that belong to the agent rather than to the account.
    Column(Modifier.fillMaxWidth()) {
      AccountHeading("Controls")
      AccountGroup {
        AccountRow("Trade", first = true) { nav.navigate(Routes.TRADE) }
        AccountRow("Coins to consider") { nav.navigate(Routes.PROPOSALS) }
        AccountRow("How much risk?") { nav.navigate(Routes.RISK) }
      }
    }

    Column(Modifier.fillMaxWidth()) {
      AccountHeading("Account")
      AccountGroup {
        AccountRow("Trading limits", first = true) {
          nav.navigate(Routes.web("/limits", "Trading limits"))
        }
        AccountRow("Wallet & permissions") {
          nav.navigate(Routes.web("/grant", "Wallet & permissions"))
        }
        AccountRow("Settings") { nav.navigate(Routes.SETTINGS) }
        AccountRow("Telegram") { nav.navigate(Routes.TELEGRAM) }
        AccountRow("The Merry Circle") { nav.navigate(Routes.CIRCLE) }
        AccountRow("Create an agent") {
          nav.navigate(Routes.web("/create", "Create an agent"))
        }
      }
      // EVERY ONE OF THE SIGNATURE-BEARING ROWS ENDS IN A CEREMONY, so every one
      // of them is a handoff to the web app rather than a native
      // reimplementation of key custody. The web gives these rows no warning
      // styling at all and neither do these; the sentence carries it instead.
      Prose(
        text = "Trading limits, wallet permissions and creating an agent need your owner key, " +
          "so they open the merrymen web app inside this one. This app never holds a key.",
        size = 13.sp,
        lineHeight = 19.5.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 12.dp),
      )
    }

    if (signedIn != null) {
      // THE KILL SWITCH, WHICH WAS DECLARED AND NEVER WIRED. revokeGrant()
      // (DELETE /api/grants) stands the worker down, and nothing in the app
      // reached it — a stop control you cannot find is not a stop control. It
      // arms then confirms, the way KillSwitch.tsx does, because a single tap on
      // "stop everything" is too easy to hit by accident. It is DESTRUCTIVE in
      // the true sense (`--down`, not the softer sign-out red): re-arming the
      // agent afterwards needs a fresh signature, which is a web handoff.
      var armed by remember { mutableStateOf(false) }
      var stopNote by remember { mutableStateOf<String?>(null) }
      Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Box(
          Modifier
            .heightIn(min = 44.dp)
            .clickable(role = Role.Button) {
              if (!armed) {
                armed = true
                stopNote = "Tap again to stop it. This revokes its trading permission until you re-sign."
              } else {
                armed = false
                scope.launch {
                  stopNote = when (val r = c.api.revokeGrant()) {
                    is dev.merrymen.app.net.ApiResult.Ok ->
                      "Stopped. Your agent will not trade again until you re-sign its permission."
                    is dev.merrymen.app.net.ApiResult.Refused ->
                      if (r.status == 401) "Sign in first." else r.message
                    is dev.merrymen.app.net.ApiResult.Unreachable ->
                      "Couldn't reach merrymen to stop it. " + r.cause
                  }
                }
              }
            },
          contentAlignment = Alignment.CenterStart,
        ) {
          Text(
            text = if (armed) "Tap again to stop your agent" else "Stop my agent",
            style = TextStyle(fontFamily = sans(15.sp, FontWeight.SemiBold), fontSize = 15.sp),
            color = MerryColors.down,
          )
        }
        stopNote?.let {
          Text(
            it,
            style = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp, lineHeight = 19.sp),
            color = MerryColors.tx2,
          )
        }
      }

      // `.profile-session-actions button` — polish.css:75-76: colour #f47777,
      // min-height 44px, 15px, transparent, no border. That red is NOT `--down`;
      // it is a softer one used only here, and keeping them apart keeps "a loss"
      // and "a destructive control" from wearing the same colour.
      Box(
        Modifier
          .heightIn(min = 44.dp)
          .clickable(role = Role.Button) { scope.launch { c.repo.signOut() } },
        contentAlignment = Alignment.CenterStart,
      ) {
        Text(
          text = "Sign out",
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp),
          color = SignOutRed,
        )
      }
    }
    BottomInsetSpacer()
  }
}

/**
 * `.account-person` — polish.css:124-127: a flex row at `gap: 14px` holding a
 * 48px circle, then the name at 19px/600 with `letter-spacing: -.02em`, then the
 * agent-count line at 14px `--faint`.
 *
 * THE AVATAR IS NOT A GRADIENT FACE. `terminal.css:3902-3911` (as re-sized by
 * polish.css:125) makes this one a plain `--raised` circle carrying a single
 * 24px glyph in `--tx`: the "◎" mark when the owner string is an address, and
 * otherwise the owner's first character uppercased. The earlier 52px
 * lime-on-#252c19 rounded square at terminal.css:3486 is fully overridden.
 *
 * "1 agent" IS A LITERAL in the web (`You.tsx:59`), not a count. It is not
 * pluralised here either — computing it would make the two clients disagree
 * about a number.
 *
 * THE STATUS CHIP IS NOT DRAWN. `.profile-mode` reads `mine.statusLabel`
 * ("Paper trading" / "Running" / "Idle" / "Offline") and this screen has no such
 * field; an empty chip, or one defaulted to "Offline", would state a fact about
 * the agent that nothing here read.
 */
@Composable
private fun AccountPerson(f: Feed) {
  val owner = f.agent?.owner
  val label = shortAddress(owner) ?: owner?.takeIf { it.isNotBlank() } ?: "You"
  val glyph = when {
    owner?.startsWith("0x") == true -> "◎"
    !label.isEmpty() -> label.take(1).uppercase(Locale.ROOT)
    else -> "?"
  }
  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.size(48.dp).clip(CircleShape).background(MerryColors.raised),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = glyph,
        style = TextStyle(
          fontFamily = sans(24.sp, FontWeight.W500),
          fontSize = 24.sp,
          fontWeight = FontWeight.W500,
        ),
        color = MerryColors.tx,
      )
    }
    Column(Modifier.weight(1f)) {
      Text(
        text = label,
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(19.sp, FontWeight.W600),
          fontSize = 19.sp,
          fontWeight = FontWeight.W600,
          letterSpacing = (-0.02).em,
        ),
        color = MerryColors.tx,
      )
      Prose(
        text = "1 agent",
        size = 14.sp,
        lineHeight = 18.9.sp,
        color = MerryColors.faint,
        modifier = Modifier.padding(top = 3.dp),
      )
    }
  }
}

/**
 * `.account-balance` — a plain block. `polish.css:128` sets `padding: 0;
 * margin: 0` and `terminal.css:3921` flattens its radius to 0, so the card the
 * base sheet drew here is gone.
 *
 * The label is 15px `--tx-2` with 8px under it (polish.css:129); the figure is
 * 54px of Geist Pixel at `line-height: 1.15` (polish.css:130) with the cents at
 * `0.43em` in `--tx-2` — 23px inside a 54px figure. `money(null)` is the em dash
 * and `BalanceFigure` then emits no decimals span at all, so an unread balance
 * is one dash and nothing else. NEVER "$0.00".
 *
 * THE DAILY CHANGE HAS THREE RENDERINGS AND ONLY ONE OF THEM IS COLOURED
 * (`You.tsx:68-72`): null gets the class `meta` — grey `--tx-2` — and the words
 * "Daily change unavailable"; a negative gets `--down`; anything else gets
 * `--up`. This client has no daily-change figure on this payload, so the null
 * arm is the true one and it says so in words rather than showing a dash with no
 * label. What it must never do is take the `>= 0` branch by default, which is
 * the screen saying "we don't know" in text and "it went up" in colour.
 */
@Composable
private fun AccountBalance(f: Feed, nav: NavHostController) {
  Column(Modifier.fillMaxWidth()) {
    Prose(
      text = "Portfolio balance",
      size = 15.sp,
      lineHeight = 20.25.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(bottom = 8.dp),
    )
    PixelBalance(f.equityNow, size = 54.sp, cents = 23.sp, lineHeight = 62.1.sp)
    Prose(
      text = "Daily change unavailable",
      size = 14.sp,
      lineHeight = 21.sp,
      color = MerryColors.tx2,
      weight = FontWeight.W500,
      modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
    )

    // `.profile-funding` — polish.css:57-58 and :132: two equal columns,
    // `gap: 10px`, `margin-top: 18px`, each button 50px tall at radius 10 and
    // 16px/600. The primary is `--tx` on `--ink`; the secondary is `--card` with
    // a 1px `--line` border. WITHDRAW IS NOT STYLED AS DESTRUCTIVE — it is a
    // quiet secondary, which is the product's stated posture and not an
    // oversight to correct in a restyle.
    Row(
      Modifier.fillMaxWidth().padding(top = 18.dp),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      FundButton("Add funds", filled = true, modifier = Modifier.weight(1f)) {
        nav.navigate(Routes.web("/deposit", "Add funds"))
      }
      FundButton("Withdraw", filled = false, modifier = Modifier.weight(1f)) {
        nav.navigate(Routes.web("/withdraw", "Withdraw"))
      }
    }
  }
}

@Composable
private fun FundButton(
  label: String,
  filled: Boolean,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(10.dp)
  Box(
    modifier
      .height(50.dp)
      .clip(shape)
      .background(if (filled) MerryColors.tx else MerryColors.card)
      .then(if (filled) Modifier else Modifier.border(1.dp, MerryColors.line, shape))
      .clickable(role = Role.Button, onClick = onClick)
      .padding(12.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(
        fontFamily = sans(16.sp, FontWeight.W600),
        fontSize = 16.sp,
        fontWeight = FontWeight.W600,
      ),
      color = if (filled) MerryColors.ink else MerryColors.tx,
    )
  }
}

/**
 * THE ONE CARDED ELEMENT ON THIS SCREEN — `.account-agent`, polish.css:136:
 * `border: 1px solid var(--line); border-radius: 14px; background: var(--card);
 * padding: 16px 12px; gap: 12px`, with a 44px face, the name at 16px/600, the
 * strategy at 13px `--tx-2` and the value right-aligned. Tapping it goes to Chat.
 */
@Composable
private fun YourAgent(f: Feed, nav: NavHostController) {
  val agent = f.agent
  val shape = RoundedCornerShape(14.dp)
  Column(Modifier.fillMaxWidth()) {
    AccountHeading("Your agent", count = if (agent != null) "1" else null)
    Row(
      Modifier
        .fillMaxWidth()
        .clip(shape)
        .background(MerryColors.card)
        .border(1.dp, MerryColors.line, shape)
        .clickable(role = Role.Button) { nav.navigate(Routes.CHAT) }
        .padding(horizontal = 12.dp, vertical = 16.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Avatar(name = agent?.name ?: "No agent yet", size = 44.dp)
      Column(Modifier.weight(1f)) {
        Text(
          text = agent?.name ?: "No agent yet",
          maxLines = 1,
          style = TextStyle(
            fontFamily = sans(16.sp, FontWeight.W600),
            fontSize = 16.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.tx,
        )
        agent?.strategy?.takeIf { it.isNotBlank() }?.let {
          Prose(it, 13.sp, 18.85.sp, MerryColors.tx2, modifier = Modifier.padding(top = 5.dp))
        }
      }
      // `money(null)` is "—". An unread portfolio is not an empty one.
      Money(f.equityNow, bold = true)
    }
  }
}

/**
 * THE GROUPED ACCOUNT CARD — polish.css:141-143.
 *
 * The web builds this with `:nth-child` border-radius surgery: every row carries
 * `background: var(--card)` and a 1px `--line` border with `border-top: 0`, the
 * FIRST regains its top border and the corners `12px 12px 0 0`, and the LAST
 * takes `0 0 12px 12px`. That is a CSS-only trick. In Compose the whole column is
 * clipped once and the rows are separated by hairlines — do NOT try to give each
 * row its own shape.
 */
@Composable
private fun AccountGroup(content: @Composable ColumnScope.() -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Column(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape),
    content = content,
  )
}

/**
 * One row of it — `min-height: 64px; padding: 14px; gap: 14px` with the label at
 * 16px/600 `--tx` and a trailing 18px chevron in `--tx-2`.
 *
 * THE LEADING 24px LUCIDE ICON IS NOT DRAWN. The web gives each row a glyph
 * (SlidersHorizontal, Wallet, Settings, …); nine of them would have to be
 * hand-transcribed here, and a hand-drawn approximation of an icon set is the
 * kind of "close enough" this whole exercise exists to stop. Label and chevron
 * only, and it is stated rather than quietly dropped.
 */
@Composable
private fun ColumnScope.AccountRow(
  label: String,
  sub: String? = null,
  first: Boolean = false,
  onClick: () -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 64.dp)
      .then(
        if (first) {
          Modifier
        } else {
          Modifier.drawBehind { drawRect(MerryColors.line, size = Size(size.width, 1.dp.toPx())) }
        },
      )
      .clickable(role = Role.Button, onClick = onClick)
      .padding(14.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        text = label,
        style = TextStyle(
          fontFamily = sans(16.sp, FontWeight.W600),
          fontSize = 16.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
      sub?.let {
        Prose(it, 13.sp, 19.5.sp, MerryColors.tx2, modifier = Modifier.padding(top = 5.dp))
      }
    }
    ChevronRight(MerryColors.tx2)
  }
}
