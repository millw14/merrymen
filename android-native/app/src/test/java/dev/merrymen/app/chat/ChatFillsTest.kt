package dev.merrymen.app.chat

import dev.merrymen.app.data.ChatLine
import dev.merrymen.app.data.LineOrder
import dev.merrymen.app.data.MAX_LINES
import dev.merrymen.app.data.absorbFill
import dev.merrymen.app.data.capThread
import dev.merrymen.app.data.chatTape
import dev.merrymen.app.data.mergeFills
import dev.merrymen.app.data.newestAt
import dev.merrymen.app.data.tradeKeyOf
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.OrderReceipt
import dev.merrymen.app.ui.ChatMove
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE AGENT'S OWN FILLS, ONE TRADE TO ONE LINE.
 *
 * The web's chat-thread.test.ts cases for mergeFills, capThread and
 * absorbFill, run against the port. Each case is a way the web once showed
 * one trade twice, or dumped old trades into the conversation as news.
 */
class ChatFillsTest {
  private val t0 = 1_800_000_000L

  private fun move(
    at: Long = t0,
    action: String? = "buy",
    symbol: String? = "CASHCAT",
    size: Double? = 5.0,
    outcome: String = "landed",
    paper: Boolean = false,
    tx: String? = null,
  ) = ChatMove(at = at, action = action, symbol = symbol, sizeUsdg = size, outcome = outcome, outcomeText = null, paper = paper, txHash = tx)

  private fun receipt(side: String = "buy", symbol: String = "CASHCAT", usdg: Double? = 5.0, tx: String? = null) =
    OrderReceipt(status = "filled", side = side, symbol = symbol, usdgActual = usdg, txHash = tx)

  private fun msg(id: String, at: Long?, text: String = "", role: String = "agent", order: LineOrder? = null, tradeKey: String? = null, side: String? = null) =
    ChatLine(id = id, role = role, at = at, text = text, side = side, order = order, tradeKey = tradeKey)

  private fun events(m: List<ChatLine>) = m.filter { it.role == "event" }

  // ── the agent's own fills, merged into the thread ───────────────────────

  private val since = t0 - 1

  @Test fun aNewLandedFillAppearsOnceKeyedByTheTrade() {
    val first = mergeFills(emptyList(), listOf(move()), since)
    assertEquals(1, first.size)
    assertEquals("event", first[0].role)
    assertEquals("buy", first[0].side)
    assertEquals("\$5.00 CASHCAT · Filled", first[0].text)
    assertEquals("CASHCAT", first[0].trade?.symbol)
    assertSame("an unchanged tape changes nothing", first, mergeFills(first, listOf(move()), since))
  }

  @Test fun nothingOlderThanTheWatermarkIsDumpedIntoTheThread() {
    assertTrue(mergeFills(emptyList(), listOf(move(at = since - 100), move(at = since)), since).isEmpty())
  }

  @Test fun refusalsPendingsHoldsAndRevertsAreNotFills() {
    val tape = listOf(
      move(outcome = "refused", at = since + 1),
      move(outcome = "pending", at = since + 2),
      move(action = "hold", at = since + 3),
      move(outcome = "reverted", at = since + 4),
      move(action = null, at = since + 5),
    )
    assertTrue(mergeFills(emptyList(), tape, since).isEmpty())
  }

  @Test fun aPaperFillIsNotAnnouncedAsAFill() {
    assertTrue(mergeFills(emptyList(), listOf(move(paper = true)), since).isEmpty())
    assertTrue(mergeFills(emptyList(), listOf(move(paper = true, action = "sell"), move(paper = true, at = since + 5)), since).isEmpty())
    assertEquals("a real fill beside it still is one", 1, mergeFills(emptyList(), listOf(move(paper = true, at = since + 5), move()), since).size)
  }

