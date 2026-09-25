package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.ChatLine
import dev.merrymen.app.data.PendingCard
import dev.merrymen.app.data.chatKeyFor
import dev.merrymen.app.data.receiptParts
import dev.merrymen.app.net.perTradeUsdg
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.CommandSpec
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LimitCheck
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.Via
import dev.merrymen.app.ui.chipsFor
import dev.merrymen.app.ui.moneyLine
import dev.merrymen.app.ui.orderLimit
import dev.merrymen.app.ui.sans

/** lucide `ArrowUp`, 19px, stroke 1.8 — the composer's send glyph. */
@Composable
private fun ArrowUp(tint: Color, size: Dp = 19.dp) =
  StrokeGlyph("m5 12 7-7 7 7", "M12 19V5", tint = tint, size = size, stroke = 1.8f)

/** `.flow-error` — `terminal.css:373`: 12px `--down`, line-height 1.5, role=alert. */
@Composable
private fun FlowError(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier.semantics { liveRegion = LiveRegionMode.Assertive },
    style = TextStyle(
      fontFamily = sans(12.sp),
      fontSize = 12.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 18.sp,
    ),
    color = MerryColors.down,
  )
}

/**
 * CHAT — a fixed-height three-zone column, drawn from the app's one thread.
 *
 * `polish.css:156-157`: the chat body is `padding-top: 12px; padding-bottom:
 * calc(92px + safe-area); gap: 10px`, and `.desk-page` itself runs at
 * `gap: 16px`. `terminal.css:3828-3847` makes the conversation the ONLY flexible
 * child, with a 220px floor pinned by desk-scroll.test.ts.
 *
 * THE SCREEN OWNS NOTHING BUT ITS SCROLL. The thread, the reply streaming in,
 * the card and the orders being followed all live in [dev.merrymen.app.data.ChatThread],
 * so leaving mid-reply and coming back shows the finished reply, and an order's
 * receipt lands whichever tab is open. While this screen is resumed it tells
 * the thread so, and nothing arriving counts toward the tab's dot.
 *
 * WHOSE THREAD IS DRAWN is decided here as well as there: the thread in hand
 * is shown only when its key is the key the session gives NOW. A session that
 * lapses or changes hands shows nothing of the last owner's words, even for the
 * moment before the thread catches up.
 *
 * THE AGENT SIDE HAS NO BUBBLE AT ALL (`polish.css:168-171`): a 36px face, a
 * 12px gap, the name at 17px/600, then the reply as 16px/1.55 `--tx-2` sitting
 * directly on `--bg`. Only the reader's own message is a raised pill, right
 * aligned, with the tail on the bottom RIGHT.
 */
