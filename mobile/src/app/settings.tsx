import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import * as Clipboard from "expo-clipboard";
import { RENEW_SOON_DAYS, type StoredGrant } from "@merrymen/core";
import { EXPLORER } from "@/net/chainlinks";
import { feedOrigin, isMock } from "@/net/api";
import { chatUrl, fetchTelegramStatus, type TelegramStatus } from "@/net/telegram";
import { forgetOwner, readOwner } from "@/crypto/keystore";
import { clearGrant, readGrant, secondsLeft } from "@/crypto/grantStore";
import { accountFromMnemonic } from "@/crypto/mnemonic";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { useNoScreenshots } from "@/ui/useNoScreenshots";
import { C } from "@/ui/tokens";

/**
 * Settings — and mostly, telling the truth about what this app can and cannot do.
 *
 * The hard part here is the stop button. On the dashboard the kill switch is wired
 * end to end, because the dashboard sits on the same machine as the worker. This
 * app does not. Deleting a grant from this phone's keychain removes OUR copy; it
 * does not reach an agent that is already running elsewhere with the session key,
 * and it certainly does not touch the chain.
 *
 * A "revoke" button that only clears local state while an agent keeps trading
 * would be the single most dangerous thing in the product — someone would press
 * it, believe they were safe, and walk away. So the destructive action is named
 * for what it actually does, and the section above it explains what genuinely
 * stops an agent: the expiry that is already signed into the key, or moving the
 * funds with the owner key.
 *
 * ORDERED BY THE MOMENT YOU REACH FOR IT, not by importance-in-the-abstract:
 * stop it → the secret the stopping depends on → set it up → look it up →
 * destroy it. "Stopping your agent" used to be third, below a nine-row address
 * card and a chat-setup card, which put the panic path behind two screens of
 * scrolling. Nothing in it was reworded to move it.
 *
 * Sections shrink by STATE, never behind a disclosure tap. A tap is what buries
 * safety copy: an owner who never taps never learns the limit. State-gating
 * hides only what a given user has already answered — a linked user does not
 * need the linking instructions — and every guarantee that copy carried has to
 * survive the collapse in one line, or the section does not collapse.
 */