  @Test fun aChatOrdersReceiptIsTheSameTradeNotASecondOne() {
    val placed = msg("o", t0 * 1000 - 30_000, "bought 5.00 USDG of CASHCAT", order = LineOrder("abc", receipt = receipt()))
    val merged = mergeFills(listOf(placed), listOf(move()), since)
    assertEquals("the fill joins the receipt instead of repeating it", 1, merged.size)
    assertEquals("CASHCAT", merged[0].trade?.symbol)
    assertNotNull(merged[0].tradeKey)
  }

  @Test fun butADifferentFillOfTheSameCoinIsItsOwnEvent() {
    val placed = msg("o", t0 * 1000, order = LineOrder("abc", receipt = receipt(usdg = 20.0)))
    assertEquals(2, mergeFills(listOf(placed), listOf(move()), since).size)
  }

  @Test fun aThreadReadBackGetsItsTradesFromTheTapeHoweverOld() {
    val key = tradeKeyOf(move(at = since - 500))!!
    val kept = msg("f", null, "\$5.00 CASHCAT · Filled", role = "event", tradeKey = key, side = "buy")
    val back = mergeFills(listOf(kept), listOf(move(at = since - 500)), since)
    assertEquals(since - 500, back[0].trade?.at)
    assertEquals(1, back.size)
  }

  @Test fun aReceiptThatArrivesAfterItsFillAbsorbsIt() {
    val merged = mergeFills(emptyList(), listOf(move()), since)
    val answer = msg("o", t0 * 1000 + 5_000, "bought it", order = LineOrder("abc", receipt = receipt()))
    val after = absorbFill(merged + answer, "o")
    assertEquals(1, after.size)
    assertEquals("o", after[0].id)
    assertEquals(merged[0].tradeKey, after[0].tradeKey)
    assertEquals("CASHCAT", after[0].trade?.symbol)
    val other = msg("p", t0 * 1000, order = LineOrder("def", receipt = receipt(usdg = 9.0)))
    assertEquals("a receipt for a different size leaves the fill where it was", 2, absorbFill(merged + other, "p").size)
  }

  @Test fun aFillThatFallsOffTheTopOfAFullThreadIsNotNewsAgain() {
    val tape = listOf(move(at = since + 1), move(at = since + 2, symbol = "PEPE"))
    val fills = mergeFills(emptyList(), tape, since)
    val chatter = (0 until MAX_LINES - 2).map { msg("c$it", null, "line $it", role = "owner") }
    val full = fills + chatter + msg("new", null, "one more", role = "owner")
    val (kept, keptSince) = capThread(full, since)
    assertEquals(MAX_LINES, kept.size)
    assertEquals("the oldest line went", fills[1].id, kept[0].id)
    assertSame("and the tape does not bring it back as news", kept, mergeFills(kept, tape, keptSince!!))
    val later = mergeFills(kept, listOf(move(at = since + 3, symbol = "WIF")) + tape, keptSince)
    assertEquals("a fill newer than anything trimmed is still news", "\$5.00 WIF · Filled", later.last().text)
  }

  @Test fun aThreadUnderTheLimitIsReturnedAsItWasAndAnUnsetWatermarkStaysUnset() {
    val one = listOf(msg("a", null))
    val (same, s) = capThread(one, 7)
    assertSame(one, same)
    assertEquals(7L, s)
    val (_, unset) = capThread((0..MAX_LINES).map { msg("x$it", null) }, null)
    assertNull(unset)
  }

  @Test fun aTapeNobodyReadIsNotAnEmptyOne() {
    val json = Json { ignoreUnknownKeys = true; explicitNulls = false; isLenient = true }
    val feed = json.decodeFromString<Feed>(ChatRig.FEED)
    assertEquals(1, chatTape(true, feed)!!.size)
    val empty = json.decodeFromString<Feed>("""{"source":"sqlite","agent":{"name":"Shogun"},"trades":[]}""")
    assertEquals("read and empty is empty", emptyList<ChatMove>(), chatTape(true, empty))
    val unread = json.decodeFromString<Feed>("""{"source":"none","trades":[]}""")
    assertNull("a feed that did not answer is not a tape", chatTape(true, unread))
    assertNull("no read, no tape", chatTape(true, null))
    assertNull("no agent, no tape", chatTape(false, feed))
    assertNull("an account not read yet, no tape", chatTape(null, feed))
  }

