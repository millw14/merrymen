package dev.merrymen.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.merrymen.app.LocalContainer
import kotlinx.coroutines.launch

/**
 * THE TWO SOCIAL CONTROLS, and the sentence each of them owes the reader.
 *
 * A LIKE AND A WIRE ARE NOT THE SAME GESTURE and the UI must not let them look
 * like it. A like is applause: it is displayed, it is counted, and it reaches
 * NOTHING that decides anything. A wire puts another desk's published thinking
 * into your own agent's next prompt, which is an input to a decision that
 * spends real money. So the wire control carries a budget, a sentence, and the
 * line about what it cannot do; the heart carries a number and nothing else.
 *
 * See data/Social.kt for the fence both sit behind.
 *
 * WHICH STYLESHEET RULE EACH ONE ACTUALLY OBEYS — read this before "fixing" a
 * value here against a grep:
 *
 *  - The heart is `.wire-like` (terminal.css:7196-7226), which is what
 *    `wire.tsx:229` renders. polish.css:26-29 defines a DIFFERENT, flatter
 *    `.feed-like` — a 21px glyph on a bare 44px row with no pill — and no
 *    component in web/src puts that class on anything. It is dead CSS from an
 *    earlier feed. The one thing taken from it is its `min-height: 44px`, which
 *    is the mobile sheet stating that the like control is a 44px touch target;
 *    see [LikeButton].
 *  - The wire control has NO live web appearance at all.
 *    `web/src/components/WireButton.tsx` exists and is imported by nothing, and
 *    the `.mm-wire` rules that would dress it live in `web/src/styles/agent.css`,
 *    which the terminal does not load. Its COPY is therefore ported verbatim
 *    from that component and its LOOK is assembled from live terminal rules,
 *    each cited at its call site. Anything else would be invented.
 */

/** `--ease`, terminal.css:624 — the only easing the terminal uses for colour. */
private val TerminalEase = CubicBezierEasing(0.2f, 0.7f, 0.3f, 1f)

/**
 * THE HEART GLYPH, from `wire.tsx:257-262` verbatim.
 *
 * A hand-drawn 24-unit path, not a Material icon and not a "♥" character. It is
 * stroked at 1.9 in viewBox units and additionally FILLED once the reader has
 * liked the post — the same two states the SVG's `fill` attribute switches
 * between. Material's Favorite / FavoriteBorder pair is a different silhouette
 * at a different weight, which is what this file used to draw.
 */
private const val HEART_PATH = "M12 20s-7-4.35-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 4.65-7 9-7 9z"

/** The SVG viewBox the path is authored in, and its stroke width in those units. */
private const val HEART_VIEW = 24f
private const val HEART_STROKE = 1.9f

