// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MyceliumStakeEscrow
/// @notice Variant-A HBAR escrow and provider-stake accounting for Hedera testnet EVM.
/// @dev Direct HBAR transfers fund escrow; an owner-operated mirror-confirmation relayer then records them.
contract MyceliumStakeEscrow is EIP712, Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    enum EscrowStatus {
        NONE,
        ACTIVE,
        RELEASED,
        REFUNDED,
        RELEASED_UNVERIFIED
    }

    enum Outcome {
        RELEASED,
        REFUNDED,
        RELEASED_UNVERIFIED
    }

    struct Provider {
        bytes32 profile;
        address operator;
        bool registered;
    }

    struct EscrowEntry {
        address providerKey;
        address payer;
        uint256 amount;
        bytes32 hederaTxRef;
        EscrowStatus status;
    }

    struct UnstakeRequest {
        uint256 amount;
        uint256 unlockAt;
    }

    struct StakePolicy {
        uint256 amount;
        bytes32 paramsDigest;
    }

    struct SlashProposal {
        bytes32 subjectId;
        address providerKey;
        bytes32 profile;
        uint64 epoch;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 nonce;
        uint256 expiry;
        bool vetoed;
        bool executed;
    }

    struct Verdict {
        bytes32 subjectId;
        address providerKey;
        bytes32 profile;
        uint64 epoch;
        uint8 outcome;
        bytes32 evidenceDigest;
        bytes32 policyVersion;
        uint256 nonce;
        uint256 expiry;
    }

    struct SlashOrder {
        bytes32 slashId;
        bytes32 subjectId;
        address providerKey;
        bytes32 profile;
        uint64 epoch;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 nonce;
        uint256 expiry;
    }

    error AuthorizationConsumed();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error EmptyBatch();
    error ExpiredAuthorization();
    error InsufficientEscrowBacking();
    error InvalidAddress();
    error InvalidOutcome();
    error InvalidPeriod();
    error InvalidProfile();
    error InvalidSlashExpiry();
    error InvalidVerifierSignature();
    error NonceConsumed();
    error OnlyGuardian();
    error OnlyVerifier();
    error PaymentAlreadyRecorded();
    error PaymentNotActive();
    error PendingSlashExists();
    error ProviderAlreadyRegistered();
    error ProviderNotRegistered();
    error SlashAlreadyExists();
    error SlashAlreadyFinalized();
    error SlashNotFound();
    error SlashWasVetoed();
    error TransferFailed();
    error Unbonding();
    error UnderRequiredStake();
    error UnstakeAlreadyRequested();
    error ZeroAmount();

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
    event UnbondingPeriodSet(uint256 period);
    event ChallengeWindowSet(uint256 period);

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 subjectId,address providerKey,bytes32 profile,uint64 epoch,uint8 outcome,bytes32 evidenceDigest,bytes32 policyVersion,uint256 nonce,uint256 expiry)"
    );

    uint256 public constant MIN_UNBONDING_PERIOD = 2 days;
    uint256 public constant MAX_UNBONDING_PERIOD = 30 days;
    uint256 public constant MIN_CHALLENGE_WINDOW = 1 hours;
    uint256 public constant MAX_CHALLENGE_WINDOW = 7 days;

    mapping(address providerKey => Provider provider) public providers;
    mapping(address operator => address providerKey) public operatorProvider;
    mapping(bytes32 paymentId => EscrowEntry entry) public escrow;
    mapping(address providerKey => uint256 amount) public stakeBalance;
    mapping(address providerKey => UnstakeRequest request) public unstakeRequest;
    mapping(bytes32 profile => StakePolicy policy) public requiredStake;
    mapping(bytes32 slashId => SlashProposal proposal) public pendingSlash;
    mapping(address providerKey => uint256 count) public pendingSlashCount;
    mapping(bytes32 digest => bool consumed) public consumedVerdict;
    mapping(uint256 nonce => bool consumed) public consumedVerdictNonce;
    mapping(uint256 nonce => bool consumed) public consumedSlashNonce;

    address public verifierSigner;
    uint256 public unbondingPeriod = 7 days;
    uint256 public challengeWindow = 1 days;
    address public guardian;
    address payable public immutable insurancePool;

    uint256 public totalStakeBalance;
    uint256 public totalUnreleased;
    uint256 public totalReleased;
    uint256 public totalRefunded;
    uint256 public totalReleasedUnverified;
    uint256 public totalSlashInsurance;

    /// @notice Creates an escrow with an owner/guardian and a non-verifier insurance recipient.
    /// @param initialOwner Address authorized for policy, verifier, pause, and deposit-recording actions.
    /// @param initialInsurancePool Recipient of executed slash proceeds.
    constructor(address initialOwner, address initialInsurancePool)
        EIP712("MyceliumVerification", "1")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || initialInsurancePool == address(0)) {
            revert InvalidAddress();
        }
        guardian = initialOwner;
        insurancePool = payable(initialInsurancePool);
    }

    /// @notice Accepts direct HBAR transfers that a relayer later attributes with `recordDeposit`.
    receive() external payable { }

    /// @notice Registers one provider key, profile, and operational payout address.
    /// @param providerKey Stable EVM address identifying the serving provider or coalition.
    /// @param profile Pinned execution-profile digest.
    /// @param operator Address permitted to operate and fund stake for the provider.
    function registerProvider(address providerKey, bytes32 profile, address operator)
        external
        onlyOwner
    {
        if (providerKey == address(0) || operator == address(0)) revert InvalidAddress();
        if (profile == bytes32(0)) revert InvalidProfile();
        if (providers[providerKey].registered) revert ProviderAlreadyRegistered();
        if (operatorProvider[operator] != address(0)) revert ProviderAlreadyRegistered();
        providers[providerKey] =
            Provider({ profile: profile, operator: operator, registered: true });
        operatorProvider[operator] = providerKey;
        emit ProviderRegistered(providerKey, profile, operator);
    }

    /// @notice Adds payable stake for the registered provider represented by the caller.
    function stake() external payable whenNotPaused {
        address providerKey = _providerFor(msg.sender);
        if (msg.value == 0) revert ZeroAmount();
        stakeBalance[providerKey] += msg.value;
        totalStakeBalance += msg.value;
        emit Staked(providerKey, msg.sender, msg.value, stakeBalance[providerKey]);
    }

    /// @notice Starts unbonding while preserving the profile's currently required stake.
    /// @param amount Stake amount requested for later withdrawal.
    function requestUnstake(uint256 amount) external whenNotPaused {
        address providerKey = _providerFor(msg.sender);
        if (amount == 0) revert ZeroAmount();
        if (unstakeRequest[providerKey].amount != 0) revert UnstakeAlreadyRequested();
        uint256 balance = stakeBalance[providerKey];
        if (amount > balance) revert ZeroAmount();
        if (balance - amount < requiredStake[providers[providerKey].profile].amount) {
            revert UnderRequiredStake();
        }
        uint256 unlockAt = block.timestamp + unbondingPeriod;
        unstakeRequest[providerKey] = UnstakeRequest({ amount: amount, unlockAt: unlockAt });
        emit UnstakeRequested(providerKey, amount, unlockAt);
    }

    /// @notice Withdraws a matured unstake request if no slash proposal remains open.
    function withdraw() external nonReentrant {
        address providerKey = _providerFor(msg.sender);
        UnstakeRequest memory request = unstakeRequest[providerKey];
        if (request.amount == 0 || block.timestamp < request.unlockAt) revert Unbonding();
        if (pendingSlashCount[providerKey] != 0) revert PendingSlashExists();
        if (request.amount > stakeBalance[providerKey]) revert UnderRequiredStake();

        delete unstakeRequest[providerKey];
        stakeBalance[providerKey] -= request.amount;
        totalStakeBalance -= request.amount;
        _sendValue(payable(msg.sender), request.amount);
        emit Withdrawn(providerKey, msg.sender, request.amount);
    }

    /// @notice Attributes a previously received variant-A HBAR transfer after mirror confirmation.
    /// @param paymentId Application payment identifier; it may be recorded exactly once.
    /// @param providerKey Registered provider responsible for the payment.
    /// @param payer Refund recipient.
    /// @param amount Confirmed HBAR amount in tinybar/EVM wei units.
    /// @param hederaTxRef Opaque digest/reference to the confirmed Hedera transaction.
    function recordDeposit(
        bytes32 paymentId,
        address providerKey,
        address payer,
        uint256 amount,
        bytes32 hederaTxRef
    ) external onlyOwner whenNotPaused {
        if (!providers[providerKey].registered) revert ProviderNotRegistered();
        if (payer == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (escrow[paymentId].status != EscrowStatus.NONE) revert PaymentAlreadyRecorded();
        if (address(this).balance < totalStakeBalance) revert InsufficientEscrowBacking();
        if (totalUnreleased + amount > address(this).balance - totalStakeBalance) {
            revert InsufficientEscrowBacking();
        }

        escrow[paymentId] = EscrowEntry({
            providerKey: providerKey,
            payer: payer,
            amount: amount,
            hederaTxRef: hederaTxRef,
            status: EscrowStatus.ACTIVE
        });
        totalUnreleased += amount;
        emit DepositRecorded(paymentId, providerKey, payer, amount, hederaTxRef);
    }

    /// @notice Applies verifier-signed settlement verdicts atomically.
    /// @param verdicts Verdict tuples signed independently under this contract's EIP-712 domain.
    /// @param signatures Signatures parallel to `verdicts`, each recovering to `verifierSigner`.
    function settle(Verdict[] calldata verdicts, bytes[] calldata signatures)
        external
        whenNotPaused
        nonReentrant
    {
        uint256 length = verdicts.length;
        if (length == 0 || signatures.length != length) revert EmptyBatch();
        for (uint256 i; i < length; ++i) {
            _settleOne(verdicts[i], signatures[i]);
        }
    }

    /// @notice Opens a verifier-originated slash challenge that the guardian may veto before expiry.
    /// @param order Slash data; `expiry` is both the signed-order horizon and challenge-window end.
    function proposeSlash(SlashOrder calldata order) external whenNotPaused {
        if (msg.sender != verifierSigner || verifierSigner == address(0)) revert OnlyVerifier();
        Provider memory provider = providers[order.providerKey];
        if (!provider.registered) revert ProviderNotRegistered();
        if (provider.profile != order.profile) revert InvalidProfile();
        if (order.amount == 0) revert ZeroAmount();
        if (pendingSlash[order.slashId].providerKey != address(0)) revert SlashAlreadyExists();
        if (consumedSlashNonce[order.nonce]) revert NonceConsumed();
        if (
            order.expiry < block.timestamp + challengeWindow
                || order.expiry > block.timestamp + MAX_UNBONDING_PERIOD
        ) revert InvalidSlashExpiry();

        consumedSlashNonce[order.nonce] = true;
        pendingSlash[order.slashId] = SlashProposal({
            subjectId: order.subjectId,
            providerKey: order.providerKey,
            profile: order.profile,
            epoch: order.epoch,
            amount: order.amount,
            evidenceDigest: order.evidenceDigest,
            nonce: order.nonce,
            expiry: order.expiry,
            vetoed: false,
            executed: false
        });
        pendingSlashCount[order.providerKey] += 1;
        emit SlashProposed(
            order.slashId,
            order.providerKey,
            order.profile,
            order.amount,
            order.evidenceDigest,
            order.expiry
        );
    }

    /// @notice Executes an expired, unvetoed slash, refunding its linked held payment first.
    /// @param slashId Previously proposed slash identifier.
    function executeSlash(bytes32 slashId) external whenNotPaused nonReentrant {
        SlashProposal storage proposal = pendingSlash[slashId];
        if (proposal.providerKey == address(0)) revert SlashNotFound();
        if (proposal.executed) revert SlashAlreadyFinalized();
        if (proposal.vetoed) revert SlashWasVetoed();
        if (block.timestamp < proposal.expiry) revert ChallengeWindowOpen();

        proposal.executed = true;
        pendingSlashCount[proposal.providerKey] -= 1;
        uint256 slashAmount = proposal.amount;
        uint256 balance = stakeBalance[proposal.providerKey];
        if (slashAmount > balance) slashAmount = balance;
        stakeBalance[proposal.providerKey] = balance - slashAmount;
        totalStakeBalance -= slashAmount;

        EscrowEntry storage linked = escrow[proposal.subjectId];
        if (linked.status == EscrowStatus.ACTIVE && linked.providerKey == proposal.providerKey) {
            _refund(linked, proposal.subjectId, proposal.evidenceDigest);
        }

        totalSlashInsurance += slashAmount;
        _sendValue(insurancePool, slashAmount);
        emit SlashExecuted(slashId, proposal.providerKey, slashAmount, insurancePool);
    }

    /// @notice Vetoes a pending slash during its public challenge period.
    /// @param slashId Slash identifier.
    /// @param reason Public guardian reason; callers must not include private prompt/output material.
    function vetoSlash(bytes32 slashId, string calldata reason) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        SlashProposal storage proposal = pendingSlash[slashId];
        if (proposal.providerKey == address(0)) revert SlashNotFound();
        if (proposal.executed || proposal.vetoed) revert SlashAlreadyFinalized();
        if (block.timestamp >= proposal.expiry) revert ChallengeWindowClosed();
        proposal.vetoed = true;
        pendingSlashCount[proposal.providerKey] -= 1;
        emit SlashVetoed(slashId, reason);
    }

    /// @notice Publishes the required stake and its off-chain policy-input digest for a profile.
    /// @param profile Pinned execution profile digest.
    /// @param amount Required stake in tinybar/EVM wei units.
    /// @param paramsDigest Digest of the policy parameters and freshness-bound stats inputs.
    function setRequiredStake(bytes32 profile, uint256 amount, bytes32 paramsDigest)
        external
        onlyOwner
    {
        if (profile == bytes32(0)) revert InvalidProfile();
        requiredStake[profile] = StakePolicy({ amount: amount, paramsDigest: paramsDigest });
        emit RequiredStakeSet(profile, amount, paramsDigest);
    }

    /// @notice Rotates the only verifier key accepted for EIP-712 verdicts and slash proposals.
    /// @param verifier New verifier EVM address.
    /// @param attestationDigest Digest of the verifier attestation material.
    /// @param mode Deployment mode code: 1=local, 2=TEE.
    function setVerifier(address verifier, bytes32 attestationDigest, uint8 mode)
        external
        onlyOwner
    {
        if (verifier == address(0) || mode == 0 || mode > 2) revert InvalidAddress();
        verifierSigner = verifier;
        emit VerifierSet(verifier, attestationDigest, mode);
    }

    /// @notice Pauses staking, deposit recording, settlements, and slash progression.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes paused contract operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Changes the unbonding period within fixed bounds and never below the challenge window.
    /// @param period New period in seconds.
    function setUnbondingPeriod(uint256 period) external onlyOwner {
        if (
            period < MIN_UNBONDING_PERIOD || period > MAX_UNBONDING_PERIOD
                || period < challengeWindow
        ) revert InvalidPeriod();
        unbondingPeriod = period;
        emit UnbondingPeriodSet(period);
    }

    /// @notice Changes the slash challenge window within fixed bounds and never above unbonding.
    /// @param period New period in seconds.
    function setChallengeWindow(uint256 period) external onlyOwner {
        if (
            period < MIN_CHALLENGE_WINDOW || period > MAX_CHALLENGE_WINDOW
                || period > unbondingPeriod
        ) revert InvalidPeriod();
        challengeWindow = period;
        emit ChallengeWindowSet(period);
    }

    /// @notice Returns the active EIP-712 domain separator for relayer verification.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Returns the EIP-712 digest that `verifierSigner` must sign for a verdict.
    /// @param verdict Verdict tuple to hash.
    function hashVerdict(Verdict calldata verdict) external view returns (bytes32) {
        return _hashTypedDataV4(_verdictStructHash(verdict));
    }

    function _providerFor(address caller) internal view returns (address providerKey) {
        if (providers[caller].registered) return caller;
        providerKey = operatorProvider[caller];
        if (providerKey == address(0) || !providers[providerKey].registered) {
            revert ProviderNotRegistered();
        }
    }

    function _settleOne(Verdict calldata verdict, bytes calldata signature) internal {
        if (block.timestamp > verdict.expiry) revert ExpiredAuthorization();
        if (verdict.outcome > uint8(Outcome.RELEASED_UNVERIFIED)) revert InvalidOutcome();
        bytes32 digest = _hashTypedDataV4(_verdictStructHash(verdict));
        if (consumedVerdict[digest]) revert AuthorizationConsumed();
        if (consumedVerdictNonce[verdict.nonce]) revert NonceConsumed();
        if (digest.recover(signature) != verifierSigner || verifierSigner == address(0)) {
            revert InvalidVerifierSignature();
        }

        EscrowEntry storage entry = escrow[verdict.subjectId];
        if (entry.status != EscrowStatus.ACTIVE) revert PaymentNotActive();
        if (entry.providerKey != verdict.providerKey) revert ProviderNotRegistered();
        if (providers[verdict.providerKey].profile != verdict.profile) revert InvalidProfile();
        consumedVerdict[digest] = true;
        consumedVerdictNonce[verdict.nonce] = true;

        if (verdict.outcome == uint8(Outcome.RELEASED)) {
            _release(entry, verdict.subjectId, verdict.evidenceDigest, false);
        } else if (verdict.outcome == uint8(Outcome.REFUNDED)) {
            _refund(entry, verdict.subjectId, verdict.evidenceDigest);
        } else {
            _release(entry, verdict.subjectId, verdict.evidenceDigest, true);
        }
    }

    function _verdictStructHash(Verdict calldata verdict) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_TYPEHASH,
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
    }

    function _release(
        EscrowEntry storage entry,
        bytes32 paymentId,
        bytes32 evidenceDigest,
        bool unverified
    ) internal {
        uint256 amount = entry.amount;
        entry.status = unverified ? EscrowStatus.RELEASED_UNVERIFIED : EscrowStatus.RELEASED;
        totalUnreleased -= amount;
        address payable recipient = payable(providers[entry.providerKey].operator);
        if (unverified) {
            totalReleasedUnverified += amount;
            _sendValue(recipient, amount);
            emit ReleasedUnverified(paymentId, entry.providerKey, recipient, amount, evidenceDigest);
        } else {
            totalReleased += amount;
            _sendValue(recipient, amount);
            emit Released(paymentId, entry.providerKey, recipient, amount, evidenceDigest);
        }
    }

    function _refund(EscrowEntry storage entry, bytes32 paymentId, bytes32 evidenceDigest)
        internal
    {
        uint256 amount = entry.amount;
        entry.status = EscrowStatus.REFUNDED;
        totalUnreleased -= amount;
        totalRefunded += amount;
        _sendValue(payable(entry.payer), amount);
        emit Refunded(paymentId, entry.providerKey, entry.payer, amount, evidenceDigest);
    }

    function _sendValue(address payable recipient, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = recipient.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }
}
