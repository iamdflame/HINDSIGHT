// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {MirrorLib} from "./MirrorLib.sol";

/// @title EthereumMirror
/// @notice A permissionless, ownerless archive of verified source-chain block commitments -- the
///         cache Attestcoin forgot to keep.
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
///      Measured against the live CC3 prover: a fresh query carries 1 root, a day-old one 11, a
///      180-day-old one 711, and a batch anchored at both ends of a window carries the whole
///      window (901 roots per call). Every existing integration discards all of them and keeps
///      one transaction. This contract keeps them.
///
///      Persisting them adds no trust assumption -- the precompile already certified them in the
///      same call -- but it changes the cost structure permanently. An Attestcoin query pays one
///      hash per block of continuity walked, and continuity lengthens with the age of the fact.
///      Against a held root the same transaction verifies from a Merkle path alone, in a `view`
///      call, forever, without the hosted prover and without the precompile.
///
/// @dev What changed from v1, and why it needed a new address.
///
///      v1 used `rootOf[k][h] == 0` to mean "not held". An empty Ethereum block -- no transactions
///      -- has a transaction root that genuinely *is* zero, so v1 could not tell "held, and empty"
///      from "never stored". Twenty-four such heights cut a 100,801-block archive into 25 runs and
///      capped an honest absence claim at 61.5 hours. That is not a footnote; it is the product.
///
///      v2 keeps a separate bitmap of which heights are held. `rootOf` may now be zero *and* held.
///      Contiguity is checked word by word instead of height by height, so a single sealed span
///      can cover 131,072 blocks rather than 5,000, and a 90-day claim is five spans.
///
///      `IMirror` is unchanged: every signature v1 exposed, v2 exposes with the same meaning.
///      `heldWord` is additive. There is still no owner, no pause and no upgrade path.
contract EthereumMirror {
    INativeQueryVerifier public constant VERIFIER = INativeQueryVerifier(address(uint160(0x0FD2)));

    /// @notice Largest number of blocks one `sealSpan` or `extendSpan` call may walk.
    /// @dev Contiguity costs one SLOAD per 256 blocks, so 2^17 blocks is ~512 cold reads --
    ///      about 1.1M gas. Ninety days of Ethereum at 12s is five such windows.
    uint64 public constant MAX_SEAL_WINDOW = 131_072;

    /// @notice chainKey => block number => transaction Merkle root of that block.
    /// @dev Zero for an empty block that is held. Use `isMirrored` for the existence question.
    mapping(uint64 => mapping(uint64 => bytes32)) public rootOf;

    /// @notice chainKey => (blockNumber >> 8) => bitmap of held heights within that word.
    /// @dev Bit `h & 255` of word `h >> 8` is set iff height `h` is held. This is the fact that
    ///      `rootOf` alone cannot carry, and it is what lets a span cross an empty block.
    mapping(uint64 => mapping(uint64 => uint256)) internal _held;

    /// @notice Count of distinct blocks mirrored per chain.
    mapping(uint64 => uint64) public mirroredBlocks;

    /// @notice Highest block number mirrored per chain.
    mapping(uint64 => uint64) public highestMirrored;

    /// @notice Lowest block number mirrored per chain.
    mapping(uint64 => uint64) public lowestMirrored;

    /// @notice A contiguous, fully-mirrored range of source-chain blocks, proven contiguous once.
    /// @dev Absence claims are only meaningful over ranges with no gaps: a gap is a place where a
    ///      disproving transaction could hide. The proof is paid once here and referenced by id.
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

    // ---------------------------------------------------------------------------------------
    // Notarising
    // ---------------------------------------------------------------------------------------

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
        // binds every entry of `continuityRoots`. This contract does not re-walk the chain: it
        // could not, because only the attestation layer holds the terminal digest to compare
        // against. See `MirrorLib.walkDigests` and `test/TrustBoundary.t.sol`.
        bool ok = VERIFIER.verifyAndEmit(
            chainKey,
            blockHeight,
            encodedTransaction,
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings}),
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots})
        );
        if (!ok) revert ProofRejected();

        // The one check made in this contract's own code: the caller supplies `merkleRoot` and
        // `continuityRoots` separately, so require the protocol's own invariant -- the array is
        // indexed from the query height -- rather than trusting argument ordering.
        if (continuityRoots[0] != merkleRoot) revert ConflictingRoot(blockHeight, merkleRoot, continuityRoots[0]);

        added = _retain(chainKey, blockHeight, continuityRoots);

        emit BlocksMirrored(chainKey, blockHeight, blockHeight + uint64(continuityRoots.length) - 1, added);
    }

    /// @notice Mirror using the precompile's batch form: many transactions, one shared continuity
    ///         proof.
    /// @dev Every supplied Merkle root is required to equal the continuity root at its own height,
    ///      so the batch cannot smuggle in a proof belonging to some other block.
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

    /// @dev Persist a contiguous array of roots starting at `firstBlock`. Walks the held bitmap one
    ///      word at a time so each 256-height word is read once and written at most once.
    ///
    ///      A zero root is a real root -- the root of an empty block -- and is recorded as held
    ///      without touching `rootOf` (the slot is already zero). That is the whole fix.
    function _retain(uint64 chainKey, uint64 firstBlock, bytes32[] calldata roots) internal returns (uint64 added) {
        mapping(uint64 => bytes32) storage chainRoots = rootOf[chainKey];
        mapping(uint64 => uint256) storage held = _held[chainKey];
        uint256 n = roots.length;

        // Track the range in memory and settle the bookkeeping slots once, rather than paying a
        // warm SSTORE per block for a monotonically rising high-water mark.
        uint64 lo = type(uint64).max;
        uint64 hi;

        uint256 i;
        uint64 bn = firstBlock;
        while (i < n) {
            uint64 word = bn >> 8;
            uint256 bits = held[word];
            uint256 updated = bits;

            while (i < n && (bn >> 8) == word) {
                uint256 mask = uint256(1) << (bn & 255);
                if ((bits & mask) == 0) {
                    if (roots[i] != bytes32(0)) chainRoots[bn] = roots[i];
                    updated |= mask;
                    unchecked {
                        ++added;
                    }
                    if (bn < lo) lo = bn;
                    if (bn > hi) hi = bn;
                } else if (chainRoots[bn] != roots[i]) {
                    // Two independently accepted proofs disagreeing about one block would mean the
                    // attestation layer had certified conflicting histories. Refuse to record it.
                    emit RootConflict(chainKey, bn, chainRoots[bn], roots[i]);
                    revert ConflictingRoot(bn, chainRoots[bn], roots[i]);
                }
                unchecked {
                    ++i;
                    ++bn;
                }
            }

            if (updated != bits) held[word] = updated;
        }

        if (added == 0) return 0;

        mirroredBlocks[chainKey] += added;
        if (hi > highestMirrored[chainKey]) highestMirrored[chainKey] = hi;
        uint64 curLo = lowestMirrored[chainKey];
        if (curLo == 0 || lo < curLo) lowestMirrored[chainKey] = lo;
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
    // branch. Verified against the live precompile by `worker/src/differential.ts`.

    /// @notice Verify a source-chain transaction against mirrored history, reverting on failure.
    /// @dev Semantics deliberately identical to the block-prover precompile: an unmirrored block,
    ///      a malformed path or a forged transaction all revert. No precompile call, no continuity
    ///      walk and no proving service are involved. A held empty block reverts `ProofInvalid`,
    ///      not `NotMirrored`: it is mirrored, and there is nothing in it to verify.
    /// @return txIndex The transaction's position within its block, recovered from the path shape.
    function verifyOrRevert(
        uint64 chainKey,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (uint64 txIndex) {
        if (!_isHeld(chainKey, blockNumber)) revert NotMirrored(chainKey, blockNumber);

        MirrorLib.ProofEntry[] memory path = _toPath(siblings);
        if (MirrorLib.computeRoot(encodedTransaction, path) != rootOf[chainKey][blockNumber]) {
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
        if (!_isHeld(chainKey, blockNumber)) return (false, 0);

        MirrorLib.ProofEntry[] memory path = _toPath(siblings);
        if (MirrorLib.computeRoot(encodedTransaction, path) != rootOf[chainKey][blockNumber]) return (false, 0);
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

    // ---------------------------------------------------------------------------------------
    // Coverage
    // ---------------------------------------------------------------------------------------

    /// @notice Whether a block's commitment is held. True for a held empty block.
    function isMirrored(uint64 chainKey, uint64 blockNumber) external view returns (bool) {
        return _isHeld(chainKey, blockNumber);
    }

    /// @notice The bitmap word covering heights `wordIndex * 256 .. wordIndex * 256 + 255`.
    /// @dev Lets a reader map coverage of a million heights in a few thousand calls. Additive; not
    ///      part of `IMirror`.
    function heldWord(uint64 chainKey, uint64 wordIndex) external view returns (uint256) {
        return _held[chainKey][wordIndex];
    }

    function _isHeld(uint64 chainKey, uint64 blockNumber) internal view returns (bool) {
        return (_held[chainKey][blockNumber >> 8] >> (blockNumber & 255)) & 1 == 1;
    }

    /// @notice Contiguous coverage from `fromBlock`, capped at `maxScan`. Lets a caller discover
    ///         which spans of history are already cheap to query.
    /// @dev Walks the bitmap a word at a time: the cost is one SLOAD per 256 held blocks, not one
    ///      per block.
    function contiguousFrom(uint64 chainKey, uint64 fromBlock, uint64 maxScan) external view returns (uint64 span) {
        mapping(uint64 => uint256) storage held = _held[chainKey];
        uint64 bn = fromBlock;
        while (span < maxScan) {
            uint256 have = held[bn >> 8] >> (bn & 255); // bit 0 is `bn`
            if (have & 1 == 0) break;

            uint256 ones = _trailingOnes(have); // run of set bits starting at `bn`
            uint256 room = 256 - (bn & 255); // bits remaining in this word from `bn`
            uint256 take = ones;
            if (take > room) take = room;
            if (span + take > maxScan) take = maxScan - span;

            span += uint64(take);
            bn += uint64(take);
            // A clear bit inside this word ended the run; only a full-word run continues.
            if (ones < room) break;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Spans: contiguity, proven once and reused
    // ---------------------------------------------------------------------------------------

    /// @notice Prove that every block in `[fromBlock, toBlock]` is mirrored, and record that fact
    ///         as a reusable span id.
    /// @dev Anyone may seal a span; sealing grants no privilege. The check is what makes a later
    ///      claim of absence checkable, because it establishes there is nowhere in the range for a
    ///      contradicting transaction to hide. A held empty block is not a gap: nothing hides in it.
    function sealSpan(uint64 chainKey, uint64 fromBlock, uint64 toBlock) external returns (uint256 spanId) {
        if (toBlock < fromBlock) revert BadRange();
        if (toBlock - fromBlock + 1 > MAX_SEAL_WINDOW) revert SealWindowTooLarge();

        _requireContiguous(chainKey, fromBlock, toBlock);

        spanId = _spans.length;
        _spans.push(Span({chainKey: chainKey, fromBlock: fromBlock, toBlock: toBlock}));
        emit SpanSealed(spanId, chainKey, fromBlock, toBlock);
    }

    /// @notice Grow an existing span upward, one bounded chunk at a time.
    /// @dev Extension is permissionless, because widening a span only ever makes a claim harder to
    ///      sustain, never easier. Claims snapshot span bounds at assertion, so a later extension
    ///      cannot drag evidence into an existing claim's range.
    function extendSpan(uint256 spanId, uint64 newToBlock) external {
        if (spanId >= _spans.length) revert NoSuchSpan();
        Span storage sp = _spans[spanId];
        if (newToBlock <= sp.toBlock) revert BadRange();
        if (newToBlock - sp.toBlock > MAX_SEAL_WINDOW) revert SealWindowTooLarge();

        _requireContiguous(sp.chainKey, sp.toBlock + 1, newToBlock);
        sp.toBlock = newToBlock;
        emit SpanExtended(spanId, sp.chainKey, sp.fromBlock, newToBlock);
    }

    /// @dev Word-wise contiguity: every bit in `[fromBlock, toBlock]` must be set. Full interior
    ///      words compare against all-ones; the two edge words are masked. The revert names the
    ///      first missing height, because "there is a gap" is not actionable and "block N" is.
    function _requireContiguous(uint64 chainKey, uint64 fromBlock, uint64 toBlock) internal view {
        mapping(uint64 => uint256) storage held = _held[chainKey];
        uint64 firstWord = fromBlock >> 8;
        uint64 lastWord = toBlock >> 8;

        for (uint64 w = firstWord; w <= lastWord; ++w) {
            uint256 need = type(uint256).max;
            if (w == firstWord) need &= type(uint256).max << (fromBlock & 255);
            if (w == lastWord) {
                uint256 top = toBlock & 255;
                if (top < 255) need &= (uint256(1) << (top + 1)) - 1;
            }

            uint256 have = held[w];
            if ((have & need) != need) {
                uint256 missing = need & ~have;
                revert GapInSpan(chainKey, (w << 8) | uint64(_lowestSetBit(missing)));
            }
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

    // ---------------------------------------------------------------------------------------
    // Bit arithmetic
    // ---------------------------------------------------------------------------------------

    /// @dev Number of consecutive set bits starting at bit 0. 256 for all-ones.
    function _trailingOnes(uint256 x) private pure returns (uint256) {
        return _trailingZeros(~x);
    }

    /// @dev Index of the lowest set bit; 256 if none. Binary search, eight steps.
    function _trailingZeros(uint256 x) private pure returns (uint256 n) {
        if (x == 0) return 256;
        if (x & type(uint128).max == 0) {
            n += 128;
            x >>= 128;
        }
        if (x & type(uint64).max == 0) {
            n += 64;
            x >>= 64;
        }
        if (x & type(uint32).max == 0) {
            n += 32;
            x >>= 32;
        }
        if (x & type(uint16).max == 0) {
            n += 16;
            x >>= 16;
        }
        if (x & type(uint8).max == 0) {
            n += 8;
            x >>= 8;
        }
        if (x & 0xF == 0) {
            n += 4;
            x >>= 4;
        }
        if (x & 0x3 == 0) {
            n += 2;
            x >>= 2;
        }
        if (x & 0x1 == 0) n += 1;
    }

    function _lowestSetBit(uint256 x) private pure returns (uint256) {
        return _trailingZeros(x);
    }
}
