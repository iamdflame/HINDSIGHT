// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MirrorLib} from "../src/MirrorLib.sol";

/// @title Property tests for the hashing core
/// @notice `MirrorLib` is the half of this system that must agree with the block-prover precompile
///         exactly. The differential harness checks that agreement against the live precompile on
///         a corpus of real transactions; this file checks the properties that must hold for
///         *every* input, including the shapes a real corpus will never contain.
///
/// @dev The tree builder here reimplements the Gluwa scheme from its specification rather than
///      calling the library under test, so a bug in `computeRoot` cannot hide behind a matching
///      bug in the fixture generator:
///
///          leaf  = keccak256(0x00 ++ txBytes)
///          inner = keccak256(0x01 ++ left ++ right)
///          an odd node at any level is paired against ZERO_HASH
contract MirrorLibFuzzTest is Test {
    bytes32 internal constant ZERO_HASH = bytes32(0);

    // ---------------------------------------------------------------------------------------
    // Reference implementation, independent of the library under test
    // ---------------------------------------------------------------------------------------

    function _leafHash(bytes memory leaf) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(0x00), leaf));
    }

    function _innerHash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(0x01), l, r));
    }

    /// @dev Returns every level of the tree, level 0 being the leaf hashes.
    function _levels(bytes[] memory leaves) internal pure returns (bytes32[][] memory levels) {
        uint256 depth = 1;
        for (uint256 w = leaves.length; w > 1; w = (w + 1) / 2) depth++;

        levels = new bytes32[][](depth);
        bytes32[] memory cur = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) cur[i] = _leafHash(leaves[i]);
        levels[0] = cur;

        uint256 d = 1;
        while (cur.length > 1) {
            uint256 w = (cur.length + 1) / 2;
            bytes32[] memory next = new bytes32[](w);
            for (uint256 i; i < w; ++i) {
                bytes32 l = cur[2 * i];
                bytes32 r = (2 * i + 1 < cur.length) ? cur[2 * i + 1] : ZERO_HASH;
                next[i] = _innerHash(l, r);
            }
            levels[d++] = next;
            cur = next;
        }
    }

    function _proof(bytes32[][] memory levels, uint256 index)
        internal
        pure
        returns (MirrorLib.ProofEntry[] memory path)
    {
        path = new MirrorLib.ProofEntry[](levels.length - 1);
        uint256 idx = index;
        for (uint256 d; d + 1 < levels.length; ++d) {
            bytes32[] memory level = levels[d];
            bool isRightChild = idx % 2 == 1;
            uint256 siblingIdx = isRightChild ? idx - 1 : idx + 1;
            bytes32 sibling = siblingIdx < level.length ? level[siblingIdx] : ZERO_HASH;
            // `isLeft` describes where the sibling sits, so it is set when we are the right child.
            path[d] = MirrorLib.ProofEntry({hash: sibling, isLeft: isRightChild});
            idx /= 2;
        }
    }

    function _leaves(uint256 count, uint256 seed) internal pure returns (bytes[] memory out) {
        out = new bytes[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = abi.encodePacked(keccak256(abi.encodePacked(seed, i)), uint16(i));
        }
    }

    // ---------------------------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------------------------

    /// Every leaf of any tree reproduces the root through its own path.
    function testFuzz_pathReproducesRootForEveryLeaf(uint8 rawCount, uint16 rawIndex, uint256 seed) public pure {
        uint256 count = uint256(rawCount) + 1; // 1..256
        uint256 index = uint256(rawIndex) % count;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];

        MirrorLib.ProofEntry[] memory path = _proof(levels, index);
        assertEq(MirrorLib.computeRoot(leaves[index], path), expected, "path did not reproduce the root");
    }

    /// The transaction's position is recoverable from the shape of the path alone.
    function testFuzz_txIndexIsRecoverableFromPathShape(uint8 rawCount, uint16 rawIndex, uint256 seed) public pure {
        uint256 count = uint256(rawCount) + 1;
        uint256 index = uint256(rawIndex) % count;

        bytes32[][] memory levels = _levels(_leaves(count, seed));
        MirrorLib.ProofEntry[] memory path = _proof(levels, index);

        assertEq(uint256(MirrorLib.txIndexOf(path)), index, "recovered the wrong transaction index");
    }

    /// Corrupting any single sibling breaks the root. This is the property the whole archive rests
    /// on: a mirrored root is only meaningful if no other path can reach it.
    function testFuzz_mutatingAnySiblingBreaksTheRoot(uint8 rawCount, uint16 rawIndex, uint8 rawLevel, uint256 seed)
        public
        pure
    {
        uint256 count = uint256(rawCount) + 2; // at least 2 leaves, so a path exists
        uint256 index = uint256(rawIndex) % count;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];

        MirrorLib.ProofEntry[] memory path = _proof(levels, index);
        if (path.length == 0) return;

        uint256 level = uint256(rawLevel) % path.length;
        path[level].hash = bytes32(uint256(path[level].hash) ^ 1);

        assertTrue(MirrorLib.computeRoot(leaves[index], path) != expected, "a mutated sibling still reached the root");
    }

    /// Corrupting the transaction itself breaks the root.
    function testFuzz_mutatingTheTransactionBreaksTheRoot(uint8 rawCount, uint16 rawIndex, uint256 seed) public pure {
        uint256 count = uint256(rawCount) + 1;
        uint256 index = uint256(rawIndex) % count;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];
        MirrorLib.ProofEntry[] memory path = _proof(levels, index);

        bytes memory tampered = abi.encodePacked(leaves[index], uint8(0xFF));
        assertTrue(MirrorLib.computeRoot(tampered, path) != expected, "a tampered transaction still reached the root");
    }

    /// Flipping a direction bit breaks the root, except in the degenerate case where the sibling
    /// happens to equal the node it is paired with -- which cannot arise from distinct leaves.
    function testFuzz_flippingADirectionBitBreaksTheRoot(uint8 rawCount, uint16 rawIndex, uint8 rawLevel, uint256 seed)
        public
        pure
    {
        uint256 count = uint256(rawCount) + 2;
        uint256 index = uint256(rawIndex) % count;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];

        MirrorLib.ProofEntry[] memory path = _proof(levels, index);
        if (path.length == 0) return;
        uint256 level = uint256(rawLevel) % path.length;

        // Recompute the node at this level to rule out the sibling-equals-node degeneracy.
        bytes32 node = MirrorLib.hashLeaf(leaves[index]);
        for (uint256 d; d < level; ++d) {
            node = path[d].isLeft ? MirrorLib.hashInner(path[d].hash, node) : MirrorLib.hashInner(node, path[d].hash);
        }
        if (path[level].hash == node) return;

        path[level].isLeft = !path[level].isLeft;
        assertTrue(MirrorLib.computeRoot(leaves[index], path) != expected, "a flipped direction bit still reached the root");
    }

    /// Truncating or extending a path breaks the root.
    function testFuzz_pathLengthIsLoadBearing(uint8 rawCount, uint16 rawIndex, uint256 seed) public pure {
        uint256 count = uint256(rawCount) + 4;
        uint256 index = uint256(rawIndex) % count;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];
        MirrorLib.ProofEntry[] memory path = _proof(levels, index);
        if (path.length < 2) return;

        MirrorLib.ProofEntry[] memory shortened = new MirrorLib.ProofEntry[](path.length - 1);
        for (uint256 i; i < shortened.length; ++i) shortened[i] = path[i];
        assertTrue(MirrorLib.computeRoot(leaves[index], shortened) != expected, "a truncated path still reached the root");

        MirrorLib.ProofEntry[] memory extended = new MirrorLib.ProofEntry[](path.length + 1);
        for (uint256 i; i < path.length; ++i) extended[i] = path[i];
        extended[path.length] = MirrorLib.ProofEntry({hash: ZERO_HASH, isLeft: false});
        assertTrue(MirrorLib.computeRoot(leaves[index], extended) != expected, "an extended path still reached the root");
    }

    /// Two different leaves in the same tree never share a path that reaches the root.
    function testFuzz_oneLeafCannotBorrowAnothersPath(uint8 rawCount, uint16 rawA, uint16 rawB, uint256 seed)
        public
        pure
    {
        uint256 count = uint256(rawCount) + 2;
        uint256 a = uint256(rawA) % count;
        uint256 b = uint256(rawB) % count;
        if (a == b) return;

        bytes[] memory leaves = _leaves(count, seed);
        bytes32[][] memory levels = _levels(leaves);
        bytes32 expected = levels[levels.length - 1][0];

        MirrorLib.ProofEntry[] memory pathA = _proof(levels, a);
        assertTrue(MirrorLib.computeRoot(leaves[b], pathA) != expected, "a foreign transaction reached the root");
    }

    // ---------------------------------------------------------------------------------------
    // The digest chain
    // ---------------------------------------------------------------------------------------

    /// Altering any root in a continuity array diverges the terminal digest. This is precisely why
    /// the precompile's acceptance of an array binds every entry of it, and therefore why the
    /// mirror may persist all of them.
    function testFuzz_anyAlteredRootDivergesTheTerminalDigest(
        uint8 rawLen,
        uint8 rawPos,
        uint64 firstBlock,
        bytes32 lowerEndpointDigest,
        uint256 seed
    ) public pure {
        uint256 len = uint256(rawLen) + 1;
        vm.assume(firstBlock < type(uint64).max - 300);
        uint256 pos = uint256(rawPos) % len;

        bytes32[] memory roots = new bytes32[](len);
        for (uint256 i; i < len; ++i) roots[i] = keccak256(abi.encodePacked(seed, i));

        bytes32 honest = MirrorLib.walkDigests(firstBlock, roots, lowerEndpointDigest);

        roots[pos] = bytes32(uint256(roots[pos]) ^ 1);
        bytes32 altered = MirrorLib.walkDigests(firstBlock, roots, lowerEndpointDigest);

        assertTrue(honest != altered, "the digest chain did not notice an altered root");
    }

    /// The chain is order-sensitive: the same roots at a different starting height differ.
    function testFuzz_digestChainIsBoundToItsStartingHeight(
        uint8 rawLen,
        uint64 firstBlock,
        bytes32 lowerEndpointDigest,
        uint256 seed
    ) public pure {
        uint256 len = uint256(rawLen) + 1;
        vm.assume(firstBlock > 0 && firstBlock < type(uint64).max - 300);

        bytes32[] memory roots = new bytes32[](len);
        for (uint256 i; i < len; ++i) roots[i] = keccak256(abi.encodePacked(seed, i));

        assertTrue(
            MirrorLib.walkDigests(firstBlock, roots, lowerEndpointDigest)
                != MirrorLib.walkDigests(firstBlock - 1, roots, lowerEndpointDigest),
            "the same roots produced the same digest at a different height"
        );
    }
}
