package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.unrankedShort
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.Bps
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/**
 * `.rank` / `.rank-hit` — terminal.css:3027-3113. A race, drawn as a ruled list:
 *
 * `.rank { padding: 10px 0; border-bottom: 1px solid var(--line) }` with the
 * last row's rule removed, and inside it
 * `grid-template-columns: 20px auto minmax(0,1fr) auto; gap: 11px`:
 * the position at 13px `--faint` with tabular figures, the face, who, then the
 * figures column at 12px/600 with `letter-spacing: -0.02em`.
 *
 * THE POSITION IS AN EM DASH WHEN THE RETURN IS UNKNOWN — Board.tsx:138 renders
 * `row.ret == null ? "—" : row.rank`. An agent with no measurable return has no
 * position in the race, and printing one anyway would rank it on a number
 * nobody has.
 */
@Composable
private fun RankRow(
  row: LeaderRow,
  place: Int?,
  last: Boolean,
  modifier: Modifier = Modifier,
) {
  Column(modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(vertical = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(11.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = place?.toString() ?: "—",
        modifier = Modifier.width(20.dp),
        style = TextStyle(
          fontFamily = numerals(FontWeight.W400),
          fontSize = 13.sp,
          fontWeight = FontWeight.W400,
        ),
        color = MerryColors.faint,
      )
      // `.face` at its shared 30px default — terminal.css:1031. Board.tsx passes
      // no size, so this is not the 22px `.face.pin` the feed rail uses.
      Avatar(row.name ?: row.handle ?: "agent", size = 30.dp)
      Column(Modifier.weight(1f)) {
        NameBlock(
          title = row.name ?: row.handle ?: "agent",
          owner = row.handle,
          verified = row.handleVerified,
        )
        // `.rank-trades` — terminal.css:3088: 11px `--faint`, nowrap, 2px under
        // the name. Rendered only when the count is KNOWN: null is "we were not
        // told", which is not the same claim as "no trades yet".
        // THE WIRE FIELD IS `landed`, and `trades` never existed — so this line
        // decoded null on every row and rendered nowhere. Zero is also excluded
        // deliberately: an agent with 0 settled fills and a dozen paper ones has
        // traded, just not for real, and "0 trades" would deny it.
        row.landed?.takeIf { it > 0 }?.let { n ->
          Text(
            text = if (n == 1) "1 trade" else "$n trades",
            modifier = Modifier.padding(top = 2.dp),
            maxLines = 1,
            style = TextStyle(
              fontFamily = sans(11.sp),
              fontSize = 11.sp,
              fontWeight = FontWeight.W400,
            ),
            color = MerryColors.faint,
          )
        }
      }
      // `.rank .chg` at 12px/600 — but only for a row that HAS a return.
      //
      // A NULL HERE IS NOT AN UNREADABLE FIGURE. rank-pnl.ts guarantees exactly
      // one of `pnlBps` and `unrankedWhy` is ever set, so a null return always
      // means unranked for a STATED reason, and the web prints that reason.
      // Handing it to Bps rendered the app's em dash — which Components.kt
      // reserves for "we never got an answer" — so the phone asserted its own
      // ignorance in the one place the server had actually given an answer.
      // Eight rows on the live board carry a reason as I write this.
      if (row.pnlBps == null) {
        Text(
          text = unrankedShort(row.unrankedWhy),
          maxLines = 1,
          style = TextStyle(
            fontFamily = sans(12.sp, FontWeight.W600),
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.faint,
        )
      } else {
        Bps(row.pnlBps, size = 12.sp)
      }
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
  }
}

@Composable
fun LeaderboardScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<Leaderboard>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.leaderboard().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Leaderboard", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(state, onRetry = { scope.launch { load() } }) { b ->
        if (b.agents.isEmpty()) {
          // "Nothing to rank" and "we could not rank" are different sentences.
          Empty(
            //  MEANS THE LEDGER COULD NOT BE READ. It is not
            // "nobody has traded", and the two must not share a sentence — the
            // web keeps them apart in ReadEmpty.
            if (b.source == "none") "Activity unavailable." else "Nothing to rank yet",
            if (b.source == "none") "We could not read the ledger for this deployment."
            else "No agent has a settled result on this deployment.",
            kind = EmptyKind.Board,
          )
        } else {
          // The position counts only rows that HAVE a return, so an unranked
          // agent does not push the agent below it down the table.
          var place = 0
          b.agents.forEachIndexed { i, a ->
            val p = if (a.pnlBps == null) null else ++place
            RankRow(
              row = a,
              place = p,
              last = i == b.agents.lastIndex,
              modifier = Modifier.clickable(enabled = a.slug != null) {
                a.slug?.let { nav.navigate(Routes.agent(it)) }
              },
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}
