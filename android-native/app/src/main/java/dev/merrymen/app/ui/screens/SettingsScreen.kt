package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.OriginCheck
import dev.merrymen.app.net.SettingsRead
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.paperResetOnce
import dev.merrymen.app.net.said
import dev.merrymen.app.net.settingsRead
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PUBLIC_BOOK_IGNORED
import dev.merrymen.app.ui.SETTINGS_OWNER_CHANGED
import dev.merrymen.app.ui.SaveLookup
import dev.merrymen.app.ui.SettingsDraft
import dev.merrymen.app.ui.SettingsSaveOutcome
import dev.merrymen.app.ui.settingLabel
import dev.merrymen.app.ui.saveSettingsDraft
import dev.merrymen.app.ui.settleUnknownSave
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/**
 * THE FORM PAGE'S ACCENT IS NOT LIME, and this is the single easiest thing to
 * get wrong on this screen.
 *
 * `forms.css:6` redefines the token on the scope itself:
 * `.terminal-host .terminal-form-page { … --lime: var(--tx); }`
 *
 * So on Settings — and on the wallet/grant page — every rule that reads
 * `var(--lime)` resolves to the off-white `--tx` #ECECE4. A hardcoded
 * `MerryColors.lime` here would give the settings screen an accent the web does
 * not have anywhere, and would spend the one colour this product reserves for
 * "the owner must act before the agent can move" on a Save button.
 *
 * Named rather than inlined so the reason travels with the value.
 */
private val FormAccent = MerryColors.tx

/**
 * `.terminal-form-heading h1`, AS IT RESOLVES ON A PHONE — 26px, not 34px.
 *
 * `forms.css:10` says 30px and `forms.css:96` (inside `@media(max-width:650px)`)
 * cuts it to 26px, with `font-weight: 600; line-height: 1.2; letter-spacing: -.04em`.
 *
 * DELIBERATELY NOT [PageTitle]. `polish.css:109` sets `.top-title` to 34px, but
 * Settings does not render a `.top-title` at all — `screens/Settings.tsx:398`
 * renders `<FormHeading title="Settings" />`, which is `.terminal-form-heading h1`
 * (FormPage.tsx:6-8). The two headings are different sizes in the web and the
 * difference is what tells a reader a form page from a browsing page.
 */
private val FormHeadingText = TextStyle(
  fontFamily = sans(26.sp, FontWeight.W600),
  fontSize = 26.sp,
  fontWeight = FontWeight.W600,
  lineHeight = 31.2.sp,
  letterSpacing = (-0.04).em,
)

/**
 * `.mm-label` — forms.css:36: `font-size: 14px; font-weight: 500; line-height: 1.5`.
 *
 * ABOVE the control, never floating in it. The web has no placeholder-as-label
 * anywhere in this vocabulary, which is why these screens use [BasicTextField]
 * and a separate label rather than an `OutlinedTextField`.
 */
private val FieldLabelText = TextStyle(
  fontFamily = sans(14.sp, FontWeight.W500),
  fontSize = 14.sp,
  fontWeight = FontWeight.W500,
  lineHeight = 21.sp,
)

/** `.mm-danger` — forms.css:57: `color: var(--down); font-size: 13px; line-height: 1.6`. */
private val DangerText = TextStyle(
  fontFamily = sans(13.sp),
  fontSize = 13.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.8.sp,
)

/** The box's own text — forms.css:40: `font-size: 14px`, colour `--tx`. */
private val InputText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  color = MerryColors.tx,
)

/** `.mm-btn.primary` / `.grant-btn` — forms.css:53: `font-size: 14px; font-weight: 600`. */
private val ButtonText = TextStyle(
  fontFamily = sans(14.sp, FontWeight.W600),
  fontSize = 14.sp,
  fontWeight = FontWeight.W600,
)

