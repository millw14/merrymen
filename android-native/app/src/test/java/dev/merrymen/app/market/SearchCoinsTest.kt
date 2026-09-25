package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.SearchHit
import dev.merrymen.app.net.SearchResults
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SEARCH FINDS WHAT MARKETS LISTS, and "Nothing matched" claims only what was
 * searched. /api/search matches the registry (stocks and ETFs) and agents,
 * never a launchpad coin; on 2026-09-25 ?q=fooms, ?q=pear and ?q=hydx each
 * answered {"hits":[]} while those coins were rows on Markets. The coins here
 * are the captured /api/discoveries sweep, read through the real client.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SearchCoinsTest {
  private val disc: Discoveries = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(Fixtures.text("probe-discoveries.json"))
      (apiFor(server).discoveries() as ApiResult.Ok).value
    } finally {
      server.shutdown()
    }
  }
  private val coins = Loaded.Value(disc)
  private val none = SearchResults(emptyList())

  private fun hitsOf(list: SearchList): List<SearchHit> = (list as SearchList.Hits).hits

  @Test fun aCoinMarketsListsIsFoundByItsTickerWhenTheRouteFindsNothing() {
    // The sweep carries two FOOMS pools, each its own token, as Markets lists them.
    val hits = hitsOf(searchList(none, coins, "fooms"))
    assertEquals(listOf("FOOMS", "FOOMS"), hits.map { it.title })
    val first = hits.first()
    assertEquals("/t/0x749216618ac66ea41ee4cabf5229d83d74f04586", first.href)
    assertEquals("FOOMS / WETH", first.sub)
    assertEquals(listOf("HYDX"), hitsOf(searchList(none, coins, "  HyDx ")).map { it.title })
  }

  @Test fun andByItsPoolName() {
    assertEquals(listOf("QUANTA"), hitsOf(searchList(none, coins, "quanta / weth")).map { it.title })
  }

  @Test fun theRoutesHitsComeFirstAndACoinItAlsoFoundIsListedOnce() {
    val routeSaid = SearchResults(
      listOf(SearchHit(kind = "token", href = "/t/0x749216618AC66EA41EE4CABF5229D83D74F04586", title = "FOOMS", sub = "Fooms")),
    )
    val list = searchList(routeSaid, coins, "fooms") as SearchList.Hits
    assertEquals("the route's own hit first, as it sent it", routeSaid.hits.single(), list.hits.first())
    assertEquals(
      "that coin once; the sweep's other FOOMS after it",
      listOf("/t/0x749216618AC66EA41EE4CABF5229D83D74F04586", "/t/0x651f494378d658bb942c8f0652fc3271b551f372"),
      list.hits.map { it.href },
    )
    assertNull(list.note)
  }

  @Test fun nothingMatchedSaysWhatWasSearched() {
    val read = searchList(none, coins, "zzzzqq") as SearchList.NoMatch
    assertEquals("No stock, ETF, launchpad coin or agent by that name.", read.body)

    val unread = searchList(none, Loaded.Unreachable("the connection timed out"), "fooms") as SearchList.NoMatch
    assertTrue(unread.body, unread.body.startsWith("No listed stock, ETF or agent by that name."))
    assertTrue(unread.body, unread.body.contains("weren't searched"))

    val indexDown = searchList(none, Loaded.Value(disc.copy(indexUnreachable = true, rows = emptyList())), "fooms")
    assertTrue((indexDown as SearchList.NoMatch).body.contains("weren't searched"))

    val cut = searchList(none, Loaded.Value(disc.copy(truncated = true)), "zzzzqq") as SearchList.NoMatch
    assertTrue(cut.body, cut.body.contains("not every coin was searched"))
  }

  @Test fun whileTheCoinsAreStillBeingReadNothingIsClaimed() {
    assertEquals(SearchList.StillReading, searchList(none, Loaded.Loading, "fooms"))
  }

  @Test fun hitsBesideAnUnreadLaunchpadSayTheCoinsWereNotSearched() {
    val nvda = SearchResults(listOf(SearchHit(kind = "token", href = "/t/0xnvda", title = "NVDA", sub = "NVIDIA")))
    val list = searchList(nvda, Loaded.Refused(503, "merrymen answered with an error (503). Try again in a moment."), "nv")
    assertTrue((list as SearchList.Hits).note!!.contains("weren't searched"))
  }

  // ── asking again (SearchCoins) ─────────────────────────────────────────────

  private fun routeHits(q: String) = Loaded.Value(SearchResults(listOf(SearchHit(kind = "agent", href = "/a/$q", title = q))))

  @Test fun coinsThatFailedAreAskedAgainByTheNextQueryWhenTheSearchItselfAnswered() = runTest {
    val answers = ArrayDeque(listOf(Loaded.Unreachable("the connection timed out"), coins))
    var reads = 0
    val coinsFor = SearchCoins(this) { reads++; answers.removeFirst() }
    coinsFor.ask() // the screen opening
    advanceUntilIdle()
    val first = searchList(none, coinsFor.coins.value, "fooms")
    assertTrue("the list says the coins weren't searched", (first as SearchList.NoMatch).body.contains("weren't searched"))

    // /api/search answers every query, so no failed block offers Try again;
    // the next query sent asks for the coins by itself.
    val inputs = MutableStateFlow(SearchInput(""))
    val job = launch { searchViews(inputs, coinsFor) { routeHits(it) }.collect {} }
    inputs.value = SearchInput("fooms")
    advanceUntilIdle()
    assertEquals(2, reads)
    assertEquals(listOf("FOOMS", "FOOMS"), hitsOf(searchList(none, coinsFor.coins.value, "fooms")).map { it.title })

    inputs.value = SearchInput("hydx")
    advanceUntilIdle()
    job.cancel()
    assertEquals("never again once rows were read", 2, reads)
  }

  @Test fun aSlowSweepIsNotCancelledOrRestartedByTyping() = runTest {
    var reads = 0
    val coinsFor = SearchCoins(this) { reads++; delay(5_000); coins }
    coinsFor.ask()
    val inputs = MutableStateFlow(SearchInput(""))
    val job = launch { searchViews(inputs, coinsFor) { routeHits(it) }.collect {} }
    for (text in listOf("fo", "foo", "foom", "fooms")) {
      inputs.value = SearchInput(text)
      advanceTimeBy(400) // each one past the debounce, so each is sent
    }
    assertEquals("still reading", Loaded.Loading, coinsFor.coins.value)
    advanceUntilIdle()
    job.cancel()
    assertEquals("one read, and it landed", 1, reads)
    assertEquals(coins, coinsFor.coins.value)
  }

  @Test fun anIndexThatDidNotAnswerIsAskedAgainToo() = runTest {
    val indexDown = Loaded.Value(disc.copy(indexUnreachable = true, rows = emptyList()))
    val answers = ArrayDeque(listOf(indexDown, coins))
    val coinsFor = SearchCoins(this) { answers.removeFirst() }
    coinsFor.ask()
    advanceUntilIdle()
    coinsFor.ask() // the note's Try again
    advanceUntilIdle()
    assertEquals(coins, coinsFor.coins.value)
  }

  @Test fun tryAgainIsOfferedExactlyWhenTheListSaysTheCoinsWerentSearched() {
    val nvda = SearchResults(listOf(SearchHit(kind = "token", href = "/t/0xnvda", title = "NVDA", sub = "NVIDIA")))
    val states = listOf(
      Loaded.Idle,
      Loaded.Loading,
      coins,
      Loaded.Value(disc.copy(indexUnreachable = true, rows = emptyList())),
      Loaded.Unreachable("the connection timed out"),
      Loaded.Refused(503, "merrymen answered with an error (503). Try again in a moment."),
    )
    for (state in states) {
      val saysSo = (searchList(nvda, state, "nv") as SearchList.Hits).note != null
      assertEquals(state.toString(), saysSo, coinsUnsearched(state))
    }
  }
}
