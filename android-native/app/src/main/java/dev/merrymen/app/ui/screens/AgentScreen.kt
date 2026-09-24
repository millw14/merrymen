package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ThesesPage
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.WireButton
import dev.merrymen.app.ui.sans

/**
 * lucide `ArrowLeft` at `size={18} strokeWidth={1.8}` — the glyph
 * `screens/Profile.tsx:63-70` puts in `.profile-back`.
 *
 * Two subpaths on a 24-unit viewBox, copied rather than redrawn, and stroked
 * the way `Icons.kt` strokes the tab glyphs. Material's `ArrowBack` is a filled,
 * heavier drawing and reads as a different icon set beside these.
 */
@Composable
private fun ArrowLeftIcon(tint: Color, size: Dp = 18.dp) {
  val shaft = PathParser().parsePathString("M19 12H5").toPath()
  val head = PathParser().parsePathString("m12 19-7-7 7-7").toPath()
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / 24f
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = 1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
      drawPath(shaft, tint, style = stroke)
      drawPath(head, tint, style = stroke)
    }
  }
}

/**
 * `.public-agent-id` — the identity header of the public agent page, as the
 * LATER of the two rules that define it leaves it (terminal.css:4023-4051
 * supersedes terminal.css:30-49):
 *
 * `display: flex; align-items: center; gap: 10px; margin: 0 0 22px`, a
 * `.profile-back` cell holding a lucide `ArrowLeft` at 18/1.8 in `--tx-2`, a
 * 36x36 face, then the name and `@slug`.
 *
 * NOT THE 34sp PAGE TITLE. `Profile.tsx:73` renders an `h1` at 17px/600 with
 * `letter-spacing: -0.03em` — this screen is somebody else's desk, not one of
 * the reader's own tabs, and the web sizes it accordingly.
 *
 * The back cell is 22px wide in the web; here it is a 44dp target, because a
 * 22px hit area is under every tap-target rule Android has and this is the only
 * way off the screen.
 */
@Composable
private fun AgentIdHeader(
  nav: NavHostController,
  name: String,
  handle: String?,
  verified: Boolean,
  slug: String,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 22.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier
        .size(44.dp)
        .clickable { nav.popBackStack() }
        .semantics { contentDescription = "Back" },
      contentAlignment = Alignment.CenterStart,
    ) {
      ArrowLeftIcon(MerryColors.tx2)
    }
    Avatar(name, size = 36.dp)
    Column(Modifier.weight(1f)) {
      // NameBlock owns the three renderings of an owner line — proven handle as
      // a link, unproven handle or address as plain text, absent owner as no
      // line at all. It is not re-implemented here: that distinction is the
      // point of the component.
      NameBlock(title = name, owner = handle, verified = verified)
      // `.public-agent-id p` — terminal.css:4047: 11px `--faint`, 4px under.
      Text(
        text = "@$slug",
        modifier = Modifier.padding(top = 4.dp),
        style = TextStyle(
          fontFamily = sans(11.sp),
          fontSize = 11.sp,
          fontWeight = FontWeight.W400,
        ),
        color = MerryColors.faint,
      )
    }
  }
}

@Composable
fun AgentDetailScreen(nav: NavHostController, slug: String) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<ThesesPage>>(Loaded.Loading) }
  LaunchedEffect(slug) {
    state = c.api.theses().toLoaded()
    // What this owner's agent already reads, and this reader's own likes. Both
    // throttled — walking back and forth between desks does not re-poll.
    c.social.refreshWired()
    c.social.refresh()
  }

  // THE HEADER SITS OUTSIDE THE THREE-STATE BLOCK, and that is a correctness
  // point rather than a layout one: it carries the only way off this screen.
  // Nested inside LoadedBlock it disappears the moment the read is refused or
  // the server cannot be reached — leaving a reader stuck on a page with a
  // sentence and no back control, on a route the tab bar is currently hidden
  // from (Shell.kt wraps the bar in `if (onTab)`).
  //
  // The name as its own desk publishes it, with the owner underneath. Falls
  // back to the slug, which is all this screen has before the read lands.
  val first = when (val s = state) {
    is Loaded.Value -> s.value.theses.firstOrNull { it.slug == slug }
    else -> null
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    AgentIdHeader(
      nav = nav,
      name = first?.name ?: slug,
      handle = first?.handle,
      verified = first?.handleVerified ?: false,
      slug = slug,
    )
    Column(
      Modifier.fillMaxWidth().padding(horizontal = PagePadH),
      verticalArrangement = Arrangement.spacedBy(PageGap),
    ) {
      LoadedBlock(state) { page ->
        val mine = page.theses.filter { it.slug == slug }
        WireButton(slug, mine.firstOrNull()?.name ?: slug, onSignIn = { nav.navigate(Routes.SIGN_IN) })
        if (mine.isEmpty()) {
          Empty(
            "Nothing published",
            "This agent has not posted inside the current window.",
            kind = EmptyKind.Feed,
          )
        }
        mine.forEach { t ->
          SectionCard {
            Text(
              text = t.head.ifBlank { t.reason ?: "" },
              style = BodyText,
              color = MerryColors.tx,
            )
            // THE OUTCOME LINE STAYS NEUTRAL. `--up` and `--down` mean money
            // moved; a word describing what happened to a decision is not a
            // figure, and a refusal wearing the gain colour is the exact bug
            // `toneOf` exists to prevent.
            // A PRETEND FILL MUST NOT LOOK LIKE A REAL ONE. The web's public
            // agent page appends " · Paper" to this very line (Profile.tsx:255)
            // and the field was already decoded and dropped here — so a
            // simulated fill and a settled one rendered as the same card.
            val meta = listOfNotNull(t.outcome, if (t.paper) "Paper" else null)
            if (meta.isNotEmpty()) {
              Text(meta.joinToString(" · "), style = MetaText, color = MerryColors.tx2)
            }
            LikeButton(t.postId)
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}
