// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MyceliumStakeEscrow } from "../src/MyceliumStakeEscrow.sol";
import { TestBase, Vm } from "./TestBase.sol";

contract EscrowSequenceHandler {
    Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant VERIFIER_PK = 0xA11CE;
    bytes32 internal constant PROFILE = keccak256("sequence-profile");
    address internal constant OPERATOR = address(0xCAFE);
    address internal constant PAYER = address(0x1234);
    address internal constant INSURANCE = address(0x1A5);

    MyceliumStakeEscrow public immutable target;
    address public immutable verifier;
    uint256 public totalInputs;
    uint256 public nextPayment;
    uint256 public nextNonce;
    bytes32[] public paymentIds;

    constructor() {
        verifier = VM.addr(VERIFIER_PK);
        target = new MyceliumStakeEscrow(address(this), INSURANCE);
        target.registerProvider(address(this), PROFILE, OPERATOR);
        target.setVerifier(verifier, keccak256("sequence-attestation"), 2);
        VM.deal(address(this), 3 ether);
        target.stake{ value: 3 ether }();
        totalInputs = 3 ether;
    }

    receive() external payable { }

    function deposit(uint96 rawAmount) external {
        uint256 amount = 1 + (uint256(rawAmount) % 1 ether);
        VM.deal(address(this), address(this).balance + amount);
        (bool ok,) = address(target).call{ value: amount }("");
        require(ok, "funding failed");
        bytes32 paymentId = keccak256(abi.encode("sequence-payment", nextPayment++));
        paymentIds.push(paymentId);
        target.recordDeposit(
            paymentId, address(this), PAYER, amount, keccak256(abi.encode(paymentId))
        );
        totalInputs += amount;
    }

    function settleActive(uint256 rawIndex, uint8 rawOutcome) external {
        uint256 length = paymentIds.length;
        if (length == 0) return;
        bytes32 paymentId = paymentIds[rawIndex % length];
        (,,,, MyceliumStakeEscrow.EscrowStatus status) = target.escrow(paymentId);
        if (status != MyceliumStakeEscrow.EscrowStatus.ACTIVE) return;

        MyceliumStakeEscrow.Verdict memory verdict = MyceliumStakeEscrow.Verdict({
            subjectId: paymentId,
            providerKey: address(this),
            profile: PROFILE,
            epoch: 1,
            outcome: rawOutcome % 3,
            evidenceDigest: keccak256("sequence-evidence"),
            policyVersion: keccak256("sequence-policy"),
            nonce: nextNonce++,
            expiry: block.timestamp + 1 days
        });
        MyceliumStakeEscrow.Verdict[] memory verdicts = new MyceliumStakeEscrow.Verdict[](1);
        verdicts[0] = verdict;
        bytes[] memory signatures = new bytes[](1);
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(VERIFIER_PK, target.hashVerdict(verdict));
        signatures[0] = abi.encodePacked(r, s, v);
        target.settle(verdicts, signatures);
    }

    function accountedValue() external view returns (uint256) {
        return address(target).balance + target.totalReleased() + target.totalRefunded()
            + target.totalReleasedUnverified() + target.totalSlashInsurance();
    }
}

contract MyceliumStakeEscrowInvariantTest is TestBase {
    EscrowSequenceHandler internal handler;

    function setUp() public {
        vm.chainId(296);
        handler = new EscrowSequenceHandler();
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_arbitraryDepositSettlementSequencesConserveValue() public view {
        assertEq(handler.accountedValue(), handler.totalInputs());
    }
}