@Composable
fun ChatScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val chat = c.chat
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val known by c.repo.identityKnown.collectAsState()
  val thread by chat.thread.collectAsState()
  val sending by chat.sending.collectAsState()
  val streaming by chat.streaming.collectAsState()
  val card by chat.card.collectAsState()
  val confirming by chat.confirming.collectAsState()
  val draft by chat.draft.collectAsState()
  val snapshot by chat.snapshot.collectAsState()
  val ceiling by chat.ceiling.collectAsState()

  // ON SCREEN WHILE RESUMED, and only then: a backgrounded app is not reading.
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  DisposableEffect(lifecycle) {
    val watch = LifecycleEventObserver { _, e ->
      when (e) {
        Lifecycle.Event.ON_RESUME -> chat.setOpen(true)
        Lifecycle.Event.ON_PAUSE -> chat.setOpen(false)
        else -> Unit
      }
    }
    lifecycle.addObserver(watch)
    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) chat.setOpen(true)
    onDispose {
      lifecycle.removeObserver(watch)
      chat.setOpen(false)
    }
  }

  val key = chatKeyFor(hosted, signedIn)
  val lines = thread.linesFor(hosted, signedIn)
  // The card and what was read for it belong to the thread in hand: nothing of
  // either is drawn while that thread is not the session's.
  val mine = key != null && thread.key == key
  val snap = snapshot?.takeIf { mine }
  val offer = card?.takeIf { mine }
  val agent = snap?.feed?.agent
  val name = agent?.name?.takeIf { agent.nameSource != "fallback" } ?: "Your agent"

  Column(
    Modifier
      .fillMaxSize()
      // The web gets this from the browser; here the composer has to ride the
      // keyboard or it is typed into blind.
      .imePadding()
      .padding(horizontal = PagePadH)
      .padding(top = 12.dp),
  ) {
    // `.desk-header h1` — polish.css:159: 20px, weight 600, tracking -0.02em.
    // The agent's NAME when it was read, and "Chat" when it was not — never the
    // house's fallback name presented as the reader's agent.
    Text(
      text = if (name == "Your agent") "Chat" else name,
      modifier = Modifier.padding(bottom = 16.dp),
      style = TextStyle(
        fontFamily = sans(20.sp, FontWeight.W600),
        fontSize = 20.sp,
        fontWeight = FontWeight.W600,
        letterSpacing = (-0.02).em,
      ),
      color = MerryColors.tx,
    )

    if (key == null) {
      // NOBODY'S THREAD. Hosted and signed out, the honest offer is to sign in;
      // before the session has answered, nothing is claimed either way.
      if (hosted == true && known && signedIn == null) {
        Notice(
          title = "Sign in to talk to your agent",
          body = "Your conversation is kept for your wallet, on this phone.",
          actionLabel = "Sign in",
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
      } else {
        Prose(
          text = "Checking who's signed in…",
          size = 15.sp,
          lineHeight = 20.25.sp,
          color = MerryColors.faint,
        )
      }
      BottomInsetSpacer()
      return@Column
    }

    if (snap?.grants?.exists == false && hosted == true) {
      // No agent yet: there is nobody to talk to. The web shows the same empty
      // state in place of the whole conversation.
      Empty(
        title = "Your agent starts here.",
        body = "Create your agent and fund it, and this is where you talk to it.",
        actionLabel = "Set up your agent",
        onAction = { nav.navigate(Routes.web("/grant", "Your agent")) },
        kind = EmptyKind.Chat,
      )
      BottomInsetSpacer()
      return@Column
    }

    val listState = rememberLazyListState()
    LaunchedEffect(lines.size, sending, streaming?.length) {
      val last = lines.size + (if (sending) 1 else 0) - 1
      if (last >= 0) listState.animateScrollToItem(last)
    }
    LazyColumn(
      state = listState,
      modifier = Modifier.weight(1f).heightIn(min = 220.dp),
      contentPadding = PaddingValues(bottom = 8.dp),
    ) {
      itemsIndexed(lines, key = { _, m -> m.id }) { i, m ->
        // `terminal.css:4573` — 30px above each turn; 22px between a question
        // and the reply to it (terminal.css:3473).
        val top = if (i == 0) 0.dp else if (m.role == "owner") 30.dp else 22.dp
        Line(m, name, sending, Modifier.padding(top = top), onRetry = { chat.retry(m.id) }) {
          nav.navigate(Routes.SETTINGS)
        }
      }
      if (sending) {
        item(key = "typing") {
          // THE TYPING BUBBLE, IN THE THREAD, and the reply grows inside it as
          // it streams. Only what the stream reader lets through is in
          // `streaming`: nothing of a marker, ever.
          AgentReply(
            name = name,
            text = streaming?.takeIf { it.isNotBlank() } ?: "…",
            modifier = Modifier.padding(top = 22.dp).semantics { contentDescription = "$name is typing" },
          )
        }
      }
    }

    // ---- the dock: in flow, not floating -----------------------------------
    offer?.let { pending ->
      ConfirmCard(
        card = pending,
        acting = confirming,
        mode = snap?.grants?.mode,
        perTrade = snap?.grants?.perTradeUsdg,
        ceiling = ceiling,
        onDismiss = { chat.dismissCard() },
        onConfirm = { chat.confirm { path, id -> nav.navigate(Routes.web(path, id)) } },
      )
    }

    // WHAT TO ASK NEXT, about THIS agent. Sizes appear only under a reply that
    // asks "how much?", each inside the smaller of the sealed cap and the chat
    // ceiling as just read. A chip only sends a message; a trade still needs
    // the card.
    if (!sending && offer == null) {
      val chips = chipsFor(snap, lines, ceiling)
      if (chips.isNotEmpty()) {
        Row(
          Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 10.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          chips.forEach { chip -> ChipPill(chip.label) { chat.send(chip.message) } }
        }
      }
    }

    Composer(
      draft = draft,
      onDraft = chat::setDraft,
      sending = sending,
      placeholder = "Message ${name.takeIf { it != "Your agent" } ?: "your agent"}…",
      onSend = { chat.send(draft) },
    )
    BottomInsetSpacer()
  }
}