/**
 * `overflow-wrap: anywhere` FOR PROSE \u2014 which is not the same thing as [breakable].
 *
 * A zero-width space is a FIRST-CLASS break opportunity, ranked with a real
 * space, so a greedy line breaker takes the last one that fits in preference to
 * the space before the word. Running whole sentences through [breakable]
 * therefore wrapped every refusal message mid-word ("The server rejec / ted
 * some values") \u2014 on exactly the copy that has to stay legible. CSS's
 * `anywhere` is a LAST RESORT that only breaks inside a word when the word
 * cannot fit a line on its own, and this is that: only runs long enough to
 * overflow by themselves get the treatment.
 */
private fun breakLongRuns(text: String): String =
  Regex("\\S{25,}").replace(text) { breakable(it.value) }

/**
 * A FOCUS RING DRAWN OUTSIDE THE BOX, which `Modifier.border` cannot do.
 *
 * `forms.css:43`: `outline: 2px solid var(--tx-2); outline-offset: 2px`. A CSS
 * outline is painted outside the border box and takes NO layout space, so the
 * field does not move when it gains focus. The caller reserves 4dp around the
 * control and this paints into that reserve: stroke centre 1dp in from the
 * outer edge — which is `offset 2px + half of a 2px stroke` measured from the
 * control — and a corner radius of the control's radius plus that 3px.
 *
 * The ring is GREY, not lime. `forms.css:43` (0,2,1) beats the app-wide lime
 * `button:focus-visible` at `terminal.css:661` (0,1,1), so on a form page the
 * inputs focus grey while the buttons focus lime — except that on this page
 * lime is itself redefined to `--tx`. See [FormAccent].
 */
private fun Modifier.outlineRing(show: Boolean, color: Color, radius: Dp): Modifier =
  this.drawBehind {
    if (!show) return@drawBehind
    val w = 2.dp.toPx()
    drawRoundRect(
      color = color,
      topLeft = Offset(w / 2f, w / 2f),
      size = Size(size.width - w, size.height - w),
      cornerRadius = CornerRadius(radius.toPx() + 3.dp.toPx()),
      style = Stroke(width = w),
    )
  }

/**
 * `.mm-danger` — forms.css:57. Red 13px body text, no background, no icon.
 *
 * THIS IS NOT INTERCHANGEABLE WITH [NoteLine]. The settings screen says three
 * different things in this register and the web keeps two of them apart by
 * colour alone: "Loading settings…" and "Could not load your settings." are
 * both grey `.mm-note` (the second is distinguished by carrying a retry), while
 * a SAVE THAT FAILED is red. A save that did not happen must never read like a
 * save that did.
 */
@Composable
private fun DangerLine(text: String, modifier: Modifier = Modifier) {
  if (text.isBlank()) return
  Text(breakLongRuns(text), modifier, style = DangerText, color = MerryColors.down)
}

/**
 * THE ONE INPUT BOX — forms.css:39-41.
 *
 * `width: 100%; min-height: 46px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); color: var(--tx); font-size: 14px; box-sizing: border-box`
 *
 * `box-sizing: border-box` is why `heightIn(min = 46.dp)` sits on the OUTER box
 * that already carries the border and the padding: in CSS the 46 includes them,
 * and putting the floor on the inner text would inflate the control to ~72dp.
 *
 * PLACEHOLDERS ARE AT `--tx-2`, DELIBERATELY. The web authors no `::placeholder`
 * rule at all and rides Chromium's dark-scheme default, which is roughly 54%
 * white. On the settings screen a placeholder is the ONLY thing that says
 * whether a secret is stored — `saved ····ab12 — type to replace` against the
 * literal `not set` — so styling it as a generic dim hint at or below `--faint`
 * would make "we hold your key" and "we hold nothing" fade into each other.
 */
