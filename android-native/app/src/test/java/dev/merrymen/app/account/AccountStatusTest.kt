package dev.merrymen.app.account

import dev.merrymen.app.net.EquityPoint
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.Position
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.TradeRecord
import dev.merrymen.app.ui.BlockerFix
import dev.merrymen.app.ui.TapeItem
import dev.merrymen.app.ui.TapeOp
import dev.merrymen.app.ui.TapeStatus
import dev.merrymen.app.ui.TelegramRow
import dev.merrymen.app.ui.TrencherRow
import dev.merrymen.app.ui.accountPct
import dev.merrymen.app.ui.accountUsd
import dev.merrymen.app.ui.accountVaultUsdOf
import dev.merrymen.app.ui.blockerAdviceOf
import dev.merrymen.app.ui.blockerFixOf
import dev.merrymen.app.ui.blockerIsStale
import dev.merrymen.app.ui.ethFromWei
import dev.merrymen.app.ui.lastHeardText
import dev.merrymen.app.ui.modeChipOf
import dev.merrymen.app.ui.pnlLineOf
import dev.merrymen.app.ui.positionLinesOf
import dev.merrymen.app.ui.rejectRuleLabel
import dev.merrymen.app.ui.tapeItemsOf
import dev.merrymen.app.ui.tapeRowsOf
import dev.merrymen.app.ui.telegramRowOf
import dev.merrymen.app.ui.telegramStartUrl
import dev.merrymen.app.ui.telegramStripValue
import dev.merrymen.app.ui.trencherRowOf
import dev.merrymen.app.ui.triedLine
import dev.merrymen.app.ui.usdgFromUnits
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P03: WHAT HOME AND YOU MAY SAY ABOUT THE OWNER'S OWN ACCOUNT, rule by rule.
 * Each case is one of the web's (account.ts, swaps.ts, agent-status.ts,
 * lib/live-blocker.ts, lib/rank-pnl.ts) run against this port.
 */
class AccountStatusTest {

  // ── positions ────────────────────────────────────────────────────────────

  private fun pos(value: Double?, cost: Double?, fromQuote: Boolean?, stale: Int = 0) =
    Position(symbol = "CASHCAT", valueUsdg = value, costUsdg = cost, costFromQuote = fromQuote, priceStaleRaw = stale)

  @Test fun aVouchedCostGetsItsReturnBesideTheValue() {
    val line = positionLinesOf(listOf(pos(120.0, 100.0, fromQuote = false))).single()
    assertEquals("$120.00", line.detail)
    assertEquals(20.0, line.pnlPct!!, 1e-9)
    assertEquals("+20.00%", line.pctText)
  }

  @Test fun aCostFromAQuoteIsUnconfirmedAndGetsNoReturn() {
    // Only an explicit false vouches: true and null (unread provenance) do not.
    for (q in listOf(true, null)) {
      val line = positionLinesOf(listOf(pos(120.0, 100.0, fromQuote = q))).single()
      assertEquals("$120.00 · cost unconfirmed", line.detail)
      assertNull(line.pnlPct)
      assertNull(line.pctText)
    }
  }

  @Test fun noCostIsCostUnknownNeverAFreePosition() {
    for (cost in listOf(null, 0.0, -5.0)) {
      val line = positionLinesOf(listOf(pos(50.0, cost, fromQuote = false))).single()
      assertEquals("$50.00 · cost unknown", line.detail)
      assertNull(line.pnlPct)
    }
  }

  @Test fun aStaleMarkKeepsItsValueAndLosesItsReturn() {
    val line = positionLinesOf(listOf(pos(80.0, 100.0, fromQuote = false, stale = 1))).single()
    assertEquals("$80.00 · last mark", line.detail)
    assertNull(line.pnlPct)
  }

  @Test fun positionsWorthNothingAreLeftOffAsTheWebLeavesThemOff() {
    assertTrue(positionLinesOf(listOf(pos(0.0, 10.0, false), pos(null, 10.0, false))).isEmpty())
  }

  // ── P&L ──────────────────────────────────────────────────────────────────

