package dev.merrymen.app.feed

import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.DiscoveryCoin
import dev.merrymen.app.net.ThesesPage
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.ui.feed.Basis
import dev.merrymen.app.ui.feed.CallFigure
import dev.merrymen.app.ui.feed.FigureTone
import dev.merrymen.app.ui.feed.TradeBeat
import dev.merrymen.app.ui.feed.ViewBeat
import dev.merrymen.app.ui.feed.beatsOf
import dev.merrymen.app.ui.feed.callFigure
import dev.merrymen.app.ui.feed.callFigureText
import dev.merrymen.app.ui.feed.compactUsd
import dev.merrymen.app.ui.feed.dealSizeOf
import dev.merrymen.app.ui.feed.liveTokensOf
import dev.merrymen.app.ui.feed.livePriceOf
import dev.merrymen.app.ui.feed.pctBps
import dev.merrymen.app.ui.feed.tokenFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * THE CALL'S OWN NUMBER, and the coin it is priced against — over the
 * captured posts and the captured market (probe-theses.json, probe-market.json).
 *
 * The rule under test is the one the web learned the hard way: a figure is
 * printed only when every input was read and positive, and a row is priced
 * only against the ONE token that answers to it by address or by listed
 * symbol. Anything else prints nothing.
 */
class CallFigureTest {
  private val page: ThesesPage = served("probe-theses.json") { it.theses() }
  private val market: TokensPage = served("probe-market.json") { it.market() }
  private val beats = beatsOf(page.theses)
  private val tokens = liveTokensOf(market, null)

  private val mylaBuy = beats.filterIsInstance<TradeBeat>().first { it.core.actor.name == "Myla" }

  @Test fun aLandedBuyIsMeasuredFromItsFillAgainstTheListedPrice() {
    val live = livePriceOf(tokens, "TSLA")
    assertEquals(378.34, live!!, 1e-9)
    val f = callFigure(mylaBuy, live)!!
    assertEquals(Basis.SINCE_ENTRY, f.basis)
    assertEquals((378.34 / 380.265 - 1) * 100, f.pct, 1e-9)
    // −0.5%, with the house minus and the loss tone.
    val text = callFigureText(f)
    assertEquals("−0.5%", text.pct)
    assertEquals(FigureTone.DOWN, text.tone)
    assertNull(text.usd)
  }

  @Test fun noLivePriceMeansNoFigureNeverAZero() {
    assertNull(callFigure(mylaBuy, null))
    assertNull(callFigure(mylaBuy, 0.0))
    assertNull(callFigure(mylaBuy, -1.0))
    assertNull(callFigure(mylaBuy, Double.NaN))
    // Without the market read, the row has no price to be measured against.
    assertNull(livePriceOf(liveTokensOf(null, null), "TSLA"))
  }

  @Test fun aViewIsMeasuredSinceItWasPosted() {
    val hold = beats.filterIsInstance<ViewBeat>().first { it.symbol == "TSLA" && it.core.markUsd != null }
    val f = callFigure(hold, livePriceOf(tokens, "TSLA"))!!
    assertEquals(Basis.SINCE_POSTED, f.basis)
    // The mark was 378.34 and so is the price: flat, printed without a sign.
    assertEquals("0.0%", callFigureText(f).pct)
    assertEquals(FigureTone.FLAT, callFigureText(f).tone)
  }

  @Test fun aViewWithNoMarkHasNoFigure() {
    val bare = beats.filterIsInstance<ViewBeat>().first { it.core.markUsd == null }
    assertNull(callFigure(bare, 100.0))
  }

  @Test fun aTradeThatDidNotLandHasNoFigureAndAShadowIsSincePosted() {
    val row = page.theses.first { it.action == "buy" }
    val refused = beatsOf(listOf(row.copy(outcome = "refused"))).single()
    assertNull(callFigure(refused, 400.0))
    val shadow = beatsOf(listOf(row.copy(shadow = true, markUsd = 380.0))).single()
    assertEquals(Basis.SINCE_POSTED, callFigure(shadow, 399.0)!!.basis)
  }

