package dev.merrymen.app.account

import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.BLOCKER_ADVICE
import dev.merrymen.app.ui.REJECT_LABELS
import dev.merrymen.app.ui.SettingsDraft
import dev.merrymen.app.ui.SettingsShown
import dev.merrymen.app.ui.blockerAdviceOf
import dev.merrymen.app.ui.liveTradingNote
import dev.merrymen.app.ui.liveTradingReadout
import dev.merrymen.app.ui.rejectRuleLabel
import java.io.File
import kotlinx.serialization.json.Json
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

  /**
   * THE LIVE TRADING SWITCH SAYS WHAT THE WEB'S SAYS — Settings.tsx's read-out
   * and hint in each position, and the warning owed when the box differs from
   * what is saved, taken from the TSX (whitespace folded, as the page renders
   * it) and held against what this app's own functions hand the form.
   */
  @Test fun liveTradingSentencesMatchSettingsTsx() {
    val src = sibling("web/src/terminal/screens/Settings.tsx")
    assumeTrue("web/ is not beside this checkout", src != null)
    val flat = src!!.replace(Regex("\\s+"), " ")
    val section = flat.substringAfter("settings.section.tradingMode").substringBefore("WHAT IT TRADES")
    val str = "\"((?:[^\"\\\\]|\\\\.)*)\""
    val ternaries = Regex("""\{liveTradingVal \? $str : $str\}""").findAll(section).map { it.groupValues }.toList()
    assertEquals("the read-out and the hint", 2, ternaries.size)
    val (unit, hint) = ternaries
    assertEquals(unit[1], liveTradingReadout(true).unit)
    assertEquals(unit[2], liveTradingReadout(false).unit)
    assertEquals(hint[1], liveTradingReadout(true).hint)
    assertEquals(hint[2], liveTradingReadout(false).hint)

    // Each warning is the first <b>…</b>…</p> after the condition that shows it.
    fun noteAfter(condition: String): Pair<String, String> {
      val m = Regex("""<b>(.*?)</b>(.*?)</p>""").find(section.substringAfter(condition))
        ?: error("no warning after $condition in Settings.tsx")
      return m.groupValues[1].trim() to m.groupValues[2].trim()
    }
    val env = LENIENT.decodeFromString(SettingsEnvelope.serializer(), Fixtures.text("probe-settings-signedout.json"))
    fun noteFor(saved: Boolean, ticked: Boolean): Pair<String, String> {
      val shown = SettingsShown(
        env.copy(values = Json.parseToJsonElement("""{"liveTradingEnabled":$saved}""")),
        SettingsDraft().setBool("liveTradingEnabled", ticked),
      )
      val note = liveTradingNote(shown) ?: error("no warning for saved=$saved ticked=$ticked")
      return note.lead.trim() to note.body.trim()
    }
    // Unticked over a saved ON: the real-positions warning.
    assertEquals(noteAfter("{!liveTradingVal &&"), noteFor(saved = true, ticked = false))
    // Ticked over a saved OFF: "This spends real money."
    assertEquals(noteAfter("{liveTradingVal && !("), noteFor(saved = false, ticked = true))
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

  private companion object {
    val LENIENT = Json { ignoreUnknownKeys = true }
  }
}