/**
 * THE HEART — `.wire-like` inside `.wire-acts`.
 *
 * `terminal.css:7189` gives the slot `margin-top: 2px`; `terminal.css:7196`
 * gives the control itself:
 * `inline-flex; align-items:center; gap:5px; padding:4px 9px; border:1px solid var(--line); border-radius:999px; background:transparent; font-size:12px; line-height:1; color:var(--faint)`
 * with `.on` swapping the colour to `--down` and the border to
 * `color-mix(in srgb, var(--down) 45%, transparent)` — which is exactly
 * `Down.copy(alpha = 0.45f)` — over a 120ms `--ease` transition on colour and
 * border-colour only. `:disabled` is `opacity: .55` with NO colour change.
 *
 * THE 44dp BOX AROUND A 26dp PILL. The drawn pill is the web's, about 26dp
 * tall, which is under Android's touch floor. `polish.css:26` is the mobile
 * sheet's own statement that this control should be `min-height: 44px` on a
 * phone, so the touch box is 44dp and the pill inside it stays the size the web
 * draws it. Growing the pill itself would put a shape in the row the web does
 * not have.
 *
 * THREE RENDERINGS OF THE COUNT, and the second and third are the ones that
 * regress silently:
 *
 *   - a count we read — the number;
 *   - a count we could NOT read — an em dash, in `--faint` even while the heart
 *     is red. Never a 0: "nobody liked this" and "we could not ask" are
 *     different claims and only one of them is about the post;
 *   - a post with no id — nothing at all. An unslugged post has no stable name
 *     for a like to attach to, which is post-id.ts's intended consequence.
 *
 * WHERE THIS DELIBERATELY DIVERGES FROM THE WEB. `wire.tsx:251` renders the
 * count only when `likes.read && n > 0`, so an unread count and a real zero
 * both come out blank — two different facts with one appearance. This client
 * keeps them apart, and it keeps the read zero VISIBLE, because that is already
 * the house rule next door: `Bps` in Components.kt renders a read zero in the
 * primary colour precisely so "we read it and it did not move" stays distinct
 * from "we could not read it".
 *
 * A TAP THAT CANNOT BE STORED IS ANSWERED, NOT SWALLOWED. Where the web
 * disables the button and explains in a `title` attribute, a phone has no
 * hover, so the control stays tappable and says why instead — with the remedy
 * where there is one. The same four sentences the web puts in `title`
 * (`wire.tsx:235-243`) are mirrored into the accessibility label, so a screen
 * reader gets the explanation without having to tap.
 *
 * IT SAYS THE REMEDY; IT DOES NOT PERFORM IT. The first version called an
 * `onSignIn` that navigated straight to the sign-in flow, and on a real device
 * that meant tapping a HEART threw the reader out of the feed and into a wallet
 * signature ceremony — with the explanation flashing past on the way. A heart is
 * the smallest gesture in the product and it must not be the one that hijacks
 * where you are. The message names the tab; the reader decides.
 */