function short(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-8)}`;
}

function countdown(sec: number): string {
  if (sec <= 0) return "expired";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Settings() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();
  const [grant, setGrant] = useState<Omit<StoredGrant, "demoOwnerPrivateKey"> | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [tgError, setTgError] = useState<string | null>(null);
  /**
   * Whether the status above is generated. fetchTelegramStatus already returns
   * `mock`, and this screen used to throw it away — so a demo build showed a
   * plausible bot handle and, worse, a fabricated one-time link code, styled
   * exactly like a real one. A link code is a credential; inventing one and
   * presenting it as the user's is the kind of detail that teaches someone to
   * trust the wrong thing.
   */
  const [tgMock, setTgMock] = useState(false);

  /**
   * FLAG_SECURE while this screen is mounted — screenshots and screen recording
   * are blocked and the recents thumbnail is blanked.
   *
   * Unconditional rather than gated on `phrase !== null`, because a hook cannot
   * be called conditionally and because the protection has to be in place
   * BEFORE the words appear, not one render after. The rest of this screen is
   * addresses and caps, which nobody needed to screenshot anyway.
   */
  useNoScreenshots("settings");

  useEffect(() => {
    void fetchTelegramStatus(isMock ? null : feedOrigin).then((r) => {
      // The failure used to be dropped on the floor, which left the card saying
      // "checking the bridge…" for as long as the screen stayed open. Reading as
      // "almost ready" when the truth is "your agent is unreachable" is the
      // wrong way round for the one screen about stopping it.
      if (r.ok) {
        setTg(r.status);
        setTgMock(r.mock);
      } else setTgError(r.reason);
    });
  }, []);

  /**
   * Hide a revealed recovery phrase the moment the app leaves the foreground.
   *
   * Nothing cleared it before: no timeout, no blur, only the manual Hide button.
   * Twelve words stayed on screen through an app switch, and on both platforms
   * the OS snapshots the screen for the task switcher as the app backgrounds.
   */
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") setPhrase(null);
    });
    return () => sub.remove();
  }, []);

  const openTelegram = useCallback(async () => {
    if (!tg?.botUsername) return;
    const url = chatUrl(tg.botUsername, tg.linkCode);
    // Telegram not installed is a normal state, not an error — the same URL works
    // in a browser, so fall through to it rather than failing silently.
    await Linking.openURL(url).catch(() => {});
  }, [tg]);

  useEffect(() => {
    void (async () => {
      setGrant(await readGrant());
      const status = await readOwner();
      if (status.state === "present") {
        try {
          setOwner(accountFromMnemonic(status.mnemonic).address);
        } catch {
          /* an unreadable key shows as absent rather than crashing the screen */
        }
      }
      setLoaded(true);
    })();
  }, []);

  /**
   * Reveal the phrase behind a biometric prompt.
   *
   * The key is stored WITHOUT requireAuthentication (see keystore.ts — the OS
   * destroys such keys when biometrics change), so this gate is enforced by us
   * rather than by the keychain. That is a weaker guarantee and worth being honest
   * about: it stops someone holding your unlocked phone, not someone running code
   * inside the app.
   */
  const reveal = useCallback(async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync().catch(() => false);
    const enrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);
    if (hasHardware && enrolled) {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: "Show your recovery phrase",
        cancelLabel: "Cancel",
      });
      if (!res.success) return;
    }
    const status = await readOwner();
    if (status.state === "present") setPhrase(status.mnemonic);
  }, []);

  const forgetEverything = useCallback(() => {
    Alert.alert(
      "Forget this device?",
      "This removes the key and grant FROM THIS PHONE ONLY. It does not stop an agent that is already running, and it does not move your funds. Without your recovery phrase written down, this is permanent.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: async () => {
            await clearGrant();
            await forgetOwner();
            router.replace("/onboarding");
          },
        },
      ],
    );
  }, []);

  const left = grant ? secondsLeft(grant) : 0;
  /** Shared by the wall's expiry Row and the stop list's expiry bullet, so the
   *  same countdown escalates the same way in both places — and inside the
   *  shared `RENEW_SOON_DAYS`, so the phone turns gold the day the web warns. */
  const expiryTone = !grant ? C.dim : left <= 0 ? C.red : left < RENEW_SOON_DAYS * 86_400 ? C.gold : C.text2;
  const linked = tg?.owner != null;

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}>
      {/* An explicit way out. This is a headerless modal, so the only dismissal
          was a downward swipe on iOS and the system back button on Android —
          neither of which is visible, and one of which doesn't exist on a phone
          using gesture navigation. */}
      <View style={styles.titleRow}>
        <Text style={styles.h1}>Settings</Text>
        <Pressable style={styles.done} hitSlop={10} onPress={() => router.back()}>
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      </View>

      {/* ── stopping it ──────────────────────────────────────────────────── */}
      {/* FIRST, because it is the only reason anyone opens this screen in a
          hurry. Every word below is the copy that was here when it sat third. */}
      <Text style={styles.section}>stopping your agent</Text>
      <View style={styles.card}>
        <Text style={styles.body}>
          This app holds the key that <Text style={styles.em}>creates</Text> permission. It is not the thing
          that runs your agent, so there is no button here that halts one mid-trade.
        </Text>
        <Text style={styles.body}>What actually stops it:</Text>
        {/* The dashboard stays first. It is the only stop with no precondition:
            no bot, no toggle, no network path to Telegram. Ranking a gated stop
            above an ungated one optimises for speed at the cost of certainty,
            which is the wrong trade when the reader is frightened. */}
        <Bullet>The kill switch in the dashboard, which reaches the worker directly because it runs beside it.</Bullet>
        {/* Second, and only ever as true as we can prove it is.

            worker/src/telegram/executor.ts gates every control command on
            `controlEnabled` and otherwise answers with a padlock telling you to
            go to the dashboard. So this bullet has three forms, and the third is
            not a hedge for its own sake: an agent too old to report the flag
            leaves us genuinely unable to promise the chat can stop anything. */}
        {tg?.hasToken &&
          (tg.control === false ? (
            <Text style={styles.muted}>
              Not the chat — control commands are off for Telegram, so it can answer questions but cannot
              pause or kill. Turn them on in your dashboard if you want that.
            </Text>
          ) : (
            <Bullet>
              Telling it to stop in the chat — /pause holds it before its next trade, /kill destroys the grant
              {tg.control === null ? ", if control commands are on for Telegram in your dashboard." : "."}
            </Bullet>
          ))}
        <Bullet>
          The expiry already signed into the key —{" "}
          <Text style={{ color: expiryTone }}>{grant ? countdown(left) : "no key yet"}</Text>. It dies on
          schedule whether or not anyone intervenes.
        </Bullet>
        <Bullet>
          Moving the funds out with your recovery phrase. The owner key is the only signer that can, and it is
          not bound by the caps.
        </Bullet>
        {/* An unreachable agent is itself news on this section — and it used to
            be swallowed, leaving the chat card spinning "checking the bridge…". */}
        {tgError && (
          <Text style={styles.errorBox}>
            Couldn&apos;t reach your agent to check the chat — {tgError}. The stops above that don&apos;t go
            through this phone still work.
          </Text>
        )}
        {/* Linked users get the chat button HERE, at the moment of need, rather
            than a section away under a heading about setup. */}
        {linked && tg?.botUsername && (
          <Pressable style={styles.action} onPress={openTelegram}>
            <Text style={styles.actionText}>Open the conversation</Text>
          </Pressable>
        )}
        {/* The one action in this list the app CAN perform, so it gets a button
            rather than being described and left to the reader to find. */}
        <Pressable style={styles.action} onPress={() => router.push("/recover")}>
          <Text style={styles.actionText}>Sweep the account to a wallet I control</Text>
        </Pressable>
      </View>

      {/* ── recovery phrase ──────────────────────────────────────────────── */}
      {/* SECOND, because the bullet above and the sweep button both end at "your
          recovery phrase", and the next thing under them should be it. */}
      <Text style={styles.section}>recovery phrase</Text>
      <View style={styles.card}>
        {phrase ? (
          <>
            <View style={styles.grid}>
              {phrase.split(" ").map((w, i) => (
                <View key={`${i}-${w}`} style={styles.wordCell}>
                  <Text style={styles.wordIndex}>{i + 1}</Text>
                  <Text style={styles.word}>{w}</Text>
                </View>
              ))}
            </View>
            <Pressable style={styles.action} onPress={() => setPhrase(null)}>
              <Text style={styles.actionText}>Hide</Text>
            </Pressable>
          </>
        ) : (
          <>
            {/* The camera-roll clause is not new copy for the product —
                onboarding says it when the words FIRST appear. This is the
                reveal months later, plausibly in public, and it was the one
                without the warning. */}
            <Text style={styles.body}>
              Anyone who reads these words controls your funds. Check nobody is looking over your shoulder,
              and don&apos;t photograph them — a photo in your camera roll syncs to the cloud.
            </Text>
            <Pressable style={styles.action} onPress={reveal}>
              <Text style={styles.actionText}>Show my phrase</Text>
            </Pressable>
          </>
        )}
        {/* The owner address belongs with the phrase that derives it, not in a
            card about spending caps — you check it to confirm this phrase
            controls the account you think it does. Rendered only when there IS
            one: a row reading "owner —" is a dash where the reassurance should
            be, on the screen where it matters most. */}
        {owner && (
          <Row label="owner" value={short(owner)} onCopy={() => Clipboard.setStringAsync(owner)} last />
        )}
      </View>

      {/* ── talking to it ────────────────────────────────────────────────── */}
      {/*
        This was its own screen. It is a setup step you do once — link the phone
        to the bot — and after that the conversation happens in Telegram, so a
        whole destination in the app for it was a tab you never went back to.

        WHY IT HANDS OFF RATHER THAN BEING A CHAT BOX. There is no chat endpoint:
        narrateChat lives in the worker, and everything that makes the
        conversation safe lives beside it — the chat allowlist, the single-use
        link code, and the confirm-park flow that stops "send 400 USDG to 0x…"
        executing on one message. A chat box here would reach none of that, or
        would need it all rebuilt, and a second implementation of a confirmation
        gate ends up subtly weaker than the first.

        Now THIRD, and it shrinks as you answer it. Once you are linked, the
        instructions are answered questions and the button has moved up to the
        stop section — but the confirm-park guarantee survives as one line,
        because "can someone in my chat drain me?" is a question that must have
        an answer on the device, not only in the bot's own /help.
      */}
      {!tgError && (
        <>
          <Text style={styles.section}>talking to it</Text>
          <View style={styles.card}>
            {tg === null ? (
              <Text style={styles.muted}>checking the bridge…</Text>
            ) : tgMock ? (
              /* Say it instead of dressing up invented values as a real bridge.
                 The bot handle and the link code below would both be fiction. */
              <Text style={styles.body}>
                No agent to talk to — this build reads generated data. The bot handle and link code a real
                install shows you would both be invented here, so they aren&apos;t shown.
              </Text>
            ) : !tg.hasToken ? (
              /* Nothing this app can do about a missing token — the bot is created in
                 Telegram and its token pasted into the dashboard, and the token
                 deliberately never travels to a client. Say where to go. */
              <Text style={styles.body}>
                No bot yet. Create one with @BotFather, then paste its token into your dashboard under
                Settings → Telegram. The token stays on the machine running your agent — it never comes to
                this phone.
              </Text>
            ) : linked ? (
              <Text style={styles.body}>
                Linked. Moving money out always takes a second, explicit confirmation in the chat and is
                capped by the wall you signed — one message can never send your funds anywhere.
              </Text>
            ) : (
              <>
                <Text style={styles.body}>
                  Ask it what it&apos;s holding, why it made a trade, or tell it to stop — in plain English.
                  Moving money out always takes a second, explicit confirmation and is capped by the wall you
                  signed, so one message can never send your funds anywhere.
                </Text>
                {tg.linkCode && (
                  /* Not one word changed. It moved out of the app's quietest text
                     rung, whose comment in tokens.ts records that it was already
                     recoloured once for carrying a theft warning — it was still
                     carrying this one. */
                  <View style={styles.warn}>
                    <Text style={styles.warnText}>
                      Opening the chat sends your one-time link code, which is what tells your agent to trust
                      this chat. Don&apos;t paste that code anywhere public.
                    </Text>
                  </View>
                )}
                <Pressable style={styles.action} disabled={!tg.botUsername} onPress={openTelegram}>
                  <Text style={styles.actionText}>Open Telegram and link</Text>
                </Pressable>
              </>
            )}
          </View>
        </>
      )}

      {/* ── the wall ─────────────────────────────────────────────────────── */}
      {/* FOURTH. This is a lookup, not an emergency: the one urgent thing on the
          card — how long the key has left — is now also carried in the stop list
          above, with the same escalating colour. */}
      <Text style={styles.section}>the wall</Text>
      {!loaded ? (
        <Text style={styles.muted}>reading…</Text>
      ) : grant ? (
        <View style={[styles.card, styles.rowCard]}>
          <Row label="smart account" value={short(grant.smartAccount)} onCopy={() => Clipboard.setStringAsync(grant.smartAccount)} />
          {/* Kept, and now copyable. While the session key can still spend more
              than the caps suggest (see the open wall-narrowing work), this is
              the identity of the thing that actually moves your money — hiding
              it under a heading that promises "verify every cap" would make the
              card more misleading, not less. */}
          <Row
            label="session key"
            value={short(grant.sessionKeyAddress)}
            onCopy={() => Clipboard.setStringAsync(grant.sessionKeyAddress)}
          />
          <Row label="most per trade" value={`${grant.caps.perTradeUsdg} USDG`} />
          <Row label="most per day" value={`${grant.caps.dailyUsdg} USDG`} />
          <Row label="trades per day" value={String(grant.caps.maxOpsPerDay)} />
          {/* A signed cap, chosen at /grant and shown there as "stops out at
              −10% drawdown", then never surfaced again. A card headed "verify
              every cap" that showed four of five was the bigger problem. */}
          <Row label="stops out at" value={`−${grant.caps.maxDrawdownPct}%`} />
          <Row label="key expires" value={countdown(left)} tone={expiryTone} last />
          <Pressable
            style={styles.link}
            onPress={() => Linking.openURL(`${EXPLORER}/address/${grant.smartAccount}`)}
          >
            <Text style={styles.linkText}>verify every cap on the explorer →</Text>
          </Pressable>
          {/* Expiry is the state where re-signing matters most, and it was the
              one state with no button for it — "Sign a wall" existed only when
              there had never been one. */}
          {left <= 0 && (
            <Pressable style={styles.action} onPress={() => router.push("/onboarding/grant")}>
              <Text style={styles.actionText}>Sign a new wall</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.muted}>
            No wall signed on this device yet. Without one, nothing can trade on your behalf.
          </Text>
          <Pressable style={styles.action} onPress={() => router.push("/onboarding/grant")}>
            <Text style={styles.actionText}>Sign a wall</Text>
          </Pressable>
        </View>
      )}

      {/* ── data ─────────────────────────────────────────────────────────── */}
      <Text style={styles.section}>data</Text>
      <View style={styles.card}>
        <Row label="feed" value={isMock ? "mock (generated)" : feedOrigin} tone={isMock ? C.gold : C.text} last />
        {isMock && (
          <Text style={styles.muted}>
            Every number in this app is generated on-device. Set EXPO_PUBLIC_FEED_ORIGIN to read a real agent.
          </Text>
        )}
      </View>

      {/* ── danger ───────────────────────────────────────────────────────── */}
      <Text style={styles.section}>danger</Text>
      <Pressable style={styles.danger} onPress={forgetEverything}>
        <Text style={styles.dangerText}>Forget this device</Text>
      </Pressable>
      {/* Named for what it does. "Revoke" would imply it reaches the agent or the
          chain, and it reaches neither. */}
      <Text style={styles.dangerNote}>
        Removes the key and grant from this phone only. It does not stop a running agent and does not move your
        funds. Irreversible without your written phrase.
      </Text>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  tone,
  last,
  onCopy,
}: {
  label: string;
  value: string;
  tone?: string;
  last?: boolean;
  onCopy?: () => void;
}) {
  return (
    <Pressable style={[styles.row, last && styles.rowLast]} onPress={onCopy} disabled={!onCopy}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tone ? { color: tone } : null]}>{value}</Text>
    </Pressable>
  );
}

/** Takes children rather than a string, so a bullet can tone one span of itself
 *  — the expiry countdown turns gold then red inside its sentence. */
function Bullet({ children }: { children: ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletMark}>·</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 20, gap: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  h1: { color: C.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  done: { minHeight: 44, justifyContent: "center", paddingLeft: 12 },
  doneText: { color: C.green, fontSize: 15, fontWeight: "600" },
  section: {
    color: C.faint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.3,
    marginTop: 18,
  },
  card: { backgroundColor: C.bg2, borderRadius: 12, padding: 14, gap: 10 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 12,
    minHeight: 44,
  },
  rowLast: { borderBottomWidth: 0 },
  /**
   * For cards whose children are Rows. The rows already carry their own vertical
   * padding AND their own separator, so the card's `gap` stacked on top pushed
   * every rule 10dp toward the row above it rather than sitting between the two.
   */
  rowCard: { gap: 0 },
  rowLabel: { color: C.dim, fontSize: 13.5 },
  rowValue: { color: C.text, fontSize: 13.5, fontVariant: ["tabular-nums"] },
  body: { color: C.dim, fontSize: 13.5, lineHeight: 20 },
  em: { color: C.text2 },
  muted: { color: C.faint, fontSize: 12.5, lineHeight: 19 },
  bullet: { flexDirection: "row", gap: 8 },
  bulletMark: { color: C.green, fontSize: 14 },
  bulletText: { color: C.dim, fontSize: 13, lineHeight: 19, flexShrink: 1 },
  link: { minHeight: 44, justifyContent: "center" },
  linkText: { color: C.green, fontSize: 13 },
  /** The gold warn surface from onboarding, so the same class of warning looks
   *  the same wherever it appears. */
  warn: {
    backgroundColor: "rgba(234,179,8,0.12)",
    borderColor: "rgba(234,179,8,0.35)",
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
  },
  warnText: { color: C.gold, fontSize: 13, lineHeight: 19 },
  /** Matches recover.tsx's errorBox — a failure the user must act on, not a
   *  muted aside. */
  errorBox: {
    color: C.red,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: "rgba(251,113,133,0.10)",
    borderColor: "rgba(251,113,133,0.30)",
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
  },
  action: {
    backgroundColor: C.bg3,
    borderRadius: 12,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    // "Sweep the account to a wallet I control" already fills 80% of the button
    // at the default text size; with no horizontal padding it touches both
    // borders at iOS Larger Text and wraps flush against them above that.
    // recover.tsx solved this on its equivalent button and settings never got it.
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  actionText: { color: C.text2, fontSize: 14, fontWeight: "600", textAlign: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  wordCell: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    backgroundColor: C.bg3,
    borderRadius: 7,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minWidth: "30%",
  },
  wordIndex: { color: C.faint, fontSize: 10, fontVariant: ["tabular-nums"] },
  word: { color: C.text, fontSize: 14, fontWeight: "600" },
  danger: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(251,113,133,0.35)",
    marginTop: 4,
  },
  dangerText: { color: C.red, fontSize: 15, fontWeight: "600", textAlign: "center" },
  dangerNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