  private fun book(
    equity: Double? = 130.0,
    contributed: Double? = 100.0,
    gas: Double? = 2.0,
    unpriced: Int? = 0,
    landed: Int? = 3,
    known: Boolean? = true,
  ) = Feed(
    source = "sqlite",
    equity = if (equity == null) emptyList() else listOf(EquityPoint(equityUsdg = equity)),
    netContributionsUsdg = contributed,
    gasUsdg = gas,
    gasUnpricedTrades = unpriced,
    landed = landed,
    contributionsKnown = known,
  )

  @Test fun theReturnIsNetOfContributionsAndGas() {
    val p = pnlLineOf(book(), "live")!!
    assertEquals(28.0, p.usd, 1e-9)
    assertEquals(28.0, p.pct, 1e-9)
    assertEquals("+$28.00 (+28.00%) all time", p.text)
  }

  @Test fun theReturnIsWithheldUnlessEveryTermIsEvidence() {
    assertNull("no deposit on record", pnlLineOf(book(contributed = null), "live"))
    assertNull("a zero deposit", pnlLineOf(book(contributed = 0.0), "live"))
    assertNull("nothing landed", pnlLineOf(book(landed = 0), "live"))
    assertNull("landed unread", pnlLineOf(book(landed = null), "live"))
    assertNull("contributions inferred", pnlLineOf(book(known = false), "live"))
    assertNull("contributions never assessed", pnlLineOf(book(known = null), "live"))
    assertNull("no mark", pnlLineOf(book(equity = null), "live"))
    assertNull("gas unread", pnlLineOf(book(gas = null), "live"))
    // A simulated balance minus real deposits is a number about nothing.
    assertNull("a paper book", pnlLineOf(book(), "paper"))
    assertNull("mode unread", pnlLineOf(book(), null))
  }

  @Test fun unpricedGasIsSaidBesideTheReturn() {
    assertEquals("-$12.00 (-12.00%) all time · gas for 2 trades not priced", pnlLineOf(book(equity = 90.0, unpriced = 2), "live")!!.text)
    assertEquals("+$28.00 (+28.00%) all time · gas for 1 trade not priced", pnlLineOf(book(unpriced = 1), "live")!!.text)
  }

  // ── the mode chip, the heartbeat and the balances ────────────────────────

  @Test fun theModeChipIsOnlyWhatTheHeartbeatSaid() {
    assertEquals("LIVE", modeChipOf("live"))
    assertEquals("PAPER", modeChipOf("paper"))
    assertEquals("IDLE", modeChipOf("idle"))
    assertNull(modeChipOf(null))
    assertNull(modeChipOf("offline"))
  }

  @Test fun lastHeardCountsFromEpochSeconds() {
    val now = 1_758_800_000_000L
    assertEquals("Last heard 3m ago", lastHeardText(now / 1000 - 180, now))
    assertEquals("Last heard 30s ago", lastHeardText(now / 1000 - 30, now))
    assertEquals("Last heard 5h ago", lastHeardText(now / 1000 - 5 * 3600, now))
    assertEquals("Last heard 3d ago", lastHeardText(now / 1000 - 3 * 86400, now))
    // A heartbeat the phone's clock puts in the future is not a negative age.
    assertEquals("Last heard just now", lastHeardText(now / 1000 + 60, now))
    assertNull(lastHeardText(null, now))
  }

  @Test fun anUnreadBalanceIsNeverZero() {
    assertEquals(12.5, usdgFromUnits("12500000")!!, 1e-9)
    assertEquals(0.0, usdgFromUnits("0")!!, 0.0)
    assertNull(usdgFromUnits(null))
    assertNull(usdgFromUnits(""))
    assertNull(usdgFromUnits("lots"))
    assertEquals("0.0042 ETH", ethFromWei("4200000000000000"))
    assertEquals("0 ETH", ethFromWei("0"))
    assertNull(ethFromWei(null))
  }

  @Test fun moneyIsSaidTheWebsWay() {
    assertEquals("$1,234.56", accountUsd(1234.56))
    assertEquals("-$3.10", accountUsd(-3.1))
    assertEquals("—", accountUsd(null))
    assertEquals("+150%", accountPct(150.0))
    assertEquals("-5.00%", accountPct(-5.0))
    assertEquals("0.00%", accountPct(0.0))
  }

