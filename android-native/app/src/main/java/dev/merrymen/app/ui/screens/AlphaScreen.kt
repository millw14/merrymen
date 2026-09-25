package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
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
import dev.merrymen.app.market.WhileResumed
import dev.merrymen.app.market.alphaEmptyCopy
import dev.merrymen.app.market.alphaNotes
import dev.merrymen.app.market.alphaPerks
import dev.merrymen.app.market.alphaTierBadge
import dev.merrymen.app.market.refreshLoop
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
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

/** `polish.css:153` — the locked Alpha CTA's ink. Only ever on that button. */
private val GateInk = Color(0xFF07150E)

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
 * THE TIER BADGE — `.alpha-tier`, `{emoji} {name}` beside the title — is drawn
 * only for an OPEN desk whose payload names a tier. An open desk with no tier
 * is self-hosted, never "Traveller" and never "unknown tier", so the slot is
 * left empty rather than filled with a guess (alphaTierBadge).
 *
 * IT REFRESHES EVERY TWO MINUTES WHILE ON SCREEN, and not at all otherwise:
 * the desk comes off the same server memo as /api/discoveries, which lives two
 * minutes, so asking sooner is asking for the same bytes. A refresh that fails
 * after a good read keeps the good read on screen and SAYS it is the last one,
 * rather than blanking a desk the reader was in the middle of reading.
 */
@Composable
fun AlphaScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  // KEYED ON THE WALLET: a desk read for one session is not shown under
  // another, and a sign-in reads the desk again at once.
  var state by remember(signedIn) { mutableStateOf<Loaded<dev.merrymen.app.net.AlphaView>>(Loaded.Loading) }
  var refreshFailed by remember(signedIn) { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  suspend fun load(): Boolean {
    val r = c.api.alpha().toLoaded()
    if (r is Loaded.Value || state !is Loaded.Value) {
      state = r
      refreshFailed = false
    } else {
      refreshFailed = true
    }
    return r is Loaded.Value
  }
  WhileResumed(signedIn) { refreshLoop(ALPHA_EVERY_MS) { load() } }

  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(horizontal = PagePadH)
      // `.body:has(> .alpha-page) { padding-top: 20px }` — polish.css:180.
      .padding(top = 20.dp),
  ) {
    // `.board-head` — a space-between row: the title, and the tier badge when
    // an open desk names one.
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      PageTitle("Alpha")
      (state as? Loaded.Value)?.value?.let { alphaTierBadge(it) }?.let { TierBadge(it) }
    }

    // `.alpha-page > .alpha-intro` — polish.css:145: 17px/1.5 `--tx-2`,
    // `margin: 0 0 18px`. (polish.css:31's 21px is the non-mobile instance.)
    Prose(
      text = "The research behind the trade.",
      size = 17.sp,
      lineHeight = 25.5.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(top = 8.dp, bottom = 18.dp),
    )

    if (refreshFailed) {
      HostedNote(
        "Couldn't refresh Alpha just now — this is the last read, and it will try again.",
        Modifier.padding(bottom = 14.dp),
      )
    }

    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { a ->
      if (a.locked) {
        // THE BODY IS NOT HERE TO HIDE. The server omits `picks` entirely when
        // locked; there is nothing to blur, which is the point.
        AlphaGate(a, nav)
        InsideAlpha(picks = a.pickCount, passed = passedCount(a.passed))
      } else {
        AlphaDesk(a, nav, onRetry = { scope.launch { load() } })
      }
    }
    BottomInsetSpacer()
  }
}

/** Two minutes: the server's discoveries memo lives that long (refresh-loop.ts DISCOVERIES_EVERY_MS). */
private const val ALPHA_EVERY_MS = 120_000L

/**
 * `.alpha-tier` — the tier that opened the desk, beside the title. A quiet
 * outlined chip in `--tx-2`: it identifies the reader's standing, it is not a
 * reward, so it takes neither the accent nor the gate's green.
 */
@Composable
private fun TierBadge(text: String) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier.clip(shape).border(1.dp, MerryColors.line, shape).padding(horizontal = 10.dp, vertical = 4.dp),
  ) {
    Text(
      text = text,
      maxLines = 1,
      style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
      color = MerryColors.tx2,
    )
  }
}

/**
 * THE OPEN DESK, with what it says about itself first.
 *
 * The disclosures (alphaNotes) come before the rows, once for the page. Then
 * "Kept": the rows, or — when there are none — WHY there are none, which is
 * one of three different facts (alphaEmptyCopy). The scout could not look,
 * the index did not answer, or it looked and kept nothing: only the last is a
 * statement about the market, and only the last is drawn as an empty state.
 * The other two are our failure and read as a notice.
 */
@Composable
private fun AlphaDesk(a: dev.merrymen.app.net.AlphaView, nav: NavHostController, onRetry: () -> Unit) {
  val notes = alphaNotes(a)
  if (notes.isNotEmpty()) {
    Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      notes.forEach { HostedNote(it) }
    }
  }
  val empty = alphaEmptyCopy(a)
  AlphaKept(a, nav) {
    when {
      empty == null -> Unit
      empty.ours -> Notice(
        title = empty.title,
        body = empty.body,
        // Try again only where trying again can help: the index blinking.
        // A scout with no model will have no model on the next tap either.
        actionLabel = if (a.indexUnreachable) "Try again" else null,
        onAction = if (a.indexUnreachable) onRetry else null,
      )
      else -> Empty(empty.title, empty.body)
    }
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

    // WHAT THE ENTRY TIER UNLOCKS, verbatim from the payload, which renders it
    // from CIRCLE_TIERS so the copy cannot drift from what the token does —
    // and cannot promise a price, a return or a burn (token.ts forbids it).
    // Typed here instead, it would be the one place such a promise could creep in.
    val perks = alphaPerks(a)
    if (perks.isNotEmpty()) {
      Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        perks.forEach { perk ->
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Prose("·", 14.sp, 20.sp, MerryColors.tx2)
            Prose(perk, 14.sp, 20.sp, MerryColors.tx2)
          }
        }
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
    TabSectionHeading("Inside Alpha", Modifier.padding(bottom = 14.dp))

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
private fun AlphaKept(
  a: dev.merrymen.app.net.AlphaView,
  nav: NavHostController,
  whenEmpty: @Composable () -> Unit,
) {
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

    if (a.pickRows.isEmpty()) {
      whenEmpty()
    } else {
      Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        a.pickRows.forEach { AlphaRow(it, passed = false, nav = nav) }
      }
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
