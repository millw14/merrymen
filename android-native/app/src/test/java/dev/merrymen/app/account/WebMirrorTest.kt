package dev.merrymen.app.account

import dev.merrymen.app.ui.BLOCKER_ADVICE
import dev.merrymen.app.ui.REJECT_LABELS
import dev.merrymen.app.ui.blockerAdviceOf
import dev.merrymen.app.ui.rejectRuleLabel
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * THE TWO MAPS THIS APP COPIES FROM ITS SIBLINGS, HELD AGAINST THEM.
 *
 * The blocker advice is web/src/lib/live-blocker.ts and the refusal labels are
 * worker/src/thesis-policy.ts. A copy drifts the day the original gains a rule
 * — the web's own drift tests exist because that happened twice — so this
 * parses each original's table and runs this app's lookup against every entry.
 * The unit-test working directory is app/, so the siblings are at ../../; a
 * checkout without them (the app built alone) skips rather than fails.
 */
class WebMirrorTest {
  private fun sibling(path: String): String? = File("../../$path").takeIf { it.isFile }?.readText()

  /** The quoted string starting at [from] in [src], with JS escapes undone. */
  private fun quoted(src: String, from: Int): Pair<String, Int> {
    val q = src[from]
    val out = StringBuilder()
    var i = from + 1
    while (src[i] != q) {
      if (src[i] == '\\') { out.append(src[i + 1]); i += 2 } else { out.append(src[i]); i++ }
    }
    return out.toString() to i + 1
  }

  @Test fun blockerAdviceMatchesLiveBlockerTs() {
    val src = sibling("web/src/lib/live-blocker.ts")
    assumeTrue("web/ is not beside this checkout", src != null)
    val body = src!!.substringAfter("const ADVICE").substringAfter("Object.freeze({").substringBefore("\n});")
    val entry = Regex("""(?m)^\s*"([a-z-]+)":\s*\{""")
    val seen = mutableSetOf<String>()
    for (m in entry.findAll(body)) {
      val rule = m.groupValues[1]
      val block = body.substring(m.range.last).substringBefore("\n  },")
      val sayAt = block.indexOf("say:")
      val start = block.indexOfAny(charArrayOf('"', '\''), sayAt)
      val say = quoted(block, start).first
      fun flag(name: String) = Regex("""$name:\s*(true|false)""").find(block)!!.groupValues[1].toBoolean()
      val mine = blockerAdviceOf(rule) ?: error("the app has no advice for \"$rule\"")
      assertEquals("say for $rule", say, mine.say)
      assertEquals("funding for $rule", flag("funding"), mine.funding)
      assertEquals("resign for $rule", flag("resign"), mine.resign)
      assertEquals("fault for $rule", flag("fault"), mine.fault)
      seen += rule
    }
    assertEquals("every rule the web advises on, and no other", seen, BLOCKER_ADVICE.keys)
  }

  @Test fun rejectLabelsMatchThesisPolicyTs() {
    val src = sibling("worker/src/thesis-policy.ts")
    assumeTrue("worker/ is not beside this checkout", src != null)
    val body = src!!.substringAfter("const R: Readonly<Record<string, string>> = Object.freeze({").substringBefore("\n});")
    val key = Regex("""(?m)^\s*(?:"([a-z-]+)"|([a-z]+)):\s*""")
    val seen = mutableMapOf<String, String>()
    for (m in key.findAll(body)) {
      val rule = m.groupValues[1].ifEmpty { m.groupValues[2] }
      val start = m.range.last + 1
      if (start >= body.length || (body[start] != '"' && body[start] != '\'')) continue
      seen[rule] = quoted(body, start).first
    }
    assertEquals(seen, REJECT_LABELS)
    for ((rule, label) in seen) assertEquals(label, rejectRuleLabel(rule))
  }
}
