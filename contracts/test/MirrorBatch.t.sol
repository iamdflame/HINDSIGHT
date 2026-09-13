// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {MirrorLib} from "../src/MirrorLib.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @notice Implements the *batch* overload the earlier mocks left out, which is why `mirrorBatch`
///         had never been exercised. Records what it was asked so the test can check the mirror
///         forwarded the batch faithfully.
contract BatchVerifier {
    bool public rejecting;
    uint256 public lastBatchSize;
    bytes32 public lastContinuityHash;

    function setRejecting(bool v) external {
        rejecting = v;
    }

    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external view returns (bool) {
        return !rejecting;
    }

    function verifyAndEmit(
        uint64,
        uint64[] calldata heights,
        bytes[] calldata,
        INativeQueryVerifier.MerkleProof[] calldata,
        INativeQueryVerifier.ContinuityProof calldata continuity
    ) external returns (bool) {
        lastBatchSize = heights.length;
        lastContinuityHash = keccak256(abi.encode(continuity.lowerEndpointDigest, continuity.roots));
        return !rejecting;
    }
}

/// @title mirrorBatch, exercised at last
/// @notice Several transactions from different blocks, one shared continuity proof. The binding
///         check is the interesting part: every transaction's Merkle root must sit at its own
///         offset in the shared array, *before* the precompile is trusted with any of it.
contract MirrorBatchTest is Test {
    EthereumMirror internal mirror;
    BatchVerifier internal verifier;

    uint64 constant ETH = 3;
    uint64 constant FROM = 25_961_802;
    uint256 constant N_ROOTS = 22;

    bytes32[] internal roots;

    function setUp() public {
        verifier = new BatchVerifier();
        vm.etch(address(uint160(0x0FD2)), address(verifier).code);
        verifier = BatchVerifier(address(uint160(0x0FD2)));
        mirror = new EthereumMirror();

        for (uint256 i; i < N_ROOTS; ++i) roots.push(keccak256(abi.encodePacked("root", i)));
    }

    /// Three transactions at offsets 0, 3 and 21, each with a root matching the shared array.
    function _batch()
        internal
        view
        returns (uint64[] memory heights, bytes[] memory txs, INativeQueryVerifier.MerkleProof[] memory proofs)
    {
        uint256[3] memory offsets = [uint256(0), 3, 21];
        heights = new uint64[](3);
        txs = new bytes[](3);
        proofs = new INativeQueryVerifier.MerkleProof[](3);
        for (uint256 i; i < 3; ++i) {
            heights[i] = FROM + uint64(offsets[i]);
            txs[i] = abi.encodePacked("tx", i);
            INativeQueryVerifier.MerkleProofEntry[] memory none;
            proofs[i] = INativeQueryVerifier.MerkleProof({root: roots[offsets[i]], siblings: none});
        }
    }

    function test_batchRetainsTheWholeSharedRange() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();

        uint64 added = mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);

        assertEq(uint256(added), N_ROOTS, "batch should retain every root in the shared array");
        assertEq(uint256(mirror.mirroredBlocks(ETH)), N_ROOTS);
        for (uint256 i; i < N_ROOTS; ++i) {
            assertEq(mirror.rootOf(ETH, FROM + uint64(i)), roots[i]);
        }
        assertEq(verifier.lastBatchSize(), 3, "precompile did not see all three queries");
        assertEq(verifier.lastContinuityHash(), keccak256(abi.encode(bytes32(0), roots)));
    }

    /// A transaction whose root does not sit at its own offset is refused *before* the precompile
    /// is called -- the mirror never trusts argument ordering.
    function test_batchRefusesATransactionAtTheWrongOffset() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        p[1].root = roots[4]; // claims height FROM+3 but carries the root of FROM+4

        vm.expectRevert(
            abi.encodeWithSelector(EthereumMirror.ConflictingRoot.selector, h[1], roots[3], roots[4])
        );
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
        assertEq(verifier.lastBatchSize(), 0, "precompile was consulted on a malformed batch");
    }

    function test_batchRefusesAHeightBelowTheRange() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        h[0] = FROM - 1;
        vm.expectRevert(EthereumMirror.BatchMalformed.selector);
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
    }

    function test_batchRefusesAHeightBeyondTheRange() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        h[2] = FROM + uint64(N_ROOTS); // one past the last root
        vm.expectRevert(EthereumMirror.BatchMalformed.selector);
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
    }

    function test_batchRefusesMismatchedLengths() public {
        (uint64[] memory h,, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        bytes[] memory tooFew = new bytes[](2);
        vm.expectRevert(EthereumMirror.BatchMalformed.selector);
        mirror.mirrorBatch(ETH, h, tooFew, p, FROM, bytes32(0), roots);
    }

    function test_batchRefusesAnEmptyBatch() public {
        uint64[] memory h;
        bytes[] memory t;
        INativeQueryVerifier.MerkleProof[] memory p;
        vm.expectRevert(EthereumMirror.BatchMalformed.selector);
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
    }

    function test_batchRefusesEmptyContinuity() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        bytes32[] memory none;
        vm.expectRevert(EthereumMirror.EmptyContinuity.selector);
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), none);
    }

    /// A rejecting precompile retains nothing from a batch, exactly as for a single query.
    function test_rejectedBatchRetainsNothing() public {
        verifier.setRejecting(true);
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        vm.expectRevert(EthereumMirror.ProofRejected.selector);
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
        assertEq(uint256(mirror.mirroredBlocks(ETH)), 0);
    }

    /// Re-submitting an identical batch is idempotent; a conflicting one is refused.
    function test_batchIsIdempotentAndConflictSafe() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
        uint64 again = mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);
        assertEq(uint256(again), 0, "second identical batch added something");

        bytes32[] memory conflicting = new bytes32[](N_ROOTS);
        for (uint256 i; i < N_ROOTS; ++i) conflicting[i] = roots[i];
        conflicting[10] = keccak256("a different history");
        // Rebuild the proofs so the binding check passes and the conflict is caught in _retain.
        (uint64[] memory h2, bytes[] memory t2, INativeQueryVerifier.MerkleProof[] memory p2) = _batch();
        vm.expectRevert(
            abi.encodeWithSelector(
                EthereumMirror.ConflictingRoot.selector, FROM + 10, roots[10], conflicting[10]
            )
        );
        mirror.mirrorBatch(ETH, h2, t2, p2, FROM, bytes32(0), conflicting);
    }

    /// Single and batch paths land in the same storage and agree about it.
    function test_batchAndSingleAgree() public {
        (uint64[] memory h, bytes[] memory t, INativeQueryVerifier.MerkleProof[] memory p) = _batch();
        mirror.mirrorBatch(ETH, h, t, p, FROM, bytes32(0), roots);

        // A single query at an offset inside the same range: nothing new, nothing conflicting.
        bytes32[] memory tail = new bytes32[](N_ROOTS - 5);
        for (uint256 i; i < tail.length; ++i) tail[i] = roots[5 + i];
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        uint64 added = mirror.mirror(ETH, FROM + 5, hex"00", roots[5], none, bytes32(0), tail);
        assertEq(uint256(added), 0);
        assertEq(uint256(mirror.mirroredBlocks(ETH)), N_ROOTS);
    }
}
