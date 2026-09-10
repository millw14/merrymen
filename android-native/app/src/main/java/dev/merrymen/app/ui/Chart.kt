package dev.merrymen.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

/**
 * THE PRICE CHART, drawn by hand — and the holes left as holes.
 *
 * The web loads TradingView's lightweight-charts for this, and the reasoning
 * there (a crosshair, a pannable axis, a tooltip that follows the pointer) does
 * not carry over: there is no pointer here, and the equivalent Android library
 * would be a 500kB dependency for a read-only chart on one screen. What DOES
 * carry over is the honesty defect that library taught us about, and it is the
 * whole reason this file is more than a polyline.
 *
 * BARS ARE PLACED AT CONSECUTIVE SLOTS, NOT AT THEIR TIMESTAMPS. That is how
 * every candle renderer works, and handed the bars alone it means a 63-hour
 * hole occupies ZERO horizontal distance and the chart draws straight across
 * it. Measured on one real pool: 421 bars over 792 hours — 47% of the range
 * missing, in 43 separate runs, the longest 63 hours. So the holes are padded
 * with EMPTY slots here, and a line breaks across them rather than joining two
 * prices with a segment that never happened.
 *
 * `PriceLine`'s caption on the web says what a viewer is looking at — the
 * periods the feed published nothing "are left out rather than drawn across,
 * which is what the breaks are" — and that promise is kept here.
 */
data class Bar(val time: Long, val open: Double, val high: Double, val low: Double, val close: Double)

/**
 * WHERE THIS STILL DIVERGES FROM THE WEB, said rather than hidden.
 *
 * [ChartKind.CANDLE] matches: same 220px stage, same `--up`/`--down` bodies,
 * borders and wicks, same gaps-stay-gaps treatment, and — as on a phone — no
 * price scale, no time scale, no grid and no price line.
 *
 * [ChartKind.LINE] DOES NOT. The web's line mode is not a polyline: it is
 * `DitherChart`, a low-resolution canvas scaled up with `image-rendering:
 * pixelated`, filling under the series with an ordered dither in the dither-kit's
 * own `rgb(40,210,110)` / `rgb(240,70,70)` — deliberately different greens and
 * reds from the terminal's tokens — with a dashed crosshair, a clamped tooltip
 * and round agent "riders" along the series. That is a licensed component and a
 * substantial piece of drawing; reproducing it by eye would produce something
 * that looks like it and is not it. This draws an honest polyline instead, with
 * the same breaks across gaps, and the difference is recorded here rather than
 * left for somebody to find.
 */
enum class ChartKind { CANDLE, LINE }

/**
 * A cap on how many blank slots one hole may consume.
 *
 * The same 500 the web uses. A pool that published four bars in a year would
 * otherwise pad tens of thousands of empty slots and the real bars would be a
 * smudge at the right-hand edge.
 */
private const val MAX_WHITESPACE = 500

/**
 * The bar size in seconds — the MODE of the gaps, not the median.
 *
 * The interval is a property of the REQUEST ("give me 5-minute bars"), so the
 * right estimate is the spacing that occurs most often. A median is wrong in
 * exactly the case that matters: five-minute bars with one weekend in them have
 * gaps [300, 300, …, 250000], and on a short series the median lands between
 * the two — 750 seconds of nothing anybody asked for, which then pads the hole
 * at the wrong resolution.
 *
 * Ties go to the SMALLER gap: bars cannot be closer together than the
 * resolution, so the smallest spacing observed is an upper bound on the size.
 */
fun barInterval(bars: List<Bar>): Long {
  if (bars.size < 2) return 0
  val seen = HashMap<Long, Int>()
  for (i in 1 until bars.size) {
    val gap = bars[i].time - bars[i - 1].time
    if (gap > 0) seen[gap] = (seen[gap] ?: 0) + 1
  }
  var best = 0L
  var bestCount = 0
  for ((gap, count) in seen) {
    if (count > bestCount || (count == bestCount && best != 0L && gap < best)) {
      best = gap
      bestCount = count
    }
  }
  return best
}

