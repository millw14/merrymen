// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// The most quote assets one vault will ever track.
//
// FILE-LEVEL SO BOTH CONTRACTS BOUND THE SAME SET WITH THE SAME NUMBER. The
// factory has to refuse a seed the vault would refuse, and Solidity will not
// let it read PonsClassVaultV2.MAX_QUOTES. Writing 8 in two places is how those
// two bounds drift apart, and a factory bounded looser than its vault is exactly
// the failure the factory constructor now exists to prevent.
uint256 constant MAX_QUOTE_ASSETS = 8;

import {IPonsCurve, IERC20Trade} from "./interfaces/IPonsCurve.sol";

/**
 * @title PonsClassVaultV2
 * @notice v1 with a PER-QUOTE spend ceiling in place of one global raw-unit cap.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS RATHER THAN A PATCH TO PonsClassVault.sol
 *
 * v1 charges `quoteIn` against ONE number (PonsClassVault.sol:193-207) sized for
 * USDG at 6dp (DEFAULT_SPEND_CAP = 250_000_000, PonsClassVault.sol:163). But
 * `quoteIn` is denominated in whatever asset funded the call, and the chain has
 * never restricted that: `_checkCurve` accepts any ERC-20 equal to the curve's
 * own pairToken(). The single thing pinning buys to USDG is off chain — the
 * wall's ONE_OF on word 1 (wall.ts:793). The moment a second quote is approved,
 * a $5 entry quoted in an 18dp share hands this contract ~2.8e16 raw and meets a
 * ceiling of 2.5e8: a refusal by eight orders of magnitude, in the one place
 * that cannot be fixed off chain.
 *
 * A ceiling must therefore be keyed by the asset it is denominated in. It must
 * NOT be made commensurable by scaling, because the only inputs that could scale
 * it are a price or an ERC-8056 uiMultiplier — data this contract is forbidden
 * to read at execution time, and data an attacker who chose the curve could
 * choose too. The translation from the owner's USD allowance to a raw count
 * happens ONCE, off chain, before the grant is signed. This file only compares
 * raw numbers to raw numbers for the same address.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS UNCHANGED FROM v1, AND MUST STAY UNCHANGED
 *
 * One immutable owner; no recipient argument anywhere; no admin, no pause, no
 * upgrade, no rescue-to-anywhere; native-quoted curves refused by name; the
 * curve NOT authenticated on chain (provenance lives in the worker's
 * factory-filtered knownCurves, so for the class case the chain is LOOSER than
 * the off-chain mirror); the vault holds no quote asset between calls. Read
 * PonsClassVault.sol's header for the full argument — it is still the argument.
 *
 * THE ADDRESS IS A FUNCTION OF (factory, owner) AND NOTHING ELSE. Caps live in
 * STORAGE and are seeded by the factory from its own set. They are deliberately
 * NOT constructor data the CALLER chooses, because anything a caller varies
 * varies the CREATE2 address — and a cap the owner later re-derives from a moved
 * price would then derive a DIFFERENT vault at the next re-sign, pin an empty
 * contract, and strand the open position in the old one. That is the no-exit
 * trap this contract family exists to remove, rebuilt in the name of a
 * commitment the wall already makes by pinning the address (wall.ts:775).
 *
 * NOT IN hardhat.config.ts's cancun overrides (contracts/hardhat.config.ts:15-28)
 * and must not be added to them: the re-entrancy flag below is a plain storage
 * bool exactly as v1's is (PonsClassVault.sol:227), so this compiles to the
 * default target like every non-transient contract here.
 */

