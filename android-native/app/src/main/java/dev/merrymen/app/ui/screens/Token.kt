package dev.merrymen.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.net.TokenHolder
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BOTTOM_INSET
import dev.merrymen.app.ui.Bar
import dev.merrymen.app.ui.ChartKind
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.PriceChart
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.abs

/**
 * ONE TOKEN: its price, its chart, and who is holding it.
 *
 * The old version of this screen asked `/api/market` for the whole list and
 * picked one row out of it, which is why it could show a price and nothing else:
 * the list route knows no holders, no bars and nothing the index says. This one
 * asks `/api/tokens/{address}`, which answers all three.
 *
 * TWO DIFFERENT SOURCES OF BARS, because there are two different kinds of
 * token. A stock or ETF has a real venue behind it and its bars come through
 * our own proxy; a launchpad coin has a pool, and its bars come back inside the
 * token document itself. A client that only implemented one of them would have
 * a chart on a quarter of the registry.
 *
 * WHY THIS SCREEN HAS NO CARDS. `web/src/terminal/screens/Token.tsx` renders a
 * bare `.token` column — `display:flex; flex-direction:column; gap:0`
 * (terminal.css:1131) — of five blocks with no surfaces, no borders and no
 * radii anywhere. The only rounded thing on it is the selected timeframe
 * button. Every `SectionCard`, `Notice` and `Pill` this file used to draw was a
 * box the web does not draw, so they are gone; the honesty renderings they used
 * to carry are still here, restyled into the terminal's flat idiom.
 *
 * THE GUTTER IS 20px, NOT 18. `terminal.css:678` says `.body { padding: 18px
 * 18px calc(--nav + 32px) }` and `terminal.css:1257` says `.token-body {
 * padding-bottom: calc(--nav + 40px) }` — and BOTH are overruled on a phone by
 * `polish.css:87`, `.terminal-host .app > .body { padding: 16px 20px
 * calc(100px + env(safe-area-inset-bottom)) }`. That selector is (0,3,0)
 * against the base sheet's (0,1,0) `:where()` rules, so it wins outright, and
 * the token screen's own bottom override never applies. Hence [PagePadH] /
 * [PagePadTop] / [BOTTOM_INSET] — the same three constants every other screen
 * uses — rather than the 18/18/116 the base sheet appears to promise.
 *
 * That correction matters twice: `.token-plot { margin: 0 -18px }`
 * (terminal.css:1253) cancels 18 of the gutter's 20, so the chart is NOT
 * full-bleed — it stops 2px short of each screen edge — and the dither axis
 * strip's `padding-inline: 18px` (terminal.css:4747) puts it back level with
 * the body text. See [bleed].
 */

/**
 * The six spans, taken from CHART_WINDOWS in web/src/lib/venue.ts.
 *
 * A SPAN IS NOT A BAR SIZE, and conflating them is the bug this pair of tables
 * exists to prevent. "1H" means one hour of history; the coin route's `window`
 * means how wide each bar is, and it accepts exactly four values — anything else
 * silently becomes hourly. So the span picks a bar size, and then the span is
 * applied by TRIMMING the series. Never by padding: a token with two hours of
 * history under a 1M button is two hours of history, not a month of blanks.
 */
private val WINDOWS = listOf("1H", "4H", "1D", "5D", "1M", "ALL")

private fun barSizeFor(window: String): String = when (window) {
  "1H", "4H" -> "15m"
  "1M", "ALL" -> "1d"
  else -> "1h"
}

/** How much history each span claims. ALL trims nothing. */
private val WINDOW_SECONDS: Map<String, Long> = mapOf(
  "1H" to 3_600L,
  "4H" to 14_400L,
  "1D" to 86_400L,
  "5D" to 432_000L,
  "1M" to 2_592_000L,
)

/**
 * The cut the stock venue applies to its own answer.
 *
 * Yahoo has no one-hour range, so the proxy asks for a day of one-minute bars
 * and the last hour is taken from the tail. Mirrored from CHART_WINDOWS.
 */
private val VENUE_CUT: Map<String, Long> = mapOf("1H" to 3_600L, "4H" to 14_400L)

private fun trim(bars: List<Bar>, seconds: Long?): List<Bar> {
  if (seconds == null || bars.isEmpty()) return bars
  val end = bars.last().time
  return bars.filter { it.time >= end - seconds }
}

/**
 * A coin's bars, off the token document.
 *
 * `uiMultiplier` is deliberately NOT applied here: it is a stock-contract
 * concept (a corporate action rebasing the on-chain unit), and a curve coin has
 * no such field. Multiplying a coin's bars by a number that does not exist for
 * it is how a chart quietly moves by 1e18.
 */
private fun coinBars(candles: CandleRead?, window: String): List<Bar> {
  val list = candles?.candles ?: return emptyList()
  val bars = list.map { Bar(it.t, it.o, it.h, it.l, it.c) }
  return trim(bars, WINDOW_SECONDS[window])
}

/**
 * A stock's bars, through the venue proxy.
 *
 * A BAR WITH ANY NULL IN IT IS DROPPED, not interpolated. Yahoo's arrays are
 * nullable at every index — a halted minute is four nulls — and filling them in
 * draws a line through a price that never existed. Then `uiMultiplier` is
 * applied, because the on-chain unit is what the rest of this screen quotes.
 */
private suspend fun stockBars(
  api: MerrymenApi,
  symbol: String,
  window: String,
  multiplier: Double,
): Loaded<List<Bar>> = when (val r = api.venueChart(symbol, window)) {
  is ApiResult.Ok -> {
    val row = r.value.chart?.result?.firstOrNull()
    val q = row?.indicators?.quote?.firstOrNull()
    val ts = row?.timestamp ?: emptyList()
    val out = ArrayList<Bar>(ts.size)
    if (q != null) {
      for (i in ts.indices) {
        val o = q.open.getOrNull(i)
        val h = q.high.getOrNull(i)
        val l = q.low.getOrNull(i)
        val c = q.close.getOrNull(i)
        if (o == null || h == null || l == null || c == null) continue
        out.add(Bar(ts[i], o * multiplier, h * multiplier, l * multiplier, c * multiplier))
      }
    }
    // ONE TRIM, NOT TWO. The web trims a STOCK series only by the venue's own
    // `cut` (VENUE_CUT), because the range it asked the venue for already
    // matches the span; WINDOW_SECONDS is the COIN path's trimmer. Applying both
    // over-clipped 5D/1M so the chart showed fewer sessions than its label — and
    // the change line under the price, computed off the first drawn bar, then
    // read the wrong span. bars.ts trims stocks by cut alone.
    Loaded.Value(trim(out, VENUE_CUT[window]))
  }
  is ApiResult.Refused -> Loaded.Refused(r.status, r.message)
  is ApiResult.Unreachable -> Loaded.Unreachable(r.cause)
}

