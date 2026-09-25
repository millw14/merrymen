package dev.merrymen.app.chat

import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.Via
import dev.merrymen.app.ui.settingsPayload
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * THE CARD'S REGISTRY IS THE WEB'S.
 *
 * COMMANDS is a copy of web/src/lib/chat-commands.ts, and the confirm card's
 * sentence and what a tap does both come from it. This reads the web file when
 * the repository is beside the app and holds the ids, their order, how each is
 * carried out and where a navigate goes to it; the sentences are pinned by
 * their own cases below.
 */
class CommandsMirrorTest {
  private data class Entry(val id: String, val via: String, val to: String?)

  private fun webRegistry(): List<Entry>? {
    val f = File("../../web/src/lib/chat-commands.ts")
    if (!f.isFile) return null
    val src = f.readText()
    val start = src.indexOf("const REGISTRY: ChatCommand[] = [")
    val end = src.indexOf("export const CHAT_COMMANDS")
    if (start < 0 || end < 0) return null
    val body = src.substring(start, end)
    val ids = Regex("""\n\s{4}id: "([a-z-]+)",""").findAll(body).toList()
    return ids.mapIndexed { i, m ->
      val block = body.substring(m.range.first, if (i + 1 < ids.size) ids[i + 1].range.first else body.length)
      Entry(
        id = m.groupValues[1],
        via = Regex("""via: "([a-z]+)"""").find(block)!!.groupValues[1],
        to = Regex("""\bto: "([^"]+)"""").find(block)?.groupValues?.get(1),
      )
    }
  }

  @Test fun theIdsTheirOrderAndTheirRoutesMatchTheWeb() {
    val web = webRegistry()
    assumeTrue("web/src/lib/chat-commands.ts is not beside this checkout", web != null)
    val mine = COMMANDS.values.map {
      Entry(it.id, it.via.name.lowercase(), it.to)
    }
    assertEquals(web, mine)
  }

  @Test fun theMoneySentencesAreTheWebsWords() {
    val a = mapOf("symbol" to "tsla", "usdgAmount" to "5", "query" to "cash cat")
    assertEquals(
      "Spend \$5.00 buying TSLA. I'll place it — my key's limits still decide whether it goes through.",
      COMMANDS.getValue("buy").say(a),
    )
    assertEquals(
      "Sell \$5.00 of TSLA. If that is more than you hold I sell what is there, and if it is a coin on a bonding curve " +
        "I have to sell the whole position — I'll tell you which happened. I'll place it; my key's limits still decide.",
      COMMANDS.getValue("sell").say(a),
    )
    assertEquals(
      "Go after CASH CAT with \$5.00. I'll find which coin you mean first — if more than one answers to that name I'll " +
        "ask rather than guess, and if my key doesn't cover it yet I'll tell you what it needs.",
      COMMANDS.getValue("snipe").say(a),
    )
    assertEquals("Refuse a fill worse than 0.5% off the quote.", COMMANDS.getValue("set-slippage").say(mapOf("slippageBps" to "50")))
    assertEquals("Refuse a fill worse than 1% off the quote.", COMMANDS.getValue("set-slippage").say(mapOf("slippageBps" to "100")))
    assertEquals("Trade this basket from now on: TSLA, NVDA. Anything not on that list I stop buying.",
      COMMANDS.getValue("set-basket").say(mapOf("basketSymbols" to "TSLA,NVDA")))
  }

  @Test fun theModeCommandsWriteTheModeAndTheModelCannotChooseIt() {
    val paper = settingsPayload(COMMANDS.getValue("go-paper"), mapOf("liveTradingEnabled" to "true", "bundlerUrl" to "x"))
    assertEquals(JsonPrimitive(false), paper["liveTradingEnabled"])
    assertEquals(JsonPrimitive(true), paper["paperTradingEnabled"])
    assertFalse("a key the command does not declare is dropped", paper.containsKey("bundlerUrl"))
    assertEquals(JsonPrimitive(true), settingsPayload(COMMANDS.getValue("go-live"), emptyMap())["liveTradingEnabled"])
    val basket = settingsPayload(COMMANDS.getValue("set-basket"), mapOf("basketSymbols" to "TSLA, NVDA,"))
    assertEquals(JsonArray(listOf(JsonPrimitive("TSLA"), JsonPrimitive("NVDA"))), basket["basketSymbols"])
    assertEquals(Via.SNIPE, COMMANDS.getValue("snipe").via)
  }
}
