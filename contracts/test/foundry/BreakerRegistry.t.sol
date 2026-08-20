// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BreakerRegistry} from "src/BreakerRegistry.sol";

contract BreakerRegistryTest is Test {
    BreakerRegistry public registry;
    address public owner;
    address public keeper;
    address public stranger;
    address public agent;

    uint16 constant THRESHOLD = 1000; // 10%

    event Armed(address indexed account, address indexed owner, address keeper, uint16 maxDrawdownBps);
    event KeeperSet(address indexed account, address keeper);
    event ThresholdSet(address indexed account, uint16 maxDrawdownBps);
    event EquityReported(address indexed account, uint128 equityUsdg, uint128 hwmUsdg);
    event Tripped(address indexed account, uint128 equityUsdg, uint128 hwmUsdg, uint256 drawdownBps);
    event Reset(address indexed account, bool hwmRebased);

    function setUp() public {
        registry = new BreakerRegistry();
        owner = makeAddr("owner");
        keeper = makeAddr("keeper");
        stranger = makeAddr("stranger");
        agent = makeAddr("agent");
    }

    // ── Arm ──────────────────────────────────────────────────────────────

    function test_Arm_SetsOwnerAndKeeper() public {
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);

        BreakerRegistry.Breaker memory b = registry.get(agent);
        assertEq(b.owner, owner);
        assertEq(b.keeper, keeper);
        assertEq(b.maxDrawdownBps, THRESHOLD);
        assertFalse(b.tripped);
    }

    function test_Arm_RevertsOnSecondCall() public {
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.AlreadyArmed.selector);
        registry.arm(agent, keeper, 500);
    }

    function test_Arm_RevertsOnZeroThreshold() public {
        vm.expectRevert(BreakerRegistry.BadThreshold.selector);
        registry.arm(agent, keeper, 0);
    }

    function test_Arm_RevertsOnOverMaxThreshold() public {
        vm.expectRevert(BreakerRegistry.BadThreshold.selector);
        registry.arm(agent, keeper, 10_001);
    }

    function test_Arm_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit Armed(agent, owner, keeper, THRESHOLD);
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);
    }

    function test_Arm_AllowsDifferentCallers(address caller) public {
        vm.assume(caller != address(0));
        vm.prank(caller);
        registry.arm(agent, keeper, THRESHOLD);
        assertEq(registry.get(agent).owner, caller);
    }

    // ── SetKeeper ────────────────────────────────────────────────────────

    function test_SetKeeper_OnlyOwner() public {
        _arm();
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.NotOwner.selector);
        registry.setKeeper(agent, stranger);
    }

    function test_SetKeeper_Updates() public {
        _arm();
        vm.prank(owner);
        registry.setKeeper(agent, stranger);
        assertEq(registry.get(agent).keeper, stranger);
    }

    // ── SetThreshold ─────────────────────────────────────────────────────

    function test_SetThreshold_OnlyOwner() public {
        _arm();
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.NotOwner.selector);
        registry.setThreshold(agent, 2000);
    }

    function test_SetThreshold_RejectsBadValues(uint16 bps) public {
        vm.assume(bps == 0 || bps > 10_000);
        _arm();
        vm.prank(owner);
        vm.expectRevert(BreakerRegistry.BadThreshold.selector);
        registry.setThreshold(agent, bps);
    }

    function test_SetThreshold_Updates(uint16 bps) public {
        vm.assume(bps > 0 && bps <= 10_000);
        _arm();
        vm.prank(owner);
        registry.setThreshold(agent, bps);
        assertEq(registry.get(agent).maxDrawdownBps, bps);
    }

    // ── ReportEquity ─────────────────────────────────────────────────────

    function test_ReportEquity_Keeper() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 1000e6);
    }

    function test_ReportEquity_Owner() public {
        _arm();
        vm.prank(owner);
        registry.reportEquity(agent, 1000e6);
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 1000e6);
    }

    function test_ReportEquity_RevertsStranger() public {
        _arm();
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.NotReporter.selector);
        registry.reportEquity(agent, 1000e6);
    }

    function test_ReportEquity_RevertsUnarmed() public {
        vm.expectRevert(BreakerRegistry.NotArmed.selector);
        registry.reportEquity(agent, 1000e6);
    }

    function test_ReportEquity_RatchetsHwmUp() public {
        _arm();
        vm.startPrank(keeper);
        registry.reportEquity(agent, 1000e6);
        registry.reportEquity(agent, 500e6);  // -50%, HWM stays at 1000
        vm.stopPrank();
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 1000e6);
    }

    function test_ReportEquity_HwmNeverDecreases() public {
        _arm();
        vm.startPrank(keeper);
        registry.reportEquity(agent, 500e6);   // HWM = 500
        registry.reportEquity(agent, 1000e6);  // HWM = 1000
        registry.reportEquity(agent, 700e6);   // HWM stays 1000
        vm.stopPrank();
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 1000e6);
    }

    function test_ReportEquity_DoesNotTripBelowThreshold() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 950e6); // -5% < 10%
        assertFalse(registry.isTripped(agent));
    }

    function test_ReportEquity_TripsAtThresholdExact() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 900e6); // -10% == threshold
        assertTrue(registry.isTripped(agent));
    }

    function test_ReportEquity_TripsAboveThreshold() public {
        _armWithThreshold(500); // 5%
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 920e6); // -8% > 5%
        assertTrue(registry.isTripped(agent));
    }

    function test_ReportEquity_EmitsTrippedEvent() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.expectEmit(true, true, true, true);
        emit Tripped(agent, 900e6, 1000e6, 1000);
        vm.prank(keeper);
        registry.reportEquity(agent, 900e6);
    }

    // ── Trip (permissionless) ────────────────────────────────────────────

    function test_Trip_PermissionlessWhenDataSupports() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 500e6); // -50% but threshold is 10%
        vm.prank(owner);
        registry.setThreshold(agent, 4000); // 40% — data shows 50%
        vm.prank(stranger);
        registry.trip(agent);
        assertTrue(registry.isTripped(agent));
    }

    function test_Trip_RevertsIfDrawdownInsufficient() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 950e6); // -5% < 10%
        vm.expectRevert(BreakerRegistry.DrawdownNotReached.selector);
        vm.prank(stranger);
        registry.trip(agent);
    }

    function test_Trip_RevertsIfUnarmed() public {
        vm.expectRevert(BreakerRegistry.NotArmed.selector);
        registry.trip(agent);
    }

    // ── Halt (owner only) ────────────────────────────────────────────────

    function test_Halt_OwnerOnly() public {
        _arm();
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.NotOwner.selector);
        registry.halt(agent);
    }

    function test_Halt_TripsWithoutDrawdown() public {
        _arm();
        vm.prank(owner);
        registry.halt(agent);
        assertTrue(registry.isTripped(agent));
    }

    function test_Halt_Idempotent() public {
        _arm();
        vm.prank(owner);
        registry.halt(agent);
        vm.prank(owner);
        registry.halt(agent); // should not revert
        assertTrue(registry.isTripped(agent));
    }

    // ── Reset (owner only) ──────────────────────────────────────────────

    function test_Reset_OnlyOwner() public {
        _arm();
        vm.prank(stranger);
        vm.expectRevert(BreakerRegistry.NotOwner.selector);
        registry.reset(agent, false);
    }

    function test_Reset_Untrips() public {
        _arm();
        vm.prank(owner);
        registry.halt(agent);
        assertTrue(registry.isTripped(agent));
        vm.prank(owner);
        registry.reset(agent, false);
        assertFalse(registry.isTripped(agent));
    }

    function test_Reset_RebasesHwm() public {
        _arm();
        vm.startPrank(keeper);
        registry.reportEquity(agent, 1000e6);
        registry.reportEquity(agent, 500e6); // HWM = 1000, equity = 500
        vm.stopPrank();
        vm.prank(owner);
        registry.reset(agent, true);
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 500e6);
    }

    function test_Reset_NoRebaseKeepsHwm() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 500e6);
        vm.prank(owner);
        registry.reset(agent, false);
        (,,, uint128 hwm,,) = _breaker();
        assertEq(hwm, 1000e6);
    }

    // ── DrawdownBps ──────────────────────────────────────────────────────

    function test_DrawdownBps_ZeroWhenNoEquity() public {
        _arm();
        assertEq(registry.drawdownBps(agent), 0);
    }

    function test_DrawdownBps_ZeroWhenAtHwm() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        assertEq(registry.drawdownBps(agent), 0);
    }

    function test_DrawdownBps_ComputesCorrectly() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 750e6); // -25%
        assertEq(registry.drawdownBps(agent), 2500); // 25%
    }

    function test_DrawdownBps_Precision(uint128 hwm, uint128 equity) public {
        vm.assume(hwm > 0 && hwm <= 1_000_000e6);
        vm.assume(equity < hwm);
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, hwm);
        vm.prank(keeper);
        registry.reportEquity(agent, equity);
        // drawdownBps must equal the formula exactly, not merely be bounded
        uint256 expected = (uint256(hwm) - equity) * 10_000 / hwm;
        assertEq(registry.drawdownBps(agent), expected);
    }

    // ── Fuzz: report equity with random values ───────────────────────────

    function testFuzz_RandomReports_RatchetsHwm(uint128[] calldata equities) public {
        vm.assume(equities.length > 0 && equities.length <= 100);
        _arm();
        uint128 maxSeen = 0;
        vm.startPrank(keeper);
        for (uint i = 0; i < equities.length; i++) {
            registry.reportEquity(agent, equities[i]);
            if (equities[i] > maxSeen) maxSeen = equities[i];
            (,,, uint128 hwm,,) = _breaker();
            assertEq(hwm, maxSeen);
        }
        vm.stopPrank();
    }

    function testFuzz_RandomReports_TripIsPermanent(uint128[] calldata equities) public {
        vm.assume(equities.length > 0 && equities.length <= 50);
        _armWithThreshold(2000); // 20%
        bool everTripped = false;
        uint128 max = 0;
        vm.startPrank(keeper);
        for (uint i = 0; i < equities.length; i++) {
            registry.reportEquity(agent, equities[i]);
            if (equities[i] > max) max = equities[i];
            if (!everTripped) {
                // Trip condition: (max - equity) * 10_000 / max >= 2000
                if (max > 0 && (uint256(max - equities[i]) * 10_000) / max >= 2000) {
                    everTripped = true;
                    assertTrue(registry.isTripped(agent));
                } else {
                    // Two-sided: a spuriously-tripping contract must fail here
                    assertFalse(registry.isTripped(agent), "tripped below threshold");
                }
            }
            if (everTripped) {
                assertTrue(registry.isTripped(agent), "once tripped, always tripped");
            }
        }
        vm.stopPrank();
    }

    // ── Invariant helpers ────────────────────────────────────────────────

    function test_KeeperCannotUntrip() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(agent, 800e6); // -20% > 10% → tripped
        assertTrue(registry.isTripped(agent));

        // Keeper reports higher equity — should NOT untrip
        vm.prank(keeper);
        registry.reportEquity(agent, 2000e6);
        assertTrue(registry.isTripped(agent), "keeper can't untrip");
    }

    function test_OwnerCanTripRegardlessOfData() public {
        _arm();
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6); // HWM = 1000, equity = 1000
        assertEq(registry.drawdownBps(agent), 0);
        vm.prank(owner);
        registry.halt(agent);
        assertTrue(registry.isTripped(agent));
    }

    function test_PermissionlessTripReliesOnStoredData() public {
        _arm();
        // Only 1 report: HWM = 1000, equity = 1000, drawdown = 0
        vm.prank(keeper);
        registry.reportEquity(agent, 1000e6);
        vm.expectRevert(BreakerRegistry.DrawdownNotReached.selector);
        vm.prank(stranger);
        registry.trip(agent);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _arm() internal {
        vm.prank(owner);
        registry.arm(agent, keeper, THRESHOLD);
    }

    function _armWithThreshold(uint16 bps) internal {
        vm.prank(owner);
        registry.arm(agent, keeper, bps);
    }

    function _breaker() internal view returns (
        address owner_,
        address keeper_,
        uint16 maxDrawdownBps_,
        uint128 hwmUsdg_,
        uint128 lastEquityUsdg_,
        bool tripped_
    ) {
        BreakerRegistry.Breaker memory b = registry.get(agent);
        return (b.owner, b.keeper, b.maxDrawdownBps, b.hwmUsdg, b.lastEquityUsdg, b.tripped);
    }
}
