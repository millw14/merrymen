import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { formatEther, isAddress, type Address } from "viem";
import type { BrowserPlan } from "../../../web/src/lib/recover-client";
import { accountFromMnemonic, validateMnemonic } from "@/crypto/mnemonic";
import { planMobileRecovery, recoveryOrigin, sweepMobileRecovery } from "@/crypto/recovery";
import { forgetOwner, readOwner, writeOwner } from "@/crypto/keystore";
import { readGrant } from "@/crypto/grantStore";
import { EXPLORER, RPC_URL } from "@/net/chainlinks";
import { feedOrigin } from "@/net/api";
import { useBottomPad, useTopPad } from "@/ui/insets";
import { useNoScreenshots } from "@/ui/useNoScreenshots";
import { C } from "@/ui/tokens";

/**
 * Recovery — restore the key, then sweep the account back to a wallet you control.
 *
 * Reached when the keystore's marker survives but the secret does not, which on
 * Android means the OS destroyed the key because biometric enrolment changed. The
 * module catches that and returns null, indistinguishable from "nothing stored"
 * unless something else remembers — hence the marker. Without this screen the app
 * would decide "first run", generate a fresh key, and strand a funded account.
 *
 * The sweep uses worker/src/recover.ts, the same code the CLI and the dashboard
 * run, because this is the operation that moves EVERYTHING at once and a second
 * implementation of it is the last thing anyone needs. It rebuilds the account
 * with the owner key as sudo signer, so it is not bound by the session key's caps
 * — that is the point, and it is also why the confirmation below is deliberate
 * rather than a single tap.
 */

type Stage = "restore" | "plan" | "sent";
// Only Merrymen's canonical service offers house recovery. Custom feed builds
// retain the standalone bundler field and explicitly pay recovery from ETH.
const API_ORIGIN = recoveryOrigin(feedOrigin);

/**
 * Strip query strings out of anything URL-shaped before it reaches the screen.
 *
 * The bundler field's own placeholder is `…/rpc?apikey=…`, and viem embeds the
 * full request URL in its error messages — errors/request.js builds
 * `URL: ${getUrl(url)}` into metaMessages, and getUrl only removes basic-auth
 * userinfo, not the search string. So a failed sweep printed the owner's
 * bundler API key on screen, in a stack of text people paste into chats when
 * asking for help.
 */
function redact(message: string): string {
  return message.replace(/(https?:\/\/[^\s]+?)\?[^\s]*/g, "$1?…");
}