  @Test fun aSellShowsWhatItRealizedAndItsDollarsOnlyWhenSent() {
    val row = page.theses.first { it.action == "buy" }.copy(action = "sell", sizeUsdg = 50.0)
    val private = beatsOf(listOf(row.copy(realizedPct = -4.0, realizedUsd = null))).single()
    val f = callFigure(private, null)!!
    assertEquals(Basis.REALIZED, f.basis)
    assertNull(f.usd)
    // The size beside a realized % whose dollars were withheld IS the dollars,
    // one line of arithmetic away — so it is not printed either.
    assertNull(dealSizeOf(private))

    val public = beatsOf(listOf(row.copy(realizedPct = 3.2, realizedUsd = 0.62))).single()
    val text = callFigureText(callFigure(public, null)!!)
    assertEquals("+3.2%", text.pct)
    assertEquals("+$0.62", text.usd)
    assertEquals(50.0, dealSizeOf(public)!!, 0.0)
  }

  @Test fun theSignFollowsWhatIsPrinted() {
    assertEquals("−$0.16", callFigureText(CallFigure(Basis.REALIZED, -3.2, -0.16)).usd)
    // Under half a cent prints "$0.00" — and a minus beside it would claim a loss nobody sees.
    assertEquals("$0.00", callFigureText(CallFigure(Basis.REALIZED, -0.01, -0.004)).usd)
    assertEquals(FigureTone.FLAT, callFigureText(CallFigure(Basis.REALIZED, 0.049, null)).tone)
    assertEquals(FigureTone.UP, callFigureText(CallFigure(Basis.REALIZED, 0.05, null)).tone)
    assertEquals("−12.3%", pctBps(-1234.0))
    assertEquals("+1,234.5%", pctBps(123450.0))
  }

  // ── which coin ────────────────────────────────────────────────────────────

  private fun coin(address: String, name: String, price: Double?) = DiscoveryCoin(token = address, name = name, priceUsd = price)

  @Test fun aTrencherIdMatchesOnlyTheCoinWhoseAddressItWasMintedFrom() {
    val chump = coin("0x" + "0".repeat(29) + "7631dacc21b", "CHUMP / WETH", 0.05)
    val list = liveTokensOf(market, Discoveries(rows = listOf(chump, coin("0x" + "1".repeat(40), "OTHER / WETH", 9.0))))
    assertEquals(chump.token, tokenFor(list, "T7631DACC21B")?.id)
    assertEquals(0.05, livePriceOf(list, "T7631DACC21B")!!, 0.0)
  }

  @Test fun twoCoinsAnsweringIsAGuessAndAGuessIsNoToken() {
    val a = coin("0x" + "a".repeat(29) + "7631dacc21b", "ONE", 0.05)
    val b = coin("0x" + "b".repeat(29) + "7631dacc21b", "TWO", 7.0)
    val list = liveTokensOf(market, Discoveries(rows = listOf(a, b)))
    assertNull(tokenFor(list, "T7631DACC21B"))
    assertNull(livePriceOf(list, "T7631DACC21B"))
  }

  @Test fun aMemecoinCallingItselfATickerNeverPricesTheStock() {
    // Somebody deploys "TSLA" at a price of their choosing.
    val impostor = coin("0x" + "c".repeat(40), "TSLA / WETH", 99999.0)
    val list = liveTokensOf(market, Discoveries(rows = listOf(impostor)))
    assertEquals(378.34, livePriceOf(list, "TSLA")!!, 1e-9)
    // And a ticker never reaches a memecoin: with no listed stock, no price.
    assertNull(livePriceOf(liveTokensOf(null, Discoveries(rows = listOf(impostor))), "TSLA"))
  }

  @Test fun discoveryNeverTurnsAListedStockIntoAMemecoin() {
    val aapl = market.tokens.first { it.symbol == "AAPL" }
    val list = liveTokensOf(market, Discoveries(rows = listOf(coin(aapl.address!!, "AAPL / WETH", 1.0))))
    val t = list.single { it.id == aapl.address!!.lowercase() }
    assertEquals("stock", t.kind)
    assertNotNull(livePriceOf(list, "AAPL"))
  }

  @Test fun aMarketCapPrintsOnlyWhenOneWasRecorded() {
    val row = page.theses.first { it.action == "buy" }
    assertNull(beatsOf(listOf(row.copy(mcapUsd = 0.0))).single().core.mcapUsd)
    assertNull(beatsOf(listOf(row.copy(mcapUsd = null))).single().core.mcapUsd)
    assertEquals("$3.5M", compactUsd(beatsOf(listOf(row.copy(mcapUsd = 3519339.32))).single().core.mcapUsd))
    assertEquals("$604.4K", compactUsd(604389.1))
    assertEquals("$1M", compactUsd(999_990.0))
  }
}
