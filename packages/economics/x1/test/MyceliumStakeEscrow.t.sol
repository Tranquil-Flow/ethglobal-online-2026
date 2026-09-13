// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MyceliumStakeEscrow } from "../src/MyceliumStakeEscrow.sol";
import { TestBase } from "./TestBase.sol";

contract MyceliumStakeEscrowTest is TestBase {
    uint256 internal constant VERIFIER_PK = 0xA11CE;
    bytes32 internal constant PROVIDER_KEY = keccak256("provider-key");
    bytes32 internal constant PROFILE = keccak256("profile-0.5b");
    bytes32 internal constant PAYMENT_ID = keccak256("payment-1");
    bytes32 internal constant HEDERA_REF = keccak256("hedera-tx-ref");
    bytes32 internal constant EVIDENCE = keccak256("public-evidence-digest");
    bytes32 internal constant POLICY_VERSION = keccak256("policy-v1");

    MyceliumStakeEscrow internal escrow;
    address internal verifier;
    address internal operator = address(0x1001);
    address internal payer = address(0x2002);
    address internal insurance = address(0x3003);

    event ProviderRegistered(
        bytes32 indexed providerKey, bytes32 indexed profile, address indexed operator
    );
    event StakeChanged(
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        address indexed staker,
        int256 change,
        uint256 newStake
    );
    event DepositRecorded(
        bytes32 indexed paymentId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        address payer,
        uint256 amount,
        bytes32 hederaTxRef
    );

    function setUp() public {
        vm.chainId(296);
        verifier = vm.addr(VERIFIER_PK);
        escrow = new MyceliumStakeEscrow(address(this), insurance);
        escrow.setVerifier(verifier, keccak256("verifier-attestation"));
        vm.deal(address(this), 100 ether);
        vm.deal(operator, 100 ether);
        vm.deal(payer, 100 ether);
    }

    receive() external payable { }

    function testHappyPathRegisterStakeRecordDepositSettleRelease() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit ProviderRegistered(PROVIDER_KEY, PROFILE, operator);
        escrow.registerProvider(PROVIDER_KEY, PROFILE, operator);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit StakeChanged(PROVIDER_KEY, PROFILE, operator, int256(2 ether), 2 ether);
        vm.prank(operator);
        escrow.stake{ value: 2 ether }();

        _prefundEscrow(1 ether);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DepositRecorded(PAYMENT_ID, PROVIDER_KEY, PROFILE, payer, 1 ether, HEDERA_REF);
        escrow.recordDeposit(PAYMENT_ID, PROVIDER_KEY, payer, 1 ether, HEDERA_REF);
        assertEq(escrow.totalUnreleased(), 1 ether);

        uint256 beforeOperator = operator.balance;
        MyceliumStakeEscrow.Verdict[] memory verdicts = new MyceliumStakeEscrow.Verdict[](1);
        verdicts[0] =
            _signedVerdict(PAYMENT_ID, uint8(MyceliumStakeEscrow.SettlementAction.RELEASE), 1);
        escrow.settle(verdicts);

        assertEq(escrow.totalUnreleased(), 0);
        assertEq(escrow.totalReleased(), 1 ether);
        assertEq(operator.balance, beforeOperator + 1 ether);
    }

    function testUnhappyPathDuplicateRegistrationRejected() public {
        escrow.registerProvider(PROVIDER_KEY, PROFILE, operator);
        vm.expectRevert(MyceliumStakeEscrow.ProviderAlreadyRegistered.selector);
        escrow.registerProvider(PROVIDER_KEY, PROFILE, address(0x4444));
    }

    function testUnhappyPathDuplicateDepositRejected() public {
        _registerAndStake(2 ether);
        _prefundEscrow(2 ether);
        escrow.recordDeposit(PAYMENT_ID, PROVIDER_KEY, payer, 1 ether, HEDERA_REF);
        vm.expectRevert(MyceliumStakeEscrow.PaymentAlreadyRecorded.selector);
        escrow.recordDeposit(PAYMENT_ID, PROVIDER_KEY, payer, 1 ether, HEDERA_REF);
    }

    function testStakeTwiceAccumulatesWithoutDoubleCountingUnreleased() public {
        escrow.registerProvider(PROVIDER_KEY, PROFILE, operator);
        vm.prank(operator);
        escrow.stake{ value: 1 ether }();
        vm.prank(operator);
        escrow.stake{ value: 2 ether }();
        bytes32 id = escrow.providerId(PROVIDER_KEY, PROFILE);
        assertEq(escrow.stakeBalance(id), 3 ether);
        assertEq(escrow.totalUnreleased(), 0);
    }

    function testRequestUnstakeWithdrawBeforeAfterUnbonding() public {
        _registerAndStake(3 ether);
        vm.prank(operator);
        escrow.requestUnstake(1 ether, PROVIDER_KEY, PROFILE);
        vm.prank(operator);
        vm.expectRevert(MyceliumStakeEscrow.Unbonding.selector);
        escrow.withdraw(PROVIDER_KEY, PROFILE);

        vm.warp(block.timestamp + escrow.unbondingPeriod() + 1);
        uint256 beforeOperator = operator.balance;
        vm.prank(operator);
        escrow.withdraw(PROVIDER_KEY, PROFILE);
        assertEq(operator.balance, beforeOperator + 1 ether);
    }

    function testWithdrawBlockedByPendingAudit() public {
        _registerAndStake(3 ether);
        vm.prank(operator);
        escrow.requestUnstake(1 ether, PROVIDER_KEY, PROFILE);
        escrow.setPendingAudits(PROVIDER_KEY, PROFILE, 1);
        vm.warp(block.timestamp + escrow.unbondingPeriod() + 1);
        vm.prank(operator);
        vm.expectRevert(MyceliumStakeEscrow.PendingAuditExists.selector);
        escrow.withdraw(PROVIDER_KEY, PROFILE);
    }

    function testSlashChallengeVetoBlocksExecution() public {
        _registerAndStake(3 ether);
        bytes32 slashId = keccak256("slash-1");
        MyceliumStakeEscrow.SlashOrder memory order = MyceliumStakeEscrow.SlashOrder({
            slashId: slashId,
            paymentId: PAYMENT_ID,
            providerKey: PROVIDER_KEY,
            profile: PROFILE,
            amount: 1 ether,
            evidenceDigest: EVIDENCE,
            nonce: 9,
            deadline: block.timestamp + 2 days
        });
        vm.prank(verifier);
        escrow.proposeSlash(order);
        escrow.vetoSlash(slashId, "false positive");
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(MyceliumStakeEscrow.SlashWasVetoed.selector);
        escrow.executeSlash(slashId);
    }

    function testPauseUnpause() public {
        escrow.registerProvider(PROVIDER_KEY, PROFILE, operator);
        escrow.pause();
        vm.prank(operator);
        vm.expectRevert();
        escrow.stake{ value: 1 ether }();
        escrow.unpause();
        vm.prank(operator);
        escrow.stake{ value: 1 ether }();
        bytes32 id = escrow.providerId(PROVIDER_KEY, PROFILE);
        assertEq(escrow.stakeBalance(id), 1 ether);
    }

    function testSetRequiredStakeOnlyPolicy() public {
        escrow.setPolicy(address(0x9999));
        vm.expectRevert(MyceliumStakeEscrow.OnlyPolicy.selector);
        escrow.setRequiredStake(PROFILE, 1 ether, keccak256("params"));
        vm.prank(address(0x9999));
        escrow.setRequiredStake(PROFILE, 1 ether, keccak256("params"));
        (uint256 amount, bytes32 digest) = escrow.requiredStake(PROFILE);
        assertEq(amount, 1 ether);
        assertEq(digest, keccak256("params"));
    }

    function testSettleRejectsBadSignatureAndReplay() public {
        _registerAndStake(2 ether);
        _prefundEscrow(2 ether);
        escrow.recordDeposit(PAYMENT_ID, PROVIDER_KEY, payer, 1 ether, HEDERA_REF);

        MyceliumStakeEscrow.Verdict[] memory verdicts = new MyceliumStakeEscrow.Verdict[](1);
        verdicts[0] =
            _signedVerdict(PAYMENT_ID, uint8(MyceliumStakeEscrow.SettlementAction.REFUND), 7);
        verdicts[0].signature = _signature(0xB0B, escrow.hashVerdict(verdicts[0]));
        vm.expectRevert(MyceliumStakeEscrow.InvalidVerifierSignature.selector);
        escrow.settle(verdicts);

        verdicts[0] =
            _signedVerdict(PAYMENT_ID, uint8(MyceliumStakeEscrow.SettlementAction.REFUND), 7);
        escrow.settle(verdicts);
        vm.expectRevert(MyceliumStakeEscrow.NonceConsumed.selector);
        escrow.settle(verdicts);
    }

    function _registerAndStake(uint256 amount) internal {
        escrow.registerProvider(PROVIDER_KEY, PROFILE, operator);
        vm.prank(operator);
        escrow.stake{ value: amount }();
    }

    function _prefundEscrow(uint256 amount) internal {
        (bool ok,) = address(escrow).call{ value: amount }("");
        require(ok, "prefund failed");
    }

    function _signedVerdict(bytes32 paymentId, uint8 action, uint256 nonce)
        internal
        returns (MyceliumStakeEscrow.Verdict memory verdict)
    {
        verdict = MyceliumStakeEscrow.Verdict({
            paymentId: paymentId,
            providerKey: PROVIDER_KEY,
            profile: PROFILE,
            action: action,
            evidenceDigest: EVIDENCE,
            policyVersion: POLICY_VERSION,
            nonce: nonce,
            deadline: block.timestamp + 1 days,
            signature: ""
        });
        verdict.signature = _signature(VERIFIER_PK, escrow.hashVerdict(verdict));
    }
}
