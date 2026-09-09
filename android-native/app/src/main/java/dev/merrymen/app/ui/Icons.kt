package dev.merrymen.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * THE TAB ICONS, transcribed from the web's own SVG.
 *
 * `ui.tsx`'s `TabIcon` draws each one as a STROKED path on a 24x24 viewBox with
 * `fill="none" stroke="currentColor" strokeWidth="1.8"`. Material's icon set has
 * near-equivalents for three of them and they are the wrong drawings — the
 * Android bar was using a filled house, a speech bubble, a broadcast tower and
 * four sparkles, none of which appear anywhere in this product.
 *
 * The path strings below are copied character for character. Nothing here is
 * redrawn by eye.
 *
 * NOTE THE ALPHA ICON'S COMMENT IN THE SOURCE: "a rising edge with a mark on it
 * — a call, not a chart. Deliberately not the bar chart the leaderboard used."
 * That distinction is the reason it is not a generic trending glyph, so it is
 * worth not losing.
 */
private const val VIEW = 24f
private const val STROKE = 1.8f

private object Paths {
  const val HOME = "M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-8.5Z"
  const val CHAT =
    "M20.5 12c0 3.8-3.8 6.9-8.5 6.9a10 10 0 0 1-2.6-.34L4.4 20l1.2-3.4A6.4 6.4 0 0 1 3.5 12C3.5 8.2 7.3 5.1 12 5.1s8.5 3.1 8.5 6.9Z"
  /** Two subpaths: the rising edge, then the arrowhead. */
  const val ALPHA_EDGE = "M3.5 16.4 9 10.6l3.6 3.4 6.4-7.2"
  const val ALPHA_HEAD = "M15.2 6.4h4.4v4.3"
  const val YOU_HEAD_CX = 12f
  const val YOU_SHOULDERS = "M5.6 19c1.3-2.8 3.8-4.2 6.4-4.2S17.1 16.2 18.4 19"
}

/** One stroked 24x24 path, scaled to [size]. */
@Composable
private fun StrokeIcon(vararg data: String, tint: Color, size: Dp, modifier: Modifier = Modifier) {
  val paths = data.map { PathParser().parsePathString(it).toPath() }
  Canvas(modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    paths.forEach { p ->
      // Scale by drawing into a scaled coordinate space rather than by rebuilding
      // the path — the stroke width must scale with it or a 24px drawing at 28dp
      // renders a hairline.
      scale(s, s, pivot = androidx.compose.ui.geometry.Offset.Zero) {
        drawPath(
          path = p,
          color = tint,
          style = Stroke(width = STROKE, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
      }
    }
  }
}

@Composable
fun HomeIcon(tint: Color, size: Dp = 24.dp) = StrokeIcon(Paths.HOME, tint = tint, size = size)

@Composable
fun ChatIcon(tint: Color, size: Dp = 24.dp) = StrokeIcon(Paths.CHAT, tint = tint, size = size)

@Composable
fun AlphaIcon(tint: Color, size: Dp = 24.dp) =
  StrokeIcon(Paths.ALPHA_EDGE, Paths.ALPHA_HEAD, tint = tint, size = size)

/** A circle plus shoulders; the circle is a `<circle>` element, not a path. */
@Composable
fun YouIcon(tint: Color, size: Dp = 24.dp) {
  val shoulders = PathParser().parsePathString(Paths.YOU_SHOULDERS).toPath()
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / VIEW
    scale(s, s, pivot = androidx.compose.ui.geometry.Offset.Zero) {
      drawCircle(
        color = tint,
        radius = 3.1f,
        center = androidx.compose.ui.geometry.Offset(Paths.YOU_HEAD_CX, 9f),
        style = Stroke(width = STROKE),
      )
      drawPath(
        path = shoulders,
        color = tint,
        style = Stroke(width = STROKE, cap = StrokeCap.Round, join = StrokeJoin.Round),
      )
    }
  }
}

