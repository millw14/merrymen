package dev.merrymen.app.net

import kotlinx.serialization.Serializable

/** Current valuation and separately measured return; missing evidence stays unread. */
@Serializable
data class BookPerformance(
  val book: String? = null,
  val equityUsdg: Double? = null,
  val equityAt: Long? = null,
  val pnlUsdg: Double? = null,
  val pnlBps: Double? = null,
  val pnlAt: Long? = null,
  val publicBook: Boolean = false,
  val gasComplete: Boolean? = null,
  val held: Boolean = false,
  val fills: Int? = null,
  val fillsAtMark: Int? = null,
  val funded: Boolean? = null,
  val valuation: String? = null,
  val underReview: Boolean = false,
  val pnlEstimated: Boolean = false,
)

@Serializable
data class RetiredAgent(
  val slug: String? = null,
  val name: String? = null,
  val book: String? = null,
  val pnlBps: Double? = null,
  val estimated: Boolean = false,
  val trades: Int? = null,
  val lastValuedAt: Long? = null,
)
