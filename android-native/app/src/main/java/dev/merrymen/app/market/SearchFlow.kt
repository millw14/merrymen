package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.SearchHit
import dev.merrymen.app.net.SearchResults
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transformLatest
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * WHAT THE SEARCH SCREEN SHOWS, and for WHICH query.
 *
 * Every answer carries the query it answers, so nothing can draw the hits for
 * "na" under a box that says "nas". That is the bug this replaces: each
 * keystroke launched its own request with nothing cancelling the last, and a
 * slow answer for an older query landed after a newer one and overwrote it.
 */
sealed interface SearchView {
  /** Nothing typed. */
  data object Idle : SearchView

  /**
   * ONE CHARACTER IS NOT A SEARCH. /api/search answers `{hits: []}` to anything
   * under two characters without looking (search/route.ts), so sending one and
   * rendering "Nothing matched" would be us reporting a search that never ran.
   */
  data class TooShort(val query: String) : SearchView

  data class Searching(val query: String) : SearchView

  data class Answer(val query: String, val result: Loaded<SearchResults>) : SearchView
}

/** How long typing must pause before a query is sent. */
const val SEARCH_DEBOUNCE_MS = 250L

/** The server's own floor (search/route.ts: `if (q.length < 2)`). */
const val SEARCH_MIN_CHARS = 2

/**
 * One typed query and how many times Try again was pressed for it. The count
 * is part of the key, so pressing Try again on the same words is a new request
 * — and distinctUntilChanged still drops a keystroke that changed nothing.
 */
data class SearchInput(val text: String, val attempt: Int = 0)

/**
 * THE SEARCH, AS A FLOW OF WHAT TO SHOW.
 *
 * Debounced, so typing "nvda" asks once rather than four times; and LATEST
 * ONLY: `transformLatest` cancels the request in flight the moment a newer
 * query arrives, and MerrymenApi.call is cancellable, so the older request is
 * abandoned on the wire rather than raced. An older answer therefore cannot
 * be emitted after a newer query at all — not merely filtered out afterwards.
 */
@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
fun searchViews(
  inputs: Flow<SearchInput>,
  search: suspend (String) -> Loaded<SearchResults>,
): Flow<SearchView> =
  inputs
    .map { it.copy(text = it.text.trim()) }
    .distinctUntilChanged()
    .debounce { if (it.text.length < SEARCH_MIN_CHARS) 0L else SEARCH_DEBOUNCE_MS }
    .transformLatest { input ->
      val q = input.text
      when {
        q.isEmpty() -> emit(SearchView.Idle)
        q.length < SEARCH_MIN_CHARS -> emit(SearchView.TooShort(q))
        else -> {
          emit(SearchView.Searching(q))
          emit(SearchView.Answer(q, search(q)))
        }
      }
    }

/** What the list under the box draws. */
sealed interface SearchShown {
  /** The box is empty. */
  data object Blank : SearchShown

  /** "Type at least two characters." */
  data object Hint : SearchShown

  data object Loading : SearchShown

  /** The answer to exactly the words in the box. */
  data class Result(val result: Loaded<SearchResults>) : SearchShown
}

/**
 * THE BOX AND THE LIST MUST AGREE — for every view, not only an answer.
 *
 * The flow is debounced, so for 250ms after a keystroke the view on hand is
 * about the PREVIOUS text. Checking only answers against the box left the
 * rest unchecked: typing the second character kept "Type at least two
 * characters." under a box that had two. So the box decides what may be
 * drawn: nothing when it is empty, the hint when it is short, the answer only
 * when it answers these very words, and loading for anything else.
 */
fun searchShown(view: SearchView, typed: String): SearchShown {
  val q = typed.trim()
  return when {
    q.isEmpty() -> SearchShown.Blank
    q.length < SEARCH_MIN_CHARS -> SearchShown.Hint
    view is SearchView.Answer && view.query == q -> SearchShown.Result(view.result)
    else -> SearchShown.Loading
  }
}

/** How many launchpad coins a search lists: the route's own limit for its hits. */
const val SEARCH_COIN_LIMIT = 8

/**
 * THE LAUNCHPAD COINS THAT MATCH [q], as the web's Search matches its tokens
 * (Search.tsx: ticker or name, case-insensitive): the ticker the Markets list
 * shows ([coinSymbolOf]) or the index's pool name.
 *
 * /api/search matches only the /api/market registry — stocks and ETFs — and
 * agents. It never matches a coin Markets lists from /api/discoveries, so a
 * coin one tap away on Markets was reported here as "No token or agent by that
 * name". The web's Search filters its own token list, which joins those coins
 * in; this does the same over the rows the app reads.
 */
