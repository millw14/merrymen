package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.SearchHit
import dev.merrymen.app.net.SearchResults
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * THE SEARCH BOX AND THE LIST UNDER IT MUST BE ABOUT THE SAME WORDS.
 *
 * Driven through [searchViews] with a clock the test owns, so "the first
 * answer is slow" is a fact of the test rather than a hope about a network.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SearchFlowTest {
  private fun hits(q: String) = Loaded.Value(SearchResults(listOf(SearchHit(kind = "token", title = q))))

  @Test fun aSlowOlderAnswerNeverLandsAfterANewerQuery() = runTest {
    val inputs = MutableStateFlow(SearchInput(""))
    val asked = mutableListOf<String>()
    val seen = mutableListOf<SearchView>()
    val job = launch {
      searchViews(inputs) { q ->
        asked += q
        // "na" is the slow one: it would land long after "nas" if nothing
        // cancelled it.
        delay(if (q == "na") 5_000 else 100)
        hits(q)
      }.toList(seen)
    }
    inputs.value = SearchInput("na")
    advanceTimeBy(400) // past the debounce: "na" is on the wire
    inputs.value = SearchInput("nas")
    advanceUntilIdle()
    job.cancel()

    assertEquals("both were asked; the first was abandoned", listOf("na", "nas"), asked)
    val answers = seen.filterIsInstance<SearchView.Answer>()
    assertEquals(listOf("nas"), answers.map { it.query })
    assertEquals(listOf("nas"), ((answers.single().result as Loaded.Value).value.hits.map { it.title }))
  }

  @Test fun typingFasterThanTheDebounceAsksOnce() = runTest {
    val inputs = MutableStateFlow(SearchInput(""))
    val asked = mutableListOf<String>()
    val job = launch { searchViews(inputs) { q -> asked += q; hits(q) }.collect {} }
    for (text in listOf("n", "nv", "nvd", "nvda")) {
      inputs.value = SearchInput(text)
      advanceTimeBy(60)
    }
    advanceUntilIdle()
    job.cancel()
    assertEquals(listOf("nvda"), asked)
  }

  @Test fun oneCharacterIsNotASearchAndBlankIsIdle() = runTest {
    val inputs = MutableStateFlow(SearchInput(""))
    val asked = mutableListOf<String>()
    val seen = mutableListOf<SearchView>()
    val job = launch { searchViews(inputs) { q -> asked += q; hits(q) }.toList(seen) }
    advanceUntilIdle()
    inputs.value = SearchInput(" n ")
    advanceUntilIdle()
    inputs.value = SearchInput("   ")
    advanceUntilIdle()
    job.cancel()
    // The server answers `{hits: []}` under two characters without looking, so
    // sending one would render "Nothing matched" about a search that never ran.
    assertTrue(asked.isEmpty())
    assertEquals(listOf(SearchView.Idle, SearchView.TooShort("n"), SearchView.Idle), seen)
  }

  @Test fun tryAgainAsksTheSameWordsAgain() = runTest {
    val inputs = MutableStateFlow(SearchInput("robin"))
    val asked = mutableListOf<String>()
    var fail = true
    val seen = mutableListOf<SearchView>()
    val job = launch {
      searchViews(inputs) { q ->
        asked += q
        if (fail) Loaded.Unreachable("timeout") else hits(q)
      }.toList(seen)
    }
    advanceUntilIdle()
    fail = false
    inputs.value = SearchInput("robin", attempt = 1)
    advanceUntilIdle()
    // A keystroke that changed nothing is not a new request.
    inputs.value = SearchInput(" robin ", attempt = 1)
    advanceUntilIdle()
    job.cancel()
    assertEquals(listOf("robin", "robin"), asked)
    val results = seen.filterIsInstance<SearchView.Answer>().map { it.result }
    assertTrue(results[0] is Loaded.Unreachable)
    assertTrue(results[1] is Loaded.Value)
  }

  /**
   * The same rule through the REAL client: the first answer is held back two
   * seconds by the server, the second is immediate, and only the second is
   * ever shown. The first request is cancelled on the wire, not merely ignored.
   */
  @Test fun theRealClientsSlowAnswerIsAbandoned() = runBlocking {
    val server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val q = request.requestUrl?.queryParameter("q")
        val body = """{"hits":[{"kind":"token","href":"/t/0x1","title":"$q","sub":null}]}"""
        val r = MockResponse().setHeader("content-type", "application/json").setBody(body)
        return if (q == "na") r.setBodyDelay(2, TimeUnit.SECONDS) else r
      }
    }
    server.start()
    try {
      val api = apiFor(server)
      val inputs = MutableStateFlow(SearchInput("na"))
      val seen = mutableListOf<SearchView>()
      val job = launch { searchViews(inputs) { api.search(it).toLoaded() }.toList(seen) }
      delay(600) // "na" sent and waiting on its slow body
      inputs.value = SearchInput("nas")
      withTimeout(5_000) {
        while (seen.none { it is SearchView.Answer }) delay(20)
      }
      delay(2_200) // long enough for "na" to have landed, had it not been cancelled
      job.cancel()
      val answers = seen.filterIsInstance<SearchView.Answer>()
      assertEquals(listOf("nas"), answers.map { it.query })
      assertEquals("nas", (answers.single().result as Loaded.Value).value.hits.first().title)
    } finally {
      server.shutdown()
    }
  }

  /**
   * THE BOX DECIDES WHAT IS DRAWN. For the 250ms after a keystroke the view
   * is about the previous text, whatever kind of view it is: typing the
   * second character left "Type at least two characters." under a box that
   * had two, because only an answer was checked against the box.
   */
  @Test fun onlyWhatIsAboutTheWordsInTheBoxIsDrawn() {
    // With two characters typed, the hint, the idle view and any view of older words read as loading.
    assertEquals(SearchShown.Loading, searchShown(SearchView.TooShort("n"), "nv"))
    assertEquals(SearchShown.Loading, searchShown(SearchView.Idle, "nv"))
    assertEquals(SearchShown.Loading, searchShown(SearchView.Searching("n v"), "nv"))
    assertEquals(SearchShown.Loading, searchShown(SearchView.Answer("nvd", hits("nvd")), "nv"))
    // The answer to exactly these words, spaces around them aside.
    assertEquals(SearchShown.Result(hits("nv")), searchShown(SearchView.Answer("nv", hits("nv")), " nv "))
    // Short or empty text is said by the box, whatever the view still holds.
    assertEquals(SearchShown.Hint, searchShown(SearchView.Answer("nvda", hits("nvda")), "n"))
    assertEquals(SearchShown.Blank, searchShown(SearchView.Searching("nvda"), "  "))
  }
}
