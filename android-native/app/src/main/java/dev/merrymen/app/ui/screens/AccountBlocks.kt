package dev.merrymen.app.ui.screens

import android.content.Context
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.AgentGlance
import dev.merrymen.app.net.AgentImageKind
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.ImageWrite
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.agentImageBytes
import dev.merrymen.app.net.removeOwnAgentImage
import dev.merrymen.app.net.said
import dev.merrymen.app.net.uploadOwnAgentImage
import dev.merrymen.app.ui.AgentImageRevisions
import dev.merrymen.app.ui.BALANCE_UNREAD
import dev.merrymen.app.ui.BlockerFix
import dev.merrymen.app.ui.HOUSE_AGENT_NAME
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.OWN_TAPE_LIMIT
import dev.merrymen.app.ui.PositionLine
import dev.merrymen.app.ui.NameSave
import dev.merrymen.app.ui.TapeItem
import dev.merrymen.app.ui.TapeOp
import dev.merrymen.app.ui.TapeRow
import dev.merrymen.app.ui.TapeStatus
import dev.merrymen.app.ui.TelegramRow
import dev.merrymen.app.ui.TrencherRow
import dev.merrymen.app.ui.accountUsd
import dev.merrymen.app.ui.accountVaultUsdOf
import dev.merrymen.app.ui.ago
import dev.merrymen.app.ui.blockerAdviceOf
import dev.merrymen.app.ui.blockerFixOf
import dev.merrymen.app.ui.blockerIsStale
import dev.merrymen.app.ui.ethFromWei
import dev.merrymen.app.ui.lastHeardText
import dev.merrymen.app.ui.modeChipOf
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.offersNameChip
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.tapeItemsOf
import dev.merrymen.app.ui.tapeOpWords
import dev.merrymen.app.ui.tapeRowsOf
import dev.merrymen.app.ui.telegramRowOf
import dev.merrymen.app.ui.telegramStartUrl
import dev.merrymen.app.ui.telegramStripValue
import dev.merrymen.app.ui.trencherRowOf
import dev.merrymen.app.ui.triedLine
import dev.merrymen.app.ui.saveOwnAgentName
import dev.merrymen.app.ui.usdgFromUnits
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * THE ACCOUNT'S OWN BLOCKS, shared by Home and You.
 *
 * Every rule these draw from is in ui/AccountStatus.kt, where a JVM test runs
 * it; this file only draws. Names are prefixed `Account`/`Own` because the
 * screens package is one namespace and the kit's names are taken.
 */

/** `--warn`'s own fallback in terminal.css (`var(--warn, #fbbf24)`) — the strip's "not done yet", never red. */
private val StripWarn = Color(0xFFFBBF24)

/** The refusal amber, terminal.css `.stamp.cap` — a rule declined is neither a gain nor a loss. */
private val TriedAmber = Color(0xFFD4A24A)

/** `.tag` — the squared-off label, terminal.css:1703. A fact about the rail, not a filter. */
@Composable
internal fun AccountModeTag(text: String) {
  Text(
    text = text,
    modifier = Modifier
      .clip(RoundedCornerShape(2.dp))
      .background(TabTagGround)
      .padding(start = 6.dp, end = 6.dp, top = 3.dp, bottom = 2.dp),
    style = TextStyle(
      fontFamily = sans(12.sp, FontWeight.W600),
      fontSize = 12.sp,
      fontWeight = FontWeight.W600,
      letterSpacing = 0.06.em,
      lineHeight = 12.sp,
    ),
    color = MerryColors.tx,
  )
}

/**
 * LIVE / PAPER / IDLE and when the worker was last heard from — both straight
 * from the heartbeat, and neither drawn when it was not reported. Nothing at
 * all while /api/grants has not answered: a missing chip is honest, a guessed
 * one is not.
 */
@Composable
internal fun AccountModeLine(grants: Loaded<GrantView>, nowMs: Long, modifier: Modifier = Modifier) {
  val g = (grants as? Loaded.Value)?.value?.takeIf { it.exists } ?: return
  val chip = modeChipOf(g.mode)
  val heard = lastHeardText(g.workerAliveAt, nowMs)
  if (chip == null && heard == null) return
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
    chip?.let { AccountModeTag(it) }
    heard?.let { Prose(it, 13.sp, 17.55.sp, MerryColors.tx2) }
  }
}

