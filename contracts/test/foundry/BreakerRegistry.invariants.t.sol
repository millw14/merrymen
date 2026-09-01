// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BreakerRegistry} from "src/BreakerRegistry.sol";

/**
 * @title BreakerRegistryHandler
 * @notice Fuzz driver for BreakerRegistry invariant testing. All state-changing
 * calls go through this handler with the CORRECT caller (keeper reports, owner
 * halts/resets/setThreshold/setKeeper, anyone trips), so the fuzzer explores the
 * real state machine instead of bouncing off access control.
 *
 * The handler maintains its OWN shadow state — expectedHwm / expectedEquity /
 * expectedTripped / threshold / keeper — computed from the fuzzed inputs, NOT
 * read back from the registry. The invariant suite asserts equality between the
 * shadow and the contract after every action. A ghost that can only echo the
 * contract is not a second source of truth; this one is.
 *
 * Trip ledger: every trip since the last owner reset is recorded with the cause,
 * the drawdown at trip time and the threshold in force at trip time, so INV-3
 * judges each trip against the threshold that was actually live when it fired
 * (threshold changes mid-flight can't mask or falsely condemn a trip).
 */
contract BreakerRegistryHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    enum TripCause {
        NONE,
        DRAWDOWN,
        HALT
    }

    struct TripRecord {
        TripCause cause;
        uint256 ddBps; // drawdownBps at trip time (meaningful for DRAWDOWN)
        uint256 thresholdBps; // maxDrawdownBps in force at trip time
    }

    BreakerRegistry public registry;
    address public owner;
    address public keeper;
    address public stranger;
    address public agent;
    address public agentB; // second account for cross-account isolation

    // ── Shadow state: the second source of truth ────────────────────────
    uint128 public expectedHwm;
    uint128 public expectedEquity;
    bool public expectedTripped;
    uint16 public threshold; // mirrors maxDrawdownBps
    address public expectedKeeper; // mirrors keeper

    // Second-account shadow (isolation coverage)
    uint128 public expectedHwmB;
    uint128 public expectedEquityB;
    bool public expectedTrippedB;

    // Every trip since the last reset, with context
    TripRecord[] public trips;

    constructor(
        BreakerRegistry _registry,
        address _owner,
        address _keeper,
        address _stranger,
        address _agent,
        address _agentB
    ) {
        registry = _registry;
        owner = _owner;
        keeper = _keeper;
        stranger = _stranger;
        agent = _agent;
        agentB = _agentB;
        expectedKeeper = _keeper;
        // Seed the shadow from the armed + pre-reported state set up in setUp()
        BreakerRegistry.Breaker memory b = _registry.get(_agent);
        threshold = b.maxDrawdownBps;
        expectedHwm = b.hwmUsdg;
        expectedEquity = b.lastEquityUsdg;
        expectedTripped = b.tripped;
    }

    /// @notice Report equity. Caller is chosen independently of the value
    /// (70% keeper, 20% owner, 10% stranger) so no slice of the equity domain
    /// is excluded by the caller selector, and equity is bounded into the band
    /// the breaker exists to police — with extra density near the threshold.
    function reportEquity(uint128 rawEquity, uint256 callerKind) external {
        uint128 equity = _boundEquity(rawEquity, expectedHwm);
        vm.prank(_reporter(callerKind));
        try registry.reportEquity(agent, equity) {
            expectedEquity = equity;
            if (equity > expectedHwm) expectedHwm = equity;
            if (!expectedTripped && _expectedDd() >= threshold) {
                _recordTrip(TripCause.DRAWDOWN);
            }
        } catch {}
    }

    /// @notice Permissionless trip — reverts unless stored data supports it.
    function trip() external {
        vm.prank(stranger);
        try registry.trip(agent) {
            if (!expectedTripped && _expectedDd() >= threshold) {
                _recordTrip(TripCause.DRAWDOWN);
            }
        } catch {}
    }

    /// @notice Owner-only manual halt (no drawdown precondition by design).
    function haltByOwner() external {
        vm.prank(owner);
        registry.halt(agent); // never reverts for the owner
        if (!expectedTripped) _recordTrip(TripCause.HALT);
    }

    /// @notice Owner-only reset; rebaseHwm restarts the peak at current equity.
    /// Direct call (no try/catch): a mutant that breaks reset reverts the
    /// handler call, and fail_on_revert turns that into a failed run.
    function reset(bool rebaseHwm) external {
        vm.prank(owner);
        registry.reset(agent, rebaseHwm);
        expectedTripped = false;
        delete trips;
        if (rebaseHwm) expectedHwm = expectedEquity;
    }

    /// @notice Owner-only threshold change; shadow must follow in the same
    /// action or INV-3 would judge old trips against the new threshold.
    function setThreshold(uint16 bps) external {
        vm.prank(owner);
        try registry.setThreshold(agent, bps) {
            threshold = bps;
        } catch {}
    }

    /// @notice Owner-only keeper rotation; reports then prank the new keeper.
    function setKeeper(address newKeeper) external {
        vm.prank(owner);
        try registry.setKeeper(agent, newKeeper) {
            expectedKeeper = newKeeper;
        } catch {}
    }

    /// @notice Arm a second account (arm is otherwise never fuzzed).
    function armSecond() external {
        vm.prank(owner);
        try registry.arm(agentB, keeper, 500) {
            expectedHwmB = 0;
            expectedEquityB = 0;
            expectedTrippedB = false;
        } catch {}
    }

    /// @notice Report on the second account — proves ops on B never touch A.
    function reportSecond(uint128 rawEquity) external {
        uint128 equity = _boundEquity(rawEquity, expectedHwmB);
        vm.prank(expectedKeeper);
        try registry.reportEquity(agentB, equity) {
            expectedEquityB = equity;
            if (equity > expectedHwmB) expectedHwmB = equity;
            if (!expectedTrippedB && _expectedDdB() >= 500) expectedTrippedB = true;
        } catch {}
    }

    // ── Accessors for invariants ─────────────────────────────────────────

    function tripsLength() external view returns (uint256) {
        return trips.length;
    }

    function tripAt(uint256 i) external view returns (TripCause cause, uint256 ddBps, uint256 thresholdBps) {
        TripRecord storage t = trips[i];
        return (t.cause, t.ddBps, t.thresholdBps);
    }

    function expectedDrawdownBps() external view returns (uint256) {
        return _expectedDd();
    }

    // ── Internals ────────────────────────────────────────────────────────

    function _boundEquity(uint128 raw, uint128 hwmRef) internal pure returns (uint128) {
        uint256 maxEquity = hwmRef == 0 ? 2000e6 : uint256(hwmRef) * 2;
        uint128 equity = uint128(uint256(raw) % (maxEquity + 1));
        // 1 in 4 calls: sample the band around the HWM densely, so the
        // threshold boundary [hwm*70/100, hwm*110/100] gets real coverage.
        if (hwmRef > 0 && uint256(keccak256(abi.encode(raw))) % 4 == 0) {
            uint256 lo = uint256(hwmRef) * 70 / 100;
            uint256 hi = uint256(hwmRef) * 110 / 100;
            equity = uint128(lo + uint256(raw) % (hi - lo + 1));
        }
        return equity;
    }

    function _reporter(uint256 callerKind) internal view returns (address) {
        uint256 kind = callerKind % 10;
        if (kind < 7) return expectedKeeper;
        if (kind < 9) return owner;
        return stranger;
    }

    function _expectedDd() internal view returns (uint256) {
        if (expectedHwm == 0) return 0;
        if (expectedEquity >= expectedHwm) return 0;
        return (uint256(expectedHwm - expectedEquity) * 10_000) / expectedHwm;
    }

    function _expectedDdB() internal view returns (uint256) {
        if (expectedHwmB == 0) return 0;
        if (expectedEquityB >= expectedHwmB) return 0;
        return (uint256(expectedHwmB - expectedEquityB) * 10_000) / expectedHwmB;
    }

    function _recordTrip(TripCause cause) internal {
        expectedTripped = true;
        trips.push(TripRecord(cause, _expectedDd(), threshold));
    }
}

