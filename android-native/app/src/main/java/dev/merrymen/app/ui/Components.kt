package dev.merrymen.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.merrymen.app.data.Loaded
import java.util.Locale

// ---------------------------------------------------------------------------
// PAGE CHROME
// ---------------------------------------------------------------------------

/**
 * THE PAGE GUTTER, from the one rule that actually decides it on a phone.
 *
 * `polish.css:87`, inside `@media (max-width: 1099px)`:
 * `.terminal-host .app > .body { padding: 16px 20px calc(100px + env(safe-area-inset-bottom)); gap: 14px }`
 *
 * That rule beats terminal.css:678's `18px 18px` on both specificity
 * (`.terminal-host .x` is 0,2,0 against `:where(.terminal-host) .x` at 0,1,0)
 * and source order, so 20px is the gutter and 16px is the top — NOT 18, and
 * not the 16 the Android screens have been hardcoding on the sides.
 *
 * These are public so a screen names the value once instead of guessing it;
 * they belong to the page, not to any card, which is why [SectionCard] no
 * longer carries a margin of its own.
 */
val PagePadH = 20.dp

/** `padding: 16px …` — the first row sits 16px under the status bar inset. */
val PagePadTop = 16.dp

/** `gap: 14px` — the space between two top-level sections of a page. */
val PageGap = 14.dp

/**
 * HOW FAR THE LAST ROW MUST CLEAR THE FLOATING TAB BAR.
 *
 * `polish.css:87` resolves the body's bottom padding to
 * `calc(100px + env(safe-area-inset-bottom))`. (polish.css:17 says 104px and is
 * the value this constant used to cite — but 87 is the later rule at equal
 * specificity, so 100px is what the browser actually computes.)
 *
 * The 4px kept on top of the web's 100 stands in for `env(safe-area-inset-bottom)`,
 * which nothing else in this app adds: `Shell` provides this as a flat number
 * and does not fold in `WindowInsets.navigationBars`. Drop it to 100 only
 * together with a real inset.
 *
 * The bar is `position: fixed`, so content scrolls UNDER it and this padding is
 * the only thing that lets the LAST card be read rather than sitting permanently
 * behind the pill. It belongs INSIDE each scrollable — as `contentPadding` on a
 * LazyColumn or a trailing Spacer on a scrolling Column — not as padding on the
 * container, which would stop the content sliding under the bar at all and lose
 * the translucency the design is built on.
 */
val BOTTOM_INSET = 104.dp

/** The whole page box in one value: gutter, top, and the bar's clearance. */
val PagePadding = PaddingValues(
  start = PagePadH,
  end = PagePadH,
  top = PagePadTop,
  bottom = BOTTOM_INSET,
)

/** See [BOTTOM_INSET]. Provided once by Shell so a preview still gets 0. */
val LocalBottomInset = compositionLocalOf { 0.dp }

/**
 * THE BIG SCREEN HEADING — "Home", "Feed", "Alpha", "Leaderboard".
 *
 * `polish.css:109-110`, inside `@media (max-width: 1099px)`:
 * `.terminal-host .top-title, .terminal-host .account-header h1 { font-size: 34px; line-height: 1.15; font-weight: 700; letter-spacing: -.04em; margin: 0 }`
 *
 * The base sheet says 22px (terminal.css:727) — that is the DESKTOP size, and
 * reading it alone is how this heading ends up a third too small. On a phone the
 * title is deliberately enormous: it is the only 34px thing on the screen.
 */
@Composable
fun PageTitle(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = sans(34.sp, FontWeight.W700),
      fontSize = 34.sp,
      fontWeight = FontWeight.W700,
      lineHeight = 39.1.sp,
      letterSpacing = (-0.04).em,
      color = MerryColors.tx,
    ),
  )
}

// ---------------------------------------------------------------------------
// FIGURES
// ---------------------------------------------------------------------------

/**
 * A FIGURE, OR THE REASON THERE ISN'T ONE.
 *
 * The em dash is not a placeholder for zero. "$0.00" says we asked and the
 * answer was nothing; "—" says we never got an answer. This app renders those
 * differently everywhere, because the product they belong to spent real money
 * learning that collapsing them is how an owner gets told they hold nothing on
 * the strength of a rate limit.
 *
 * THE DASH IS `--faint`, NOT `--tx-2`. terminal.css:695 gives `.flat` — the
 * class the web puts on a change it could not read — `color: var(--faint)`, and
 * the sheet's own comment names it as neither the green nor the red. A missing
 * figure is that same claim, so it wears that same grey rather than the one
 * every secondary label already uses.
 *
 * Digits come from [numerals] because that is where the web gets them: `--sans`
 * lists "Geist Numerals" first with `unicode-range: U+0030-0039`, so a browser
 * resolves every digit to it and every letter to DM Sans. That split is what
 * makes a column of money line up.
 */
@Composable
fun Money(
  value: Double?,
  modifier: Modifier = Modifier,
  bold: Boolean = false,
  size: TextUnit = 15.sp,
) {
  val weight = if (bold) FontWeight.W600 else FontWeight.W400
  Text(
    text = value?.let { "$" + String.format(Locale.US, "%,.2f", it) } ?: "—",
    modifier = modifier,
    style = TextStyle(
      fontFamily = numerals(weight),
      fontSize = size,
      fontWeight = weight,
    ),
    color = if (value == null) MerryColors.faint else MerryColors.tx,
  )
}

/**
 * Basis points, signed, coloured only when money actually moved.
 *
 * The sign is carried by the character AND the colour here, unlike the web's
 * `.delta`, which carries it by a caret glyph and the colour alone. That is a
 * deliberate keep: this figure appears in rows without a caret beside it.
 *
 * `--up` / `--down` are set as a TEXT colour and never as a ground — no rule in
 * terminal.css fills a surface with either. A gain on a green chip would be an
 * emphasis the web does not have, and a refusal on one would be a lie.
 */