/** One line of the thread, by who said it. */
@Composable
private fun Line(
  m: ChatLine,
  name: String,
  sending: Boolean,
  modifier: Modifier,
  onRetry: () -> Unit,
  onSettings: () -> Unit,
) {
  when (m.role) {
    "owner" -> if (m.text.isNotBlank()) UserBubble(m.text, modifier)
    "event" -> ReceiptRow(m.side?.replaceFirstChar { it.uppercase() }, m.text, modifier)
    else -> AgentReply(
      name = name,
      text = m.text,
      modifier = modifier,
      // THE RECEIPT IS TEMPLATED FROM LEDGER FIELDS, never from a model: the
      // worker's figures, and nothing where a figure was not read.
      receipt = m.order?.receipt?.let(::receiptParts),
      failed = m.failed != null,
    ) {
      if (m.failed != null) {
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          // A Retry only where asking again can work, and not while a reply is
          // already on its way.
          if (m.retry != null && !sending) ChipPill("Retry", onClick = onRetry)
          if (m.failed == "no-llm") ChipPill("Open Settings", onClick = onSettings)
        }
      }
    }
  }
}

/**
 * THE READER'S OWN MESSAGE — `.desk-question`, terminal.css:3764-3768 and 4500.
 *
 * Right aligned, `width: fit-content`, `max-width: 88%`, ground `--raised`, no
 * border, radii 16 / 16 / 4 / 16 — the tail is on the bottom RIGHT — with
 * `padding: 12px 16px` and text at 14px/1.5 in full `--tx`.
 */
@Composable
private fun UserBubble(text: String, modifier: Modifier = Modifier) {
  BoxWithConstraints(modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
    val cap = maxWidth * 0.88f
    Box(
      Modifier
        .widthIn(max = cap)
        .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 4.dp, bottomStart = 16.dp))
        .background(MerryColors.raised)
        .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
      Text(
        text = text,
        style = TextStyle(fontFamily = sans(14.sp), fontSize = 14.sp, fontWeight = FontWeight.W400, lineHeight = 21.sp),
        color = MerryColors.tx,
      )
    }
  }
}

/**
 * THE AGENT'S ANSWER — a face, a name and prose on the page ground
 * (`polish.css:168-171`). A receipt, when the line carries one, sits above
 * the words as its pill and line; a failure said in the agent's voice is the
 * same register, with its actions under it.
 */
@Composable
private fun AgentReply(
  name: String,
  text: String,
  modifier: Modifier = Modifier,
  receipt: Pair<String?, String>? = null,
  failed: Boolean = false,
  below: @Composable () -> Unit = {},
) {
  Row(
    modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Avatar(name = name, size = 36.dp)
    Column(Modifier.weight(1f)) {
      Text(
        text = name,
        style = TextStyle(fontFamily = sans(17.sp, FontWeight.W600), fontSize = 17.sp, fontWeight = FontWeight.W600),
        color = MerryColors.tx,
      )
      receipt?.let { (side, line) -> ReceiptRow(side, line, Modifier.padding(top = 6.dp)) }
      Prose(
        text = text,
        size = 16.sp,
        lineHeight = 24.8.sp,
        color = if (failed) MerryColors.faint else MerryColors.tx2,
        modifier = Modifier.padding(top = 4.dp),
      )
      below()
    }
  }
}

/**
 * `.chat-receipt` — a Buy/Sell pill and the templated line beside it. The pill
 * is a pre-trade word for the side, not a colour for an outcome, so it takes
 * the quiet chip ground; the outcome is in the words ("· Filled", "· Refused —
 * past the per-trade cap").
 */
