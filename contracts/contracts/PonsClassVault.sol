// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPonsCurve, IERC20Trade} from "./interfaces/IPonsCurve.sol";

/**
 * @title PonsClassVault
 * @notice A per-account holder for CLASS-traded Pons tokens — tokens the owner
 * never enumerated into the signed grant. It exists for exactly one reason:
 * SO THAT SELLING ONE DOES NOT REQUIRE A PER-TOKEN APPROVE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES, PRECISELY
 *
 * A sniper picks tokens that did not exist when the grant was signed, so they
 * cannot be in the wall's enumerated asset list. Relaxing the BUY is easy: the
 * wall pins the ADAPTER as `target` and the token is just a calldata word, and
 * a word can be left unconstrained (`null`) — the wall already does this for the
 * per-launch `curve` argument.
 *
 * The SELL is where it breaks. `PonsSelfTrade.tradeExactIn` pulls `assetIn` by
 * `transferFrom`, so selling token X requires the account to have called
 * `X.approve(adapter, amount)` first. That call's `target` IS token X — a
 * literal address — and a Kernel CallPolicy permission is keyed by
 * (target, selector). The consequence is the one outcome no cap protects
 * against: an agent that can BUY a position it can never EXIT.
 *
 * A CORRECTION, because this comment used to claim more than is true. It said
 * "there is no wildcard target, so a permission to approve a token nobody has
 * heard of yet cannot be written". That is not established. The zerodev
 * permissions package (5.6.3) documents, in constants.ts, that
 * CALL_POLICY_CONTRACT_V0_0_2 onward "Added `zeroAddress` target address
 * support, which means you can approve any contracts with specific selector.
 * (e.g. approve any ERC20 transfer)" — and the wall pins V0_0_4. The claim rests
 * on one changelog line: no SDK code path, type or test exercises it, and the
 * policy contract's source is not published. So it is DOCUMENTED BUT
 * UNEXERCISED, which is neither "supported" nor "absent".
 *
 * This contract is still the right answer, for a different and weaker reason
 * than the one originally given. A zeroAddress-target approve, paired with the
 * unpinned adapter leg it would need to be useful, lets a compromised session
 * key approve EVERY token the account holds — airdrops and transfers-in
 * included — and sell each into any curve it names. This vault's exposure is one
 * capped USDG approve per trade, the account's own token balances are never in
 * scope, and it rests on bytecode in this repository rather than on a sentence
 * in a dependency's changelog. Narrower, and checkable.
 *
 * THE FIX IS TO MOVE WHERE THE TOKEN LIVES. If the class token is never held by
 * the account, the account never needs to approve it. This vault holds it, and
 * the wall pins THIS CONTRACT as the target — an address that is known at
 * signing time — while the token stays an unconstrained argument. Both the buy
 * and the sell become expressible under the policy the chain already supports.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY GIVES UP, AND WHY THAT IS THE TRADE
 *
 * `PonsSelfTrade` states as its safety property that it "never holds a balance —
 * the reason there is nothing here to steal". THIS CONTRACT HOLDS A BALANCE.
 * That is not an oversight, it is the whole mechanism, and it is bounded three
 * ways rather than hand-waved:
 *
 *   1. ONE OWNER, SET AT CONSTRUCTION, IMMUTABLE. This is not a shared pool.
 *      Every account gets its own vault, so a bug here loses one agent's class
 *      positions, never the fleet's. A shared custodial adapter would have been
 *      cheaper (no deploy per account) and would have been a honeypot holding
 *      every agent's tokens behind one code path — deliberately not built.
 *   2. NOTHING LEAVES EXCEPT TO THE OWNER. There is no recipient argument
 *      anywhere in this file. `sell` pays the curve's proceeds directly to
 *      `owner`, and `sweep` pushes to `owner`. A caller cannot name a third
 *      party because the ABI gives them nowhere to write one.
 *   3. NO OWNER-ADMIN, NO PAUSE, NO UPGRADE, NO RESCUE-TO-ANYWHERE. Same trade
 *      as PonsSelfTrade and V4SelfSwap: an admin key that can freeze the owner's
 *      exit is a worse failure than the one it prevents.
 *
 * WHAT AN ATTACKER WITH THE SESSION KEY GETS, STATED PLAINLY. They can name a
 * hostile `curve` and convert the account's capped USDG into a worthless token
 * held by this vault — the same exposure the wall already carries for
 * PonsSelfTrade and V4SelfSwap, whose curve/pool arguments are equally
 * caller-chosen. They CANNOT move anything to themselves: every payout path in
 * this file is hard-coded to `owner`. What is new versus PonsSelfTrade is that
 * the junk now sits here rather than in the account, and `sweep` is what gets it
 * back out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT DO
 *
 * - NATIVE-QUOTED CURVES ARE REFUSED, exactly as PonsSelfTrade refuses them and
 *   for the same reasons (no `receive()`, no live ETH balance, no dependency on
 *   this chain's upgradeable WETH proxy). 53.6% of launches are native-quoted
 *   and none of them is reachable here.
 * - IT DOES NOT AUTHENTICATE THE CURVE. A curve self-reports `factory()` and a
 *   malicious contract can too; the Pons factory publishes no registry view. So
 *   provenance is NOT checked here and this file does not pretend to. It is
 *   enforced off-chain by the worker's factory-filtered `knownCurves`, which
 *   means FOR THE CLASS CASE THE CHAIN IS LOOSER THAN THE OFF-CHAIN MIRROR —
 *   the reverse of this system's usual invariant. That inversion is the price of
 *   a class permission and must be understood before a grant is signed.
 * - IT HOLDS NO QUOTE ASSET BETWEEN CALLS. Buys pull quote from the owner and
 *   spend it; sells pay proceeds straight to the owner. Any dust either side
 *   leaves behind is swept back to the owner in the same call.
 */
