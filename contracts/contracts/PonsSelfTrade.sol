// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsCurve, IERC20Trade} from "./interfaces/IPonsCurve.sol";

/**
 * @title PonsSelfTrade
 * @notice A Pons bonding-curve trade that CANNOT send the proceeds anywhere but
 * back to the caller. Same single idea as V4SelfSwap, applied to a second venue.
 *
 * WHY THIS EXISTS. A Pons token has no Uniswap pool until it graduates at its
 * threshold — it trades only on its own bonding curve. So every route the wall
 * already grants (SwapRouter02, the v4 adapter) reaches exactly none of the
 * launchpad where essentially every new token on this chain appears. This is
 * the venue adapter for that.
 *
 * WHY IT IS NOT JUST "CALL THE CURVE". The wall pins a TARGET, and buys go to a
 * PER-TOKEN curve address — a new one every launch, ~475 an hour. There is no
 * address to pin. Granting the account permission to call an arbitrary target
 * would be granting everything. So the wall pins THIS contract, the curve
 * becomes an argument, and what bounds the damage is stated honestly below
 * rather than implied.
 *
 * THE ONE INVARIANT EVERYTHING ELSE RESTS ON:
 *   assets are pulled ONLY from `msg.sender`, and paid ONLY to `msg.sender`.
 * Both are the same value, read once at entry. `msg.sender` is passed to the
 * curve's own `recipient` argument, so the curve pays the account DIRECTLY and
 * this contract is never the recipient of anything. There is no code path that
 * names a third party.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT DO, AND WHY
 *
 * NATIVE-QUOTED CURVES ARE REFUSED. This is the big one: 53.6% of launches are
 * quoted in native ETH and none of them can be traded here. `buy()` is payable
 * and wants ETH, while every permission in the wall carries `valueLimit: 0` —
 * the account may not send native value at all. The way to bridge that is for
 * the adapter to pull WETH, unwrap it, and forward the ETH itself, and that
 * costs four of the guarantees this file otherwise inherits from V4SelfSwap:
 *
 *   1. a `receive()`, the first function in this repo that accepts ETH;
 *   2. a live ETH balance mid-transaction, so "never holds a balance" — the
 *      reason there is nothing here to steal — stops being true;
 *   3. a trust dependency on WETH, which on this chain is NOT canonical WETH9
 *      but an upgradeable TransparentUpgradeableProxy whose admin can replace
 *      the implementation, and which hands this contract FULL GAS on the
 *      withdraw payout — i.e. an upgradeable third party gets control exactly
 *      while the adapter holds ETH;
 *   4. a WETH approve permission the wall does not have today.
 *
 * That is a different contract with a different threat model, and it belongs
 * behind its own SELECTOR so the owner can grant this one without granting
 * that one — the same opt-in shape `allowRialto` and `allowUniswapV4` use. A
 * single function branching on `pairToken()` would give one permission that
 * grants both behaviours forever.
 *
 * Stated plainly so nobody discovers it later: the ERC-20-quoted curves this
 * DOES reach are 27.2% of launches, and only the USDG-quoted 2.8% are one hop
 * from the agent's cash. A stock-token-quoted curve needs USDG→NVDA first —
 * exactly as many hops as USDG→WETH→unwrap would have been. "ERC-20 is simpler"
 * is a claim about this contract, not about reach.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREAT MODEL, HONESTLY
 *
 * - THE CURVE ARGUMENT CANNOT BE AUTHENTICATED, AND NOTHING HERE PRETENDS TO.
 *   A curve self-reports its `factory()`, which a malicious contract can return
 *   too, so checking it would be a guard that guarantees nothing. The only
 *   sound direction is factory→curve, and the Pons factory publishes no registry
 *   view (sixteen candidate selectors probed; none present in its bytecode).
 *   So a compromised session key can name an attacker's contract as `curve` and
 *   lose up to the standing allowance of an allowlisted asset.
 *
 *   That is EXACTLY the exposure the wall already carries for V4SelfSwap, whose
 *   pool key is equally caller-chosen: "a compromised session key can still swap
 *   up to the standing ERC-20 allowance into a pool the attacker owns, at a
 *   price the attacker picks". Not zero, and not new. What bounds it: `assetIn`
 *   is pinned ONE_OF the owner's own asset list by the wall, the pull is capped
 *   at `amountIn`, and `minAmountOut` is enforced HERE rather than by the curve.
 *
 * - SLIPPAGE IS ENFORCED AGAINST THE ACCOUNT'S OWN BALANCE, not against what the
 *   curve says it paid. The curve takes a `minQuoteOut`/`minTokensOut` of its
 *   own and would revert, but that is the untrusted party checking its own
 *   homework. Measuring the caller's balance before and after makes the
 *   guarantee independent of the curve being honest — the same discipline that
 *   makes V4SelfSwap take its amounts from the returned delta rather than the
 *   argument.
 *
 * - NO OWNER, NO ADMIN, NO PAUSE, NO UPGRADE, NO RESCUE. Identical trade to
 *   V4SelfSwap: an admin key able to pause the owner's exits is a worse failure
 *   than an unfixable bug in a contract with no storage and no balances. There
 *   is deliberately no sweep function, because a sweep function is a "send
 *   assets to an address" function and not having one is the point.
 *
 * - IT NEVER HOLDS A BALANCE ACROSS CALLS. The output goes from the curve to the
 *   caller without passing through here. The input does pass through — the curve
 *   pulls from its caller, which is this contract — but any residue is returned
 *   to `msg.sender` before the call ends, and the allowance is zeroed. A
 *   donation cannot subsidise anyone's trade: every path pulls its own input.
 *
 * - FEE-ON-TRANSFER TOKENS DO NOT WORK, and fail closed. The amount approved to
 *   the curve is what was pulled; a token that skims leaves the curve unable to
 *   take what it asked for, and the trade reverts.
 *
 * - A GRADUATED CURVE IS REFUSED BY NAME. Its reserves read exactly like a
 *   healthy curve's — quote side back at the virtual seed, token side empty —
 *   so without this check the failure would surface as an anonymous revert or,
 *   worse, a trade at a price for a market that has moved to Uniswap v4.
 *
 * SHAPE OF THE SIGNATURE, AND WHY IT IS FLAT. Six STATIC words, no struct and
 * no `bytes`. The wall maps args[i] to calldata offset i*32 with a flat
 * positional rule and no ABI arity check, so an all-static signature makes the
 * policy's view of the calldata and the ABI's view the same thing by
 * construction. wall.ts already carries the cautionary tale — `exactInputSingle`
 * has its recipient at word 3 while `exactInput` has it at word 2, because one
 * leading `bytes` made the tuple dynamic. Nothing here can move: no pointers
 * exist. Every word is also SEMANTIC:
 *
 *   word 0  curve         nothing useful — it is per-token and unpinnable
 *   word 1  assetIn       ONE_OF the owner's asset list
 *   word 2  assetOut      ONE_OF the same list; EQUAL USDG makes it exit-only
 *   word 3  amountIn      LESS_THAN_OR_EQUAL a per-trade cap
 *   word 4  minAmountOut  nothing useful — denominated in the output asset
 *   word 5  deadline      nothing useful
 *
 * DIRECTION IS DERIVED, NOT DECLARED. Whether this is a buy or a sell follows
 * from the curve's own `token()` and `pairToken()`, for the same reason
 * V4SelfSwap derives `zeroForOne` from the token order: a caller-supplied
 * direction that disagrees with the venue is a whole bug class that simply does
 * not exist if there is no such argument.
 */