@Composable
fun LikeButton(postId: String?) {
  if (postId == null) return
  val c = LocalContainer.current
  val likes by c.social.likes.collectAsState()
  val scope = rememberCoroutineScope()
  // KEYED ON THE POST. A LazyColumn reuses a row's slot for a different post as
  // it scrolls, and an unkeyed `remember` would carry "we could not save that"
  // onto somebody else's thesis. Two posts CAN share an id — the same view with
  // a pending trade and a landed one — so this is a remember key and never a
  // LazyColumn item key, which must be unique or it crashes.
  var note by remember(postId) { mutableStateOf<String?>(null) }

  // Self-hosted: there is no likes route at all, and a dead heart is worse
  // than no heart.
  if (!likes.supported) return

  val mine = postId in likes.mine
  val count = likes.countOf(postId)

  // `transition: color 120ms var(--ease), border-color 120ms var(--ease)`.
  // Nothing else about the control animates — no ripple, no scale, no
  // background: the web has none of them.
  val tint by animateColorAsState(
    targetValue = if (mine) MerryColors.down else MerryColors.faint,
    animationSpec = tween(durationMillis = 120, easing = TerminalEase),
    label = "wire-like-colour",
  )
  val edge by animateColorAsState(
    targetValue = if (mine) MerryColors.down.copy(alpha = 0.45f) else MerryColors.line,
    animationSpec = tween(durationMillis = 120, easing = TerminalEase),
    label = "wire-like-border",
  )

  // The four `title` strings, in the order the TAP resolves them rather than the
  // order wire.tsx writes them — so what a reader is told before tapping is what
  // tapping will say. (The web checks `mineRead` first; signing out sets
  // `mineRead` back to true, so the two orders agree in every reachable state.)
  val label = when {
    !likes.signedIn -> "Sign in from the You tab to like posts"
    !likes.mineRead -> "Likes could not be loaded just now"
    mine -> "Remove your like"
    else -> "Like this post"
  }

  val pill = RoundedCornerShape(50)

  Column(Modifier.padding(top = 2.dp)) {
    Box(
      modifier = Modifier
        // `polish.css:26` — 44px of touch, around a pill the web draws at ~26px.
        .heightIn(min = 44.dp)
        .clickable(role = Role.Button) {
          note = null
          when {
            !likes.signedIn -> note = "Sign in from the You tab to like posts."
            !likes.mineRead ->
              note = "We could not reach your likes just now, so this would not be saved."
            else -> scope.launch { note = c.social.toggleLike(postId, !mine) }
          }
        }
        .semantics {
          contentDescription = label
          // The web's `aria-pressed`. It is the liked state and nothing else —
          // it must not be made to carry the count.
          stateDescription = if (mine) "Liked" else "Not liked"
        },
      contentAlignment = Alignment.CenterStart,
    ) {
      Row(
        modifier = Modifier
          // `.wire-like:disabled { opacity: .55 }` — opacity ONLY. The web
          // greys nothing and recolours nothing here, and the control stays
          // visible in every state because one that disappears teaches nobody
          // why. Unlike the web it also stays TAPPABLE, so it can answer.
          .alpha(if (likes.canLike) 1f else 0.55f)
          .clip(pill)
          .border(1.dp, edge, pill)
          .padding(horizontal = 9.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Heart(filled = mine, tint = tint)
        LikeCount(count = count, tint = tint)
      }
    }
    note?.let { NoteLine(it) }
  }
}

/**
 * `.wire-like svg` — 14x14 of the 24-unit path, stroked at 1.9 and filled as
 * well once the post is liked. The stroke scales with the glyph exactly as an
 * SVG's would because the width is applied inside the scaled draw scope.
 */
@Composable
private fun Heart(filled: Boolean, tint: Color) {
  val path = remember { PathParser().parsePathString(HEART_PATH).toPath() }
  Canvas(Modifier.size(14.dp)) {
    val s = size.minDimension / HEART_VIEW
    scale(s, s, pivot = Offset.Zero) {
      if (filled) drawPath(path = path, color = tint, style = Fill)
      drawPath(path = path, color = tint, style = Stroke(width = HEART_STROKE))
    }
  }
}

/**
 * The number beside the heart — `<span class="mono">` at the pill's inherited
 * 12px and `line-height: 1`, in the pill's current colour.
 *
 * THE EM DASH IS THE POINT, and it is `--faint` rather than the pill's colour:
 * "we could not ask" is not a fact about this post and must not wear the red
 * that says the reader liked it. Digits come from [numerals] because that is
 * where the web gets them; the dash is a letterform, so it comes from the prose
 * face.
 */
@Composable
private fun LikeCount(count: Int?, tint: Color) {
  val known = count != null
  Text(
    text = count?.toString() ?: "—",
    style = TextStyle(
      fontFamily = if (known) numerals(FontWeight.W400) else sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 12.sp,
    ),
    color = if (known) tint else MerryColors.faint,
  )
}

/**
 * WIRE THIS DESK INTO YOUR AGENT'S THINKING.
 *
 * NEVER A HEART, A STAR OR A BOOKMARK — the same four things that make it
 * legible as wiring on the web make it legible here, and the copy does most of
 * the work:
 *
 *   1. A VISIBLE BUDGET. `4 / 8`. A prompt has a context window; nobody caps
 *      bookmarks, so the denominator alone says what this is.
 *   2. The sentence underneath, which is permanent rather than a tooltip.
 *   3. That the sentence ends by saying what this CANNOT do — and that the
 *      last clause is BOLD, as `WireButton.tsx:66` writes it. It is the one
 *      piece of emphasis in the block and it is on the limit, not the feature.
 *
 * THE LAST LINE IS THE PRODUCT'S WHOLE POSITION ON FOLLOWING: a follow is an
 * input to a decision, never a trigger for one. An owner about to hand somebody
 * else's reasoning to something that spends their money is owed that sentence
 * before they tap, not after.
 *
 * WHERE THE LOOK COMES FROM, since the web component is unreachable and its
 * sheet is not loaded. `.mm-wire` is a SECTION with a bottom hairline and no
 * card, which is also how the terminal's own public profile builds a phone page
 * — `.public-strategy` is `padding: 22px 0` with no border and no ground
 * (terminal.css:4104), and `polish.css:133` strips borders and padding off
 * every `.account-section`. So this is an unboxed block, not a [SectionCard],
 * and it draws no horizontal padding of its own: the PAGE owns the gutter
 * (see PagePadH in Components.kt). A screen that renders this inside a
 * LazyColumn with no `contentPadding` will put it flush against the edge.
 */
@Composable
fun WireButton(slug: String, name: String, onSignIn: (() -> Unit)? = null) {
  val c = LocalContainer.current
  val wired by c.social.wired.collectAsState()
  val scope = rememberCoroutineScope()
  var note by remember { mutableStateOf<String?>(null) }

  val on = wired.has(slug)
  val full = !on && wired.full

  Column(
    modifier = Modifier
      .fillMaxWidth()
      // `.mm-wire { border-bottom: 1px solid var(--mm-edge) }`. Drawn before the
      // padding is applied so the hairline sits on the section's outer edge,
      // where a CSS border would be.
      .drawBehind {
        val t = 1.dp.toPx()
        drawRect(
          color = MerryColors.line,
          topLeft = Offset(0f, size.height - t),
          size = Size(size.width, t),
        )
      }
      .padding(vertical = 22.dp),
    // `.risk-note { margin: 10px 0 0 }` — the terminal's spacing between a
    // control and the sentences that explain it.
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    // NOT KNOWN IS NOT "FOLLOWS NOBODY". A signed-out viewer, a self-hosted
    // install and an unreachable route all land here, and each gets the reason
    // rather than a control that would fail on the tap.
    if (!wired.known) {
      WireProse(wired.why ?: "Checking what your agent reads…", MerryColors.tx)
      WireProse(
        "Wiring puts a desk’s published thinking into your own agent’s next prompt. You need an " +
          "agent for it to go into.",
        MerryColors.tx2,
      )
      if (onSignIn != null) FlowPrimary("Sign in", onSignIn)
      return@Column
    }

    Row(
      Modifier.fillMaxWidth(),
      // `--gap: 10px` is the wire's own column gap and the spacing this row of
      // control-plus-figure reads at everywhere else in the terminal.
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      WireToggle(
        label = if (on) "wired" else "wire in",
        on = on,
        enabled = !full,
      ) {
        note = null
        scope.launch { note = c.social.toggleWire(slug, !on) }
      }
      Budget(count = wired.wired.size, max = wired.max)
    }

    // The three sentences, verbatim from WireButton.tsx:63-78 including the
    // typographic apostrophes and the bold on the limit.
    Text(
      text = when {
        on -> buildAnnotatedString {
          append("Your agent reads ")
          append(name)
          append("’s theses before it decides. New ones go into its next prompt. ")
          withStyle(SpanStyle(fontWeight = FontWeight.W600, color = MerryColors.tx)) {
            append("Nothing here can make it trade.")
          }
        }
        full -> buildAnnotatedString {
          append(
            "Your agent already reads ${wired.max} desks, which is as many as fit in one prompt. " +
              "Unwire one to make room.",
          )
        }
        else -> buildAnnotatedString {
          append("Puts ")
          append(name)
          append("’s published theses into your agent’s next prompt, as one more thing to weigh. ")
          withStyle(SpanStyle(fontWeight = FontWeight.W600, color = MerryColors.tx)) {
            append("Nothing here can make it trade.")
          }
        }
      },
      style = WireProseStyle,
      color = MerryColors.tx2,
    )

    // `.mm-note.quiet` — the meta size in `--faint`. A timing caveat, not a
    // warning: it must not acquire a colour that reads as one.
    Text(
      text = "Takes effect the next time your agent arms.",
      style = TextStyle(
        fontFamily = sans(12.sp),
        fontSize = 12.sp,
        fontWeight = FontWeight.W400,
        lineHeight = 19.2.sp,
      ),
      color = MerryColors.faint,
    )

    note?.let { NoteLine(it) }
  }
}

/**
 * `.hosted-entry p` (terminal.css:6677) as polish.css leaves it on a phone:
 * 14px, line-height 1.6. The colour is the caller's, because this block uses
 * two: the REASON we cannot show the control is a statement at `--tx`, and the
 * explanation of what wiring is is secondary at `--tx-2`.
 */
private val WireProseStyle = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 22.4.sp,
)