@Composable
fun TokenDetailScreen(nav: NavHostController, address: String) {
  val c = LocalContainer.current
  val ctx = LocalContext.current
  val scope = rememberCoroutineScope()

  var detail by remember { mutableStateOf<Loaded<TokenDetail>>(Loaded.Loading) }
  var bars by remember { mutableStateOf<Loaded<List<Bar>>>(Loaded.Loading) }
  var window by remember { mutableStateOf("1D") }
  var kind by remember { mutableStateOf(ChartKind.CANDLE) }
  var said by remember { mutableStateOf<String?>(null) }
  var copied by remember { mutableStateOf(false) }

  val watched by c.session.watchlist.collectAsState(initial = emptySet())
  // The Android watchlist keys on the LOWERCASED address; the web's
  // `watchlist.ts` stores `token.id` verbatim and tests membership
  // case-sensitively. Neither list ever leaves its own device, so the two
  // cannot disagree in public — but they are different keys, and this is the
  // one that is here.
  val starred = address.lowercase() in watched

  // `{copied ? "Copied" : shortId(token.id)}` with a 1200ms timer
  // (Token.tsx:126-133). The success signal lives in the button's own label, so
  // a clipboard write that WORKED never needs the status line — which is left
  // free to say the one thing that matters, that it did not.
  LaunchedEffect(copied) {
    if (copied) {
      delay(1200)
      copied = false
    }
  }

  // Refetched on the SPAN because a coin's bars travel inside the token
  // document and their size depends on it. A stock refetch is a second call, and
  // both are cached upstream for minutes.
  LaunchedEffect(address, window) {
    bars = Loaded.Loading
    val d = c.api.token(address, barSizeFor(window)).toLoaded()
    detail = d
    val t = (d as? Loaded.Value)?.value
    bars = when {
      t == null -> Loaded.Loading
      t.market.kind == "memecoin" -> Loaded.Value(coinBars(t.candles, window))
      else -> {
        // The registry's ticker, not the ledger's: the ledger only knows a
        // symbol for a token some agent already holds, so a stock nobody has
        // bought had no symbol to ask the venue about.
        val sym = t.market.symbol ?: t.market.stock?.symbol ?: t.ledger.symbol
        if (sym == null) Loaded.Value(emptyList())
        else stockBars(c.api, sym, window, t.market.stock?.uiMultiplier ?: 1.0)
      }
    }
  }

  val loaded = (detail as? Loaded.Value)?.value
  // Unchanged from the previous version of this screen, and it is also what the
  // share sheet is titled with.
  val shareName = loaded?.let {
    it.market.symbol ?: it.ledger.symbol ?: it.market.coin?.name
  } ?: "This token"

  Box(Modifier.fillMaxSize()) {
    Column(
      Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Column(
        Modifier
          // `.app { width: 100%; max-width: 430px; margin: 0 auto }`,
          // terminal.css:670-676.
          .widthIn(max = 430.dp)
          .fillMaxWidth()
          .padding(
            start = PagePadH,
            end = PagePadH,
            top = PagePadTop,
            // The bar does not render over this route today (Shell draws it
            // only on the five tabs), so this is trailing space rather than
            // clearance — but it is the same number the web reserves, and it
            // follows the bar if the route is ever given one.
            bottom = maxOf(BOTTOM_INSET, LocalBottomInset.current),
          ),
      ) {
        TokenTop(
          symbol = loaded?.let { it.market.symbol ?: it.ledger.symbol ?: it.market.coin?.name },
          fullName = loaded?.market?.stock?.name ?: loaded?.market?.coin?.name,
          kind = loaded?.market?.kind,
          address = address,
          copied = copied,
          starred = starred,
          onBack = { nav.popBackStack() },
          onCopy = {
            val failure = copy(ctx, address)
            if (failure == null) copied = true
            said = failure
          },
          onStar = {
            scope.launch {
              c.session.toggleWatch(address)
              // DEVICE-LOCAL, and the note under it says so. A star here does
              // not appear on the web, because neither watchlist has ever left
              // the device it was made on. The web says nothing at all here and
              // is quietly wrong to; matching that silence would be a
              // regression, so the sentence stays.
              said = if (starred) null else "Starred on this device. The web keeps its own list."
            }
          },
          onShare = { scope.launch { said = share(ctx, c.repo.originNow(), address, shareName) } },
        )

        said?.let { StatusLine(it) }

        LoadedBlock(
          detail,
          onRetry = {
            scope.launch { detail = c.api.token(address, barSizeFor(window)).toLoaded() }
          },
        ) { t ->
          // BOTH TICKERS ARE ATTACKER-CHOSEN, and theses are matched to a page
          // by symbol. Without this an agent's real reasoning about NVDA prints
          // on an impostor's page, attributed to a holder of the impostor. The
          // web says the narrower half of this in the holders section
          // (Token.tsx:290); the sentence below says why the whole page needs
          // reading with care, which is where it belongs, so it sits under the
          // identity it qualifies. It used to be a bordered Notice card — the
          // card is gone, every word of it is not.
          if (t.market.symbolClash) {
            Column(Modifier.padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
              Text(
                "Another listed token shares this ticker",
                style = TextStyle(
                  fontFamily = sans(13.sp, FontWeight.W600),
                  fontSize = 13.sp,
                  fontWeight = FontWeight.W600,
                  lineHeight = 17.55.sp,
                ),
                color = MerryColors.tx,
              )
              Meta(
                "A ticker is a string whoever deployed the token picked. Check the address " +
                  "before you read anything here as being about the listed one.",
              )
            }
          }

          val list = (bars as? Loaded.Value)?.value.orEmpty()
          Hero(
            price = t.market.stock?.priceUsd ?: t.market.coin?.priceUsd,
            fdvUsd = t.market.coin?.fdvUsd,
            bars = list,
            window = window,
          )

          PriceNotes(t)

          // `.token-plot` and everything inside it. The chart, its caption and
          // the tools row all live in the near-full-bleed block; the caption is
          // given the axis strip's own 18px inset so it lands level with the
          // body text rather than 2px from the screen edge.
          Column(Modifier.bleed(18.dp).padding(bottom = 8.dp)) {
            ChartPane(bars, kind, t)
            ChartTools(
              window = window,
              onWindow = { window = it },
              kind = kind,
              onKind = { kind = it },
            )
          }

          Holders(t, nav)
        }
      }
    }

    // `.token-body::after` — terminal.css:1262-1275. A fixed, non-interactive
    // 96px scrim so content dissolves into the ground rather than being cut off
    // at the bottom edge. It is a sibling of the scroller here rather than a
    // pseudo-element of it, because Compose has no fixed positioning inside a
    // scroll container; visually it is the same thing.
    Box(
      Modifier
        .align(Alignment.BottomCenter)
        .widthIn(max = 430.dp)
        .fillMaxWidth()
        .height(96.dp)
        .background(
          Brush.verticalGradient(
            0f to MerryColors.bg.copy(alpha = 0f),
            0.58f to MerryColors.bg,
            1f to MerryColors.bg,
          ),
        ),
    )
  }
}

// ---------------------------------------------------------------------------
// HEADER
// ---------------------------------------------------------------------------

/**
 * `.token-top` — terminal.css:1137-1142.
 *
 * `grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 10px`.
 * No padding, no border, no ground: three slots on the page.
 *
 * THE BACK CONTROL IS TEXT. `Token.tsx:150-157` renders the literal glyph "←"
 * (U+2190) with `.back { color: var(--tx-2); font-size: 15px; font-weight: 600;
 * line-height: 1 }` — not an icon, not a circle, and with no ripple surface
 * under it. It renders before the token has arrived, because the way out of a
 * screen must not depend on the screen having loaded.
 *
 * The 22x36 tap target is the web's 22px column at the row's own height. That
 * is under Android's 48dp guidance and it is deliberate: growing it changes the
 * header's geometry, which is a product decision rather than a restyle. Same
 * for the two 36x36 action buttons.
 */
