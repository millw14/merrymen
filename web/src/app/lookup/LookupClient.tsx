"use client";

/**
 * Paste an address, see what it holds. No key, no login, nothing to sign.
 *
 * WHY THE PAGE LOOKS LIKE THIS. The question behind almost every "I am locked
 * out" message is not "how do I withdraw" but "is my money still there, and
 * which of these addresses is my agent". Those are two different questions and
 * only the second one is hard, because there are three addresses in this system
 * and nothing has ever told people which is which. So the answer comes first,
 * in a sentence, and the balances come after it.
 *
 * NOTHING HERE CAN SPEND. `readAsOwner` builds its owner with
 * `ownerFromAddress`, whose signing methods throw by construction, so this page
 * could not authorise a transfer even if someone asked it to.
 */

import { useState } from "react";
import { formatUnits } from "viem";
import { isAddr, normalizeAddr } from "@/lib/address";
import { chainFor, readAddress, readAsOwner, verdictOf, type Lookup, type Reading } from "@/lib/account-lookup";
import { robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import "@/styles/lookup.css";

const MAINNET = robinhoodChain.id;
const TESTNET = robinhoodTestnet.id;

const fmtEth = (wei: bigint | null) => (wei === null ? "unreadable" : `${formatUnits(wei, 18)} ETH`);

function ReadingCard({
  title,
  note,
  reading,
  extra,
}: {
  title: string;
  note: string;
  reading: Reading;
  extra?: { label: string; rows: { symbol: string; amount: string }[] };
}) {
  const nothing = reading.holdings.length === 0 && (reading.nativeWei === null || reading.nativeWei === 0n);
  return (
    <div className="mm-lookup-card">
      <h3>{title}</h3>
      <p className="mm-lookup-addr">{reading.address}</p>
      <p className="mm-lookup-meta">
        {note}
        {" · "}
        {reading.deployed === null
          ? "deployment unknown"
          : reading.deployed
            ? "contract deployed"
            : "not deployed"}
      </p>

      {nothing && !extra?.rows.length ? (
        <p className="mm-lookup-none">Nothing held here.</p>
      ) : (
        <div className="mm-lookup-rows">
          {reading.holdings.map((h) => (
            <div className="mm-lookup-row" key={h.address}>
              <span>{h.symbol}</span>
              <span>{h.amount}</span>
            </div>
          ))}
          {reading.nativeWei !== null && reading.nativeWei > 0n && (
            <div className="mm-lookup-row">
              <span>ETH (gas)</span>
              <span>{fmtEth(reading.nativeWei)}</span>
            </div>
          )}
          {extra?.rows.map((r) => (
            <div className="mm-lookup-row" key={`${extra.label}-${r.symbol}`}>
              <span>
                {r.symbol} <em>{extra.label}</em>
              </span>
              <span>{r.amount}</span>
            </div>
          ))}
        </div>
      )}

      {reading.unreadable.length > 0 && (
        <p className="mm-lookup-warn">
          Could not read: {reading.unreadable.join(", ")}. That is not the same as empty — the chain did
          not answer, so this list is incomplete. Try again before concluding anything.
        </p>
      )}
    </div>
  );
}

/**
 * The sentence, decided by `verdictOf` and only rendered here.
 *
 * The distinction that matters most is the last one: an address that derives an
 * account which was never deployed is almost always someone's SIGN-IN wallet,
 * not their owner key — and telling them that is the whole reason this page
 * exists.
 */
function Verdict({ l }: { l: Lookup }) {
  const v = verdictOf(l);
  const derived = l.asOwner?.derived;

  if (v.kind === "both" || v.kind === "owner") {
    return (
      <div className="mm-lookup-verdict">
        <h2>This looks like an owner address.</h2>
        <p>
          It controls the account <code>{derived}</code>, and that account holds what is listed below.
        </p>
        <p>
          To move it you need the private key for <code>{l.input}</code> — the recovery key you saved
          when the agent was created. Run <code>npx merrymen recover</code> and paste it there.
        </p>
      </div>
    );
  }

  if (v.kind === "account") {
    return (
      <div className="mm-lookup-verdict">
        <h2>This looks like an agent account.</h2>
        <p>The smart account itself, holding what is listed below.</p>
        <p>
          A smart account cannot sign for itself — moving these funds needs its OWNER key, which is a
          different address. That is the recovery key you were shown once when the agent was created.
        </p>
      </div>
    );
  }

  if (v.kind === "unreadable") {
    return (
      <div className="mm-lookup-verdict is-quiet">
        <h2>The chain did not answer.</h2>
        <p>
          Some balances could not be read, so nothing here should be taken as “empty”. Try again in a
          moment, or switch chain if the agent is on the other one.
        </p>
      </div>
    );
  }

  if (v.kind === "empty-deployed") {
    return (
      <div className="mm-lookup-verdict is-quiet">
        <h2>This account exists, and is empty.</h2>
        <p>
          There is a contract deployed here, so it has been used — the balances are genuinely zero
          rather than never created. Funds have already moved out, or the agent is on the other chain.
        </p>
      </div>
    );
  }

  // Nothing, and nothing deployed either — the case that sends people looking
  // for a support backdoor that does not exist.
  return (
    <div className="mm-lookup-verdict is-quiet">
      <h2>Nothing was ever created from this address.</h2>
      <p>
        Read as an owner it derives <code>{derived}</code>, which has no contract and no balance; read
        as an account it holds nothing either.
      </p>
      <p>
        This is usually a <strong>sign-in wallet</strong> — the wallet you logged in with identifies
        you, but it was never your agent&rsquo;s owner. A legacy agent&rsquo;s owner key was generated
        in your browser and shown once as the <strong>recovery key</strong>. Look for that, or open the
        wallet screen in the same browser profile you created the agent in, where it can still be
        revealed.
      </p>
    </div>
  );
}

export function LookupClient() {
  const [value, setValue] = useState("");
  // Widened deliberately: `useState(MAINNET)` infers the literal 4663, and the
  // testnet radio then fails to typecheck against its own state setter.
  const [chainId, setChainId] = useState<number>(MAINNET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Lookup | null>(null);
  // The verdict needs BOTH readings. Rendering it while one is still in flight
  // would tell someone "nothing was ever created here" about an account whose
  // balance is still loading, which is the single worst sentence to get wrong.
  const [settled, setSettled] = useState(false);

  /**
   * The two readings run SEPARATELY and render as they land.
   *
   * Awaiting both took about thirty seconds on chain 4663, because deriving an
   * account also scans for a class vault over a very large block range. Someone
   * who pasted their account address watched a spinner for half a minute to see
   * a balance that had been ready in two — and a page for people who think
   * their money is gone is the worst possible place to look broken.
   */
  async function run() {
    const addr = normalizeAddr(value);
    if (!isAddr(addr)) {
      setError("That is not an address. Paste a 0x address, 42 characters.");
      return;
    }
    const address = addr as `0x${string}`;
    setBusy(true);
    setError(null);
    setResult(null);
    setSettled(false);

    let chain;
    try {
      chain = chainFor(chainId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }

    const base: Lookup = {
      input: address,
      chainId,
      asOwner: null,
      ownerError: null,
      asAccount: null,
      accountError: null,
    };
    setResult(base);

    // Merged into whatever is already on screen, so the slower half cannot
    // clobber the faster one when it finally arrives.
    const merge = (patch: Partial<Lookup>) =>
      setResult((prev) => ({ ...(prev ?? base), ...patch }));

    const direct = readAddress(chain, address)
      .then((asAccount) => merge({ asAccount }))
      .catch((e: unknown) => merge({ accountError: e instanceof Error ? e.message.split("\n")[0]! : String(e) }));

    const owner = readAsOwner(chain, address)
      .then((asOwner) => merge({ asOwner }))
      .catch((e: unknown) => merge({ ownerError: e instanceof Error ? e.message.split("\n")[0]! : String(e) }));

    await Promise.all([direct, owner]);
    setSettled(true);
    setBusy(false);
  }

  return (
    <div className="mm mm-lookup">
      <div className="mm-lookup-inner">
        <p className="mm-lookup-brand">merrymen</p>
        <h1>What is in this account?</h1>
        <p className="mm-lookup-lede">
          Paste any address — your agent&rsquo;s account, or the owner it was created from — and this
          reads the chain and tells you which one it is and what it holds. No sign-in, no key, and
          nothing here can move funds.
        </p>

        <div className="mm-lookup-form">
          <input
            className="mm-lookup-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Address to look up"
          />
          <button className="mm-lookup-btn" onClick={() => void run()} disabled={busy}>
            {busy ? "reading the chain…" : "look it up"}
          </button>
        </div>

        <div className="mm-lookup-chain">
          <label>
            <input type="radio" checked={chainId === MAINNET} onChange={() => setChainId(MAINNET)} />
            mainnet · {MAINNET}
          </label>
          <label>
            <input type="radio" checked={chainId === TESTNET} onChange={() => setChainId(TESTNET)} />
            testnet · {TESTNET}
          </label>
        </div>

        {error && <p className="mm-lookup-error">{error}</p>}

        {result && (
          <>
            {settled ? (
              <Verdict l={result} />
            ) : (
              <p className="mm-lookup-meta">reading the chain — the owner derivation scans for a class vault and can take about half a minute.</p>
            )}

            {result.asOwner && (
              <ReadingCard
                title="Read as an owner → the account it derives"
                note="the ERC-4337 account this address controls"
                reading={result.asOwner.reading}
                {...(result.asOwner.classHoldings.length > 0
                  ? {
                      extra: {
                        label: "in class vault",
                        rows: result.asOwner.classHoldings.map((h) => ({ symbol: h.symbol, amount: h.amount })),
                      },
                    }
                  : {})}
              />
            )}
            {result.ownerError && (
              <p className="mm-lookup-warn">Could not derive an account from this address: {result.ownerError}</p>
            )}

            {result.asAccount && (
              <ReadingCard
                title="Read as an account → the address itself"
                note="balances held directly at this address"
                reading={result.asAccount}
              />
            )}
            {result.accountError && (
              <p className="mm-lookup-warn">Could not read this address directly: {result.accountError}</p>
            )}
          </>
        )}

        <div className="mm-lookup-help">
          <h2>Three addresses people mix up</h2>
          <dl>
            <dt>The wallet you sign in with</dt>
            <dd>
              Identity only. It says which agent is yours; it has never controlled the funds, and
              reconnecting it does not give you custody.
            </dd>
            <dt>The owner key</dt>
            <dd>
              What actually controls the account. For a legacy agent this was generated in your browser
              and shown once as the <strong>recovery key</strong> — it is not your sign-in wallet.
            </dd>
            <dt>The agent account</dt>
            <dd>
              The smart account that holds the money. It is an ERC-4337 contract, not a normal wallet,
              so importing the owner key into MetaMask shows an <em>empty</em> wallet — the key derives
              a different address from the account.
            </dd>
          </dl>
          <p>
            With the recovery key, <code>npx merrymen recover</code> sweeps the account to any wallet
            you name. It runs on your machine and the key never leaves it. The key is never sent to our
            servers, so if it is lost and the browser profile that created it is gone, nobody can
            recover the account — including us.
          </p>
        </div>
      </div>
    </div>
  );
}
