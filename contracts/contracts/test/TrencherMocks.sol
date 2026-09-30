// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ITrencherV3Router} from "../TrencherVault.sol";
import {IERC20Trade} from "../interfaces/IPonsCurve.sol";

contract TrencherMockRouter is ITrencherV3Router {
    mapping(bytes32 => address) private pools;
    uint256 public numerator = 2;
    uint256 public denominator = 1;
    function setRate(uint256 n, uint256 d) external { numerator = n; denominator = d; }
    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a, fee))] = pool;
    }
    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a, fee))];
    }
    function exactInput(ExactInputParams calldata p) external payable returns (uint256 output) {
        address input = address(bytes20(p.path[:20]));
        address out = address(bytes20(p.path[p.path.length-20:]));
        IERC20Trade(input).transferFrom(msg.sender, address(this), p.amountIn);
        output = p.amountIn * numerator / denominator;
        require(output >= p.amountOutMinimum, "slippage");
        IERC20Trade(out).transfer(p.recipient, output);
    }
}
