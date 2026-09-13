// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VerificationLedger
/// @notice Sepolia append-only ledger for Mycelium audit, escrow, stake, slash, and canary events.
/// @dev Events contain public counters/references/digests only: no prompts, model outputs, or raw hashes.
contract VerificationLedger is EIP712, Ownable {
    using ECDSA for bytes32;

    enum Reason {
        RANDOM,
        PROBATION,
        ENSEMBLE,
        ESCALATION
    }

    enum Outcome {
        MATCH,
        MISMATCH,
        INCONCLUSIVE,
        UNAVAILABLE
    }

    struct AuditPayload {
        bytes32 auditId;
        bytes32 providerKey;
        bytes32 profile;
        uint256 epoch;
        uint8 reason;
        uint8 outcome;
        bytes32 evidenceDigest;
        bytes32 hederaRef;
    }

    struct AuditRecord {
        bytes32 providerKey;
        bytes32 profile;
        uint256 epoch;
        uint8 reason;
        uint8 outcome;
        bytes32 evidenceDigest;
        bytes32 hederaRef;
        bool exists;
    }

    struct SlashRecord {
        bytes32 providerKey;
        bytes32 profile;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 executeAfter;
        bool vetoed;
        bool executed;
        bool exists;
    }

    struct StakeRequirement {
        uint256 amount;
        bytes32 paramsDigest;
    }

    error AuditAlreadyRecorded();
    error ExpiredAuthorization();
    error InvalidAddress();
    error InvalidData();
    error InvalidVerifierSignature();
    error NonceConsumed();
    error OnlyGuardian();
    error OnlyVerifier();
    error SlashAlreadyFinalized();
    error SlashChallengeOpen();
    error SlashNotFound();
    error SlashWasVetoed();

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

    bytes32 public constant AUDIT_TYPEHASH = keccak256(
        "Audit(bytes32 auditId,bytes32 providerKey,bytes32 profile,uint256 epoch,uint8 reason,uint8 outcome,bytes32 evidenceDigest,bytes32 hederaRef,uint256 nonce,uint256 deadline)"
    );

    address public verifier;
    address public guardian;
    uint256 public challengeWindow = 1 days;
    uint256 public slashNonce;

    mapping(bytes32 auditId => AuditRecord audit) public audits;
    mapping(bytes32 profile => StakeRequirement requirement) public requiredStake;
    mapping(bytes32 providerProfile => uint256 stake) public stakeByProviderProfile;
    mapping(bytes32 slashId => SlashRecord slash) public slashes;
    mapping(uint256 nonce => bool consumed) public consumedAuditNonce;

    uint256 public assessmentBatchCount;
    uint256 public escrowBatchCount;
    uint256 public stakeChangeCount;
    uint256 public canaryCount;

    modifier onlyVerifier() {
        if (msg.sender != verifier || verifier == address(0)) revert OnlyVerifier();
        _;
    }

    /// @notice Creates an owner/guardian controlled ledger.
    constructor(address initialOwner) EIP712("MyceliumVerification", "1") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        guardian = initialOwner;
    }

    /// @notice Records a verifier-authored audit event.
    function recordAudit(
        bytes32 auditId,
        bytes32 providerKey,
        bytes32 profile,
        uint256 epoch,
        uint8 reason,
        uint8 outcome,
        bytes32 evidenceDigest,
        bytes32 hederaRef
    ) external onlyVerifier {
        _recordAudit(
            AuditPayload({
                auditId: auditId,
                providerKey: providerKey,
                profile: profile,
                epoch: epoch,
                reason: reason,
                outcome: outcome,
                evidenceDigest: evidenceDigest,
                hederaRef: hederaRef
            })
        );
    }

    /// @notice Records an audit relayed with an EIP-712 verifier signature.
    function recordAuditSigned(
        AuditPayload calldata audit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert ExpiredAuthorization();
        if (consumedAuditNonce[nonce]) revert NonceConsumed();
        bytes32 digest = _hashAudit(audit, nonce, deadline);
        if (digest.recover(signature) != verifier || verifier == address(0)) {
            revert InvalidVerifierSignature();
        }
        consumedAuditNonce[nonce] = true;
        _recordAudit(audit);
    }

    /// @notice Records a verifier-authored assessment-count batch.
    function recordAssessmentBatch(
        bytes32 providerKey,
        bytes32 profile,
        uint256 windowStart,
        uint256 windowEnd,
        uint256 assessed,
        uint256 suspicious,
        uint256 unavailable
    ) external onlyVerifier {
        if (windowEnd < windowStart) revert InvalidData();
        assessmentBatchCount += 1;
        emit AssessmentBatch(
            providerKey, profile, windowStart, windowEnd, assessed, suspicious, unavailable
        );
    }

    /// @notice Records a verifier-authored escrow-outcome count batch.
    function recordEscrowBatch(
        bytes32 providerKey,
        bytes32 profile,
        uint256 released,
        uint256 refunded,
        uint256 releasedUnverified
    ) external onlyVerifier {
        escrowBatchCount += 1;
        emit EscrowBatch(providerKey, profile, released, refunded, releasedUnverified);
    }

    /// @notice Records a verifier-authored stake mirror update.
    function recordStakeChange(
        bytes32 providerKey,
        bytes32 profile,
        uint256 newStake,
        int256 change
    ) external onlyVerifier {
        stakeByProviderProfile[_providerProfileId(providerKey, profile)] = newStake;
        stakeChangeCount += 1;
        emit StakeChanged(providerKey, profile, newStake, change);
    }

    /// @notice Proposes a slash to be executed after the guardian challenge window.
    function proposeSlash(
        bytes32 providerKey,
        bytes32 profile,
        uint256 amount,
        bytes32 evidenceDigest
    ) external onlyVerifier returns (bytes32 slashId) {
        if (amount == 0) revert InvalidData();
        uint256 nonce = slashNonce++;
        slashId = keccak256(
            abi.encode(
                address(this), block.chainid, providerKey, profile, amount, evidenceDigest, nonce
            )
        );
        uint256 executeAfter = block.timestamp + challengeWindow;
        slashes[slashId] = SlashRecord({
            providerKey: providerKey,
            profile: profile,
            amount: amount,
            evidenceDigest: evidenceDigest,
            executeAfter: executeAfter,
            vetoed: false,
            executed: false,
            exists: true
        });
        emit SlashProposed(slashId, providerKey, profile, amount, evidenceDigest, executeAfter);
    }

    /// @notice Executes an unvetoed slash after the challenge window.
    function executeSlash(bytes32 slashId) external onlyVerifier {
        SlashRecord storage slash = slashes[slashId];
        if (!slash.exists) revert SlashNotFound();
        if (slash.executed || slash.vetoed) {
            if (slash.vetoed) revert SlashWasVetoed();
            revert SlashAlreadyFinalized();
        }
        if (block.timestamp < slash.executeAfter) revert SlashChallengeOpen();
        slash.executed = true;
        emit SlashExecuted(slashId, slash.providerKey, slash.profile, slash.amount);
    }

    /// @notice Vetoes a pending slash with a public reason.
    function vetoSlash(bytes32 slashId, string calldata reason) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        SlashRecord storage slash = slashes[slashId];
        if (!slash.exists) revert SlashNotFound();
        if (slash.executed || slash.vetoed) revert SlashAlreadyFinalized();
        slash.vetoed = true;
        emit SlashVetoed(slashId, reason);
    }

    /// @notice Records a policy-required stake update.
    function setRequiredStake(bytes32 profile, uint256 amount, bytes32 paramsDigest)
        external
        onlyVerifier
    {
        requiredStake[profile] = StakeRequirement({ amount: amount, paramsDigest: paramsDigest });
        emit RequiredStakeSet(profile, amount, paramsDigest);
    }

    /// @notice Owner rotation of the ledger verifier.
    function setVerifier(address newVerifier, bytes32 attestationDigest) external onlyOwner {
        if (newVerifier == address(0)) revert InvalidAddress();
        verifier = newVerifier;
        emit VerifierSet(newVerifier, attestationDigest);
    }

    /// @notice Records a red-team canary result.
    function recordCanary(bytes32 providerKey, bytes32 profile, bool detected)
        external
        onlyVerifier
    {
        canaryCount += 1;
        emit CanaryResult(providerKey, profile, detected);
    }

    /// @notice EIP-712 domain separator for verifier relayers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Returns the audit digest a verifier must sign for `recordAuditSigned`.
    function hashAudit(AuditPayload calldata audit, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashAudit(audit, nonce, deadline);
    }

    function _recordAudit(AuditPayload memory audit) internal {
        if (
            audit.auditId == bytes32(0) || audit.providerKey == bytes32(0)
                || audit.profile == bytes32(0)
        ) {
            revert InvalidData();
        }
        if (audit.reason > uint8(Reason.ESCALATION) || audit.outcome > uint8(Outcome.UNAVAILABLE)) {
            revert InvalidData();
        }
        if (audits[audit.auditId].exists) revert AuditAlreadyRecorded();
        audits[audit.auditId] = AuditRecord({
            providerKey: audit.providerKey,
            profile: audit.profile,
            epoch: audit.epoch,
            reason: audit.reason,
            outcome: audit.outcome,
            evidenceDigest: audit.evidenceDigest,
            hederaRef: audit.hederaRef,
            exists: true
        });
        emit AuditRecorded(
            audit.auditId,
            audit.providerKey,
            audit.profile,
            audit.epoch,
            audit.reason,
            audit.outcome,
            audit.evidenceDigest,
            audit.hederaRef
        );
    }

    function _hashAudit(AuditPayload calldata audit, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    AUDIT_TYPEHASH,
                    audit.auditId,
                    audit.providerKey,
                    audit.profile,
                    audit.epoch,
                    audit.reason,
                    audit.outcome,
                    audit.evidenceDigest,
                    audit.hederaRef,
                    nonce,
                    deadline
                )
            )
        );
    }

    function _providerProfileId(bytes32 providerKey, bytes32 profile)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(providerKey, profile));
    }
}
