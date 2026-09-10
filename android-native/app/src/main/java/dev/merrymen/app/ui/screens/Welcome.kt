package dev.merrymen.app.ui.screens

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.Text
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.R
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import kotlin.random.Random
import kotlinx.coroutines.launch

/**
 * THE FIRST THING A NEW READER SEES.
 *
 * Built to the mockup the owner supplied, not ported from the web — the web has
 * no such page (its sign-in is an inline notice behind the gate). So this is the
 * one screen with no web counterpart to match; the reference is the mockup and
 * the brand mint `#4AD696`, and the constellation is drawn from the five
 * DITHERED stock marks the owner supplied, which already carry that colour baked
 * into their path data.
 *
 * A STARTUP PAGE, NOT A SECOND WALL. It shows on a cold start until the reader
 * signs in or goes on as a guest, then Session marks it seen and it never
 * returns. The gate is the one thing that stops you at the door; an introduction
 * that stopped you every launch would be a worse gate wearing a nicer coat.
 *
 * THE THREE DOORS. "Continue with X" and "Continue with wallet" both open the
 * web sign-in — that is where the owner key and Privy live, and this app never
 * holds a key (see WebAuth). The choice between X, email and wallet is the
 * Privy modal's to present; the two buttons are the same door dressed for the
 * two audiences the mockup names. "Continue as guest" simply goes in — the whole
 * product is readable without a wallet, and pretending otherwise at the door
 * would turn away the person still deciding.
 */
@Composable
fun WelcomeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val scope = rememberCoroutineScope()

  fun signIn() {
    // Seen, plainly — a reader on the web sign-in has been past the welcome.
    scope.launch { c.session.setWelcomed() }
    nav.navigate(Routes.SIGN_IN)
  }
  fun guest() {
    scope.launch { c.session.setWelcomed() }
    nav.navigate(Routes.HOME) {
      popUpTo(Routes.WELCOME) { inclusive = true }
    }
  }

  Box(
    Modifier
      .fillMaxSize()
      .background(MerryColors.bg)
      .windowInsetsPadding(WindowInsets.safeDrawing),
  ) {
    StarfieldGlow(Modifier.fillMaxSize())

    Column(Modifier.fillMaxSize()) {
      Constellation(Modifier.fillMaxWidth().height(392.dp))

      Spacer(Modifier.weight(1f))

      Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp)) {
        Text(
          buildAnnotatedString {
            withStyle(SpanWhite) { append("The next era\n") }
            withStyle(SpanMint) { append("trades itself.") }
          },
          style = TextStyle(
            fontFamily = sans(40.sp, FontWeight.Bold),
            fontSize = 40.sp,
            lineHeight = 44.sp,
            fontWeight = FontWeight.Bold,
          ),
        )
        Spacer(Modifier.height(12.dp))
        Text(
          "Create your account. Meet your agent.",
          style = TextStyle(fontFamily = sans(16.sp), fontSize = 16.sp),
          color = MerryColors.tx2,
        )

        Spacer(Modifier.height(24.dp))

        // PRIMARY — the mint pill, dark ink text, the X mark drawn rather than
        // pulled from an icon set that does not carry it.
        PillButton(
          background = MerryColors.mint,
          content = MerryColors.ink,
          border = null,
          onClick = ::signIn,
        ) { col ->
          XGlyph(col, Modifier.size(20.dp))
          Spacer(Modifier.width(12.dp))
          Text("Continue with X", style = pillLabel, color = col)
        }

        Spacer(Modifier.height(12.dp))

        // SECONDARY — transparent over a hairline, the wallet drawn as a stroke.
        PillButton(
          background = Color.Transparent,
          content = MerryColors.tx,
          border = MerryColors.line,
          onClick = ::signIn,
        ) { col ->
          WalletGlyph(col, Modifier.size(20.dp))
          Spacer(Modifier.width(12.dp))
          Text("Continue with wallet", style = pillLabel, color = col)
        }

        Spacer(Modifier.height(20.dp))

        Text(
          "Continue as guest  →",
          style = TextStyle(fontFamily = sans(16.sp, FontWeight.Medium), fontSize = 16.sp, textAlign = TextAlign.Center),
          color = MerryColors.mint,
          modifier = Modifier.fillMaxWidth().clickable(onClick = ::guest).padding(vertical = 8.dp),
        )

        Spacer(Modifier.height(16.dp))

        Text(
          "By continuing, you agree to our Terms and Privacy Policy.",
          style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, textAlign = TextAlign.Center),
          color = MerryColors.faint,
          modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))
      }
    }
  }
}

private val SpanWhite = androidx.compose.ui.text.SpanStyle(color = MerryColors.tx)
private val SpanMint = androidx.compose.ui.text.SpanStyle(color = MerryColors.mint)
private val pillLabel = TextStyle(fontFamily = sans(16.sp, FontWeight.SemiBold), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)

/**
 * A full-width pill, 56dp tall, ~fully rounded — the mockup's button geometry.
 * The trailing lambda draws the row content and is handed the content colour so
 * a glyph and its label cannot drift apart.
 */
