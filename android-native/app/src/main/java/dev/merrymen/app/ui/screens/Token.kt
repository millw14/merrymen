package dev.merrymen.app.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.net.TokenHolder
import dev.merrymen.app.ui.Bar
import dev.merrymen.app.ui.Bps
import dev.merrymen.app.ui.ChartKind
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.Pill
import dev.merrymen.app.ui.PriceChart
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.shortAddress
import kotlinx.coroutines.launch

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
    Loaded.Value(trim(trim(out, VENUE_CUT[window]), WINDOW_SECONDS[window]))
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

  val watched by c.session.watchlist.collectAsState(initial = emptySet())
  val starred = address.lowercase() in watched

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

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Token", nav)
    LoadedBlock(detail, onRetry = { scope.launch { detail = c.api.token(address, barSizeFor(window)).toLoaded() } }) { t ->
      val name = t.market.symbol ?: t.ledger.symbol ?: t.market.coin?.name ?: "This token"
      val price = t.market.stock?.priceUsd ?: t.market.coin?.priceUsd

      SectionCard {
        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Column {
            Text(name, style = MaterialTheme.typography.titleLarge)
            t.market.stock?.name?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            if (t.market.stock == null) {
              t.market.coin?.name?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
          }
          Row {
            // DEVICE-LOCAL, and the note under it says so. A star here does not
            // appear on the web, because neither watchlist has ever left the
            // device it was made on.
            IconButton(onClick = {
              scope.launch {
                c.session.toggleWatch(address)
                said = if (starred) null else "Starred on this device. The web keeps its own list."
              }
            }) {
              Icon(
                if (starred) Icons.Filled.Star else Icons.Filled.StarBorder,
                contentDescription = if (starred) "Watching" else "Watch",
                tint = if (starred) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
              )
            }
            IconButton(onClick = { scope.launch { said = share(ctx, c.repo.originNow(), address, name) } }) {
              Icon(Icons.Filled.Share, contentDescription = "Share")
            }
          }
        }

        Row(
          Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Money(price, bold = true)
          t.market.coin?.change24hPct?.let { Bps((it * 100).toInt()) }
        }

        // A HALT MAY ONLY BE ASSERTED WHEN THE CHAIN ANSWERED. Null is our own
        // uncertainty and says so; it is never rendered as "trading normally".
        when (t.market.stock?.paused) {
          true -> Text("Trading is halted on this token.", style = MaterialTheme.typography.bodySmall)
          null -> if (t.market.kind != "memecoin") {
            Text(
              "We could not read whether trading is halted.",
              style = MaterialTheme.typography.bodySmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
          }
          false -> Unit
        }

        // ON-CURVE RESERVE IS MOSTLY VIRTUAL SEED — a fresh curve reports about
        // $4,100 of "reserve" while holding none of it — so it is never
        // presented as money anybody could sell into.
        if (t.market.coin?.onCurve == true) {
          Text(
            "Still on its bonding curve. The depth the index reports for a curve is mostly a " +
              "virtual seed, not money you could sell into.",
            style = MaterialTheme.typography.bodySmall,
          )
        }

        // BOTH TICKERS ARE ATTACKER-CHOSEN, and theses are matched to a page by
        // symbol. Without this line an agent's real reasoning about NVDA prints
        // on an impostor's page, attributed to a holder of the impostor.
        if (t.market.symbolClash) {
          Notice(
            title = "Another listed token shares this ticker",
            body = "A ticker is a string whoever deployed the token picked. Check the address " +
              "before you read anything here as being about the listed one.",
          )
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
          Text(shortAddress(address) ?: address, style = MaterialTheme.typography.labelSmall)
          IconButton(onClick = { said = copy(ctx, address) }) {
            Icon(Icons.Filled.ContentCopy, contentDescription = "Copy address")
          }
        }
        said?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
      }

      SectionCard("Price") {
        Row(
          Modifier.horizontalScroll(rememberScrollState()),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          WINDOWS.forEach { w -> Pill(w, window == w) { window = w } }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          Pill("Candles", kind == ChartKind.CANDLE) { kind = ChartKind.CANDLE }
          Pill("Line", kind == ChartKind.LINE) { kind = ChartKind.LINE }
        }
        ChartBlock(bars, kind, t)
      }

      HoldersCard(t, nav)
    }
    Spacer(Modifier.height(24.dp))
  }
}

/**
 * The chart, or the reason there is not one — and those reasons are not
 * interchangeable.
 *
 * `mismatch` and `none` are facts about the POOL. `refused` is a fact about our
 * read. Rendering the third as either of the first two states something about a
 * token out of our own outage, which is the rule this whole repo is built on.
 */
