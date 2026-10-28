package dev.merrymen.app.ui

import dev.merrymen.app.net.Position

private val POSITION_TICKER = Regex("^[A-Za-z0-9._-]{1,32}$")
private val GENERATED_POSITION_SYMBOL = Regex("^T[0-9A-F]{11}$", RegexOption.IGNORE_CASE)
private val POSITION_ADDRESS = Regex("^0x[0-9a-f]{40}$", RegexOption.IGNORE_CASE)

/** Mirrors web/terminal/position-token.ts; a display label never replaces the ledger key. */
fun positionLabel(position: Position): String {
  // Position's default preserves an older feed's absent display_symbol;
  // explicit null from a newer feed must not fall back to its ledger symbol.
  val ticker = position.displaySymbol.orEmpty().trim().trimStart('$')
  if (POSITION_TICKER.matches(ticker) && !ticker.startsWith("0x", ignoreCase = true) &&
    !GENERATED_POSITION_SYMBOL.matches(ticker)) {
    return "\$$ticker"
  }
  val address = position.token
  return if (address != null && POSITION_ADDRESS.matches(address)) {
    address.take(6) + "…" + address.takeLast(4)
  } else "Unknown token"
}