@Composable
private fun PillButton(
  background: Color,
  content: Color,
  border: Color?,
  onClick: () -> Unit,
  row: @Composable androidx.compose.foundation.layout.RowScope.(Color) -> Unit,
) {
  Row(
    Modifier
      .fillMaxWidth()
      .height(56.dp)
      .background(background, RoundedCornerShape(28.dp))
      .then(if (border != null) Modifier.border(1.dp, border, RoundedCornerShape(28.dp)) else Modifier)
      .clickable(onClick = onClick),
    horizontalArrangement = Arrangement.Center,
    verticalAlignment = Alignment.CenterVertically,
  ) { row(content) }
}

/**
 * THE FIVE MARKS, scattered the way the mockup arranges them.
 *
 * Each is a VectorDrawable of a pre-dithered logo, already mint, so they are
 * only positioned and rotated here — never recoloured. Sizes and angles are the
 * mockup's; the wordmark sits in the middle of the cluster where the glow is
 * brightest. Positions are dp offsets from the top-start of a fixed-height band
 * so the arrangement holds across phone widths without reflowing.
 */
@Composable
private fun Constellation(modifier: Modifier) {
  Box(modifier) {
    Mark(R.drawable.logo_nvidia, 108.dp, x = 4.dp, y = 44.dp, rot = -8f, Alignment.TopStart)
    Mark(R.drawable.logo_amd, 60.dp, x = 0.dp, y = 6.dp, rot = 0f, Alignment.TopCenter)
    Mark(R.drawable.logo_apple, 92.dp, x = (-8).dp, y = 26.dp, rot = 7f, Alignment.TopEnd)
    Mark(R.drawable.logo_microsoft, 92.dp, x = 22.dp, y = 214.dp, rot = -4f, Alignment.TopStart)
    Mark(R.drawable.logo_tesla, 104.dp, x = (-16).dp, y = 196.dp, rot = 9f, Alignment.TopEnd)

    Text(
      "Merrymen",
      style = TextStyle(fontFamily = sans(30.sp, FontWeight.Bold), fontSize = 30.sp, fontWeight = FontWeight.Bold),
      color = MerryColors.tx,
      modifier = Modifier.align(Alignment.Center),
    )
  }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.Mark(
  @DrawableRes id: Int,
  size: androidx.compose.ui.unit.Dp,
  x: androidx.compose.ui.unit.Dp,
  y: androidx.compose.ui.unit.Dp,
  rot: Float,
  align: Alignment,
) {
  Image(
    painter = painterResource(id),
    contentDescription = null,
    modifier = Modifier
      .align(align)
      .offset(x = x, y = y)
      .size(size)
      .rotate(rot),
  )
}

/**
 * The ground: a soft mint glow bloomed behind the constellation, over a faint,
 * DETERMINISTIC starfield. Seeded so the stars do not re-scatter on every
 * recomposition — a field that twinkles under state changes reads as a bug.
 */
@Composable
private fun StarfieldGlow(modifier: Modifier) {
  val stars = remember {
    val r = Random(0x4AD696)
    List(90) { Triple(r.nextFloat(), r.nextFloat(), r.nextFloat()) }
  }
  Canvas(modifier) {
    // The bloom, centred on the cluster (~upper third), large and low-alpha.
    val c = Offset(size.width * 0.5f, size.height * 0.28f)
    drawCircle(
      brush = Brush.radialGradient(
        colors = listOf(MerryColors.mint.copy(alpha = 0.14f), Color.Transparent),
        center = c,
        radius = size.minDimension * 0.9f,
      ),
      radius = size.minDimension * 0.9f,
      center = c,
    )
    stars.forEach { (fx, fy, fr) ->
      // Denser toward the top, matching the mockup's night-sky feel.
      val y = fy * fy * size.height
      drawCircle(
        color = MerryColors.tx.copy(alpha = 0.06f + fr * 0.10f),
        radius = 0.6f + fr * 1.6f,
        center = Offset(fx * size.width, y),
      )
    }
  }
}

/** The X wordmark, filled in the button's content colour. Standard 24-view path. */
private val X_PATH = PathParser().parsePathString(
  "M18.9,1.5h3.6l-7.9,9l9.3,12.3h-7.3l-5.7-7.5l-6.5,7.5H0.7l8.5-9.7L0,1.5h7.5l5.2,6.8L18.9,1.5z" +
    "M17.6,20.6h2L6.4,3.3h-2.1L17.6,20.6z",
).toPath().apply { fillType = PathFillType.EvenOdd }

@Composable
private fun XGlyph(color: Color, modifier: Modifier) {
  Canvas(modifier) {
    val s = size.minDimension / 24f
    scale(s, s, pivot = Offset.Zero) { drawPath(X_PATH, color = color, style = Fill) }
  }
}

/** A wallet, drawn as strokes to match the mockup's thin outline. */
@Composable
private fun WalletGlyph(color: Color, modifier: Modifier) {
  Canvas(modifier) {
    val u = size.minDimension / 24f
    val sw = 2f * u
    translate(0f, 0f) {
      drawRoundRect(
        color = color,
        topLeft = Offset(3f * u, 6f * u),
        size = androidx.compose.ui.geometry.Size(18f * u, 13f * u),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(3f * u, 3f * u),
        style = Stroke(width = sw),
      )
      // the card slot / button
      drawCircle(color = color, radius = 1.6f * u, center = Offset(16.5f * u, 12.5f * u))
    }
  }
}
