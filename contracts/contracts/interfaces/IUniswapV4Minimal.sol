// contracts/contracts/interfaces/IUniswapV4Minimal.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice Uniswap v4 core, hand-written and cut to the four calls one spot swap
 * needs. There is no @uniswap/v4-core dependency in this package on purpose —
 * the house style (see IPolicy.sol) is a minimal mirrored interface, and pulling
 * v4-core in would drag Currency/BalanceDelta/PoolId user-defined value types,
 * TickMath, and a second solc pragma range into a contract that holds money.
 *
 * WHERE THE TYPES WENT. v4-core declares `type Currency is address` and
 * `type BalanceDelta is int256`. User-defined value types are erased in the ABI
 * — the canonical signature uses the UNDERLYING type — so declaring them here as
 * `address` and `int256` produces byte-identical selectors and calldata. Same for
 * `PoolId`/`bytes32`. This is checked, not assumed: the selectors below are
 * pinned in the test plan and the fork test calls the real PoolManager.
 *
 * SELECTORS (computed from these declarations, and they match v4-core):
 *   unlock(bytes)                       0x48c89491
 *   swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes)
 *                                       0xf3cd914c
 *   sync(address)                       0xa5841194
 *   settle()                            0x11da60b4
 *   take(address,address,uint256)       0x0b0d9c09
 *   unlockCallback(bytes)               0x91dd7346
 */

/// @notice v4's pool identity. Hashed by the PoolManager into a poolId; there is
/// no factory and no registry, so the caller must supply the whole key.
/// `currency0 < currency1` is an invariant of every initialized pool.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice v4-core `SwapParams`. NOTE the sign convention on `amountSpecified`:
/// NEGATIVE means EXACT INPUT (the opposite of v3). Getting this backwards does
/// not fail loudly — it executes an exact-OUTPUT swap for the number you meant
/// as an input, against a minOut nobody computed.
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    /// @notice Take the singleton's lock and call `unlockCallback` back on the
    /// caller. Reverts if already unlocked (so this cannot nest), and reverts at
    /// the end if any currency delta is still non-zero.
    function unlock(bytes calldata data) external returns (bytes memory);

    /// @dev Returns v4's `BalanceDelta`: two int128s packed into one int256,
    /// amount0 in the HIGH 128 bits, amount1 in the LOW 128 bits. Positive = the
    /// PoolManager owes the caller; negative = the caller owes the PoolManager.
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 delta);

    /// @notice Snapshot the PoolManager's balance of `currency` so the following
    /// `settle()` can measure what actually arrived. Must be called immediately
    /// before the transfer in.
    function sync(address currency) external;

    /// @notice Credit the caller with (balance now − balance at sync).
    function settle() external payable returns (uint256 paid);

    /// @notice Pay out a credit. `to` is where the tokens land.
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice ERC-20 calls used to settle input and verify actual output delivery.
/// transferFrom's return value is deliberately declared — see V4SelfSwap._pull
/// for how a missing one is handled.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