  // ── blockers ─────────────────────────────────────────────────────────────

  @Test fun eachBlockerSaysItsOwnSentenceAndOffersItsOwnFix() {
    val gas = blockerAdviceOf("no-gas")!!
    assertTrue(gas.say.startsWith("Your agent has no ETH"))
    assertTrue(gas.fault)
    assertEquals(BlockerFix.Deposit, blockerFixOf("no-gas"))
    assertEquals(BlockerFix.Deposit, blockerFixOf("no-cash"))
    // Money is NOT the fix for a dead policy, and the sentence says so.
    assertTrue(blockerAdviceOf("dead-policy")!!.say.contains("adding funds will not help"))
    assertEquals(BlockerFix.Resign, blockerFixOf("dead-policy"))
    assertEquals(BlockerFix.Resign, blockerFixOf("wrong-chain"))
    assertEquals(BlockerFix.Resign, blockerFixOf("grant-too-wide"))
    // Nothing for the owner to press: it arms itself, or it is ours to fix.
    assertNull(blockerFixOf("not-armed"))
    assertNull(blockerFixOf("no-executor"))
    // A choice, not a fault — and the one control that changes it is Settings.
    assertFalse(blockerAdviceOf("live-not-enabled")!!.fault)
    assertEquals(BlockerFix.StartLive, blockerFixOf("live-not-enabled"))
  }

  @Test fun noBlockerAndAnUnknownBlockerSayNothing() {
    assertNull(blockerAdviceOf(null))
    assertNull(blockerAdviceOf(""))
    assertNull(blockerAdviceOf("some-rule-a-newer-worker-invented"))
    assertNull(blockerFixOf("some-rule-a-newer-worker-invented"))
  }

  @Test fun aVerdictAboutAReplacedKeyIsNotRepeated() {
    fun g(rule: String, beat: Long?, granted: Long?) = GrantView(
      exists = true,
      liveBlocker = rule,
      workerAliveAt = beat,
      grant = buildJsonObject { if (granted != null) put("grantedAt", JsonPrimitive(granted)) },
    )
    assertTrue(blockerIsStale(g("dead-policy", beat = 1_000, granted = 2_000)))
    assertFalse(blockerIsStale(g("dead-policy", beat = 3_000, granted = 2_000)))
    // Not about the key at all: a new signature says nothing about gas.
    assertFalse(blockerIsStale(g("no-gas", beat = 1_000, granted = 2_000)))
    // A missing time is not evidence either way.
    assertFalse(blockerIsStale(g("dead-policy", beat = null, granted = 2_000)))
    assertFalse(blockerIsStale(g("dead-policy", beat = 1_000, granted = null)))
  }

  // ── Telegram and Trencher ────────────────────────────────────────────────

  @Test fun anUnreadBridgeIsCheckingNeverNoToken() {
    assertEquals(TelegramRow.Unread, telegramRowOf(null))
    assertEquals("checking…", telegramStripValue(telegramRowOf(null)))
    assertEquals(TelegramRow.NoToken, telegramRowOf(TelegramStatus(hasToken = false)))
    assertEquals("not set up", telegramStripValue(TelegramRow.NoToken))
  }

  @Test fun theBridgeStatesInTheWebsOrder() {
    // Off is checked before connected: a good token behind a switch is not "unverified".
    assertEquals(TelegramRow.Off, telegramRowOf(TelegramStatus(hasToken = true, enabled = false, connected = false)))
    assertEquals(TelegramRow.Unverified, telegramRowOf(TelegramStatus(hasToken = true, enabled = true, connected = false)))
    val unlinked = telegramRowOf(TelegramStatus(hasToken = true, enabled = true, connected = true, botUsername = "merrybot", linkCode = "AB12CD"))
    assertEquals(TelegramRow.Unlinked("AB12CD", "merrybot"), unlinked)
    assertEquals("ready to connect", telegramStripValue(unlinked))
    assertEquals("starting up", telegramStripValue(TelegramRow.Unlinked(null, "merrybot")))
    val linked = telegramRowOf(TelegramStatus(hasToken = true, enabled = true, connected = true, botUsername = "merrybot", ownerId = 42, allowlist = listOf(42L)))
    assertEquals(TelegramRow.Linked("merrybot", 1), linked)
    assertEquals("connected as @merrybot", telegramStripValue(linked))
  }