contract PonsClassVaultV2 {
    /// @notice The smart account this vault belongs to. The only caller, and the
    /// only address any asset can ever be sent to.
    address public immutable owner;

    /**
     * @notice So off-chain code can never mistake a v1 vault for a v2 one.
     * @dev v1 has no such view, which is itself the discriminator: both answer
     * `owner()` identically, and recovery already calls `owner()` to confirm it
     * found the right contract (worker/src/recover.ts:853-859). This is what lets
     * the signer REFUSE a factory constant that still points at v1 rather than
     * seal a grant whose caps are a single global number.
     */
    uint8 public constant VAULT_VERSION = 2;

    /// @notice The window every quote's cap is measured over. ONE length for all
    /// of them: NVDA and SPY do not need different days, and a per-quote length
    /// would cost bits the packed slot below does not have.
    uint256 public constant SPEND_WINDOW = 1 days;

    /**
     * @notice The most quote assets this vault will ever track.
     *
     * A BOUND ON THE OWNER'S REAL EXPOSURE, which is the SUM of the caps and not
     * any one of them — a hostile curve can be stood up per quote so each budget
     * burns independently (wall.ts:706-714 concedes the curve is unpinnable). It
     * also keeps `approvedQuotes()` and the `_seal` scan below O(8) forever.
     */
    uint256 public constant MAX_QUOTES = MAX_QUOTE_ASSETS;

    /**
     * One quote asset's ceiling and its window, in ONE storage slot.
     *
     * 96 + 96 + 64 = 256 exactly, so a buy reads one cold slot and writes one
     * word. v1 read three separate slots (PonsClassVault.sol:159, :169, :170)
     * for one global bucket; this is one slot per quote. uint96 reaches 7.9e28 —
     * 7.9e22 USDG at 6dp, 7.9e10 whole shares at 18dp — and a cap that does not
     * fit is REFUSED by name rather than truncated, because a silently truncated
     * ceiling is a ceiling nobody agreed to.
     */
    struct QuoteLimit {
        /// Raw units of THIS EXACT quote address. Never a USD figure, never scaled.
        uint96 cap;
        /// Raw units already spent inside the current window.
        uint96 spent;
        /// Unix seconds. Zero until this quote's first buy, which reads as "rolled".
        uint64 windowStart;
    }

    /// @dev Private, with named views below. "What did I seal" and "what is left"
    /// are different facts, and one public getter would let "never approved" read
    /// as "exhausted" — the distinction `buy`'s two errors exist to preserve.
    mapping(address => QuoteLimit) private limits;

    /**
     * @dev Every quote this vault has ever been sealed for, in seal order.
     *
     * WRITTEN AT SEAL TIME, NEVER ON THE HOT PATH. A buy touches only the packed
     * slot above. This array exists so an owner can read `totalCapPerWindow()` —
     * the number they are actually risking per day — and so `approvedQuotes()`
     * can answer the /grant screen without a per-asset probe over the registry.
     * A removed quote (cap set to zero) STAYS here with a zero cap, so the array
     * never needs a delete-shuffle and its length is monotonic under MAX_QUOTES.
     */
    address[] private quotes;

    bool private inTrade;

    error NotOwner();
    error Reentrant();
    /// @notice The quote was never sealed into this vault. DISTINCT FROM
    /// SpendCapExceeded on purpose: one means "re-seal", the other means "wait",
    /// and a worker that cannot tell them apart retries the unfixable one for
    /// ever. `remaining == 0` is not a synonym for `never approved`.
    error QuoteNotApproved(address quoteAsset);
    error SpendCapExceeded(address quoteAsset, uint256 wanted, uint256 remaining);
    error CapTooLarge(address quoteAsset, uint256 cap);
    error ZeroCap(address quoteAsset);
    error DuplicateQuote(address quoteAsset);
    error ZeroQuote();
    error EmptySeed();
    error TooManyQuotes();
    error LengthMismatch();
    error Expired();
    error ZeroAmount();
    error ZeroOwner();
    error NotAContract();
    error NativeQuoteNotSupported();
    error CurveGraduated();
    error TokenDoesNotMatchCurve(address curveToken);
    error TransferFailed();
    error NoOutput();
    error InsufficientOutput(uint256 got, uint256 wanted);

    /// @notice Emitted for every sealed entry, INCLUDING the constructor's, so
    /// the approved set is reconstructible from logs from block zero.
    event QuoteCapSet(address indexed quoteAsset, uint256 cap);

    /**
     * @notice THE QUOTE ASSET IS NAMED, which v1's events did not do.
     *
     * v1 emitted (curve, token, quoteIn, tokensOut) — PonsClassVault.sol:223-224 —
     * and every off-chain reader took `quoteIn` for USDG at 6dp
     * (worker/src/venues/class-log.ts:166, worker/src/store.ts:793's `cost_usdg`).
     * With one quote that was true by the wall. With several it is false, and the
     * failure is silent: an NVDA-quoted $5 entry books as ~2.3e10 USDG spent.
     * Naming the asset is what lets the book refuse to add two denominations
     * together instead of adding them wrongly.
     *
     * Three indexed words is the EVM maximum alongside topic0, and it is spent
     * here rather than on an amount because a consumer filters by asset and reads
     * amounts.
     */
    event ClassBuy(
        address indexed curve, address indexed token, address indexed quoteAsset,
        uint256 quoteIn, uint256 tokensOut
    );
    event ClassSell(
        address indexed curve, address indexed token, address indexed quoteAsset,
        uint256 tokensIn, uint256 quoteOut
    );
    event Swept(address indexed token, uint256 amount);

    modifier only() {
        // The wall pins this contract as a target; this pins the caller. Both,
        // because a wall is a grant to ONE account and this vault holds ONE
        // account's assets — neither should be the only thing standing.
        if (msg.sender != owner) revert NotOwner();
        if (inTrade) revert Reentrant();
        inTrade = true;
        _;
        inTrade = false;
    }

    /**
     * @dev Set once by the factory at CREATE2 time; the salt is the owner, so the
     * address is derivable BEFORE deployment — which is what lets the wall pin it
     * as a literal `target` when the grant is signed.
     *
     * THE SEED ARGUMENTS COME FROM THE FACTORY'S OWN SET, NEVER FROM A CALLER,
     * and that is the whole address story. Constructor arguments are part of the
     * init code hash (v1 proves it at PonsClassVault.sol:407). Because the
     * factory supplies these two from a set fixed at its own construction,
     * `vaultFor(owner_)` closes over them and stays a ONE-ARGUMENT derivation:
     * no caller can vary them, so no caller can steer the address, and the whole
     * off-chain derivation — classvault.ts, both signers, the recovery ticket,
     * the no-grant path — needs no change at all.
     *
     * A FRESH VAULT CAN BUY IN ITS FIRST USER-OP, which is not a nicety: the
     * account deploys this contract inside the SAME batch as its first class buy
     * (worker/src/index.ts:7094) and a Kernel BATCH/DEFAULT op reverts whole, so
     * there is no second transaction to seal caps in. A vault that needed one
     * would have a first buy that always fails — and an owner transaction sent
     * to a not-yet-deployed vault would mine green and set nothing, because a
     * CALL to a codeless address succeeds with empty returndata.
     */
    constructor(address owner_, address[] memory seedQuotes, uint256[] memory seedCaps) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
        if (seedQuotes.length != seedCaps.length) revert LengthMismatch();
        // A vault with no quotes can buy nothing, for ever, and would announce
        // that only on the first canary. A mis-encoded seed fails HERE.
        if (seedQuotes.length == 0) revert EmptySeed();
        for (uint256 i; i < seedQuotes.length; ++i) {
            // Zero is refused at BIRTH but permitted in the setter below: a zero
            // in a birth list means the list was built wrong, while a zero from
            // the owner means "stop buying this now".
            if (seedCaps[i] == 0) revert ZeroCap(seedQuotes[i]);
            // Last-wins on a duplicate would seal a ceiling nobody chose.
            if (limits[seedQuotes[i]].cap != 0) revert DuplicateQuote(seedQuotes[i]);
            _seal(seedQuotes[i], seedCaps[i]);
        }
    }

    /**
     * @notice Raise, lower or remove what this vault may spend per window, per quote.
     *
     * OWNER ONLY — the smart account — and the wall grants the session key
     * exactly `buy` and `sell` on this target (wall.ts:772-812). SAY THE TRUE
     * THING ABOUT THAT ASYMMETRY: `owner` IS the account, so a compromised
     * session key's calls arrive as `msg.sender == owner` and this check stops a
     * stranger EOA and nothing more. What actually keeps this selector out of a
     * session key's reach is the wall not naming it — so that omission is pinned
     * by a wall test that enumerates this target's permitted selectors, not by
     * this comment. v1's header (PonsClassVault.sol:149-153) claimed the pin
     * existed before it did; it must exist before v2 is deployed.
     *
     * IT DOES NOT MOVE THE ADDRESS, which is the point: an owner may re-derive
     * their raw caps from a moved price as often as they like and the vault they
     * hold positions in stays the vault their wall pins.
     *
     * BATCH ONLY, no single-quote variant. A multi-quote allowance is edited as a
     * SET — the ruling's own example is four of them — and two transactions leave
     * a window where the owner's intent is half applied. One function is also one
     * thing the wall test has to prove ungranted.
     *
     * REMOVAL IS INSTANT AND THE WINDOW COUNTER IS NOT RESET. Zero refuses the
     * next buy in the same block; there is no timelock, because the reason an
     * owner reaches for this is that something is already wrong. And re-sealing
     * the same cap must not refill a spent window.
     */
    function setQuoteCaps(address[] calldata quoteAssets, uint256[] calldata caps) external {
        if (msg.sender != owner) revert NotOwner();
        if (quoteAssets.length != caps.length) revert LengthMismatch();
        for (uint256 i; i < quoteAssets.length; ++i) _seal(quoteAssets[i], caps[i]);
    }

    /// @dev ONE code path for the constructor and the setter, so validation cannot
    /// drift between what is sealed at birth and what is set later.
    function _seal(address q, uint256 cap) private {
        // address(0) is how a curve says "native ETH" (_checkCurve), so a cap for
        // it could never be charged. Refused rather than stored inert.
        if (q == address(0)) revert ZeroQuote();
        if (cap > type(uint96).max) revert CapTooLarge(q, cap);

        uint256 n = quotes.length;
        bool known;
        for (uint256 i; i < n; ++i) {
            if (quotes[i] == q) { known = true; break; }
        }
        // ZEROING AN ASSET THE VAULT NEVER KNEW IS A NO-OP, NOT A PURCHASE OF A
        // SLOT. Without this test the push happens before the cap is looked at,
        // so setQuoteCaps([X], [0]) on an unseen address consumes one of the
        // eight slots for ever — the array is append-only by design, so nothing
        // can free it again.
        //
        // That is not a contrived call. This setter takes a SET, deliberately,
        // and the natural off-chain screen sends the owner's whole quote
        // universe with the disabled ones at zero. A few edits with a different
        // asset disabled each time and the vault can never approve a real quote
        // again, in a contract with no admin and no upgrade.
        //
        // It also restores what MAX_QUOTES is documented to bound: assets that
        // have actually held a ceiling, and therefore the owner's real exposure.
        // Counting never-approved addresses would let TooManyQuotes fire at a
        // total exposure of one quote's cap.
        if (!known && cap == 0) {
            // Still emitted, so an owner who zeroed the wrong address sees that
            // the call did what they asked rather than nothing at all.
            emit QuoteCapSet(q, 0);
            return;
        }
        if (!known) {
            if (n >= MAX_QUOTES) revert TooManyQuotes();
            quotes.push(q);
        }
        // Only `cap` is written. `spent` and `windowStart` survive, deliberately.
        limits[q].cap = uint96(cap);
        emit QuoteCapSet(q, cap);
    }

    /// @notice The sealed ceiling for one quote, raw. ZERO MEANS REFUSED — the cap
    /// IS the allowlist, so there is no second list to fall out of sync with it.
    function quoteCap(address quoteAsset) external view returns (uint256) {
        return limits[quoteAsset].cap;
    }

    /**
     * @notice What may still be spent on this quote in the current window.
     *
     * READ `quoteCap` ALONGSIDE IT. An unapproved quote and an exhausted one both
     * answer zero here, and only the pair distinguishes them. The contract keeps
     * them apart where it counts — `buy` reverts with two different errors.
     */
    function spendRemaining(address quoteAsset) external view returns (uint256) {
        QuoteLimit memory l = limits[quoteAsset];
        if (l.cap == 0) return 0;
        if (block.timestamp >= uint256(l.windowStart) + SPEND_WINDOW) return l.cap;
        return l.spent >= l.cap ? 0 : uint256(l.cap) - uint256(l.spent);
    }

    /// @notice The whole slot, for an owner reconciling a vault against what they
    /// signed.
    function quoteLimit(address quoteAsset)
        external view returns (uint256 cap, uint256 spent, uint256 windowStart)
    {
        QuoteLimit memory l = limits[quoteAsset];
        return (l.cap, l.spent, l.windowStart);
    }

    /// @notice Every quote this vault has been sealed for, with its CURRENT cap.
    /// Entries with a zero cap are removed quotes and are shown as such.
    function approvedQuotes() external view returns (address[] memory assets, uint256[] memory caps) {
        assets = quotes;
        caps = new uint256[](assets.length);
        for (uint256 i; i < assets.length; ++i) caps[i] = limits[assets[i]].cap;
    }

    /**
     * @notice The worst case in one window, stated rather than left to be discovered.
     *
     * THIS IS THE NEW EXPOSURE PER-QUOTE CAPS BUY. The global cap was one number;
     * this is a SUM, and a hostile curve can be stood up per quote so each budget
     * burns independently. Across a window boundary it is 2x this, because the
     * window rolls rather than slides — the same deliberate weakness v1 documents
     * at PonsClassVault.sol:194-197. The figure an owner actually risks over a
     * grant is this number times the days remaining, because there is no on-chain
     * revocation and no on-chain repetition limit (PonsClassVault.sol:134-139:
     * RateLimitPolicy is codeless on 4663).
     *
     * It is a sum of RAW units across assets with different decimals, so it is a
     * bound to be read per asset via `approvedQuotes()`, not a currency figure.
     * The /grant screen converts; this contract does not.
     */
    function totalCapPerWindow() external view returns (uint256 total) {
        address[] memory a = quotes;
        for (uint256 i; i < a.length; ++i) total += limits[a[i]].cap;
    }

    /**
     * @dev Charge a buy against ONE quote's window, rolling it forward when it has
     * passed. Called before the pull and before the approve, exactly as v1 charged.
     *
     * ROLLED, NOT SLIDING, AND PER QUOTE. A sliding window needs per-call history
     * and the gas to walk it. Per-quote starts are what make the slot pack; a
     * shared window would need an epoch counter and a second write to buy a bound
     * that is identical, since an attacker aligns boundaries either way. Size a
     * cap at half what you would tolerate losing in a day and the two-window worst
     * case is the number you already agreed to.
     */
    function _chargeSpend(address quoteAsset, uint256 quoteIn) private {
        QuoteLimit memory l = limits[quoteAsset];
        if (l.cap == 0) revert QuoteNotApproved(quoteAsset);

        bool rolled = block.timestamp >= uint256(l.windowStart) + SPEND_WINDOW;
        uint256 spent = rolled ? 0 : uint256(l.spent);
        // SATURATING, not a subtraction. The owner may lower a cap below what this
        // window has already spent — that is the panic button working — and an
        // unguarded `cap - spent` would panic instead of refusing by name.
        uint256 remaining = uint256(l.cap) > spent ? uint256(l.cap) - spent : 0;
        if (quoteIn > remaining) revert SpendCapExceeded(quoteAsset, quoteIn, remaining);

        // One whole-word write, whether or not the window rolled. `spent + quoteIn`
        // is <= cap <= type(uint96).max by the check above, so the cast is safe.
        limits[quoteAsset] = QuoteLimit({
            cap: l.cap,
            spent: uint96(spent + quoteIn),
            windowStart: rolled ? uint64(block.timestamp) : l.windowStart
        });
    }

    /**
     * @notice Buy a class token with an APPROVED quote asset, and KEEP it here.
     * @dev Signature, selector and word order are IDENTICAL to v1's, so
     * PONS_CLASS_VAULT_ABI (abis.ts:207-233) and the wall's positional pins on
     * this call need no rework. Only the charge changed.
     */
    function buy(
        address curve,
        address quoteAsset,
        uint256 quoteIn,
        uint256 minTokensOut,
        uint256 deadline
    ) external only returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();
        // BEFORE the pull and before the approve, exactly as v1: the ceiling has
        // to bind before anything leaves the account, not after the curve returns.
        //
        // KEYED ON `quoteAsset`, which is the same word `_pull` moves and the
        // same word `_checkCurve` proves equal to the curve's own pairToken(). So
        // the cap cannot be charged against one asset while a different one is
        // spent. The FULL quoteIn is charged even when the curve pulls less and
        // the residue goes home — a ceiling should over-charge, not under-charge.
        _chargeSpend(quoteAsset, quoteIn);
        address token = _checkCurve(curve, quoteAsset);

        // MEASURED, NOT TRUSTED. A balance delta on this contract, never a number
        // the untrusted curve returns.
        uint256 before = IERC20Trade(token).balanceOf(address(this));

        _pull(quoteAsset, owner, address(this), quoteIn);
        _approve(quoteAsset, curve, quoteIn);
        IPonsCurve(curve).buy(quoteIn, minTokensOut, address(this));
        _approve(quoteAsset, curve, 0);

        uint256 residue = IERC20Trade(quoteAsset).balanceOf(address(this));
        if (residue > 0) _push(quoteAsset, owner, residue);

        tokensOut = IERC20Trade(token).balanceOf(address(this)) - before;
        if (tokensOut == 0) revert NoOutput();
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        emit ClassBuy(curve, token, quoteAsset, quoteIn, tokensOut);
    }

    /**
     * @notice Sell a class token this vault holds, paying the owner directly.
     *
     * IT CONSULTS NEITHER THE CAP NOR THE APPROVED SET, AND MUST NEVER LEARN TO.
     * That is the entire exit guarantee. A membership check here would mean that
     * un-approving a quote strands every position entered in it — the no-exit
     * trap this contract family exists to remove, rebuilt in the name of
     * tidiness. If a reviewer ever adds `if (limits[quoteAsset].cap == 0) revert`
     * to this function, v2 is worse than v1.
     */
    function sell(
        address curve,
        uint256 tokensIn,
        uint256 minQuoteOut,
        uint256 deadline
    ) external only returns (uint256 quoteOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        address quoteAsset = IPonsCurve(curve).pairToken();
        address token = _checkCurve(curve, quoteAsset);

        uint256 before = IERC20Trade(quoteAsset).balanceOf(owner);

        _approve(token, curve, tokensIn);
        IPonsCurve(curve).sell(tokensIn, minQuoteOut, owner);
        _approve(token, curve, 0);

        quoteOut = IERC20Trade(quoteAsset).balanceOf(owner) - before;
        if (quoteOut == 0) revert NoOutput();
        if (quoteOut < minQuoteOut) revert InsufficientOutput(quoteOut, minQuoteOut);
        emit ClassSell(curve, token, quoteAsset, tokensIn, quoteOut);
    }

    /**
     * @notice THE UNCONDITIONAL EXIT. No cap, no approved set, no curve.
     *
     * @dev MEASURED, NOT TRUSTED — the rule buy and sell already keep, and the one
     * place v1 did not. v1 emitted the balance it read BEFORE the transfer
     * (PonsClassVault.sol:331-336), and _push proves only that the call did not
     * revert and did not return false. A token whose transfer returns true and
     * moves nothing — an ordinary soft honeypot on a launchpad minting hundreds
     * of curves an hour, and precisely the asset this vault exists to hold —
     * would emit a full-size withdrawal for tokens that never left. A clamping
     * token would emit one per attempt, and the off-chain fold sums them: five
     * partial sweeps of a 500-unit position book 1,500 as withdrawn, and the
     * owner is told they took home three times the capital they put in.
     *
     * So the amount is the OWNER'S delta. A sweep that moves nothing reverts by
     * name instead of succeeding for ever, and the event says what arrived.
     *
     * The exit itself is unchanged and must stay so: one destination, fixed at
     * construction, consulting neither cap nor approved set. Un-approving a quote
     * must never strand a position entered in it.
     */
    function sweep(address token) external only returns (uint256 amount) {
        uint256 held = IERC20Trade(token).balanceOf(address(this));
        if (held == 0) revert ZeroAmount();
        uint256 beforeOwner = IERC20Trade(token).balanceOf(owner);
        _push(token, owner, held);
        amount = IERC20Trade(token).balanceOf(owner) - beforeOwner;
        // NOT ZeroAmount, which above means "there was nothing to sweep". This
        // means "there was something and it did not arrive", and a caller that
        // cannot tell those apart retries the one that will never work.
        if (amount == 0) revert TransferFailed();
        emit Swept(token, amount);
    }

    // ── Below here is PonsClassVault.sol:346-379 verbatim. Restated rather than
    //    inherited because v1's bytecode is frozen at 0x48a5…ab3d and a shared
    //    base would change it; copied rather than re-derived because re-deriving
    //    is how two versions drift apart. Any change here is a change to both.

    function _checkCurve(address curve, address quoteAsset) private view returns (address token) {
        if (curve.code.length == 0) revert NotAContract();
        address curveQuote = IPonsCurve(curve).pairToken();
        if (curveQuote == address(0)) revert NativeQuoteNotSupported();
        if (curveQuote != quoteAsset) revert TokenDoesNotMatchCurve(curveQuote);
        if (IPonsCurve(curve).graduated()) revert CurveGraduated();
        token = IPonsCurve(curve).token();
        if (token == address(0) || token == quoteAsset) revert TokenDoesNotMatchCurve(token);
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transferFrom, (from, to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transfer, (to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        if (amount != 0) {
            (bool zeroOk, ) = token.call(abi.encodeCall(IERC20Trade.approve, (spender, 0)));
            zeroOk; // a token that refuses the zeroing may still accept the set
        }
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.approve, (spender, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }
}

/**
 * @title PonsClassVaultFactoryV2
 * @notice CREATE2 deployer for v2 vaults. Same salt, same ABI, new bytecode.
 *
 * THE SALT IS STILL THE OWNER, not keccak(owner, version) and not
 * keccak(owner, caps). The creationCode already differs from v1's and this
 * factory is a different address, so a v2 vault lands somewhere else by
 * construction. Versioning or cap-salting would add nothing and would cost
 * three things: `vaultFor` gains an argument (so classvault.ts:38-46,
 * session.ts:461, signGrant.ts:173 and ticket/route.ts:121 all change in
 * lockstep or the two signers pin different vaults), the wall's `deploy`
 * permission gains a word it cannot pin (wall.ts:827-831 pins exactly one), and
 * "one owner, one vault, second deploy reverts" stops being true per factory.
 *
 * THE ABI IS DELIBERATELY IDENTICAL to v1's `deploy(address)` /
 * `vaultFor(address) view`, so PONS_CLASS_VAULT_FACTORY_ABI (classvault.ts:38-46)
 * and PONS_CLASS_VAULT_FACTORY_DEPLOY_ABI (abis.ts:259-267) are reused byte for
 * byte and the note at abis.ts:256-257 stays true. The cost of that convenience
 * is that a v1 address sitting in the v2 slot answers plausibly instead of
 * reverting — which is exactly what VERSION and `vaultInitCodeHash` exist to
 * catch, asserted by the deploy script and again by the signer.
 *
 * DEPLOYMENT STAYS PERMISSIONLESS AND IDEMPOTENT-BY-REVERT, and v1's argument
 * (PonsClassVault.sol:393-396) survives verbatim BECAUSE the caps are not in the
 * initcode: a griefer can at worst pay to create the vault the owner was going
 * to create anyway, carrying this factory's seed and the owner's own salt.
 */
contract PonsClassVaultFactoryV2 {
    uint8 public constant FACTORY_VERSION = 2;

    /// @dev Fixed at this factory's own construction; there is no setter. Storage
    /// rather than `immutable` only because Solidity has no immutable arrays —
    /// read it as immutable, and note that `vaultFor` being `view` over it is
    /// what keeps the address prediction a pure function of `owner_`.
    address[] private seedQuotes;
    uint256[] private seedCaps;

    event VaultDeployed(address indexed owner, address vault);

    error LengthMismatch();
    error EmptySeed();
    error ZeroSeedQuote();
    error ZeroSeedCap();
    error TooManySeedQuotes();
    error DuplicateSeedQuote(address quoteAsset);
    error SeedCapTooLarge(address quoteAsset, uint256 cap);

    /**
     * @dev EVERY RULE THE VAULT CONSTRUCTOR KEEPS, KEPT HERE TOO.
     *
     * This validated a strict SUBSET of what the vault validates, and the
     * difference is the worst failure this contract can have. The stored arrays
     * are passed verbatim to every vault, so a seed that trips a rule only the
     * vault enforces constructs a factory that then reverts inside deploy for
     * EVERY owner, for ever — with no setter and no admin to correct it.
     *
     * Nothing downstream catches it, which is what makes it worth the O(64)
     * loop. FACTORY_VERSION answers 2. vaultFor answers a well-formed non-zero
     * address. vaultInitCodeHash matches the compiled artifact exactly — it
     * must, since the bytecode is correct and only the constructor ARGUMENTS are
     * poisoned, and the checker hashes those same arrays. seedQuoteSet answers
     * without complaint. A factory that can never make a vault passes every gate
     * the system has, gets written into a constant, and is sealed into grants
     * before anything exercises deploy.
     *
     * One typo reaches it: a duplicated symbol in the deploy script's seed.
     */
    constructor(address[] memory quotes_, uint256[] memory caps_) {
        if (quotes_.length != caps_.length) revert LengthMismatch();
        // A factory with no seed mints vaults that can buy nothing, whose first
        // class trade reverts after the approve has already landed.
        if (quotes_.length == 0) revert EmptySeed();
        if (quotes_.length > MAX_QUOTE_ASSETS) revert TooManySeedQuotes();
        for (uint256 i; i < quotes_.length; ++i) {
            if (quotes_[i] == address(0)) revert ZeroSeedQuote();
            if (caps_[i] == 0) revert ZeroSeedCap();
            if (caps_[i] > type(uint96).max) revert SeedCapTooLarge(quotes_[i], caps_[i]);
            for (uint256 j; j < i; ++j) {
                if (quotes_[j] == quotes_[i]) revert DuplicateSeedQuote(quotes_[i]);
            }
        }
        seedQuotes = quotes_;
        seedCaps = caps_;
    }

    /**
     * @notice The caps every vault from this factory is born with.
     * @dev READ BY THE SIGNER, not just by operators: the wall's ONE_OF on the
     * class buy's quote word must equal this set, or the wall permits a quote the
     * vault refuses (a wasted op) or names one it does not cover.
     */
    function seedQuoteSet() external view returns (address[] memory assets, uint256[] memory caps) {
        return (seedQuotes, seedCaps);
    }

    /// @notice Create this owner's vault. Permissionless; a second deploy for the
    /// same owner reverts on the CREATE2 collision.
    function deploy(address owner_) external returns (address vault) {
        vault = address(
            new PonsClassVaultV2{salt: bytes32(uint256(uint160(owner_)))}(owner_, seedQuotes, seedCaps)
        );
        emit VaultDeployed(owner_, vault);
    }

    /**
     * @notice The address `deploy(owner_)` will produce. Callable before it exists.
     * @dev ONE ARGUMENT, AND IT MUST STAY THAT WAY. The two extra constructor
     * words come from this contract's own set — the same values `deploy` passes —
     * so prediction and production cannot disagree even in principle, and no
     * caller can steer the address. This is the property the wall depends on to
     * pin a contract that does not exist yet (wall.ts:775).
     */
    function vaultFor(address owner_) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            bytes32(uint256(uint160(owner_))),
            vaultInitCodeHash(owner_)
        )))));
    }

    /**
     * @notice The init code hash this factory will CREATE2 with, for `owner_`.
     * @dev PROVING THE FACTORY IS WHAT IT CLAIMS, independently of its name and of
     * any registry constant. FACTORY_VERSION is a number a wrong contract could
     * also return; this is the bytecode. The deploy script asserts it against the
     * locally compiled artifact — the only check that would catch a factory built
     * from a different commit.
     */
    function vaultInitCodeHash(address owner_) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            type(PonsClassVaultV2).creationCode,
            abi.encode(owner_, seedQuotes, seedCaps)
        ));
    }
}
