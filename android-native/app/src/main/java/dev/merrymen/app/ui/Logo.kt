package dev.merrymen.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * THE MARK, transcribed rather than redrawn.
 *
 * `web/src/terminal/ui.tsx` builds it from nineteen rounded rectangles on a
 * 940x630 viewBox — no path data, no curves beyond the corner radii. So this is
 * the same nineteen rectangles at the same coordinates, scaled. Redrawing it as
 * an approximated vector would have been quicker and would have been a different
 * logo; a mark is the one thing in a UI that is either right or wrong.
 *
 * IT IS THE CENTRE TAB, not decoration. `nav.ts` says so in as many words —
 * "FEED IS THE CENTRE, under the logo — which is where the logo already was" —
 * so the middle slot of the bar draws this and not a glyph from an icon set.
 *
 * `fill="currentColor"` on the web, so the colour is the caller's.
 */
private data class Brick(
  val x: Float,
  val y: Float,
  val w: Float,
  val h: Float,
  val r: Float,
)

private const val VIEW_W = 940f
private const val VIEW_H = 630f

/** The nineteen, in source order, from ui.tsx. */
private val BRICKS = listOf(
  Brick(280f, 1f, 324f, 47f, 23.5f),
  Brick(403f, 72f, 258f, 49f, 24.5f),
  Brick(138f, 137f, 51f, 54f, 25.5f),
  Brick(473f, 137f, 227f, 54f, 27f),
  Brick(742f, 137f, 50f, 54f, 25f),
  Brick(64f, 212f, 199f, 48f, 24f),
  Brick(516f, 212f, 204f, 48f, 24f),
  Brick(766f, 212f, 109f, 48f, 24f),
  Brick(0f, 288f, 126f, 48f, 24f),
  Brick(161f, 288f, 582f, 48f, 24f),
  Brick(812f, 288f, 128f, 48f, 24f),
  Brick(64f, 366f, 199f, 47f, 23.5f),
  Brick(518f, 366f, 202f, 47f, 23.5f),
  Brick(766f, 366f, 109f, 47f, 23.5f),
  Brick(138f, 436f, 51f, 48f, 24f),
  Brick(473f, 436f, 227f, 48f, 24f),
  Brick(742f, 436f, 51f, 48f, 24f),
  Brick(403f, 510f, 259f, 48f, 24f),
  Brick(280f, 582f, 324f, 47f, 23.5f),
)

/**
 * @param height the mark's height. Width follows the viewBox ratio, exactly as
 *   `ui.tsx` does it — `Math.round(size * (940 / 630))`.
 */
@Composable
fun LogoMark(height: Dp = 22.dp, tint: Color = Color.Unspecified, modifier: Modifier = Modifier) {
  val colour = if (tint == Color.Unspecified) MerryColors.tx else tint
  Canvas(modifier.size(width = height * (VIEW_W / VIEW_H), height = height)) {
    val s = size.height / VIEW_H
    BRICKS.forEach { b ->
      drawRoundRect(
        color = colour,
        topLeft = Offset(b.x * s, b.y * s),
        size = Size(b.w * s, b.h * s),
        cornerRadius = CornerRadius(b.r * s, b.r * s),
      )
    }
  }
}
