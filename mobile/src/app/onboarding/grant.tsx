import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { signGrant } from "@/crypto/signGrant";
import { saveGrant } from "@/crypto/grantStore";
import { isMock } from "@/net/api";
// A VALUE import, not just a type. The tradeable set is read from the shared core
// package so the wall lists what the key may actually touch — and because a
// type-only import would be erased at compile time, leaving the Metro alias for
// @merrymen/core configured but never exercised, which is the same as untested.
import { DEFAULT_PERMISSION_DAYS, TRADEABLE_SYMBOLS, type GrantCaps } from "@merrymen/core";
import { accountFromMnemonic } from "@/crypto/mnemonic";
import { readOwner } from "@/crypto/keystore";
import { fundWithPhantom } from "@/net/wallets";
import { handoffMessage } from "@/net/handoffMessage";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { C } from "@/ui/tokens";

/**
 * The permission wall — what the agent will be allowed to do, before it can.
 *
 * This screen's job is comprehension, not decoration. The caps below are not
 * settings the app enforces politely; once signed they are conditions inside the
 * account contract, and a fully compromised agent still cannot exceed them. That
 * is the entire product, so the screen says it in plain words rather than showing
 * five sliders and hoping.
 *
 * Presets and values are the same three the dashboard offers, so a person who set
 * up on desktop sees the same choices here. (The web form opens on the scout and
 * calls it the default; this screen opens on the outlaw.)
 *
 * Every preset runs the shared monthly `DEFAULT_PERMISSION_DAYS`: they differ in
 * how much money the agent may move, not in how often its owner must sign. The
 * scout and the outlaw were 7 and 14 days, so an agent set up here went offline
 * every week or two until somebody signed again.
 */

const PRESETS: { id: string; label: string; blurb: string; caps: GrantCaps }[] = [
  {
    id: "scout",
    label: "cautious · the scout",
    blurb: "dip a toe — tiny trades, tight leash",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: DEFAULT_PERMISSION_DAYS, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  },
  {
    id: "outlaw",
    label: "balanced · the outlaw",
    blurb: "the sensible default",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: DEFAULT_PERMISSION_DAYS, maxDrawdownPct: 10, maxOpsPerDay: 48 },
  },
  {
    id: "warlord",
    label: "bold · the warlord",
    blurb: "bigger arrows, wider walls",
    caps: { perTradeUsdg: 200, dailyUsdg: 2000, expiryDays: DEFAULT_PERMISSION_DAYS, maxDrawdownPct: 15, maxOpsPerDay: 96 },
  },
];