  @Test fun theWatermarkIsTheNewestTradeAlreadyOnTheTape() {
    assertEquals(9L, newestAt(listOf(move(at = 5), move(at = 9), move(at = 0))))
    assertEquals(0L, newestAt(emptyList()))
  }

  @Test fun theKeyPrefersTheChainHashWhenTheTapeCarriesOne() {
    val tx = "0x" + "cd".repeat(32)
    assertEquals("tx:$tx", tradeKeyOf(move(tx = tx.uppercase().replace("0X", "0x"))))
    assertEquals("t:$t0:buy:CASHCAT:5:l", tradeKeyOf(move()))
    assertNull(tradeKeyOf(move(action = "hold")))
  }

  // ── a chat SELL joins its fill too ─────────────────────────────────────

  private val t = 1_800_000_000L
  private val sellSince = t - 3_600
  private fun sold(at: Long = t, size: Double? = 5.01, tx: String? = null) = move(at = at, action = "sell", symbol = "TSLA", size = size, tx = tx)
  private val placedSell = msg("p", t * 1000 - 60_000, "Placed it — sell TSLA.", order = LineOrder("abc"))
  private fun sellAnswer(usdg: Double? = null, tx: String? = null, at: Long = t * 1000 + 20_000) =
    msg("o", at, "sold TSLA", order = LineOrder("abc", receipt = receipt(side = "sell", symbol = "TSLA", usdg = usdg, tx = tx)))

  @Test fun aQuoteBookedSellIsOneLine() {
    val merged = mergeFills(listOf(placedSell, sellAnswer()), listOf(sold()), sellSince)
    assertEquals("no second line", 0, events(merged).size)
    assertEquals("the receipt holds the fill", "TSLA", merged[1].trade?.symbol)
  }

  @Test fun aReceiptBookedSellIsOneLineWhateverItsFigureSays() {
    val merged = mergeFills(listOf(placedSell, sellAnswer(usdg = 4.97)), listOf(sold()), sellSince)
    assertEquals(0, events(merged).size)
    assertNotNull(merged[1].tradeKey)
  }

  @Test fun andWhenTheTapeShowsItFirstTheReceiptAbsorbsIt() {
    val tapeFirst = mergeFills(listOf(placedSell), listOf(sold()), sellSince)
    assertEquals(1, events(tapeFirst).size)
    val after = absorbFill(tapeFirst + sellAnswer(), "o")
    assertEquals(0, events(after).size)
    assertEquals(tapeFirst.last().tradeKey, after.last().tradeKey)
  }

  @Test fun aSellOfTheSameCoinFromBeforeTheOrderWasPlacedIsNotItsFill() {
    val earlier = sold(at = t - 600, size = 2.0)
    val merged = mergeFills(listOf(placedSell, sellAnswer()), listOf(sold(), earlier), sellSince)
    assertEquals("the receipt took the order's fill", t, merged[1].trade?.at)
    assertEquals("and the earlier sell kept its own line", listOf(t - 600), events(merged).map { it.trade?.at })
    val tapeFirst = mergeFills(listOf(placedSell), listOf(earlier), sellSince)
    assertEquals("an earlier sell is never absorbed", 1, events(absorbFill(tapeFirst + sellAnswer(), "o")).size)
  }

  @Test fun norIsOneThatFilledAfterTheOrderWasAnswered() {
    assertEquals(1, events(mergeFills(listOf(placedSell, sellAnswer()), listOf(sold(at = t + 600)), sellSince)).size)
  }

