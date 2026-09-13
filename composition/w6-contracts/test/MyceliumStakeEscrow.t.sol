// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MyceliumStakeEscrow } from "../src/MyceliumStakeEscrow.sol";
import { TestBase } from "./TestBase.sol";

contract MyceliumStakeEscrowTest is TestBase {
    event ProviderRegistered(
        address indexed providerKey, bytes32 indexed profile, address indexed operator
    );
    event Staked(
        address indexed providerKey, address indexed funder, uint256 amount, uint256 newBalance
    );
    event UnstakeRequested(address indexed providerKey, uint256 amount, uint256 unlockAt);
    event Withdrawn(address indexed providerKey, address indexed recipient, uint256 amount);
    event DepositRecorded(
        bytes32 indexed paymentId,
        address indexed providerKey,
        address indexed payer,
        uint256 amount,
        bytes32 hederaTxRef
    );
    event Released(
        bytes32 indexed paymentId,
        address indexed providerKey,
        address indexed recipient,
        uint256 amount,
        bytes32 evidenceDigest
    );
    event Refunded(
        bytes32 indexed paymentId,
        address indexed providerKey,
        address indexed payer,
        uint256 amount,
        bytes32 evidenceDigest
    );
    event ReleasedUnverified(
        bytes32 indexed paymentId,
        address indexed providerKey,
        address indexed recipient,
        uint256 amount,
        bytes32 evidenceDigest
    );
    event SlashProposed(
        bytes32 indexed slashId,
        address indexed providerKey,
        bytes32 indexed profile,
        uint256 amount,
        bytes32 evidenceDigest,
        uint256 expiry
    );
    event SlashExecuted(
        bytes32 indexed slashId,
        address indexed providerKey,
        uint256 amount,
        address indexed insurancePool
    );
    event SlashVetoed(bytes32 indexed slashId, string reason);
    event RequiredStakeSet(bytes32 indexed profile, uint256 amount, bytes32 paramsDigest);
    event VerifierSet(address indexed verifier, bytes32 attestationDigest, uint8 mode);

    uint256 internal constant VERIFIER_PK = 0xA11CE;
    bytes32 internal constant PROFILE = keccak256("qwen-0.5b-int8");
    address internal constant PROVIDER = address(0xBEEF);
    address internal constant OPERATOR = address(0xCAFE);
    address internal constant PAYER = address(0x1234);
    address internal constant INSURANCE = address(0x1A5);

    MyceliumStakeEscrow internal target;
    address internal verifier;

    function setUp() public {
        vm.chainId(296);
        verifier = vm.addr(VERIFIER_PK);
        target = new MyceliumStakeEscrow(address(this), INSURANCE);
        vm.deal(address(this), 1_000 ether);
        vm.deal(PROVIDER, 100 ether);
        vm.deal(OPERATOR, 0);
        vm.deal(PAYER, 0);
        vm.deal(INSURANCE, 0);
    }

    function testRegisterProviderOwnerEmitsEvent() public {
        vm.expectEmit(true, true, true, true, address(target));
        emit ProviderRegistered(PROVIDER, PROFILE, OPERATOR);
        target.registerProvider(PROVIDER, PROFILE, OPERATOR);

        (bytes32 profile, address operator, bool registered) = target.providers(PROVIDER);
        assertEq(profile, PROFILE);
        assertEq(operator, OPERATOR);
        assertTrue(registered);
    }

    function testRegisterProviderOnlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        target.registerProvider(PROVIDER, PROFILE, OPERATOR);
    }

    function testRegisterProviderRejectsDoubleRegistration() public {
        target.registerProvider(PROVIDER, PROFILE, OPERATOR);
        vm.expectRevert(MyceliumStakeEscrow.ProviderAlreadyRegistered.selector);
        target.registerProvider(PROVIDER, PROFILE, OPERATOR);
    }

    function testStakePayableUpdatesBalanceAndEmits() public {
        _register();
        vm.expectEmit(true, true, false, true, address(target));
        emit Staked(PROVIDER, PROVIDER, 3 ether, 3 ether);
        vm.prank(PROVIDER);
        target.stake{ value: 3 ether }();
        assertEq(target.stakeBalance(PROVIDER), 3 ether);
        assertEq(target.totalStakeBalance(), 3 ether);
    }

    function testOperatorMayStakeForProvider() public {
        _register();
        vm.deal(OPERATOR, 2 ether);
        vm.prank(OPERATOR);
        target.stake{ value: 2 ether }();
        assertEq(target.stakeBalance(PROVIDER), 2 ether);
    }

    function testStakeRejectsUnregisteredCallerAndZeroValue() public {
        _callAsExpectRevert(
            address(0xBAD),
            address(target),
            0,
            abi.encodeCall(MyceliumStakeEscrow.stake, ()),
            MyceliumStakeEscrow.ProviderNotRegistered.selector
        );
        _register();
        _callAsExpectRevert(
            PROVIDER,
            address(target),
            0,
            abi.encodeCall(MyceliumStakeEscrow.stake, ()),
            MyceliumStakeEscrow.ZeroAmount.selector
        );
    }

    function testRequestUnstakeUnderRequiredStakeReverts() public {
        _registeredStake(3 ether);
        target.setRequiredStake(PROFILE, 2 ether, keccak256("params"));
        vm.prank(PROVIDER);
        vm.expectRevert(MyceliumStakeEscrow.UnderRequiredStake.selector);
        target.requestUnstake(2 ether);
    }

    function testRequestUnstakeEmitsAndStoresUnlock() public {
        _registeredStake(3 ether);
        uint256 unlockAt = block.timestamp + 7 days;
        vm.expectEmit(true, false, false, true, address(target));
        emit UnstakeRequested(PROVIDER, 1 ether, unlockAt);
        vm.prank(PROVIDER);
        target.requestUnstake(1 ether);
        (uint256 amount, uint256 storedUnlock) = target.unstakeRequest(PROVIDER);
        assertEq(amount, 1 ether);
        assertEq(storedUnlock, unlockAt);
    }

    function testWithdrawBeforeUnlockReverts() public {
        _registeredStake(3 ether);
        vm.prank(PROVIDER);
        target.requestUnstake(1 ether);
        vm.prank(PROVIDER);
        vm.expectRevert(MyceliumStakeEscrow.Unbonding.selector);
        target.withdraw();
    }

    function testWithdrawAfterUnlockSucceedsAndEmits() public {
        _registeredStake(3 ether);
        vm.prank(PROVIDER);
        target.requestUnstake(1 ether);
        vm.warp(block.timestamp + 7 days);
        uint256 beforeBalance = PROVIDER.balance;
        vm.expectEmit(true, true, false, true, address(target));
        emit Withdrawn(PROVIDER, PROVIDER, 1 ether);
        vm.prank(PROVIDER);
        target.withdraw();
        assertEq(PROVIDER.balance, beforeBalance + 1 ether);
        assertEq(target.stakeBalance(PROVIDER), 2 ether);
    }

    function testWithdrawBlockedByPendingSlash() public {
        _registeredStake(3 ether);
        _setVerifier();
        vm.prank(PROVIDER);
        target.requestUnstake(1 ether);
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.warp(block.timestamp + 8 days);
        vm.prank(PROVIDER);
        vm.expectRevert(MyceliumStakeEscrow.PendingSlashExists.selector);
        target.withdraw();
    }

    function testRecordDepositOwnerOnlyAndEmits() public {
        _register();
        bytes32 paymentId = keccak256("payment");
        bytes32 hederaRef = keccak256("hedera-tx");
        _fundEscrow(1 ether);
        vm.expectEmit(true, true, true, true, address(target));
        emit DepositRecorded(paymentId, PROVIDER, PAYER, 1 ether, hederaRef);
        target.recordDeposit(paymentId, PROVIDER, PAYER, 1 ether, hederaRef);
        (
            address providerKey,
            address payer,
            uint256 amount,,
            MyceliumStakeEscrow.EscrowStatus status
        ) = target.escrow(paymentId);
        assertEq(providerKey, PROVIDER);
        assertEq(payer, PAYER);
        assertEq(amount, 1 ether);
        assertEq(uint256(status), uint256(MyceliumStakeEscrow.EscrowStatus.ACTIVE));

        vm.prank(address(0xBAD));
        vm.expectRevert();
        target.recordDeposit(keccak256("other"), PROVIDER, PAYER, 1, hederaRef);
    }

    function testRecordDepositEnforcesUnreleasedAtMostFreeBalance() public {
        _register();
        _fundEscrow(1 ether);
        target.recordDeposit(keccak256("p1"), PROVIDER, PAYER, 1 ether, keccak256("h1"));
        vm.expectRevert(MyceliumStakeEscrow.InsufficientEscrowBacking.selector);
        target.recordDeposit(keccak256("p2"), PROVIDER, PAYER, 1, keccak256("h2"));
    }

    function testRecordDepositRejectsDuplicatePayment() public {
        _register();
        _fundEscrow(2 ether);
        bytes32 paymentId = keccak256("p1");
        target.recordDeposit(paymentId, PROVIDER, PAYER, 1 ether, keccak256("h1"));
        vm.expectRevert(MyceliumStakeEscrow.PaymentAlreadyRecorded.selector);
        target.recordDeposit(paymentId, PROVIDER, PAYER, 1 ether, keccak256("h2"));
    }

    function testSettleValidRelease() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 0, 1);
        vm.expectEmit(true, true, true, true, address(target));
        emit Released(paymentId, PROVIDER, OPERATOR, 1 ether, verdict.evidenceDigest);
        _settle(verdict, VERIFIER_PK);
        assertEq(OPERATOR.balance, 1 ether);
        assertEq(target.totalReleased(), 1 ether);
    }

    function testSettleValidRefund() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 1, 2);
        vm.expectEmit(true, true, true, true, address(target));
        emit Refunded(paymentId, PROVIDER, PAYER, 1 ether, verdict.evidenceDigest);
        _settle(verdict, VERIFIER_PK);
        assertEq(PAYER.balance, 1 ether);
        assertEq(target.totalRefunded(), 1 ether);
    }

    function testSettleValidReleasedUnverified() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 2, 3);
        vm.expectEmit(true, true, true, true, address(target));
        emit ReleasedUnverified(paymentId, PROVIDER, OPERATOR, 1 ether, verdict.evidenceDigest);
        _settle(verdict, VERIFIER_PK);
        assertEq(OPERATOR.balance, 1 ether);
        assertEq(target.totalReleasedUnverified(), 1 ether);
    }

    function testSettleInvalidSignatureReverts() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 0, 1);
        vm.expectRevert(MyceliumStakeEscrow.InvalidVerifierSignature.selector);
        _settle(verdict, 0xB0B);
    }

    function testSettleExpiredVerdictReverts() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 0, 1);
        verdict.expiry = block.timestamp - 1;
        vm.expectRevert(MyceliumStakeEscrow.ExpiredAuthorization.selector);
        _settle(verdict, VERIFIER_PK);
    }

    function testSettleDoubleSettlementAndNonceReplayRevert() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 0, 7);
        _settle(verdict, VERIFIER_PK);
        vm.expectRevert(MyceliumStakeEscrow.AuthorizationConsumed.selector);
        _settle(verdict, VERIFIER_PK);

        bytes32 second = _recordPayment(1 ether, keccak256("second"));
        MyceliumStakeEscrow.Verdict memory sameNonce = _verdict(second, 0, 7);
        vm.expectRevert(MyceliumStakeEscrow.NonceConsumed.selector);
        _settle(sameNonce, VERIFIER_PK);
    }

    function testProposeSlashNonVerifierReverts() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.prank(address(0xBAD));
        vm.expectRevert(MyceliumStakeEscrow.OnlyVerifier.selector);
        target.proposeSlash(order);
    }

    function testProposeSlashEmitsAndExecuteBeforeExpiryReverts() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.expectEmit(true, true, true, true, address(target));
        emit SlashProposed(
            order.slashId, PROVIDER, PROFILE, order.amount, order.evidenceDigest, order.expiry
        );
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.expectRevert(MyceliumStakeEscrow.ChallengeWindowOpen.selector);
        target.executeSlash(order.slashId);
    }

    function testVetoWithinWindowBlocksExecution() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.expectEmit(true, false, false, true, address(target));
        emit SlashVetoed(order.slashId, "false positive");
        target.vetoSlash(order.slashId, "false positive");
        vm.warp(order.expiry + 1);
        vm.expectRevert(MyceliumStakeEscrow.SlashWasVetoed.selector);
        target.executeSlash(order.slashId);
    }

    function testVetoSlashGuardianOnly() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.prank(verifier);
        target.proposeSlash(order);
        _callAsExpectRevert(
            address(0xBAD),
            address(target),
            0,
            abi.encodeCall(MyceliumStakeEscrow.vetoSlash, (order.slashId, "not guardian")),
            MyceliumStakeEscrow.OnlyGuardian.selector
        );
    }

    function testVetoAfterWindowHasNoEffect() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, keccak256("audit"));
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.warp(order.expiry + 1);
        vm.expectRevert(MyceliumStakeEscrow.ChallengeWindowClosed.selector);
        target.vetoSlash(order.slashId, "too late");
        target.executeSlash(order.slashId);
        assertEq(target.stakeBalance(PROVIDER), 2 ether);
    }

    function testExecuteSlashPaysFullAmountToInsuranceNeverVerifier() public {
        _registeredStake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(2 ether, keccak256("audit"));
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.warp(order.expiry);
        uint256 verifierBefore = verifier.balance;
        vm.expectEmit(true, true, true, true, address(target));
        emit SlashExecuted(order.slashId, PROVIDER, 2 ether, INSURANCE);
        target.executeSlash(order.slashId);
        assertEq(INSURANCE.balance, 2 ether);
        assertEq(verifier.balance, verifierBefore);
        assertEq(target.totalSlashInsurance(), 2 ether);
    }

    function testExecuteSlashRefundsLinkedHeldPaymentFirst() public {
        bytes32 paymentId = _activePayment(1 ether);
        _stake(3 ether);
        _setVerifier();
        MyceliumStakeEscrow.SlashOrder memory order = _slashOrder(1 ether, paymentId);
        vm.prank(verifier);
        target.proposeSlash(order);
        vm.warp(order.expiry);
        target.executeSlash(order.slashId);
        assertEq(PAYER.balance, 1 ether);
        assertEq(INSURANCE.balance, 1 ether);
        assertEq(target.totalRefunded(), 1 ether);
    }

    function testSetRequiredStakeOnlyOwnerAndEmits() public {
        bytes32 params = keccak256("params");
        vm.expectEmit(true, false, false, true, address(target));
        emit RequiredStakeSet(PROFILE, 4 ether, params);
        target.setRequiredStake(PROFILE, 4 ether, params);
        (uint256 amount, bytes32 digest) = target.requiredStake(PROFILE);
        assertEq(amount, 4 ether);
        assertEq(digest, params);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        target.setRequiredStake(PROFILE, 1, params);
    }

    function testSetVerifierOnlyOwnerAndEmits() public {
        bytes32 attestation = keccak256("attestation");
        vm.expectEmit(true, false, false, true, address(target));
        emit VerifierSet(verifier, attestation, 2);
        target.setVerifier(verifier, attestation, 2);
        assertEq(target.verifierSigner(), verifier);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        target.setVerifier(address(0xB0B), attestation, 1);
    }

    function testPauseBlocksSettleAndUnpauseRestores() public {
        bytes32 paymentId = _activePayment(1 ether);
        _setVerifier();
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, 0, 1);
        target.pause();
        assertTrue(target.paused());
        vm.expectRevert();
        _settle(verdict, VERIFIER_PK);
        target.unpause();
        assertFalse(target.paused());
        _settle(verdict, VERIFIER_PK);
    }

    function testPauseControlsOnlyOwner() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert();
        target.pause();
        vm.expectRevert();
        target.unpause();
        vm.stopPrank();
    }

    function testPeriodSettersEnforceOwnershipAndBounds() public {
        target.setChallengeWindow(2 days);
        assertEq(target.challengeWindow(), 2 days);
        target.setUnbondingPeriod(8 days);
        assertEq(target.unbondingPeriod(), 8 days);

        vm.expectRevert(MyceliumStakeEscrow.InvalidPeriod.selector);
        target.setChallengeWindow(30 minutes);
        vm.expectRevert(MyceliumStakeEscrow.InvalidPeriod.selector);
        target.setUnbondingPeriod(1 days);

        vm.startPrank(address(0xBAD));
        vm.expectRevert();
        target.setChallengeWindow(1 days);
        vm.expectRevert();
        target.setUnbondingPeriod(9 days);
        vm.stopPrank();
    }

    function testDomainSeparatorMatchesHederaChain() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("MyceliumVerification")),
                keccak256(bytes("1")),
                uint256(296),
                address(target)
            )
        );
        assertEq(target.domainSeparator(), expected);
    }

    function testHashVerdictMatchesIndependentEip712Encoding() public view {
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(keccak256("payment"), 0, 42);
        assertEq(target.hashVerdict(verdict), _hashVerdictLocally(verdict));
    }

    function testFuzzAccountingInvariantForDepositAndSettlement(uint96 rawAmount, uint8 rawOutcome)
        public
    {
        uint256 amount = 1 + (uint256(rawAmount) % 10 ether);
        uint8 outcome = rawOutcome % 3;
        _registeredStake(3 ether);
        _setVerifier();
        bytes32 paymentId = _recordPayment(amount, keccak256(abi.encode(rawAmount, rawOutcome)));
        uint256 totalInputs = 3 ether + amount;
        assertEq(_accountedValue(), totalInputs);
        MyceliumStakeEscrow.Verdict memory verdict = _verdict(paymentId, outcome, 99);
        _settle(verdict, VERIFIER_PK);
        assertEq(_accountedValue(), totalInputs);
    }

    function _accountedValue() internal view returns (uint256) {
        return address(target).balance + target.totalReleased() + target.totalRefunded()
            + target.totalReleasedUnverified() + target.totalSlashInsurance();
    }

    function _register() internal {
        target.registerProvider(PROVIDER, PROFILE, OPERATOR);
    }

    function _stake(uint256 amount) internal {
        vm.prank(PROVIDER);
        target.stake{ value: amount }();
    }

    function _registeredStake(uint256 amount) internal {
        _register();
        _stake(amount);
    }

    function _setVerifier() internal {
        target.setVerifier(verifier, keccak256("attestation"), 2);
    }

    function _fundEscrow(uint256 amount) internal {
        (bool ok,) = address(target).call{ value: amount }("");
        assertTrue(ok);
    }

    function _activePayment(uint256 amount) internal returns (bytes32 paymentId) {
        _register();
        paymentId = _recordPayment(amount, keccak256("payment"));
    }

    function _recordPayment(uint256 amount, bytes32 salt) internal returns (bytes32 paymentId) {
        paymentId = keccak256(abi.encode("payment", salt));
        _fundEscrow(amount);
        target.recordDeposit(
            paymentId, PROVIDER, PAYER, amount, keccak256(abi.encode("hedera", salt))
        );
    }

    function _verdict(bytes32 subjectId, uint8 outcome, uint256 nonce)
        internal
        view
        returns (MyceliumStakeEscrow.Verdict memory)
    {
        return MyceliumStakeEscrow.Verdict({
            subjectId: subjectId,
            providerKey: PROVIDER,
            profile: PROFILE,
            epoch: 1,
            outcome: outcome,
            evidenceDigest: keccak256("evidence"),
            policyVersion: keccak256("policy-v1"),
            nonce: nonce,
            expiry: block.timestamp + 1 days
        });
    }

    function _settle(MyceliumStakeEscrow.Verdict memory verdict, uint256 signerPk) internal {
        MyceliumStakeEscrow.Verdict[] memory verdicts = new MyceliumStakeEscrow.Verdict[](1);
        verdicts[0] = verdict;
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _signature(signerPk, _hashVerdictLocally(verdict));
        target.settle(verdicts, signatures);
    }

    function _hashVerdictLocally(MyceliumStakeEscrow.Verdict memory verdict)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash = keccak256(
            "Verdict(bytes32 subjectId,address providerKey,bytes32 profile,uint64 epoch,uint8 outcome,bytes32 evidenceDigest,bytes32 policyVersion,uint256 nonce,uint256 expiry)"
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                verdict.subjectId,
                verdict.providerKey,
                verdict.profile,
                verdict.epoch,
                verdict.outcome,
                verdict.evidenceDigest,
                verdict.policyVersion,
                verdict.nonce,
                verdict.expiry
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("MyceliumVerification")),
                keccak256(bytes("1")),
                uint256(296),
                address(target)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _slashOrder(uint256 amount, bytes32 subjectId)
        internal
        view
        returns (MyceliumStakeEscrow.SlashOrder memory)
    {
        return MyceliumStakeEscrow.SlashOrder({
            slashId: keccak256(abi.encode("slash", subjectId, amount)),
            subjectId: subjectId,
            providerKey: PROVIDER,
            profile: PROFILE,
            epoch: 1,
            amount: amount,
            evidenceDigest: keccak256("slash-evidence"),
            nonce: 55,
            expiry: block.timestamp + target.challengeWindow()
        });
    }
}
