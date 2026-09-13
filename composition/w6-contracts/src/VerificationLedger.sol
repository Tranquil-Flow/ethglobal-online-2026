// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VerificationLedger
/// @notice Signature-attributed, append-only Sepolia event ledger for Graph consumers.
/// @dev Payloads decode only into fixed public-statistics tuples; prompt/output material has no field.
contract VerificationLedger is EIP712, Ownable {
    using ECDSA for bytes32;

    enum Mode {
        DISABLED,
        LOCAL,
        TEE
    }

    enum AuditReason {
        RANDOM,
        PROBATION,
        ENSEMBLE,
        ESCALATION
    }

    struct AuditRecordData {
        bytes32 auditId;
        address providerKey;
        bytes32 profile;
        uint64 epoch;
        uint8 reason;
        uint8 outcome;
        bytes32 evidenceDigest;
        bytes32 hederaRef;
    }

    struct AssessmentBatchData {
        address providerKey;
        bytes32 profile;
        uint64 window;
        uint64 assessed;
        uint64 suspicious;
        uint64 unavailable;
        uint64 statsBlock;
    }

    struct EscrowBatchData {
        address providerKey;
        bytes32 profile;
        uint64 released;
        uint64 refunded;
        uint64 releasedUnverified;
        uint256 releasedAmount;
        uint256 refundedAmount;
        uint256 releasedUnverifiedAmount;
        bytes32 hederaRef;
    }

    struct StakeChangedData {
        address providerKey;
        bytes32 profile;
        int256 delta;
        uint256 newBalance;
        bytes32 hederaRef;
    }

    struct SlashProposedData {
        bytes32 slashId;
        address providerKey;
        bytes32 profile;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 expiry;
        bytes32 hederaRef;
    }

    struct SlashExecutedData {
        bytes32 slashId;
        address providerKey;
        bytes32 profile;
        uint256 amount;
        bytes32 hederaRef;
    }

    struct SlashVetoedData {
        bytes32 slashId;
        address providerKey;
        bytes32 profile;
        bytes32 reasonCode;
        bytes32 hederaRef;
    }

    struct RequiredStakeSetData {
        bytes32 profile;
        uint256 amount;
        uint256 P;
        uint256 q;
        uint256 d;
        uint256 alpha;
        uint256 lambda;
        uint64 statsBlock;
    }

    struct VerifierKeySetData {
        address verifier;
        bytes32 attestationDigest;
        uint8 mode;
    }

    struct CanaryResultData {
        address providerKey;
        bytes32 profile;
        uint64 epoch;
        bool mismatched;
        bytes32 evidenceDigest;
    }

    error InvalidAuthorSignature();
    error InvalidData();
    error NonCanonicalPayload();
    error RecordConsumed();
    error UnauthorizedAuthor();
    error UnknownEventType();

    event AuthorSet(address indexed author, Mode mode);
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

    bytes32 public constant RECORD_TYPEHASH =
        keccak256("LedgerRecord(bytes32 eventType,bytes32 payloadHash,address author)");
    bytes32 public constant AUDIT_RECORDED = keccak256("AuditRecorded");
    bytes32 public constant ASSESSMENT_BATCH = keccak256("AssessmentBatch");
    bytes32 public constant ESCROW_BATCH = keccak256("EscrowBatch");
    bytes32 public constant STAKE_CHANGED = keccak256("StakeChanged");
    bytes32 public constant SLASH_PROPOSED = keccak256("SlashProposed");
    bytes32 public constant SLASH_EXECUTED = keccak256("SlashExecuted");
    bytes32 public constant SLASH_VETOED = keccak256("SlashVetoed");
    bytes32 public constant REQUIRED_STAKE_SET = keccak256("RequiredStakeSet");
    bytes32 public constant VERIFIER_KEY_SET = keccak256("VerifierKeySet");
    bytes32 public constant CANARY_RESULT = keccak256("CanaryResult");

    mapping(address author => Mode mode) public authors;
    mapping(bytes32 digest => bool consumed) public consumedRecord;

    /// @notice Creates the ledger with its author-registry owner.
    /// @param initialOwner Address authorized to add, rotate, or disable authors.
    constructor(address initialOwner) EIP712("MyceliumVerification", "1") Ownable(initialOwner) { }

    /// @notice Adds, changes, or disables an event author.
    /// @param author EVM signing and submitting address.
    /// @param mode DISABLED, LOCAL, or TEE attribution mode.
    function setAuthor(address author, Mode mode) external onlyOwner {
        if (author == address(0)) revert InvalidData();
        authors[author] = mode;
        emit AuthorSet(author, mode);
    }

    /// @notice Verifies and appends exactly one typed event for the calling registered author.
    /// @param eventType One of the public event-type constants.
    /// @param payload Canonical `abi.encode` of the event's documented data struct.
    /// @param signature Author EIP-712 signature over event type, payload hash, and author address.
    function record(bytes32 eventType, bytes calldata payload, bytes calldata signature) external {
        if (authors[msg.sender] == Mode.DISABLED) revert UnauthorizedAuthor();
        bytes32 digest = _recordDigest(eventType, payload, msg.sender);
        if (consumedRecord[digest]) revert RecordConsumed();
        if (digest.recover(signature) != msg.sender) revert InvalidAuthorSignature();
        consumedRecord[digest] = true;
        _emitRecord(eventType, payload);
    }

    /// @notice Returns the active EIP-712 domain separator for relayer verification.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Returns the EIP-712 digest an author must sign for `record`.
    /// @param eventType One of the public event-type constants.
    /// @param payload Canonical encoded event data.
    /// @param author Registered author expected to submit the transaction.
    function hashRecord(bytes32 eventType, bytes calldata payload, address author)
        external
        view
        returns (bytes32)
    {
        return _recordDigest(eventType, payload, author);
    }

    /// @notice Purely decodes an `AuditRecorded` payload for Graph-side tooling.
    function decodeAuditRecorded(bytes calldata payload)
        external
        pure
        returns (AuditRecordData memory)
    {
        return abi.decode(payload, (AuditRecordData));
    }

    /// @notice Purely decodes an `AssessmentBatch` payload for Graph-side tooling.
    function decodeAssessmentBatch(bytes calldata payload)
        external
        pure
        returns (AssessmentBatchData memory)
    {
        return abi.decode(payload, (AssessmentBatchData));
    }

    /// @notice Purely decodes an `EscrowBatch` payload for Graph-side tooling.
    function decodeEscrowBatch(bytes calldata payload)
        external
        pure
        returns (EscrowBatchData memory)
    {
        return abi.decode(payload, (EscrowBatchData));
    }

    /// @notice Purely decodes a `StakeChanged` payload for Graph-side tooling.
    function decodeStakeChanged(bytes calldata payload)
        external
        pure
        returns (StakeChangedData memory)
    {
        return abi.decode(payload, (StakeChangedData));
    }

    /// @notice Purely decodes a `SlashProposed` payload for Graph-side tooling.
    function decodeSlashProposed(bytes calldata payload)
        external
        pure
        returns (SlashProposedData memory)
    {
        return abi.decode(payload, (SlashProposedData));
    }

    /// @notice Purely decodes a `SlashExecuted` payload for Graph-side tooling.
    function decodeSlashExecuted(bytes calldata payload)
        external
        pure
        returns (SlashExecutedData memory)
    {
        return abi.decode(payload, (SlashExecutedData));
    }

    /// @notice Purely decodes a `SlashVetoed` payload for Graph-side tooling.
    function decodeSlashVetoed(bytes calldata payload)
        external
        pure
        returns (SlashVetoedData memory)
    {
        return abi.decode(payload, (SlashVetoedData));
    }

    /// @notice Purely decodes a `RequiredStakeSet` payload for Graph-side tooling.
    function decodeRequiredStakeSet(bytes calldata payload)
        external
        pure
        returns (RequiredStakeSetData memory)
    {
        return abi.decode(payload, (RequiredStakeSetData));
    }

    /// @notice Purely decodes a `VerifierKeySet` payload for Graph-side tooling.
    function decodeVerifierKeySet(bytes calldata payload)
        external
        pure
        returns (VerifierKeySetData memory)
    {
        return abi.decode(payload, (VerifierKeySetData));
    }

    /// @notice Purely decodes a `CanaryResult` payload for Graph-side tooling.
    function decodeCanaryResult(bytes calldata payload)
        external
        pure
        returns (CanaryResultData memory)
    {
        return abi.decode(payload, (CanaryResultData));
    }

    function _recordDigest(bytes32 eventType, bytes calldata payload, address author)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(RECORD_TYPEHASH, eventType, keccak256(payload), author));
        return _hashTypedDataV4(structHash);
    }

    function _emitRecord(bytes32 eventType, bytes calldata payload) internal {
        if (eventType == AUDIT_RECORDED) {
            AuditRecordData memory data = abi.decode(payload, (AuditRecordData));
            _canonical(payload, abi.encode(data));
            if (data.reason > uint8(AuditReason.ESCALATION) || data.outcome > 4) {
                revert InvalidData();
            }
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
        } else if (eventType == ASSESSMENT_BATCH) {
            AssessmentBatchData memory data = abi.decode(payload, (AssessmentBatchData));
            _canonical(payload, abi.encode(data));
            emit AssessmentBatch(
                data.providerKey,
                data.profile,
                data.window,
                data.assessed,
                data.suspicious,
                data.unavailable,
                data.statsBlock
            );
        } else if (eventType == ESCROW_BATCH) {
            EscrowBatchData memory data = abi.decode(payload, (EscrowBatchData));
            _canonical(payload, abi.encode(data));
            emit EscrowBatch(
                data.providerKey,
                data.profile,
                data.released,
                data.refunded,
                data.releasedUnverified,
                data.releasedAmount,
                data.refundedAmount,
                data.releasedUnverifiedAmount,
                data.hederaRef
            );
        } else if (eventType == STAKE_CHANGED) {
            StakeChangedData memory data = abi.decode(payload, (StakeChangedData));
            _canonical(payload, abi.encode(data));
            emit StakeChanged(
                data.providerKey, data.profile, data.delta, data.newBalance, data.hederaRef
            );
        } else if (eventType == SLASH_PROPOSED) {
            SlashProposedData memory data = abi.decode(payload, (SlashProposedData));
            _canonical(payload, abi.encode(data));
            emit SlashProposed(
                data.slashId,
                data.providerKey,
                data.profile,
                data.amount,
                data.evidenceDigest,
                data.expiry,
                data.hederaRef
            );
        } else if (eventType == SLASH_EXECUTED) {
            SlashExecutedData memory data = abi.decode(payload, (SlashExecutedData));
            _canonical(payload, abi.encode(data));
            emit SlashExecuted(
                data.slashId, data.providerKey, data.profile, data.amount, data.hederaRef
            );
        } else if (eventType == SLASH_VETOED) {
            SlashVetoedData memory data = abi.decode(payload, (SlashVetoedData));
            _canonical(payload, abi.encode(data));
            emit SlashVetoed(
                data.slashId, data.providerKey, data.profile, data.reasonCode, data.hederaRef
            );
        } else if (eventType == REQUIRED_STAKE_SET) {
            RequiredStakeSetData memory data = abi.decode(payload, (RequiredStakeSetData));
            _canonical(payload, abi.encode(data));
            emit RequiredStakeSet(
                data.profile,
                data.amount,
                data.P,
                data.q,
                data.d,
                data.alpha,
                data.lambda,
                data.statsBlock
            );
        } else if (eventType == VERIFIER_KEY_SET) {
            VerifierKeySetData memory data = abi.decode(payload, (VerifierKeySetData));
            _canonical(payload, abi.encode(data));
            if (data.verifier == address(0) || data.mode == 0 || data.mode > 2) {
                revert InvalidData();
            }
            emit VerifierKeySet(data.verifier, data.attestationDigest, data.mode);
        } else if (eventType == CANARY_RESULT) {
            CanaryResultData memory data = abi.decode(payload, (CanaryResultData));
            _canonical(payload, abi.encode(data));
            emit CanaryResult(
                data.providerKey, data.profile, data.epoch, data.mismatched, data.evidenceDigest
            );
        } else {
            revert UnknownEventType();
        }
    }

    function _canonical(bytes calldata supplied, bytes memory encoded) internal pure {
        if (supplied.length != encoded.length || keccak256(supplied) != keccak256(encoded)) {
            revert NonCanonicalPayload();
        }
    }
}