@Composable
private fun ReceiptRow(side: String?, line: String, modifier: Modifier = Modifier) {
  Row(
    modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (side != null) {
      Box(
        Modifier
          .clip(RoundedCornerShape(50))
          .border(1.dp, MerryColors.line, RoundedCornerShape(50))
          .padding(horizontal = 8.dp, vertical = 2.dp),
      ) {
        Text(
          text = side,
          style = TextStyle(fontFamily = sans(11.sp, FontWeight.W600), fontSize = 11.sp, fontWeight = FontWeight.W600),
          color = MerryColors.tx,
        )
      }
    }
    Text(
      text = line,
      style = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp, lineHeight = 19.5.sp),
      color = MerryColors.tx,
    )
  }
}

/** `.desk-prompts button` — an outline pill that only ever sends a message. */
@Composable
private fun ChipPill(label: String, onClick: () -> Unit) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 13.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(fontFamily = sans(13.sp), fontSize = 13.sp),
      color = MerryColors.tx,
    )
  }
}

/**
 * THE COMPOSER — `polish.css:174-176` over terminal.css:3780-3796, 4506-4535.
 *
 * THE SEND BUTTON IS NOT LIME. It is `--tx` (near-white) on `--ink`, and
 * disabled it is `--raised` with a `--faint` glyph. Lime on this screen is
 * reserved for the controls that AUTHORISE something — the confirm card's YES.
 * A harmonised accent-coloured send button would make sending a message look
 * like confirming an action.
 */
@Composable
private fun Composer(
  draft: String,
  onDraft: (String) -> Unit,
  sending: Boolean,
  placeholder: String,
  onSend: () -> Unit,
) {
  val shape = RoundedCornerShape(16.dp)
  val enabled = draft.isNotBlank() && !sending
  Row(
    Modifier
      .fillMaxWidth()
      .heightIn(min = 58.dp)
      .clip(shape)
      .background(MerryColors.card)
      .border(1.dp, MerryColors.line, shape)
      .padding(horizontal = 12.dp, vertical = 10.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.Bottom,
  ) {
    Box(Modifier.weight(1f).heightIn(min = 38.dp, max = 120.dp), contentAlignment = Alignment.CenterStart) {
      if (draft.isEmpty()) {
        Prose(
          text = placeholder,
          size = 16.sp,
          lineHeight = 24.sp,
          color = MerryColors.faint,
          modifier = Modifier.padding(8.dp),
        )
      }
      BasicTextField(
        // The web's maxLength: a longer message is refused by the route.
        value = draft,
        onValueChange = { onDraft(it.take(2_000)) },
        modifier = Modifier
          .fillMaxWidth()
          .padding(8.dp)
          .semantics { contentDescription = placeholder.removeSuffix("…") },
        textStyle = TextStyle(fontFamily = sans(16.sp), fontSize = 16.sp, lineHeight = 24.sp, color = MerryColors.tx),
        cursorBrush = SolidColor(MerryColors.tx),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (enabled) onSend() }),
      )
    }
    Box(
      Modifier
        .size(40.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(if (enabled) MerryColors.tx else MerryColors.raised)
        .clickable(enabled = enabled, role = Role.Button, onClick = onSend)
        .semantics { contentDescription = "Send message" },
      contentAlignment = Alignment.Center,
    ) {
      ArrowUp(if (enabled) MerryColors.ink else MerryColors.faint)
    }
  }
}

/**
 * THE CONFIRMATION CARD — the human tap that is the whole security boundary.
 *
 * The model may PROPOSE; only this button acts. THE SENTENCE COMES FROM THE
 * LOCAL REGISTRY AND NEVER FROM THE WIRE — model-written text could describe
 * one action and request another.
 *
 * A CARD THAT PLACES AN ORDER SAYS FOUR THINGS BEFORE THE TAP: the side, the
 * coin and the amount (the registry's sentence), and whether it is real money
 * or paper (from the worker's own mode, unread said as "treat it as real").
 * An amount past a limit the phone has read is refused ON the card, in red,
 * with the limit named, and YES is disabled; a limit that was not read is
 * said, and the server checks it. A coin a snipe found carries its address.
 *
 * AN UNKNOWN ID IS SHOWN AND REFUSED, NOT HIDDEN — the web renders nothing for
 * an id it cannot describe, and a proposal that vanishes reads as an action
 * already taken. Kept: the id is named, and the button says no.
 *
 * GREEN-FAMILY, NOT RED (terminal.css:7509-7524); `.is-weighty` adds the
 * inset lime bar. DECLINING IS NOT THE SMALLER TARGET: both buttons are the
 * same pill.
 */
