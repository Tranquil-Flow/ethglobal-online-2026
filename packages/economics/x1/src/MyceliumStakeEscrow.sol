// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MyceliumStakeEscrow
/// @notice Variant-A native-token stake and escrow accounting for Hedera testnet EVM.
/// @dev Direct transfers pre-fund escrow; a trusted relayer records mirror-confirmed deposits.
contract MyceliumStakeEscrow is EIP712, Ownable, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;

    enum EscrowStatus {
        NONE,
        ACTIVE,
        RELEASED,
        REFUNDED,
        RELEASED_UNVERIFIED
    }

    enum SettlementAction {
        RELEASE,
        REFUND,
        RELEASE_UNVERIFIED
    }

    struct Provider {
        bytes32 providerKey;
        bytes32 profile;
        address operator;
        bool registered;
    }

    struct EscrowEntry {
        bytes32 providerKey;
        bytes32 profile;
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

    struct Verdict {
        bytes32 paymentId;
        bytes32 providerKey;
        bytes32 profile;
        uint8 action;
        bytes32 evidenceDigest;
        bytes32 policyVersion;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    struct SlashOrder {
        bytes32 slashId;
        bytes32 paymentId;
        bytes32 providerKey;
        bytes32 profile;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 nonce;
        uint256 deadline;
    }

    struct SlashProposal {
        bytes32 paymentId;
        bytes32 providerKey;
        bytes32 profile;
        uint256 amount;
        bytes32 evidenceDigest;
        uint256 nonce;
        uint256 executeAfter;
        uint256 deadline;
        bool vetoed;
        bool executed;
    }

    error EmptyBatch();
    error ExpiredAuthorization();
    error InsufficientEscrowBacking();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidPeriod();
    error InvalidProfile();
    error InvalidSettlementAction();
    error InvalidVerifierSignature();
    error NonceConsumed();
    error OnlyGuardian();
    error OnlyPolicy();
    error OnlyRelayer();
    error OnlyVerifier();
    error PaymentAlreadyRecorded();
    error PaymentNotActive();
    error PendingAuditExists();
    error PendingSlashExists();
    error ProviderAlreadyRegistered();
    error ProviderNotRegistered();
    error SlashAlreadyExists();
    error SlashAlreadyFinalized();
    error SlashChallengeOpen();
    error SlashNotFound();
    error SlashWasVetoed();
    error TransferFailed();
    error Unbonding();
    error UnderRequiredStake();
    error UnstakeAlreadyRequested();
    error ZeroAmount();

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
    event UnstakeRequested(
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        address indexed operator,
        uint256 amount,
        uint256 unlockAt
    );
    event Withdrawn(
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        address indexed recipient,
        uint256 amount
    );
    event DepositRecorded(
        bytes32 indexed paymentId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        address payer,
        uint256 amount,
        bytes32 hederaTxRef
    );
    event Settled(
        bytes32 indexed paymentId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint8 action,
        uint256 amount,
        address recipient,
        bytes32 evidenceDigest
    );
    event SlashProposed(
        bytes32 indexed slashId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        bytes32 paymentId,
        uint256 amount,
        bytes32 evidenceDigest,
        uint256 executeAfter
    );
    event SlashExecuted(
        bytes32 indexed slashId,
        bytes32 indexed providerKey,
        bytes32 indexed profile,
        uint256 amount,
        address insurancePool
    );
    event SlashVetoed(bytes32 indexed slashId, string reason);
    event RequiredStakeSet(bytes32 indexed profile, uint256 amount, bytes32 paramsDigest);
    event VerifierSet(address indexed verifier, bytes32 attestationDigest);
    event RelayerSet(address indexed relayer);
    event PolicySet(address indexed policy);
    event PendingAuditsSet(bytes32 indexed providerKey, bytes32 indexed profile, uint256 count);
    event UnbondingPeriodSet(uint256 period);
    event ChallengeWindowSet(uint256 period);

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 paymentId,bytes32 providerKey,bytes32 profile,uint8 action,bytes32 evidenceDigest,bytes32 policyVersion,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MIN_UNBONDING_PERIOD = 2 days;
    uint256 public constant MAX_UNBONDING_PERIOD = 30 days;
    uint256 public constant MIN_CHALLENGE_WINDOW = 1 hours;
    uint256 public constant MAX_CHALLENGE_WINDOW = 7 days;

    mapping(bytes32 id => Provider provider) public providers;
    mapping(address operator => bytes32 id) public operatorProviderId;
    mapping(bytes32 paymentId => EscrowEntry entry) public escrow;
    mapping(bytes32 id => uint256 amount) public stakeBalance;
    mapping(bytes32 id => UnstakeRequest request) public unstakeRequest;
    mapping(bytes32 profile => StakePolicy policy) public requiredStake;
    mapping(bytes32 slashId => SlashProposal proposal) public slashProposals;
    mapping(bytes32 id => uint256 count) public pendingSlashCount;
    mapping(bytes32 id => uint256 count) public pendingAuditCount;
    mapping(bytes32 digest => bool consumed) public consumedVerdict;
    mapping(uint256 nonce => bool consumed) public consumedVerdictNonce;
    mapping(uint256 nonce => bool consumed) public consumedSlashNonce;

    address public verifier;
    address public relayer;
    address public policy;
    address public guardian;
    address payable public immutable insurancePool;
    uint256 public unbondingPeriod = 7 days;
    uint256 public challengeWindow = 1 days;

    uint256 public totalStakeBalance;
    uint256 public totalUnreleased;
    uint256 public totalReleased;
    uint256 public totalRefunded;
    uint256 public totalReleasedUnverified;
    uint256 public totalSlashInsurance;

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    modifier onlyPolicy() {
        if (msg.sender != policy) revert OnlyPolicy();
        _;
    }

    modifier onlyVerifier() {
        if (msg.sender != verifier || verifier == address(0)) revert OnlyVerifier();
        _;
    }

    /// @notice Creates an escrow owned by `initialOwner`; owner is guardian, relayer, and policy by default.
    constructor(address initialOwner, address initialInsurancePool)
        EIP712("MyceliumVerification", "1")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || initialInsurancePool == address(0)) {
            revert InvalidAddress();
        }
        guardian = initialOwner;
        relayer = initialOwner;
        policy = initialOwner;
        insurancePool = payable(initialInsurancePool);
    }

    /// @notice Accepts direct native-token escrow pre-funding for later `recordDeposit` attribution.
    receive() external payable { }

    /// @notice Registers a provider/profile pair and its operator.
    function registerProvider(bytes32 providerKey, bytes32 profile, address operator)
        external
        onlyOwner
    {
        if (providerKey == bytes32(0) || profile == bytes32(0)) revert InvalidProfile();
        if (operator == address(0)) revert InvalidAddress();
        bytes32 id = providerId(providerKey, profile);
        if (
            providers[id].registered || operatorProviderId[operator] != bytes32(0)
                || providerProfile[providerKey] != bytes32(0)
        ) {
            revert ProviderAlreadyRegistered();
        }
        providers[id] = Provider({
            providerKey: providerKey, profile: profile, operator: operator, registered: true
        });
        operatorProviderId[operator] = id;
        providerProfile[providerKey] = profile;
        emit ProviderRegistered(providerKey, profile, operator);
    }

    /// @notice Adds stake for the provider/profile operated by `msg.sender`.
    function stake() external payable whenNotPaused {
        bytes32 id = _providerIdForOperator(msg.sender);
        if (msg.value == 0) revert ZeroAmount();
        Provider memory provider = providers[id];
        stakeBalance[id] += msg.value;
        totalStakeBalance += msg.value;
        emit StakeChanged(
            provider.providerKey, provider.profile, msg.sender, int256(msg.value), stakeBalance[id]
        );
    }

    /// @notice Starts unbonding stake while leaving the provider above its required stake.
    function requestUnstake(uint256 amount, bytes32 providerKey, bytes32 profile)
        external
        whenNotPaused
    {
        bytes32 id = _requireOperatorFor(msg.sender, providerKey, profile);
        if (amount == 0) revert ZeroAmount();
        if (unstakeRequest[id].amount != 0) revert UnstakeAlreadyRequested();
        uint256 balance = stakeBalance[id];
        if (amount > balance) revert InvalidAmount();
        if (balance - amount < requiredStake[profile].amount) revert UnderRequiredStake();
        uint256 unlockAt = block.timestamp + unbondingPeriod;
        unstakeRequest[id] = UnstakeRequest({ amount: amount, unlockAt: unlockAt });
        emit UnstakeRequested(providerKey, profile, msg.sender, amount, unlockAt);
    }

    /// @notice Withdraws a matured unstake when no audits or slash challenges are open.
    function withdraw(bytes32 providerKey, bytes32 profile) external nonReentrant {
        bytes32 id = _requireOperatorFor(msg.sender, providerKey, profile);
        UnstakeRequest memory request = unstakeRequest[id];
        if (request.amount == 0 || block.timestamp < request.unlockAt) revert Unbonding();
        if (pendingAuditCount[id] != 0) revert PendingAuditExists();
        if (pendingSlashCount[id] != 0) revert PendingSlashExists();
        if (request.amount > stakeBalance[id]) revert UnderRequiredStake();

        delete unstakeRequest[id];
        stakeBalance[id] -= request.amount;
        totalStakeBalance -= request.amount;
        _sendValue(payable(msg.sender), request.amount);
        emit StakeChanged(
            providerKey, profile, msg.sender, -int256(request.amount), stakeBalance[id]
        );
        emit Withdrawn(providerKey, profile, msg.sender, request.amount);
    }

    /// @notice Attributes a mirror-confirmed variant-A deposit without accepting value in this call.
    function recordDeposit(
        bytes32 paymentId,
        bytes32 providerKey,
        address payer,
        uint256 amount,
        bytes32 hederaTxRef
    ) external onlyRelayer whenNotPaused {
        if (paymentId == bytes32(0)) revert InvalidAmount();
        if (payer == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        bytes32 profile = _singleProfile(providerKey);
        if (escrow[paymentId].status != EscrowStatus.NONE) revert PaymentAlreadyRecorded();
        if (totalStakeBalance + totalUnreleased + amount > address(this).balance) {
            revert InsufficientEscrowBacking();
        }
        escrow[paymentId] = EscrowEntry({
            providerKey: providerKey,
            profile: profile,
            payer: payer,
            amount: amount,
            hederaTxRef: hederaTxRef,
            status: EscrowStatus.ACTIVE
        });
        totalUnreleased += amount;
        emit DepositRecorded(paymentId, providerKey, profile, payer, amount, hederaTxRef);
    }

    /// @notice Applies a batch of EIP-712 verifier-signed settlement verdicts.
    function settle(Verdict[] calldata verdicts) external whenNotPaused nonReentrant {
        if (verdicts.length == 0) revert EmptyBatch();
        for (uint256 i; i < verdicts.length; ++i) {
            _settleOne(verdicts[i]);
        }
    }

    /// @notice Opens a slash challenge proposed by the registered verifier.
    function proposeSlash(SlashOrder calldata order) external onlyVerifier whenNotPaused {
        bytes32 id = _requireProvider(order.providerKey, order.profile);
        if (order.slashId == bytes32(0)) revert InvalidAmount();
        if (order.amount == 0) revert ZeroAmount();
        if (slashProposals[order.slashId].providerKey != bytes32(0)) revert SlashAlreadyExists();
        if (consumedSlashNonce[order.nonce]) revert NonceConsumed();
        uint256 executeAfter = block.timestamp + challengeWindow;
        if (order.deadline < executeAfter) revert ExpiredAuthorization();

        consumedSlashNonce[order.nonce] = true;
        slashProposals[order.slashId] = SlashProposal({
            paymentId: order.paymentId,
            providerKey: order.providerKey,
            profile: order.profile,
            amount: order.amount,
            evidenceDigest: order.evidenceDigest,
            nonce: order.nonce,
            executeAfter: executeAfter,
            deadline: order.deadline,
            vetoed: false,
            executed: false
        });
        pendingSlashCount[id] += 1;
        emit SlashProposed(
            order.slashId,
            order.providerKey,
            order.profile,
            order.paymentId,
            order.amount,
            order.evidenceDigest,
            executeAfter
        );
    }

    /// @notice Executes an unvetoed slash after its challenge window.
    function executeSlash(bytes32 slashId) external whenNotPaused nonReentrant {
        SlashProposal storage proposal = slashProposals[slashId];
        if (proposal.providerKey == bytes32(0)) revert SlashNotFound();
        if (proposal.executed) revert SlashAlreadyFinalized();
        if (proposal.vetoed) revert SlashWasVetoed();
        if (block.timestamp < proposal.executeAfter) revert SlashChallengeOpen();

        bytes32 id = providerId(proposal.providerKey, proposal.profile);
        proposal.executed = true;
        pendingSlashCount[id] -= 1;
        uint256 slashAmount = proposal.amount;
        uint256 balance = stakeBalance[id];
        if (slashAmount > balance) slashAmount = balance;
        stakeBalance[id] = balance - slashAmount;
        totalStakeBalance -= slashAmount;

        EscrowEntry storage linked = escrow[proposal.paymentId];
        if (linked.status == EscrowStatus.ACTIVE && linked.providerKey == proposal.providerKey) {
            _settleEscrow(
                linked, proposal.paymentId, SettlementAction.REFUND, proposal.evidenceDigest
            );
        }

        totalSlashInsurance += slashAmount;
        _sendValue(insurancePool, slashAmount);
        emit StakeChanged(
            proposal.providerKey,
            proposal.profile,
            address(this),
            -int256(slashAmount),
            stakeBalance[id]
        );
        emit SlashExecuted(
            slashId, proposal.providerKey, proposal.profile, slashAmount, insurancePool
        );
    }

    /// @notice Public guardian veto of a pending slash with a non-private reason string.
    function vetoSlash(bytes32 slashId, string calldata reason) external {
        if (msg.sender != guardian) revert OnlyGuardian();
        SlashProposal storage proposal = slashProposals[slashId];
        if (proposal.providerKey == bytes32(0)) revert SlashNotFound();
        if (proposal.executed || proposal.vetoed) revert SlashAlreadyFinalized();
        if (block.timestamp >= proposal.executeAfter) revert SlashChallengeOpen();
        proposal.vetoed = true;
        pendingSlashCount[providerId(proposal.providerKey, proposal.profile)] -= 1;
        emit SlashVetoed(slashId, reason);
    }

    /// @notice Sets the profile's required stake from the configured policy authority.
    function setRequiredStake(bytes32 profile, uint256 amount, bytes32 paramsDigest)
        external
        onlyPolicy
    {
        if (profile == bytes32(0)) revert InvalidProfile();
        requiredStake[profile] = StakePolicy({ amount: amount, paramsDigest: paramsDigest });
        emit RequiredStakeSet(profile, amount, paramsDigest);
    }

    /// @notice Rotates the verifier key used for settlement signatures and slash proposals.
    function setVerifier(address newVerifier, bytes32 attestationDigest) external onlyOwner {
        if (newVerifier == address(0)) revert InvalidAddress();
        verifier = newVerifier;
        emit VerifierSet(newVerifier, attestationDigest);
    }

    /// @notice Rotates the trusted variant-A deposit relayer.
    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert InvalidAddress();
        relayer = newRelayer;
        emit RelayerSet(newRelayer);
    }

    /// @notice Rotates the policy authority for required-stake updates.
    function setPolicy(address newPolicy) external onlyOwner {
        if (newPolicy == address(0)) revert InvalidAddress();
        policy = newPolicy;
        emit PolicySet(newPolicy);
    }

    /// @notice Sets pending audit count for withdrawal gating.
    function setPendingAudits(bytes32 providerKey, bytes32 profile, uint256 count)
        external
        onlyOwner
    {
        bytes32 id = _requireProvider(providerKey, profile);
        pendingAuditCount[id] = count;
        emit PendingAuditsSet(providerKey, profile, count);
    }

    /// @notice Pauses staking, recording, settlement, and slash execution/proposal.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes paused operations.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Changes unbonding period within fixed safety bounds.
    function setUnbondingPeriod(uint256 period) external onlyOwner {
        if (
            period < MIN_UNBONDING_PERIOD || period > MAX_UNBONDING_PERIOD
                || period < challengeWindow
        ) {
            revert InvalidPeriod();
        }
        unbondingPeriod = period;
        emit UnbondingPeriodSet(period);
    }

    /// @notice Changes slash challenge window within fixed safety bounds.
    function setChallengeWindow(uint256 period) external onlyOwner {
        if (
            period < MIN_CHALLENGE_WINDOW || period > MAX_CHALLENGE_WINDOW
                || period > unbondingPeriod
        ) {
            revert InvalidPeriod();
        }
        challengeWindow = period;
        emit ChallengeWindowSet(period);
    }

    /// @notice Deterministic key for a provider/profile pair.
    function providerId(bytes32 providerKey, bytes32 profile) public pure returns (bytes32) {
        return keccak256(abi.encode(providerKey, profile));
    }

    /// @notice EIP-712 domain separator for off-chain relayers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest signed by `verifier` for a settlement verdict.
    function hashVerdict(Verdict calldata verdict) external view returns (bytes32) {
        return _hashTypedDataV4(_verdictStructHash(verdict));
    }

    function _settleOne(Verdict calldata verdict) internal {
        if (block.timestamp > verdict.deadline) revert ExpiredAuthorization();
        if (verdict.action > uint8(SettlementAction.RELEASE_UNVERIFIED)) {
            revert InvalidSettlementAction();
        }
        bytes32 digest = _hashTypedDataV4(_verdictStructHash(verdict));
        if (consumedVerdict[digest]) revert NonceConsumed();
        if (consumedVerdictNonce[verdict.nonce]) revert NonceConsumed();
        if (digest.recover(verdict.signature) != verifier || verifier == address(0)) {
            revert InvalidVerifierSignature();
        }
        EscrowEntry storage entry = escrow[verdict.paymentId];
        if (entry.status != EscrowStatus.ACTIVE) revert PaymentNotActive();
        if (entry.providerKey != verdict.providerKey || entry.profile != verdict.profile) {
            revert ProviderNotRegistered();
        }
        consumedVerdict[digest] = true;
        consumedVerdictNonce[verdict.nonce] = true;
        _settleEscrow(
            entry, verdict.paymentId, SettlementAction(verdict.action), verdict.evidenceDigest
        );
    }

    function _settleEscrow(
        EscrowEntry storage entry,
        bytes32 paymentId,
        SettlementAction action,
        bytes32 evidenceDigest
    ) internal {
        uint256 amount = entry.amount;
        totalUnreleased -= amount;
        if (action == SettlementAction.RELEASE) {
            entry.status = EscrowStatus.RELEASED;
            totalReleased += amount;
            address recipient = providers[providerId(entry.providerKey, entry.profile)].operator;
            _sendValue(payable(recipient), amount);
            emit Settled(
                paymentId,
                entry.providerKey,
                entry.profile,
                uint8(action),
                amount,
                recipient,
                evidenceDigest
            );
        } else if (action == SettlementAction.REFUND) {
            entry.status = EscrowStatus.REFUNDED;
            totalRefunded += amount;
            _sendValue(payable(entry.payer), amount);
            emit Settled(
                paymentId,
                entry.providerKey,
                entry.profile,
                uint8(action),
                amount,
                entry.payer,
                evidenceDigest
            );
        } else {
            entry.status = EscrowStatus.RELEASED_UNVERIFIED;
            totalReleasedUnverified += amount;
            address recipient = providers[providerId(entry.providerKey, entry.profile)].operator;
            _sendValue(payable(recipient), amount);
            emit Settled(
                paymentId,
                entry.providerKey,
                entry.profile,
                uint8(action),
                amount,
                recipient,
                evidenceDigest
            );
        }
    }

    function _verdictStructHash(Verdict calldata verdict) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_TYPEHASH,
                verdict.paymentId,
                verdict.providerKey,
                verdict.profile,
                verdict.action,
                verdict.evidenceDigest,
                verdict.policyVersion,
                verdict.nonce,
                verdict.deadline
            )
        );
    }

    function _providerIdForOperator(address operator) internal view returns (bytes32 id) {
        id = operatorProviderId[operator];
        if (id == bytes32(0) || !providers[id].registered) revert ProviderNotRegistered();
    }

    function _requireOperatorFor(address operator, bytes32 providerKey, bytes32 profile)
        internal
        view
        returns (bytes32 id)
    {
        id = providerId(providerKey, profile);
        if (!providers[id].registered || operatorProviderId[operator] != id) {
            revert ProviderNotRegistered();
        }
    }

    function _requireProvider(bytes32 providerKey, bytes32 profile)
        internal
        view
        returns (bytes32 id)
    {
        id = providerId(providerKey, profile);
        if (!providers[id].registered) revert ProviderNotRegistered();
    }

    function _singleProfile(bytes32 providerKey) internal view returns (bytes32 profile) {
        // In this bounded candidate, one provider key is expected to be registered to one profile.
        // The relayer learns the profile from the registered operator mapping by scanning off-chain;
        // on-chain we store the first matching profile at registration in providerLookup.
        profile = providerProfile[providerKey];
        if (profile == bytes32(0)) revert ProviderNotRegistered();
    }

    mapping(bytes32 providerKey => bytes32 profile) private providerProfile;

    function _sendValue(address payable recipient, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = recipient.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }
}
