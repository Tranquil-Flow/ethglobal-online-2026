// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { VerificationLedger } from "../src/VerificationLedger.sol";
import { TestBase } from "./TestBase.sol";

contract VerificationLedgerTest is TestBase {
    uint256 internal constant VERIFIER_PK = 0xC0FFEE;
    bytes32 internal constant AUDIT_ID = keccak256("audit-1");
    bytes32 internal constant PROVIDER_KEY = keccak256("provider-key");
    bytes32 internal constant PROFILE = keccak256("profile-0.5b");
    bytes32 internal constant EVIDENCE = keccak256("public-evidence-digest");
    bytes32 internal constant HEDERA_REF = keccak256("hedera-ref");

    VerificationLedger internal ledger;
    address internal verifier;
    address internal relayer = address(0xCAFE);

    event AuditRecorded(
        bytes32 indexed auditId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 epoch,
        uint8 reason,
        uint8 outcome,
        bytes32 evidenceDigest,
        bytes32 hederaRef
    );
    event AssessmentBatch(
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 windowStart,
        uint256 windowEnd,
        uint256 assessed,
        uint256 suspicious,
        uint256 unavailable
    );
    event EscrowBatch(
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 released,
        uint256 refunded,
        uint256 releasedUnverified
    );
    event StakeChanged(
        bytes32 indexed providerKey, bytes32 indexed profile, uint256 newStake, int256 change
    );
    event SlashProposed(
        bytes32 indexed slashId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 amount,
        bytes32 evidenceDigest,
        uint256 executeAfter
    );
    event SlashExecuted(
        bytes32 indexed slashId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 amount
    );
    event SlashVetoed(bytes32 indexed slashId, string reason);
    event RequiredStakeSet(bytes32 indexed profile, uint256 amount, bytes32 paramsDigest);
    event VerifierSet(address indexed verifier, bytes32 attestationDigest);
    event CanaryResult(bytes32 indexed providerKey, bytes32 indexed profile, bool detected);

    function setUp() public {
        vm.chainId(11_155_111);
        verifier = vm.addr(VERIFIER_PK);
        ledger = new VerificationLedger(address(this));
        vm.expectEmit(true, true, true, true, address(ledger));
        emit VerifierSet(verifier, keccak256("attestation"));
        ledger.setVerifier(verifier, keccak256("attestation"));
    }

    function testRecordAuditEventAndQuery() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit AuditRecorded(
            AUDIT_ID,
            PROVIDER_KEY,
            PROFILE,
            42,
            uint8(VerificationLedger.Reason.RANDOM),
            uint8(VerificationLedger.Outcome.MATCH),
            EVIDENCE,
            HEDERA_REF
        );
        vm.prank(verifier);
        ledger.recordAudit(
            AUDIT_ID,
            PROVIDER_KEY,
            PROFILE,
            42,
            uint8(VerificationLedger.Reason.RANDOM),
            uint8(VerificationLedger.Outcome.MATCH),
            EVIDENCE,
            HEDERA_REF
        );
        (bytes32 p, bytes32 profile, uint256 epoch, uint8 reason, uint8 outcome,,, bool exists) =
            ledger.audits(AUDIT_ID);
        assertEq(p, PROVIDER_KEY);
        assertEq(profile, PROFILE);
        assertEq(epoch, 42);
        assertEq(uint256(reason), uint256(uint8(VerificationLedger.Reason.RANDOM)));
        assertEq(uint256(outcome), uint256(uint8(VerificationLedger.Outcome.MATCH)));
        assertTrue(exists);
    }

    function testRecordAssessmentBatchEventAndQuery() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit AssessmentBatch(PROVIDER_KEY, PROFILE, 100, 200, 90, 4, 6);
        vm.prank(verifier);
        ledger.recordAssessmentBatch(PROVIDER_KEY, PROFILE, 100, 200, 90, 4, 6);
        assertEq(ledger.assessmentBatchCount(), 1);
    }

    function testRecordEscrowBatchEventAndQuery() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit EscrowBatch(PROVIDER_KEY, PROFILE, 7, 2, 1);
        vm.prank(verifier);
        ledger.recordEscrowBatch(PROVIDER_KEY, PROFILE, 7, 2, 1);
        assertEq(ledger.escrowBatchCount(), 1);
    }

    function testRecordStakeChangeEventAndQuery() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit StakeChanged(PROVIDER_KEY, PROFILE, 10 ether, int256(1 ether));
        vm.prank(verifier);
        ledger.recordStakeChange(PROVIDER_KEY, PROFILE, 10 ether, int256(1 ether));
        bytes32 id = keccak256(abi.encode(PROVIDER_KEY, PROFILE));
        assertEq(ledger.stakeByProviderProfile(id), 10 ether);
    }

    function testSetRequiredStakeEventAndQuery() public {
        bytes32 params = keccak256("params");
        vm.expectEmit(true, true, true, true, address(ledger));
        emit RequiredStakeSet(PROFILE, 4 ether, params);
        vm.prank(verifier);
        ledger.setRequiredStake(PROFILE, 4 ether, params);
        (uint256 amount, bytes32 digest) = ledger.requiredStake(PROFILE);
        assertEq(amount, 4 ether);
        assertEq(digest, params);
    }

    function testRecordCanaryEventAndQuery() public {
        vm.expectEmit(true, true, true, true, address(ledger));
        emit CanaryResult(PROVIDER_KEY, PROFILE, true);
        vm.prank(verifier);
        ledger.recordCanary(PROVIDER_KEY, PROFILE, true);
        assertEq(ledger.canaryCount(), 1);
    }

    function testEip712AuditSignatureValidationAndReplay() public {
        VerificationLedger.AuditPayload memory audit = VerificationLedger.AuditPayload({
            auditId: keccak256("signed-audit"),
            providerKey: PROVIDER_KEY,
            profile: PROFILE,
            epoch: 99,
            reason: uint8(VerificationLedger.Reason.ENSEMBLE),
            outcome: uint8(VerificationLedger.Outcome.MISMATCH),
            evidenceDigest: EVIDENCE,
            hederaRef: HEDERA_REF
        });
        uint256 nonce = 123;
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _signature(VERIFIER_PK, ledger.hashAudit(audit, nonce, deadline));
        vm.prank(relayer);
        ledger.recordAuditSigned(audit, nonce, deadline, signature);
        (,,,,,,, bool exists) = ledger.audits(keccak256("signed-audit"));
        assertTrue(exists);

        vm.expectRevert(VerificationLedger.NonceConsumed.selector);
        ledger.recordAuditSigned(audit, nonce, deadline, signature);

        VerificationLedger.AuditPayload memory audit2 = VerificationLedger.AuditPayload({
            auditId: keccak256("signed-audit-2"),
            providerKey: PROVIDER_KEY,
            profile: PROFILE,
            epoch: 100,
            reason: uint8(VerificationLedger.Reason.ESCALATION),
            outcome: uint8(VerificationLedger.Outcome.INCONCLUSIVE),
            evidenceDigest: EVIDENCE,
            hederaRef: HEDERA_REF
        });
        bytes memory badSignature = _signature(0xBAD, ledger.hashAudit(audit2, 124, deadline));
        vm.expectRevert(VerificationLedger.InvalidVerifierSignature.selector);
        ledger.recordAuditSigned(audit2, 124, deadline, badSignature);
    }

    function testSlashProposalVetoLifecycle() public {
        vm.prank(verifier);
        bytes32 slashId = ledger.proposeSlash(PROVIDER_KEY, PROFILE, 3 ether, EVIDENCE);
        ledger.vetoSlash(slashId, "guardian veto");
        (,,,,, bool vetoed, bool executed, bool exists) = ledger.slashes(slashId);
        assertTrue(exists);
        assertTrue(vetoed);
        assertFalse(executed);
        vm.warp(block.timestamp + ledger.challengeWindow() + 1);
        vm.prank(verifier);
        vm.expectRevert(VerificationLedger.SlashWasVetoed.selector);
        ledger.executeSlash(slashId);
    }

    function testSlashProposalExecuteLifecycle() public {
        vm.prank(verifier);
        bytes32 slashId = ledger.proposeSlash(PROVIDER_KEY, PROFILE, 3 ether, EVIDENCE);
        vm.prank(verifier);
        vm.expectRevert(VerificationLedger.SlashChallengeOpen.selector);
        ledger.executeSlash(slashId);
        vm.warp(block.timestamp + ledger.challengeWindow() + 1);
        vm.prank(verifier);
        ledger.executeSlash(slashId);
        (,,,,,, bool executed,) = ledger.slashes(slashId);
        assertTrue(executed);
    }

    function testOnlyVerifierGuardsRecorders() public {
        vm.expectRevert(VerificationLedger.OnlyVerifier.selector);
        ledger.recordEscrowBatch(PROVIDER_KEY, PROFILE, 1, 0, 0);
    }
}