@Composable
private fun TokenTop(
  symbol: String?,
  fullName: String?,
  kind: String?,
  address: String,
  copied: Boolean,
  starred: Boolean,
  onBack: () -> Unit,
  onCopy: () -> Unit,
  onStar: () -> Unit,
  onShare: () -> Unit,
) {
  Row(
    Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.width(22.dp).height(36.dp).tap("Back", onBack),
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

    // `.token-who { display: flex; align-items: center; gap: 10px; min-width: 0 }`
    Row(
      Modifier.weight(1f),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      TokenCoin(symbol.orEmpty(), 36.dp)
      Column(Modifier.weight(1f)) {
        if (symbol != null) {
          Row(
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text(
              text = symbol,
              // `.token-top h1 { font-size: 17px; letter-spacing: -0.03em }`
              // over the sheet's `h1 { margin: 0; font-weight: 600 }`.
              style = TextStyle(
                fontFamily = sans(17.sp, FontWeight.W600),
                fontSize = 17.sp,
                fontWeight = FontWeight.W600,
                letterSpacing = (-0.03).em,
              ),
              color = MerryColors.tx,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.weight(1f, fill = false),
            )
            // `{token.kind !== "memecoin" && <i className="verified"/>}`.
            // A memecoin must never get this badge: it means the asset is a
            // registered tokenized security, which is a claim about the issuer.
            if (kind != null && kind != "memecoin") VerifiedBadge()
          }
        }
        // `.token-sub` — terminal.css:1187-1200.
        Row(
          Modifier.padding(top = 2.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          if (fullName != null) {
            Text(
              text = fullName,
              style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
              color = MerryColors.faint,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.weight(1f, fill = false),
            )
          }
          Text(
            text = if (copied) "Copied" else shortId(address),
            // `--mono` is used on exactly one element on this whole screen, and
            // this is it. An address is a string to compare character by
            // character, so the characters must be the same width.
            style = TextStyle(
              fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
              fontSize = 11.sp,
            ),
            color = MerryColors.tx2,
            modifier = Modifier.tap("Copy the token address", onCopy),
          )
        }
      }
    }

    // `.token-acts { gap: 2px }`, each button 36x36 at `--tx-2`, and `--tx`
    // when on. THERE IS NO ACCENT ON THIS SCREEN: the watched star does not go
    // lime or gold, it goes from the secondary text colour to the primary one.
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
      Box(
        Modifier.size(36.dp).tap(if (starred) "Watching" else "Watch", onStar),
        contentAlignment = Alignment.Center,
      ) {
        StarGlyph(starred, if (starred) MerryColors.tx else MerryColors.tx2)
      }
      Box(
        Modifier.size(36.dp).tap("Share", onShare),
        contentAlignment = Alignment.Center,
      ) {
        ShareGlyph(MerryColors.tx2)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HERO
// ---------------------------------------------------------------------------

/**
 * `.token-hero` — terminal.css:1220-1251, `Token.tsx:194-215`.
 *
 * `display: flex; align-items: flex-end; justify-content: space-between; gap:
 * 16px; margin: 16px 0 14px`. `align-items: flex-end` is literal and it
 * matters: the 44px price and the 16px fully-diluted figure share a bottom
 * edge, which is what makes the pair read as one line.
 *
 * THE CHANGE IS OVER THE SELECTED SPAN, NOT OVER 24 HOURS. `Token.tsx:103-110`
 * computes it from the bars the chart is drawing — `(last.close - first.open) /
 * first.open` — and prints the span id after it. This screen used to render
 * `coin.change24hPct` in that position, which is a different quantity from the
 * one the label names: tap 1H and the figure did not move.
 *
 * AND IT IS ABSENT, NOT ZERO, WHEN IT CANNOT BE COMPUTED. No bars, or a first
 * open of zero, and the whole line is skipped — no dash, no "0.00%", and in
 * particular no green. `Token.tsx:112` coalesces the same null to zero for the
 * CHART's colour (`const down = (winPct ?? 0) < 0`) and live.ts:283-296 names
 * that pattern as the bug `deltaClass` exists to fix. The text escapes it by
 * being gated on `winPct != null`, and that gate is kept here.
 */
@Composable
private fun Hero(price: Double?, fdvUsd: Double?, bars: List<Bar>, window: String) {
  val first = bars.firstOrNull()
  val last = bars.lastOrNull()
  val winPct = if (first != null && last != null && first.open > 0.0) {
    ((last.close - first.open) / first.open) * 100.0
  } else {
    null
  }
  val winDol = if (first != null && last != null) last.close - first.open else null

  Row(
    Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 14.dp),
    horizontalArrangement = Arrangement.spacedBy(16.dp),
    verticalAlignment = Alignment.Bottom,
  ) {
    Column(Modifier.weight(1f)) {
      Text(
        text = coinPrice(price),
        // `.price { font-size: 44px; line-height: 1; letter-spacing: -0.03em;
        // font-weight: 500 }`.
        style = TextStyle(
          fontFamily = numerals(FontWeight.W500),
          fontSize = 44.sp,
          fontWeight = FontWeight.W500,
          lineHeight = 44.sp,
          letterSpacing = (-0.03).em,
        ),
        color = MerryColors.tx,
        maxLines = 1,
      )
      if (winPct != null && winDol != null) {
        val down = winPct < 0.0
        Text(
          text = "${if (down) "▼" else "▲"} ${money(abs(winDol))} ${pctPts(winPct)} $window",
          style = TextStyle(
            fontFamily = numerals(FontWeight.W600),
            fontSize = 13.sp,
            fontWeight = FontWeight.W600,
          ),
          color = if (down) MerryColors.down else MerryColors.up,
          modifier = Modifier.padding(top = 6.dp),
        )
      }
    }
    // `{token.fdvUsd != null && <div className="token-mc">…}` — the block is
    // not rendered at all when there is no figure, rather than rendered with a
    // dash. A stock has no fully-diluted value, so this is a coin-only block.
    if (fdvUsd != null) {
      Column(horizontalAlignment = Alignment.End) {
        Text(
          text = compactUsd(fdvUsd),
          style = TextStyle(
            fontFamily = numerals(FontWeight.W600),
            fontSize = 16.sp,
            fontWeight = FontWeight.W600,
            letterSpacing = (-0.03).em,
          ),
          color = MerryColors.tx,
        )
        Text(
          text = "Fully diluted value",
          style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
          color = MerryColors.faint,
          modifier = Modifier.padding(top = 3.dp),
        )
      }
    }
  }
}

/**
 * THE THINGS THE MOBILE WEB DOES NOT SAY ABOUT THIS PRICE, AND SHOULD.
 *
 * None of these three has a counterpart in `Token.tsx`: the five-figure
 * `.token-market-strip` that would carry the first of them is `display: none`
 * at top level (terminal.css:4809) and only becomes a grid inside
 * `@media (min-width: 1100px)`. So a phone shows a 44px price with nothing
 * qualifying it. Restyling to match would have carried that hole across, so the
 * sentences stay and only their dressing changes — flat `.meta` type on the
 * page ground, no cards, no borders, no amber.
 */
@Composable
private fun PriceNotes(t: TokenDetail) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    // A HALT MAY ONLY BE ASSERTED WHEN THE CHAIN ANSWERED. Null is our own
    // uncertainty and says so; it is never rendered as "trading normally".
    when (t.market.stock?.paused) {
      true -> Text(
        text = "Trading is halted on this token.",
        style = TextStyle(
          fontFamily = sans(13.sp, FontWeight.W600),
          fontSize = 13.sp,
          fontWeight = FontWeight.W600,
          lineHeight = 17.55.sp,
        ),
        // NOT `--down`. A halt is not a loss, and the two colours on this
        // screen that mean money moved may not be spent on anything else.
        color = MerryColors.tx,
      )
      null -> if (t.market.kind != "memecoin") {
        Meta("We could not read whether trading is halted.")
      }
      false -> Unit
    }

    // ON-CURVE RESERVE IS MOSTLY VIRTUAL SEED — a fresh curve reports about
    // $4,100 of "reserve" while holding none of it — so it is never presented
    // as money anybody could sell into.
    if (t.market.coin?.onCurve == true) {
      Meta(
        "Still on its bonding curve. The depth the index reports for a curve is mostly a " +
          "virtual seed, not money you could sell into.",
      )
    }
  }
}

// ---------------------------------------------------------------------------
// THE CHART
// ---------------------------------------------------------------------------

/**
 * The chart, or the reason there is not one — and those reasons are not
 * interchangeable.
 *
 * `mismatch` and `none` are facts about the POOL. `refused` is a fact about our
 * read. Rendering the third as either of the first two states something about a
 * token out of our own outage, which is the rule this whole repo is built on.
 *
 * THE WEB COLLAPSES ALL OF THEM. `Token.tsx:217` prints one sentence — "Price
 * history unavailable. Try another timeframe." — whether the venue refused, the
 * pool published nothing, or the fetch timed out, because `loadBars` catches
 * everything and returns `[]` (bars.ts:80). So what is matched here is its
 * TYPOGRAPHY (`.meta`: 12px, `--tx-2`, terminal.css:704) and not its
 * conflation.
 */
@Composable
private fun ChartPane(bars: Loaded<List<Bar>>, kind: ChartKind, t: TokenDetail) {
  val candles = t.candles
  when (bars) {
    is Loaded.Value ->
      if (bars.value.isEmpty()) {
        ChartStatus(
          when {
            candles?.state == "mismatch" ->
              "The index has bars for this pool, but they are about the other side of the pair — " +
                "so they are not this token's prices and are not drawn."
            candles?.state == "none" -> "This pool has published no bars in that span."
            candles?.state == "refused" -> "We could not read the price series just now."
            else -> "No bars for that span."
          },
        )
      } else {
        // THE NEWEST BAR IS ALWAYS PARTIAL — measured at one minute into an
        // hour, one sixtieth complete — so it is drawn faint and said out loud.
        val partial = candles?.lastBarAgeSec?.let { candles.interval > 0 && it < candles.interval } ?: true
        PriceChart(bars.value, kind, partialLast = partial)
        val gaps = candles?.gaps ?: 0
        ChartCaption(
          // Each clause closes itself. Built the other way round, a series with
          // no label and no gaps read "79 bars The newest bar is still forming"
          // — two sentences run together, which is what a caption assembled from
          // optional parts does unless every part ends itself.
          buildString {
            append(bars.value.size)
            append(if (bars.value.size == 1) " bar" else " bars")
            candles?.label?.takeIf { it.isNotBlank() }?.let { append(", ").append(it) }
            append(".")
            if (gaps > 0) {
              append(" ")
              append(gaps)
              append(" periods published nothing and are left out rather than drawn across.")
            }
            if (partial) append(" The newest bar is still forming, so it is drawn faint.")
          },
        )
      }
    is Loaded.Refused -> ChartStatus(
      "The chart venue said no (${bars.status}). That is our read failing, not a price.",
    )
    is Loaded.Unreachable -> ChartStatus("We could not reach the chart venue: " + bars.cause)
    // U+2026, as the web writes it — not three periods.
    else -> ChartStatus("Loading the chart…")
  }
}

/**
 * `.tv-tools` — terminal.css:1550-1596.
 *
 * `margin: 0 12px; padding: 6px 0 2px; gap: 8px`, measured from the plot's own
 * edges, which sit 2px inside the screen. IT SITS BELOW THE CHART ON A PHONE:
 * the `order: -1` that lifts it above lives inside `@media (min-width: 1100px)`
 * (terminal.css:5440).
 *
 * The six windows share the row equally — `.tv-windows { flex: 1 }` and each
 * button `flex: 1` inside it — so they stretch rather than scrolling as pills,
 * which is what this row used to be. The selected one takes `--raised` at an
 * 8px radius and `--tx`; the rest have no ground at all. The chart-kind pair is
 * 32x32 each with no ground, no border and no radius: the selection there is
 * colour and nothing else.
 *
 * THE RESET BUTTON IS DELIBERATELY MISSING. The web's third control
 * (`RotateCcw`, "Reset chart view") bumps a key that remounts lightweight-charts
 * and refits it to the data. Nothing on this screen pans or zooms, so the
 * button would be a control that visibly does nothing — worse than its absence.
 */
@Composable
private fun ChartTools(
  window: String,
  onWindow: (String) -> Unit,
  kind: ChartKind,
  onKind: (ChartKind) -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(horizontal = 12.dp)
      .padding(top = 6.dp, bottom = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
      WINDOWS.forEach { id ->
        val on = window == id
        Box(
          Modifier
            .weight(1f)
            .clip(RoundedCornerShape(8.dp))
            .background(if (on) MerryColors.raised else Color.Transparent)
            .tap(null) { onWindow(id) }
            .padding(vertical = 6.dp),
          contentAlignment = Alignment.Center,
        ) {
          Text(
            text = id,
            style = TextStyle(
              fontFamily = sans(11.sp, FontWeight.W600),
              fontSize = 11.sp,
              fontWeight = FontWeight.W600,
              lineHeight = 11.sp,
            ),
            color = if (on) MerryColors.tx else MerryColors.faint,
          )
        }
      }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
      Box(
        Modifier.size(32.dp).tap("Candles") { onKind(ChartKind.CANDLE) },
        contentAlignment = Alignment.Center,
      ) {
        CandleGlyph(if (kind == ChartKind.CANDLE) MerryColors.tx else MerryColors.faint)
      }
      Box(
        // The web labels this control "Dither area" because its line mode is
        // not a line: it swaps in an ordered-dither canvas. Chart.kt draws an
        // honest polyline instead and says so, so calling the button "Dither
        // area" here would name a renderer this client does not have. The GLYPH
        // is the web's (lucide ChartArea at 18px, strokeWidth 1.8); the label
        // describes what the tap actually does.
        Modifier.size(32.dp).tap("Line") { onKind(ChartKind.LINE) },
        contentAlignment = Alignment.Center,
      ) {
        ChartAreaGlyph(if (kind == ChartKind.LINE) MerryColors.tx else MerryColors.faint)
      }
    }
  }
}

