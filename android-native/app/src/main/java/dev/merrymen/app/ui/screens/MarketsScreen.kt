package dev.merrymen.app.ui.screens

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.market.MarketRow
import dev.merrymen.app.market.WhileResumed
import dev.merrymen.app.market.fmtCompactUsd
import dev.merrymen.app.market.fmtPctPts
import dev.merrymen.app.market.marketCaveats
import dev.merrymen.app.market.marketRows
import dev.merrymen.app.market.refreshLoop
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/**
 * `.halt` — terminal.css:2312:
 * `padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px; color: var(--tx-2); font-size: 12px; font-weight: 600`
 *
 * A NEUTRAL PILL, not a red one. A halted market is a fact about the venue, not
 * a loss, and `--down` is spent on money going the wrong way. (The sheet keeps
 * one variant, `.halt.off`, which turns lime when trading is back ON — the
 * accent marks the good news, not the bad.)
 */
@Composable
private fun HaltChip(text: String, modifier: Modifier = Modifier) {
  val shape = RoundedCornerShape(50)
  Box(
    modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 11.dp, vertical = 7.dp),
  ) {
    Text(
      text = text,
      style = TextStyle(
        fontFamily = sans(12.sp, FontWeight.W600),
        fontSize = 12.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 12.sp,
      ),
      color = MerryColors.tx2,
    )
  }
}

/** The registry and its prices: the venue's quote TTL (refresh-loop.ts MARKET_EVERY_MS). */
private const val MARKET_EVERY_MS = 30_000L

/** The launchpad sweep: the server's memo lives two minutes (DISCOVERIES_EVERY_MS). */
private const val DISCOVERIES_EVERY_MS = 120_000L

/**
 * MARKETS — the listed stocks and ETFs, and the launchpad coins the index is
 * carrying, as the web's Home "Market activity" joins them.
 *
 * It used to list /api/market alone, so no launchpad coin ever appeared here.
 * Now the two reads are merged (marketRows), each on its own clock, and only
 * while this screen is on top (WhileResumed): a screen nobody can see does not
 * ask for prices every thirty seconds.
 *
 * A REFRESH THAT FAILS KEEPS THE LAST GOOD ROWS and says so, instead of
 * blanking a list the reader was scanning; a first read that fails says what
 * failed, and a list missing one of its two halves says which half.
 */
@Composable
fun MarketsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var market by remember { mutableStateOf<Loaded<TokensPage>>(Loaded.Loading) }
  var disc by remember { mutableStateOf<Loaded<Discoveries>>(Loaded.Loading) }
  var marketStale by remember { mutableStateOf(false) }
  var discStale by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  suspend fun readMarket(): Boolean {
    val r = c.api.market().toLoaded()
    if (r is Loaded.Value || market !is Loaded.Value) {
      market = r
      marketStale = false
    } else {
      marketStale = true
    }
    return r is Loaded.Value
  }

  suspend fun readDiscoveries(): Boolean {
    val r = c.api.discoveries().toLoaded()
    if (r is Loaded.Value || disc !is Loaded.Value) {
      disc = r
      discStale = false
    } else {
      discStale = true
    }
    return r is Loaded.Value
  }

  WhileResumed(Unit) {
    launch { refreshLoop(MARKET_EVERY_MS) { readMarket() } }
    launch { refreshLoop(DISCOVERIES_EVERY_MS) { readDiscoveries() } }
  }

  // ONE SCROLLER, and the header scrolls with it. `App.tsx` renders no app bar
  // on a phone at all — `.body` is the single scroll region (polish.css:87) and
  // every screen's title is just its first child, so it leaves the screen as
  // the reader moves down. A fixed title here would be a different design.
  Column(
    Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState()),
  ) {
    Header("Markets", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      val m = market
      val d = disc
      val mFailed = m is Loaded.Refused || m is Loaded.Unreachable
      val dFailed = d is Loaded.Refused || d is Loaded.Unreachable
      when {
        // Neither read has answered yet.
        m is Loaded.Loading && d is Loaded.Loading -> LoadedBlock(Loaded.Loading) { _: Unit -> }
        // Neither half could be read: say what failed, with Try again.
        mFailed && dFailed -> LoadedBlock(
          m,
          onRetry = {
            scope.launch {
              readMarket()
              readDiscoveries()
            }
          },
        ) { _ -> }
        else -> MarketList(
          market = m,
          disc = d,
          marketStale = marketStale,
          discStale = discStale,
          nav = nav,
        )
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

@Composable
private fun MarketList(
  market: Loaded<TokensPage>,
  disc: Loaded<Discoveries>,
  marketStale: Boolean,
  discStale: Boolean,
  nav: NavHostController,
) {
  val rows = marketRows((market as? Loaded.Value)?.value, (disc as? Loaded.Value)?.value)
  marketCaveats(market, disc, marketStale, discStale).forEach { NoteLine(it, Modifier.padding(bottom = 8.dp)) }

  if (rows.isEmpty() && market is Loaded.Value && disc is Loaded.Value) {
    Empty(
      "No tokens listed",
      "Nothing has been registered on this deployment yet, and the index returned no coins.",
      kind = EmptyKind.Positions,
    )
    return
  }
  rows.forEach { r -> MarketListRow(r, nav) }
  // The coins arrive on their own clock; until the first sweep lands, the
  // list says it is still reading rather than implying there are none.
  if (disc is Loaded.Loading) NoteLine("Reading the launchpad…", Modifier.padding(top = 8.dp))
  if (market is Loaded.Loading) NoteLine("Reading the listed stocks…", Modifier.padding(top = 8.dp))
}

@Composable
private fun MarketListRow(r: MarketRow, nav: NavHostController) {
  TokRow(
    seed = r.symbol,
    title = r.symbol,
    sub = r.name,
    modifier = Modifier.clickable(enabled = r.address != null) {
      r.address?.let { nav.navigate(Routes.token(it)) }
    },
    under = {
      // HALT IS NULLABLE ON PURPOSE: the server may only assert it when the
      // chain answered, so unknown stays quiet.
      if (r.halted) HaltChip("trading halted", Modifier.padding(top = 4.dp))
    },
    right = {
      Money(r.priceUsd, bold = true)
      val chg = r.change24hPct
      when {
        // A POOL YOUNGER THAN A DAY HAS NO 24-HOUR CHANGE. The index reports
        // one anyway — a change since launch — and printing it under "24h"
        // is the figure the doNotDo list forbids by name.
        r.newPool -> Text("new pool", style = MetaText, color = MerryColors.faint)
        chg != null -> Text(
          text = fmtPctPts(chg) + " 24h",
          style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
          color = if (chg < 0) MerryColors.down else MerryColors.up,
        )
        // 24h VOLUME, NOT A 24h CHANGE. /api/market sends no change figure
        // for a stock, so nothing claims one; the label stays, because an
        // unlabelled second figure under a price reads as a move.
        r.volume24hUsd != null -> Text(
          "24h vol " + fmtCompactUsd(r.volume24hUsd),
          style = MetaText,
          color = MerryColors.faint,
        )
        else -> Unit
      }
    },
  )
}
