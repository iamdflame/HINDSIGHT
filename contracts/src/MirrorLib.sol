// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MirrorLib
/// @notice A faithful Solidity reimplementation of the Attestcoin Protocol's transaction
///         Merkle scheme and block digest chain.
///
/// @dev Why this exists.
///
///      The Attestcoin block-prover precompile (`0x0FD2`) verifies a transaction against a
///      *continuity proof* that walks from an on-chain attestation down to the queried block.
///      That walk costs one hash per block traversed. Gluwa's own gas documentation notes that
///      once attestations decay into sparse checkpoints (one per 1000 blocks on Ethereum), the
///      same query costs more than 10x what it cost while fresh, and it grows without bound as
///      the transaction ages.
///
///      But the continuity proof does not only certify the queried block. It carries the
///      transaction Merkle root of *every* block from the query height up to the attestation,
///      chained as `digest[i] = keccak(blockNumber[i], root[i], digest[i-1])`. The precompile
///      validates that entire chain. Tamper with any single root and the terminal digest no
///      longer matches the stored attestation, so every root in the array is bound.
///
///      Those roots arrive as calldata. The caller already holds them; the precompile has
///      already certified them. Persisting them introduces no new trust assumption and turns
///      an O(age) verification into an O(log n) one, permanently, with no prover service in
///      the loop. This library is the O(log n) half.
///
///      Hashing must match the Gluwa usc-sdk exactly or roots will not reproduce:
///        leaf  = keccak256(abi.encodePacked(uint8(0x00), txBytes))
///        inner = keccak256(abi.encodePacked(uint8(0x01), left, right))
///        odd nodes are paired against ZERO_HASH
///        digest = keccak256(abi.encodePacked(uint64 number, bytes32 root, bytes32 prevDigest))
library MirrorLib {
    bytes32 internal constant ZERO_HASH = bytes32(0);

    uint8 private constant LEAF_PREFIX = 0x00;
    uint8 private constant INNER_PREFIX = 0x01;

    /// @notice One step of a Merkle path. `isLeft` is true when the *sibling* sits on the left,
    ///         which means the node being carried upward was the right-hand child.
    /// @dev Layout-compatible with INativeQueryVerifier.MerkleProofEntry so proofs returned by
    ///      the SDK or the hosted prover can be passed straight through without re-shaping.
    struct ProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    function hashLeaf(bytes memory leaf) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(LEAF_PREFIX, leaf));
    }

    function hashInner(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(INNER_PREFIX, left, right));
    }

    /// @notice Recompute the block's transaction Merkle root from a leaf and its sibling path.
    /// @param txBytes The Attestcoin-encoded transaction+receipt bytes (the tree's leaf preimage).
    /// @param path    Sibling hashes ordered leaf -> root.
    function computeRoot(bytes memory txBytes, ProofEntry[] memory path) internal pure returns (bytes32 root) {
        root = hashLeaf(txBytes);
        uint256 n = path.length;
        for (uint256 i; i < n; ++i) {
            root = path[i].isLeft ? hashInner(path[i].hash, root) : hashInner(root, path[i].hash);
        }
    }

    /// @notice Recover a transaction's index within its block from the shape of its Merkle path.
    /// @dev Each level contributes one bit: the node was a right-hand child exactly when its
    ///      sibling was on the left. This is the same quantity the precompile exposes as
    ///      `calculateTxIndex`, recomputed locally so that ordering is available in view calls
    ///      and without a precompile round-trip. Intra-block position is information no
    ///      Ethereum receipt carries.
    function txIndexOf(ProofEntry[] memory path) internal pure returns (uint64 index) {
        uint256 n = path.length;
        for (uint256 i; i < n; ++i) {
            if (path[i].isLeft) index |= uint64(1) << uint64(i);
        }
    }

    /// @notice The per-block digest used by the Attestcoin continuity chain.
    function digestOf(uint64 blockNumber, bytes32 merkleRoot, bytes32 prevDigest) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(blockNumber, merkleRoot, prevDigest));
    }

    /// @notice Genesis form of the digest, used when no prior digest exists.
    function digestOf(uint64 blockNumber, bytes32 merkleRoot) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(blockNumber, merkleRoot));
    }

    /// @notice Reference implementation of the continuity digest walk. Returns the terminal digest.
    /// @dev This is what the precompile computes. `EthereumMirror.mirror()` does NOT call it, and
    ///      cannot usefully: the terminal digest is only meaningful against the attested digest,
    ///      which lives in the attestation layer and is not exposed to contracts. The mirror
    ///      therefore delegates chain validation to the precompile and checks only that
    ///      `continuityRoots[0]` is the root of the queried block. This function exists so the
    ///      scheme is documented in code and so tests can show that altering any root diverges
    ///      the digest -- which is *why* the precompile's acceptance binds the whole array.
    ///      See `test/TrustBoundary.t.sol`.
    function walkDigests(uint64 firstBlock, bytes32[] memory roots, bytes32 lowerEndpointDigest)
        internal
        pure
        returns (bytes32 digest)
    {
        digest = lowerEndpointDigest;
        uint256 n = roots.length;
        for (uint256 i; i < n; ++i) {
            digest = digestOf(firstBlock + uint64(i), roots[i], digest);
        }
    }
}