export default function Grant() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();
  const [preset, setPreset] = useState(PRESETS[1]);
  const [owner, setOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("signing…");
  const [signed, setSigned] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the wallet handoff actually did. Held as a message rather than a
  // boolean because the copy and the app-open fail independently, and telling
  // someone "copied" when it wasn't sends them to paste an empty clipboard.
  const [handoff, setHandoff] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const status = await readOwner();
      if (status.state === "present") {
        try {
          setOwner(accountFromMnemonic(status.mnemonic).address);
        } catch {
          setOwner(null);
        }
      }
    })();
  }, []);

  const caps = preset.caps;

  const sign = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const status = await readOwner();
      if (status.state !== "present") {
        // Re-read rather than trusting the address held in state: the OS can
        // invalidate the key between screens, and signing with a stale
        // assumption would fail confusingly deep inside the SDK.
        setError("Your key isn't available. Restart onboarding.");
        return;
      }
      const { grant } = await signGrant({
        mnemonic: status.mnemonic,
        caps,
        onProgress: setStep,
      });
      await saveGrant(grant);
      setSigned(grant.smartAccount);
    } catch (e) {
      setError(e instanceof Error ? `${e.message}` : "Signing failed.");
    } finally {
      setBusy(false);
    }
  }, [caps]);

  /**
   * Copy the account and open Phantom, in that order and in one tap.
   *
   * Phantom publishes no deeplink that prefills a send (see net/wallets.ts), so
   * "one tap, then paste" is the most automatic this can honestly be — and every
   * outcome below is reported truthfully rather than assumed, because the copy
   * and the launch fail for different reasons.
   */
  const fundNow = useCallback(async () => {
    if (!signed) return;
    setHandoff(handoffMessage(await fundWithPhantom(signed)));
  }, [signed]);

  // Say it before the walkthrough, not as a thrown error at the end of it.
  // signGrant refuses too — that is the real enforcement, and this is the part
  // that stops someone reading four screens of caps that will never be signed.
  if (isMock) {
    return (
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}>
        <Text style={styles.h1}>Not in a demo build</Text>
        <Text style={styles.lede}>
          This build reads generated data — the balances and trades it shows are invented on the phone. So it
          will not sign a permission wall, because signing one would create a real account on Robinhood Chain
          that real money could be sent to, and every number this app then showed you about it would be
          fiction.
        </Text>
        <Text style={styles.lede}>
          Your recovery phrase is real and is safe on this device. To actually run an agent, install a build
          pointed at your own worker.
        </Text>
        <Pressable style={styles.primary} onPress={() => router.replace("/")}>
          <Text style={styles.primaryText}>Look around the demo</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}>
      <Text style={styles.h1}>The permission wall</Text>
      <Text style={styles.lede}>
        You&apos;re about to give your agent a key that can trade — and only trade, inside these limits. They
        live in the account contract on-chain, not in this app: a compromised agent can trade inside the
        wall, but it can&apos;t sign anything in your name, can&apos;t send your funds to an address you
        didn&apos;t register, and can&apos;t touch your ETH.
      </Text>

      <Text style={styles.section}>temperament</Text>
      {PRESETS.map((p) => {
        const on = p.id === preset.id;
        return (
          <Pressable key={p.id} style={[styles.preset, on && styles.presetOn]} onPress={() => setPreset(p)}>
            <View style={styles.presetHead}>
              <Text style={[styles.presetLabel, on && styles.presetLabelOn]}>{p.label}</Text>
              {on && <Text style={styles.check}>✓</Text>}
            </View>
            <Text style={styles.presetBlurb}>{p.blurb}</Text>
          </Pressable>
        );
      })}

      <Text style={styles.section}>what it may do</Text>
      <View style={styles.caps}>
        <Cap label="most per trade" value={`${caps.perTradeUsdg} USDG`} />
        <Cap label="most per day" value={`${caps.dailyUsdg} USDG`} />
        <Cap label="trades per day" value={`${caps.maxOpsPerDay}`} />
        <Cap label="renews every" value={`${caps.expiryDays} days`} />
        <Cap label="stops out at" value={`−${caps.maxDrawdownPct}% drawdown`} last />
      </View>

      <Text style={styles.section}>what it may trade</Text>
      <View style={styles.symbols}>
        {TRADEABLE_SYMBOLS.map((s) => (
          <Text key={s} style={styles.symbol}>
            {s}
          </Text>
        ))}
      </View>
      <Text style={styles.symbolNote}>
        {TRADEABLE_SYMBOLS.length} assets, read from the same registry the worker uses. Anything not on this
        list needs a new wall, signed by you.
      </Text>

      <Text style={styles.section}>what it may never do</Text>
      <View style={styles.nevers}>
        <Never text="Send your money anywhere. This wall registers no withdrawal address, so it carries no transfer permission at all — the chain refuses every send. Funds come home with your owner key." />
        <Never text="Trade an asset outside the allowed list. Adding one means signing a new wall, which is why it can't widen by itself." />
        <Never text="Trade past its permission. When the permission ends, trading stops on schedule even if every other control fails." />
        <Never text="Touch your recovery phrase. It never leaves this phone — not to us, not to the agent, not over the network." />
      </View>

      {owner && (
        <View style={styles.ownerBox}>
          <Text style={styles.ownerLabel}>signing as</Text>
          <Text style={styles.ownerAddr}>{owner}</Text>
        </View>
      )}

      {signed ? (
        <View style={styles.done}>
          <Text style={styles.doneTitle}>Wall signed</Text>
          <Text style={styles.doneLabel}>smart account · Robinhood Chain</Text>
          {/* Selectable: this screen asks the reader to move money to this
              address, so being able to select it by hand is the floor. The
              button below is the fast path, not the only one. */}
          <Text style={styles.doneAddr} selectable>
            {signed}
          </Text>
          <Text style={styles.doneText}>
            Send USDG and a little ETH for gas here, and your agent can start inside the limits above. Your
            recovery phrase never left this phone.
          </Text>

          <Pressable style={styles.fundBtn} onPress={fundNow}>
            <Text style={styles.fundBtnText}>Copy address & open Phantom</Text>
          </Pressable>
          {handoff && <Text style={styles.handoff}>{handoff}</Text>}
          {/* Phantom carries Robinhood Chain on the same EVM address it already
              uses for Ethereum, but the network ships switched off, and a send
              screen with no Robinhood Chain in the list is exactly where someone
              gets stuck. Say where the toggle is, once. */}
          <Text style={styles.fundNote}>
            No Robinhood Chain in Phantom&apos;s network list? Turn it on under Settings → Active Networks. Any
            wallet or exchange that supports Robinhood Chain works too — the address above is the same either
            way.
          </Text>
        </View>
      ) : (
        <>
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable style={[styles.primary, busy && styles.primaryOff]} disabled={busy} onPress={sign}>
            {busy ? (
              <View style={styles.busyRow}>
                <ActivityIndicator color="#08120e" />
                <Text style={styles.primaryText}>{step}</Text>
              </View>
            ) : (
              <Text style={styles.primaryText}>Sign this wall</Text>
            )}
          </Pressable>
          <Text style={styles.signNote}>
            Signing happens on this device. Only the capped session key is ever shareable — your recovery
            phrase is not part of what gets signed or sent.
          </Text>
        </>
      )}

      <Pressable style={styles.secondary} onPress={() => router.replace("/")}>
        <Text style={styles.secondaryText}>{signed ? "Go to the dashboard" : "Skip for now"}</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * `last` drops the trailing rule. Without it the final row still drew its
 * separator 5dp above the card's own bottom edge — a divider between the last
 * value and nothing, which then read as the card's edge and made the real edge
 * look misaligned.
 */
