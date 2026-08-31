// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsCurve, IERC20Trade} from "./interfaces/IPonsCurve.sol";

/**
 * @title PonsNativeTrade
 * @notice The native-ETH-quoted half of the Pons launchpad, which PonsSelfTrade
 * refuses by design — and which is roughly 47% of launches.
 *
 * WHY A SECOND CONTRACT INSTEAD OF A BRANCH. PonsSelfTrade's header lists what a
 * native path would cost it, and the list is right. The mistake would be paying
 * that price for BOTH directions at once. They are not equally expensive, and a
 * single function branching on `pairToken()` would give one permission that
 * grants both behaviours forever. Two selectors on this contract are two
 * permissions, and the wall can grant either without the other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ASYMMETRY, WHICH IS THE WHOLE DESIGN
 *
 * SELLING for native ETH costs nothing this repo was protecting.
 * `IPonsCurve.sell` PAYS `recipient` DIRECTLY, so passing `msg.sender` means the
 * ETH goes from the curve to the account and never touches this contract. That
 * removes all four of the guarantees PonsSelfTrade's header said a native path
 * would forfeit:
 *
 *   1. no `receive()` — nothing is ever paid to this contract;
 *   2. no live ETH balance mid-transaction, so "holds nothing worth stealing"
 *      stays literally true;
 *   3. no WETH, and therefore no dependency on this chain's upgradeable
 *      TransparentUpgradeableProxy taking control while a balance exists;
 *   4. no new approve permission — the account approves the TOKEN it is
 *      selling, exactly as it already does for the ERC-20 adapter.
 *
 * And `sellForNative` is NON-PAYABLE, so the wall grants it at `valueLimit: 0`
 * like every other permission. Nothing about the "no permission moves native
 * ETH" invariant changes: an exit can only ever ADD ETH to the account.
 *
 * BUYING with native ETH is the expensive one, and it is expensive for a reason
 * no amount of contract design removes: `IPonsCurve.buy` is payable and requires
 * `msg.value == quoteIn` EXACTLY, so the ACCOUNT must send native value. That
 * needs a permission with a non-zero `valueLimit` — the first in this wall — and
 * that is a decision for an owner, not a consequence of an edit. It lives behind
 * its own selector so it can be refused independently, and `wall.ts` grants it
 * only under an explicit opt-in.
 *
 * SO THE HONEST SUMMARY: exits from native-quoted curves are nearly free and
 * strictly reduce risk. Entries cost an invariant. Ship them as separate
 * decisions, because they are.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREAT MODEL — the same one, restated where it differs
 *
 * - THE CURVE ARGUMENT STILL CANNOT BE AUTHENTICATED, and nothing here pretends
 *   otherwise. A curve self-reports `token()` and `pairToken()`, and a hostile
 *   contract answers however it likes. What bounds the damage is unchanged: the
 *   token leg is pinned ONE_OF the owner's own EXTRA tokens by the wall, the pull
 *   is capped at `amountIn`, and the floor is enforced HERE against the
 *   account's own balance rather than the curve's word.
 *
 * - THE SELL DIRECTION'S WORST CASE, stated correctly on the second attempt. A
 *   compromised session key calling `sellForNative` can sell an allowlisted
 *   token into an attacker's contract at an attacker's price, bounded by the
 *   allowance the wall permits.
 *
 *   AN EARLIER VERSION OF THIS COMMENT SAID "it cannot spend the account's
 *   cash", and that was FALSE as the wall was then written: `token` was pinned
 *   ONE_OF the same list that begins with USDG, so cash was a legal input and an
 *   attacker's curve could take it for one wei — cheaper than every other
 *   USDG-touching route in the wall, because this selector has no output leg to
 *   pin. It is now pinned to the owner's EXTRAS only (wall.ts,
 *   `nativeCurveAssets`), which is what makes the sentence true rather than
 *   aspirational: cash and equities are not reachable from this selector at all.
 *   Recorded rather than quietly corrected, because a contract whose comments
 *   are load-bearing has to show where one was wrong.
 *
 * - THE BUY DIRECTION'S WORST CASE IS THE ACCOUNT'S ETH, per call, up to the
 *   permission's `valueLimit`. Worth stating plainly because it is new: every
 *   other permission in this wall carries `valueLimit: 0` and therefore cannot
 *   lose native ETH at all. Under gas sponsorship the account holds little or no
 *   ETH, which shrinks the exposure and also — honestly — shrinks the feature.
 *
 * - NO OWNER, NO ADMIN, NO PAUSE, NO UPGRADE, NO RESCUE, and no `receive()`.
 *   Same trade as the sibling: an admin key able to freeze an owner's exit is a
 *   worse failure than an unfixable bug in a contract that holds nothing. A
 *   curve that tried to refund ETH to this contract would revert the whole
 *   trade, which is the correct direction to fail.
 *
 * - FEE-ON-TRANSFER TOKENS DO NOT WORK and fail closed, exactly as in the
 *   sibling: the amount approved to the curve is what was pulled, and a token
 *   that skims leaves the curve unable to take what it asked for.
 *
 * - A GRADUATED CURVE IS REFUSED BY NAME, for the reason the sibling gives: a
 *   graduated curve's reserves read like a healthy one's.
 *
 * SHAPE OF THE SIGNATURES. All-static words, no struct and no `bytes`, so the
 * wall's flat `args[i] → calldata word i` rule and the ABI's view of the
 * calldata are the same thing by construction. Note what is ABSENT from both:
 * there is NO `assetOut` on the sell and NO `assetIn` on the buy. The native
 * side is implied by the SELECTOR, which is what keeps `address(0)` out of the
 * wall's asset lists entirely — a zero-address sentinel in a ONE_OF would
 * weaken the ERC-20 path that shares it.
 *
 *   sellForNative  word 0 curve        unpinnable, per-token
 *                  word 1 token        ONE_OF the owner's EXTRA tokens only —
 *                                      never cash, never an equity
 *                  word 2 amountIn     bounded by the approve allowance
 *                  word 3 minNativeOut nothing useful — denominated in ETH
 *                  word 4 deadline     nothing useful
 *
 *   buyWithNative  word 0 curve        unpinnable, per-token
 *                  word 1 token        ONE_OF the owner's EXTRA tokens only
 *                  word 2 minTokensOut nothing useful
 *                  word 3 deadline     nothing useful
 *                  (the SIZE is msg.value, bounded by the permission's valueLimit)
 */
