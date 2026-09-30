package dev.merrymen.app.data

import dev.merrymen.app.net.GcLine

/**
 * WHERE THE READER IS IN THE ROOM: following the newest line, or scrolled away
 * and missing some — web/src/terminal/screens/GroupChat.tsx's `follow`, `seen`
 * and `unseen`, as one value the screen keeps in its saved state.
 *
 * The screen hands it every event and does what it answers; the rules live
 * here so a test can hold them. They were inline in the composable, where the
 * first reading of "is a scroll in progress" — taken before anything had
 * scrolled, with the list still at its top — was read as the reader stopping
 * at the top. The following was switched off before the first scroll to the
 * newest line could run, and the room opened at its OLDEST line under "60 new
 * messages ↓" on every open, after every Try again, and after a rotation.
 *
 * [following]: new lines are scrolled to. [seenTop]: the newest line id the
 * reader had in view when they last followed; the pill counts what is newer.
 * [epoch]: the room log ([GroupChatState.epoch]) this reader was put on; -1
 * before it has been shown one, so the first log is a fresh start too.
 */
data class GcReader(val following: Boolean = true, val seenTop: Long = 0L, val epoch: Int = -1) {
  /**
   * THE LOG CHANGED: its first read landed, lines arrived, or the room
   * replaced it. Returns the reader after it, and whether to put the newest
   * line in view.
   *
   * A log this reader was not put on — the first one, or one the room
   * REPLACED after a long absence — is a fresh start: following, with all of
   * it seen (the web's `rebased → pin(true)`). Otherwise a follower is kept on
   * the newest line and has seen it; a reader who scrolled away stays where
   * they are, and the pill counts.
   */
  fun logShown(epoch: Int, newestId: Long, hasRows: Boolean): Pair<GcReader, Boolean> {
    val next = when {
      epoch != this.epoch -> GcReader(following = true, seenTop = newestId, epoch = epoch)
      following -> copy(seenTop = maxOf(seenTop, newestId))
      else -> this
    }
    return next to (next.following && hasRows)
  }

  /**
   * A SCROLL ENDED, and this is where it left the list. Only the end of a
   * scroll moves the following ([ScrollEnds]): at the bottom the reader is
   * following again and has seen everything; anywhere else they are reading
   * back, and what lands meanwhile is counted.
   */
  fun scrollEnded(atBottom: Boolean, newestId: Long): GcReader =
    if (atBottom) copy(following = true, seenTop = maxOf(seenTop, newestId)) else copy(following = false)

  /** Back to the newest line: the pill, or the owner's own send. */
  fun toNewest(newestId: Long): GcReader = copy(following = true, seenTop = maxOf(seenTop, newestId))

  /** What the pill says is new: other people's lines past the last one seen. None while following. */
  fun unseen(messages: List<GcLine>, mySlug: String?): Int =
    if (following) 0 else messages.count { it.id > seenTop && !isMine(it, mySlug) }
}

/**
 * WHEN A SCROLL ENDS, from successive readings of "is a scroll in progress".
 *
 * An end is a reading of false after a reading of true. The first reading is
 * never one: it is taken as the list is first drawn, before anything scrolled,
 * and it says nothing about where the reader wants to be.
 */
class ScrollEnds {
  private var scrolling = false

  /** Whether this reading is a scroll that just ended. */
  fun ended(inProgress: Boolean): Boolean {
    val was = scrolling
    scrolling = inProgress
    return was && !inProgress
  }
}