@Composable
private fun InputBox(
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  placeholder: String? = null,
  password: Boolean = false,
  keyboardType: KeyboardType = KeyboardType.Text,
  focusRequester: FocusRequester? = null,
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .fillMaxWidth()
      .outlineRing(focused, MerryColors.tx2, 12.dp)
      .padding(4.dp),
  ) {
    Box(
      Modifier
        .fillMaxWidth()
        .heightIn(min = 46.dp)
        .clip(shape)
        .background(MerryColors.card)
        .border(1.dp, MerryColors.line, shape)
        .padding(horizontal = 14.dp, vertical = 12.dp),
      contentAlignment = Alignment.CenterStart,
    ) {
      var field = Modifier.fillMaxWidth()
      if (focusRequester != null) field = field.focusRequester(focusRequester)
      BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = field,
        singleLine = true,
        textStyle = InputText,
        cursorBrush = SolidColor(MerryColors.tx),
        visualTransformation =
          if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        interactionSource = interaction,
        decorationBox = { inner ->
          Box(contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty() && !placeholder.isNullOrBlank()) {
              Text(placeholder, style = InputText, color = MerryColors.tx2)
            }
            inner()
          }
        },
      )
    }
  }
}

/** `.mm-field` — forms.css:25: a column with a 9px gap between label, control and hint. */
@Composable
private fun FormField(
  label: String,
  value: String,
  onValueChange: (String) -> Unit,
  modifier: Modifier = Modifier,
  hint: String? = null,
  placeholder: String? = null,
  password: Boolean = false,
) {
  Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(9.dp)) {
    Text(label, style = FieldLabelText, color = MerryColors.tx)
    InputBox(
      value = value,
      onValueChange = onValueChange,
      placeholder = placeholder,
      password = password,
    )
    if (!hint.isNullOrBlank()) HintLine(hint)
  }
}

/**
 * `.mm-btn.primary` / `.grant-btn` — forms.css:53:
 * `padding: 14px 22px; border: 0; border-radius: 12px; background: var(--tx); color: var(--ink); font-size: 14px; font-weight: 600; min-height: 46px`
 *
 * NOT FULL WIDTH and not sticky — it sits in normal flow at the bottom of the
 * form. Its ground is `--tx` #ECECE4, which on this page is also what `--lime`
 * resolves to ([FormAccent]); the two are the same colour here and that is not
 * a coincidence to paper over with a literal.
 *
 * DISABLED IS `opacity: .45` AND NOTHING ELSE — forms.css:54. No colour change,
 * no container swap. Material's disabled container colour would repaint this in
 * a surface tone that appears nowhere in the sheet.
 */
@Composable
private fun PrimaryButton(
  label: String,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  Box(
    modifier
      .alpha(if (enabled) 1f else 0.45f)
      .heightIn(min = 46.dp)
      .clip(RoundedCornerShape(12.dp))
      .background(FormAccent)
      .clickable(enabled = enabled, onClick = onClick)
      .padding(horizontal = 22.dp, vertical = 14.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, style = ButtonText, color = MerryColors.ink)
  }
}

/**
 * `.btn-kill` — forms.css:90:
 * `color: var(--down); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px`
 *
 * THE RED IS TEXT AND ONLY TEXT. There is no red ground and no red border: the
 * box is the same neutral hairline every other control wears, so the control
 * reads as consequential rather than as an alarm. That register is exactly
 * right for "restart the practice book" — it destroys a simulated history and
 * the worker refuses it outright on the live rail, so it is irreversible but it
 * is not money.
 *
 * `.btn-kill` sets no font-size, so the web inherits one; 14sp is chosen to sit
 * with the rest of the form vocabulary rather than derived.
 */
@Composable
private fun KillButton(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 12.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(14.sp, FontWeight.W500),
        fontSize = 14.sp,
        fontWeight = FontWeight.W500,
      ),
      color = MerryColors.down,
    )
  }
}

