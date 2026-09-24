package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.TierView
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.shortAddress
import kotlinx.coroutines.launch

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
      .background(TabTagGround)
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
    TabSectionHeading("Positions", Modifier.padding(bottom = 12.dp))
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
    TabSectionHeading("Go", Modifier.padding(bottom = 12.dp))
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