@Composable
fun Bps(value: Int?, modifier: Modifier = Modifier, size: TextUnit = 13.sp) {
  val text = value?.let {
    (if (it >= 0) "+" else "") + String.format(Locale.US, "%.2f", it / 100.0) + "%"
  } ?: "—"
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = numerals(FontWeight.W600),
      fontSize = size,
      fontWeight = FontWeight.W600,
    ),
    color = when {
      value == null -> MerryColors.faint
      value > 0 -> Up
      value < 0 -> Down
      // Zero is not unknown. It keeps the primary text colour rather than the
      // faint one, so "we read it and it did not move" stays distinct from
      // "we could not read it".
      else -> MerryColors.tx
    },
  )
}

// ---------------------------------------------------------------------------
// SURFACES
// ---------------------------------------------------------------------------

/**
 * WHAT A CARD ACTUALLY IS IN THIS PRODUCT.
 *
 * There is no `.card` class in terminal.css. The card is a REPEATED RECIPE, and
 * the closest thing to a canonical instance is `.proposals` (terminal.css:7276):
 *
 * `padding: 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--card)`
 *
 * with `--r: 16px` (terminal.css:623) and `--line: #24261e`. The same four
 * ingredients recur at `.first-visit` (18px 20px, radius 16), `.alpha-lock`
 * (22px 18px, radius 16), `.fund-recipient` (16px, radius 14) and
 * `.public-performance` (22px 20px 16px, radius 18) — which is why [radius] and
 * [padding] are parameters rather than constants. Six radii are in genuine use;
 * normalising them to one would be inventing a scale the sheet does not have.
 *
 * SEVERAL WEB SURFACES HAVE NO BORDER AND SOME HAVE NO CARD AT ALL. `.stat`
 * (radius 14) and `.week-card` (radius 16) are card GROUND with no border —
 * hence [bordered]. And `.desk-portfolio`, `.account-balance`,
 * `.public-performance` and `.flow-back` all have their radius flattened to 0 by
 * a later rule, i.e. they are plain blocks on the page ground. A screen that
 * reaches for [SectionCard] out of habit will draw a box the web does not draw;
 * check the screen's own spec file before wrapping something in one.
 *
 * NO OUTER MARGIN. This used to carry `padding(horizontal = 16.dp, vertical = 6.dp)`,
 * which was the page gutter smuggled into the component — and at 16dp it was the
 * wrong gutter. The page owns its own box now: see [PagePadH] / [PageGap].
 *
 * The title is the sheet's `h3` (terminal.css:851): 15px, weight 600, `margin: 0 0 12px`,
 * inheriting `--tx`. It is NOT uppercased — text-transform on a phone is live in
 * exactly one place in the whole terminal (`.tag.holders`), and a card heading is
 * not it.
 */
