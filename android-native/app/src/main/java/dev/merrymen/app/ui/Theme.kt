package dev.merrymen.app.ui

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * THE WEB TERMINAL'S PALETTE, VERBATIM.
 *
 * Every value below is copied from the `.terminal-host` block in
 * `web/src/terminal/terminal.css` (line 607). The previous version of this file
 * claimed the same provenance and did not have it — it carried `#0B0B0C`
 * against the web's `#070806`, a gold `#C8A24C` against the web's lime
 * `#a5ce1f`, and up/down greens and reds that were a different green and a
 * different red. Close enough to look intentional, wrong enough that the two
 * clients did not look like one product.
 *
 * THE PHONE USES THE BASE TOKENS. `terminal.css:5868` redefines `--faint`,
 * `--tx-2` and `--line` — but inside `@media (min-width: 1100px)`, which is the
 * desktop shell. Below that breakpoint the base values stand, so those three
 * overrides are deliberately NOT here.
 *
 * THERE IS NO LIGHT THEME, because the web has none — no `prefers-color-scheme`
 * rule exists in the terminal's stylesheet. This file used to ship a light
 * scheme, which is why the app rendered as a white Material app on an emulator
 * set to light while the product it mirrors is near-black.
 */
object MerryColors {
  /** `--bg` — the ground. Near-black with a green cast, not neutral grey. */
  val bg = Color(0xFF070806)
  /** `--card` */
  val card = Color(0xFF12130F)
  /** `--raised` */
  val raised = Color(0xFF1A1B16)
  /** `--tx` — primary text. */
  val tx = Color(0xFFECECE4)
  /** `--tx-2` — secondary text. */
  val tx2 = Color(0xFFABADA1)
  /** `--faint` — the quietest legible text. */
  val faint = Color(0xFF898C80)
  /** `--line` — every border. */
  val line = Color(0xFF24261E)
  /** `--ink` — text ON the accent. */
  val ink = Color(0xFF111111)

  /**
   * `--lime` — THE accent, and the only one.
   *
   * Not a brand gold. This is what the web highlights with.
   */
  val lime = Color(0xFFA5CE1F)

  /**
   * `--up` / `--down`: MONEY MOVED, and nothing else may borrow them.
   *
   * The rule the web states about `.wire-beat.view`: a number wearing the gain
   * colour reads as a result. A refused trade never gets [up]; an emptiness
   * never gets [down].
   */
  val up = Color(0xFF3DD68C)
  val down = Color(0xFFFF5C71)

  /**
   * `#4AD696` — the ONBOARDING mint.
   *
   * The brand green of the welcome page and the colour the dithered stock marks
   * are drawn in (they ship with it baked into their path fill). Deliberately
   * kept distinct from [up]: [up] means money moved and may appear on a figure,
   * where this is a marketing accent that never sits on a number.
   */
  val mint = Color(0xFF4AD696)
}

/** Kept at these names because the screens already read them. */
val Up = MerryColors.up
val Down = MerryColors.down

/** Neither gain nor loss: a decision that came to nothing. */
val Neutral = MerryColors.faint

/** `--r: 16px`. Every card corner in the terminal. */
val CardRadius = 16.dp

/**
 * Figures line up in columns, so digits must be the same width — and on the web
 * they come from Geist Numerals rather than from the prose face.
 */
val MonoNumbers = TextStyle(fontFamily = Numerals, fontWeight = FontWeight.Medium)

/**
 * Material's slots, filled from the terminal's tokens.
 *
 * The screens read `MaterialTheme.colorScheme.*`, so mapping here restyles all
 * of them at once rather than leaving a hunt through every file. The mapping is
 * stated rather than guessed: `surface` is a CARD and `surfaceVariant` is the
 * RAISED surface, which is how the web uses them.
 */
private val TerminalColors = darkColorScheme(
  primary = MerryColors.lime,
  onPrimary = MerryColors.ink,
  background = MerryColors.bg,
  onBackground = MerryColors.tx,
  surface = MerryColors.card,
  onSurface = MerryColors.tx,
  surfaceVariant = MerryColors.raised,
  onSurfaceVariant = MerryColors.tx2,
  outline = MerryColors.line,
  outlineVariant = MerryColors.line,
  error = MerryColors.down,
  onError = MerryColors.ink,
  scrim = MerryColors.bg,
)

private val AppTypography = Typography(
  headlineSmall = TextStyle(fontFamily = sans(22.sp, FontWeight.SemiBold), fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
  titleLarge = TextStyle(fontFamily = sans(20.sp, FontWeight.SemiBold), fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
  titleMedium = TextStyle(fontFamily = sans(16.sp, FontWeight.SemiBold), fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
  bodyMedium = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 22.sp),
  bodySmall = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp, lineHeight = 18.sp),
  labelMedium = TextStyle(fontFamily = sans(13.sp, FontWeight.Medium), fontSize = 13.sp, fontWeight = FontWeight.Medium),
  labelSmall = TextStyle(fontFamily = sans(11.sp, FontWeight.Medium), fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.6.sp),
)

/**
 * @param dark ignored, and kept only so call sites do not have to change. The
 *   terminal has one appearance; following the device into light mode would
 *   invent a design the product does not have.
 */
@Composable
fun MerrymenTheme(dark: Boolean = true, content: @Composable () -> Unit) {
  val view = LocalView.current
  if (!view.isInEditMode) {
    SideEffect {
      val window = (view.context as Activity).window
      // Light glyphs in the status bar, because the ground behind them is
      // always near-black now.
      WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
    }
  }
  MaterialTheme(colorScheme = TerminalColors, typography = AppTypography, content = content)
}
