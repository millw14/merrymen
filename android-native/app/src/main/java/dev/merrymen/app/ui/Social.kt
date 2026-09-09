package dev.merrymen.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.merrymen.app.LocalContainer
import kotlinx.coroutines.launch

/**
 * THE TWO SOCIAL CONTROLS, and the sentence each of them owes the reader.
 *
 * A LIKE AND A WIRE ARE NOT THE SAME GESTURE and the UI must not let them look
 * like it. A like is applause: it is displayed, it is counted, and it reaches
 * NOTHING that decides anything. A wire puts another desk's published thinking
 * into your own agent's next prompt, which is an input to a decision that
 * spends real money. So the wire control carries a budget, a sentence, and the
 * line about what it cannot do; the heart carries a number and nothing else.
 *
 * See data/Social.kt for the fence both sit behind.
 */

/**
 * THE HEART.
 *
 * Three renderings, and the second and third are the ones that regress
 * silently:
 *
 *   - a count we read — the number, zero included;
 *   - a count we could NOT read — an em dash. Never a 0: "nobody liked this"
 *     and "we could not ask" are different claims and only one is about the
 *     post;
 *   - a post with no id — nothing at all. An unslugged post has no stable name
 *     for a like to attach to, which is post-id.ts's intended consequence.
 *
 * A TAP THAT CANNOT BE STORED IS ANSWERED, NOT SWALLOWED. Where the web
 * disables the button and explains in a `title` attribute, a phone has no
 * hover, so the control stays tappable and says why instead — with the remedy
 * where there is one.
 *
 * IT SAYS THE REMEDY; IT DOES NOT PERFORM IT. The first version called an
 * `onSignIn` that navigated straight to the sign-in flow, and on a real device
 * that meant tapping a HEART threw the reader out of the feed and into a wallet
 * signature ceremony — with the explanation flashing past on the way. A heart is
 * the smallest gesture in the product and it must not be the one that hijacks
 * where you are. The message names the tab; the reader decides.
 */
@Composable
fun LikeButton(postId: String?) {
  if (postId == null) return
  val c = LocalContainer.current
  val likes by c.social.likes.collectAsState()
  val scope = rememberCoroutineScope()
  // KEYED ON THE POST. A LazyColumn reuses a row's slot for a different post as
  // it scrolls, and an unkeyed `remember` would carry "we could not save that"
  // onto somebody else's thesis. Two posts CAN share an id — the same view with
  // a pending trade and a landed one — so this is a remember key and never a
  // LazyColumn item key, which must be unique or it crashes.
  var note by remember(postId) { mutableStateOf<String?>(null) }

  // Self-hosted: there is no likes route at all, and a dead heart is worse
  // than no heart.
  if (!likes.supported) return

  val mine = postId in likes.mine
  val count = likes.countOf(postId)

  Column {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier
        .clickable {
          note = null
          when {
            !likes.signedIn -> note = "Sign in from the You tab to like posts."
            !likes.mineRead ->
              note = "We could not reach your likes just now, so this would not be saved."
            else -> scope.launch { note = c.social.toggleLike(postId, !mine) }
          }
        }
        .padding(vertical = 4.dp, horizontal = 2.dp),
    ) {
      Icon(
        if (mine) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
        contentDescription = if (mine) "Liked" else "Like",
        tint = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(18.dp),
      )
      Spacer(Modifier.width(6.dp))
      Text(
        // THE EM DASH IS THE POINT. It is what this whole client renders for
        // "we do not know", and a like count is not exempt from that.
        count?.toString() ?: "—",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    note?.let {
      Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
    }
  }
}

/**
 * WIRE THIS DESK INTO YOUR AGENT'S THINKING.
 *
 * NEVER A HEART, A STAR OR A BOOKMARK — the same four things that make it
 * legible as wiring on the web make it legible here, and the copy does most of
 * the work:
 *
 *   1. A VISIBLE BUDGET. `4 / 8`. A prompt has a context window; nobody caps
 *      bookmarks, so the denominator alone says what this is.
 *   2. The sentence underneath, which is permanent rather than a tooltip.
 *   3. That the sentence ends by saying what this CANNOT do.
 *
 * THE LAST LINE IS THE PRODUCT'S WHOLE POSITION ON FOLLOWING: a follow is an
 * input to a decision, never a trigger for one. An owner about to hand somebody
 * else's reasoning to something that spends their money is owed that sentence
 * before they tap, not after.
 */
@Composable
fun WireButton(slug: String, name: String, onSignIn: (() -> Unit)? = null) {
  val c = LocalContainer.current
  val wired by c.social.wired.collectAsState()
  val scope = rememberCoroutineScope()
  var note by remember { mutableStateOf<String?>(null) }

  val on = wired.has(slug)
  val full = !on && wired.full

  SectionCard("Wire in") {
    // NOT KNOWN IS NOT "FOLLOWS NOBODY". A signed-out viewer, a self-hosted
    // install and an unreachable route all land here, and each gets the reason
    // rather than a control that would fail on the tap.
    if (!wired.known) {
      Text(
        wired.why ?: "Checking what your agent reads…",
        style = MaterialTheme.typography.bodySmall,
      )
      Text(
        "Wiring puts a desk's published thinking into your own agent's next prompt. You need an " +
          "agent for it to go into.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      if (onSignIn != null) {
        OutlinedButton(onClick = onSignIn) { Text("Sign in") }
      }
      return@SectionCard
    }

    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      OutlinedButton(
        onClick = { scope.launch { note = c.social.toggleWire(slug, !on) } },
        enabled = !full,
      ) { Text(if (on) "wired" else "wire in") }
      Text(
        "${wired.wired.size} / ${wired.max}",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Text(
      when {
        on ->
          "Your agent reads $name's theses before it decides. New ones go into its next prompt. " +
            "Nothing here can make it trade."
        full ->
          "Your agent already reads ${wired.max} desks, which is as many as fit in one prompt. " +
            "Unwire one to make room."
        else ->
          "Puts $name's published theses into your agent's next prompt, as one more thing to " +
            "weigh. Nothing here can make it trade."
      },
      style = MaterialTheme.typography.bodySmall,
    )
    Text(
      "Takes effect the next time your agent arms.",
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    note?.let {
      Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
  }
}