  @Test fun twoFillsInTheWindowTheReceiptTakesTheOneNearestItsAnswer() {
    val soon = sold(at = t - 50, size = 1.0)
    val merged = mergeFills(listOf(placedSell, sellAnswer()), listOf(sold(), soon), sellSince)
    assertEquals(t, merged[1].trade?.at)
    val tapeFirst = mergeFills(listOf(placedSell), listOf(soon, sold()), sellSince)
    val after = absorbFill(tapeFirst + sellAnswer(), "o")
    assertEquals(t, after.first { it.id == "o" }.trade?.at)
    assertEquals(listOf(t - 50), events(after).map { it.trade?.at })
  }

  @Test fun theChainHashDecidesWhenBothSidesCarryOne() {
    val tx = "0x" + "ab".repeat(32)
    val other = "0x" + "cd".repeat(32)
    assertEquals("the same hash is one trade", 0, events(mergeFills(listOf(placedSell, sellAnswer(tx = tx)), listOf(sold(tx = tx)), sellSince)).size)
    assertEquals(
      "a different hash is not, whatever else agrees",
      1,
      events(mergeFills(listOf(placedSell, sellAnswer(tx = tx)), listOf(sold(tx = other)), sellSince)).size,
    )
  }

  @Test fun aBuysSizeMustStillAgree() {
    val bought = msg("o", t * 1000 + 20_000, "bought", order = LineOrder("abc", receipt = receipt(usdg = 20.0)))
    assertEquals(1, events(mergeFills(listOf(placedSell, bought), listOf(move(at = t)), sellSince)).size)
  }

  @Test fun twoSellsOfOneCoinEachReceiptTakesItsOwnFill() {
    val two = listOf(
      msg("p1", t * 1000 - 100_000, "Placed 1", order = LineOrder("aaa")),
      msg("o1", t * 1000 + 20_000, "sold 1", order = LineOrder("aaa", receipt = receipt(side = "sell", symbol = "TSLA", usdg = null))),
      msg("p2", t * 1000 + 30_000, "Placed 2", order = LineOrder("bbb")),
      msg("o2", t * 1000 + 90_000, "sold 2", order = LineOrder("bbb", receipt = receipt(side = "sell", symbol = "TSLA", usdg = null))),
    )
    val first = mergeFills(two, listOf(sold()), sellSince)
    assertEquals("the first receipt takes the first fill", t, first.first { it.id == "o1" }.trade?.at)
    assertNull("and the second does not take it too", first.first { it.id == "o2" }.tradeKey)
    val second = mergeFills(first, listOf(sold(at = t + 60), sold()), sellSince)
    assertEquals("the second receipt takes the second fill", t + 60, second.first { it.id == "o2" }.trade?.at)
    assertTrue("two sells, two lines — no fill line left over", events(second).isEmpty())
  }

  // ── a phone clock that is wrong does not split one trade ────────────────

  private val placedAt = t * 1000 - 20_000
  private val answeredAt = t * 1000 + 15_000
  private val skews = listOf(0L, 3, 5, 11, -3, -5, -11)

  /** The two lines a chat order leaves, stamped by a phone [skewMin] off; the placing line keeps the server's time when POST gave it. */
  private fun lines(side: String, skewMin: Long, server: Boolean = true) = listOf(
    msg("p", placedAt + skewMin * 60_000, "Placed it", order = LineOrder("abc", serverPlacedAt = if (server) placedAt else null)),
    msg("o", answeredAt + skewMin * 60_000, "done", order = LineOrder("abc", receipt = receipt(side = side, symbol = "TSLA", usdg = if (side == "buy") 5.0 else null))),
  )

  private fun fill(side: String, at: Long = t, size: Double = 5.0) = move(at = at, action = side, symbol = "TSLA", size = size)