/**
 * WHAT IS STOPPING THIS AGENT, ON THE SCREEN ITS OWNER OPENS (Agent.tsx:505).
 *
 * The worker's verdict, in lib/live-blocker.ts's words, with the one control
 * that fixes it. An ALARM ONLY WHEN SOMETHING IS WRONG: a practising owner
 * whose agent is doing exactly what they chose gets the quiet slab, not a red
 * box telling them it is blocked. A verdict about a key already replaced is
 * not repeated. Nothing when there is no blocker, or one this build does not
 * know.
 */
@Composable
internal fun AccountBlockerPanel(grants: Loaded<GrantView>, onFix: (BlockerFix) -> Unit, modifier: Modifier = Modifier) {
  val g = (grants as? Loaded.Value)?.value?.takeIf { it.exists } ?: return
  val advice = blockerAdviceOf(g.liveBlocker) ?: return
  if (blockerIsStale(g)) return
  val fix = blockerFixOf(g.liveBlocker)
  Notice(
    title = if (advice.fault) "Your agent can't trade for real yet" else "Your agent isn't trading real money",
    body = advice.say,
    actionLabel = fix?.label,
    onAction = fix?.let { f -> { onFix(f) } },
    tone = if (advice.fault) MerryColors.down else null,
    modifier = modifier,
  )
}

/**
 * THE OWNER'S POSITIONS: the value always, the % only beside a cost the ledger
 * vouches for, and the note that says why when there is none. An empty list
 * here is a fact — this block only renders for a book the server READ.
 */
@Composable
internal fun AccountPositions(lines: List<PositionLine>, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth()) {
    TabSectionHeading("Positions", Modifier.padding(bottom = 12.dp))
    if (lines.isEmpty()) {
      Prose("No positions reported yet.", 13.sp, 18.85.sp, MerryColors.tx2)
      return@Column
    }
    lines.forEach { p ->
      Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        dev.merrymen.app.ui.Coin(p.symbol, size = 40.dp)
        Column(Modifier.weight(1f)) {
          Text(
            text = p.symbol,
            maxLines = 1,
            style = TextStyle(fontFamily = sans(16.sp, FontWeight.W700), fontSize = 16.sp, fontWeight = FontWeight.W700),
            color = MerryColors.tx,
          )
          Prose(p.detail, 13.sp, 18.85.sp, MerryColors.tx2, modifier = Modifier.padding(top = 2.dp))
        }
        p.pctText?.let {
          Text(
            text = it,
            style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600),
            color = if (p.down) MerryColors.down else MerryColors.up,
          )
        }
      }
    }
  }
}

/**
 * WHAT IS IN THE AGENT'S ACCOUNT ON CHAIN — /api/grants' own multicall, field
 * by field. A read that failed says "couldn't read" and never "$0.00": a zero
 * sends a funded owner to add funds they already sent. Vault SHARES are not
 * printed as dollars (the chain read is a share count, not USDG); the book's
 * own vault figure is, when the book is live — a paper mark's vault is the
 * practice ledger's, and does not belong under "Real funds, on chain"
 * ([accountVaultUsdOf]).
 */
@Composable
internal fun AccountBalances(grants: Loaded<GrantView>, feed: Feed, modifier: Modifier = Modifier) {
  val g = (grants as? Loaded.Value)?.value?.takeIf { it.exists } ?: return
  val b = g.balances
  val vault = accountVaultUsdOf(g, feed)
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    TabSectionHeading("In the account", Modifier.padding(bottom = 4.dp))
    BalanceRow("USDG", b?.let { usdgFromUnits(it.cashUsdg)?.let { v -> accountUsd(v) } } ?: BALANCE_UNREAD)
    BalanceRow("ETH for fees", b?.let { ethFromWei(it.ethWei) } ?: BALANCE_UNREAD)
    if (g.mode == "paper") {
      // Both facts are true and the owner needs both: the chain holds real
      // money, and a paper agent is not trading it.
      Prose("Real funds, on chain. In Paper mode none of it trades.", 12.sp, 18.sp, MerryColors.faint)
    }
    vault?.let { BalanceRow("In vaults", accountUsd(it)) }
  }
}

@Composable
private fun BalanceRow(label: String, value: String) {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
    Prose(label, 14.sp, 18.9.sp, MerryColors.tx2)
    Text(
      text = value,
      style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600),
      color = if (value == BALANCE_UNREAD) MerryColors.faint else MerryColors.tx,
    )
  }
}

/**
 * THE OWNER'S OWN TAPE — every operation, every refusal, and why (swaps.ts).
 * Refusals of one reason fold into one "Tried" line at the newest of them, so
 * thirty ops-cap refusals no longer push the fills off the screen; none is
 * hidden.
 */