/** The chart's own `<p class="meta" role="status">`, at the body's left edge. */
@Composable
private fun ChartStatus(text: String) {
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 16.2.sp),
    color = MerryColors.tx2,
    modifier = Modifier
      // `.token-plot` is 2px from the screen edge and `.meta` adds no padding
      // of its own, so on the web this sentence sits 18px to the LEFT of every
      // other line on the page. The dither axis strip directly beneath it is
      // given `padding-inline: 18px` (terminal.css:4747) for exactly this
      // reason, so the same 18 is applied here: a status sentence flush to the
      // screen edge reads as a rendering fault, not as a design.
      .padding(horizontal = 18.dp)
      .padding(top = 2.dp)
      .semantics { liveRegion = LiveRegionMode.Polite },
  )
}

/** The caption under a drawn chart. Same `.meta` type, same 18px inset. */
@Composable
private fun ChartCaption(text: String) {
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 16.2.sp),
    color = MerryColors.tx2,
    modifier = Modifier.padding(horizontal = 18.dp).padding(top = 6.dp),
  )
}

// ---------------------------------------------------------------------------
// WHO IS HOLDING IT
// ---------------------------------------------------------------------------

/**
 * WHO IS HOLDING IT — from the agents' own published books.
 *
 * `.held-sec { padding-top: 22px; padding-bottom: 24px }` (terminal.css:1598),
 * an `h3` heading at 15px/600 with `margin: 0 0 12px`, then a plain list. No
 * card, no border, no ground, and no dividers between rows: the 32px of
 * combined row padding is the only separation there is.
 *
 * THE COUNT IN THE HEADING IS A COUNT OF PUBLISHERS, NOT OF HOLDERS, and the
 * coverage line underneath is the only thing that makes it honest. Drop that
 * line and "Holders (3)" becomes a claim about how many agents hold the token,
 * which it is not. The web says it as "{published} of {total} agents publish
 * their positions." (Token.tsx:289) and this screen used to say the same fact
 * from the other end ("N more agents hold it without publishing a book"); the
 * web's phrasing is taken for parity, and the fact is not dropped.
 *
 * A PRETEND FILL MUST NOT LOOK LIKE A REAL ONE, which is why `paper` and
 * `basisSource` are rendered rather than dropped: three different things arrive
 * here — a receipt read off a settled transaction, a paper fill that is exact
 * but simulated, and a pre-trade quote that is an estimate of a price nothing
 * traded at.
 */
