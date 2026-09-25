package dev.merrymen.app.chat

import dev.merrymen.app.ui.ChatChip
import dev.merrymen.app.ui.amountCeiling
import dev.merrymen.app.ui.chatChips
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE AMOUNT CHIPS NEVER OFFER WHAT THE SERVER WOULD REFUSE.
 *
 * The web's amountCeiling and chatChips, ported. The cases are the ones the
 * web found the hard way: a ceiling of 9.999 printed as "$10.00 (max)", which
 * the orders route refused, and 8.2 × 100 landing a hair below 820.
 */
class ChatChipsTest {
  @Test fun theClampIsFlooredToTheCentAndNeverAboveTheLimit() {
    assertEquals(9.99, amountCeiling(25.0, 9.999)!!, 0.0)
    assertEquals("8.2 stays 8.20, not 8.19", 8.20, amountCeiling(8.2, 100.0)!!, 0.0)
    assertEquals(5.0, amountCeiling(5.0, 25.0)!!, 0.0)
  }

  @Test fun aCeilingOfZeroIsNoCeilingSoTheSealedCapAloneClamps() {
    assertEquals(40.0, amountCeiling(40.0, 0.0)!!, 0.0)
  }

  @Test fun anUnreadInputOffersNoAmountAtAll() {
    assertNull(amountCeiling(null, 25.0))
    assertNull(amountCeiling(25.0, null))
    assertNull(amountCeiling(0.0, 25.0))
    assertNull("less than a cent is no amount to offer", amountCeiling(0.004, 25.0))
  }

  private fun chips(lastAgent: String?, perTrade: Double?, ceiling: Double?, latest: String? = "NVDA", holding: List<String> = listOf("NVDA")) =
    chatChips(null, stopped = false, latestSymbol = latest, holding = holding, lastAgent = lastAgent, perTrade = perTrade, ceiling = ceiling)

  @Test fun howMuchDrawsTwoStepsBelowTheClampAndTheMax() {
    val c = chips("How much should I put in?", perTrade = 30.0, ceiling = 25.0)
    assertEquals(
      listOf(ChatChip("\$5.00", "\$5.00"), ChatChip("\$10.00", "\$10.00"), ChatChip("\$25.00 (max)", "\$25.00")),
      c.take(3),
    )
    assertEquals("sizes leave room for one question at most", 3, c.size)
  }

  @Test fun noChipIsEverAboveTheLimit() {
    for (cap in listOf(1.0, 4.99, 5.0, 7.5, 9.999, 25.0, 1000.0)) {
      val max = amountCeiling(cap, 0.0) ?: continue
      for (chip in chips("what size?", perTrade = cap, ceiling = 0.0)) {
        if (!chip.label.startsWith("$")) continue
        val v = chip.message.removePrefix("$").replace(",", "").toDouble()
        assertTrue("$v over $max", v <= max)
      }
    }
  }

  @Test fun anUnreadCeilingOffersNoSizesEvenWhenAsked() {
    assertTrue(chips("How much?", perTrade = 30.0, ceiling = null).none { it.label.startsWith("$") })
  }

  @Test fun theContextChipsComeInTheWebsOrder() {
    assertEquals(
      listOf("Why NVDA?", "What do you hold?", "Trading limits"),
      chips("Here is my take.", 30.0, 25.0).map { it.label },
    )
    assertEquals(
      listOf("Why can't you trade?", "My strategy", "Trading limits"),
      chips(null, 30.0, 25.0, latest = null, holding = emptyList()).map { it.label },
    )
    assertEquals(
      "a blocker leads, and there are never more than four",
      listOf("Why can't you trade?", "Why NVDA?", "What do you hold?", "Trading limits"),
      chatChips("no-gas", false, "NVDA", listOf("NVDA"), null, 30.0, 25.0).map { it.label },
    )
  }
}