contract PonsClassVault {
    /// @notice The smart account this vault belongs to. The only caller, and the
    /// only address any asset can ever be sent to.
    address public immutable owner;

    /// @dev Set once by the factory at CREATE2 time; the salt is the owner, so
    /// the address is derivable BEFORE deployment — which is what lets the wall
    /// pin it as a literal `target` when the grant is signed.
    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroOwner();
        owner = owner_;
    }

    error NotOwner();
    error Reentrant();
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

    event ClassBuy(address indexed curve, address indexed token, uint256 quoteIn, uint256 tokensOut);
    event ClassSell(address indexed curve, address indexed token, uint256 tokensIn, uint256 quoteOut);
    event Swept(address indexed token, uint256 amount);

    bool private inTrade;

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
     * @notice Buy a class token with the quote asset, and KEEP it here.
     * @dev The owner must have approved this contract for `quoteIn` of
     * `quoteAsset` — which is the account's ordinary, already-granted USDG
     * approve, not a per-token one. That is the point of the whole file.
     *
     * The curve pays THIS CONTRACT, deliberately: if it paid the owner, the
     * token would land in the account and selling it would need the per-token
     * approve this design exists to avoid.
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
        address token = _checkCurve(curve, quoteAsset);

        // MEASURED, NOT TRUSTED. The curve is an untrusted contract asked to
        // report on its own behaviour, so the amount is a balance delta on this
        // contract rather than anything the curve returns.
        uint256 before = IERC20Trade(token).balanceOf(address(this));

        _pull(quoteAsset, owner, address(this), quoteIn);
        _approve(quoteAsset, curve, quoteIn);
        IPonsCurve(curve).buy(quoteIn, minTokensOut, address(this));
        _approve(quoteAsset, curve, 0);

        // A curve that pulled less than it was approved for would otherwise
        // leave quote stranded here. It goes back to the owner, not to a rescue
        // function — there isn't one.
        uint256 residue = IERC20Trade(quoteAsset).balanceOf(address(this));
        if (residue > 0) _push(quoteAsset, owner, residue);

        tokensOut = IERC20Trade(token).balanceOf(address(this)) - before;
        if (tokensOut == 0) revert NoOutput();
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        emit ClassBuy(curve, token, quoteIn, tokensOut);
    }

    /**
     * @notice Sell a class token this vault holds, paying the owner directly.
     * @dev NO APPROVE IS NEEDED FROM THE OWNER — the tokens are already here.
     * This is the exit that the enumerated wall could not express, and the
     * reason a class position is not a trap.
     *
     * Proceeds go to `owner`, never to this contract, so the vault holds only
     * class tokens and never the account's cash.
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

        // The owner's balance, because the curve pays the owner. Measuring the
        // recipient rather than believing the curve is the same discipline
        // PonsSelfTrade uses.
        uint256 before = IERC20Trade(quoteAsset).balanceOf(owner);

        _approve(token, curve, tokensIn);
        IPonsCurve(curve).sell(tokensIn, minQuoteOut, owner);
        _approve(token, curve, 0);

        quoteOut = IERC20Trade(quoteAsset).balanceOf(owner) - before;
        if (quoteOut == 0) revert NoOutput();
        if (quoteOut < minQuoteOut) revert InsufficientOutput(quoteOut, minQuoteOut);
        emit ClassSell(curve, token, tokensIn, quoteOut);
    }

    /**
     * @notice Send a token's whole balance back to the owner.
     * @dev THE UNCONDITIONAL EXIT. It takes no recipient and no amount: there is
     * exactly one destination and it is fixed at construction. This is what
     * `merrymen recover` uses to pull class positions out of the vault, and what
     * makes "the tokens are in a contract" recoverable rather than a one-way
     * door. It is deliberately callable even for a graduated or dead curve,
     * because a position you cannot sell is still a position you can move.
     */
    function sweep(address token) external only returns (uint256 amount) {
        amount = IERC20Trade(token).balanceOf(address(this));
        if (amount == 0) revert ZeroAmount();
        _push(token, owner, amount);
        emit Swept(token, amount);
    }

    /**
     * @dev The three refusals that must happen before any asset moves, shared by
     * buy and sell so they cannot drift apart.
     *
     * `graduated()` is checked FIRST-class rather than as a nicety: a graduated
     * curve resets its reserves, so it reports what looks like a live market
     * while the real one has moved to a Uniswap pool.
     */
    function _checkCurve(address curve, address quoteAsset) private view returns (address token) {
        if (curve.code.length == 0) revert NotAContract();
        address curveQuote = IPonsCurve(curve).pairToken();
        if (curveQuote == address(0)) revert NativeQuoteNotSupported();
        if (curveQuote != quoteAsset) revert TokenDoesNotMatchCurve(curveQuote);
        if (IPonsCurve(curve).graduated()) revert CurveGraduated();
        token = IPonsCurve(curve).token();
        if (token == address(0) || token == quoteAsset) revert TokenDoesNotMatchCurve(token);
    }

    /// @dev transferFrom, tolerant of this chain's non-standard ERC-20s.
    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transferFrom, (from, to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    /// @dev transfer, same tolerance.
    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Trade.transfer, (to, amount)));
        if (!ok) revert TransferFailed();
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFailed();
    }

    /// @dev approve, zeroing first for the tokens that demand it.
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
 * @title PonsClassVaultFactory
 * @notice CREATE2 deployer, so a vault's address is known BEFORE it exists.
 *
 * THIS IS LOAD-BEARING, NOT CONVENIENCE. The wall must pin the vault as a
 * literal `target` at the moment the owner signs the grant — which is before the
 * vault has ever been deployed or used. A deterministic address is what makes
 * that possible; without it the class permission could not be written at all.
 *
 * The salt IS the owner address, so exactly one vault can exist per account and
 * anyone can recompute it. Deployment is permissionless and idempotent-by-revert
 * (a second deploy for the same owner fails), so a griefer can at worst pay to
 * create the vault the owner was going to create anyway — with the owner already
 * baked in, since the salt determines the address.
 */
contract PonsClassVaultFactory {
    event VaultDeployed(address indexed owner, address vault);

    function deploy(address owner_) external returns (address vault) {
        vault = address(new PonsClassVault{salt: bytes32(uint256(uint160(owner_)))}(owner_));
        emit VaultDeployed(owner_, vault);
    }

    /// @notice The address `deploy(owner_)` will produce. Callable before deployment.
    function vaultFor(address owner_) external view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(PonsClassVault).creationCode, abi.encode(owner_)));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(owner_))), initHash)
                    )
                )
            )
        );
    }
}