@Composable
private fun Holders(t: TokenDetail, nav: NavHostController) {
  val holders = t.ledger.holders
  Column(Modifier.fillMaxWidth().padding(top = 22.dp, bottom = 24.dp)) {
    // AN UNREAD LEDGER IS NOT AN EMPTY ONE. The web's equivalent is "Public
    // holdings are unavailable right now." above the heading, in the same
    // unclassed `<p role="status">` slot.
    if (!t.ledger.fillsRead) {
      StatusLine("We could not read the trade history, so we cannot say who is holding this.")
    }

    Text(
      text = "Holders" + if (holders.isNotEmpty()) " (${holders.size})" else "",
      style = TextStyle(
        fontFamily = sans(15.sp, FontWeight.W600),
        fontSize = 15.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
      modifier = Modifier.padding(bottom = 12.dp),
    )

    if (t.ledger.fillsRead) {
      val total = holders.size + t.ledger.privateHolders
      Meta("${holders.size} of $total agents publish their positions.")
    }

    if (holders.isNotEmpty()) {
      holders.forEach { h -> HolderRow(h, nav) }
    } else if (t.ledger.fillsRead) {
      // ONLY REACHABLE WHEN THE READ SUCCEEDED AND RETURNED NOTHING. The
      // `fillsRead` guard above is what keeps this sentence from being a claim
      // about retention manufactured out of a caught exception.
      Empty(
        title = "No public agent holdings reported yet.",
        body = "",
        kind = EmptyKind.Positions,
        compact = true,
      )
    }
  }
}

/**
 * `.held` — terminal.css:1624-1768, `Token.tsx:361-397`.
 *
 * A full-width left-aligned button: `grid-template-columns: 40px minmax(0,1fr);
 * gap: 12px; align-items: start; padding: 16px 0`. The whole row is the tap
 * target, so the "Their desk" text button that used to sit under it is gone.
 *
 * THE BASIS MARKER IS THE POINT OF THIS ROW. On the mobile web there is none:
 * `<i className="tag unsettled">` is emitted only inside the holders TABLE
 * (Token.tsx:378), and `.holder-table-wrap` is `display: none` below 1100px
 * (terminal.css:4810) — so on a phone today a simulated book is visually
 * indistinguishable from settled money. That is the exact thing read-token.ts
 * forbids, so it is NOT matched: the table's `.tag.unsettled` styling is
 * brought onto the card instead, and the full sentence is kept underneath it.
 * The chip is scannable down a list of ten rows; the sentence is unambiguous;
 * neither alone does both jobs.
 *
 * AND THE CHIP HAS THREE WORDS, NOT TWO. The web writes `seat.paper ? "paper" :
 * "estimate"`, which files an entry price we never recorded under "estimate" —
 * an estimate is a number somebody produced, and an unrecorded basis is the
 * absence of one. `entryCaveat` already keeps those apart in prose and the chip
 * follows it.
 */
@Composable
private fun HolderRow(h: TokenHolder, nav: NavHostController) {
  val name = h.name.ifBlank { h.slug ?: "an agent" }
  val caveat = entryCaveat(h)
  val slug = h.slug
  Row(
    Modifier
      .fillMaxWidth()
      .then(
        if (slug != null) {
          Modifier.tap("Open $name") { nav.navigate(Routes.agent(slug)) }
        } else {
          Modifier
        },
      )
      .padding(vertical = 16.dp),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Avatar(name = name, size = 40.dp)
    Column(Modifier.weight(1f)) {
      // `.held-top` — the name and the position value on one line.
      Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Row(
          Modifier.weight(1f),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            text = name,
            style = TextStyle(
              fontFamily = sans(15.sp, FontWeight.W700),
              fontSize = 15.sp,
              fontWeight = FontWeight.W700,
              letterSpacing = (-0.02).em,
            ),
            color = MerryColors.tx,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
          )
          basisWord(h)?.let { UnsettledTag(it) }
        }
        // `{seat.position > 0 ? <b>{money(seat.position)}</b> : null}` — the
        // element is omitted rather than printed as "$0.00".
        if (h.valueUsdg > 0.0) {
          Text(
            text = money(h.valueUsdg),
            style = TextStyle(
              fontFamily = numerals(FontWeight.W600),
              fontSize = 16.sp,
              fontWeight = FontWeight.W600,
              letterSpacing = (-0.03).em,
            ),
            color = MerryColors.tx,
            maxLines = 1,
          )
        }
      }

      // `.held-sub` — the average entry on the left, the return on the right.
      Row(
        Modifier.fillMaxWidth().padding(top = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Bottom,
      ) {
        Box(Modifier.weight(1f)) {
          // `seat.avgEntry > 0 ? <span>Avg. …</span> : <span />` — an EMPTY
          // span, so the row keeps its shape and nothing is claimed. Note the
          // literal copy is "Avg. " with the period.
          val entry = h.entryPriceUsd
          if (entry != null && entry > 0.0) {
            Text(
              text = "Avg. " + coinPrice(entry),
              style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp),
              color = MerryColors.faint,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        Text(
          text = pctBps(h.pnlBps),
          style = TextStyle(
            fontFamily = numerals(FontWeight.W600),
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
          ),
          // THE WEB PAINTS AN UNKNOWN RETURN AT FULL TEXT STRENGTH.
          // `seat.pnlBps == null ? "" : …` (Token.tsx:380) leaves an unknown
          // with no class, so it inherits `--tx` and a "—" reads as a stated
          // figure. It is not green, so it is not the `deltaClass` bug — but
          // `--faint` is what the rest of this app means by "we do not know",
          // and that is what is used. A measured zero keeps `--tx`, because a
          // return we read and found flat is not an unknown one.
          color = when {
            h.pnlBps == null -> MerryColors.faint
            h.pnlBps!! > 0 -> MerryColors.up
            h.pnlBps!! < 0 -> MerryColors.down
            else -> MerryColors.tx
          },
          maxLines = 1,
        )
      }

      // The sentence the chip abbreviates. The web has no equivalent on this
      // card — see the KDoc above for why it is here anyway. It takes the
      // thesis paragraph's slot (`.held-who p`) at a quieter weight, because it
      // is a caveat about a figure and not an agent's reasoning.
      if (caveat.isNotBlank()) {
        Text(
          text = caveat.removePrefix(" — ").replaceFirstChar { ch -> ch.uppercase() } + ".",
          style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 17.4.sp),
          color = MerryColors.faint,
          modifier = Modifier.padding(top = 6.dp),
        )
      }
    }
  }
}

/**
 * `.tag.unsettled` — terminal.css:6760-6768.
 *
 * `margin-left: 6px; border: 1px DASHED var(--faint); color: var(--faint);
 * font-size: 11px; padding: 1px 5px; border-radius: 5px` over the base `.tag`'s
 * `#1c1d16` ground at weight 500 and `letter-spacing: 0.03em`.
 *
 * The dash is load-bearing. The sheet's own comment quotes read-token.ts: "a
 * pretend fill must not look like a real one". A solid border in a dimmer grey
 * reads as de-emphasised; a dashed one reads as provisional.
 */
@Composable
private fun UnsettledTag(word: String) {
  Box(
    Modifier
      .clip(RoundedCornerShape(5.dp))
      .background(TagGround)
      .dashedRoundedBorder(MerryColors.faint, 1.dp, 5.dp)
      .padding(horizontal = 5.dp, vertical = 1.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = word,
      style = TextStyle(
        fontFamily = sans(11.sp, FontWeight.W500),
        fontSize = 11.sp,
        fontWeight = FontWeight.W500,
        lineHeight = 11.sp,
        letterSpacing = 0.03.em,
      ),
      color = MerryColors.faint,
    )
  }
}

/** terminal.css:1712 — the base `.tag` ground, and not a theme token. */
private val TagGround = Color(0xFF1C1D16)

/**
 * WHY THIS ENTRY PRICE IS NOT A SETTLED FILL — or "" when it is.
 *
 * Mirrors `entryCaveat` in web/src/terminal/bars.ts, word for word, because the
 * two clients must not disagree about which fills were real.
 */
private fun entryCaveat(h: TokenHolder): String = when {
  h.paper -> " — on paper, not a real fill"
  h.basisSource == "quote" -> " — an estimate, not a settled fill"
  h.basisSource == null -> " — entry price unrecorded"
  else -> ""
}

/** The one word that goes in the chip, or null for a settled receipt. */
private fun basisWord(h: TokenHolder): String? = when {
  h.paper -> "paper"
  h.basisSource == "quote" -> "estimate"
  h.basisSource == null -> "unrecorded"
  else -> null
}

// ---------------------------------------------------------------------------
// SHARED TYPE ON THIS SCREEN
// ---------------------------------------------------------------------------

/**
 * `.meta` — terminal.css:704: `margin: 2px 0 0; color: var(--tx-2); font-size: 12px`.
 *
 * The quiet line under a heading or a figure. Used five times on this screen
 * and never as a card.
 */
@Composable
private fun Meta(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 16.2.sp),
    color = MerryColors.tx2,
    modifier = modifier.padding(top = 2.dp),
  )
}

