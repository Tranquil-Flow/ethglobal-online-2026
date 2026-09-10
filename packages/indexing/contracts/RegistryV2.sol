// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.36;

/// Open attributed public checker statements only. A signature authenticates the checker claim;
/// this contract does not verify execution, payment, inference correctness, or economic finality.
contract RegistryV2 {
    string public constant NAME = "MyceliumOpenRegistry";
    string public constant VERSION = "2";
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant STATEMENT_TYPEHASH = keccak256("CheckerAssessment(bytes32 statementDigest,bytes32 receiptDigest,bytes32 providerKey,bytes32 verifierKey,bytes32 methodKey,uint8 outcome,uint8 mode,uint64 expiresAt,bytes32 nonce,bytes32 metadataHash)");
    bytes32 private constant STATEMENT_DOMAIN = keccak256("mycelium:open-assessment:v2");
    uint256 private constant SECP256K1N_DIV_2 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint8 public immutable deploymentMode;
    bytes32 public immutable DOMAIN_SEPARATOR;

    struct OpenAssessment {
        bytes32 statementDigest;
        bytes32 receiptDigest;
        bytes32 providerKey;
        bytes32 verifierKey;
        bytes32 methodKey;
        uint8 outcome;
        uint8 mode;
        uint64 expiresAt;
        bytes32 nonce;
        string publicMetadata;
    }

    mapping(bytes32 => bytes32) public statements;
    mapping(bytes32 => bytes32) public authorNonces;

    event OpenAssessmentPublished(
        bytes32 indexed statementDigest,
        bytes32 indexed receiptDigest,
        bytes32 indexed providerKey,
        address author,
        address relayer,
        bytes32 verifierKey,
        bytes32 methodKey,
        uint8 outcome,
        uint8 mode,
        bool linked,
        string publicMetadata
    );

    constructor(uint8 m) {
        require(m <= 1, "CONFIG");
        deploymentMode = m;
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            block.chainid,
            address(this)
        ));
    }

    function publishStatement(OpenAssessment calldata s, bytes calldata signature) external returns (address author) {
        require(s.statementDigest != bytes32(0) && s.receiptDigest != bytes32(0) && s.providerKey != bytes32(0)
            && s.verifierKey != bytes32(0) && s.methodKey != bytes32(0) && s.outcome <= 4
            && s.mode == deploymentMode && bytes(s.publicMetadata).length > 0
            && bytes(s.publicMetadata).length <= 8192, "MALFORMED");
        require(s.expiresAt >= block.timestamp, "EXPIRED");
        bytes32 metadataHash = keccak256(bytes(s.publicMetadata));
        bytes32 structHash = keccak256(abi.encode(
            STATEMENT_TYPEHASH,
            s.statementDigest,
            s.receiptDigest,
            s.providerKey,
            s.verifierKey,
            s.methodKey,
            s.outcome,
            s.mode,
            s.expiresAt,
            s.nonce,
            metadataHash
        ));
        author = recover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)), signature);
        require(author != address(0), "INVALID_SIGNATURE");
        require(s.statementDigest == keccak256(abi.encode(
            STATEMENT_DOMAIN,
            s.receiptDigest,
            s.providerKey,
            author,
            s.verifierKey,
            s.methodKey,
            s.outcome,
            s.mode,
            s.expiresAt,
            s.nonce,
            metadataHash
        )), "STATEMENT_DIGEST");
        bytes32 nonceKey = keccak256(abi.encode(author, s.nonce));
        bytes32 previousNonce = authorNonces[nonceKey];
        if (previousNonce != bytes32(0)) {
            require(previousNonce == s.statementDigest, "CONFLICTING_NONCE");
        }
        bytes32 commitment = keccak256(abi.encode(
            s.receiptDigest,
            s.providerKey,
            author,
            s.verifierKey,
            s.methodKey,
            s.outcome,
            s.mode,
            s.expiresAt,
            s.nonce,
            metadataHash
        ));
        bytes32 previous = statements[s.statementDigest];
        if (previous != bytes32(0)) {
            require(previous == commitment, "CONFLICTING_STATEMENT");
            return author;
        }
        authorNonces[nonceKey] = s.statementDigest;
        statements[s.statementDigest] = commitment;
        emit OpenAssessmentPublished(s.statementDigest, s.receiptDigest, s.providerKey, author, msg.sender,
            s.verifierKey, s.methodKey, s.outcome, s.mode, false, s.publicMetadata);
    }

    function recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > SECP256K1N_DIV_2) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