function Cap({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.capRow, last && styles.capRowLast]}>
      <Text style={styles.capLabel}>{label}</Text>
      <Text style={styles.capValue}>{value}</Text>
    </View>
  );
}

function Never({ text }: { text: string }) {
  return (
    <View style={styles.neverRow}>
      <Text style={styles.neverMark}>✕</Text>
      <Text style={styles.neverText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 24, gap: 12 },
  h1: { color: C.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  lede: { color: C.dim, fontSize: 15, lineHeight: 22 },
  section: {
    color: C.faint,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1.3,
    marginTop: 18,
  },
  preset: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    padding: 14,
    gap: 4,
    minHeight: 60,
  },
  presetOn: { borderColor: C.green, backgroundColor: "rgba(52,211,153,0.10)" },
  presetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  presetLabel: { color: C.text2, fontSize: 15, fontWeight: "600" },
  presetLabelOn: { color: C.green },
  presetBlurb: { color: C.faint, fontSize: 12.5 },
  check: { color: C.green, fontSize: 15 },
  caps: { backgroundColor: C.bg2, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 4 },
  capRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    gap: 12,
  },
  capRowLast: { borderBottomWidth: 0 },
  capLabel: { color: C.dim, fontSize: 14 },
  capValue: { color: C.text, fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  symbols: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 2 },
  symbol: {
    color: C.text2,
    fontSize: 12.5,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 9,
    overflow: "hidden",
  },
  symbolNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 6 },
  nevers: { gap: 10, marginTop: 2 },
  neverRow: { flexDirection: "row", gap: 10 },
  neverMark: { color: C.red, fontSize: 13, marginTop: 2 },
  neverText: { color: C.dim, fontSize: 13.5, lineHeight: 20, flexShrink: 1 },
  ownerBox: { backgroundColor: C.bg2, borderRadius: 10, padding: 13, gap: 4, marginTop: 14 },
  ownerLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  ownerAddr: { color: C.text2, fontSize: 12 },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  primaryOff: { opacity: 0.6 },
  primaryText: { color: '#08120e', fontSize: 16, fontWeight: '700' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  signNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 8 },
  error: { color: C.red, fontSize: 13, lineHeight: 19, marginTop: 12 },
  done: {
    backgroundColor: 'rgba(52,211,153,0.10)',
    borderColor: 'rgba(52,211,153,0.35)',
    borderWidth: 1,
    borderRadius: 12,
    padding: 15,
    gap: 6,
    marginTop: 16,
  },
  doneTitle: { color: C.green, fontSize: 15, fontWeight: '700' },
  doneLabel: { color: C.faint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 },
  doneAddr: { color: C.text, fontSize: 12 },
  doneText: { color: C.dim, fontSize: 13, lineHeight: 19, marginTop: 4 },
  fundBtn: {
    backgroundColor: C.green,
    borderRadius: 10,
    // 48 not 52: this sits inside the done card rather than being the screen's
    // own primary action, and matching the page button would compete with it.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    // The label is long enough to wrap flush against both borders at iOS
    // Larger Text without this — the same fix settings.tsx's action carries.
    paddingHorizontal: 14,
    marginTop: 10,
  },
  fundBtnText: { color: '#08120e', fontSize: 15, fontWeight: '700', textAlign: 'center' },
  handoff: { color: C.green, fontSize: 12.5, lineHeight: 18, marginTop: 8 },
  fundNote: { color: C.faint, fontSize: 12, lineHeight: 18, marginTop: 8 },
  secondary: {
    backgroundColor: C.bg2,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
    marginTop: 8,
  },
  secondaryText: { color: C.text2, fontSize: 15 },
});