/**
 * SETTINGS — the form, bound to the wallet it was read for.
 *
 * THE OWNER TRAVELS WITH THE FORM. GET /api/settings says whose values these
 * are (`owner`), and every save sends that back: hosted, a save made after
 * another wallet signed in — through the WebView, in another tab of the same
 * session — is refused 409 and writes nothing, instead of turning Live trading
 * on for an agent its owner never looked at. The form is also keyed on
 * repo.signedIn, so a wallet switch throws away the old wallet's draft rather
 * than offering to save it onto the new one.
 *
 * A SAVE IS REPORTED AS WHAT IT WAS. "Saved" only when the server said ok;
 * keys it ignored listed as NOT saved; its own refusals one line each; and an
 * answer that never came back is looked up — the settings read again and
 * compared key by key — never sent a second time on its own.
 */
@Composable
fun SettingsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val canOfferSignIn by c.repo.canOfferSignIn.collectAsState()
  // Keyed on the wallet: another wallet's read, draft and notes never survive a switch.
  var state by remember(signedIn) { mutableStateOf<Loaded<SettingsRead>>(Loaded.Loading) }
  var telegram by remember(signedIn) { mutableStateOf<TelegramStatus?>(null) }
  var draft by remember(signedIn) { mutableStateOf(SettingsDraft()) }
  var origin by remember { mutableStateOf("") }
  var note by remember(signedIn) { mutableStateOf<String?>(null) }
  // WHETHER THE LAST THING THAT HAPPENED WENT WRONG. forms.css keeps "Saved"
  // and a failure apart — `.mm-note` is `--tx-2`, `.mm-danger` is `--down` —
  // and a failure that reads like a confirmation is the specific mistake this
  // product keeps writing rules against.
  var noteBad by remember(signedIn) { mutableStateOf(false) }
  // The save's own report, under the button: the server's lines, or the keys
  // that did not save.
  var saveLines by remember(signedIn) { mutableStateOf<List<String>>(emptyList()) }
  var ownerChanged by remember(signedIn) { mutableStateOf(false) }
  var saving by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()

  suspend fun load() {
    val r = c.api.settingsRead().toLoaded()
    state = r
    if (r is Loaded.Refused && r.status == 401) c.repo.refreshIdentity()
    telegram = (c.api.telegram() as? ApiResult.Ok)?.value
  }

  LaunchedEffect(signedIn) {
    origin = c.repo.originNow()
    load()
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    // `.terminal-form-heading` — forms.css:9-10, at the ≤650px size. See
    // [FormHeadingText] for why this is 26sp and not the shell's 34sp.
    Column(
      Modifier
        .fillMaxWidth()
        .padding(start = PagePadH, end = PagePadH, top = PagePadTop),
    ) {
      BackControl({ nav.popBackStack() }, Modifier.padding(bottom = 14.dp))
      Text(
        text = "Settings",
        modifier = Modifier.padding(top = 8.dp, bottom = 28.dp),
        style = FormHeadingText,
        color = MerryColors.tx,
      )
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      SignedInNotice(Modifier.padding(bottom = 16.dp))
      note?.let { if (noteBad) DangerLine(it) else NoteLine(it) }

      PanelSectionHeading("This device")
      Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        FormField(
          label = "Server",
          value = origin,
          onValueChange = { origin = it },
        )
        // NO SITE PASSWORD FIELD. It opened the beta door, and the server
        // removed that door on 2026-09-16 (46c852d1).
        PrimaryButton("Save and reconnect") {
          scope.launch {
            when (val saved = c.repo.setOrigin(origin)) {
              // NOTHING WAS SAVED, and the owner is told why in the red line
              // above the field.
              is OriginCheck.Refused -> {
                note = saved.why
                noteBad = true
              }
              is OriginCheck.Ok -> {
                origin = saved.origin
                // A NEW ORIGIN IS A NEW SERVER, so who we are there has to be
                // asked again before its settings are read.
                c.repo.refreshIdentity()
                note = "Saved. Reloading."
                noteBad = false
                load()
              }
            }
          }
        }
      }

      LoadedBlock(
        state,
        // SIGN-IN ONLY WHERE THERE IS ONE: hosted, and nobody signed in.
        onSignIn = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
        onRetry = { scope.launch { load() } },
      ) { read ->
        val env = read.env
        // READ SIGNED OUT, HOSTED: `owner` is "" and the values are the house
        // defaults — nobody's settings. Drawing them as a form would present
        // defaults as the reader's own agent, and its save could only 401.
        if (env.owner == "") {
          Spacer(Modifier.height(24.dp))
          Notice(
            title = "Sign in to change your agent's settings",
            body = "These are the defaults a new agent starts with, not an account of yours.",
            actionLabel = if (canOfferSignIn) "Sign in" else null,
            onAction = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
          )
          return@LoadedBlock
        }
        SettingsForm(
          env = env,
          keys = read.keys,
          telegram = telegram,
          hosted = hosted,
          draft = draft,
          onDraft = { draft = it; ownerChanged = false },
          // Which strategies need the token, so the lock is stated where the
          // choice is made rather than discovered later.
          circleLocked = setOf("even-keel", "dip-hunter"),
          onWeb = { path, title -> nav.navigate(Routes.web(path, title)) },
          onTelegram = { nav.navigate(Routes.TELEGRAM) },
        )
        if (env.errors.isNotEmpty()) {
          Spacer(Modifier.height(16.dp))
          Text(text = "The server rejected some values", style = FieldLabelText, color = MerryColors.tx)
          Spacer(Modifier.height(9.dp))
          Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { env.errors.forEach { DangerLine(it) } }
        }

        PanelSectionHeading("Save")
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
          HintLine(if (draft.dirty) "Unsaved changes." else "Nothing changed yet.")
          PrimaryButton(
            label = if (saving) "Saving…" else "Save changes",
            enabled = draft.dirty && !saving,
          ) {
            saveLines = emptyList()
            saving = true
            scope.launch {
              // THE FORM'S OWNER GOES WITH IT, and a session the app already
              // knows to be another wallet's sends nothing (saveSettingsDraft).
              val save = c.api.saveSettingsDraft(draft, env, c.repo.signedIn.value)
              val outcome = save.outcome
              if (outcome == null) {
                // A BOX THIS FORM CANNOT READ IS NOT SENT AS TYPED, and it is
                // not dropped either: the save stops and says which.
                note = "Nothing was saved."
                noteBad = true
                saveLines = save.blocked
              } else {
                val report = reportOf(outcome)
                note = report.note
                noteBad = report.bad
                saveLines = report.lines
                ownerChanged = outcome is SettingsSaveOutcome.OwnerChanged
                val sent = save.sent
                when {
                  outcome is SettingsSaveOutcome.Saved -> {
                    // THE SERVER'S VALUES ARE WHAT THE SCREEN SHOWS NOW — the
                    // ignored keys included, so a toggle the server dropped does
                    // not keep showing the owner's own choice over it.
                    draft = SettingsDraft()
                    load()
                  }
                  outcome is SettingsSaveOutcome.Unknown && sent != null -> {
                    // LOOK IT UP. Read the settings back and compare each key
                    // sent; what holds its new value saved, what does not stays
                    // in the draft for the owner to decide about.
                    when (val fresh = c.api.settingsRead()) {
                      is ApiResult.Ok -> {
                        val found = settleUnknownSave(sent, fresh.value.env, env.owner)
                        val looked = lookupReport(outcome.why, found)
                        note = looked.note
                        noteBad = looked.bad
                        saveLines = looked.lines
                        ownerChanged = found.ownerChanged
                        if (!found.ownerChanged) {
                          draft = draft.without(found.saved)
                          state = Loaded.Value(fresh.value)
                        }
                      }
                      else -> {
                        note = "Couldn't tell whether that saved — ${outcome.why}, and the settings could not " +
                          "be read back to check. Your changes are still here; reload before saving again."
                        noteBad = true
                      }
                    }
                  }
                  else -> Unit
                }
              }
              saving = false
            }
          }
          if (saveLines.isNotEmpty()) {
            // ONE RED LINE PER ERROR (Settings.tsx:1890 — a `.mm-danger` div
            // each, directly under Save).
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { saveLines.forEach { DangerLine(it) } }
          }
          if (ownerChanged) {
            KillButton("Reload for the wallet signed in now") {
              scope.launch {
                draft = SettingsDraft()
                note = null
                saveLines = emptyList()
                ownerChanged = false
                c.repo.refreshIdentity()
                load()
              }
            }
          }
        }
      }

      PanelSectionHeading("Practice")
      Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        NoteLine(
          "Starting over restores the practice stake and clears simulated positions. " +
            "On the live rail the worker refuses it — real trades are never deleted.",
        )
        KillButton("Restart the practice book") {
          scope.launch {
            when (val r = c.api.paperResetOnce()) {
              is ApiResult.Ok -> {
                note = "Queued. Your agent restarts the practice book on its next tick."
                noteBad = false
              }
              is ApiResult.Refused -> {
                note = if (r.status == 401) "Sign in to restart the practice book." else r.message
                noteBad = true
              }
              // A LOST ANSWER TO A WRITE IS NOT A FAILURE: the restart may be
              // queued. Said as unknown, and not sent again on its own.
              is ApiResult.Unreachable -> {
                note = "Couldn't tell whether the restart was queued. ${r.said.trimEnd('.')}. Check the " +
                  "practice book after your agent's next tick before asking again."
                noteBad = true
              }
            }
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

/** What the Save area says about one save: a line at the top, and lines under the button. */
private data class SaveReport(val note: String?, val bad: Boolean, val lines: List<String>)

private fun reportOf(o: SettingsSaveOutcome): SaveReport = when (o) {
  is SettingsSaveOutcome.Saved -> {
    val applies = o.appliesWithin?.let { "Saved — applies within $it." } ?: "Saved."
    if (o.notSaved.isEmpty()) {
      SaveReport(applies, bad = false, lines = emptyList())
    } else {
      // NOT "Saved." A key the server dropped is a change the owner believes
      // they made. Named, each one, as not saved — and the public book in the
      // web's own words, because an older server drops it silently.
      SaveReport(
        "Saved, except what is listed below.",
        bad = true,
        lines = o.notSaved.map { key ->
          if (key == "publicBook") PUBLIC_BOOK_IGNORED
          else "Not saved: ${settingLabel(key)} — this server did not take it, so it is unchanged."
        },
      )
    }
  }
  is SettingsSaveOutcome.Rejected -> SaveReport("The server rejected some values. Nothing was saved.", bad = true, lines = o.lines)
  SettingsSaveOutcome.OwnerChanged -> SaveReport(SETTINGS_OWNER_CHANGED, bad = true, lines = emptyList())
  SettingsSaveOutcome.SignIn -> SaveReport("Sign in to save your settings. Nothing was saved.", bad = true, lines = emptyList())
  is SettingsSaveOutcome.Failed -> SaveReport(o.message, bad = true, lines = emptyList())
  is SettingsSaveOutcome.Unknown -> SaveReport("Checking whether that saved…", bad = false, lines = emptyList())
}

private fun lookupReport(why: String, found: SaveLookup): SaveReport = when {
  found.ownerChanged -> SaveReport(SETTINGS_OWNER_CHANGED, bad = true, lines = emptyList())
  found.notSaved.isEmpty() -> SaveReport("Saved — $why, so the settings were read back, and every change is there.", bad = false, lines = emptyList())
  else -> SaveReport(
    "Couldn't confirm every change — $why, so the settings were read back.",
    bad = true,
    lines = found.notSaved.map { "Not saved yet: ${settingLabel(it)}. It is still in your changes; save again if you still want it." },
  )
}