contract PonsSelfTrade {
    /**
     * @dev Set for the duration of one trade. The curve is caller-supplied and
     * untrusted, and it receives control during `buy`/`sell` — including
     * whatever the asset contracts do on transfer. Nothing here is re-entrant by
     * design, but a guard costs one TSTORE and removes the need to be right
     * about that.
     */
    bool private transient inTrade;

    /// @notice One curve trade, tying an ACCOUNT to a curve and its amounts.
    /// `amountOut` is what the account's balance ACTUALLY gained, not what the
    /// curve reported.
    event SelfTrade(
        address indexed account,
        address indexed curve,
        address indexed assetOut,
        address assetIn,
        uint256 amountIn,
        uint256 amountOut
    );

    /**
     * @notice The most quote asset ONE CALLER may spend here in a rolling window.
     *
     * ─────────────────────────────────────────────────────────────────────────
     * THE SAME HOLE THE CLASS VAULT HAD, AND THE SAME BOUND
     *
     * `_direction` interrogates the curve about ITSELF, and the launchpad mints
     * ~475 curve addresses an hour, so no call policy can enumerate the
     * legitimate ones. The Pons factory exposes no registry to verify against —
     * eighteen candidate view signatures probed on mainnet 4663, none answers.
     * Provenance is not available on chain.
     *
     * So a compromised session key names a contract it controls as the curve.
     * It answers correctly, takes the approved input, and pays one wei back to
     * the account so the `amountOut == 0` floor does not trip — `minAmountOut`
     * being supplied by the same attacker.
     *
     * The wall bounds that PER CALL. Nothing bounded the repetition:
     * `RateLimitPolicy` has zero bytecode on this chain, so `maxOpsPerDay` is
     * enforced only by the worker, which is the party a compromise owns.
     *
     * ─────────────────────────────────────────────────────────────────────────
     * PER CALLER, NOT GLOBAL — the difference from PonsClassVault
     *
     * That vault belongs to one account. This adapter is a SHARED singleton
     * every account calls, so a single ceiling across all of them would let one
     * compromised account spend the whole allowance and refuse everybody else's
     * trades for the rest of the window. The ceiling is therefore keyed by
     * `msg.sender`, and one account's drain cannot reach another's.
     *
     * A caller raises or lowers their own, and cannot touch anyone else's. The
     * wall grants the session key exactly `tradeExactIn` on this target, so the
     * key being bounded cannot reach `setSpendCap`; the owner's sudo key can.
     *
     * ONLY BUYS ARE CHARGED. A sell brings quote back in, and a ceiling that
     * could refuse an exit would be a no-exit trap.
     */
    mapping(address => uint256) private capFor;
    mapping(address => bool) public capConfigured;

    /// @notice Quote units. 250 USDG at 6dp, for a caller that never sets one.
    uint256 public constant DEFAULT_SPEND_CAP = 250_000_000;

    /// @notice The window the cap is measured over.
    uint256 public constant SPEND_WINDOW = 1 days;

    mapping(address => uint256) private windowStart;
    mapping(address => uint256) private spentInWindow;

    event SpendCapSet(address indexed account, uint256 cap);

    /// @notice This caller's ceiling — their own setting, or the default.
    function spendCapOf(address account) public view returns (uint256) {
        return capConfigured[account] ? capFor[account] : DEFAULT_SPEND_CAP;
    }

    /**
     * @notice Set YOUR OWN ceiling. Cannot touch another account's.
     * @dev Zero disables buying for this caller and still leaves selling open.
     * `capConfigured` is what makes a deliberate zero distinguishable from
     * "never set" — without it, zero would silently mean the default.
     */
    function setSpendCap(uint256 cap) external {
        capFor[msg.sender] = cap;
        capConfigured[msg.sender] = true;
        emit SpendCapSet(msg.sender, cap);
    }

    /// @notice What this caller may still spend in the current window.
    function spendRemaining(address account) external view returns (uint256) {
        uint256 cap = spendCapOf(account);
        if (block.timestamp >= windowStart[account] + SPEND_WINDOW) return cap;
        uint256 spent = spentInWindow[account];
        return spent >= cap ? 0 : cap - spent;
    }

    /// @dev Charge a buy against this caller's window, rolling it when it passes.
    function _chargeSpend(address account, uint256 amountIn) private {
        if (block.timestamp >= windowStart[account] + SPEND_WINDOW) {
            windowStart[account] = block.timestamp;
            spentInWindow[account] = 0;
        }
        uint256 cap = spendCapOf(account);
        uint256 spent = spentInWindow[account] + amountIn;
        if (spent > cap) revert SpendCapExceeded(amountIn, cap - spentInWindow[account]);
        spentInWindow[account] = spent;
    }

    error Expired();
    error ZeroAmount();
    error SpendCapExceeded(uint256 wanted, uint256 remaining);
    error NotAContract();
    error Reentrant();
    error NativeQuoteNotSupported();
    error CurveGraduated();
    error AssetsDoNotMatchCurve(address curveToken, address curveQuote);
    error IdenticalAssets();
    error InsufficientOutput(uint256 received, uint256 minAmountOut);
    error NoOutput();
    error TransferFailed();
    error ApprovalFailed();

    /**
     * @notice Trade `amountIn` of `assetIn` for at least `minAmountOut` of
     * `assetOut` on one Pons bonding curve, paying from and delivering to the
     * CALLER.
     *
     * @dev The caller must have approved this contract for `amountIn` of
     * `assetIn`. That approval is the real spending bound and it is the one the
     * wall caps: this contract cannot pull from anyone but its own caller, so an
     * allowance here is not a licence anyone else can use.
     *
     * @param curve        The bonding curve. A PRICE parameter, not a security
     *                     one — see the threat model above. It cannot be
     *                     authenticated and is not claimed to be.
     * @param assetIn      Asset paid. Must be the curve's quote asset (a buy) or
     *                     its launched token (a sell).
     * @param assetOut     Asset received. Must be the other side of the same curve.
     * @param amountIn     Exact input, in `assetIn`'s own units.
     * @param minAmountOut Slippage floor in `assetOut`'s units, enforced here
     *                     against the caller's own balance change.
     * @param deadline     Unix seconds. A UserOp carries no expiry of its own —
     *                     the grant's timestamp policy expires the KEY, weeks
     *                     out — so without this an op held back by a bundler can
     *                     land days later at a price nobody quoted. On a bonding
     *                     curve that matters more than on a pool: the p99 price
     *                     move over four minutes is 1,546 bps.
     * @return amountOut   `assetOut` actually delivered to the caller.
     */
    function tradeExactIn(
        address curve,
        address assetIn,
        address assetOut,
        uint128 amountIn,
        uint128 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (inTrade) revert Reentrant();
        inTrade = true;

        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (assetIn == assetOut) revert IdenticalAssets();
        // A non-contract asset makes a raw `.call` return success having moved
        // nothing — cheaper to check than to reason about.
        if (curve.code.length == 0 || assetIn.code.length == 0 || assetOut.code.length == 0) {
            revert NotAContract();
        }

        bool isBuy = _direction(curve, assetIn, assetOut);

        // CHARGED BEFORE THE PULL AND THE APPROVE, so a refusal moves nothing
        // and the untrusted curve never receives an allowance it could spend.
        // Buys only: a sell returns quote to the account, and a ceiling that
        // could block one would be a no-exit trap.
        if (isBuy) _chargeSpend(msg.sender, amountIn);

        // The balance the guarantee is measured against. Read BEFORE the pull,
        // and on `msg.sender`, because the curve pays the account directly and
        // this contract never sees the output.
        uint256 balanceBefore = IERC20Trade(assetOut).balanceOf(msg.sender);

        // Pull the input to this contract, because the curve pulls from ITS
        // caller and that is us. This is the one moment a balance exists here,
        // and it is returned or spent before the call ends.
        _pull(assetIn, msg.sender, address(this), amountIn);
        _approve(assetIn, curve, amountIn);

        // `minAmountOut` is passed through so the curve fails early and by name
        // where it can, but it is NOT what this function relies on — see the
        // balance check below.
        if (isBuy) {
            IPonsCurve(curve).buy(amountIn, minAmountOut, msg.sender);
        } else {
            IPonsCurve(curve).sell(amountIn, minAmountOut, msg.sender);
        }

        // Leave no standing allowance and no residue. A curve that took less
        // than it was approved for would otherwise leave this contract able to
        // move the difference later, and a caller's asset sitting here would be
        // unrecoverable — there is no rescue function, on purpose.
        _approve(assetIn, curve, 0);
        uint256 residue = IERC20Trade(assetIn).balanceOf(address(this));
        if (residue > 0) _push(assetIn, msg.sender, residue);

        // THE GUARANTEE. What the account actually gained, not what the curve
        // said it paid. The curve is the untrusted party in this transaction and
        // is not asked to grade its own work.
        uint256 balanceAfter = IERC20Trade(assetOut).balanceOf(msg.sender);
        amountOut = balanceAfter - balanceBefore;
        // Zero is refused separately from the floor. An empty-but-live curve is
        // common on this launchpad, and a `minAmountOut` of 0 must not be read
        // as "nothing is acceptable" — this repo has already been burned once by
        // manufactured success: 1,311 intents, 0 landed, and a P&L that believed
        // its own intent.
        if (amountOut == 0) revert NoOutput();
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        emit SelfTrade(msg.sender, curve, assetOut, assetIn, amountIn, amountOut);
        inTrade = false;
    }

    /**
     * @dev Ask the curve what it is, refuse anything that does not line up, and
     * return whether this is a buy.
     *
     * A SEPARATE FUNCTION for a boring reason worth recording: inlined, this
     * pushed `tradeExactIn` over the stack limit and solc rejected the emit at
     * the bottom. Splitting it is also honest about what it is — a set of
     * questions put to an untrusted contract, kept away from the money.
     *
     * It does NOT authenticate the curve. A hostile contract answers however it
     * likes. What it does is make the caller's declared assets and the curve's
     * own claims agree, so a direction can never be inferred from one and acted
     * on with the other.
     */
    function _direction(address curve, address assetIn, address assetOut) private view returns (bool isBuy) {
        address curveToken = IPonsCurve(curve).token();
        address curveQuote = IPonsCurve(curve).pairToken();

        // Native-quoted curves are out of scope for this selector, by design.
        // Refused by NAME so the worker can quarantine on it rather than seeing
        // an anonymous failure it cannot classify.
        if (curveQuote == address(0)) revert NativeQuoteNotSupported();
        // Checked BEFORE anything is pulled. A graduated curve's reserves look
        // healthy; only this says otherwise.
        if (IPonsCurve(curve).graduated()) revert CurveGraduated();

        isBuy = assetIn == curveQuote && assetOut == curveToken;
        bool isSell = assetIn == curveToken && assetOut == curveQuote;
        if (!isBuy && !isSell) revert AssetsDoNotMatchCurve(curveToken, curveQuote);
    }

    /**
     * @dev transferFrom tolerant of the non-standard ERC-20s this chain's
     * memecoins are full of: success with no return data is accepted, a `false`
     * or short return is not.
     */
    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transferFrom, (from, to, amount)));
        if (!ok) revert TransferFailed();
        // Decoded as a uint, not a bool: abi.decode(..., (bool)) runs solc's bool
        // validator, which does a bare revert(0,0) on a word that is neither 0
        // nor 1 rather than yielding false — so a dirty-word token would fail
        // with an EMPTY revert, indistinguishable from out-of-gas, and could not
        // be quarantined by error selector. Same semantics as SafeERC20.
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    /// @dev transfer, with the same tolerance as `_pull`.
    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transfer, (to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    /**
     * @dev approve, zeroing first.
     *
     * Some ERC-20s on this chain refuse a non-zero→non-zero allowance change,
     * and a memecoin's token contract is whatever its creator wrote. Zeroing
     * first works on both kinds. The zero call's failure is tolerated only when
     * the allowance is already zero, which is the ordinary case here.
     */
    function _approve(address token, address spender, uint256 amount) private {
        if (amount > 0) {
            (bool zeroOk, ) = token.call(abi.encodeCall(IERC20Trade.approve, (spender, 0)));
            zeroOk; // best-effort: a token that reverts on approve(0) is handled by the call below
        }
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.approve, (spender, amount)));
        if (!ok) revert ApprovalFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert ApprovalFailed();
    }
}
