package dev.merrymen.app.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * The terminal's palette, carried across so the two clients are recognisably one
 * product. Taken from web/src/terminal/terminal.css rather than re-invented.
 *
 * GAIN AND LOSS ARE NOT THE ACCENT. `up` and `down` mean money moved and are
 * reserved for that; anything else borrowing them makes a number look like a
 * result. The same rule the web's `.wire-beat.view` comment states.
 */
private val Ink = Color(0xFF0B0B0C)
private val Card = Color(0xFF141416)
private val Line = Color(0xFF2A2A2E)
private val Paper = Color(0xFFFAFAF8)
private val PaperCard = Color(0xFFFFFFFF)
private val PaperLine = Color(0xFFE3E3DE)
private val Brand = Color(0xFFC8A24C)

val Up = Color(0xFF3FB950)
val Down = Color(0xFFE5534B)
/** Neither: a decision that came to nothing. */
val Neutral = Color(0xFF8B8B93)

private val DarkColors = darkColorScheme(
  primary = Brand,
  onPrimary = Ink,
  background = Ink,
  onBackground = Color(0xFFEDEDEF),
  surface = Card,
  onSurface = Color(0xFFEDEDEF),
  surfaceVariant = Color(0xFF1C1C20),
  onSurfaceVariant = Color(0xFFA8A8B0),
  outline = Line,
  error = Down,
)

private val LightColors = lightColorScheme(
  primary = Color(0xFF8A6D2F),
  onPrimary = Color.White,
  background = Paper,
  onBackground = Color(0xFF16161A),
  surface = PaperCard,
  onSurface = Color(0xFF16161A),
  surfaceVariant = Color(0xFFF1F1EC),
  onSurfaceVariant = Color(0xFF5A5A62),
  outline = PaperLine,
  error = Color(0xFFB3261E),
)

/** Figures line up in columns, so digits must be the same width. */
val MonoNumbers = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)

private val AppTypography = Typography(
  headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
  titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
  bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
  bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
  labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp),
)

@Composable
fun MerrymenTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
  val colors = if (dark) DarkColors else LightColors
  val view = LocalView.current
  if (!view.isInEditMode) {
    SideEffect {
      val window = (view.context as Activity).window
      WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !dark
    }
  }
  MaterialTheme(colorScheme = colors, typography = AppTypography, content = content)
}
