package dev.merrymen.app.orders

import dev.merrymen.app.data.REJECT_RULE_LABELS
import dev.merrymen.app.data.receiptText
import dev.merrymen.app.net.OrderReceipt
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * THE RECEIPT'S WORDS FOR A REFUSAL ARE THE TAPE'S WORDS.
 *
 * REJECT_RULE_LABELS is a copy of worker/src/thesis-policy.ts `R`, and a copy
 * drifts: the worker has already added rules twice without every reader
 * learning them. This reads the worker's own file when the repository is
 * checked out beside the app (the unit tests run from app/, so it is
 * ../../worker) and skips, rather than passes, when it is not.
 */
class OrderMirrorTest {
  private fun workerLabels(): Map<String, String>? {
    val f = File("../../worker/src/thesis-policy.ts")
    if (!f.isFile) return null
    val src = f.readText()
    val start = src.indexOf("const R: Readonly<Record<string, string>> = Object.freeze({")
    if (start < 0) return null
    val end = src.indexOf("});", start)
    val entry = Regex("""^\s*"?([a-z][a-z-]*)"?:\s*"((?:[^"\\]|\\.)*)",?\s*$""")
    return src.substring(start, end).lines().mapNotNull { line ->
      entry.find(line)?.let { it.groupValues[1] to it.groupValues[2].replace("\\'", "'") }
    }.toMap()
  }

  @Test fun everyRuleLabelMatchesTheWorker() {
    val worker = workerLabels()
    assumeTrue("worker/src/thesis-policy.ts is not beside this checkout", worker != null)
    assertEquals(worker, REJECT_RULE_LABELS)
  }

  @Test fun aRefusalNamesItsRuleInThoseWordsAndAnUnknownRuleByItsSlug() {
    assertEquals(
      "[Buy] \$5.00 CASHCAT · Refused — past the per-trade cap",
      receiptText(OrderReceipt(status = "refused", side = "buy", symbol = "CASHCAT", usdgActual = 5.0, rejectRule = "per-trade-cap")),
    )
    assertEquals(
      "[Sell] TSLA · Refused — some-new-rule",
      receiptText(OrderReceipt(status = "refused", side = "sell", symbol = "TSLA", rejectRule = "some-new-rule")),
    )
    // No symbol: the address the ledger recorded, shortened; no size read: none printed.
    assertEquals(
      "0x1da8…9b63 · Filled",
      receiptText(OrderReceipt(status = "filled", token = "0x1da81ca017949efbe07972776580d04592ba9b63")),
    )
    assertEquals("Token label unavailable · Expired", receiptText(OrderReceipt(status = "expired")))
  }
}