@Composable
fun SectionCard(
  title: String? = null,
  modifier: Modifier = Modifier,
  radius: Dp = 16.dp,
  bordered: Boolean = true,
  padding: PaddingValues = PaddingValues(14.dp),
  gap: Dp = 8.dp,
  content: @Composable ColumnScope.() -> Unit,
) {
  val shape = RoundedCornerShape(radius)
  Column(
    modifier = modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .then(if (bordered) Modifier.border(1.dp, MerryColors.line, shape) else Modifier)
      .padding(padding),
    verticalArrangement = Arrangement.spacedBy(gap),
  ) {
    if (title != null) {
      Text(
        text = title,
        // `h3 { margin: 0 0 12px }`. The Column's own [gap] supplies part of it;
        // this makes up the difference so the heading sits 12dp clear of the
        // first row whatever the caller sets the gap to.
        modifier = Modifier.padding(bottom = (12.dp - gap).coerceAtLeast(0.dp)),
        style = TextStyle(
          fontFamily = sans(15.sp, FontWeight.W600),
          fontSize = 15.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
    }
    content()
  }
}

// ---------------------------------------------------------------------------
// LOADING, REFUSAL, UNREACHABILITY
// ---------------------------------------------------------------------------

/**
 * HOW ANY SCREEN OPENS THE DOOR, without thirteen call sites passing a lambda.
 *
 * The gate is a property of the whole install, so the way out of it is the same
 * from every screen. Shell provides this once; a preview or a test that does not
 * gets null and renders the sentence without a button, which still names the
 * remedy.
 */
val LocalOpenSettings = compositionLocalOf<(() -> Unit)?> { null }

/**
 * THE REFUSAL COLOUR — a rule declined, which is a third outcome.
 *
 * `terminal.css:1430-1436`: `.stamp.cap`, `.stamp.wall`, `.stamp.breaker` and
 * `.stamp.blocked` set BOTH `color` and `border-color` to `#d4a24a`. It is
 * deliberately neither `--up` green nor `--down` red — a refused trade is not a
 * loss, and folding it into a Material error role turns it into one.
 *
 * Private to this file per the one-file-per-agent rule; it wants lifting into
 * `MerryColors` in Theme.kt, where the stamp family will need it too.
 */
private val RefusalAmber = Color(0xFFD4A24A)

/** `.desk-notice`'s left rail, `terminal.css:7482`. An olive-grey, not a token. */
private val NoticeRail = Color(0xFF6B6A55)

/** `.desk-notice`'s ground, `terminal.css:7483`. Warmer than `--card`. */
private val NoticeGround = Color(0xFF17170F)

/**
 * THE THREE-STATE RENDERER, so no screen has to reinvent the distinction.
 *
 * Refused-with-401 is a door, not an emptiness. Unreachable is our failure, not
 * the account's. Both get a next action, because a dead end with no next action
 * is what sends somebody to a JSON endpoint to work out what happened — which a
 * tester in this beta actually did.
 *
 * THE TONES ARE NOT DECORATION. terminal.css keeps three different "something is
 * wrong" treatments and they mean different things: amber `.stamp` (a rule
 * refused), the `--down` `.desk-blocked` card (nothing can proceed at all), and
 * the quiet `.desk-notice` slab (we are sitting still and here is why). A
 * refusal gets the amber; an unreachable server gets the quiet slab, because it
 * is not a refusal and not a loss — it is us failing to get an answer.
 */
@Composable
fun <T> LoadedBlock(
  state: Loaded<T>,
  onSignIn: (() -> Unit)? = null,
  onRetry: (() -> Unit)? = null,
  content: @Composable (T) -> Unit,
) {
  when (state) {
    is Loaded.Idle -> Unit
    // The web has no spinner anywhere — its unread state is the empty card
    // reading "Loading…" (ui.tsx:217). A screen that wants that reading should
    // call `Empty(title = "Loading…", body = "")`. This stays a spinner because
    // it renders INSIDE cards and rows where a 264dp panel would not fit, but it
    // is tinted --faint rather than the accent: nothing is live here, we are
    // simply still reading.
    is Loaded.Loading -> Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) {
      CircularProgressIndicator(
        modifier = Modifier.size(18.dp),
        color = MerryColors.faint,
        strokeWidth = 2.dp,
      )
    }
    is Loaded.Value -> content(state.value)
    is Loaded.Refused -> {
      // TWO DIFFERENT 401s, AND ONLY ONE OF THEM IS ABOUT YOUR ACCOUNT.
      //
      // While the site gate is on, EVERY route answers 401 {"error":"gated"} —
      // including the ones that would tell us who you are. Rendering that as
      // "Sign in to see this" sent a reader into a wallet signature ceremony to
      // fix a door that a shared password opens, which is a remedy that cannot
      // work. Seen on a real device: every screen said "Sign in", the Sign in
      // button opened the web sign-in, and the web sign-in was behind the same
      // closed door.
      val gated = state.status == 401 && state.message.trim().equals("gated", ignoreCase = true)
      val openSettings = LocalOpenSettings.current
      Notice(
        title = when {
          gated -> "This deployment is behind a password"
          state.status == 401 -> "Sign in to see this"
          else -> "The server said no"
        },
        body = when {
          gated ->
            "merrymen is in closed beta. The site password goes in Settings — it is the door to " +
              "the whole deployment, not your account."
          else -> state.message
        },
        actionLabel = when {
          gated && openSettings != null -> "Open settings"
          !gated && state.status == 401 && onSignIn != null -> "Sign in"
          else -> null
        },
        onAction = if (gated) openSettings else onSignIn,
        tone = RefusalAmber,
      )
    }
    is Loaded.Unreachable -> Notice(
      title = "Couldn't reach merrymen",
      // Deliberately OUR failure, in our words. Not "you are offline" — we do
      // not know that, and telling somebody their connection is broken when the
      // server is down sends them to reset a router.
      body = "That's this app failing to get an answer, not a fact about your account. " + state.cause,
      actionLabel = if (onRetry != null) "Try again" else null,
      onAction = onRetry,
      tone = null,
    )
  }
}

/**
 * A SENTENCE THE APP NEEDS SOMEBODY TO READ, in one of two weights.
 *
 * [tone] `null` is the QUIET one — `.desk-notice`, terminal.css:7478:
 * `margin: 12px 0; padding: 10px 12px; border-left: 2px solid #6b6a55; background: #17170f; color: var(--tx-2); font-size: 13px; line-height: 1.45`
 * and NO border-radius. The sheet's comment says why it is quiet: it "has no
 * blocker rule behind it… the agent telling them why it is sitting still".
 *
 * [tone] non-null is the LOUD one — `.desk-blocked`, terminal.css:7467:
 * `padding: 13px 15px; border: 1px solid color-mix(in srgb, var(--down) 40%, transparent); border-radius: var(--r); background: color-mix(--down 9%)`,
 * with its `p` at 13px/1.6 in FULL `--tx` rather than the dimmed `--tx-2`.
 * `color-mix(in srgb, X n%, transparent)` is exactly `X.copy(alpha = n / 100)`,
 * so the tone drives both alphas and nothing is approximated. The sheet calls it
 * "deliberately louder than the proposals panel below it".
 *
 * The title line has no element of its own in either rule; it is `.flow-notice strong`
 * (terminal.css:4338), 13px/600 at `--tx`.
 *
 * The action is `.desk-blocked button` (terminal.css:7497) on the loud one — a
 * LIME PILL, `radius 999px; background: var(--lime); color: var(--ink); 13px/600`,
 * reserved by both its call sites for "the owner must act to unblock this" — and
 * the quieter `.fund` (terminal.css:814, `--raised` ground, radius 10) on the
 * quiet one.
 */
@Composable
fun Notice(
  title: String,
  body: String,
  actionLabel: String? = null,
  onAction: (() -> Unit)? = null,
  tone: Color? = null,
  modifier: Modifier = Modifier,
) {
  if (tone == null) {
    // The rail must run the full height of the text, so the Row is measured to
    // its tallest child rather than filling the parent.
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
      Box(Modifier.width(2.dp).fillMaxHeight().background(NoticeRail))
      Column(
        Modifier
          .weight(1f)
          .background(NoticeGround)
          .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        NoticeTitle(title)
        NoticeBody(body, color = MerryColors.tx2, lineHeight = 18.85.sp)
        if (actionLabel != null && onAction != null) {
          FundButton(actionLabel, onAction, Modifier.padding(top = 5.dp))
        }
      }
    }
  } else {
    val shape = RoundedCornerShape(16.dp)
    Column(
      modifier
        .fillMaxWidth()
        .clip(shape)
        .background(tone.copy(alpha = 0.09f))
        .border(1.dp, tone.copy(alpha = 0.40f), shape)
        .padding(horizontal = 15.dp, vertical = 13.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      NoticeTitle(title)
      // `.desk-blocked p { color: var(--tx) }` — the body of a blocker is at
      // full brightness. Dimming it to --tx-2 is how a blocker starts reading as
      // a footnote.
      NoticeBody(body, color = MerryColors.tx, lineHeight = 20.8.sp)
      if (actionLabel != null && onAction != null) {
        LimePill(actionLabel, onAction, Modifier.padding(top = 5.dp))
      }
    }
  }
}

/** `.flow-notice strong` — terminal.css:4338, 13px/600 at `--tx`. */
@Composable
private fun NoticeTitle(text: String) {
  Text(
    text = text,
    style = TextStyle(
      fontFamily = sans(13.sp, FontWeight.W600),
      fontSize = 13.sp,
      fontWeight = FontWeight.W600,
      lineHeight = 17.55.sp,
    ),
    color = MerryColors.tx,
  )
}

@Composable
private fun NoticeBody(text: String, color: Color, lineHeight: TextUnit) {
  if (text.isBlank()) return
  Text(
    text = text,
    style = TextStyle(
      fontFamily = sans(13.sp),
      fontSize = 13.sp,
      fontWeight = FontWeight.W400,
      lineHeight = lineHeight,
    ),
    color = color,
  )
}

/**
 * `.fund` — the secondary button. terminal.css:814:
 * `padding: 8px 14px; min-height: 36px; border-radius: 10px; background: var(--raised); color: var(--tx); font-weight: 600; font-size: 13px`.
 */
@Composable
private fun FundButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
  Box(
    modifier
      .heightIn(min = 36.dp)
      .clip(RoundedCornerShape(10.dp))
      .background(MerryColors.raised)
      .clickable(onClick = onClick)
      .padding(horizontal = 14.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * The ONE place lime is a button ground — `.desk-blocked button` (terminal.css:7497)
 * and `.proposal-resign` (terminal.css:7447). Both call sites mean the same
 * thing: the owner must do something before the agent can move. Do not spend it
 * on an ordinary action.
 */
@Composable
private fun LimePill(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
  Box(
    modifier
      .clip(RoundedCornerShape(50))
      .background(MerryColors.lime)
      .clickable(onClick = onClick)
      .padding(horizontal = 15.dp, vertical = 8.dp),
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

// ---------------------------------------------------------------------------
// PILL
// ---------------------------------------------------------------------------

/**
 * `.pill` — terminal.css:965.
 *
 * `padding: 8px 13px; border-radius: 999px; background: var(--card); color: var(--tx-2); font-size: 13px; font-weight: 600`,
 * and `.pill.on { background: #ecece4; color: #111 }`. There is NO BORDER on
 * either state, the resting ground is `--card` rather than transparent, and the
 * rendered height is about 34px — the previous version of this composable had a
 * 1px line border, a transparent rest state, 12sp text and a 44dp floor, which
 * is the `polish.css:23` toggle-row family (`.feed-views button`), a different
 * control.
 *
 * SELECTED IS OFF-WHITE, NOT THE ACCENT. `--tx` on `--ink`. Lime reads as "live"
 * everywhere else in the terminal — it is for a running agent and a confirm
 * prompt, not for which filter you happen to be on.
 *
 * The 34dp box is the web's, and it is under Android's 48dp touch guidance. It
 * is a plain Box rather than an M3 component precisely so Material does not
 * silently inflate it and break the row rhythm; if this needs to grow for
 * accessibility that is a product decision, not a restyle.
 */
@Composable
fun Pill(text: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
  Box(
    modifier
      .clip(RoundedCornerShape(50))
      .background(if (selected) MerryColors.tx else MerryColors.card)
      .clickable(onClick = onClick)
      .padding(horizontal = 13.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = text,
      style = TextStyle(
        fontFamily = sans(13.sp, FontWeight.W600),
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
      ),
      color = if (selected) MerryColors.ink else MerryColors.tx2,
    )
  }
}

// ---------------------------------------------------------------------------
// AVATARS
// ---------------------------------------------------------------------------

/**
 * THE HUE HASH, mirrored character for character from `ui.tsx:6-9`.
 *
 * ```
 * let h = 0;
 * for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
 * ```
 *
 * This is identity, not decoration: the same agent must come out the same colour
 * on the phone and in the browser, so the multiplier, the modulus and the
 * per-step reduction all have to stay exactly as they are. `charCodeAt` returns
 * a UTF-16 code unit, which is what Kotlin's `Char.code` gives, so a surrogate
 * pair folds identically in both.
 */
private fun hueOf(seed: String): Int {
  var h = 0
  for (c in seed) h = (h * 31 + c.code) % 360
  return h
}

/**
 * `gradient()` at `ui.tsx:20-23`:
 * `linear-gradient(145deg, hsl(h 62% 62%), hsl((h + 42) % 360 58% 44%))`.
 *
 * Note the second stop is 58%/44%, NOT a second copy of 62%/62% — the ramp
 * darkens as well as rotating, and a flat pair reads as a different avatar set.
 *
 * CSS measures the angle clockwise from "to top", so 145deg points down and
 * slightly right. For a box of w x h the gradient line has length
 * `|w sin θ| + |h cos θ|` and is centred on the box, which for a square puts the
 * ends at about (0.10, -0.07) and (0.90, 1.07) of the side.
 */
private fun faceBrush(seed: String, size: Size): Brush {
  val h = hueOf(seed).toFloat()
  return Brush.linearGradient(
    colors = listOf(
      Color.hsl(h, 0.62f, 0.62f),
      Color.hsl((h + 42f) % 360f, 0.58f, 0.44f),
    ),
    start = Offset(size.width * 0.1005f, size.height * -0.0705f),
    end = Offset(size.width * 0.8995f, size.height * 1.0705f),
  )
}

/**
 * `initialsOf` at `ui.tsx:11-17`, ported straight.
 *
 * Zero words returns the literal "??" — a VISIBLE "we do not have a name",
 * not a blank circle. Do not turn it into an empty string.
 */
private fun initialsOf(name: String): String {
  val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
  return when {
    words.isEmpty() -> "??"
    words.size == 1 -> words[0].take(2).uppercase(Locale.ROOT)
    else -> "${words[0][0]}${words[1][0]}".uppercase(Locale.ROOT)
  }
}

/** `Coin`'s initials, `ui.tsx:261-262`: alphanumerics only, 2 chars, else "?". */
private fun coinInitials(symbol: String): String =
  symbol.replace(Regex("[^A-Za-z0-9]"), "").take(2).uppercase(Locale.ROOT).ifEmpty { "?" }

/**
 * The initials size the sheet gives each avatar box. terminal.css:1031 sets the
 * shared 11px; the variants override it at :1058 (`.face.sm` 16px box / 7px),
 * :1064 (`.face.pin` 22 / 8), :1071 (`.face.lg` 48 / 16) and :1079 (`.coin`
 * 40 / 12). The ratios are not constant, so the four named boxes are matched
 * exactly and anything else falls back to the pin ratio.
 */
private fun initialsSizeFor(box: Dp): TextUnit = when (box) {
  16.dp -> 7.sp
  22.dp -> 8.sp
  30.dp -> 11.sp
  40.dp -> 12.sp
  48.dp -> 16.sp
  else -> (box.value * 8f / 22f).sp
}

/**
 * AN AGENT'S FACE — `.face.pin` / `.stack .face`, 22x22 (terminal.css:1064, :2978).
 *
 * A circle carrying [name]'s own gradient with its initials on top in
 * `#0e0e10` at weight 700. That near-black is NOT `--ink` and not `--bg`
 * (terminal.css:1040 states it separately); it is the one colour in the app that
 * exists to sit on a light avatar ground.
 *
 * The web layers a lazily-loaded robohash `<img>` over the initials and REMOVES
 * it on error so the gradient shows through (`ui.tsx:38-45`). No image is
 * fetched here — this composable is the fallback layer only, and a caller that
 * wants the portrait should draw it into the same box on top. Doing so leaves
 * the identity colour correct either way, which is the point of the fallback
 * being a hash rather than a placeholder grey.
 *
 * [badgeSymbol] draws `.stack-badge .coin` (terminal.css:2999): a 13x13 coin
 * pinned to the bottom-right with `box-shadow: 0 0 0 2px var(--bg)`. That shadow
 * is a SPREAD RING outside the box, not a border — `Modifier.border` would eat
 * 2dp of the coin — so the ring is a larger `--bg` circle behind it, and the
 * badge is offset by (ring + the CSS's own -3px) to land where the sheet puts it.
 */
@Composable
fun Avatar(
  name: String,
  modifier: Modifier = Modifier,
  size: Dp = 22.dp,
  badgeSymbol: String? = null,
) {
  Box(modifier.size(size)) {
    Box(
      Modifier
        .fillMaxSize()
        .clip(CircleShape)
        .drawBehind { drawRect(brush = faceBrush(name, this.size)) },
      contentAlignment = Alignment.Center,
    ) {
      val glyph = initialsSizeFor(size)
      Text(
        text = initialsOf(name),
        style = TextStyle(
          fontFamily = sans(glyph, FontWeight.W700),
          fontSize = glyph,
          fontWeight = FontWeight.W700,
          lineHeight = glyph,
        ),
        color = AvatarGlyph,
      )
    }
    if (badgeSymbol != null) CoinBadge(badgeSymbol, Modifier.align(Alignment.BottomEnd))
  }
}

/** terminal.css:1040 — shared by `.face` and `.coin`, and not a theme token. */
private val AvatarGlyph = Color(0xFF0E0E10)

/** terminal.css:1084 — `.coin`'s default ground while a logo is still loading. */
private val CoinGround = Color(0xFFECECE4)

@Composable
private fun BoxScope.CoinBadge(symbol: String, modifier: Modifier = Modifier) {
  Box(
    modifier
      // right:-3px / bottom:-3px on the coin, plus the 2dp ring that sits
      // outside it, is 5dp of travel from the parent's corner.
      .offset(x = 5.dp, y = 5.dp)
      .size(17.dp)
      .background(MerryColors.bg, CircleShape)
      .padding(2.dp),
  ) {
    Box(
      Modifier
        .fillMaxSize()
        .clip(CircleShape)
        .background(CoinGround)
        .drawBehind { drawRect(brush = faceBrush(symbol, this.size)) },
      contentAlignment = Alignment.Center,
    ) {
      Text(
        text = coinInitials(symbol),
        style = TextStyle(
          fontFamily = sans(6.sp, FontWeight.W700),
          fontSize = 6.sp,
          fontWeight = FontWeight.W700,
          lineHeight = 6.sp,
        ),
        color = AvatarGlyph,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// THE EMPTY STATE
// ---------------------------------------------------------------------------

/**
 * Which drawing goes in the empty state's front card. `ui.tsx:156-159` maps
 * these to lucide icons; nothing else about the artwork changes per kind — the
 * `empty-art-<kind>` class exists in the DOM and no sheet defines any of the
 * seven.
 */
enum class EmptyKind { Feed, Board, Chat, Profile, Search, Positions, Wallet }

/**
 * THE DESIGNED EMPTY STATE — `.blank`, as polish.css leaves it on a phone.
 *
 * `polish.css:191-207` (which beats terminal.css:2603's bare left-aligned column
 * on both specificity and order):
 * `align-items: center; justify-content: center; text-align: center; gap: 18px; padding: 36px 24px 32px; margin: 14px 0 24px; min-height: 264px; border: 1px solid var(--line); border-radius: 20px;`
 * over `background: radial-gradient(ellipse at 50% 0%, rgb(185 202 141 / .055), transparent 72%), var(--card)`.
 *
 * The title is `.blank > strong` at 19px/1.4/weight 500 with the base sheet's
 * `letter-spacing: -0.02em` still applying. The note is `<p class="blank-note">`
 * — but `.blank p` (0,1,1) outranks `.blank-note` (0,1,0), so the live values are
 * terminal.css:2626: 13px/1.45 at `--tx-2`, and `.blank-note`'s own 1.5 line
 * height never renders. The button is `.fund.solid` with polish.css:207's
 * overrides: min-height 44, radius 12, a 24px gap before the ↗ (U+2197), on
 * terminal.css:2634's `padding: 11px 16px`.
 *
 * WHAT I SIMPLIFIED. Two things, both in the artwork:
 *  - The seven lucide glyphs are hand-transcribed path data, not extracted from
 *    the pinned lucide-react build (the web's node_modules is not installed
 *    here), so a curve may differ in detail from the release the site ships.
 *    They are decorative and depict nothing real.
 *  - CSS's `radial-gradient(ellipse …)` is elliptical and Compose's is circular,
 *    so the wash is a circle of 0.72 x the card's width. At 5.5% alpha the
 *    eccentricity is not visible.
 *
 * THE ARTWORK MUST NEVER ACQUIRE A FIGURE. It is two blank cards, two rules and
 * a handful of loose pixels precisely so that an empty screen cannot be mistaken
 * for a screen with data on it. Do not give it numbers, a chart line or a
 * sparkline.
 *
 * [compact] is `.blank.blank-compact` (polish.css:218): 160px tall, transparent
 * ground, a DASHED border, and a 13px/weight-400 title in `--tx-2`. The dash and
 * the missing ground are the difference between "this is empty" and "this is a
 * designed empty panel"; solid-bordering it collapses the two.
 *
 * [horizontal] is the Home board-preview arm (polish.css:99): 120px tall, the
 * artwork BESIDE the copy, 18px padding, 16px gap, left-aligned.
 */
@Composable
fun Empty(
  title: String,
  body: String,
  actionLabel: String? = null,
  onAction: (() -> Unit)? = null,
  kind: EmptyKind = EmptyKind.Feed,
  compact: Boolean = false,
  horizontal: Boolean = false,
  modifier: Modifier = Modifier,
) {
  val shape = RoundedCornerShape(20.dp)
  val gap = if (compact) 12.dp else if (horizontal) 16.dp else 18.dp
  val minHeight = when {
    compact -> 160.dp
    horizontal -> 120.dp
    else -> 264.dp
  }
  val pad = when {
    compact -> PaddingValues(horizontal = 18.dp, vertical = 22.dp)
    horizontal -> PaddingValues(18.dp)
    else -> PaddingValues(start = 24.dp, end = 24.dp, top = 36.dp, bottom = 32.dp)
  }

  var box = modifier
    .fillMaxWidth()
    // `margin: 14px 0 24px`. On Home this rule is cancelled (polish.css:74 sets
    // `.board-preview .blank { margin: 0 }`), which the horizontal arm is.
    .padding(top = if (horizontal) 0.dp else 14.dp, bottom = if (horizontal) 0.dp else 24.dp)
    .heightIn(min = minHeight)
    .clip(shape)

  box = if (compact) {
    box.dashedRoundedBorder(MerryColors.line, 1.dp, 20.dp)
  } else {
    box
      .background(MerryColors.card)
      .drawBehind {
        drawRect(
          Brush.radialGradient(
            colors = listOf(EmptyWash, Color.Transparent),
            center = Offset(size.width / 2f, 0f),
            radius = size.width * 0.72f,
          ),
        )
      }
      .border(1.dp, MerryColors.line, shape)
  }
  box = box.padding(pad)

  if (horizontal) {
    Row(box, horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
      EmptyArtwork(kind, compact)
      Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        EmptyTitle(title, compact, TextAlign.Start)
        EmptyNote(body, TextAlign.Start)
        if (actionLabel != null && onAction != null) EmptyAction(actionLabel, onAction)
      }
    }
  } else {
    Column(
      box,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(gap, Alignment.CenterVertically),
    ) {
      EmptyArtwork(kind, compact)
      EmptyTitle(title, compact, TextAlign.Center)
      EmptyNote(body, TextAlign.Center)
      if (actionLabel != null && onAction != null) EmptyAction(actionLabel, onAction)
    }
  }
}

/** `rgb(185 202 141 / .055)` — polish.css:205. */
private val EmptyWash = Color(0x0EB9CA8D)

@Composable
private fun EmptyTitle(text: String, compact: Boolean, align: TextAlign) {
  val size = if (compact) 13.sp else 19.sp
  Text(
    text = text,
    textAlign = align,
    style = TextStyle(
      fontFamily = sans(size, if (compact) FontWeight.W400 else FontWeight.W500),
      fontSize = size,
      fontWeight = if (compact) FontWeight.W400 else FontWeight.W500,
      lineHeight = if (compact) 17.55.sp else 26.6.sp,
      letterSpacing = (-0.02).em,
    ),
    color = if (compact) MerryColors.tx2 else MerryColors.tx,
  )
}

@Composable
private fun EmptyNote(text: String, align: TextAlign) {
  if (text.isBlank()) return
  Text(
    text = text,
    textAlign = align,
    style = TextStyle(
      fontFamily = sans(13.sp),
      fontSize = 13.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.85.sp,
    ),
    color = MerryColors.tx2,
  )
}

/**
 * `.blank .fund.solid` — `--tx` ground, `--ink` text, and the label 24dp clear of
 * a ↗. That gap is unusually wide and it is authored, not a mistake.
 *
 * ONLY THE "we read it and there was nothing" ARM MAY HAVE THIS. `ReadEmpty`
 * (ui.tsx:225) gives an action to the ok state and to neither of the other two,
 * so a failed read can never be acted on as though it were an empty one. A
 * caller rendering a loading or unreadable state must pass no action.
 */
@Composable
private fun EmptyAction(label: String, onClick: () -> Unit) {
  Row(
    Modifier
      .heightIn(min = 44.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(MerryColors.tx)
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 11.dp),
    horizontalArrangement = Arrangement.spacedBy(24.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    val style = TextStyle(
      fontFamily = sans(13.sp, FontWeight.W600),
      fontSize = 13.sp,
      fontWeight = FontWeight.W600,
    )
    Text(label, style = style, color = MerryColors.ink)
    Text("↗", style = style, color = MerryColors.ink)
  }
}

/**
 * `.empty-art` — polish.css:208-217, drawn rather than approximated.
 *
 * A 170x116 box holding two rotated cards and three loose pixel clusters. The
 * `box-shadow` on two of the pixels is not a shadow at all: it is a cheap way to
 * draw extra 4x4 squares (`5px 0 #65764b, 0 5px #65764b` is two more squares),
 * so they are placed explicitly here.
 *
 * [compact] applies polish.css:219-222: the box becomes 102x70 with `zoom: .7`,
 * the cards shrink to 64x64 and shift left, and both rules disappear. `zoom`
 * scales LAYOUT as well as paint, which `graphicsLayer` does not — hence the
 * outer box fixed at the post-zoom 71x49 wrapping the pre-zoom drawing.
 */
@Composable
private fun EmptyArtwork(kind: EmptyKind, compact: Boolean) {
  if (compact) {
    Box(Modifier.size(71.dp, 49.dp)) {
      Box(
        Modifier
          .size(102.dp, 70.dp)
          .graphicsLayer(scaleX = 0.7f, scaleY = 0.7f, transformOrigin = TransformOrigin(0f, 0f)),
      ) { ArtworkBody(kind, w = 102.dp, h = 70.dp, card = 64.dp to 64.dp, backLeft = 7.dp, frontLeft = 22.dp, rules = false) }
    }
  } else {
    Box(Modifier.size(170.dp, 116.dp)) {
      ArtworkBody(kind, w = 170.dp, h = 116.dp, card = 88.dp to 96.dp, backLeft = 28.dp, frontLeft = 54.dp, rules = true)
    }
  }
}

private val ArtCardBorder = Color(0xFF3B4030)
private val ArtBackFill = Color(0xFF171A13)
private val ArtBackBorder = Color(0xFF2B3022)
private val ArtFrontTop = Color(0xFF282E20)
private val ArtFrontBottom = Color(0xFF191D14)
private val ArtIcon = Color(0xFFB9CA8D)
private val ArtRule = Color(0xFF505C3D)
private val ArtRuleShort = Color(0xFF38412C)
private val ArtPixelBright = Color(0xFF65764B)
private val ArtPixelDim = Color(0xFF3C462E)

@Composable
private fun BoxScope.ArtworkBody(
  kind: EmptyKind,
  w: Dp,
  h: Dp,
  card: Pair<Dp, Dp>,
  backLeft: Dp,
  frontLeft: Dp,
  rules: Boolean,
) {
  val (cw, ch) = card
  val cardShape = RoundedCornerShape(14.dp)

  // The back card: rotate(-12deg), no children.
  Box(
    Modifier
      .offset(x = backLeft, y = 8.dp)
      .size(cw, ch)
      .rotate(-12f)
      .clip(cardShape)
      .background(ArtBackFill)
      .border(1.dp, ArtBackBorder, cardShape),
  )

  // The front card: rotate(7deg), a 145deg gradient, and the glyph over two rules.
  Box(
    Modifier
      .offset(x = frontLeft, y = 5.dp)
      .size(cw, ch)
      .rotate(7f)
      .shadow(10.dp, cardShape)
      .clip(cardShape)
      .drawBehind {
        drawRect(
          Brush.linearGradient(
            colors = listOf(ArtFrontTop, ArtFrontBottom),
            start = Offset(size.width * 0.1005f, size.height * -0.0705f),
            end = Offset(size.width * 0.8995f, size.height * 1.0705f),
          ),
        )
      }
      .border(1.dp, ArtCardBorder, cardShape),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      LucideGlyph(kind, 30.dp, ArtIcon)
      if (rules) {
        Box(Modifier.size(34.dp, 2.dp).background(ArtRule, RoundedCornerShape(2.dp)))
        // `margin-top: -4px` against the column's 9px gap = an effective 5px.
        Box(Modifier.offset(y = (-4).dp).size(22.dp, 2.dp).background(ArtRuleShort, RoundedCornerShape(2.dp)))
      }
    }
  }

  // p1: left 13 / top 35, plus its two box-shadow squares at +5px right and down.
  ArtPixel(13.dp, 35.dp, ArtPixelBright)
  ArtPixel(18.dp, 35.dp, ArtPixelBright)
  ArtPixel(13.dp, 40.dp, ArtPixelBright)
  // p2: right 8 / bottom 30, plus one square 5px to its left.
  ArtPixel(w - 8.dp - 4.dp, h - 30.dp - 4.dp, ArtPixelDim)
  ArtPixel(w - 13.dp - 4.dp, h - 30.dp - 4.dp, ArtPixelDim)
  // p3: right 28 / top 7, alone.
  ArtPixel(w - 28.dp - 4.dp, 7.dp, ArtPixelDim)
}

@Composable
private fun BoxScope.ArtPixel(x: Dp, y: Dp, color: Color) {
  Box(Modifier.offset(x = x, y = y).size(4.dp).background(color))
}

/**
 * The seven lucide glyphs `ui.tsx:156-159` names, at lucide's `size={30}` and
 * `strokeWidth={1.35}` on a 24-unit viewBox.
 *
 * HAND-TRANSCRIBED. The web's node_modules is not checked in, so these are
 * written from the lucide set rather than extracted from the pinned build; a
 * curve may differ in detail. They are decorative — no reader learns anything
 * from them — so the risk is cosmetic, but it is worth re-extracting from the
 * real package when one is available.
 */
private object Lucide {
  val paths: Map<EmptyKind, List<String>> = mapOf(
    EmptyKind.Feed to listOf("M22 12h-4l-3 9L9 3l-3 9H2"),
    EmptyKind.Board to listOf(
      "M6 9H4.5a2.5 2.5 0 0 1 0-5H6",
      "M18 9h1.5a2.5 2.5 0 0 0 0-5H18",
      "M4 22h16",
      "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22",
      "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22",
      "M18 2H6v7a6 6 0 0 0 12 0V2Z",
    ),
    EmptyKind.Chat to listOf("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"),
    EmptyKind.Profile to listOf("M18 20a6 6 0 0 0-12 0"),
    EmptyKind.Search to listOf("m21 21-4.3-4.3"),
    EmptyKind.Positions to listOf(
      "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
      "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
      "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
    ),
    EmptyKind.Wallet to listOf(
      "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1",
      "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
    ),
  )

  /** The two glyphs whose lucide source uses a `<circle>` rather than a path. */
  val circles: Map<EmptyKind, Triple<Float, Float, Float>> = mapOf(
    EmptyKind.Profile to Triple(12f, 10f, 4f),
    EmptyKind.Search to Triple(11f, 11f, 8f),
  )

  const val STROKE = 1.35f
  const val VIEW = 24f
}

@Composable
private fun LucideGlyph(kind: EmptyKind, size: Dp, tint: Color) {
  val paths = (Lucide.paths[kind] ?: emptyList()).map { PathParser().parsePathString(it).toPath() }
  val circle = Lucide.circles[kind]
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / Lucide.VIEW
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = Lucide.STROKE, cap = StrokeCap.Round, join = StrokeJoin.Round)
      paths.forEach { drawPath(path = it, color = tint, style = stroke) }
      circle?.let { (cx, cy, r) ->
        drawCircle(color = tint, radius = r, center = Offset(cx, cy), style = stroke)
      }
    }
  }
}

/**
 * A DASHED ROUNDED BORDER, which `Modifier.border` cannot draw.
 *
 * Used by the compact empty state, and needed by the `.tag.unsettled` paper
 * marker whenever somebody builds it: terminal.css:6758 makes a pretend fill
 * DASHED and the sheet quotes read-token.ts on why — "a pretend fill must not
 * look like a real one". A solid border in a dimmer grey reads as
 * de-emphasised, not as not-real, so this helper exists rather than that
 * shortcut. Private here per the one-file rule; it wants lifting.
 */
private fun Modifier.dashedRoundedBorder(color: Color, width: Dp, radius: Dp): Modifier =
  this.drawBehind {
    val w = width.toPx()
    val dash = 3.dp.toPx()
    drawRoundRect(
      color = color,
      topLeft = Offset(w / 2f, w / 2f),
      size = Size(size.width - w, size.height - w),
      cornerRadius = CornerRadius(radius.toPx()),
      style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f)),
    )
  }

// ---------------------------------------------------------------------------
// CORRECTNESS VOCABULARY — unchanged, and deliberately so
// ---------------------------------------------------------------------------

/**
 * THE VERB FOR WHAT HAPPENED TO A DECISION — the client half of the rule the
 * web feed learned: a refused trade is not a purchase.
 *
 * Past tense is reserved for `landed`. Everything else is named for what it
 * actually was, because "bought" beside a trade the wall turned back is the
 * complaint that started all of this: "in the feed it says I've bought things
 * but nothing shows in my portfolio".
 */
fun verbOf(action: String?, outcome: String?, shadow: Boolean): String {
  val verb = action ?: "act"
  if (shadow || outcome == "shadow") return "would $verb"
  return when (outcome) {
    "refused", "reverted", "dropped" -> if (verb == "hold") "meant to hold" else "tried to $verb"
    "pending" -> if (verb == "hold") "is holding" else "is ${verb}ing"
    "landed" -> when (verb) {
      "buy" -> "bought"
      "sell" -> "sold"
      else -> "held"
    }
    else -> if (verb == "hold") "is holding" else "is ${verb}ing"
  }
}

/**
 * A trade that came to nothing must not wear the colour of one that didn't.
 *
 * `--up` and `--down` are only ever set as a text colour in terminal.css, never
 * as a ground, and `.wire-beat.turned` resets a turned-back row to plain `--card`
 * with a neutral rail specifically so it cannot read as a fill. Anything that
 * colours by ACTION rather than by OUTCOME reintroduces exactly that bug.
 */
fun toneOf(action: String?, outcome: String?): Color = when {
  outcome == "refused" || outcome == "reverted" || outcome == "dropped" -> Neutral
  outcome != "landed" -> Neutral
  action == "buy" -> Up
  action == "sell" -> Down
  else -> Neutral
}

/**
 * Kept so a screen can put the tab bar's clearance at the end of a scrolling
 * Column without reaching for the constant directly.
 */
@Composable
fun BottomInsetSpacer() {
  Spacer(Modifier.height(LocalBottomInset.current))
}
