// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {MirrorLib} from "./MirrorLib.sol";

/// @title EthereumMirror
/// @notice A permissionless, ownerless archive of verified source-chain block commitments.
///
/// @dev The observation this contract is built on.
///
///      Every Attestcoin readability query carries a continuity proof: an array of transaction
///      Merkle roots running from the queried block up to an on-chain attestation, chained by
///      `digest[i] = keccak(number[i], root[i], digest[i-1])`. The block-prover precompile
///      verifies that whole chain terminates at a stored attestation. Alter any single root and
///      the terminal digest diverges, so the precompile's acceptance binds *every* root in the
///      array, not merely the one belonging to the caller's transaction.
///
///      In practice a single query carries on the order of 100 such roots. Every existing
///      integration discards all of them and keeps one transaction. This contract keeps them.
///
///      Persisting them adds no trust assumption -- the precompile already certified them in the
///      same call -- but it changes the cost structure permanently. An Attestcoin query costs one
///      hash per block of continuity walked, and continuity lengthens as a transaction ages
///      (attestations decay into checkpoints one per 1000 blocks). Against a mirrored root the
///      same transaction verifies in a fixed ~6.2k gas, in a `view` call, forever, and without
///      the hosted prover in the loop.
///
///      Consequence: liveness of the proof service stops being a dependency of anything built
///      on top. Mirrored history stays verifiable when the prover is offline.
contract EthereumMirror {
    INativeQueryVerifier public constant VERIFIER = INativeQueryVerifier(address(uint160(0x0FD2)));

    /// @notice Largest number of blocks one `sealSpan` or `extendSpan` call may walk.
    /// @dev Contiguity costs one SLOAD per block, so an uncapped loop is a gas trap that also
    ///      makes long ranges permanently unsealable. Capping and providing `extendSpan` keeps
    ///      every call bounded while leaving arbitrarily long spans reachable.
    uint64 public constant MAX_SEAL_WINDOW = 5_000;

    /// @notice chainKey => block number => transaction Merkle root of that block.
    mapping(uint64 => mapping(uint64 => bytes32)) public rootOf;

    /// @notice Count of distinct blocks mirrored per chain.
    mapping(uint64 => uint64) public mirroredBlocks;

    /// @notice Highest block number mirrored per chain.
    mapping(uint64 => uint64) public highestMirrored;

    /// @notice Lowest block number mirrored per chain.
    mapping(uint64 => uint64) public lowestMirrored;

    /// @notice A contiguous, fully-mirrored range of source-chain blocks, proven contiguous once.
    /// @dev Absence claims are only meaningful over ranges with no gaps: a gap is a place where a
    ///      disproving transaction could hide. Walking a range costs one SLOAD per block, so it is
    ///      paid once here and referenced by id thereafter.
    struct Span {
        uint64 chainKey;
        uint64 fromBlock;
        uint64 toBlock;
    }

    Span[] internal _spans;

    event BlocksMirrored(uint64 indexed chainKey, uint64 indexed fromBlock, uint64 indexed toBlock, uint64 newlyAdded);
    event SpanSealed(uint256 indexed spanId, uint64 indexed chainKey, uint64 fromBlock, uint64 toBlock);
    event SpanExtended(uint256 indexed spanId, uint64 indexed chainKey, uint64 fromBlock, uint64 toBlock);

    /// @notice Emitted if two accepted proofs ever disagree about a block. Should be unreachable;
    ///         its presence on chain would be evidence of an attestation-layer failure.
    event RootConflict(uint64 indexed chainKey, uint64 indexed blockNumber, bytes32 stored, bytes32 offered);

    error ProofRejected();
    error EmptyContinuity();
    error ConflictingRoot(uint64 blockNumber, bytes32 stored, bytes32 offered);
    error NotMirrored(uint64 chainKey, uint64 blockNumber);
    error ProofInvalid(uint64 chainKey, uint64 blockNumber);
    error GapInSpan(uint64 chainKey, uint64 blockNumber);
    error BadRange();
    error NoSuchSpan();
    error SealWindowTooLarge();
    error BatchMalformed();

    /// @notice Verify a source-chain transaction, then retain every block commitment the proof
    ///         carried. Anyone may call this; there is no admin, no pause and no upgrade path.
    /// @param chainKey            Attestcoin source-chain id (3 = Ethereum mainnet, 1 = Sepolia).
    /// @param blockHeight         Height of the queried transaction's block; also `continuityRoots[0]`.
    /// @param encodedTransaction  Attestcoin-encoded transaction + receipt bytes.
    /// @param merkleRoot          Transaction Merkle root of `blockHeight`.
    /// @param siblings            Merkle path for the queried transaction.
    /// @param lowerEndpointDigest Digest of `blockHeight - 1`.
    /// @param continuityRoots     Roots for `blockHeight ..= blockHeight + len - 1`.
    /// @return added Number of blocks newly written by this call.
    function mirror(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (uint64 added) {
        if (continuityRoots.length == 0) revert EmptyContinuity();

        // The precompile is the sole source of authority. It validates Merkle inclusion for the
        // queried transaction and walks the digest chain to a stored attestation, which is what
        // binds every entry of `continuityRoots`.
        bool ok = VERIFIER.verifyAndEmit(
            chainKey,
            blockHeight,
            encodedTransaction,
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings}),
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots})
        );
        if (!ok) revert ProofRejected();

        // Defence in depth: the caller supplies `merkleRoot` and `continuityRoots` as separate
        // arguments, so require the protocol's own invariant -- the continuity array is indexed
        // from the query height -- rather than assuming the caller ordered them honestly.
        if (continuityRoots[0] != merkleRoot) revert ConflictingRoot(blockHeight, merkleRoot, continuityRoots[0]);

        added = _retain(chainKey, blockHeight, continuityRoots);

        emit BlocksMirrored(chainKey, blockHeight, blockHeight + uint64(continuityRoots.length) - 1, added);
    }

    function _retain(uint64 chainKey, uint64 firstBlock, bytes32[] calldata roots) internal returns (uint64 added) {
        mapping(uint64 => bytes32) storage chainRoots = rootOf[chainKey];
        uint256 n = roots.length;

        // Track the range in memory and settle the bookkeeping slots once, rather than paying a
        // warm SSTORE per block for a monotonically rising high-water mark.
        uint64 lo = type(uint64).max;
        uint64 hi;

        for (uint256 i; i < n; ++i) {
            uint64 bn = firstBlock + uint64(i);
            bytes32 stored = chainRoots[bn];

            if (stored == bytes32(0)) {
                chainRoots[bn] = roots[i];
                unchecked {
                    ++added;
                }
                if (bn < lo) lo = bn;
                if (bn > hi) hi = bn;
            } else if (stored != roots[i]) {
                // Two independently accepted proofs disagreeing about one block would mean the
                // attestation layer had certified conflicting histories. Refuse to record it.
                emit RootConflict(chainKey, bn, stored, roots[i]);
                revert ConflictingRoot(bn, stored, roots[i]);
            }
        }

        if (added == 0) return 0;

        mirroredBlocks[chainKey] += added;
        if (hi > highestMirrored[chainKey]) highestMirrored[chainKey] = hi;
        uint64 curLo = lowestMirrored[chainKey];
        if (curLo == 0 || lo < curLo) lowestMirrored[chainKey] = lo;
    }

    /// @notice Mirror using the precompile's batch form: many transactions, one shared continuity
    ///         proof.
    /// @dev The single-transaction path pays for a fresh continuity walk every time. The batch
    ///      form amortises one walk across up to ten queries, which is the efficient way to
    ///      notarise a working range of history. Every supplied Merkle root is additionally
    ///      required to equal the continuity root at its own height, so the batch cannot smuggle
    ///      in a proof belonging to some other block.
    /// @param rootsFromBlock Height that `continuityRoots[0]` describes.
    function mirrorBatch(
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        uint64 rootsFromBlock,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (uint64 added) {
        uint256 n = heights.length;
        if (n == 0 || n != encodedTransactions.length || n != merkleProofs.length) revert BatchMalformed();
        if (continuityRoots.length == 0) revert EmptyContinuity();

        // Bind each query to the shared continuity proof before trusting either.
        for (uint256 i; i < n; ++i) {
            if (heights[i] < rootsFromBlock) revert BatchMalformed();
            uint256 offset = heights[i] - rootsFromBlock;
            if (offset >= continuityRoots.length) revert BatchMalformed();
            if (merkleProofs[i].root != continuityRoots[offset]) {
                revert ConflictingRoot(heights[i], continuityRoots[offset], merkleProofs[i].root);
            }
        }

        bool ok = VERIFIER.verifyAndEmit(
            chainKey,
            heights,
            encodedTransactions,
            merkleProofs,
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots})
        );
        if (!ok) revert ProofRejected();

        added = _retain(chainKey, rootsFromBlock, continuityRoots);

        emit BlocksMirrored(
            chainKey, rootsFromBlock, rootsFromBlock + uint64(continuityRoots.length) - 1, added
        );
    }

    // ---------------------------------------------------------------------------------------
    // Verification against mirrored history
    // ---------------------------------------------------------------------------------------
    //
    // Two entry points, because there is exactly one safe way to expose this and one convenient
    // way, and conflating them is how integrations get exploited.
    //
    // The block-prover precompile REVERTS on every invalid input. A caller who writes
    //
    //     VERIFIER.verifyAndEmit(...);      // return value ignored
    //     _credit(user);                    // proceeds
    //
    // is accidentally safe against `0x0FD2`, because a bad proof takes the whole transaction
    // down. If our replacement returned `false` instead, that same code would credit the user on
    // a forged proof. `verifyOrRevert` therefore mirrors the precompile's semantics exactly and
    // is the documented default; `tryVerify` is the opt-in boolean form for callers that mean to
    // branch. Verified against the live precompile by the differential harness in
    // test/Differential.t.sol.

    /// @notice Verify a source-chain transaction against mirrored history, reverting on failure.
    /// @dev Semantics deliberately identical to the block-prover precompile: an unmirrored block,
    ///      a malformed path or a forged transaction all revert. Prefer this. No precompile call,
    ///      no continuity walk and no proving service are involved.
    /// @return txIndex The transaction's position within its block, recovered from the path shape.
    function verifyOrRevert(
        uint64 chainKey,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (uint64 txIndex) {
        bytes32 stored = rootOf[chainKey][blockNumber];
        if (stored == bytes32(0)) revert NotMirrored(chainKey, blockNumber);

        MirrorLib.ProofEntry[] memory path = _toPath(siblings);
        if (MirrorLib.computeRoot(encodedTransaction, path) != stored) {
            revert ProofInvalid(chainKey, blockNumber);
        }
        txIndex = MirrorLib.txIndexOf(path);
    }

    /// @notice Boolean form. Never reverts, including for an unmirrored block.
    /// @dev Use only when the caller genuinely branches on the result. `valid == false` carries no
    ///      information about *why*: unmirrored and forged are indistinguishable here by design,
    ///      so that a caller cannot accidentally treat "not yet notarised" as "does not exist".
    function tryVerify(
        uint64 chainKey,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (bool valid, uint64 txIndex) {
        bytes32 stored = rootOf[chainKey][blockNumber];
        if (stored == bytes32(0)) return (false, 0);

        MirrorLib.ProofEntry[] memory path = _toPath(siblings);
        if (MirrorLib.computeRoot(encodedTransaction, path) != stored) return (false, 0);
        return (true, MirrorLib.txIndexOf(path));
    }

    function _toPath(INativeQueryVerifier.MerkleProofEntry[] calldata siblings)
        internal
        pure
        returns (MirrorLib.ProofEntry[] memory path)
    {
        path = new MirrorLib.ProofEntry[](siblings.length);
        for (uint256 i; i < siblings.length; ++i) {
            path[i] = MirrorLib.ProofEntry({hash: siblings[i].hash, isLeft: siblings[i].isLeft});
        }
    }

    /// @notice Whether a block's commitment is held.
    function isMirrored(uint64 chainKey, uint64 blockNumber) external view returns (bool) {
        return rootOf[chainKey][blockNumber] != bytes32(0);
    }

    /// @notice Contiguous coverage from `fromBlock`, capped at `maxScan`. Lets a caller discover
    ///         which spans of history are already cheap to query.
    function contiguousFrom(uint64 chainKey, uint64 fromBlock, uint64 maxScan) external view returns (uint64 span) {
        mapping(uint64 => bytes32) storage chainRoots = rootOf[chainKey];
        while (span < maxScan && chainRoots[fromBlock + span] != bytes32(0)) {
            unchecked {
                ++span;
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // Spans: contiguity, proven once and reused
    // ---------------------------------------------------------------------------------------

    /// @notice Prove that every block in `[fromBlock, toBlock]` is mirrored, and record that fact
    ///         as a reusable span id.
    /// @dev Anyone may seal a span; sealing grants no privilege. The loop is the honest cost of
    ///      asserting completeness -- it is what makes a later claim of absence checkable, because
    ///      it establishes there is nowhere in the range for a contradicting transaction to hide.
    function sealSpan(uint64 chainKey, uint64 fromBlock, uint64 toBlock) external returns (uint256 spanId) {
        if (toBlock < fromBlock) revert BadRange();
        if (toBlock - fromBlock + 1 > MAX_SEAL_WINDOW) revert SealWindowTooLarge();

        _requireContiguous(chainKey, fromBlock, toBlock);

        spanId = _spans.length;
        _spans.push(Span({chainKey: chainKey, fromBlock: fromBlock, toBlock: toBlock}));
        emit SpanSealed(spanId, chainKey, fromBlock, toBlock);
    }

    /// @notice Grow an existing span upward, one bounded chunk at a time.
    /// @dev Spans over arbitrarily long histories are reachable without ever making a single
    ///      unbounded call: seal one window, then extend repeatedly. Only the span's creator-era
    ///      chain and contiguity matter -- extension is permissionless, because widening a span
    ///      only ever makes a claim harder to sustain, never easier.
    function extendSpan(uint256 spanId, uint64 newToBlock) external {
        if (spanId >= _spans.length) revert NoSuchSpan();
        Span storage sp = _spans[spanId];
        if (newToBlock <= sp.toBlock) revert BadRange();
        if (newToBlock - sp.toBlock > MAX_SEAL_WINDOW) revert SealWindowTooLarge();

        _requireContiguous(sp.chainKey, sp.toBlock + 1, newToBlock);
        sp.toBlock = newToBlock;
        emit SpanExtended(spanId, sp.chainKey, sp.fromBlock, newToBlock);
    }

    function _requireContiguous(uint64 chainKey, uint64 fromBlock, uint64 toBlock) internal view {
        mapping(uint64 => bytes32) storage chainRoots = rootOf[chainKey];
        for (uint64 bn = fromBlock; bn <= toBlock; ++bn) {
            if (chainRoots[bn] == bytes32(0)) revert GapInSpan(chainKey, bn);
        }
    }

    function spanCount() external view returns (uint256) {
        return _spans.length;
    }

    function spanOf(uint256 spanId) external view returns (Span memory) {
        if (spanId >= _spans.length) revert NoSuchSpan();
        return _spans[spanId];
    }

    /// @notice Whether `blockNumber` on `chainKey` falls inside a sealed span.
    function spanCovers(uint256 spanId, uint64 chainKey, uint64 blockNumber) external view returns (bool) {
        if (spanId >= _spans.length) revert NoSuchSpan();
        Span storage sp = _spans[spanId];
        return sp.chainKey == chainKey && blockNumber >= sp.fromBlock && blockNumber <= sp.toBlock;
    }
}