@Composable
private fun WireProse(text: String, color: Color) {
  Text(text = text, style = WireProseStyle, color = color)
}

/**
 * THE WIRE TOGGLE.
 *
 * Geometry from `.hosted-account-links button` (polish.css:48-49, outside every
 * media query and therefore live on a phone):
 * `inline-flex; align-items:center; min-height:44px; padding:8px 12px; border:1px solid var(--line); border-radius:12px; color:var(--tx); font-size:12px`.
 *
 * The pressed state is the terminal's one and only "selected" treatment —
 * `.pill.on` / `.tag.on` / `.feed-views button[aria-pressed=true]` are all
 * `background:#ecece4; color:#111` — so it is off-white on ink, and the border
 * goes with the ground exactly as `.pill.on`'s does. IT IS NOT LIME AND IT IS
 * NOT `--up`: lime means live, `--up` means money moved, and neither of those
 * is what "your agent reads this desk" says.
 *
 * Full is `opacity: .55` and nothing else, per `.wire-like:disabled`
 * (terminal.css:7224). The terminal never expresses disabled with a colour.
 */
@Composable
private fun WireToggle(label: String, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier = Modifier
      .alpha(if (enabled) 1f else 0.55f)
      .heightIn(min = 44.dp)
      .clip(shape)
      .background(if (on) MerryColors.tx else Color.Transparent)
      .border(1.dp, if (on) Color.Transparent else MerryColors.line, shape)
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
      .semantics { stateDescription = if (on) "Wired in" else "Not wired in" }
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
      color = if (on) MerryColors.ink else MerryColors.tx,
    )
  }
}