/**
 * The screen's `<p role="status">` — `Token.tsx:192`, `Token.tsx:287`.
 *
 * It carries NO class, so it takes the browser's default paragraph box against
 * the host's own 15px `--tx`: full text size, full text colour, and a 1em
 * margin above and below. That is deliberately louder than [Meta]: these
 * sentences are answers to something the reader just did, or a reason a section
 * below is empty.
 */
@Composable
private fun StatusLine(text: String) {
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 20.25.sp),
    color = MerryColors.tx,
    modifier = Modifier
      .padding(vertical = 15.dp)
      .semantics { liveRegion = LiveRegionMode.Polite },
  )
}

// ---------------------------------------------------------------------------
// FIGURES — the web's own formatters, ported rather than approximated
// ---------------------------------------------------------------------------

/**
 * `coinPrice` — live.ts:263-270, AND NOT [dev.merrymen.app.ui.Money].
 *
 * Three formatters were in play for the same number and they disagreed on real
 * prices: this file's old local `money()` gave "$0.0000028" where the web gives
 * "$0.00000280", and `Money()`'s "%,.2f" would render that same price as
 * "$0.00" — a real number displayed as nothing, which tv.tsx:145 calls out by
 * name as "the same failure as showing a null as zero". Anything on this screen
 * that prints a PRICE goes through here.
 *
 * "—" for null or non-finite; the literal "$0" for exactly zero; three
 * significant digits below $0.01; four decimals from $0.01 to $1; two from $1
 * up; grouped with two decimals at $100 and above.
 */
private fun coinPrice(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  if (n == 0.0) return "$0"
  if (n < 0.01) return "$" + toPrecision3(n)
  if (n >= 100) return "$" + String.format(Locale.US, "%,.2f", n)
  return "$" + String.format(Locale.US, if (n >= 1) "%.2f" else "%.4f", n)
}

/**
 * JavaScript's `Number.prototype.toPrecision(3)`, including when it gives up on
 * fixed notation.
 *
 * ECMA-262 switches to exponential when the leading digit's exponent is below
 * -6 or at least the precision, so `2.8e-6` prints as "0.00000280" and `2.8e-7`
 * prints as "2.80e-7". A naive `%.8f` agrees with the first and silently
 * rounds the second to "0.00000000". `BigDecimal(Double)` is used rather than
 * `valueOf` because the exact binary value is what JS rounds from.
 */
private fun toPrecision3(value: Double): String {
  val rounded = BigDecimal(value).round(MathContext(3, RoundingMode.HALF_UP))
  val exponent = rounded.precision() - rounded.scale() - 1
  return if (exponent < -6 || exponent >= 3) {
    val mantissa = rounded.movePointLeft(exponent).setScale(2, RoundingMode.HALF_UP)
    mantissa.toPlainString() + "e" + (if (exponent >= 0) "+" else "-") + abs(exponent)
  } else {
    rounded.setScale((2 - exponent).coerceAtLeast(0), RoundingMode.HALF_UP).toPlainString()
  }
}

