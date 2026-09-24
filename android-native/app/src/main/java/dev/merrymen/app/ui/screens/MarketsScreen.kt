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
import androidx.compose.foundation.layout.size
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

@Composable
fun MarketsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TokensPage>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.market().toLoaded() }
  LaunchedEffect(Unit) { load() }

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
      LoadedBlock(state, onRetry = { scope.launch { load() } }) { page ->
        if (page.tokens.isEmpty()) {
          Empty(
            "No tokens listed",
            "Nothing has been registered on this deployment yet.",
            kind = EmptyKind.Positions,
          )
        } else {
          page.tokens.forEach { t ->
            TokRow(
              seed = t.symbol,
              title = t.symbol,
              sub = t.name,
              modifier = Modifier.clickable(enabled = t.address != null) {
                t.address?.let { nav.navigate(Routes.token(it)) }
              },
              under = {
                // HALT IS NULLABLE ON PURPOSE: the server may only assert it
                // when the chain answered, so unknown stays quiet.
                if (t.paused == true) HaltChip("trading halted", Modifier.padding(top = 4.dp))
              },
              right = {
                Money(t.priceUsd, bold = true)
                // 24h VOLUME, NOT A 24h CHANGE. /api/market sends no change
                // figure, so the arrow that used to sit here was an em dash on
                // every row for every token, for ever. The label stays: an
                // unlabelled second figure under a price reads as a move.
                t.volume24hUsd?.let {
                  Text("24h vol", style = MetaText, color = MerryColors.faint)
                  Money(it, size = 12.sp, bold = true)
                }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}
