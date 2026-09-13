// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MyceliumStakeEscrow } from "../../src/MyceliumStakeEscrow.sol";
import { TestBase } from "../TestBase.sol";

contract EscrowInvariantHandler is TestBase {
    uint256 internal constant VERIFIER_PK = 0x1ACEB00C;
    bytes32 internal constant PROVIDER_KEY = keccak256("invariant-provider");
    bytes32 internal constant PROFILE = keccak256("invariant-profile");
    bytes32 internal constant EVIDENCE = keccak256("invariant-evidence");
    bytes32 internal constant POLICY_VERSION = keccak256("invariant-policy");

    MyceliumStakeEscrow public escrow;
    address internal verifier;
    uint256 public nextPayment;
    uint256 public nextNonce;
    bytes32[] public activePayments;

    constructor() {
        verifier = vm.addr(VERIFIER_PK);
        escrow = new MyceliumStakeEscrow(address(this), address(this));
        escrow.setVerifier(verifier, keccak256("invariant-verifier"));
        escrow.registerProvider(PROVIDER_KEY, PROFILE, address(this));
    }

    receive() external payable { }

    function deposit(uint96 rawAmount) public {
        if (activePayments.length >= 128) return;
        uint256 amount = (uint256(rawAmount) % 10 ether) + 1;
        (bool ok,) = address(escrow).call{ value: amount }("");
        require(ok, "prefund failed");
        bytes32 paymentId = keccak256(abi.encode(nextPayment++));
        escrow.recordDeposit(
            paymentId, PROVIDER_KEY, address(this), amount, keccak256(abi.encode(paymentId, amount))
        );
        activePayments.push(paymentId);
    }

    function settleActive(uint256 seed) public {
        uint256 length = activePayments.length;
        if (length == 0) return;
        uint256 index = seed % length;
        bytes32 paymentId = activePayments[index];
        MyceliumStakeEscrow.Verdict[] memory verdicts = new MyceliumStakeEscrow.Verdict[](1);
        verdicts[0] = MyceliumStakeEscrow.Verdict({
            paymentId: paymentId,
            providerKey: PROVIDER_KEY,
            profile: PROFILE,
            action: uint8(seed % 3),
            evidenceDigest: EVIDENCE,
            policyVersion: POLICY_VERSION,
            nonce: ++nextNonce,
            deadline: block.timestamp + 1 days,
            signature: ""
        });
        verdicts[0].signature = _signature(VERIFIER_PK, escrow.hashVerdict(verdicts[0]));
        escrow.settle(verdicts);
        activePayments[index] = activePayments[length - 1];
        activePayments.pop();
    }
}

contract StakeInvariantsTest is TestBase {
    EscrowInvariantHandler internal handler;
    MyceliumStakeEscrow internal escrow;

    function setUp() public {
        handler = new EscrowInvariantHandler();
        escrow = handler.escrow();
        vm.deal(address(handler), 1_000_000 ether);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_unreleasedNeverExceedsContractBalance() public view {
        assertTrue(escrow.totalUnreleased() <= address(escrow).balance);
    }
}
