"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CASH } from "@merrymen/core";
import type { GrantBalances } from "@/lib/grant-balances";
import {
  DEPOSIT_SOURCES,
  ETH_SOURCES,
  agentGasOf,
  amountForUsd,
  formatAmount,
  maxSendable,
  parseAmount,
  reserveFor,
  reserveLine,
  usdMicrosOf,
  type DepositSource,
  type SourceId,
} from "@/lib/deposit-math";
import {
  RELAY_ACTIVITY_URL,
  ROBINHOOD_CHAIN_ID,
  etaText,
  relayDeepLink,
  requestRelayPrice,
  usdgText,
  type DepositQuote,
} from "@/lib/relay-deposit";
import { isSourceAddress, readSourceBalance } from "@/lib/source-balance";
import { arrivalOf, balanceOf, settleWatch, type Arrival, type ArrivalWatch } from "@/lib/deposit-arrival";
import { usd as formatUsd } from "@/lib/format";
import { QrCode } from "./QrCode";

/**
 * THREE WAYS IN, ONE ADDRESS. The Add money panel's body:
 * - send USDG on Robinhood Chain straight to the agent account
 * - convert ETH, from Robinhood Chain itself, Ethereum, Base or Arbitrum
 * - convert SOL from Solana
 *
 * Every way ends as USDG at the same agent account.
 *
 * NO MONEY MOVES THROUGH THIS PAGE. The conversions show Relay's live price and
 * then open relay.link with the agent account as the recipient. The owner
 * signs there, with whichever wallet holds the funds (relay-deposit.ts). This
 * page holds no key, signs nothing, and has nothing to replay after a crash.
 *
 * Send USDG is first and is what renders before any click. It is the panel
 * every existing link, the chat's open-deposit and Android's /deposit WebView
 * already land on, with the copy button they expect.
 */

type Way = "usdg" | "eth" | "sol";
const WAYS: readonly { id: Way; label: string }[] = [
  { id: "usdg", label: "Send USDG" },
  { id: "eth", label: "From ETH" },
  { id: "sol", label: "From SOL" },
];

