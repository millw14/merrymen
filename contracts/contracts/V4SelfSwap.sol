// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager, IUnlockCallback, IERC20Minimal, PoolKey, SwapParams} from "./interfaces/IUniswapV4Minimal.sol";

/**
 * @title V4SelfSwap
 * @notice A Uniswap v4 spot swap that CANNOT send the output anywhere but back
 * to the caller. That single hardcoded word is the entire product.
 *
 * WHY THIS EXISTS. merrymen's agent is a Kernel smart account whose session key
 * is bounded by an on-chain call policy — "the wall" (packages/core/src/wall.ts).
 * A call policy can pin a target, a selector, and individual DECLARED ABI
 * arguments. The only v4 route on this chain is Permit2 + UniversalRouter, and
 * `execute(bytes commands, bytes[] inputs)` hides the swap recipient inside
 * opaque bytes, so the wall cannot say where the money goes. Granting it means
 * granting "move every approved token to any address, in one UserOp" — which is
 * why `allowUniswapV4` is hardcoded false in both signers and the agent cannot
 * buy or sell anything that only lives on v4.
 *
 * The fix is not a cleverer policy. It is to remove the recipient from the
 * calldata altogether. Here the output is taken to `msg.sender`, written in
 * Solidity, and `msg.sender` IS the smart account. There is no recipient
 * argument to constrain, mis-offset, or forget. Permit2 and the UniversalRouter
 * drop out of the wall entirely — a NET REDUCTION in granted power, not a
 * widening.
 *
 * THE ONE INVARIANT EVERYTHING ELSE RESTS ON:
 *   tokens are pulled ONLY from `msg.sender`, and paid ONLY to `msg.sender`.
 * Both addresses are the same local variable, captured once in `swapExactIn`
 * and carried into the callback. There is no code path that names a third
 * party. So an allowance granted to this contract can be spent by nobody but
 * the account that granted it, and one caller's bug can never reach another
 * caller's balance.
 *
 * SHAPE OF THE SIGNATURE, AND WHY IT IS FLAT. `swapExactIn` takes eight STATIC
 * words and no structs or `bytes`. The wall maps args[i] to calldata offset
 * i*32 with a flat positional rule and no ABI arity check (see zerodev's
 * permissions package, callPolicyUtils, `offset: i * 32`), so an all-static
 * signature makes the policy's view of the calldata and the ABI's view the same
 * thing by construction. wall.ts already carries a paragraph explaining why
 * `exactInputSingle`'s recipient is at word 3 while `exactInput`'s is at word 2
 * — a dynamic tuple moved it. Nothing here can move: no pointers exist. Every
 * word is also SEMANTIC, so the owner chooses how tight the wall is without
 * anyone touching this contract again:
 *
 *   word 0  tokenIn        ONE_OF an allowlist, or leave open
 *   word 1  tokenOut       EQUAL USDG makes this an EXIT-ONLY adapter
 *   word 2  fee            EQUAL a tier, or leave open
 *   word 3  tickSpacing    "
 *   word 4  hooks          EQUAL address(0) = hookless pools only (recommended)
 *   word 5  amountIn       LESS_THAN_OR_EQUAL a per-trade cap
 *   word 6  minAmountOut   nothing useful — denominated in the output token
 *   word 7  deadline       nothing useful
 *
 * `zeroForOne` is deliberately NOT a parameter. It is derived from
 * `tokenIn < tokenOut`, because a bool whose meaning flips with the pool key is
 * a word no policy can say anything true about, and a caller-supplied direction
 * that disagrees with the key is a whole bug class that simply does not exist
 * here.
 *
 * Threat model (documented honestly):
 *
 * - THIS CONTRACT DOES NOT MAKE v4 SAFE. It makes v4 exactly as safe as the v3
 *   route the wall already grants, which is the bar that unblocks the flag and
 *   no higher. A compromised session key can still swap up to the standing
 *   ERC-20 allowance into a pool the attacker owns, at a price the attacker
 *   picks (`minAmountOut` is theirs to set to 1), and harvest the difference as
 *   the LP on the other side. Identical to what `exactInputSingle` already
 *   permits on SwapRouter02 today. What it costs the attacker is that they must
 *   put real capital in a pool and take the other side; what it costs the owner
 *   is bounded per call by the approve cap and per day by the grant's rate-limit
 *   policy. It is NOT zero. Do not let anyone tell the owner "the chain enforces
 *   it" and mean "you cannot lose money".
 *
 * - NO OWNER, NO ADMIN, NO PAUSE, NO UPGRADE. If there is a bug in here, nobody
 *   can stop it — including us. That is a deliberate trade: the alternative is
 *   an admin key that can pause the owner's exits, which is a worse failure in a
 *   contract standing between an agent and its only sell route. The mitigation
 *   is that a bug has almost nothing to work with: no storage, no balances, and
 *   no path that names an address other than `msg.sender`.
 *
 * - IT NEVER HOLDS TOKENS. Input goes straight from the caller to the
 *   PoolManager; output goes straight from the PoolManager to the caller. The
 *   contract's balance is zero before and after every call, so there is nothing
 *   here to steal even mid-transaction. There is deliberately NO rescue or sweep
 *   function: a rescue function is a "send tokens to an address" function, and
 *   this contract's whole value is that it does not have one. Anything
 *   accidentally transferred in is stuck forever. It is also unusable — the
 *   settle path pulls from the caller, never from this contract's balance — so
 *   a donation cannot subsidise anyone's swap.
 *
 * - NATIVE ETH IS REFUSED. `swapExactIn` is non-payable and both currencies must
 *   be contracts, so the wall's permission can carry `valueLimit: 0`. The cost is
 *   real: this cannot touch v4's native ETH/USDG pool. WETH pools on v3 remain
 *   the ETH route. Supporting native would mean a payable function, a non-zero
 *   valueLimit, and an ETH send back to the caller — three new things for one
 *   pool.
 *
 * - HOOKS ARE PASSED THROUGH, NOT TRUSTED. `hooks` is a caller-supplied address
 *   and a malicious hook can move the swap's deltas around during the callback.
 *   Two checks bound it: the amount pulled is whatever the DELTA says is owed and
 *   must be `<= amountIn` (so a hook cannot inflate the pull to drain a standing
 *   allowance), and the amount received must be `>= minAmountOut`. Belt and
 *   braces on top of that: the wall's recommended default pins `hooks` to
 *   address(0), because the worker can only DISCOVER hookless pools today
 *   (worker/src/venues/uniswap-v4.ts guesses keys across V4_TIERS), and granting
 *   reach the worker cannot use is exactly the "an unused router in this list is
 *   a standing licence" mistake wall.ts warns about.
 *
 * - PARTIAL FILLS ARE REAL. `sqrtPriceLimitX96` is set to the permissive bound,
 *   so a pool that runs out of liquidity fills less than `amountIn` and the swap
 *   succeeds. That is why every amount below comes from the returned delta and
 *   never from the argument: settling `amountIn` when the pool only took part of
 *   it would over-pay the pool by the difference.
 *
 * - INPUT TRANSFER TAXES ARE REFUSED. `settle()` credits what actually
 *   arrived; if the input token skims the transfer, SettleMismatch reverts the
 *   whole swap. Output is measured from the caller's actual balance increase,
 *   so an output tax cannot silently deliver less than minAmountOut or inflate
 *   the returned amount and SelfSwap event. This does not make a taxed token
 *   sellable: its input leg can still fail on a later sale.
 *
 * - TRANSIENT STORAGE. The re-entrancy flag uses solc 0.8.28's `transient`, so
 *   this needs a Cancun-capable chain. That is not a new requirement: v4's
 *   PoolManager itself is built on TSTORE, so any chain with a PoolManager to
 *   talk to has it.
 */
