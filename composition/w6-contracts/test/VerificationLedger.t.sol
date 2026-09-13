// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { VerificationLedger } from "../src/VerificationLedger.sol";
import { TestBase } from "./TestBase.sol";

contract VerificationLedgerTest is TestBase {
    event AuthorSet(address indexed author, VerificationLedger.Mode mode);
    event AuditRecorded(
        bytes32 auditId,
        address indexed providerKey,
        bytes32 indexed profile,
        uint64 epoch,
        uint8 reason,
        uint8 outcome,
        bytes32 evidenceDigest,
        bytes32 hederaRef
    );
    event AssessmentBatch(
        address indexed providerKey,
        bytes32 indexed profile,
        uint64 window,
        uint64 assessed,
        uint64 suspicious,
        uint64 unavailable,
        uint64 statsBlock
    );
    event EscrowBatch(
        address indexed providerKey,
        bytes32 indexed profile,
        uint64 released,
        uint64 refunded,
        uint64 releasedUnverified,
        uint256 releasedAmount,
        uint256 refundedAmount,
        uint256 releasedUnverifiedAmount,
        bytes32 hederaRef
    );
    event StakeChanged(
        address indexed providerKey,
        bytes32 indexed profile,
        int256 delta,
        uint256 newBalance,
        bytes32 hederaRef
    );
    event SlashProposed(
        bytes32 indexed slashId,
        address indexed providerKey,
        bytes32 indexed profile,
        uint256 amount,
        bytes32 evidenceDigest,
        uint256 expiry,
        bytes32 hederaRef
    );
    event SlashExecuted(
        bytes32 indexed slashId,
        address indexed providerKey,
        bytes32 indexed profile,
        uint256 amount,
        bytes32 hederaRef
    );
    event SlashVetoed(
        bytes32 indexed slashId,
        address indexed providerKey,
        bytes32 indexed profile,
        bytes32 reasonCode,
        bytes32 hederaRef
    );
    event RequiredStakeSet(
        bytes32 indexed profile,
        uint256 amount,
        uint256 P,
        uint256 q,
        uint256 d,
        uint256 alpha,
        uint256 lambda,
        uint64 statsBlock
    );
    event VerifierKeySet(address indexed verifier, bytes32 attestationDigest, uint8 mode);
    event CanaryResult(
        address indexed providerKey,
        bytes32 indexed profile,
        uint64 epoch,
        bool mismatched,
        bytes32 evidenceDigest
    );

    uint256 internal constant AUTHOR_PK = 0xABCD1234;
    uint256 internal constant OTHER_PK = 0xBAD1234;
    address internal constant PROVIDER = address(0xBEEF);
    bytes32 internal constant PROFILE = keccak256("qwen-0.5b-int8");

    VerificationLedger internal target;
    address internal author;

    function setUp() public {
        vm.chainId(11_155_111);
        author = vm.addr(AUTHOR_PK);
        target = new VerificationLedger(address(this));
        target.setAuthor(author, VerificationLedger.Mode.TEE);
    }

    function testSetAuthorOnlyOwnerAndEmits() public {
        address next = address(0xCAFE);
        vm.expectEmit(true, false, false, true, address(target));
        emit AuthorSet(next, VerificationLedger.Mode.LOCAL);
        target.setAuthor(next, VerificationLedger.Mode.LOCAL);
        assertEq(uint256(target.authors(next)), uint256(VerificationLedger.Mode.LOCAL));

        vm.prank(address(0xBAD));
        vm.expectRevert();
        target.setAuthor(next, VerificationLedger.Mode.DISABLED);
    }

    function testRecordAuditOnlyAuthorAndDecode() public {
        VerificationLedger.AuditRecordData memory data = VerificationLedger.AuditRecordData({
            auditId: keccak256("audit"),
            providerKey: PROVIDER,
            profile: PROFILE,
            epoch: 3,
            reason: 2,
            outcome: 1,
            evidenceDigest: keccak256("evidence"),
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, false, true, address(target));
        emit AuditRecorded(
            data.auditId,
            data.providerKey,
            data.profile,
            data.epoch,
            data.reason,
            data.outcome,
            data.evidenceDigest,
            data.hederaRef
        );
        _record(target.AUDIT_RECORDED(), payload, AUTHOR_PK, author);
        VerificationLedger.AuditRecordData memory decoded = target.decodeAuditRecorded(payload);
        assertEq(decoded.auditId, data.auditId);
        assertEq(uint256(decoded.reason), 2);
    }

    function testRecordAssessmentBatchOnlyAuthorAndDecode() public {
        VerificationLedger.AssessmentBatchData memory data = VerificationLedger.AssessmentBatchData({
            providerKey: PROVIDER,
            profile: PROFILE,
            window: 86_400,
            assessed: 20,
            suspicious: 2,
            unavailable: 1,
            statsBlock: 999
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, false, true, address(target));
        emit AssessmentBatch(PROVIDER, PROFILE, 86_400, 20, 2, 1, 999);
        _record(target.ASSESSMENT_BATCH(), payload, AUTHOR_PK, author);
        VerificationLedger.AssessmentBatchData memory decoded =
            target.decodeAssessmentBatch(payload);
        assertEq(uint256(decoded.assessed), 20);
    }

    function testRecordEscrowBatchOnlyAuthorAndDecode() public {
        VerificationLedger.EscrowBatchData memory data = VerificationLedger.EscrowBatchData({
            providerKey: PROVIDER,
            profile: PROFILE,
            released: 10,
            refunded: 2,
            releasedUnverified: 1,
            releasedAmount: 10 ether,
            refundedAmount: 2 ether,
            releasedUnverifiedAmount: 1 ether,
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, false, true, address(target));
        emit EscrowBatch(PROVIDER, PROFILE, 10, 2, 1, 10 ether, 2 ether, 1 ether, data.hederaRef);
        _record(target.ESCROW_BATCH(), payload, AUTHOR_PK, author);
        VerificationLedger.EscrowBatchData memory decoded = target.decodeEscrowBatch(payload);
        assertEq(decoded.refundedAmount, 2 ether);
    }

    function testRecordStakeChangedOnlyAuthorAndDecode() public {
        VerificationLedger.StakeChangedData memory data = VerificationLedger.StakeChangedData({
            providerKey: PROVIDER,
            profile: PROFILE,
            delta: -1 ether,
            newBalance: 4 ether,
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, false, true, address(target));
        emit StakeChanged(PROVIDER, PROFILE, -1 ether, 4 ether, data.hederaRef);
        _record(target.STAKE_CHANGED(), payload, AUTHOR_PK, author);
        VerificationLedger.StakeChangedData memory decoded = target.decodeStakeChanged(payload);
        assertEq(decoded.delta, -1 ether);
    }

    function testRecordSlashProposedOnlyAuthorAndDecode() public {
        VerificationLedger.SlashProposedData memory data = VerificationLedger.SlashProposedData({
            slashId: keccak256("slash"),
            providerKey: PROVIDER,
            profile: PROFILE,
            amount: 3 ether,
            evidenceDigest: keccak256("evidence"),
            expiry: block.timestamp + 1 days,
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, true, true, address(target));
        emit SlashProposed(
            data.slashId,
            PROVIDER,
            PROFILE,
            3 ether,
            data.evidenceDigest,
            data.expiry,
            data.hederaRef
        );
        _record(target.SLASH_PROPOSED(), payload, AUTHOR_PK, author);
        VerificationLedger.SlashProposedData memory decoded = target.decodeSlashProposed(payload);
        assertEq(decoded.slashId, data.slashId);
    }

    function testRecordSlashExecutedOnlyAuthorAndDecode() public {
        VerificationLedger.SlashExecutedData memory data = VerificationLedger.SlashExecutedData({
            slashId: keccak256("slash"),
            providerKey: PROVIDER,
            profile: PROFILE,
            amount: 3 ether,
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, true, true, address(target));
        emit SlashExecuted(data.slashId, PROVIDER, PROFILE, 3 ether, data.hederaRef);
        _record(target.SLASH_EXECUTED(), payload, AUTHOR_PK, author);
        VerificationLedger.SlashExecutedData memory decoded = target.decodeSlashExecuted(payload);
        assertEq(decoded.amount, 3 ether);
    }

    function testRecordSlashVetoedOnlyAuthorAndDecode() public {
        VerificationLedger.SlashVetoedData memory data = VerificationLedger.SlashVetoedData({
            slashId: keccak256("slash"),
            providerKey: PROVIDER,
            profile: PROFILE,
            reasonCode: bytes32("FALSE_POSITIVE"),
            hederaRef: keccak256("hedera")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, true, true, address(target));
        emit SlashVetoed(data.slashId, PROVIDER, PROFILE, data.reasonCode, data.hederaRef);
        _record(target.SLASH_VETOED(), payload, AUTHOR_PK, author);
        VerificationLedger.SlashVetoedData memory decoded = target.decodeSlashVetoed(payload);
        assertEq(decoded.reasonCode, data.reasonCode);
    }

    function testRecordRequiredStakeOnlyAuthorAndDecode() public {
        VerificationLedger.RequiredStakeSetData memory data = VerificationLedger.RequiredStakeSetData({
            profile: PROFILE,
            amount: 10 ether,
            P: 5e16,
            q: 9e16,
            d: 5e17,
            alpha: 1e16,
            lambda: 2e18,
            statsBlock: 1000
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, false, false, true, address(target));
        emit RequiredStakeSet(PROFILE, 10 ether, 5e16, 9e16, 5e17, 1e16, 2e18, 1000);
        _record(target.REQUIRED_STAKE_SET(), payload, AUTHOR_PK, author);
        VerificationLedger.RequiredStakeSetData memory decoded =
            target.decodeRequiredStakeSet(payload);
        assertEq(decoded.amount, 10 ether);
    }

    function testRecordVerifierKeyOnlyAuthorAndDecode() public {
        VerificationLedger.VerifierKeySetData memory data = VerificationLedger.VerifierKeySetData({
            verifier: address(0xA11CE), attestationDigest: keccak256("attestation"), mode: 2
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, false, false, true, address(target));
        emit VerifierKeySet(data.verifier, data.attestationDigest, data.mode);
        _record(target.VERIFIER_KEY_SET(), payload, AUTHOR_PK, author);
        VerificationLedger.VerifierKeySetData memory decoded = target.decodeVerifierKeySet(payload);
        assertEq(decoded.verifier, data.verifier);
    }

    function testRecordCanaryOnlyAuthorAndDecode() public {
        VerificationLedger.CanaryResultData memory data = VerificationLedger.CanaryResultData({
            providerKey: PROVIDER,
            profile: PROFILE,
            epoch: 4,
            mismatched: true,
            evidenceDigest: keccak256("evidence")
        });
        bytes memory payload = abi.encode(data);
        vm.expectEmit(true, true, false, true, address(target));
        emit CanaryResult(PROVIDER, PROFILE, 4, true, data.evidenceDigest);
        _record(target.CANARY_RESULT(), payload, AUTHOR_PK, author);
        VerificationLedger.CanaryResultData memory decoded = target.decodeCanaryResult(payload);
        assertTrue(decoded.mismatched);
    }

    function testRecordRejectsUnregisteredAuthorEvenWithValidSelfSignature() public {
        address other = vm.addr(OTHER_PK);
        bytes memory payload = _auditPayload();
        bytes memory signature =
            _signature(OTHER_PK, target.hashRecord(target.AUDIT_RECORDED(), payload, other));
        _callAsExpectRevert(
            other,
            address(target),
            0,
            abi.encodeCall(
                VerificationLedger.record, (target.AUDIT_RECORDED(), payload, signature)
            ),
            VerificationLedger.UnauthorizedAuthor.selector
        );
    }

    function testRecordRejectsWrongSignature() public {
        bytes memory payload = _auditPayload();
        bytes memory signature =
            _signature(OTHER_PK, target.hashRecord(target.AUDIT_RECORDED(), payload, author));
        _callAsExpectRevert(
            author,
            address(target),
            0,
            abi.encodeCall(
                VerificationLedger.record, (target.AUDIT_RECORDED(), payload, signature)
            ),
            VerificationLedger.InvalidAuthorSignature.selector
        );
    }

    function testRecordSignatureReplayReverts() public {
        bytes memory payload = _auditPayload();
        bytes32 eventType = target.AUDIT_RECORDED();
        bytes memory signature =
            _signature(AUTHOR_PK, target.hashRecord(eventType, payload, author));
        vm.prank(author);
        target.record(eventType, payload, signature);
        vm.expectRevert(VerificationLedger.RecordConsumed.selector);
        vm.prank(author);
        target.record(eventType, payload, signature);
    }

    function testRecordRejectsUnknownEventTypeAndNonCanonicalPayload() public {
        bytes memory payload = _auditPayload();
        bytes32 unknown = keccak256("Unknown");
        bytes memory sigUnknown = _signature(AUTHOR_PK, target.hashRecord(unknown, payload, author));
        vm.expectRevert(VerificationLedger.UnknownEventType.selector);
        vm.prank(author);
        target.record(unknown, payload, sigUnknown);

        bytes memory padded = bytes.concat(payload, bytes32(uint256(1)));
        bytes32 eventType = target.AUDIT_RECORDED();
        bytes memory sigPadded = _signature(AUTHOR_PK, target.hashRecord(eventType, padded, author));
        vm.expectRevert(VerificationLedger.NonCanonicalPayload.selector);
        vm.prank(author);
        target.record(eventType, padded, sigPadded);
    }

    function testDomainSeparatorMatchesSepoliaChain() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("MyceliumVerification")),
                keccak256(bytes("1")),
                uint256(11_155_111),
                address(target)
            )
        );
        assertEq(target.domainSeparator(), expected);
    }

    function _record(bytes32 eventType, bytes memory payload, uint256 privateKey, address caller)
        internal
    {
        bytes memory signature =
            _signature(privateKey, target.hashRecord(eventType, payload, caller));
        vm.prank(caller);
        target.record(eventType, payload, signature);
    }

    function _auditPayload() internal pure returns (bytes memory) {
        return abi.encode(
            VerificationLedger.AuditRecordData({
                auditId: keccak256("audit"),
                providerKey: PROVIDER,
                profile: PROFILE,
                epoch: 1,
                reason: 0,
                outcome: 0,
                evidenceDigest: keccak256("evidence"),
                hederaRef: keccak256("hedera")
            })
        );
    }
}