/** `money` — live.ts:307-310. Grouped, always two decimals, "—" for null. */
private fun money(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  return "$" + String.format(Locale.US, "%,.2f", n)
}

/** `compactUsd` — live.ts:255-261. Note the lowercase "k" and the rounding. */
private fun compactUsd(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  return when {
    n >= 1e9 -> "$" + String.format(Locale.US, "%.1f", n / 1e9) + "B"
    n >= 1e6 -> "$" + String.format(Locale.US, "%.1f", n / 1e6) + "M"
    n >= 1e3 -> "$" + Math.round(n / 1e3) + "k"
    else -> "$" + Math.round(n)
  }
}

/** `pctPts` — live.ts:278-281. Two decimals, or none once it passes 100%. */
private fun pctPts(n: Double?): String {
  if (n == null || !n.isFinite()) return "—"
  val digits = if (n >= 100 || n <= -100) 0 else 2
  return (if (n > 0) "+" else "") + String.format(Locale.US, "%.${digits}f", n) + "%"
}

/**
 * `pctBps` — live.ts:300-305, and NOT [dev.merrymen.app.ui.Bps].
 *
 * Three things differ from the shared composable and all three are the web's:
 * ONE decimal rather than two; the literal "0.0%" for anything under half a
 * basis point, which is a measured near-zero and not the unmeasured "—"; and
 * U+2212 MINUS SIGN for a negative rather than a hyphen, so the sign has the
 * same width as the plus it replaces in a column.
 */
private fun pctBps(bps: Int?): String {
  if (bps == null) return "—"
  val pct = bps / 100.0
  if (abs(pct) < 0.05) return "0.0%"
  return (if (pct > 0) "+" else "−") + String.format(Locale.US, "%.1f", abs(pct)) + "%"
}

/**
 * `shortId` — Token.tsx:404-407. First four, an ellipsis, last four; the whole
 * id when it is shorter than twelve characters.
 *
 * `Owner.shortAddress` is a different function for a different string: it
 * requires `0x`-hex and cuts 6+4, so on a base58 mint it returns null and this
 * screen used to print the full 44-character address into a 12px line.
 */
private fun shortId(id: String): String =
  if (id.length < 12) id else id.take(4) + "…" + id.takeLast(4)

// ---------------------------------------------------------------------------
// GLYPHS — transcribed from the web's own SVG, not substituted from Material
// ---------------------------------------------------------------------------

private const val VIEW = 24f

/** Token.tsx:414-428. Hand-drawn, and a different silhouette from Material's. */
private const val STAR_PATH =
  "M12 3.6 14.6 9l5.9.5-4.5 3.9 1.4 5.7L12 16.4 6.6 19.1l1.4-5.7L3.5 9.5 9.4 9Z"

/** Token.tsx:430-446. The two segments joining the three nodes. */
private const val SHARE_PATH = "M8 11.1 16 6.2M8 12.9 16 17.8"

/** Token.tsx:448-455. Six sharp rectangles: the only FILLED hand-drawn icon. */
private const val CANDLE_PATH =
  "M7 4h2v3H7zM7 17h2v3H7zM6 8h4v8H6zM15 3h2v5h-2zM15 16h2v5h-2zM14 9h4v6h-4z"

/** lucide `ChartArea`, the only lucide glyph in the app at strokeWidth 1.8. */
private const val CHART_AREA_FRAME = "M3 3v16a2 2 0 0 0 2 2h16"
private const val CHART_AREA_FILL =
  "M7 11.207a.5.5 0 0 1 .146-.353l2-2a.5.5 0 0 1 .708 0l3.292 3.292a.5.5 0 0 0 .708 0l4.292-4.292" +
    "a.5.5 0 0 1 .854.353V16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"

/**
 * The watchlist star. `fill` is `currentColor` when on and `none` when not, so
 * the two states are the same drawing at two densities rather than two icons.
 *
 * SVG's default `stroke-linejoin` is miter and the web sets none, which is what
 * gives the five points their corners; rounding them would blunt the star.
 */
@Composable
private fun StarGlyph(on: Boolean, tint: Color, size: Dp = 20.dp) {
  val path = remember { PathParser().parsePathString(STAR_PATH).toPath() }
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    scale(s, s, pivot = Offset.Zero) {
      if (on) drawPath(path, tint)
      drawPath(path, tint, style = Stroke(width = 1.8f, join = StrokeJoin.Miter))
    }
  }
}

/** Three r=2.2 nodes and the two lines between them. Stroked, never filled. */
@Composable
private fun ShareGlyph(tint: Color, size: Dp = 20.dp) {
  val path = remember { PathParser().parsePathString(SHARE_PATH).toPath() }
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = 1.8f)
      drawCircle(tint, radius = 2.2f, center = Offset(18f, 5f), style = stroke)
      drawCircle(tint, radius = 2.2f, center = Offset(6f, 12f), style = stroke)
      drawCircle(tint, radius = 2.2f, center = Offset(18f, 19f), style = stroke)
      drawPath(path, tint, style = stroke)
    }
  }
}

@Composable
private fun CandleGlyph(tint: Color, size: Dp = 18.dp) {
  val path = remember { PathParser().parsePathString(CANDLE_PATH).toPath() }
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    scale(s, s, pivot = Offset.Zero) { drawPath(path, tint) }
  }
}

@Composable
private fun ChartAreaGlyph(tint: Color, size: Dp = 18.dp) {
  val paths = remember {
    listOf(CHART_AREA_FRAME, CHART_AREA_FILL).map { PathParser().parsePathString(it).toPath() }
  }
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = 1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
      paths.forEach { drawPath(it, tint, style = stroke) }
    }
  }
}

/** terminal.css:1165 — not a theme token, and the only blue in the product. */
private val VerifiedBlue = Color(0xFF3B82F6)

/**
 * `.verified` — terminal.css:1165-1185.
 *
 * A 13px `#3b82f6` disc with a check made of the RIGHT and BOTTOM borders of a
 * 4x6 box rotated 40 degrees. Because the box is `content-box`, the 1.6px
 * borders sit outside the 4x6, which puts the two stroke centrelines at x=8.3
 * and y=9.3 and the transform origin at (6.3, 6.3) — that is where the numbers
 * below come from rather than from eyeballing a tick.
 */