contract V4SelfSwap is IUnlockCallback {
    /// @notice The v4 singleton this adapter is bound to. Immutable, because a
    /// settable PoolManager is a settable "where does the money go".
    IPoolManager public immutable poolManager;

    /**
     * @dev Permissive price bounds. v4 REJECTS `sqrtPriceLimitX96 == 0` and
     * rejects a limit at or beyond the extremes, so "no limit" has to be spelled
     * as one-inside-the-edge. Slippage is enforced by `minAmountOut`, which is
     * the number the quote was actually judged against; a price limit would be a
     * second, weaker bound expressed in units nobody upstream computes.
     *
     * TickMath.MIN_SQRT_PRICE = 4295128739
     * TickMath.MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342
     */
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /**
     * @dev Set for the duration of one `swapExactIn`. The PoolManager only ever
     * calls `unlockCallback` back on the address that called `unlock`, and
     * nesting is impossible (a second `unlock` reverts with AlreadyUnlocked), so
     * `msg.sender == poolManager` is already sufficient. This is defence in
     * depth against being wrong about that, and it costs one TSTORE.
     */
    bool private transient inFlight;

    /// @notice The only record that ties an ACCOUNT to a v4 swap. The
    /// PoolManager's own Swap event names this adapter as `sender`, not the
    /// account, so without this the on-chain trail stops here. `amountIn` is the
    /// amount ACTUALLY paid, which is not always the amount requested.
    event SelfSwap(
        address indexed account,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error Expired();
    error NativeNotSupported();
    error IdenticalCurrencies();
    error ZeroAmount();
    error NotAContract();
    error NotPoolManager();
    error NoSwapInFlight();
    error UnexpectedDelta();
    error PullExceedsAmountIn();
    error InsufficientOutput();
    error TransferFromFailed();
    error SettleMismatch(uint256 owed, uint256 paid);
    error NoOutput();

    /// @dev What `swapExactIn` hands to itself through the PoolManager's
    /// callback. `account` is `msg.sender`, captured once — it is the reason no
    /// other address can appear anywhere below.
    struct CallbackData {
        address account;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        uint128 amountIn;
        uint128 minAmountOut;
    }

    constructor(IPoolManager _poolManager) {
        if (address(_poolManager).code.length == 0) revert NotAContract();
        poolManager = _poolManager;
    }

    /**
     * @notice Swap `amountIn` of `tokenIn` for at least `minAmountOut` of
     * `tokenOut` through one v4 pool, paying from and delivering to the CALLER.
     *
     * @dev The caller must have approved this contract for `amountIn` of
     * `tokenIn`. That approval is the real spending bound, and it is the one the
     * wall caps: this contract has no way to pull from anyone but its own
     * caller, so an allowance here is not a licence anyone else can use.
     *
     * The pool is identified by the caller because v4 has no factory. That makes
     * the pool a PRICE parameter, not a security parameter — a bad key means a
     * bad fill or a revert, never a lost recipient.
     *
     * @param tokenIn      Currency paid. Must be an ERC-20 contract; native is refused.
     * @param tokenOut     Currency received. Must differ from `tokenIn`.
     * @param fee          PoolKey fee (LP fee in hundredths of a bip, or the dynamic-fee flag).
     * @param tickSpacing  PoolKey tick spacing.
     * @param hooks        PoolKey hooks address. address(0) for a vanilla pool.
     * @param amountIn     Exact input, in `tokenIn`'s own units. May fill partially.
     * @param minAmountOut Slippage floor, in `tokenOut`'s units. Use the same
     *                     number the quote was judged against.
     * @param deadline     Unix seconds. A UserOp carries no expiry of its own —
     *                     the grant's timestamp policy expires the KEY, weeks out
     *                     — so without this, an op held back by a bundler can land
     *                     days later at a price nobody quoted. The account's
     *                     sequential 4337 nonce kills a stale op only if some
     *                     other op has landed in the meantime, which is not a
     *                     guarantee.
     * @return amountOut   `tokenOut` actually delivered to the caller.
     */
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint128 amountIn,
        uint128 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokenIn == address(0) || tokenOut == address(0)) revert NativeNotSupported();
        if (tokenIn == tokenOut) revert IdenticalCurrencies();
        if (amountIn == 0) revert ZeroAmount();
        // Cheaper to check than to reason about: a non-contract `tokenIn` makes a
        // raw `.call` return success having moved nothing.
        if (tokenIn.code.length == 0 || tokenOut.code.length == 0) revert NotAContract();

        inFlight = true;
        bytes memory result = poolManager.unlock(
            abi.encode(
                CallbackData({
                    account: msg.sender,
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    tickSpacing: tickSpacing,
                    hooks: hooks,
                    amountIn: amountIn,
                    minAmountOut: minAmountOut
                })
            )
        );
        inFlight = false;

        uint256 amountPaid;
        (amountPaid, amountOut) = abi.decode(result, (uint256, uint256));
        emit SelfSwap(msg.sender, tokenIn, tokenOut, amountPaid, amountOut);
    }

    /**
     * @notice PoolManager callback. Everything that touches money happens here,
     * inside the singleton's lock.
     *
     * @dev The safety net under all of it: `unlock` reverts if ANY currency delta
     * is still non-zero when this returns, so a mis-settled swap cannot be left
     * half-done — it is undone.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!inFlight) revert NoSwapInFlight();

        CallbackData memory c = abi.decode(data, (CallbackData));
        // Include the entire swap, including hooks, in the caller's delivery
        // measurement. A pre-existing holding must never subsidise minAmountOut.
        uint256 outputBefore = IERC20Minimal(c.tokenOut).balanceOf(c.account);

        // v4 requires currency0 < currency1, and `zeroForOne` is defined against
        // that order. Deriving both from the two token addresses is why this
        // contract cannot be handed a direction that contradicts its own key.
        bool zeroForOne = c.tokenIn < c.tokenOut;
        PoolKey memory key = PoolKey({
            currency0: zeroForOne ? c.tokenIn : c.tokenOut,
            currency1: zeroForOne ? c.tokenOut : c.tokenIn,
            fee: c.fee,
            tickSpacing: c.tickSpacing,
            hooks: c.hooks
        });

        bytes memory noHookData;
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                // NEGATIVE = exact input. This is the v3 convention inverted.
                amountSpecified: -int256(uint256(c.amountIn)),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            noHookData
        );

        // BalanceDelta unpacking: amount0 is the HIGH int128, amount1 the LOW
        // one. `>>` on a signed value is an arithmetic shift, and the narrowing
        // cast truncates — together that is exactly v4's sar(128,·) / signextend.
        int128 delta0 = int128(delta >> 128);
        int128 delta1 = int128(delta);
        (int128 deltaIn, int128 deltaOut) = zeroForOne ? (delta0, delta1) : (delta1, delta0);

        // Signs are from OUR perspective: negative = we owe the pool, positive =
        // the pool owes us. Anything else means a hook rearranged the swap into a
        // shape this contract was not written for, so refuse rather than improvise.
        if (deltaIn > 0 || deltaOut < 0) revert UnexpectedDelta();

        uint256 owed = uint256(uint128(-deltaIn));
        uint256 received = uint256(uint128(deltaOut));

        // LOAD-BEARING. The pull amount comes from the delta, not the argument,
        // so a hook (or a future pool type) cannot make this contract spend more
        // of the caller's standing allowance than the caller named — which is
        // also what makes a LESS_THAN_OR_EQUAL condition on `amountIn` a real
        // on-chain bound rather than a description of intent.
        if (owed > c.amountIn) revert PullExceedsAmountIn();
        if (received < c.minAmountOut) revert InsufficientOutput();
        // A fill of nothing is never what the worker meant, and this repo has been
        // burned by manufactured success before: 1,311 intents, 0 landed, and a
        // P&L that believed its own intent. minAmountOut carries no useful policy
        // constraint (it is denominated in the OUTPUT token), so this guard is
        // what stops a null meaning "zero is acceptable". Empty-but-initialized
        // pools are common on this chain.
        if (received == 0) revert NoOutput();

        // Pay first, collect second. `owed` can be 0 on an exotic pool, and
        // `sync` before the transfer is what lets `settle` measure what arrived.
        if (owed > 0) {
            poolManager.sync(c.tokenIn);
            _pull(c.tokenIn, c.account, address(poolManager), owed);
            uint256 paid = poolManager.settle();
            // PIN THE CREDIT. v4 keeps the synced currency in ONE GLOBAL transient
            // slot, and its lock guards "is anything unlocked", not "is the caller
            // the unlocker" — so the caller-chosen token we just called could have
            // re-synced it and pointed this credit at something else. It also
            // catches a fee-on-transfer skim and a rebase, which would otherwise
            // surface as an anonymous CurrencyNotSettled from the singleton with
            // nothing for the worker to quarantine on.
            if (paid != owed) revert SettleMismatch(owed, paid);
        }
        if (received > 0) {
            // The whole point of the contract is this argument being `c.account`.
            poolManager.take(c.tokenOut, c.account, received);
        }

        // The PoolManager's delta describes its nominal transfer, not what a
        // taxed/rebasing token actually credited. Enforce the signed floor on
        // the account's net increase and report that same delivered amount.
        uint256 outputAfter = IERC20Minimal(c.tokenOut).balanceOf(c.account);
        if (outputAfter < outputBefore) revert InsufficientOutput();
        uint256 delivered = outputAfter - outputBefore;
        if (delivered < c.minAmountOut) revert InsufficientOutput();
        if (delivered == 0) revert NoOutput();

        return abi.encode(owed, delivered);
    }

    /**
     * @dev transferFrom that tolerates the non-standard ERC-20s this chain's
     * memecoins are full of: success with no return data is accepted, a `false`
     * return or a short return is not. Straight from the caller to the
     * PoolManager — this contract is never the recipient, so it never holds a
     * balance that a later call could spend.
     */
    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok) revert TransferFromFailed();
        // Decoded as a uint, not a bool: abi.decode(..., (bool)) runs solc's bool
        // validator, which does a bare revert(0,0) on a word that is neither 0 nor 1
        // rather than yielding false — so a dirty-word token would fail with an
        // EMPTY revert, indistinguishable from out-of-gas, and could not be
        // quarantined by error selector. Same semantics as SafeERC20.
        if (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) == 0)) revert TransferFromFailed();
    }
}