@Composable
internal fun AccountTape(feed: Feed, nowMs: Long, modifier: Modifier = Modifier) {
  var all by remember { mutableStateOf(false) }
  val items = tapeItemsOf(tapeRowsOf(feed.trades), tapeFull = feed.trades.size >= OWN_TAPE_LIMIT)
  Column(modifier.fillMaxWidth()) {
    TabSectionHeading("Your trades", Modifier.padding(bottom = 12.dp))
    if (items.isEmpty()) {
      Prose("No trades yet.", 13.sp, 18.85.sp, MerryColors.tx2)
      return@Column
    }
    val shown = if (all) items else items.take(8)
    shown.forEach { item ->
      when (item) {
        is TapeItem.Tried -> TapeLine(
          pill = "Tried",
          pillColor = TriedAmber,
          title = triedLine(item, nowMs),
          sub = null,
          right = null,
          meta = item.newestAt?.let { ago(it * 1000, nowMs) },
        )
        is TapeItem.Row -> TapeRowLine(item.row, nowMs)
      }
    }
    if (items.size > 8) {
      Box(
        Modifier.heightIn(min = 44.dp).clickable(role = Role.Button) { all = !all },
        contentAlignment = Alignment.CenterStart,
      ) {
        Prose(if (all) "Show fewer" else "Show all ${items.size}", 13.sp, 17.55.sp, MerryColors.tx, weight = FontWeight.W600)
      }
    }
  }
}

@Composable
private fun TapeRowLine(r: TapeRow, nowMs: Long) {
  val words = tapeOpWords(r.op)
  val meta = listOfNotNull(
    if (r.status == TapeStatus.Pending) "Pending" else null,
    if (r.paper) "Paper" else null,
    r.at?.let { ago(it * 1000, nowMs) },
  ).joinToString(" · ").ifBlank { null }
  val figures = listOfNotNull(r.sizeText, r.realizedText).joinToString(" · ").ifBlank { null }
  if (words != null) {
    TapeLine(pill = words.first, pillColor = MerryColors.tx2, title = words.second, sub = r.why, right = figures, meta = meta)
  } else {
    val name = r.displayName?.takeIf { !it.equals(r.symbol, ignoreCase = true) }
    TapeLine(
      pill = r.pill,
      pillColor = when (r.side) { "buy" -> MerryColors.up; "sell" -> MerryColors.down; else -> MerryColors.tx2 },
      title = r.symbol ?: "Token label unavailable",
      sub = listOfNotNull(name, r.why).joinToString(" · ").ifBlank { null },
      right = figures,
      meta = meta,
    )
  }
}

