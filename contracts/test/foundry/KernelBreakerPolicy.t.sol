// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BreakerRegistry} from "src/BreakerRegistry.sol";
import {KernelBreakerPolicy} from "src/KernelBreakerPolicy.sol";
import {PackedUserOperation} from "src/IPolicy.sol";

contract KernelBreakerPolicyTest is Test {
    BreakerRegistry public registry;
    KernelBreakerPolicy public policy;
    address public owner;
    address public keeper;
    address public wallet;

    bytes32 constant PERMISSION_ID = keccak256("merrymen.drawdown.breaker.v1");
    uint16 constant THRESHOLD = 1000; // 10%

    // Minimal PackedUserOperation for policy checks — contents irrelevant
    function _dummyUserOp() internal pure returns (PackedUserOperation memory) {
        return PackedUserOperation({
            sender: address(0),
            nonce: 0,
            initCode: hex"",
            callData: hex"",
            accountGasLimits: bytes32(0),
            preVerificationGas: 0,
            gasFees: bytes32(0),
            paymasterAndData: hex"",
            signature: hex""
        });
    }

    function setUp() public {
        registry = new BreakerRegistry();
        policy = new KernelBreakerPolicy();
        owner = makeAddr("owner");
        keeper = makeAddr("keeper");
        wallet = makeAddr("wallet");
    }

    // ── Install ──────────────────────────────────────────────────────────

    function _installData() internal view returns (bytes memory) {
        return abi.encodePacked(PERMISSION_ID, abi.encode(address(registry)));
    }

    function test_FailsClosedBeforeInstall() public {
        vm.prank(wallet);
        uint256 result = _checkPolicy();
        assertEq(result, 1);
    }

    function test_PassesAfterInstall() public {
        vm.prank(wallet);
        policy.onInstall(_installData());
        vm.prank(wallet);
        uint256 result = _checkPolicy();
        assertEq(result, 0);
    }

    function test_RevertsOnDoubleInstall() public {
        vm.prank(wallet);
        policy.onInstall(_installData());
        vm.prank(wallet);
        vm.expectRevert(KernelBreakerPolicy.PolicyAlreadyInstalled.selector);
        policy.onInstall(_installData());
    }

    function test_RevertsOnZeroRegistry() public {
        bytes memory badData = abi.encodePacked(PERMISSION_ID, abi.encode(address(0)));
        vm.prank(wallet);
        vm.expectRevert(KernelBreakerPolicy.ZeroRegistry.selector);
        policy.onInstall(badData);
    }

    // ── Uninstall ────────────────────────────────────────────────────────

    function test_UninstallFailsClosed() public {
        vm.prank(wallet);
        policy.onInstall(_installData());
        vm.prank(wallet);
        policy.onUninstall(_installData());
        vm.prank(wallet);
        uint256 result = _checkPolicy();
        assertEq(result, 1);
    }

    function test_UninstallRevertsIfNotLive() public {
        vm.prank(wallet);
        vm.expectRevert(KernelBreakerPolicy.PolicyNotLive.selector);
        policy.onUninstall(_installData());
    }

    // ── Integration: Breaker tripped → policy blocks ────────────────────

    function test_BlocksWhenBreakerTripped() public {
        _setupArmedAccount();

        // Pre-trip: passes
        vm.prank(wallet);
        assertEq(_checkPolicy(), 0);

        // Trip via keeper
        vm.prank(keeper);
        registry.reportEquity(wallet, 900e6); // -10% at HWM=1000

        // Post-trip: blocked
        vm.prank(wallet);
        assertEq(_checkPolicy(), 1);
    }

    function test_BlocksSignatureAndUserOpEqually() public {
        _setupArmedAccount();

        // Both pass before trip
        vm.prank(wallet);
        assertEq(policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp()), 0);
        vm.prank(wallet);
        assertEq(policy.checkSignaturePolicy(PERMISSION_ID, wallet, bytes32(0), hex""), 0);

        // Trip
        vm.prank(keeper);
        registry.reportEquity(wallet, 800e6);

        // Both fail
        vm.prank(wallet);
        assertEq(policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp()), 1);
        vm.prank(wallet);
        assertEq(policy.checkSignaturePolicy(PERMISSION_ID, wallet, bytes32(0), hex""), 1);
    }

    function test_RecoversAfterOwnerReset() public {
        _setupArmedAccount();
        vm.prank(keeper);
        registry.reportEquity(wallet, 800e6); // trip
        vm.prank(wallet);
        assertEq(_checkPolicy(), 1);

        vm.prank(owner);
        registry.reset(wallet, true);
        vm.prank(wallet);
        assertEq(_checkPolicy(), 0);
    }

    // ── Module type ──────────────────────────────────────────────────────

    function test_ModuleType_Is5() public view {
        assertTrue(policy.isModuleType(5));
        assertFalse(policy.isModuleType(1));
        assertFalse(policy.isModuleType(0));
    }

    // ── Different wallets are isolated ──────────────────────────────────

    function test_WalletIsolation() public {
        address walletB = makeAddr("walletB");

        // Install for wallet, not walletB
        vm.startPrank(wallet);
        policy.onInstall(_installData());
        _checkPolicy();  // wallet should pass

        vm.startPrank(walletB);
        assertEq(policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp()), 1); // walletB fails

        // Install for walletB
        policy.onInstall(_installData());
        assertEq(policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp()), 0); // walletB now passes
        vm.stopPrank();

        // Trip wallet only - manually arm breaker (policy already installed)
        vm.startPrank(owner);
        registry.arm(wallet, keeper, THRESHOLD);
        vm.stopPrank();
        vm.prank(keeper);
        registry.reportEquity(wallet, 1000e6);
        vm.prank(keeper);
        registry.reportEquity(wallet, 800e6);

        vm.startPrank(wallet);
        assertEq(_checkPolicy(), 1);        // wallet blocked
        vm.startPrank(walletB);
        assertEq(policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp()), 0); // walletB still passes
        vm.stopPrank();
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _setupArmedAccount() internal {
        vm.prank(wallet);
        policy.onInstall(_installData());
        vm.prank(owner);
        registry.arm(wallet, keeper, THRESHOLD);
        vm.prank(keeper);
        registry.reportEquity(wallet, 1000e6);
    }

    function _checkPolicy() internal returns (uint256) {
        return policy.checkUserOpPolicy(PERMISSION_ID, _dummyUserOp());
    }
}
