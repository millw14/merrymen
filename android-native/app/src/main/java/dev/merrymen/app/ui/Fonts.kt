package dev.merrymen.app.ui

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import dev.merrymen.app.R

/**
 * THE WEB'S OWN FACES, not lookalikes.
 *
 * These are the exact woff2 files under `web/public/fonts`, decompressed to
 * TTF — the same outlines, the same subsets. (Written without the glob because
 * Kotlin NESTS block comments, so a slash-star inside a KDoc opens a comment
 * that never closes and reports itself as an error in another file entirely.
 * This is the second time it has cost a build here; see the README.)
 * Substituting a Google Fonts DM Sans
 * would be close but not the same file, and "close" is what this whole exercise
 * is trying to stop.
 *
 * THE STACK, from `--sans: "Geist Numerals", "DM Sans", system-ui`. Geist
 * Numerals is FIRST and is a ~10 KB subset that contains DIGITS and little else,
 * so in a browser it supplies figures and DM Sans supplies every letter. CSS
 * does that fallback per GLYPH; a Compose `FontFamily` does not — it resolves by
 * weight and style, not by coverage. So the split is made explicit here instead:
 * [Sans] for prose, [Numerals] for figures. Every place the web shows a number
 * in a column must use [Numerals], which is also what makes them tabular.
 *
 * `opsz` IS THE ONE THAT WILL BITE YOU. DM Sans is a variable font carrying
 * `opsz 9..40` with a DEFAULT OF 9 — an optical size cut for very small text,
 * with the looser spacing and heavier strokes that implies. A browser applies
 * `font-optical-sizing: auto` by default and feeds it the actual font-size, so
 * the web gets the right cut for free. Compose applies NOTHING and would render
 * every heading in the 9pt cut. [sans] takes the size and sets the axis, so the
 * app gets the same outlines the browser draws.
 */
private const val OPSZ_MIN = 9f
private const val OPSZ_MAX = 40f

/**
 * DM Sans at a given size and weight, with `opsz` set the way a browser would.
 *
 * Built per call site rather than cached in a handful of constants because the
 * axis is a function of the size, and the type scale has more sizes than it
 * would be honest to round to.
 */
@OptIn(ExperimentalTextApi::class)
fun sans(size: TextUnit, weight: FontWeight = FontWeight.Normal): FontFamily {
  val opsz = size.value.coerceIn(OPSZ_MIN, OPSZ_MAX)
  return FontFamily(
    Font(
      R.font.dm_sans,
      weight = weight,
      variationSettings = FontVariation.Settings(
        FontVariation.weight(weight.weight),
        FontVariation.Setting("opsz", opsz),
      ),
    ),
  )
}

/** The plain stack, for anywhere a size is not known up front. */
val Sans: FontFamily = sans(15.sp)

/**
 * FIGURES. The web's `--sans` resolves digits to this face, and it is what makes
 * a column of money line up.
 */
@OptIn(ExperimentalTextApi::class)
fun numerals(weight: FontWeight = FontWeight.Medium): FontFamily = FontFamily(
  Font(
    R.font.geist_numerals,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
  ),
)

val Numerals: FontFamily = numerals()

/** `--pixel`. Static, no axes — the one face here that is not variable. */
val Pixel: FontFamily = FontFamily(Font(R.font.geist_pixel))