@Composable
private fun TapeLine(pill: String, pillColor: Color, title: String, sub: String?, right: String?, meta: String?) {
  Row(
    Modifier.fillMaxWidth().padding(vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Text(
      text = pill,
      modifier = Modifier
        .widthIn(min = 44.dp)
        .border(1.dp, pillColor.copy(alpha = 0.5f), RoundedCornerShape(999.dp))
        .padding(horizontal = 8.dp, vertical = 2.dp),
      style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
      color = pillColor,
    )
    Column(Modifier.weight(1f)) {
      Prose(title, 14.sp, 19.sp, MerryColors.tx, weight = FontWeight.W600)
      sub?.let { Prose(it, 12.sp, 16.sp, MerryColors.tx2, modifier = Modifier.padding(top = 2.dp)) }
    }
    Column(horizontalAlignment = Alignment.End) {
      right?.let {
        Text(it, style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
      }
      meta?.let { Prose(it, 12.sp, 16.sp, MerryColors.faint) }
    }
  }
}

/**
 * TELEGRAM AND TRENCHER, AS A READING — AgentStrip.tsx. It says what the
 * settings say and links to them; it is never a second set of controls. An
 * unread status is "checking…", never "not connected". The link code travels
 * with its instruction and an "Open Telegram" that carries it into the chat.
 */
@Composable
internal fun AccountStrip(
  telegram: TelegramStatus?,
  settings: SettingsEnvelope?,
  onSettings: () -> Unit,
  onTelegram: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val uri = LocalUriHandler.current
  val tg = telegramRowOf(telegram)
  val tr = trencherRowOf(
    strategy = settings?.str("strategy"),
    trencherLiveEnabled = settings?.bool("trencherLiveEnabled"),
    assetMode = settings?.str("assetMode"),
    read = settings != null,
  )
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    StripRow(
      label = "Telegram",
      value = telegramStripValue(tg),
      tone = when (tg) {
        is TelegramRow.Linked -> MerryColors.up
        TelegramRow.Unread, TelegramRow.NoToken -> MerryColors.tx2
        else -> StripWarn
      },
      action = when (tg) {
        TelegramRow.Unread -> null
        TelegramRow.NoToken -> "Connect →"
        TelegramRow.Off -> "Turn on →"
        TelegramRow.Unverified -> "Check it →"
        is TelegramRow.Unlinked -> null
        is TelegramRow.Linked -> "Manage →"
      },
      onAction = onTelegram,
    ) {
      if (tg is TelegramRow.Unlinked) {
        if (tg.linkCode != null) {
          telegramStartUrl(tg.botUsername, tg.linkCode)?.let { url ->
            StripLink("Open Telegram →") { runCatching { uri.openUri(url) } }
          }
          Prose("Send this to your bot:", 12.sp, 18.sp, MerryColors.tx2)
          Text("/link ${tg.linkCode}", style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
          Prose("Anyone who has this code can control your agent — do not share or screenshot it.", 12.sp, 18.sp, MerryColors.tx2)
        } else {
          Prose("Your agent mints a link code on its next pass. Check back shortly.", 12.sp, 18.sp, MerryColors.tx2)
        }
      }
    }
    StripRow(
      label = "Trencher",
      value = tr.value,
      tone = when (tr) {
        TrencherRow.Live -> MerryColors.up
        TrencherRow.NoCrypto -> StripWarn
        else -> MerryColors.tx2
      },
      action = when (tr) {
        TrencherRow.Unread -> null
        TrencherRow.Off -> "What is this? →"
        TrencherRow.NoCrypto -> "Change it →"
        TrencherRow.Paper, TrencherRow.Live -> "Settings →"
      },
      onAction = onSettings,
    )
  }
}

@Composable
private fun StripRow(
  label: String,
  value: String,
  tone: Color,
  action: String?,
  onAction: () -> Unit,
  under: @Composable () -> Unit = {},
) {
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(label, modifier = Modifier.widthIn(min = 72.dp), style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
      Prose(value, 14.sp, 19.sp, tone, modifier = Modifier.weight(1f))
    }
    action?.let { StripLink(it, onAction) }
    under()
  }
}

@Composable
private fun StripLink(label: String, onClick: () -> Unit) {
  Box(Modifier.heightIn(min = 36.dp).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.CenterStart) {
    Prose(label, 13.sp, 17.55.sp, MerryColors.tx, weight = FontWeight.W600)
  }
}

// ── the name chip ──────────────────────────────────────────────────────────

private const val ACCOUNT_PREFS = "merrymen.account"

/** "Keep Robin" is remembered on this device, per agent — as NameChip.tsx keeps it per browser. */
private fun keptName(context: Context, slug: String?): Boolean = try {
  context.getSharedPreferences(ACCOUNT_PREFS, Context.MODE_PRIVATE).getBoolean("keep-name." + (slug ?: "unlinked"), false)
} catch (e: Exception) {
  false
}

private fun keepName(context: Context, slug: String?) {
  try {
    context.getSharedPreferences(ACCOUNT_PREFS, Context.MODE_PRIVATE).edit().putBoolean("keep-name." + (slug ?: "unlinked"), true).apply()
  } catch (e: Exception) {
    // This device will ask again next time; nothing worse.
  }
}

/**
 * "NAME YOUR AGENT" — an offer, never an action taken for the owner.
 *
 * Shown only where [offersNameChip] says: the house name, READ as the name.
 * "Choose my own" opens a field right here; its save is a settings write
 * bound to [readFor], the wallet the page was read for, so a name typed for
 * one wallet cannot land on another's agent. The server's own name rule is
 * shown verbatim when it refuses, and a lost answer is looked up in the feed,
 * never sent again. [hosted] false means there is no sign-in and no owner to
 * send; true with no [readFor] means the page does not know whose it is, and
 * then nothing is offered.
 */
@Composable
internal fun AccountNameChip(
  api: MerrymenApi,
  agent: AgentGlance?,
  readFor: String?,
  hosted: Boolean?,
  onNamed: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val slug = agent?.slug
  var kept by remember(slug) { mutableStateOf(keptName(context, slug)) }
  var open by remember { mutableStateOf(false) }
  var typed by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var said by remember { mutableStateOf<String?>(null) }
  var named by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  if (!offersNameChip(agent, kept)) return
  if (hosted != false && readFor == null) return

  named?.let {
    Prose("Named $it. It answers to it from its next tick.", 13.sp, 18.sp, MerryColors.tx2, modifier = modifier)
    return
  }

  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      AskChip("Choose my own") { open = !open }
      AskChip("Keep $HOUSE_AGENT_NAME") { keepName(context, slug); kept = true }
    }
    if (open) {
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
          Modifier
            .weight(1f)
            .heightIn(min = 40.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MerryColors.card)
            .border(1.dp, MerryColors.line, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
          contentAlignment = Alignment.CenterStart,
        ) {
          BasicTextField(
            value = typed,
            onValueChange = { if (it.length <= 24) typed = it },
            singleLine = true,
            textStyle = TextStyle(fontFamily = sans(14.sp), fontSize = 14.sp, color = MerryColors.tx),
            cursorBrush = SolidColor(MerryColors.tx),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            decorationBox = { inner ->
              if (typed.isEmpty()) Prose("Up to 24 letters, numbers, or spaces", 14.sp, 18.sp, MerryColors.tx2)
              inner()
            },
          )
        }
        AskChip(if (busy) "Saving…" else "Save") {
          if (busy || typed.isBlank()) return@AskChip
          busy = true
          said = null
          scope.launch {
            when (val r = api.saveOwnAgentName(typed, readFor, hosted)) {
              is NameSave.Named -> { named = r.name; onNamed() }
              is NameSave.Said -> said = r.text
            }
            busy = false
          }
        }
      }
    }
    said?.let { Prose(it, 13.sp, 19.sp, MerryColors.down) }
  }
}