export default function Recover() {
  const topPad = useTopPad();
  const bottomPad = useBottomPad();

  // The restore stage holds a typed recovery phrase in a TextInput and previews
  // the address it derives. Same protection as the screens that display one.
  useNoScreenshots("recover");
  const [stage, setStage] = useState<Stage>("restore");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [plan, setPlan] = useState<BrowserPlan | null>(null);
  const [expected, setExpected] = useState<Address | null>(null);
  const [grantTokens, setGrantTokens] = useState<readonly string[]>([]);
  const [selectedClassVault, setSelectedClassVault] = useState("");
  const [to, setTo] = useState("");
  const [bundler, setBundler] = useState("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ symbol: string; reason: string }[]>([]);

  // If a grant is still on the device we know which account the phrase SHOULD
  // control, which turns "wrong key" from a confusing empty sweep into a clear
  // mismatch error before anything is signed.
  useEffect(() => {
    void (async () => {
      const g = await readGrant();
      if (g) setExpected(g.smartAccount as Address);
      const owner = await readOwner();
      // Already holding a key? Skip straight to planning — this screen is also
      // reachable from settings for a deliberate sweep, not only after a loss.
      if (owner.state === "present") setStage("plan");
    })();
  }, []);

  const restore = useCallback(async () => {
    const check = validateMnemonic(phrase);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setBusy(true);
    try {
      await writeOwner(check.mnemonic);
      setPhrase("");
      setError(null);
      setStage("plan");
    } catch {
      setError("Couldn't save to the keychain. Try again.");
    } finally {
      setBusy(false);
    }
  }, [phrase]);

  const doPlan = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote("reading the account…");
    try {
      const owner = await readOwner();
      if (owner.state !== "present") {
        setError("No key on this device. Enter your recovery phrase first.");
        setStage("restore");
        return;
      }
      const saved = await readGrant();
      const tokens = saved?.grantTokens ?? [];
      const p = await planMobileRecovery({
        owner: accountFromMnemonic(owner.mnemonic),
        apiOrigin: API_ORIGIN,
        rpcUrl: RPC_URL,
        // Throws a clear "this key controls X, not Y" rather than sweeping the
        // wrong (probably empty) account.
        expectedSmartAccount: expected ?? undefined,
        grantTokens: tokens,
      });
      setPlan(p);
      setGrantTokens(tokens);
      setSelectedClassVault(p.classVaults.find(v => v.holdings.length > 0)?.vault ?? "");
    } catch (e) {
      setError(e instanceof Error ? redact(e.message) : "Couldn't read the account.");
    } finally {
      setBusy(false);
      setNote(null);
    }
  }, [expected]);

  const sweep = useCallback(async () => {
    if (!plan) return;
    if (!isAddress(to)) {
      setError("Enter the address you want the funds sent to.");
      return;
    }
    if (!API_ORIGIN && !bundler.startsWith("http")) {
      setError("A bundler URL is required — a smart account cannot move funds without one.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote("signing and submitting…");
    try {
      const owner = await readOwner();
      if (owner.state !== "present") throw new Error("key unavailable");
      const selected = plan.classVaults.find(v => v.vault === selectedClassVault);
      const res = await sweepMobileRecovery({
        owner: accountFromMnemonic(owner.mnemonic),
        apiOrigin: API_ORIGIN,
        rpcUrl: RPC_URL,
        bundlerUrl: bundler.trim(),
        plan,
        grantTokens,
        to: to as Address,
        ...(selected?.holdings.length ? { approvedClass: { vault: selected.vault, tokens: selected.holdings.map(h => h.token) } } : {}),
      });
      setTxHash(res.txHash);
      setSkipped(res.skipped);
      setStage("sent");
    } catch (e) {
      setError(e instanceof Error ? redact(e.message) : "The sweep failed.");
    } finally {
      setBusy(false);
      setNote(null);
    }
  }, [plan, to, bundler, grantTokens, selectedClassVault]);

  const hasBalances = (plan?.balances.length ?? 0) > 0 || (plan?.nativeRecoverableWei ?? 0n) > 0n || (plan?.classVaults.some(v => v.holdings.length > 0) ?? false);
  const noGas = plan?.needsGas === true;
  const coverageUnavailable = API_ORIGIN !== null && plan?.gasSponsored !== true;
  const cannotSweep = busy || noGas || coverageUnavailable || (plan?.unreadable.length ?? 0) > 0;

  return (
    // automaticallyAdjustKeyboardInsets, because this screen does not scroll: its
    // content is shorter than the viewport, so there is no scroll range to drag
    // and the keyboard simply covers the bottom of "Restore my key". On the one
    // screen someone reaches in a panic, the button they came for was buried.
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: topPad, paddingBottom: bottomPad }]}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled">
      {stage === "restore" && (
        <>
          <Text style={styles.h1}>This device lost its key</Text>
          <Text style={styles.lede}>
            The key was stored here and the phone&apos;s keystore no longer has it. That normally happens when
            the fingerprint or face setup changed, which wipes anything locked to it.
          </Text>
          <Text style={styles.lede}>
            <Text style={styles.strong}>Your funds are fine.</Text> They are in the smart account on-chain, not
            on this phone.
          </Text>

          <Text style={styles.label}>Recovery phrase</Text>
          <TextInput
            style={styles.input}
            value={phrase}
            onChangeText={(t) => {
              setPhrase(t);
              setError(null);
            }}
            placeholder="twelve words, separated by spaces"
            placeholderTextColor={C.faint}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            textContentType="none"
          />
          {(() => {
            const c = validateMnemonic(phrase);
            return c.ok ? (
              <Text style={styles.preview}>owner {accountFromMnemonic(c.mnemonic).address}</Text>
            ) : null;
          })()}
          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable style={styles.primary} disabled={busy} onPress={restore}>
            {busy ? <ActivityIndicator color="#08120e" /> : <Text style={styles.primaryText}>Restore my key</Text>}
          </Pressable>

          <View style={styles.divider} />
          <Text style={styles.smallHead}>If you don&apos;t have the phrase</Text>
          <Text style={styles.small}>
            Then this account cannot be recovered — not by us, not by anyone. The owner key is the only signer
            that can move funds out, and it existed only on this device and on your written copy.
          </Text>
          <Pressable
            style={styles.danger}
            onPress={async () => {
              await forgetOwner();
              router.replace("/onboarding");
            }}
          >
            <Text style={styles.dangerText}>Forget this account and start fresh</Text>
          </Pressable>
        </>
      )}

      {stage === "plan" && (
        <>
          <Text style={styles.h1}>Sweep the account</Text>
          <Text style={styles.lede}>
            This moves every token out of your smart account to an address you choose, signed by your owner key.
            It is <Text style={styles.strong}>not</Text> bound by the caps your agent trades under — that is
            what makes it work when a session key is gone or expired.
          </Text>
          {API_ORIGIN && <Text style={styles.hint}>Checking fee coverage signs an ownership proof. It moves no funds and grants no permissions.</Text>}

          {!plan ? (
            <Pressable style={styles.primary} disabled={busy} onPress={doPlan}>
              {busy ? (
                <View style={styles.busyRow}>
                  <ActivityIndicator color="#08120e" />
                  <Text style={styles.primaryText}>{note ?? "reading…"}</Text>
                </View>
              ) : (
                <Text style={styles.primaryText}>Check what&apos;s in the account</Text>
              )}
            </Pressable>
          ) : (
            <>
              <View style={styles.card}>
                <Text style={styles.cardLabel}>smart account</Text>
                <Text style={styles.cardAddr}>{plan.smartAccount}</Text>
                <Text style={styles.cardLabel}>holds</Text>
                {plan.balances.length > 0 ? (
                  plan.balances.map((b) => (
                    <View key={b.address} style={styles.balRow}>
                      <Text style={styles.balSym}>{b.symbol}</Text>
                      <Text style={styles.balAmt}>{b.amount}</Text>
                    </View>
                  ))
                ) : (
                  <Text style={styles.muted}>{plan.unreadable.length ? "Account token balances are incomplete." : "No tokens are held in the account itself."}</Text>
                )}
                <View style={styles.balRow}>
                  <Text style={styles.balSymDim}>ETH balance</Text>
                  <Text style={[styles.balAmt, noGas && { color: C.red }]}>{formatEther(plan.gasWei)}</Text>
                </View>
              </View>
              <Text style={styles.warnText}>
                {plan.gasSponsored ? "Merrymen covers the network fee, including the selected Class vault. Recoverable ETH moves too; none is kept as a fee reserve." : API_ORIGIN ? "Merrymen fee coverage is unavailable. Refresh the plan when coverage is restored. This app will not charge your ETH as a fallback." : `Standalone recovery pays the network fee from this account. ${formatEther(plan.nativeReserveWei)} ETH is reserved for fees; the remaining recoverable ETH moves with the tokens.`}
              </Text>
              {plan.sponsorshipReason && <Text style={styles.hint}>{plan.sponsorshipReason}</Text>}
              {noGas && !API_ORIGIN && (
                <Text style={styles.errorBox}>
                  This account has no ETH, so it cannot pay for its own recovery. Send a small amount of ETH to
                  the address above first, then come back.
                </Text>
              )}
              {plan.unreadable.length > 0 && <Text style={styles.errorBox}>Some balances could not be read: {plan.unreadable.join(", ")}. Refresh the plan before confirming.</Text>}
              {plan.classVaults.filter(v => v.holdings.length > 0).map(v => (
                <Pressable key={v.vault} style={styles.card} disabled={busy} onPress={() => setSelectedClassVault(v.vault)}>
                  <Text style={styles.cardLabel}>{selectedClassVault === v.vault ? "Selected Class vault" : "Select Class vault"}</Text>
                  <Text style={styles.cardAddr}>{v.vault}</Text>
                  {v.holdings.map(h => <View key={h.token} style={styles.balRow}><Text style={styles.balSym}>{h.symbol}</Text><Text style={styles.balAmt}>{h.amount}</Text></View>)}
                  {v.note && <Text style={styles.hint}>{v.note}</Text>}
                </Pressable>
              ))}
              {plan.classVaults.filter(v => v.holdings.length > 0).length > 1 && <Text style={styles.hint}>Only the selected Class vault is included. Recover the others separately.</Text>}
              <Pressable style={styles.ghost} disabled={busy} onPress={doPlan}><Text style={styles.ghostText}>Refresh balances and fee coverage</Text></Pressable>

              {hasBalances && (
                <>
                  <Text style={styles.label}>Send everything to</Text>
                  <TextInput
                    style={styles.inputOne}
                    value={to}
                    onChangeText={(t) => {
                      setTo(t);
                      setError(null);
                    }}
                    placeholder="0x… a wallet you control"
                    placeholderTextColor={C.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                  />
                  <Text style={styles.hint}>
                    Use a normal wallet address you can already access — not this smart account, and not an
                    exchange deposit address unless you are certain it accepts this chain.
                  </Text>

                  {!API_ORIGIN && <>
                  <Text style={styles.label}>Your bundler URL — standalone recovery</Text>
                  <TextInput
                    style={styles.inputOne}
                    value={bundler}
                    onChangeText={(t) => {
                      setBundler(t);
                      setError(null);
                    }}
                    placeholder="https://api.pimlico.io/v2/4663/rpc?apikey=…"
                    placeholderTextColor={C.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                  />
                  <Text style={styles.hint}>
                    This standalone recovery uses your own bundler and this account&apos;s ETH. A custom feed does not provide Merrymen&apos;s recovery service or fee coverage.
                  </Text>
                  </>}

                  {error && <Text style={styles.error}>{error}</Text>}

                  <Pressable
                    style={[styles.dangerSolid, cannotSweep && styles.primaryOff]}
                    disabled={cannotSweep}
                    onPress={sweep}
                  >
                    {busy ? (
                      <View style={styles.busyRow}>
                        <ActivityIndicator color="#2a0a10" />
                        <Text style={styles.dangerSolidText}>{note ?? "working…"}</Text>
                      </View>
                    ) : (
                      <Text style={styles.dangerSolidText}>Sweep everything — this cannot be undone</Text>
                    )}
                  </Pressable>
                </>
              )}

              {error && !hasBalances && <Text style={styles.error}>{error}</Text>}

              <Pressable style={styles.ghost} onPress={() => router.replace("/")}>
                <Text style={styles.ghostText}>back to the dashboard</Text>
              </Pressable>
            </>
          )}

          {error && !plan && <Text style={styles.error}>{error}</Text>}
        </>
      )}

      {stage === "sent" && (
        <>
          <Text style={styles.h1}>Swept</Text>
          <Text style={styles.lede}>
            {txHash ? `Recoverable assets were sent to ${to}. Check the receipt for the confirmed transaction.` : "No transfer was confirmed. Refresh the account to check what remains."}
          </Text>
          {skipped.map((item, index) => <Text key={`${item.symbol}-${index}`} style={styles.warnText}>Left behind: {item.symbol} — {item.reason}</Text>)}
          {txHash && (
            <Pressable style={styles.primary} onPress={() => Linking.openURL(`${EXPLORER}/tx/${txHash}`)}>
              <Text style={styles.primaryText}>View the receipt</Text>
            </Pressable>
          )}
          <Pressable style={styles.ghost} onPress={() => router.replace("/")}>
            <Text style={styles.ghostText}>done</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 24, gap: 12 },
  h1: { color: C.text, fontSize: 27, fontWeight: "700", letterSpacing: -0.5 },
  lede: { color: C.dim, fontSize: 15, lineHeight: 22 },
  strong: { color: C.green, fontWeight: "700" },
  label: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginTop: 12 },
  input: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    color: C.text,
    padding: 14,
    minHeight: 110,
    fontSize: 15,
    textAlignVertical: "top",
  },
  inputOne: {
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    color: C.text,
    padding: 14,
    minHeight: 48,
    fontSize: 14,
  },
  hint: { color: C.faint, fontSize: 12, lineHeight: 18 },
  preview: { color: C.dim, fontSize: 12 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
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
  warnText: { color: C.gold, fontSize: 12.5, lineHeight: 19 },
  card: { backgroundColor: C.bg2, borderRadius: 12, padding: 14, gap: 8 },
  cardLabel: { color: C.faint, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  cardAddr: { color: C.text2, fontSize: 12 },
  balRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  balSym: { color: C.text, fontSize: 14, fontWeight: "600" },
  balSymDim: { color: C.dim, fontSize: 13 },
  balAmt: { color: C.text, fontSize: 14, fontVariant: ["tabular-nums"] },
  muted: { color: C.faint, fontSize: 13 },
  primary: {
    backgroundColor: C.green,
    borderRadius: 12,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  primaryOff: { opacity: 0.45 },
  primaryText: { color: "#08120e", fontSize: 16, fontWeight: "700" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dangerSolid: {
    backgroundColor: C.red,
    borderRadius: 12,
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
    paddingHorizontal: 16,
  },
  dangerSolidText: { color: "#2a0a10", fontSize: 15, fontWeight: "700", textAlign: "center" },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 18 },
  smallHead: { color: C.text2, fontSize: 14, fontWeight: "600" },
  small: { color: C.faint, fontSize: 13, lineHeight: 20 },
  danger: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(251,113,133,0.35)",
  },
  dangerText: { color: C.red, fontSize: 14 },
  ghost: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 8 },
  ghostText: { color: C.faint, fontSize: 13 },
});