@Composable
private fun ConfirmCard(
  card: PendingCard,
  acting: Boolean,
  mode: String?,
  perTrade: Double?,
  ceiling: Double?,
  onDismiss: () -> Unit,
  onConfirm: () -> Unit,
) {
  val cmd = card.command
  val args = cmd.argText()
  val known = COMMANDS[cmd.id]
  val spec = known ?: CommandSpec(cmd.id, Via.UNKNOWN) { "" }
  val weighty = known?.weighty == true
  val money = spec.via == Via.ORDER || spec.via == Via.SNIPE
  val side = if (spec.via == Via.SNIPE) "buy" else spec.fixed["side"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
  val amount = args["usdgAmount"]?.trim()?.toDoubleOrNull()
  val limit = if (money && side != null && amount != null) orderLimit(side, amount, perTrade, ceiling) else null
  val shape = RoundedCornerShape(16.dp)

  Column(
    Modifier
      .fillMaxWidth()
      .padding(bottom = 10.dp)
      .clip(shape)
      .background(MerryColors.lime.copy(alpha = 0.08f))
      .drawBehind { if (weighty) drawRect(MerryColors.lime, size = Size(3.dp.toPx(), size.height)) }
      .border(1.dp, MerryColors.lime.copy(alpha = if (weighty) 0.75f else 0.45f), shape)
      .padding(horizontal = 14.dp, vertical = 12.dp)
      .semantics(mergeDescendants = true) { contentDescription = "Confirm this action" },
  ) {
    card.found?.let { coin ->
      CardNote("Found: ${coin.symbol} at ${coin.short ?: coin.address}")
    }
    Text(
      text = known?.say?.invoke(args)
        ?: "run \"${cmd.id}\"" + if (args.isEmpty()) "" else " with " + args.entries.joinToString(", ") { "${it.key}=${it.value}" },
      style = TextStyle(fontFamily = sans(13.5.sp), fontSize = 13.5.sp, fontWeight = FontWeight.W400, lineHeight = 21.6.sp),
      color = MerryColors.tx,
    )
    if (money) CardNote(moneyLine(mode))
    when (limit) {
      is LimitCheck.Over -> FlowError(limit.line, Modifier.padding(top = 6.dp))
      is LimitCheck.Unread -> CardNote(limit.note)
      else -> Unit
    }
    if (known == null) {
      FlowError(
        text = "This version of the app doesn't know that command, so it won't run it.",
        modifier = Modifier.padding(top = 6.dp),
      )
    }
    Row(Modifier.padding(top = 11.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ConfirmPill(
        label = if (acting) "Doing it…" else if (spec.via == Via.NAVIGATE) "Take me there" else "Yes, do it",
        enabled = known != null && !acting && limit !is LimitCheck.Over,
        ground = MerryColors.lime,
        ink = MerryColors.ink,
        border = null,
        onClick = onConfirm,
      )
      // DECLINING IS NOT AN ERROR. It clears the offer and says nothing else.
      ConfirmPill(
        label = "Not now",
        enabled = !acting,
        ground = Color.Transparent,
        ink = MerryColors.tx,
        border = MerryColors.line,
        onClick = onDismiss,
      )
    }
  }
}

/** A card's second register — 12px `--tx-2`, what the sentence alone does not say. */
@Composable
private fun CardNote(text: String) {
  Text(
    text = text,
    modifier = Modifier.padding(top = 6.dp),
    style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.sp),
    color = MerryColors.tx2,
  )
}

/**
 * `.desk-confirm-row button` — terminal.css:7545-7563: radius 999px,
 * `padding: 8px 15px`, 13px/600. Disabled is `opacity: .55` and NOTHING ELSE.
 */
@Composable
private fun ConfirmPill(
  label: String,
  enabled: Boolean,
  ground: Color,
  ink: Color,
  border: Color?,
  onClick: () -> Unit,
) {
  val shape = RoundedCornerShape(50)
  Box(
    Modifier
      .alpha(if (enabled) 1f else 0.55f)
      .clip(shape)
      .background(ground)
      .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
      .padding(horizontal = 15.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      maxLines = 1,
      style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600),
      color = ink,
    )
  }
}