/** Bars, plus a null for every slot inside the range that has none. */
fun withGaps(bars: List<Bar>): Pair<List<Bar?>, Boolean> {
  val interval = barInterval(bars)
  val out = ArrayList<Bar?>(bars.size)
  var padded = 0
  for (i in bars.indices) {
    val bar = bars[i]
    val prev = bars.getOrNull(i - 1)
    if (prev != null && interval > 0) {
      var t = prev.time + interval
      while (t < bar.time && padded < MAX_WHITESPACE) {
        out.add(null)
        padded++
        t += interval
      }
    }
    out.add(bar)
  }
  return out to (padded >= MAX_WHITESPACE)
}

/**
 * @param partialLast whether the newest bar is still forming. It ALWAYS is —
 *   measured at one minute into an hour, one sixtieth complete — and drawing it
 *   like a settled bar states a high and a low the rest of the period has not
 *   had a chance to break. So it is drawn faint, and the caption says why.
 */
@Composable
fun PriceChart(
  bars: List<Bar>,
  kind: ChartKind,
  partialLast: Boolean,
  modifier: Modifier = Modifier,
) {
  if (bars.isEmpty()) return
  val (slots, _) = withGaps(bars)
  // NAMED, NOT BORROWED FROM THE MATERIAL SLOTS. `primary` is the lime accent,
  // and a rising candle drawn in it would say "live" rather than "up" — the one
  // colour rule this product states outright. The web sets body, border and wick
  // all to --up / --down.
  val up = MerryColors.up
  val down = MerryColors.down
  val line = MerryColors.tx

  // ONE SCALE FOR EVERY MARK. Taken over the highs and lows actually drawn, so
  // nothing can be placed outside the box it is drawn in.
  val lows = slots.filterNotNull().minOf { it.low }
  val highs = slots.filterNotNull().maxOf { it.high }
  // A flat series still needs a band, or every bar lands on one pixel row.
  val pad = if (highs > lows) (highs - lows) * 0.06 else (if (highs != 0.0) kotlin.math.abs(highs) * 0.02 else 1.0)
  val lo = lows - pad
  val hi = highs + pad
  val span = (hi - lo).takeIf { it > 0 } ?: 1.0

  Canvas(modifier.fillMaxWidth().height(220.dp)) {
    val w = size.width
    val h = size.height
    val slotW = w / slots.size
    fun y(v: Double): Float = (h - ((v - lo) / span) * h).toFloat()

    // NO AXES, NO GRID, NO BASELINE — on a phone. The web configures its
    // renderer with `visible: desktop` for both the price scale and the time
    // scale, and `grid.vertLines/horzLines.visible: desktop`, where `desktop` is
    // `matchMedia("(min-width:1100px)")`. It also sets `priceLineVisible: false`,
    // so nothing is drawn across the plot either. The baseline that used to sit
    // here was a line the web does not draw at this width.

    if (kind == ChartKind.LINE) {
      val path = Path()
      var open = false
      slots.forEachIndexed { i, bar ->
        val x = i * slotW + slotW / 2f
        if (bar == null) {
          // THE BREAK IS THE POINT. A hole ends the current run rather than
          // being joined across, which is what "left out rather than drawn
          // across" means when it is drawn instead of said.
          open = false
          return@forEachIndexed
        }
        if (!open) {
          path.moveTo(x, y(bar.close))
          open = true
        } else {
          path.lineTo(x, y(bar.close))
        }
      }
      drawPath(path, color = line, style = Stroke(width = 2f))
    } else {
      val bodyW = maxOf(1f, slotW * 0.6f)
      slots.forEachIndexed { i, bar ->
        if (bar == null) return@forEachIndexed
        val x = i * slotW + slotW / 2f
        val rising = bar.close >= bar.open
        val faint = partialLast && i == slots.lastIndex
        val colour: Color = (if (rising) up else down).copy(alpha = if (faint) 0.45f else 1f)
        drawLine(colour, Offset(x, y(bar.high)), Offset(x, y(bar.low)), strokeWidth = maxOf(1f, slotW * 0.12f))
        val top = y(maxOf(bar.open, bar.close))
        val bottom = y(minOf(bar.open, bar.close))
        drawLine(
          colour,
          Offset(x, top),
          Offset(x, maxOf(bottom, top + 1f)),
          strokeWidth = bodyW,
        )
      }
    }
  }
}
