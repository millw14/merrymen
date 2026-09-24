package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
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
import dev.merrymen.app.net.CircleTier
import dev.merrymen.app.net.CircleView
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch
import java.util.Locale

/** `.mm-chips button` / `.mm-btn` — forms.css:51: `font-size: 13px`, inherited weight. */
private val ChipText = TextStyle(
  fontFamily = sans(13.sp),
  fontSize = 13.sp,
  fontWeight = FontWeight.W400,
)

/** en-US grouping, which is the format every figure in this product is written in. */
private fun grouped(n: Int): String = String.format(Locale.US, "%,d", n)

/**
 * `.mm-row` — forms.css:59:
 * `display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px`
 */
@Composable
private fun KeyValueRow(key: String, modifier: Modifier = Modifier, value: @Composable () -> Unit) {
  Column(modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(vertical = 12.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(key, style = ChipText, color = MerryColors.tx2)
      value()
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
  }
}

/**
 * `.preset-card` — forms.css:76-79:
 * `display: flex; flex-direction: column; gap: 10px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card)`
 * with the label at 14px/600 and the blurb at 12px/1.6 `--tx-2`.
 *
 * WHY THIS SHAPE AND NOT AN INVENTED ONE. There is no `.circle-` or `.tier-`
 * selector anywhere in terminal.css, polish.css, forms.css or root.css — the
 * web has no Merry Circle screen at all, so this whole page has no design to
 * copy. `.preset-card` is the nearest PUBLISHED card vocabulary in the same
 * family of "here are your options, one per box", so it is borrowed openly
 * rather than a new card being drawn. Flagged for the owner in the report.
 */
@Composable
private fun PresetCard(
  title: String,
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  val shape = RoundedCornerShape(14.dp)
  Column(
    modifier
      .fillMaxWidth()
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(18.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text(
      text = title,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W600),
        fontSize = 14.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
    content()
  }
}

/** `.chain-card-body` / `.preset-blurb` — forms.css:79: 12px, `--tx-2`, line-height 1.6. */
@Composable
private fun CardBlurb(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(
    text = text,
    modifier = modifier,
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 19.2.sp,
    ),
    color = MerryColors.tx2,
  )
}

@Composable
fun CircleScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<CircleView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.circle().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("The Merry Circle", nav)
    Spacer(Modifier.height(PageGap))
    Column(
      Modifier.fillMaxWidth().padding(horizontal = PagePadH),
      verticalArrangement = Arrangement.spacedBy(PageGap),
    ) {
      LoadedBlock(
        state,
        onSignIn = { nav.navigate(Routes.SIGN_IN) },
        onRetry = { scope.launch { load() } },
      ) { v ->
        // FOUR ANSWERS, FOUR SENTENCES. `balance` is null for three of them, and
        // rendering 0 for any would send somebody to buy tokens they may hold.
        when (v.why) {
          "sign-in" -> Notice(
            title = "Sign in",
            body = "Sign in to see where your wallet stands.",
            actionLabel = "Sign in",
            onAction = { nav.navigate(Routes.SIGN_IN) },
          )
          // Linking a SEPARATE holder wallet is a signature flow this client
          // does not carry yet, so the copy no longer promises it — it states
          // what is true (your login wallet is what's checked) and points at the
          // web for the rest, rather than offering a "link another" the app
          // cannot deliver.
          "no-wallet" -> Notice(
            "No holder wallet linked",
            "Your \$MERRYMEN balance is read from your login wallet. To point the Circle at a " +
              "different wallet, use the merrymen web app.",
          )
          "unreadable" -> Notice(
            "Couldn't read your balance",
            "That's our chain read failing, not your wallet. " + (v.error ?: ""),
          )
          // AN UNKNOWN REASON IS NOT A SUCCESSFUL READ. `why` is a plain String
          // defaulting to "ok", so anything this build does not recognise —
          // including a reason the server adds later — used to fall through to
          // the panel below and render as a standing that had been read, with
          // "—" in Holding and `error` dropped on the floor. Four answers, four
          // sentences; the fifth gets its own.
          "ok" -> PresetCard("You") {
            Text(
              text = listOfNotNull(v.tier?.emoji, v.tier?.name).joinToString(" ").ifBlank { "—" },
              style = BodyText,
              color = MerryColors.tx,
            )
            KeyValueRow("Holding") {
              Text(
                text = v.balance?.let { grouped(it) } ?: "—",
                style = TextStyle(
                  fontFamily = numerals(FontWeight.W600),
                  fontSize = 13.sp,
                  fontWeight = FontWeight.W600,
                ),
                // The em dash is not a figure, so it does not get the figure's
                // colour — the same rule Money() follows.
                color = if (v.balance == null) MerryColors.faint else MerryColors.tx,
              )
            }
            // NO `?: 0` HERE, AND THAT IS THE POINT. This line used to read
            // "0 more to reach X" whenever the server did not send a distance,
            // which tells somebody they are already there. An unknown distance
            // means the line has nothing to say, so it does not appear.
            v.next?.let { n ->
              n.tokensToGo?.let { togo ->
                CardBlurb("${grouped(togo)} more to reach ${n.name}")
              }
            }
            v.holderAddress?.let {
              Text(
                text = breakable(it),
                style = KeyText,
                color = MerryColors.faint,
              )
            }
          }
          else -> Notice(
            "Couldn't read where you stand",
            v.error?.ifBlank { null }
              ?: "The server gave a reason this version of the app doesn't know yet (\"${v.why}\").",
          )
        }

        // The tier TABLE is public and renders in every arm — it is what makes
        // the signed-out answer useful rather than empty.
        v.tiers.forEach { t -> TierCard(t) }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

@Composable
private fun TierCard(t: CircleTier) {
  PresetCard(listOfNotNull(t.emoji, t.name).joinToString(" ")) {
    CardBlurb("${grouped(t.minTokens)} \$MERRYMEN")
    if (t.bonusStrategies) CardBlurb("Unlocks holder-only strategies")
    t.perks.forEach { CardBlurb("• $it") }
  }
}
