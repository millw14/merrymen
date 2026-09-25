package dev.merrymen.app.market

import dev.merrymen.app.net.AlphaView
import java.util.Locale

/**
 * WHAT THE OPEN ALPHA DESK SAYS ABOUT ITSELF, before it says anything about a
 * coin.
 *
 * The route (web/src/app/api/alpha/route.ts, `open()`) sends the disclosures
 * beside the rows precisely so a short list is not mistaken for a quiet
 * market: whether the index answered, whether the sweep was cut short, whether
 * the site research ran, and — the one this file exists for — whether the
 * scout could look at all.
 *
 * Kept apart from the composable so the words are executed by a JVM test
 * (AlphaEmptyTest) rather than trusted.
 */

/**
 * The page's standing caveats, in the order the web's `Desk` says them. Each
 * is said ONCE for the page: these fail as a wave, and thirty per-card
 * caveats would read as thirty broken coins instead of one degraded read.
 */
fun alphaNotes(a: AlphaView): List<String> {
  if (a.locked) return emptyList()
  val out = ArrayList<String>(4)
  // With nothing kept, the empty state already says the index did not answer
  // (alphaEmptyCopy), and saying it twice reads as two failures.
  if (a.indexUnreachable && a.pickRows.isNotEmpty()) out += "Market data is unavailable. Try again shortly."
  if (a.truncated && !a.indexUnreachable) out += "Some market data is unavailable — this is a prefix of the market, not all of it."
  // THE WEB DOES NOT SAY THIS ONE, and the plan asked for it. `degraded` means
  // the render is short because the read was (a chain status or facts source
  // did not answer), and the server keeps such a render for seconds, not
  // minutes. Unsaid, a degraded desk reads as a considered one.
  if (a.degraded && !a.indexUnreachable) out += "This read was degraded — it will refresh."
  // `researched` is null when the server did not say, which is neither answer.
  if (a.researched == false) out += "Website research is unavailable for this update."
  return out
}

/** Why an open desk has no picks — and whose fault that is. */
data class AlphaEmptyCopy(
  val title: String,
  val body: String,
  /** True when the reason is OUR read failing: drawn as a notice with Try again, never as an empty state. */
  val ours: Boolean,
)

/**
 * WHAT AN EMPTY "KEPT" LIST MEANS, which is one of three different facts.
 *
 * `verdictsWhy` null: the scout looked and kept nothing — a real answer about
 * the market, and often the right one. "no-model" or "model-failed": the scout
 * COULD NOT LOOK, which is our failure, and rendering it as the first states
 * something about the market out of our own outage (read-discoveries.ts:
 * "the page must not render that as a considered pass"). And an unreachable
 * index is the same kind of failure one step earlier. Null when there are picks.
 *
 * A verdictsWhy this build does not know is read as "could not look", never as
 * a considered pass: failing closed here costs a vaguer sentence; failing open
 * costs a false statement about the market. So is one the server never sent
 * ([verdictsWhySaid] false, from alphaRead): null is the considered pass only
 * when the server said null.
 */
fun alphaEmptyCopy(a: AlphaView, verdictsWhySaid: Boolean): AlphaEmptyCopy? {
  if (a.locked || a.pickRows.isNotEmpty()) return null
  if (a.indexUnreachable) {
    return AlphaEmptyCopy(
      title = "Couldn't read the desk just now",
      body = "That's our data feed failing, not a quiet market. It should clear on its own.",
      ours = true,
    )
  }
  return when (a.verdictsWhy) {
    null -> if (verdictsWhySaid) {
      AlphaEmptyCopy(
        title = "No picks this time.",
        body = "The scout looked at what the index returned and kept nothing this pass.",
        ours = false,
      )
    } else {
      // The key was never sent: nobody told us the scout looked.
      AlphaEmptyCopy(
        title = "Research is unavailable.",
        body = "This server didn't say whether the scout looked this pass, so nothing here is a verdict — " +
          "which is not the same as nothing qualifying.",
        ours = true,
      )
    }
    // The web's words (Alpha.tsx: "Research has not run yet." / "Research is
    // unavailable."), with the half of the sentence that matters most said out
    // loud: this is not the market having nothing worth keeping.
    "no-model" -> AlphaEmptyCopy(
      title = "Research has not run yet.",
      body = "The scout has no model configured, so nothing was vetted — which is not the same as nothing qualifying.",
      ours = true,
    )
    "model-failed" -> AlphaEmptyCopy(
      title = "Research is unavailable.",
      body = "The scout's model failed this pass, so nothing was vetted — which is not the same as nothing qualifying.",
      ours = true,
    )
    else -> AlphaEmptyCopy(
      title = "Research is unavailable.",
      body = "The scout could not look this pass, so nothing was vetted — which is not the same as nothing qualifying.",
      ours = true,
    )
  }
}

/**
 * The tier badge beside the title — `{emoji} {name}` — or null.
 *
 * Only for an OPEN desk and only when the server named the tier. An open desk
 * with no tier is self-hosted (the route passes `null` there), never
 * "Traveller" and never "unknown tier", so nothing is filled in.
 */
fun alphaTierBadge(a: AlphaView): String? {
  if (a.locked) return null
  val t = a.tier ?: return null
  val name = t.name?.trim().orEmpty()
  if (name.isEmpty()) return null
  val emoji = t.emoji?.trim().orEmpty()
  return if (emoji.isEmpty()) name else "$emoji $name"
}

/** The entry tier's perks for the locked gate, verbatim from CIRCLE_TIERS, blanks dropped. */
fun alphaPerks(a: AlphaView): List<String> =
  if (!a.locked) emptyList() else a.need?.perks.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }

/** An Alpha row's change figure, and which way it points (null: no direction to colour). */
data class AlphaChange(val text: String, val up: Boolean?)

/**
 * A DAY'S CHANGE ONLY ON A POOL A DAY OLD — the rule Markets keeps
 * ([coinChange24h]), on the Alpha desk too.
 *
 * The index's change24hPct on a pool hours old is a change since launch
 * wearing a day's name; the capture of 2026-09-25 had "SI / WETH 0.01%" at
 * +18,062.8% on an age of six hours. The desk printed it raw beside the coin
 * while Markets wrote "new pool" for the same coin — the doNotDo's "a '24h'
 * change on a 9-hour-old pool". Under a day old it says so; an unknown age is
 * not assumed old enough.
 */
fun alphaChange(change: Double?, ageDays: Double?): AlphaChange {
  val age = ageDays?.takeIf { it.isFinite() && it >= 0 }
  if (age != null && age < 1.0) return AlphaChange("new pool", null)
  val chg = change?.takeIf { it.isFinite() }
  if (chg == null || age == null) return AlphaChange("—", null)
  return AlphaChange((if (chg >= 0) "+" else "") + String.format(Locale.US, "%.1f", chg) + "%", chg >= 0)
}

/**
 * The label over a row's "24h" volume: qualified with the pool's age when it
 * is younger than a day, as the token page's tape is ([poolAgeNote]) — the
 * total is real, but under "24h" alone it reads as a full day's rate.
 */
fun alphaVolumeLabel(ageDays: Double?): String = poolAgeNote(ageDays, 86_400)?.let { "24h · $it" } ?: "24h"
