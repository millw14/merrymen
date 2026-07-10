// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-4337 v0.7 packed user operation (account-abstraction repo layout).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/**
 * @notice Kernel v3 (ERC-7579) permission-policy surface, mirrored from
 * zerodevapp/kernel-7579-plugins PolicyBase. Module type 5. Validation
 * returns: 0 = success, 1 = failure (ERC-4337 sig-validation convention).
 * Install data layout: bytes32 permission id ++ policy-specific payload;
 * msg.sender is always the wallet the policy is installed on.
 */
interface IPolicy {
    function onInstall(bytes calldata data) external payable;
    function onUninstall(bytes calldata data) external payable;
    function isModuleType(uint256 id) external pure returns (bool);
    function checkUserOpPolicy(bytes32 id, PackedUserOperation calldata userOp)
        external
        payable
        returns (uint256);
    function checkSignaturePolicy(bytes32 id, address sender, bytes32 hash, bytes calldata sig)
        external
        view
        returns (uint256);
}