@Composable
private fun VerifiedBadge(size: Dp = 13.dp) {
  Canvas(
    Modifier
      .size(size)
      .semantics { contentDescription = "Registered tokenized asset" },
  ) {
    drawCircle(VerifiedBlue)
    val s = this.size.minDimension / 13f
    scale(s, s, pivot = Offset.Zero) {
      rotate(40f, pivot = Offset(6.3f, 6.3f)) {
        val check = Path().apply {
          moveTo(8.3f, 2.5f)
          lineTo(8.3f, 9.3f)
          lineTo(3.5f, 9.3f)
        }
        drawPath(check, Color.White, style = Stroke(width = 1.6f, join = StrokeJoin.Miter))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// THE TOKEN MARK
// ---------------------------------------------------------------------------

/**
 * `.token-top .coin` — 36x36, round, 11px initials.
 *
 * The gradient is `ui.tsx:7-23`, seeded by the SYMBOL rather than by a name,
 * and the initials are `Coin`'s: alphanumerics only, two characters, uppercased,
 * or the literal "?" when nothing survives. Same hash the web runs, so the same
 * token comes out the same colour in both clients.
 *
 * NO LOGO IS FETCHED. The web paints `/api/coin-image` over this plate and
 * removes it on error; there is no image loader in this app yet, so the plate
 * is all there is. `.coin`'s `#ecece4` default ground is deliberately not used:
 * it exists to sit behind a transparent PNG, and with no PNG it would be a bare
 * off-white disc where the web shows a coloured one.
 */
@Composable
private fun TokenCoin(symbol: String, size: Dp) {
  val glyph = (size.value * 11f / 36f).sp
  Box(
    Modifier
      .size(size)
      .clip(androidx.compose.foundation.shape.CircleShape)
      .drawBehind { drawRect(brush = coinBrush(symbol, this.size)) },
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = coinInitials(symbol),
      style = TextStyle(
        fontFamily = sans(glyph, FontWeight.W700),
        fontSize = glyph,
        fontWeight = FontWeight.W700,
        lineHeight = glyph,
      ),
      color = CoinGlyph,
    )
  }
}

/** terminal.css:1040 — shared by `.face` and `.coin`, and not a theme token. */
private val CoinGlyph = Color(0xFF0E0E10)

/**
 * `hueOf` at ui.tsx:6-9 — `h = (h * 31 + charCodeAt(i)) % 360`.
 *
 * Identity, not decoration: the multiplier, the modulus and the per-step
 * reduction all have to stay exactly as they are or the same token comes out a
 * different colour here than in the browser. A private copy of the one in
 * Components.kt, which is private there; it wants lifting.
 */
private fun hueOf(seed: String): Int {
  var h = 0
  for (ch in seed) h = (h * 31 + ch.code) % 360
  return h
}

/** `linear-gradient(145deg, hsl(h 62% 62%), hsl((h+42)%360 58% 44%))`. */
private fun coinBrush(seed: String, size: Size): Brush {
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

/** `Coin`'s initials, ui.tsx:261-262. "?" is VISIBLE, not a blank disc. */
private fun coinInitials(symbol: String): String =
  symbol.replace(Regex("[^A-Za-z0-9]"), "").take(2).uppercase(Locale.ROOT).ifEmpty { "?" }

// ---------------------------------------------------------------------------
// LAYOUT AND INTERACTION HELPERS
// ---------------------------------------------------------------------------

/**
 * CSS's negative margin, which Compose has no modifier for.
 *
 * `.token-plot { margin: 0 -18px 8px }` widens the plot past the page gutter on
 * both sides. Since the gutter is 20px (polish.css:87, see the file header),
 * -18 leaves the chart 2px in from each screen edge rather than truly
 * full-bleed. This measures the child against constraints [by] wider on each
 * side and places it back by that much, which is exactly what the browser does.
 *
 * Private per the one-file-per-agent rule; several screens will want it.
 */
private fun Modifier.bleed(by: Dp): Modifier = layout { measurable, constraints ->
  val extra = by.roundToPx() * 2
  val wide = if (constraints.maxWidth == Constraints.Infinity) {
    constraints
  } else {
    constraints.copy(
      minWidth = (constraints.minWidth + extra).coerceAtMost(constraints.maxWidth + extra),
      maxWidth = constraints.maxWidth + extra,
    )
  }
  val placeable = measurable.measure(wide)
  layout((placeable.width - extra).coerceAtLeast(0), placeable.height) {
    placeable.place(-extra / 2, 0)
  }
}

/**
 * A DASHED ROUNDED BORDER, which `Modifier.border` cannot draw.
 *
 * A private copy of the helper in Components.kt, which is private there. See
 * [UnsettledTag] for why the dash rather than a dimmer solid line.
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

/**
 * A TAP WITH NO RIPPLE, because the terminal has no press feedback anywhere.
 *
 * There is no ripple, no scale-on-press and no transition on any control in
 * 7824 lines of stylesheet; buttons change colour instantly or not at all.
 * Material's default indication would make the phone visibly livelier than the
 * product it mirrors, and inside a 5px-radius tag or an 8px window button it
 * draws a rectangle through the corners.
 *
 * [label] is an `onClickLabel`, NOT a content description — it names the ACTION
 * ("Open Bandit") and leaves whatever the control contains still readable.
 * Overwriting a row of real text with a label is how a holder's name, position
 * and return stop existing for a screen reader. Controls that contain nothing
 * but a drawing get [describedAs] instead.
 */
@Composable
private fun Modifier.tap(label: String? = null, onClick: () -> Unit): Modifier {
  val source = remember { MutableInteractionSource() }
  return this.clickable(
    interactionSource = source,
    indication = null,
    onClickLabel = label,
    onClick = onClick,
  )
}

/** For a control whose whole content is a Canvas or a bare glyph. */
private fun Modifier.describedAs(text: String): Modifier =
  this.semantics { contentDescription = text }

// ---------------------------------------------------------------------------
// CLIPBOARD AND SHARE
// ---------------------------------------------------------------------------

/**
 * COPY, and say so — but only when it FAILED.
 *
 * Returns null on success and the reason on failure, because the success signal
 * belongs in the button's own label ("Copied" for 1200ms, Token.tsx:169) rather
 * than in a status line: Android 13 and later already shows its own clipboard
 * toast, so a sentence as well as the toast as well as the label swap would be
 * the same news three times.
 *
 * The failure sentence is not the web's ("Could not copy the address. Select it
 * to copy manually.") because it is not the web's failure: this branch is a
 * device with no clipboard service at all, where there is nothing to select
 * from. The distinction between "the write was rejected" and "there is no
 * clipboard here" is worth the divergence.
 */
private fun copy(ctx: Context, address: String): String? {
  val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    ?: return "This device would not give us the clipboard."
  cm.setPrimaryClip(ClipData.newPlainText("token address", address))
  return null
}

/**
 * SHARE THE WEB LINK, not a deep link into the app.
 *
 * `/t/<address>` is the path the terminal itself routes on, so whoever receives
 * it lands on the same token whether or not they have this app. The origin is
 * the one this install is pointed at — a tester on a staging deploy sharing a
 * link to production would be sharing a page they are not looking at.
 */
private fun share(ctx: Context, origin: String, address: String, name: String): String? {
  val url = origin.removeSuffix("/") + "/t/" + address
  return try {
    ctx.startActivity(
      Intent.createChooser(
        Intent(Intent.ACTION_SEND).apply {
          type = "text/plain"
          putExtra(Intent.EXTRA_SUBJECT, name)
          putExtra(Intent.EXTRA_TEXT, url)
        },
        "Share $name",
      ),
    )
    null
  } catch (e: android.content.ActivityNotFoundException) {
    // DRIVEN AND CAUGHT, not gated on a capability query. The manifest's
    // <queries> block decides what a package check can even see, so asking
    // first can answer "no" for a chooser that would in fact have opened.
    "Nothing on this device can share a link."
  }
}