contract PonsNativeTrade {
    /// @dev One trade's worth. See PonsSelfTrade for why a guard is cheaper than being right.
    bool private transient inTrade;

    /// @notice A native-quoted curve trade, tying an ACCOUNT to a curve.
    /// `amountOut` is what the account's balance ACTUALLY gained.
    event NativeTrade(
        address indexed account,
        address indexed curve,
        address indexed token,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut
    );

    error Expired();
    error ZeroAmount();
    error NotAContract();
    error Reentrant();
    error NotNativeQuoted();
    error CurveGraduated();
    error TokenDoesNotMatchCurve(address curveToken);
    error InsufficientOutput(uint256 received, uint256 minAmountOut);
    error NoOutput();
    error TransferFailed();
    error ApprovalFailed();

    /**
     * @notice Sell `amountIn` of `token` back to its native-quoted curve for at
     * least `minNativeOut` wei, paid to the CALLER.
     *
     * @dev NON-PAYABLE and it must stay that way. The account sends no value;
     * the curve pays it. This is what lets the wall grant this selector at
     * `valueLimit: 0` alongside every other permission.
     *
     * @param curve        The bonding curve. A price parameter, not a security one.
     * @param token        The launched token being sold. Must be `curve.token()`.
     * @param amountIn     Exact input in the token's own units.
     * @param minNativeOut Floor in WEI, enforced against the caller's own balance change.
     * @param deadline     Unix seconds — a UserOp carries no expiry of its own.
     * @return amountOut   Wei actually delivered to the caller.
     */
    function sellForNative(
        address curve,
        address token,
        uint128 amountIn,
        uint128 minNativeOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (inTrade) revert Reentrant();
        inTrade = true;

        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        if (curve.code.length == 0 || token.code.length == 0) revert NotAContract();
        _requireNativeCurveFor(curve, token);

        // Read BEFORE the pull, on msg.sender, because the curve pays the
        // account directly and this contract never sees the ETH.
        //
        // WHAT THIS MEASURES, precisely: wei that ARRIVED at the account during
        // this call, from any source. It is not proof the CURVE paid — five
        // calls into caller-chosen code run between the two reads and any of
        // them could send ETH here. That is fine, and deliberately not
        // strengthened: inflating the delta costs an attacker exactly the ETH
        // they put into the victim's account. The guarantee being enforced is
        // "the account holds at least minNativeOut more wei afterwards", which
        // is what a floor is for. The sibling claims exactly this much and no
        // more, and an earlier draft of this comment claimed attribution it
        // could not support.
        uint256 balanceBefore = msg.sender.balance;

        _pull(token, msg.sender, address(this), amountIn);
        _approve(token, curve, amountIn);

        // minNativeOut is passed through so the curve can fail early and by
        // name, but it is NOT what this function relies on.
        IPonsCurve(curve).sell(amountIn, minNativeOut, msg.sender);

        // No standing allowance, no residue. There is no rescue function here
        // either, so an asset left behind would be unrecoverable.
        _approve(token, curve, 0);
        uint256 residue = IERC20Trade(token).balanceOf(address(this));
        if (residue > 0) _push(token, msg.sender, residue);

        // THE GUARANTEE: what the account gained, not what the curve claimed.
        amountOut = msg.sender.balance - balanceBefore;
        if (amountOut == 0) revert NoOutput();
        if (amountOut < minNativeOut) revert InsufficientOutput(amountOut, minNativeOut);

        emit NativeTrade(msg.sender, curve, token, false, amountIn, amountOut);
        inTrade = false;
    }

    /**
     * @notice Buy `token` from its native-quoted curve with the ETH sent, for at
     * least `minTokensOut`, delivered to the CALLER.
     *
     * @dev PAYABLE, and the only function in this repo that moves the account's
     * native ETH. `msg.value` IS the trade size — `IPonsCurve.buy` requires
     * `msg.value == quoteIn` exactly, takes no change and gives none — so the
     * bound is the wall permission's `valueLimit`, not an argument here. That is
     * a deliberate owner opt-in and `wall.ts` refuses to mint it otherwise.
     *
     * Everything received goes to `msg.sender`; nothing is retained. There is no
     * `receive()`, so a curve attempting to refund would revert the whole trade
     * rather than strand ETH here.
     *
     * @param curve        The bonding curve.
     * @param token        The launched token being bought. Must be `curve.token()`.
     * @param minTokensOut Floor in the token's units, enforced against the caller's balance change.
     * @param deadline     Unix seconds.
     * @return amountOut   Tokens actually delivered to the caller.
     */
    function buyWithNative(
        address curve,
        address token,
        uint128 minTokensOut,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        if (inTrade) revert Reentrant();
        inTrade = true;

        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();
        if (curve.code.length == 0 || token.code.length == 0) revert NotAContract();
        _requireNativeCurveFor(curve, token);

        uint256 balanceBefore = IERC20Trade(token).balanceOf(msg.sender);

        // Forward the WHOLE value. The curve reverts unless quoteIn equals it
        // exactly, so there is no path where this contract keeps a remainder.
        IPonsCurve(curve).buy{value: msg.value}(msg.value, minTokensOut, msg.sender);

        amountOut = IERC20Trade(token).balanceOf(msg.sender) - balanceBefore;
        if (amountOut == 0) revert NoOutput();
        if (amountOut < minTokensOut) revert InsufficientOutput(amountOut, minTokensOut);

        emit NativeTrade(msg.sender, curve, token, true, msg.value, amountOut);
        inTrade = false;
    }

    /**
     * @dev Put the questions to the curve, and refuse anything that disagrees.
     *
     * Does NOT authenticate the curve — a hostile contract answers as it likes.
     * What it does is force the CALLER's declared token and the CURVE's own
     * claim to agree, so a trade can never be built from one and executed
     * against the other.
     *
     * `pairToken() == address(0)` is the check that makes this contract the
     * mirror image of PonsSelfTrade: that one refuses native curves, this one
     * refuses everything else. Neither can be pointed at the other's venue.
     */
    function _requireNativeCurveFor(address curve, address token) private view {
        if (IPonsCurve(curve).pairToken() != address(0)) revert NotNativeQuoted();
        if (IPonsCurve(curve).graduated()) revert CurveGraduated();
        address curveToken = IPonsCurve(curve).token();
        if (curveToken != token) revert TokenDoesNotMatchCurve(curveToken);
    }

    // ── ERC-20 plumbing, decoding defensively ────────────────────────────────
    // A memecoin's token contract is whatever its creator wrote, and plenty
    // return nothing at all. Same semantics as SafeERC20, quarantined by error
    // selector so a failure says which step failed.

    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeCall(IERC20Trade.transferFrom, (from, to, amount))
        );
        if (!ok) revert TransferFailed();
        // Decoded as a uint, NOT a bool. `abi.decode(..., (bool))` runs solc's bool
        // validator, which does a bare revert(0,0) on a word that is neither 0 nor
        // 1 — so a dirty-word token would fail with EMPTY revert data,
        // indistinguishable from out-of-gas, and could not be quarantined by error
        // selector as the comment above promises. It would also refuse tokens the
        // sibling adapters deliberately accept. Same semantics as SafeERC20, and
        // the same line as PonsSelfTrade — this had drifted, and the drift was
        // silent because canonical tokens behave identically under both.
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) {
            revert TransferFailed();
        }
    }

    /// @dev transfer, with the same tolerance as `_pull`.
    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transfer, (to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) {
            revert TransferFailed();
        }
    }

    /**
     * @dev approve, zeroing first.
     *
     * Some ERC-20s refuse a non-zero to non-zero allowance change outright. The
     * zero-first sequence is what the sibling does and it costs one call.
     */
    function _approve(address token, address spender, uint256 amount) private {
        if (amount != 0) _rawApprove(token, spender, 0);
        _rawApprove(token, spender, amount);
    }

    function _rawApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.approve, (spender, amount)));
        if (!ok) revert ApprovalFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) {
            revert ApprovalFailed();
        }
    }
}
