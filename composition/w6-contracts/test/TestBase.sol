// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function deal(address who, uint256 newBalance) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
    function chainId(uint256 newChainId) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertFalse(bool value) internal pure {
        require(!value, "assertFalse failed");
    }

    function assertEq(uint256 left, uint256 right) internal pure {
        require(left == right, "assertEq(uint256) failed");
    }

    function assertEq(int256 left, int256 right) internal pure {
        require(left == right, "assertEq(int256) failed");
    }

    function assertEq(address left, address right) internal pure {
        require(left == right, "assertEq(address) failed");
    }

    function assertEq(bytes32 left, bytes32 right) internal pure {
        require(left == right, "assertEq(bytes32) failed");
    }

    function assertEq(bool left, bool right) internal pure {
        require(left == right, "assertEq(bool) failed");
    }

    function _signature(uint256 privateKey, bytes32 digest)
        internal
        returns (bytes memory signature)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _callAsExpectRevert(
        address caller,
        address target,
        uint256 value,
        bytes memory callData,
        bytes4 expectedSelector
    ) internal {
        vm.prank(caller);
        (bool ok, bytes memory returnData) = target.call{ value: value }(callData);
        require(!ok, "call did not revert");
        require(returnData.length >= 4, "missing revert selector");
        bytes4 actualSelector;
        assembly {
            actualSelector := mload(add(returnData, 32))
        }
        require(actualSelector == expectedSelector, "wrong revert selector");
    }
}