/** `.ask-chip` — the chat's suggestion chip, which is the web's register for this offer. */
@Composable
private fun AskChip(label: String, onClick: () -> Unit) {
  val shape = RoundedCornerShape(999.dp)
  Box(
    Modifier
      .heightIn(min = 36.dp)
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 14.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
  }
}

// ── pictures ───────────────────────────────────────────────────────────────

/**
 * READ A PICKED FILE, NO LARGER THAN THE ROUTE TAKES. At most [cap] + 1 bytes
 * are read, so a 200 MB video picked by mistake is refused without being held
 * in memory; the extra byte is what tells "exactly the limit" from "over it".
 */
private fun readPicked(context: Context, uri: android.net.Uri, cap: Long): Pair<String?, ByteArray?> {
  val mime = try { context.contentResolver.getType(uri) } catch (e: Exception) { null }
  val bytes = try {
    context.contentResolver.openInputStream(uri)?.use { input ->
      val out = java.io.ByteArrayOutputStream()
      val buf = ByteArray(64 * 1024)
      var total = 0L
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        total += n
        if (total > cap) { out.write(buf, 0, n); break }
        out.write(buf, 0, n)
      }
      out.toByteArray()
    }
  } catch (e: Exception) {
    null
  }
  return mime to bytes
}

/**
 * THE OWNER'S PICTURE AND BANNER, from the phone's own gallery.
 *
 * Through the Android Photo Picker, so the app asks for no storage permission
 * at all. The file is checked (type and size) before anything is sent, the
 * session is checked to still be [readFor] before the bytes go, and the route's
 * answer is said in words — a lost one as a lost one, never as a failure.
 * Choosing IS the change, as on the web: there is no Save for these.
 */
@Composable
internal fun AccountPictures(api: MerrymenApi, slug: String, readFor: String?, modifier: Modifier = Modifier) {
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
    AccountHeadingLine("Pictures")
    AgentImageKind.entries.forEach { kind -> PictureField(api, slug, readFor, kind) }
  }
}

@Composable
private fun AccountHeadingLine(text: String) {
  Text(
    text = text,
    style = TextStyle(fontFamily = sans(19.sp, FontWeight.W600), fontSize = 19.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.02).em),
    color = MerryColors.tx,
  )
}

