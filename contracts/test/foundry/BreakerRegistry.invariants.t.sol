// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BreakerRegistry} from "src/BreakerRegistry.sol";

/**
 * @title BreakerRegistryHandler
 * @notice Fuzz driver for BreakerRegistry invariant testing. All state-changing
 * calls go through this handler with the CORRECT caller (keeper reports, owner
 * halts/resets, anyone trips), so the fuzzer explores the real state machine
 * instead of bouncing off access control.
 *
 * Ghosts track what the invariants assert against:
 *   - lastHwm:       highest HWM observed (only owner reset-rebase may lower it)
 *   - pendingTrips:  trips not yet matched by an owner reset
 *   - lastTripCause: what caused the most recent trip (DRAWDOWN or HALT)
 *   - ddAtTrip:      drawdownBps at the moment of that trip
 */
contract BreakerRegistryHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    enum TripCause {
        NONE,
        DRAWDOWN,
        HALT
    }

    BreakerRegistry public registry;
    address public owner;
    address public keeper;
    address public agent;
    uint16 public threshold;

    uint128 public lastHwm;
    uint256 public pendingTrips;
    TripCause public lastTripCause;
    uint256 public ddAtTrip;

    bool private _wasTripped;

    constructor(BreakerRegistry _registry, address _owner, address _keeper, address _agent, uint16 _threshold) {
        registry = _registry;
        owner = _owner;
        keeper = _keeper;
        agent = _agent;
        threshold = _threshold;
        lastHwm = _registry.get(agent).hwmUsdg;
    }

    /// @notice Report equity as keeper, owner, or a stranger (reverts are fine).
    function reportEquity(uint128 equity) external {
        address caller = (uint160(equity) % 3 == 0) ? owner : (uint160(equity) % 3 == 1) ? keeper : agent;
        vm.prank(caller);
        try registry.reportEquity(agent, equity) {} catch {}
        _sync(TripCause.DRAWDOWN);
    }

    /// @notice Permissionless trip — reverts unless stored data supports it.
    function trip() external {
        vm.prank(agent);
        try registry.trip(agent) {} catch {}
        _sync(TripCause.DRAWDOWN);
    }

    /// @notice Owner-only manual halt (no drawdown precondition by design).
    function haltByOwner() external {
        vm.prank(owner);
        registry.halt(agent);
        _sync(TripCause.HALT);
    }

    /// @notice Owner-only reset; rebaseHwm restarts the peak at current equity.
    function reset(bool rebaseHwm) external {
        vm.prank(owner);
        registry.reset(agent, rebaseHwm);
        if (pendingTrips > 0) pendingTrips--;
        if (rebaseHwm) lastHwm = registry.get(agent).hwmUsdg; // accept the rebase
        _sync(TripCause.NONE);
    }

    function _sync(TripCause cause) internal {
        BreakerRegistry.Breaker memory b = registry.get(agent);
        if (b.hwmUsdg > lastHwm) lastHwm = b.hwmUsdg;
        if (b.tripped && !_wasTripped) {
            pendingTrips++;
            if (cause != TripCause.NONE) {
                lastTripCause = cause;
                ddAtTrip = registry.drawdownBps(agent);
            }
        }
        _wasTripped = b.tripped;
    }
}

/**
 * @title BreakerRegistryInvariants
 * @notice Invariant tests for BreakerRegistry. Properties that must ALWAYS
 * hold, verified across random sequences of calls through the handler.
 *
 * Invariants tested:
 *   INV-1: HWM never decreases, except by the owner's explicit reset-rebase
 *   INV-2: Once tripped, stays tripped until an owner reset
 *   INV-3: A drawdown-caused trip must have been backed by the threshold
 *   INV-4: Drawdown never exceeds 100%
 */
contract BreakerRegistryInvariants is Test {
    BreakerRegistry public registry;
    BreakerRegistryHandler public handler;
    address public owner;
    address public keeper;
    address public agent;

    uint16 constant THRESHOLD = 1000; // 10%

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

        // Fuzz THROUGH the handler, not at the registry directly
        handler = new BreakerRegistryHandler(registry, owner, keeper, agent, THRESHOLD);
        targetContract(address(handler));
    }

    /**
     * INV-1: HWM is monotonic except for owner reset-rebase.
     * The handler only ever lowers its ghost on reset(true); anything else
     * that drops the HWM below the observed peak is a violation.
     */
    function invariant_HwmNeverDecreases() public view {
        assertGe(registry.get(agent).hwmUsdg, handler.lastHwm(), "HWM decreased outside owner rebase");
    }

    /**
     * INV-2: Once tripped, the breaker stays tripped until an owner reset.
     * Every trip must be matched by a reset BEFORE the breaker is allowed to
     * read untripped. A trip that untrips without a reset is a violation.
     */
    function invariant_TripIsStickyUntilOwnerReset() public view {
        if (handler.pendingTrips() > 0) {
            assertTrue(registry.isTripped(agent), "breaker untripped without owner reset");
        }
    }

    /**
     * INV-3: A drawdown-caused trip must have been backed by the threshold.
     * The owner can halt with no drawdown (by design, cause = HALT), but no
     * other path may trip the breaker below the configured threshold.
     */
    function invariant_TripRequiresDrawdownOrHalt() public view {
        if (handler.lastTripCause() == BreakerRegistryHandler.TripCause.NONE) return;
        if (handler.lastTripCause() == BreakerRegistryHandler.TripCause.HALT) return; // owner halt is legal
        assertGe(handler.ddAtTrip(), handler.threshold(), "tripped below threshold without owner halt");
    }

    /**
     * INV-4: Drawdown is bounded at 100%.
     */
    function invariant_DrawdownBpsBounded() public view {
        assertLe(registry.drawdownBps(agent), 10_000, "drawdown exceeds 100%");
    }
}
