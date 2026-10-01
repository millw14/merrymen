// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey, SwapParams} from "../interfaces/IUniswapV4Minimal.sol";

/**
 * @title V4Mocks
 * @notice Test doubles for V4SelfSwap. TEST-ONLY — never deployed to a network.
 *
 * The real PoolManager is a 24kB singleton with transient accounting we cannot
 * stand up in a unit test, so MockPoolManager reproduces only the three things
 * V4SelfSwap actually depends on: the unlock/callback handshake, the sync →
 * transfer → settle credit measurement, and take(). It is deliberately NOT a
 * faithful v4 implementation; the parts that matter about the real one (delta
 * signs, exact-input convention, BalanceDelta packing) were verified against
 * Robinhood Chain mainnet directly and are pinned by the design notes.
 *
 * What these mocks exist to prove is the half that is OURS: that the adapter
 * pays from the caller, delivers to the caller, keeps nothing, refuses a
 * mis-settle, refuses an empty fill, and cannot be re-entered.
 */

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IUnlockCallbackLike {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/** A plain ERC-20 that returns true. */
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/** The USDT shape: returns NO data at all. Must still be accepted. */
contract MockNoReturnERC20 is MockERC20 {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            return(0, 0)
        }
    }
}

/** Returns a word that is neither 0 nor 1 — must be treated as success, not bare-revert. */
contract MockDirtyBoolERC20 is MockERC20 {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/** Skims a fee on transfer, so less arrives than was asked for. */
contract MockFeeOnTransferERC20 is MockERC20 {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount / 100); // 1% skim, burned
        return true;
    }
}

/** Taxes the PoolManager's output transfer, unlike the input-only mock above. */
contract MockOutputTaxERC20 is MockERC20 {
    uint256 public taxBps = 100;

    function setTaxBps(uint256 value) external {
        require(value <= 10_000);
        taxBps = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount - amount * taxBps / 10_000;
        return true;
    }
}

/**
 * A minimal PoolManager. `nextDelta0`/`nextDelta1` are set by the test to say
 * what the "pool" will return, so each case can be driven exactly.
 */
contract MockPoolManager {
    int128 public nextDelta0;
    int128 public nextDelta1;
    address private synced;
    uint256 private syncedBalanceBefore;
    /// Set to re-enter the adapter during settle, to prove the guard works.
    address public reenterTarget;
    bytes public reenterCalldata;

    function setNextDelta(int128 d0, int128 d1) external {
        nextDelta0 = d0;
        nextDelta1 = d1;
    }

    function setReentry(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterCalldata = data;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallbackLike(msg.sender).unlockCallback(data);
    }

    /// Same signature the adapter calls. The mock ignores the key and returns
    /// whatever delta the test set, so each case is driven exactly.
    function swap(PoolKey calldata, SwapParams calldata, bytes calldata) external view returns (int256) {
        return (int256(nextDelta0) << 128) | int256(uint256(uint128(nextDelta1)));
    }

    function sync(address currency) external {
        synced = currency;
        syncedBalanceBefore = IERC20Like(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (reenterTarget != address(0)) {
            (bool ok,) = reenterTarget.call(reenterCalldata);
            ok; // result inspected by the test through the outer revert
        }
        paid = IERC20Like(synced).balanceOf(address(this)) - syncedBalanceBefore;
    }

    function take(address currency, address to, uint256 amount) external {
        IERC20Like(currency).transfer(to, amount);
    }
}