/**
 * `4 / 8` — the denominator is the clearest statement in the product that this
 * is wiring and not a bookmark, so it is never abbreviated to a bare count and
 * never dropped when there is room.
 *
 * `.mm-wire .budget` is the meta size in the faint grey, and the web tags it
 * `.mono` for tabular figures; here that is [numerals], the same face the
 * browser resolves digits to.
 */
@Composable
private fun Budget(count: Int, max: Int) {
  Text(
    text = "$count / $max",
    modifier = Modifier.semantics { contentDescription = "$count of $max wired" },
    style = TextStyle(
      fontFamily = numerals(FontWeight.W400),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
    ),
    color = MerryColors.faint,
  )
}

/**
 * `.flow-primary` — terminal.css:416 as amended by terminal.css:4351:
 * `display:flex; align/justify center; width:100%; min-height:48px; padding:14px 18px; border-radius:12px; font-size:14px; font-weight:600; background:var(--tx); color:var(--ink)`.
 *
 * The base rule says `--lime`; the later one replaces it with `--tx`. The
 * terminal's only primary is off-white on near-black ink — there is no
 * accent-coloured button anywhere in the mobile shell.
 *
 * Private here per the one-file rule, and it wants lifting into Components.kt:
 * every account surface in the spec reaches for this same button.
 */
@Composable
private fun FlowPrimary(label: String, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier = Modifier
      .fillMaxWidth()
      .heightIn(min = 48.dp)
      .clip(shape)
      .background(MerryColors.tx)
      .clickable(role = Role.Button, onClick = onClick)
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
 * `.flow-error` — terminal.css:373: `font-size: 12px; color: var(--down); line-height: 1.5`,
 * rendered with `role="alert"`.
 *
 * This is the terminal's vocabulary for "the thing you just did did not
 * happen", which is exactly what both of these controls report. It is NOT the
 * amber refusal stamp (a rule declined) and NOT the `.desk-notice` slab (the
 * agent explaining why it is sitting still) — the three are separate treatments
 * in the sheet and collapsing them erases which kind of "no" this was.
 *
 * The live region is the phone's stand-in for `role="alert"`: the sentence
 * appears under a control the reader has just tapped, and a screen reader that
 * does not announce it leaves the tap looking like it worked.
 */
@Composable
private fun NoteLine(text: String) {
  Text(
    text = text,
    modifier = Modifier
      .padding(top = 6.dp)
      .semantics { liveRegion = LiveRegionMode.Assertive },
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.sp,
    ),
    color = MerryColors.down,
  )
}