@Composable
private fun ChartBlock(bars: Loaded<List<Bar>>, kind: ChartKind, t: TokenDetail) {
  val candles = t.candles
  when (bars) {
    is Loaded.Value ->
      if (bars.value.isEmpty()) {
        Text(
          when {
            candles?.state == "mismatch" ->
              "The index has bars for this pool, but they are about the other side of the pair — " +
                "so they are not this token's prices and are not drawn."
            candles?.state == "none" -> "This pool has published no bars in that span."
            candles?.state == "refused" -> "We could not read the price series just now."
            else -> "No bars for that span."
          },
          style = MaterialTheme.typography.bodySmall,
        )
      } else {
        // THE NEWEST BAR IS ALWAYS PARTIAL — measured at one minute into an
        // hour, one sixtieth complete — so it is drawn faint and said out loud.
        val partial = candles?.lastBarAgeSec?.let { candles.interval > 0 && it < candles.interval } ?: true
        PriceChart(bars.value, kind, partialLast = partial)
        val gaps = candles?.gaps ?: 0
        Text(
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
          style = MaterialTheme.typography.labelSmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    is Loaded.Refused -> Text(
      "The chart venue said no (${bars.status}). That is our read failing, not a price.",
      style = MaterialTheme.typography.bodySmall,
    )
    is Loaded.Unreachable -> Text(
      "We could not reach the chart venue: " + bars.cause,
      style = MaterialTheme.typography.bodySmall,
    )
    else -> Text("Loading the chart…", style = MaterialTheme.typography.bodySmall)
  }
}

/**
 * WHO IS HOLDING IT — from the agents' own published books.
 *
 * A PRETEND FILL MUST NOT LOOK LIKE A REAL ONE, which is why `paper` and
 * `basisSource` are rendered rather than dropped: three different things arrive
 * here — a receipt read off a settled transaction, a paper fill that is exact
 * but simulated, and a pre-trade quote that is an estimate of a price nothing
 * traded at. The web's first port of this list dropped both, and every marker on
 * a public page then read as somebody's money.
 */
@Composable
private fun HoldersCard(t: TokenDetail, nav: NavHostController) {
  SectionCard("Who holds it") {
    if (t.ledger.holders.isEmpty()) {
      // AN UNREAD LEDGER IS NOT AN EMPTY ONE, and the flag exists so this
      // sentence is not a claim about retention manufactured from an exception.
      Text(
        if (t.ledger.fillsRead) "No agent that publishes its book is holding this."
        else "We could not read the trade history, so we cannot say who is holding this.",
        style = MaterialTheme.typography.bodySmall,
      )
    } else {
      t.ledger.holders.forEach { h -> HolderRow(h, nav) }
    }
    if (t.ledger.privateHolders > 0) {
      Text(
        "${t.ledger.privateHolders} more " +
          (if (t.ledger.privateHolders == 1) "agent holds" else "agents hold") +
          " it without publishing a book.",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun HolderRow(h: TokenHolder, nav: NavHostController) {
  Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      NameBlock(title = h.name.ifBlank { h.slug ?: "an agent" }, owner = h.handle, verified = false)
      Column(horizontalAlignment = Alignment.End) {
        Money(h.valueUsdg)
        Bps(h.pnlBps)
      }
    }
    val caveat = entryCaveat(h)
    val entry = h.entryPriceUsd
    if (entry != null) {
      Text("in at " + money(entry) + caveat, style = MaterialTheme.typography.labelSmall)
    } else if (caveat.isNotBlank()) {
      Text(
        caveat.removePrefix(" — ").replaceFirstChar { ch -> ch.uppercase() },
        style = MaterialTheme.typography.labelSmall,
      )
    }
    h.slug?.let { slug ->
      TextButton(onClick = { nav.navigate(Routes.agent(slug)) }) { Text("Their desk") }
    }
  }
}

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

/** Enough digits for a price that can be very small, without pretending to more. */
private fun money(v: Double): String =
  if (v >= 1.0) "$" + String.format(java.util.Locale.US, "%,.2f", v)
  else "$" + String.format(java.util.Locale.US, "%.8f", v).trimEnd('0').trimEnd('.')

/**
 * COPY, and say so.
 *
 * Android 13 and later shows its own confirmation toast for a clipboard write,
 * so a second one would double up — hence a line in the card rather than a
 * toast, on every version.
 */
private fun copy(ctx: Context, address: String): String {
  val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    ?: return "This device would not give us the clipboard."
  cm.setPrimaryClip(ClipData.newPlainText("token address", address))
  return "Address copied."
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