export interface DepositWaysProps {
  /** The agent's smart account: the only recipient any way here names. */
  agent: string;
  chainId: number;
  balances?: GrantBalances;
  gasSponsored?: boolean | null;
  /** The signed-in owner's EVM address, offered as the wallet ETH is sent from. */
  ownerAddress?: string | null;
  /** Injected in tests. The page uses the browser's fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  now?: () => number;
}

export function DepositWays({ agent, chainId, balances, gasSponsored, ownerAddress, fetchImpl, now = Date.now }: DepositWaysProps) {
  const [way, setWay] = useState<Way>("usdg");
  const [watch, setWatch] = useWatch(agent, now);
  const network = chainId === ROBINHOOD_CHAIN_ID ? "Robinhood Chain" : `chain ${chainId}`;
  // Conversions price into USDG on Robinhood Chain mainnet. On any other
  // network they would deliver to an address that is not this agent, so they
  // are not offered at all.
  const converts = chainId === ROBINHOOD_CHAIN_ID;
  const agentUsdg = balanceOf(balances?.cashUsdg);
  const startWatch = (quote: DepositQuote) => setWatch({
    baseline: agentUsdg,
    minOut: quote.minOut,
    openedAt: now(),
  });
  // Once a reading shows the deposit, the watch keeps it (and so does a reload):
  // the agent trading that USDG afterwards doesn't make the deposit missing.
  useEffect(() => {
    if (!watch) return;
    const next = settleWatch(watch, agentUsdg, now());
    if (next !== watch) setWatch(next);
  }, [watch, agentUsdg]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {converts && (
        <div className="deposit-ways" role="tablist" aria-label="How to add money">
          {WAYS.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              id={`deposit-tab-${w.id}`}
              aria-selected={way === w.id}
              aria-controls={`deposit-panel-${w.id}`}
              onClick={() => setWay(w.id)}
            >
              {w.label}
            </button>
          ))}
        </div>
      )}
      <div role={converts ? "tabpanel" : undefined} id={`deposit-panel-${way}`} aria-labelledby={converts ? `deposit-tab-${way}` : undefined}>
        {way === "usdg" && <SendUsdg agent={agent} network={network} />}
        {way === "eth" && converts && (
          <Convert key="eth" sources={ETH_SOURCES} agent={agent} balances={balances} gasSponsored={gasSponsored}
            defaultFrom={ownerAddress ?? ""} fetchImpl={fetchImpl} onLeave={startWatch} />
        )}
        {way === "sol" && converts && (
          <Convert key="sol" sources={["sol-solana"]} agent={agent} balances={balances} gasSponsored={gasSponsored}
            defaultFrom="" fetchImpl={fetchImpl} onLeave={startWatch} />
        )}
      </div>
      {watch && <ArrivalNote watch={watch} current={agentUsdg} now={now} onDone={() => setWatch(null)} />}
    </>
  );
}

/** Way 1: the address, as text, as a QR code, and copied, with the network said plainly. */
function SendUsdg({ agent, network }: { agent: string; network: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const copy = () => {
    setError("");
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) { setError("Could not copy. Select the address above to copy it."); return; }
    void write(agent).then(() => setCopied(true)).catch(() => setError("Could not copy. Select the address above to copy it."));
  };
  return (
    <>
      <div className="fund-address-card">
        <label>Your merryman&apos;s account</label>
        <QrCode value={agent} label={`QR code of your merryman's account address, ${agent}`} />
        <p className="funding-address">{agent}</p>
        <button type="button" className="flow-primary" onClick={copy}>{copied ? "Address copied" : "Copy deposit address"}</button>
        {error && <p role="alert">{error}</p>}
        <dl className="fund-breakdown deposit-facts">
          <div><dt>Network</dt><dd>{network}</dd></div>
          <div><dt>Token</dt><dd>USDG <span className="deposit-quiet">{CASH.USDG}</span></dd></div>
        </dl>
      </div>
      <p className="fund-chain-warning"><strong>Send USDG on {network}, and only there.</strong> This address on any other network is not your agent: funds sent there are stuck, and no re-sign moves them back. Your balance updates after the transfer is recorded.</p>
    </>
  );
}

type BalanceRead = { key: string; value: bigint | null; done: boolean };
type QuoteState =
  | { key: string; status: "loading" }
  | { key: string; status: "ok"; quote: DepositQuote }
  | { key: string; status: "error"; reason: string };

/** Ways 2 and 3: a live Relay price for the amount typed, then relay.link to sign. */
function Convert({ sources, agent, balances, gasSponsored, defaultFrom, fetchImpl, onLeave }: {
  sources: readonly SourceId[];
  agent: string;
  balances?: GrantBalances;
  gasSponsored?: boolean | null;
  defaultFrom: string;
  fetchImpl?: typeof fetch;
  onLeave: (quote: DepositQuote) => void;
}) {
  const [sourceId, setSourceId] = useState<SourceId>(sources[0]!);
  const source = DEPOSIT_SOURCES[sourceId];
  const [fromText, setFromText] = useState(defaultFrom);
  const [amountText, setAmountText] = useState("");
  const [balance, setBalance] = useState<BalanceRead | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [refresh, setRefresh] = useState(0);
  // The latest price Relay gave for this source, at any amount: what sizes the
  // agent's gas top-up, which Max sets aside.
  const [unitPrice, setUnitPrice] = useState<{ sourceId: SourceId; amountIn: bigint; amountInUsd: string | null } | null>(null);
  const [maxBusy, setMaxBusy] = useState(false);
  const [maxError, setMaxError] = useState("");
  const from = fromText.trim();
  const fromValid = from !== "" && isSourceAddress(source, from);
  const balanceKey = `${sourceId}:${from}`;
  const liveKey = useRef(balanceKey);
  liveKey.current = balanceKey;
  const amount = parseAmount(amountText, source.decimals);
  const quoteKey = amount !== null && amount > 0n ? `${sourceId}:${amount}:${refresh}` : null;

  // The source wallet's balance, for Max only. A stale answer for another
  // wallet or network never lands on this one.
  useEffect(() => {
    if (!fromValid) return;
    let live = true;
    setBalance({ key: balanceKey, value: null, done: false });
    void readSourceBalance(source, from, fetchImpl).then((value) => {
      if (live) setBalance({ key: balanceKey, value, done: true });
    });
    return () => { live = false; };
  }, [balanceKey, fromValid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Relay's price for exactly this amount on exactly this network, asked a
  // moment after typing stops. An answer for an older amount is dropped.
  useEffect(() => {
    if (quoteKey === null || amount === null) { setQuote(null); return; }
    let live = true;
    setQuote({ key: quoteKey, status: "loading" });
    const timer = setTimeout(() => {
      void requestRelayPrice({ source, amount, agent }, fetchImpl).then((parsed) => {
        if (!live) return;
        setQuote(parsed.ok ? { key: quoteKey, status: "ok", quote: parsed.quote } : { key: quoteKey, status: "error", reason: parsed.reason });
        if (parsed.ok) setUnitPrice({ sourceId: source.id, amountIn: parsed.quote.amountIn, amountInUsd: parsed.quote.amountInUsd });
      });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = quote && quote.key === quoteKey ? quote : null;
  const priced = current?.status === "ok" ? current.quote : null;
  const reserve = reserveFor(source, priced?.sourceNetworkFee ?? null);
  const read = fromValid && balance?.key === balanceKey ? balance : null;
  // The agent's top-up is a second transfer out of this same wallet, so Max
  // sets it aside whenever the panel will ask for it. Null: needed, but not
  // priced yet, and Max prices it when pressed.
  const agentGas = agentGasOf(balances?.ethWei, gasSponsored);
  const needsGas = agentGas.kind === "empty" || agentGas.kind === "unread";
  const priceHere = unitPrice?.sourceId === sourceId ? unitPrice : null;
  const gasAside = !needsGas ? 0n : priceHere ? amountForUsd(source, priceHere.amountIn, priceHere.amountInUsd) : null;
  const max = read?.done ? maxSendable(source, read.value, reserve + (gasAside ?? 0n)) : null;
  const onMax = async () => {
    if (!fromValid || !read?.done || read.value === null) return;
    const key = balanceKey;
    setMaxError("");
    setMaxBusy(true);
    try {
      // Read the wallet again: the owner may have sent from it on Relay, or
      // received into it, since the reading above. An answer for a wallet or
      // network changed meanwhile is dropped.
      const value = await readSourceBalance(source, from, fetchImpl);
      if (liveKey.current !== key) return;
      setBalance({ key, value, done: true });
      if (value === null) return; // the balance line now says Max is off, and why
      let aside = gasAside;
      if (aside === null) {
        const probe = value - reserve;
        if (probe <= 0n) {
          setMaxError("This wallet can't cover its own fee and your agent's gas top-up, so Max has nothing to send.");
          return;
        }
        const parsed = await requestRelayPrice({ source, amount: probe, agent }, fetchImpl);
        if (liveKey.current !== key) return;
        if (parsed.ok) {
          setUnitPrice({ sourceId: source.id, amountIn: parsed.quote.amountIn, amountInUsd: parsed.quote.amountInUsd });
          aside = amountForUsd(source, parsed.quote.amountIn, parsed.quote.amountInUsd);
        }
        if (aside === null) {
          setMaxError("Couldn't price your agent's gas top-up, so Max can't set it aside. Type an amount instead.");
          return;
        }
      }
      const result = maxSendable(source, value, reserve + aside);
      if (result.kind === "ok") setAmountText(formatAmount(result.amount, source.decimals, source.inputDecimals));
      else setMaxError(aside > 0n
        ? "This wallet can't cover its own fee and your agent's gas top-up, so Max has nothing to send."
        : "This wallet now holds no more than it needs for its own fee, so Max has nothing to send.");
    } finally {
      setMaxBusy(false);
    }
  };
  const tooMuch = amount !== null && read?.done && read.value !== null && amount > read.value;
  const intoReserve = !tooMuch && amount !== null && read?.done && read.value !== null && read.value - amount < reserve;
  const amountInvalid = amountText.trim() !== "" && amount === null;

  return (
    <div className="deposit-convert">
      {sources.length > 1 && (
        <div className="fund-presets deposit-sources" role="group" aria-label={`Where your ${source.asset} is`}>
          {sources.map((id) => (
            <button key={id} type="button" aria-pressed={id === sourceId} onClick={() => setSourceId(id)}>
              {DEPOSIT_SOURCES[id].network}
            </button>
          ))}
        </div>
      )}
      <label className="deposit-field">
        <span>Wallet you&apos;re sending from <em className="deposit-quiet">(optional, for Max)</em></span>
        <input
          value={fromText}
          onChange={(e) => setFromText(e.target.value)}
          placeholder={source.family === "evm" ? "0x…" : "Your Solana address"}
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
        />
      </label>
      <label className="deposit-field">
        <span>Amount of {source.asset} on {source.network}</span>
        <span className="deposit-amount">
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={amountInvalid || tooMuch ? true : undefined}
          />
          <button
            type="button"
            className="flow-secondary"
            disabled={max?.kind !== "ok" || maxBusy}
            onClick={() => void onMax()}
          >
            {maxBusy ? "…" : "Max"}
          </button>
        </span>
      </label>
      <p className="deposit-quiet">{balanceLine(source, from, fromValid, read)} {reserveLine(source, reserve, gasAside)}</p>
      {maxError && <p className="flow-error" role="alert">{maxError}</p>}
      {amountInvalid && <p className="flow-error" role="alert">Enter an amount like 0.05.</p>}
      {tooMuch && <p className="flow-error" role="alert">That is more than this wallet holds.</p>}
      {intoReserve && <p className="deposit-quiet" role="status">That leaves less than {formatAmount(reserve, source.decimals, source.inputDecimals)} {source.asset} in this wallet for its next fee.</p>}

      {current?.status === "loading" && <p className="deposit-quiet" role="status">Asking Relay for a price…</p>}
      {current?.status === "error" && (
        <div role="alert" className="deposit-refusal">
          <p>{current.reason}</p>
          <button type="button" className="flow-secondary" onClick={() => setRefresh((n) => n + 1)}>Try again</button>
        </div>
      )}
      {priced && <QuoteCard quote={priced} source={source} />}
      {priced && <AgentGasLine source={source} quote={priced} agent={agent} balances={balances} gasSponsored={gasSponsored} />}
      {priced && (
        <>
          <a
            className="flow-primary"
            href={relayDeepLink(source, priced.amountIn, agent)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onLeave(priced)}
          >
            Continue on Relay
          </a>
          <p className="deposit-quiet">You sign on relay.link with the wallet that holds your {source.asset}. Relay asks you to confirm the recipient: it should be your agent&apos;s account, ending {agent.slice(-4)}. Relay prices again when you sign, and its slippage starts on Auto: set Max Slippage to {source.slippageBps / 100}% or less. Merrymen never holds or moves these funds.</p>
          <button type="button" className="flow-secondary" onClick={() => setRefresh((n) => n + 1)}>Refresh price</button>
        </>
      )}
    </div>
  );
}

function balanceLine(source: DepositSource, from: string, fromValid: boolean, read: BalanceRead | null): string {
  if (from === "") return "Add the wallet you're sending from to use Max.";
  if (!fromValid) return source.family === "evm" ? "That isn't an Ethereum-style address (0x and 40 characters)." : "That isn't a Solana address.";
  if (!read || !read.done) return "Reading this wallet's balance…";
  if (read.value === null) return `Couldn't read this wallet's ${source.asset} on ${source.network}, so Max is off. Type an amount instead.`;
  return `This wallet holds ${formatAmount(read.value, source.decimals, source.inputDecimals)} ${source.asset} on ${source.network}.`;
}

/**
 * Relay's dollar figure through the app's one money formatter, so the symbol
 * sits where the owner's locale puts it. Truncated to whole cents first, so it
 * never shows more than Relay said. "<$0.01" for dust, nothing when Relay
 * gave no figure.
 */
function usd(text: string | null): string {
  const micros = usdMicrosOf(text);
  if (micros === null) return "";
  if (micros > 0n && micros < 10_000n) return `<${formatUsd(0.01)}`;
  return formatUsd(Number(micros / 10_000n) / 100);
}

function QuoteCard({ quote, source }: { quote: DepositQuote; source: DepositSource }) {
  const sent = usd(quote.amountInUsd);
  return (
    <dl className="fund-breakdown deposit-quote" aria-label="Relay's price">
      <div><dt>You send</dt><dd>{formatAmount(quote.amountIn, source.decimals, source.inputDecimals)} {source.asset} on {source.network}{sent && ` (about ${sent})`}</dd></div>
      <div><dt>Your agent gets</dt><dd>about {usdgText(quote.expectedOut)} USDG</dd></div>
      <div><dt>At least</dt><dd>{usdgText(quote.minOut)} USDG, or Relay refunds you</dd></div>
      <div><dt>Route</dt><dd>{quote.route}</dd></div>
      <div><dt>Fees</dt><dd>{quote.fees.length === 0 ? "none quoted" : quote.fees.map((f) => {
        const dollars = usd(f.usd);
        return `${f.label} ${formatAmount(f.amount, f.decimals, 6)} ${f.symbol}${dollars ? ` (${dollars})` : ""}`;
      }).join(" · ")}</dd></div>
      <div><dt>Slippage cap</dt><dd>{quote.slippageBps / 100}%</dd></div>
      {quote.impactPercent !== null && <div><dt>Price impact, fees included</dt><dd>{quote.impactPercent}%</dd></div>}
      <div className="fund-result"><dt>Arrives</dt><dd>{etaText(quote.etaSeconds)} after you sign</dd></div>
    </dl>
  );
}

/**
 * THE AGENT'S OWN FEES. A converted deposit is USDG, and USDG cannot pay for a
 * trade (live-blocker.ts, `no-gas`). So the panel asks for about $2 of ETH, but
 * only where the agent's ETH reads zero. Where that read failed, it says it
 * could not tell and offers the same top-up, rather than ask for money that may
 * already be there or keep quiet about a stall that may be coming.
 */
function AgentGasLine({ source, quote, agent, balances, gasSponsored }: {
  source: DepositSource; quote: DepositQuote; agent: string; balances?: GrantBalances; gasSponsored?: boolean | null;
}) {
  const gas = agentGasOf(balances?.ethWei, gasSponsored);
  if (gas.kind === "ok" || gas.kind === "sponsored") return null;
  const topup = amountForUsd(source, quote.amountIn, quote.amountInUsd);
  const why = gas.kind === "empty"
    ? "Your agent has no ETH, and every trade pays a network fee in ETH."
    : "We couldn't read your agent's ETH just now. If it has none, it can't pay for a trade.";
  if (source.relayChainId === ROBINHOOD_CHAIN_ID) {
    return <p className="fund-blocker deposit-gas" role="status">{why} Also send about {topup === null ? "$2 of ETH" : `${formatAmount(topup, source.decimals, source.inputDecimals)} ETH (about $2)`} straight to the same address on Robinhood Chain.</p>;
  }
  return (
    <p className="fund-blocker deposit-gas" role="status">
      {why} Add about $2 of ETH for its fees as a second, small transfer{topup === null ? "." : <>: <a href={relayDeepLink(source, topup, agent, "ETH")} target="_blank" rel="noopener noreferrer">{formatAmount(topup, source.decimals, source.inputDecimals)} {source.asset} → ETH on Relay</a>.</>}
    </p>
  );
}

/** What the agent's balance says about the deposit the owner left to sign. */
function ArrivalNote({ watch, current, now, onDone }: { watch: ArrivalWatch; current: bigint | null; now: () => number; onDone: () => void }) {
  const [, tick] = useState(0);
  const arrival = arrivalOf(watch, current, now());
  const settled = arrival.kind === "arrived";
  useEffect(() => {
    if (settled) return;
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [settled]);
  return (
    <section className="deposit-watch" aria-live="polite" aria-label="Deposit tracking">
      <p>{arrivalText(arrival, watch)}</p>
      {(arrival.kind === "late" || arrival.kind === "partial" || arrival.kind === "no-baseline") && (
        <a className="flow-secondary" href={RELAY_ACTIVITY_URL} target="_blank" rel="noopener noreferrer">Find your request on Relay</a>
      )}
      <button type="button" className="flow-secondary" onClick={onDone}>{settled ? "Done" : "Stop watching"}</button>
    </section>
  );
}

export function arrivalText(arrival: Arrival, watch: ArrivalWatch): string {
  const min = `${usdgText(watch.minOut)} USDG`;
  switch (arrival.kind) {
    case "arrived": return `Arrived: ${usdgText(arrival.rise)} USDG reached your agent.`;
    case "partial": return `Some USDG arrived (${usdgText(arrival.rise)}), less than the ${min} minimum. Your agent may have traded in the same minute, or this is a different transfer. Check your request on Relay.`;
    case "waiting": return `Watching for at least ${min} to reach your agent. Relay usually delivers within a minute of signing, and this balance refreshes on its own.`;
    case "late": return `Nothing has arrived after 15 minutes. If you signed on Relay, open your request there: a fill that doesn't complete is refunded to the wallet you sent from.`;
    case "unread": return `We couldn't read your agent's balance just now. That's our read failing, not your deposit. Still watching for ${min}.`;
    case "no-baseline": return `We couldn't read your agent's balance before you left, so we can't tell when this deposit lands.${arrival.current === null ? "" : ` Its balance now: ${usdgText(arrival.current)} USDG.`} Check your request on Relay.`;
  }
}

/**
 * The watch survives a reload of this tab for a day. A phone that drops a
 * background tab while the owner signs on Relay would otherwise come back to a
 * panel that forgot what it was waiting for. Session storage only: it never
 * leaves the browser, and a storage failure just means no memory.
 */
const WATCH_TTL_MS = 24 * 60 * 60_000;
function useWatch(agent: string, now: () => number): [ArrivalWatch | null, (next: ArrivalWatch | null) => void] {
  const key = `merrymen:deposit-watch:${agent.toLowerCase()}`;
  const [watch, setState] = useState<ArrivalWatch | null>(() => loadWatch(key, now()));
  const keyRef = useRef(key);
  keyRef.current = key;
  const set = useMemo(() => (next: ArrivalWatch | null) => {
    setState(next);
    try {
      if (next) sessionStorage.setItem(keyRef.current, JSON.stringify({ baseline: next.baseline?.toString() ?? null, minOut: next.minOut.toString(), openedAt: next.openedAt, arrived: next.arrived?.toString() ?? null }));
      else sessionStorage.removeItem(keyRef.current);
    } catch { /* no memory, no harm */ }
  }, []);
  return [watch, set];
}

function loadWatch(key: string, at: number): ArrivalWatch | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { baseline?: unknown; minOut?: unknown; openedAt?: unknown; arrived?: unknown };
    const digits = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
    const minOut = digits(parsed.minOut);
    const openedAt = typeof parsed.openedAt === "number" ? parsed.openedAt : NaN;
    if (minOut === null || !Number.isFinite(openedAt) || at - openedAt > WATCH_TTL_MS) return null;
    return { baseline: parsed.baseline === null ? null : digits(parsed.baseline), minOut, openedAt, arrived: digits(parsed.arrived) };
  } catch {
    return null;
  }
}