fun coinHits(disc: Discoveries?, q: String, limit: Int = SEARCH_COIN_LIMIT): List<SearchHit> {
  val query = q.trim().lowercase(Locale.ROOT)
  if (query.length < SEARCH_MIN_CHARS || disc == null || disc.indexUnreachable) return emptyList()
  val seen = HashSet<String>()
  val out = ArrayList<SearchHit>()
  for (c in disc.rows) {
    if (out.size >= limit) break
    val address = c.token?.takeIf { it.isNotBlank() } ?: continue
    val symbol = coinSymbolOf(c)
    val name = c.name?.trim().orEmpty()
    if (!symbol.lowercase(Locale.ROOT).contains(query) && !name.lowercase(Locale.ROOT).contains(query)) continue
    if (!seen.add(address.lowercase(Locale.ROOT))) continue
    out += SearchHit(kind = "token", href = "/t/$address", title = symbol, sub = name.ifEmpty { null })
  }
  return out
}

/** What the list under the box draws for one answer. */
sealed interface SearchList {
  /** [note] says what was NOT searched, when something was not. */
  data class Hits(val hits: List<SearchHit>, val note: String?) : SearchList
  data class NoMatch(val title: String, val body: String) : SearchList
  /** No hits yet, and the coins are still being read: not "nothing matched". */
  data object StillReading : SearchList
}

private const val COINS_UNSEARCHED =
  "Launchpad coins couldn't be read just now, so they weren't searched — that's our read failing."

/**
 * THE ROUTE'S HITS AND THE COINS', AND WHAT AN EMPTY LIST MAY CLAIM.
 *
 * "Nothing matched" names only what was searched: with the launchpad unread
 * (its read failed, or the index did not answer) an empty list says the coins
 * were not searched, and while that read is still out it says nothing yet. A
 * coin the route already returned (a registered memecoin) is listed once.
 */
fun searchList(server: SearchResults, coins: Loaded<Discoveries>, q: String): SearchList {
  val disc = (coins as? Loaded.Value)?.value
  val unsearched = coinsUnsearched(coins)
  val listed = server.hits.mapNotNull { it.href?.lowercase(Locale.ROOT) }.toSet()
  val hits = server.hits + coinHits(disc, q).filter { it.href?.lowercase(Locale.ROOT) !in listed }
  return when {
    hits.isNotEmpty() -> SearchList.Hits(hits, note = if (unsearched) COINS_UNSEARCHED else null)
    coins is Loaded.Loading || coins is Loaded.Idle -> SearchList.StillReading
    unsearched -> SearchList.NoMatch("Nothing matched", "No listed stock, ETF or agent by that name. $COINS_UNSEARCHED")
    disc?.truncated == true -> SearchList.NoMatch(
      "Nothing matched",
      "No stock, ETF, agent or launchpad coin by that name in what was read — the index cut its sweep short, " +
        "so not every coin was searched.",
    )
    else -> SearchList.NoMatch("Nothing matched", "No stock, ETF, launchpad coin or agent by that name.")
  }
}

/**
 * THE COINS WENT UNSEARCHED, AND NOTHING IS STILL READING THEM: their read
 * failed, or it answered that the index did not. This is exactly when the
 * list says they weren't searched, and exactly when asking again can change
 * that.
 */
fun coinsUnsearched(coins: Loaded<Discoveries>): Boolean = when (coins) {
  is Loaded.Value -> coins.value.indexUnreachable
  is Loaded.Refused, is Loaded.Unreachable -> true
  Loaded.Idle, Loaded.Loading -> false
}

/**
 * THE LAUNCHPAD COINS ONE SEARCH SCREEN MATCHES AGAINST ([coinHits]), and
 * when they are asked for again.
 *
 * [ask] reads them when the screen opens, then again for every query sent and
 * from the note's own Try again, but only while they went unsearched
 * ([coinsUnsearched]). Only a failed search's Try again used to ask again. So
 * when /api/search answered and this read had failed, nothing on the screen
 * could ever ask: a new query did not, and the note saying the coins weren't
 * searched had no action. It never asks while a read is out, so a slow sweep
 * is not cancelled and started over by every query, and never once rows were
 * read. [scope] is the screen's, so a read outlives the query that asked for
 * it.
 */
class SearchCoins(
  private val scope: CoroutineScope,
  private val read: suspend () -> Loaded<Discoveries>,
) {
  private val state = MutableStateFlow<Loaded<Discoveries>>(Loaded.Idle)
  val coins: StateFlow<Loaded<Discoveries>> = state.asStateFlow()

  /** Read the coins: the first time, and after a read that left them unsearched. Otherwise nothing. */
  fun ask() {
    val now = state.value
    if (now != Loaded.Idle && !coinsUnsearched(now)) return
    if (!state.compareAndSet(now, Loaded.Loading)) return
    scope.launch { state.value = read() }
  }
}

/**
 * THE SEARCH THE SCREEN RUNS: [searchViews], where every query sent also asks
 * for coins that went unsearched ([SearchCoins.ask]), so its list can hold
 * them.
 */
fun searchViews(
  inputs: Flow<SearchInput>,
  coins: SearchCoins,
  search: suspend (String) -> Loaded<SearchResults>,
): Flow<SearchView> = searchViews(inputs) { q ->
  coins.ask()
  search(q)
}
