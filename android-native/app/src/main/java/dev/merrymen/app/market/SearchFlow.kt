package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.SearchResults
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transformLatest

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
