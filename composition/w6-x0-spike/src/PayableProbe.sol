// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Disposable X0 probe; not the production escrow contract.
contract PayableProbe {
    event Received(address indexed payer, uint256 amount, string memo, bytes32 indexed paymentId);

    constructor() payable {
        emit Received(msg.sender, msg.value, "deployment", bytes32(0));
    }

    receive() external payable {
        // Native Hedera CryptoTransfer metadata is not exposed to EVM receive().
        emit Received(msg.sender, msg.value, "", bytes32(0));
    }
}
