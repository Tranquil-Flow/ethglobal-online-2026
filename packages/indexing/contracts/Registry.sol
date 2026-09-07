// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

/// Attributed publication only: no execution, payment, signature or truth verification.
contract Registry {
    address public immutable publisher;
    uint8 public immutable deploymentMode;
    struct Receipt { bytes32 provider; bool exists; }
    mapping(bytes32 => Receipt) public receipts;
    mapping(bytes32 => bytes32) public assessments;
    event ReceiptPublished(bytes32 indexed receiptDigest, bytes32 indexed providerKey, uint8 mode);
    event AssessmentPublished(bytes32 indexed assessmentDigest, bytes32 indexed receiptDigest,
        bytes32 indexed providerKey, bytes32 verifierKey, bytes32 methodKey, uint8 outcome,
        uint8 mode, string publicMetadata);
    constructor(address p, uint8 m) {
        require(p != address(0) && m <= 1, "CONFIG");
        publisher = p;
        deploymentMode = m;
    }
    modifier authorized(uint8 mode) {
        require(msg.sender == publisher, "UNAUTHORIZED");
        require(mode == deploymentMode, "MODE");
        _;
    }
    function publishReceipt(bytes32 digest, bytes32 provider, uint8 mode) external authorized(mode) {
        require(digest != bytes32(0) && provider != bytes32(0), "MALFORMED");
        Receipt storage previous = receipts[digest];
        if (previous.exists) { require(previous.provider == provider, "CONFLICT"); return; }
        receipts[digest] = Receipt(provider, true);
        emit ReceiptPublished(digest, provider, mode);
    }
    function publishAssessment(bytes32 digest, bytes32 receipt, bytes32 provider,
        bytes32 verifier, bytes32 method, uint8 outcome, uint8 mode, string calldata metadata)
        external authorized(mode) {
        require(digest != bytes32(0) && verifier != bytes32(0) && method != bytes32(0)
            && outcome <= 4 && bytes(metadata).length > 0 && bytes(metadata).length <= 8192, "MALFORMED");
        require(receipts[receipt].exists && receipts[receipt].provider == provider, "RECEIPT");
        bytes32 commitment = keccak256(abi.encode(receipt, provider, verifier, method, outcome, mode, metadata));
        bytes32 previous = assessments[digest];
        if (previous != bytes32(0)) { require(previous == commitment, "CONFLICT"); return; }
        assessments[digest] = commitment;
        emit AssessmentPublished(digest, receipt, provider, verifier, method, outcome, mode, metadata);
    }
}