@Composable
private fun PictureField(api: MerrymenApi, slug: String, readFor: String?, kind: AgentImageKind) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val revisions by AgentImageRevisions.versions.collectAsState()
  val key = AgentImageRevisions.key(slug, kind)
  val removed = revisions.containsKey(key) && revisions[key] == null
  var busy by remember { mutableStateOf(false) }
  var said by remember { mutableStateOf<String?>(null) }
  var bad by remember { mutableStateOf(false) }
  var preview by remember { mutableStateOf<ImageBitmap?>(null) }

  // The SERVED image, re-read whenever a write here or elsewhere bumps its
  // version — so what is shown is what is stored, not the file as picked.
  LaunchedEffect(slug, revisions[key], removed) {
    preview = if (removed) null else when (val r = api.agentImageBytes(slug, kind, revisions[key])) {
      is ApiResult.Ok -> r.value?.let { bytes ->
        withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
      }
      else -> preview
    }
  }

  val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
    if (uri == null || busy) return@rememberLauncherForActivityResult
    busy = true
    said = null
    scope.launch {
      val (mime, bytes) = withContext(Dispatchers.IO) { readPicked(context, uri, kind.maxBytes) }
      val outcome = if (bytes == null) {
        ImageWrite.NotSent("That file could not be opened.")
      } else {
        api.uploadOwnAgentImage(kind, bytes, mime, readFor)
      }
      reportImageWrite(kind, slug, outcome) { text, isBad -> said = text; bad = isBad }
      busy = false
    }
  }

  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Prose(if (kind == AgentImageKind.Avatar) "Profile picture" else "Banner", 14.sp, 21.sp, MerryColors.tx, weight = FontWeight.W500)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
      val frame = if (kind == AgentImageKind.Avatar) {
        Modifier.size(56.dp).clip(CircleShape)
      } else {
        Modifier.weight(1f).aspectRatio(3f).clip(RoundedCornerShape(10.dp))
      }
      Box(frame.background(MerryColors.raised).border(1.dp, MerryColors.line, if (kind == AgentImageKind.Avatar) CircleShape else RoundedCornerShape(10.dp))) {
        preview?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxWidth().aspectRatio(if (kind == AgentImageKind.Avatar) 1f else 3f), contentScale = ContentScale.Crop) }
      }
      if (kind == AgentImageKind.Avatar) {
        PictureButtons(kind, preview != null, busy, onPick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
          busy = true
          scope.launch {
            reportImageWrite(kind, slug, api.removeOwnAgentImage(kind, readFor)) { text, isBad -> said = text; bad = isBad }
            busy = false
          }
        }
      }
    }
    if (kind == AgentImageKind.Banner) {
      PictureButtons(kind, preview != null, busy, onPick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
        busy = true
        scope.launch {
          reportImageWrite(kind, slug, api.removeOwnAgentImage(kind, readFor)) { text, isBad -> said = text; bad = isBad }
          busy = false
        }
      }
    }
    Prose(
      if (kind == AgentImageKind.Avatar) "PNG, JPEG or WebP, up to 5 MB. Cropped to a square and re-encoded; nothing else from the file is kept."
      else "PNG, JPEG or WebP, up to 8 MB. Cropped wide for the top of your agent's profile.",
      12.sp, 18.sp, MerryColors.tx2,
    )
    if (busy) Prose("updating…", 12.sp, 18.sp, MerryColors.tx2)
    said?.let { Prose(it, 13.sp, 19.sp, if (bad) MerryColors.down else MerryColors.tx2) }
  }
}

@Composable
private fun PictureButtons(kind: AgentImageKind, hasOne: Boolean, busy: Boolean, onPick: () -> Unit, onRemove: () -> Unit) {
  Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    AskChip(if (kind == AgentImageKind.Avatar) "Change picture" else "Change banner") { if (!busy) onPick() }
    if (hasOne) AskChip("Remove") { if (!busy) onRemove() }
  }
}

/** One write's result, said; and on success, the new version published so every face on screen re-reads it. */
internal fun reportImageWrite(kind: AgentImageKind, slug: String, w: ImageWrite, say: (String, Boolean) -> Unit) {
  when (w) {
    is ImageWrite.Done -> {
      AgentImageRevisions.publish(slug, kind, w.version)
      say(if (w.version == null) "Removed." else "Saved. It shows on your agent's page within a minute.", false)
    }
    is ImageWrite.Refused -> say(w.why, true)
    is ImageWrite.NotSent -> say(w.why, true)
    is ImageWrite.Unknown -> say(w.why, true)
  }
}

/** A refresh's failure, when the figures on screen are from an earlier read — said with their age. */
internal fun staleLine(failed: ApiResult<*>?, readAtMs: Long?, nowMs: Long): String? {
  if (failed == null || readAtMs == null) return null
  val why = when (failed) {
    is ApiResult.Unreachable -> failed.said.trimEnd('.')
    is ApiResult.Refused -> failed.message.trimEnd('.')
    is ApiResult.Ok -> return null
  }
  return "Couldn't refresh just now ($why). These figures were read ${ago(readAtMs, nowMs)}."
}
