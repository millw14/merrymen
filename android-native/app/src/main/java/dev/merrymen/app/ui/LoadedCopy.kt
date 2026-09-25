package dev.merrymen.app.ui

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.CANT_REACH

/** The next step a notice offers, when the caller gave it one to offer. */
enum class NoticeAction { SignIn, TryAgain }

/**
 * WHAT A NOTICE SAYS about a read that did not give a value — title, body, and
 * which action it offers.
 *
 * [refusal] is the amber tone: a rule declined. False is the quiet slab: we
 * failed to get or read an answer, which is not a refusal and not a loss.
 */
data class NoticeCopy(
  val title: String,
  val body: String,
  val action: NoticeAction?,
  val refusal: Boolean,
)

/**
 * THE WORDS [LoadedBlock] USES, kept out of the composable so a JVM test can
 * hold them.
 *
 * FOUR OUTCOMES THAT USED TO BE TWO, and each of the old two said something
 * false about one case:
 *   - 401: a door. "Sign in", when the caller can offer it.
 *   - Another 4xx: the server refused, in its words. No retry: asking again
 *     gets the same answer.
 *   - A 5xx: merrymen FAILED. It was titled "The server said no", which reads
 *     as a verdict on the reader, and offered nothing — a failure that a moment
 *     often fixes, with no way to try again. Now "merrymen had a problem" and
 *     Try again, the web's own reading of the status (request-json.ts).
 *   - Unreachable: no answer came ("Can't reach merrymen right now", the web's
 *     words) — or one came that this app could not read, which was titled
 *     "Couldn't reach merrymen" although the server had been reached. That one
 *     is now "Couldn't read merrymen's answer", and no type name appears: the
 *     model that failed goes to the log (MerrymenApi.unreadable), where a
 *     person who can fix it looks.
 *
 * [canSignIn] / [canRetry] are whether the caller passed the handler; an
 * action with nothing behind it is not offered.
 */
fun noticeFor(state: Loaded<*>, canSignIn: Boolean, canRetry: Boolean): NoticeCopy? = when (state) {
  is Loaded.Idle, is Loaded.Loading, is Loaded.Value -> null
  is Loaded.Refused -> when {
    // ONE 401, AND IT IS ABOUT YOUR SESSION. There used to be a second — the
    // site password's — but no route answers with it any more (46c852d1).
    state.status == 401 -> NoticeCopy(
      title = "Sign in to see this",
      body = state.message,
      action = if (canSignIn) NoticeAction.SignIn else null,
      refusal = true,
    )
    state.status >= 500 -> NoticeCopy(
      title = "merrymen had a problem",
      // The message is already a sentence for a person: the generic
      // "merrymen answered with an error (503). Try again in a moment.", or a
      // line the route marked ownerFacing. Never the body.
      body = state.message,
      action = if (canRetry) NoticeAction.TryAgain else null,
      refusal = false,
    )
    else -> NoticeCopy(
      title = "The server said no",
      body = state.message,
      action = null,
      refusal = true,
    )
  }
  is Loaded.Unreachable -> if (state.unreadable) {
    NoticeCopy(
      title = "Couldn't read merrymen's answer",
      body = "merrymen answered, but not in a form this app can read — that's this app, not a fact " +
        "about your account. Try again in a moment; if it keeps happening, this app may need an update.",
      action = if (canRetry) NoticeAction.TryAgain else null,
      refusal = false,
    )
  } else {
    NoticeCopy(
      title = CANT_REACH,
      // Deliberately OUR failure, in our words. Not "you are offline" — we do
      // not know that, and telling somebody their connection is broken when the
      // server is down sends them to reset a router.
      body = "That's this app failing to get an answer, not a fact about your account. " + causeSentence(state.cause),
      action = if (canRetry) NoticeAction.TryAgain else null,
      refusal = false,
    )
  }
}

/**
 * A CAUSE, MADE A SENTENCE OF ITS OWN.
 *
 * Every cause is written to follow "Can't reach merrymen right now: " (see
 * ApiResult.Unreachable.said): lower-case, with no full stop. Joined after a
 * sentence it read "…not a fact about your account. this phone couldn't look
 * up the server's address — it may be offline", on Home, You and Search each
 * time the phone was offline. So it is capitalised and closed here, where the
 * join is, and left as it is for [said]. "merrymen" keeps its lower case: it
 * is the product's name, and the web never capitalises it.
 */
internal fun causeSentence(cause: String): String {
  val t = cause.trim()
  if (t.isEmpty()) return t
  val opened = if (t.startsWith("merrymen")) t else t.replaceFirstChar { it.uppercaseChar() }
  return if (opened.last() in ".!?") opened else "$opened."
}