/**
 * @title BreakerRegistryInvariants
 * @notice Invariant tests for BreakerRegistry. Properties that must ALWAYS
 * hold, verified across random sequences of calls through the handler.
 *
 * The shadow-equality invariants (Hwm/Equity/Tripped/DrawdownMatchesShadow)
 * are the core: the handler's ghost is computed from fuzzed inputs, so the
 * contract can never satisfy them by agreeing with itself. A BreakerRegistry
 * that can never trip (M20), resets to the wrong HWM (M1), trips at the wrong
 * threshold (M4), halves its drawdown math (M6), ignores trips/halts/resets
 * (M10/M11/M12) or untrips without a reset all violate one of them.
 *
 * Invariants tested:
 *   INV-1  HWM/equity/tripped/drawdown match the handler's shadow state
 *   INV-2  Once tripped, stays tripped until an owner reset
 *   INV-3  Every drawdown trip was backed by the threshold in force at trip time
 *   INV-4  Drawdown never exceeds 100%
 *   INV-5  Ops on a second account never disturb the first
 */
contract BreakerRegistryInvariants is Test {
    BreakerRegistry public registry;
    BreakerRegistryHandler public handler;
    address public owner;
    address public keeper;
    address public stranger;
    address public agent;

    uint16 constant THRESHOLD = 1000; // 10%

    function setUp() public {
        registry = new BreakerRegistry();
        owner = makeAddr("owner");
        keeper = makeAddr("keeper");
        stranger = makeAddr("stranger");
        agent = makeAddr("agent");

        // Arm the breaker
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);

        // Initial report to set HWM
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);

        // Fuzz THROUGH the handler, not at the registry directly
        handler = new BreakerRegistryHandler(registry, owner, keeper, stranger, agent, makeAddr("agentB"));
        targetContract(address(handler));
    }

    // ── INV-1: shadow equality (the second source of truth) ──────────────

    function invariant_HwmMatchesShadow() public view {
        assertEq(registry.get(agent).hwmUsdg, handler.expectedHwm(), "HWM drifted from shadow");
    }

    function invariant_EquityMatchesShadow() public view {
        assertEq(registry.get(agent).lastEquityUsdg, handler.expectedEquity(), "equity drifted from shadow");
    }

    function invariant_TrippedMatchesShadow() public view {
        assertEq(registry.isTripped(agent), handler.expectedTripped(), "tripped drifted from shadow");
    }

    function invariant_DrawdownMatchesShadow() public view {
        assertEq(registry.drawdownBps(agent), handler.expectedDrawdownBps(), "drawdown drifted from shadow");
    }

    // ── INV-2: once tripped, the breaker stays tripped until an owner reset ──

    function invariant_TripIsStickyUntilOwnerReset() public view {
        if (handler.tripsLength() > 0) {
            assertTrue(registry.isTripped(agent), "breaker untripped without owner reset");
        }
    }

    // ── INV-3: drawdown trips must be threshold-backed (threshold at trip time) ──

    function invariant_DrawdownTripsAreThresholdBacked() public view {
        uint256 n = handler.tripsLength();
        for (uint256 i = 0; i < n; i++) {
            (BreakerRegistryHandler.TripCause cause, uint256 ddBps, uint256 thresholdBps) = handler.tripAt(i);
            if (cause == BreakerRegistryHandler.TripCause.DRAWDOWN) {
                assertGe(ddBps, thresholdBps, "drawdown trip below the threshold in force");
            }
        }
    }

    // ── INV-4: drawdown is bounded at 100% ──────────────────────────────

    function invariant_DrawdownBpsBounded() public view {
        assertLe(registry.drawdownBps(agent), 10_000, "drawdown exceeds 100%");
        assertLe(handler.expectedDrawdownBps(), 10_000, "shadow drawdown exceeds 100%");
    }

    // ── INV-5: cross-account isolation ───────────────────────────────────

    function invariant_SecondAgentIsolation() public view {
        assertEq(registry.get(handler.agentB()).hwmUsdg, handler.expectedHwmB(), "agent B HWM drifted");
        assertEq(registry.get(handler.agentB()).lastEquityUsdg, handler.expectedEquityB(), "agent B equity drifted");
        assertEq(registry.isTripped(handler.agentB()), handler.expectedTrippedB(), "agent B tripped drifted");
    }
}