  /** Extra lines for one trade, in both orders of arrival. */
  private fun extra(side: String, skewMin: Long, server: Boolean = true): List<Int> {
    val (placed, answer) = lines(side, skewMin, server)
    val receiptFirst = events(mergeFills(listOf(placed, answer), listOf(fill(side)), sellSince)).size
    val tapeFirst = events(absorbFill(mergeFills(listOf(placed), listOf(fill(side)), sellSince) + answer, "o")).size
    return listOf(receiptFirst, tapeFirst)
  }

  @Test fun aChatBuyOrSellIsOneLineHoweverFarThePhonesClockIsOff() {
    for (side in listOf("buy", "sell")) {
      for (skew in skews) assertEquals("$side, $skew minutes off", listOf(0, 0), extra(side, skew))
    }
  }

  @Test fun aBuyWhosePlacingTheServerDidNotTimeStillJoinsOnItsSizeWithinHalfAnHour() {
    for (skew in skews) assertEquals("$skew minutes off", listOf(0, 0), extra("buy", skew, server = false))
    assertEquals("but not a fill forty minutes from the answer", listOf(1, 1), extra("buy", 40, server = false))
  }

  @Test fun onTheServersClockTheOrdersLifeStillShutsOutTheAgentsOwnSells() {
    for (skew in listOf(5L, -5, 11)) {
      val earlier = fill("sell", at = t - 600, size = 2.0)
      val later = fill("sell", at = t + 600, size = 3.0)
      val merged = mergeFills(lines("sell", skew), listOf(later, fill("sell"), earlier), sellSince)
      assertEquals("${skew}m: the receipt took the order's own fill", t, merged.first { it.id == "o" }.trade?.at)
      assertEquals("${skew}m: the others kept their own lines", listOf(t - 600, t + 600), events(merged).map { it.trade?.at })
    }
  }

  @Test fun ofTwoSellsInsideTheOrdersLifeTheNearestIsJudgedOnTheServersClock() {
    for (skew in listOf(11L, -11, 0)) {
      val own = fill("sell")
      val agents = fill("sell", at = t + 100, size = 3.0)
      val (placed, answer) = lines("sell", skew)
      val receiptFirst = mergeFills(listOf(placed, answer), listOf(agents, own), sellSince)
      val tapeFirst = absorbFill(mergeFills(listOf(placed), listOf(agents, own), sellSince) + answer, "o")
      for ((order, merged) in listOf("receipt first" to receiptFirst, "tape first" to tapeFirst)) {
        assertEquals("${skew}m, $order: the receipt took the order's own fill", t, merged.first { it.id == "o" }.trade?.at)
        assertEquals("${skew}m, $order: the agent's sell is its own line, once", listOf(t + 100), events(merged).map { it.trade?.at })
      }
    }
  }

  @Test fun aBuyOfTheSameSizeFromBeforeTheOrderIsNotItsFill() {
    val earlier = fill("buy", at = t - 600)
    val early = mergeFills(lines("buy", 5), listOf(earlier), sellSince)
    assertNull("the receipt waits", early.first { it.id == "o" }.tradeKey)
    assertEquals(listOf(t - 600), events(early).map { it.trade?.at })
    val later = mergeFills(early, listOf(fill("buy"), earlier), sellSince)
    assertEquals("and takes its own fill when it comes", t, later.first { it.id == "o" }.trade?.at)
    assertEquals(listOf(t - 600), events(later).map { it.trade?.at })
  }

  // ── the tape learning a trade's hash ────────────────────────────────────

  @Test fun aLineKeyedBeforeTheTapeCarriedTheHashIsNotRepeatedOnceItDoes() {
    val first = mergeFills(emptyList(), listOf(move()), since)
    assertEquals(1, first.size)
    val kept = first.map { it.copy(trade = null) }
    val again = mergeFills(kept, listOf(move(tx = "0x" + "ef".repeat(32))), since)
    assertEquals("one trade, one line", 1, again.size)
    assertEquals("and it gets its trade back", "CASHCAT", again[0].trade?.symbol)
  }
}
