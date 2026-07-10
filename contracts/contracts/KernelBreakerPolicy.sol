// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPolicy, PackedUserOperation} from "./interfaces/IPolicy.sol";

interface IBreakerRegistry {
    function isTripped(address account) external view returns (bool);
}

/**
 * @title KernelBreakerPolicy
 * @notice Kernel v3 permission policy (module type 5) that consults a
 * BreakerRegistry at UserOp validation. Install it alongside the call/rate/
 * timestamp policies in the session-key grant; once the registry trips for the
 * wallet, EVERY op signed by the session key fails validation — the on-chain
 * half of the drawdown breaker.
 *
 * Fails closed: an id with no registry configured refuses everything.
 * Install data: bytes32 permission id ++ abi.encode(address registry).
 */
contract KernelBreakerPolicy is IPolicy {
    enum Status {
        NA,
        Live,
        Deprecated
    }

    mapping(bytes32 id => mapping(address wallet => Status)) public status;
    mapping(bytes32 id => mapping(address wallet => address)) public registryOf;

    error PolicyAlreadyInstalled();
    error PolicyNotLive();
    error ZeroRegistry();

    uint256 private constant SIG_VALIDATION_SUCCESS = 0;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    function onInstall(bytes calldata data) external payable {
        bytes32 id = bytes32(data[0:32]);
        if (status[id][msg.sender] != Status.NA) revert PolicyAlreadyInstalled();
        address registry = abi.decode(data[32:], (address));
        if (registry == address(0)) revert ZeroRegistry();
        registryOf[id][msg.sender] = registry;
        status[id][msg.sender] = Status.Live;
    }

    function onUninstall(bytes calldata data) external payable {
        bytes32 id = bytes32(data[0:32]);
        if (status[id][msg.sender] != Status.Live) revert PolicyNotLive();
        status[id][msg.sender] = Status.Deprecated;
    }

    function isModuleType(uint256 id) external pure returns (bool) {
        return id == 5; // MODULE_TYPE_POLICY
    }

    function checkUserOpPolicy(bytes32 id, PackedUserOperation calldata)
        external
        payable
        returns (uint256)
    {
        return _check(id, msg.sender);
    }

    function checkSignaturePolicy(bytes32 id, address, bytes32, bytes calldata)
        external
        view
        returns (uint256)
    {
        return _check(id, msg.sender);
    }

    function _check(bytes32 id, address wallet) private view returns (uint256) {
        if (status[id][wallet] != Status.Live) return SIG_VALIDATION_FAILED;
        address registry = registryOf[id][wallet];
        if (registry == address(0)) return SIG_VALIDATION_FAILED;
        if (IBreakerRegistry(registry).isTripped(wallet)) return SIG_VALIDATION_FAILED;
        return SIG_VALIDATION_SUCCESS;
    }
}
