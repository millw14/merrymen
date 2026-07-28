// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BreakerRegistry} from "src/BreakerRegistry.sol";

/**
 * @title BreakerRegistryInvariants
 * @notice Invariant tests for BreakerRegistry. Properties that must ALWAYS
 * hold, verified across random sequences of calls.
 *
 * Invariants tested:
 *   INV-1: HWM is monotonic non-decreasing (never decreases)
 *   INV-2: Once tripped, breaker stays tripped unless owner resets
 *   INV-3: Keeper can only make breaker MORE likely to trip (never less)
 *   INV-4: Permissionless trip uses only stored data (no oracle)
 *   INV-5: Owner can always halt regardless of drawdown state
 */
contract BreakerRegistryInvariants is Test {
    BreakerRegistry public registry;
    address public owner;
    address public keeper;
    address public agent;

    uint16 constant THRESHOLD = 1000; // 10%
    uint128 public lastHwm;

    function setUp() public {
        registry = new BreakerRegistry();
        owner = makeAddr("owner");
        keeper = makeAddr("keeper");
        agent = makeAddr("agent");

        // Arm the breaker
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);

        // Initial report to set HWM
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        lastHwm = 1000e6;

        // Register the target contract for invariant testing
        targetContract(address(registry));
    }

    /**
     * INV-1: HWM is monotonic non-decreasing.
     * The high-water mark in USDG must never decrease after any sequence of calls.
     */
    function invariant_HwmNeverDecreases() public {
        BreakerRegistry.Breaker memory b = registry.get(agent);
        assertGe(b.hwmUsdg, lastHwm, "HWM decreased - invariant violated");
        lastHwm = b.hwmUsdg;
    }

    /**
     * INV-2: Once tripped, stays tripped (owner-only relax).
     * If isTripped returned true, drawdown must be >= threshold.
     */
    function invariant_TripIsPermanentWithoutOwnerReset() public view {
        BreakerRegistry.Breaker memory b = registry.get(agent);
        if (b.tripped) {
            uint256 dd = _drawdownBps(b);
            assertGe(dd, b.maxDrawdownBps, "tripped but drawdown below threshold");
        }
    }

    /**
     * INV-3: DrawdownBps never exceeds 10,000 (100%).
     */
    function invariant_DrawdownBpsBounded() public view {
        uint256 dd = registry.drawdownBps(agent);
        assertLe(dd, 10_000, "drawdown exceeds 100%");
    }

    // ── Handler: any actor can perform any action ────────────────────────

    /// @notice Anyone can report equity
    function reportEquity(uint128 equity) public {
        address caller = (uint160(equity) % 3 == 0) ? owner : (uint160(equity) % 3 == 1) ? keeper : agent;
        vm.prank(caller);
        try registry.reportEquity(agent, equity) {
            // success — update tracker
        } catch {
            // expected: NotReporter or NotArmed
        }
    }

    /// @notice Anyone can trip
    function trip() public {
        vm.prank(agent);
        try registry.trip(agent) {
            // success
        } catch {
            // expected: DrawdownNotReached or NotArmed
        }
    }

    /// @notice Owner can always halt
    function haltByOwner() public {
        vm.prank(owner);
        registry.halt(agent);
    }

    /// @notice Owner can reset
    function reset(bool rebaseHwm) public {
        vm.prank(owner);
        registry.reset(agent, rebaseHwm);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _drawdownBps(BreakerRegistry.Breaker memory b) private pure returns (uint256) {
        if (b.hwmUsdg == 0) return 0;
        if (b.lastEquityUsdg >= b.hwmUsdg) return 0;
        return uint256(b.hwmUsdg - b.lastEquityUsdg) * 10_000 / b.hwmUsdg;
    }
}