  @Test fun theTelegramLinkCarriesTheCodeOnlyWhenBothAreWellFormed() {
    assertEquals("https://t.me/merrybot?start=AB12CD", telegramStartUrl("merrybot", "AB12CD"))
    assertNull(telegramStartUrl(null, "AB12CD"))
    assertNull(telegramStartUrl("merrybot", null))
    assertNull(telegramStartUrl("evil.com/x", "AB12CD"))
    assertNull(telegramStartUrl("merrybot", "AB&x=1"))
  }

  @Test fun trencherIsReadFromTheSettings() {
    assertEquals(TrencherRow.Unread, trencherRowOf(null, null, null, read = false))
    assertEquals(TrencherRow.Off, trencherRowOf("steady-basket", true, "all", read = true))
    assertEquals(TrencherRow.NoCrypto, trencherRowOf("trencher", true, "stocks", read = true))
    assertEquals(TrencherRow.Live, trencherRowOf("trencher", true, "crypto", read = true))
    assertEquals(TrencherRow.Paper, trencherRowOf("trencher", false, "all", read = true))
    assertEquals(TrencherRow.Paper, trencherRowOf("trencher", null, "all", read = true))
  }

  // ── the owner's tape ─────────────────────────────────────────────────────

  private val noon = ZonedDateTime.of(2026, 9, 24, 12, 0, 0, 0, ZoneOffset.UTC)
  /** The ledger's own time format (lib/ledger.ts fmtEpoch): UTC, a space, no zone. */
  private fun at(hoursAgo: Long): String = noon.minusHours(hoursAgo).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))

  private fun refusal(rule: String, hoursAgo: Long) =
    TradeRecord(kind = "swap", status = "rejected", rejectRule = rule, action = "buy", symbol = "CASHCAT", createdAt = at(hoursAgo))

  @Test fun refusalsOfOneReasonFoldIntoOneLineAtTheNewest() {
    val trades = listOf(
      refusal("ops-cap", 1),
      TradeRecord(kind = "swap", status = "landed", fillSide = "buy", symbol = "CASHCAT", amountUsdg = 5.0, createdAt = at(2)),
      refusal("ops-cap", 3),
      refusal("ops-cap", 4),
      refusal("daily-cap", 5),
    )
    val items = tapeItemsOf(tapeRowsOf(trades), tapeFull = false)
    assertEquals(3, items.size)
    val first = items[0] as TapeItem.Tried
    assertEquals(3, first.count)
    assertEquals("past today's number of trades", first.reason)
    assertTrue(items[1] is TapeItem.Row)
    assertEquals("Refused 3× today: past today's number of trades", triedLine(first, noon.toInstant().toEpochMilli(), ZoneOffset.UTC))
    assertEquals("Refused 1× today: past today's spending cap", triedLine(items[2] as TapeItem.Tried, noon.toInstant().toEpochMilli(), ZoneOffset.UTC))
  }

  @Test fun aFoldReachingPastTheCutIsAFloor() {
    val trades = listOf(refusal("ops-cap", 1), refusal("ops-cap", 2))
    val items = tapeItemsOf(tapeRowsOf(trades), tapeFull = true)
    assertEquals("Refused 2+× today: past today's number of trades", triedLine(items.single() as TapeItem.Tried, noon.toInstant().toEpochMilli(), ZoneOffset.UTC))
  }

  @Test fun aFoldFromEarlierDaysSaysSince() {
    val trades = listOf(refusal("ops-cap", 1), refusal("ops-cap", 40))
    val items = tapeItemsOf(tapeRowsOf(trades), tapeFull = false)
    assertEquals("Refused 2× since Sep 22: past today's number of trades", triedLine(items.single() as TapeItem.Tried, noon.toInstant().toEpochMilli(), ZoneOffset.UTC))
  }

  @Test fun anUnknownRuleIsShownAsItselfOnTheOwnersTape() {
    val row = tapeRowsOf(listOf(refusal("brand-new-rule", 1))).single()
    assertEquals("brand-new-rule", row.reason)
    assertEquals("the drawdown breaker was tripped", rejectRuleLabel("drawdown-breaker"))
    assertNull(rejectRuleLabel("brand-new-rule"))
  }

  @Test fun realizedDollarsOnlyOnAVouchedFilledSell() {
    val sell = TradeRecord(kind = "swap", status = "landed", fillSide = "sell", symbol = "CASHCAT", realizedPnlUsdg = 3.5, realizedVouched = true, createdAt = at(1))
    assertEquals(3.5, tapeRowsOf(listOf(sell)).single().realizedUsd!!, 1e-9)
    assertEquals("+$3.50", tapeRowsOf(listOf(sell)).single().realizedText)
    assertNull(tapeRowsOf(listOf(sell.copy(realizedVouched = null))).single().realizedUsd)
    assertNull(tapeRowsOf(listOf(sell.copy(realizedVouched = false))).single().realizedUsd)
    assertNull("a buy realizes nothing", tapeRowsOf(listOf(sell.copy(fillSide = "buy"))).single().realizedUsd)
    assertNull("a refused sell realized nothing", tapeRowsOf(listOf(sell.copy(status = "rejected"))).single().realizedUsd)
  }

  @Test fun theVaultFigureIsOnlyALiveBooksNeverThePracticeLedgers() {
    // On the paper rail the newest mark is the PRACTICE ledger's; its vault is
    // not a fact about the real account it would sit under.
    val feed = Feed(source = "sqlite", equity = listOf(EquityPoint(equityUsdg = 1_000.0, vaultUsdg = 0.0)))
    assertNull("paper", accountVaultUsdOf(GrantView(exists = true, mode = "paper"), feed))
    assertNull("idle", accountVaultUsdOf(GrantView(exists = true, mode = "idle"), feed))
    assertNull("mode unread", accountVaultUsdOf(GrantView(exists = true, mode = null), feed))
    assertNull("grants unread", accountVaultUsdOf(null, feed))
    assertNull("no agent", accountVaultUsdOf(GrantView(exists = false, mode = "live"), feed))
    val live = Feed(source = "sqlite", equity = listOf(EquityPoint(vaultUsdg = 5.0), EquityPoint(vaultUsdg = 40.25)))
    assertEquals(40.25, accountVaultUsdOf(GrantView(exists = true, mode = "live"), live)!!, 1e-9)
    assertNull("a live book with no mark", accountVaultUsdOf(GrantView(exists = true, mode = "live"), Feed(source = "sqlite")))
  }

  @Test fun eachRowSaysWhatItIsFromTheLedgersOwnWords() {
    val rows = tapeRowsOf(
      listOf(
        TradeRecord(kind = "vault-deposit", status = "landed", createdAt = at(1)),
        TradeRecord(kind = "swap", status = "submitted", action = "sell", symbol = "NVDA", createdAt = at(1)),
        TradeRecord(kind = "curve-trade", status = "paper", fillSide = "buy", symbol = "T7631DACC21B", displayName = "Cash Cat", createdAt = at(1)),
        TradeRecord(kind = "swap", status = "landed", symbol = "0xdeadbeef", createdAt = "not a time"),
      ),
    )
    assertEquals(TapeOp.VaultIn, rows[0].op)
    // 'submitted' is in flight — pending, never "filled".
    assertEquals(TapeStatus.Pending, rows[1].status)
    assertEquals("sell", rows[1].side)
    assertTrue(rows[2].paper)
    assertEquals("Cash Cat", rows[2].displayName)
    // An address is not a symbol, no side is a "Swap", and no time is no age.
    assertNull(rows[3].symbol)
    assertEquals("Swap", rows[3].pill)
    assertNull(rows[3].at)
  }
}
