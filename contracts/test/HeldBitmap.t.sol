// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract Accepts {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return true;
    }
}

/// @title An empty block is held, not a hole
/// @notice v1 could not tell "held, and the block was empty" from "never stored", because both read
///         as `rootOf == 0`. These are the tests that fail on v1 and pass on v2. They exist because
///         the difference is the difference between a 61.5-hour absence window and a 90-day one.
///
/// @dev Every word-wise routine is fuzzed against a naive per-height reference implemented here,
///      independently, so a bug in the bit arithmetic cannot hide behind a matching bug in the
///      contract. Edges are attacked on purpose: bit 0, bit 255, ranges that start or end on a word
///      boundary, ranges inside one word, ranges spanning many.
contract HeldBitmapTest is Test {
    EthereumMirror internal mirror;
    uint64 constant ETH = 3;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();
    }

    // ---------------------------------------------------------------------------------------
    // Reference: a naive per-height view of what should be held
    // ---------------------------------------------------------------------------------------

    mapping(uint64 => bool) internal refHeld;

    /// Mirror `[from, from+len)` with the given roots (zero roots allowed), and record the reference.
    function _mirrorWith(uint64 from, bytes32[] memory roots) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(ETH, from, hex"00", roots[0], none, bytes32(0), roots);
        for (uint256 i; i < roots.length; ++i) refHeld[from + uint64(i)] = true;
    }

    function _roots(uint256 len, uint256 seed, uint256 zeroEvery) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            // Some roots are genuinely zero: empty Ethereum blocks.
            r[i] = (zeroEvery != 0 && i % zeroEvery == zeroEvery - 1) ? bytes32(0) : keccak256(abi.encodePacked(seed, i));
        }
    }

    function _refContiguous(uint64 from, uint64 to) internal view returns (bool ok, uint64 firstGap) {
        for (uint64 h = from; h <= to; ++h) {
            if (!refHeld[h]) return (false, h);
        }
        return (true, 0);
    }

    function _refContiguousFrom(uint64 from, uint64 maxScan) internal view returns (uint64 n) {
        while (n < maxScan && refHeld[from + n]) ++n;
    }

    // ---------------------------------------------------------------------------------------
    // The two tests the mandate names
    // ---------------------------------------------------------------------------------------

    /// A zero root in the middle of a continuity array is an empty block. v2 holds it, and a span
    /// seals straight across it.
    function test_emptyBlockIsMirroredAndSealCrossesIt() public {
        uint64 from = 1_000_000;
        bytes32[] memory roots = _roots(50, 1, 0);
        roots[20] = bytes32(0); // an empty block at height 1_000_020
        // roots[0] must be non-zero for the mirror() binding check to be meaningful here
        _mirrorWith(from, roots);

        assertTrue(mirror.isMirrored(ETH, from + 20), "empty block should read as held");
        assertEq(mirror.rootOf(ETH, from + 20), bytes32(0), "its root really is zero");
        assertEq(uint256(mirror.mirroredBlocks(ETH)), 50, "the empty block counts");

        uint256 spanId = mirror.sealSpan(ETH, from, from + 49);
        assertTrue(mirror.spanCovers(spanId, ETH, from + 20), "span should cross the empty block");
        assertEq(uint256(mirror.contiguousFrom(ETH, from, 100)), 50, "run should not break at the empty block");
    }

    /// The failure v1 had: a held zero root must be distinguishable from a never-written zero.
    function test_zeroRootHeldDoesNotLookUnheld() public {
        uint64 from = 2_000_000;
        bytes32[] memory roots = _roots(3, 2, 0);
        roots[1] = bytes32(0);
        _mirrorWith(from, roots);

        // Held, root zero.
        assertTrue(mirror.isMirrored(ETH, from + 1));
        assertEq(mirror.rootOf(ETH, from + 1), bytes32(0));
        // Not held, root zero. Same `rootOf`, different answer.
        assertFalse(mirror.isMirrored(ETH, from + 3));
        assertEq(mirror.rootOf(ETH, from + 3), bytes32(0));
    }

    /// Verifying anything against a held empty block is `ProofInvalid` -- it is mirrored, and
    /// there is nothing in it -- never `NotMirrored`.
    function test_heldEmptyBlockIsProofInvalidNotUnmirrored() public {
        uint64 from = 3_000_000;
        bytes32[] memory roots = _roots(2, 3, 0);
        roots[1] = bytes32(0);
        _mirrorWith(from, roots);

        INativeQueryVerifier.MerkleProofEntry[] memory none;
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH, from + 1));
        mirror.verifyOrRevert(ETH, from + 1, hex"00", none);

        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.NotMirrored.selector, ETH, from + 2));
        mirror.verifyOrRevert(ETH, from + 2, hex"00", none);

        (bool ok,) = mirror.tryVerify(ETH, from + 1, hex"00", none);
        assertFalse(ok);
    }

    /// A conflicting re-mirror of an empty block is still caught: zero vs non-zero is a conflict.
    function test_emptyBlockConflictIsRefused() public {
        uint64 from = 4_000_000;
        bytes32[] memory roots = _roots(2, 4, 0);
        roots[1] = bytes32(0);
        _mirrorWith(from, roots);

        bytes32[] memory conflicting = _roots(2, 4, 0); // roots[1] now non-zero
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        vm.expectRevert(
            abi.encodeWithSelector(EthereumMirror.ConflictingRoot.selector, from + 1, bytes32(0), conflicting[1])
        );
        mirror.mirror(ETH, from, hex"00", conflicting[0], none, bytes32(0), conflicting);
    }

    /// Re-mirroring an identical array with empty blocks is idempotent.
    function test_reMirrorWithEmptyBlocksIsIdempotent() public {
        uint64 from = 5_000_000;
        bytes32[] memory roots = _roots(40, 5, 7); // every 7th is empty
        _mirrorWith(from, roots);
        uint64 before = mirror.mirroredBlocks(ETH);

        INativeQueryVerifier.MerkleProofEntry[] memory none;
        uint64 again = mirror.mirror(ETH, from, hex"00", roots[0], none, bytes32(0), roots);
        assertEq(uint256(again), 0);
        assertEq(mirror.mirroredBlocks(ETH), before);
    }

    // ---------------------------------------------------------------------------------------
    // The bitmap against a naive reference
    // ---------------------------------------------------------------------------------------

    /// `heldWord` and `isMirrored` agree with the reference for arbitrary placements, including
    /// arrays that straddle word boundaries and arrays shorter than a word.
    function testFuzz_heldWordMatchesReference(uint16 rawStart, uint16 rawLen, uint256 seed) public {
        uint64 from = 6_000_000 + uint64(rawStart); // anywhere in the word grid
        uint256 len = (uint256(rawLen) % 700) + 1; // up to ~3 words
        _mirrorWith(from, _roots(len, seed, 5));

        for (uint64 h = from - 2; h <= from + uint64(len) + 2; ++h) {
            assertEq(mirror.isMirrored(ETH, h), refHeld[h], "isMirrored disagrees with reference");
            bool bit = (mirror.heldWord(ETH, h >> 8) >> (h & 255)) & 1 == 1;
            assertEq(bit, refHeld[h], "heldWord disagrees with isMirrored");
        }
    }

    /// Contiguity over a range with a single hole reverts naming exactly that hole, wherever the
    /// hole and the range edges fall relative to word boundaries.
    function testFuzz_gapIsFoundWhereverItSits(uint16 rawStart, uint16 rawLen, uint16 rawHole) public {
        uint64 from = 7_000_000 + uint64(rawStart);
        uint256 len = (uint256(rawLen) % 1200) + 2;
        uint256 hole = uint256(rawHole) % len;

        // Two runs around the hole.
        if (hole > 0) _mirrorWith(from, _roots(hole, 1, 3));
        if (hole + 1 < len) _mirrorWith(from + uint64(hole) + 1, _roots(len - hole - 1, 2, 3));

        (bool ok, uint64 firstGap) = _refContiguous(from, from + uint64(len) - 1);
        assertFalse(ok);
        assertEq(firstGap, from + uint64(hole));

        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, from + uint64(hole)));
        mirror.sealSpan(ETH, from, from + uint64(len) - 1);
    }

    /// With no hole, the same ranges seal. Empty blocks inside them do not count as holes.
    function testFuzz_gaplessRangeSealsAcrossEmptyBlocks(uint16 rawStart, uint16 rawLen, uint8 rawEvery) public {
        uint64 from = 8_000_000 + uint64(rawStart);
        uint256 len = (uint256(rawLen) % 1200) + 1;
        uint256 every = (uint256(rawEvery) % 9) + 2; // an empty block every 2..10 heights
        _mirrorWith(from, _roots(len, 9, every));

        (bool ok,) = _refContiguous(from, from + uint64(len) - 1);
        assertTrue(ok);

        uint256 spanId = mirror.sealSpan(ETH, from, from + uint64(len) - 1);
        assertTrue(mirror.spanCovers(spanId, ETH, from));
        assertTrue(mirror.spanCovers(spanId, ETH, from + uint64(len) - 1));
    }

    /// `contiguousFrom` agrees with the naive scan, including when the run ends inside a word, at a
    /// word boundary, or is cut short by `maxScan`.
    function testFuzz_contiguousFromMatchesReference(uint16 rawStart, uint16 rawLen, uint16 rawHole, uint16 rawScan)
        public
    {
        uint64 from = 9_000_000 + uint64(rawStart);
        uint256 len = (uint256(rawLen) % 1200) + 1;
        uint256 hole = uint256(rawHole) % (len + 3); // may fall beyond the run (no hole)
        uint64 maxScan = uint64(rawScan) % 1500;

        if (hole >= len) {
            _mirrorWith(from, _roots(len, 11, 4));
        } else {
            if (hole > 0) _mirrorWith(from, _roots(hole, 11, 4));
            if (hole + 1 < len) _mirrorWith(from + uint64(hole) + 1, _roots(len - hole - 1, 12, 4));
        }

        assertEq(
            uint256(mirror.contiguousFrom(ETH, from, maxScan)),
            uint256(_refContiguousFrom(from, maxScan)),
            "contiguousFrom disagrees with the naive scan"
        );
        // And from a point strictly inside the run, too.
        if (len > 3) {
            uint64 inside = from + 2;
            assertEq(
                uint256(mirror.contiguousFrom(ETH, inside, maxScan)), uint256(_refContiguousFrom(inside, maxScan))
            );
        }
    }

    /// The specific edges: a hole exactly at bit 0 of a word, exactly at bit 255, and ranges that
    /// begin or end exactly on a word boundary.
    function test_wordBoundaryEdges() public {
        uint64 w = 10_000_000 / 256 * 256; // aligned start
        // Fill three full words except bit 0 of the middle word and bit 255 of the last.
        _mirrorWith(w, _roots(256, 20, 0)); // word 0 full
        _mirrorWith(w + 257, _roots(255, 21, 0)); // word 1, bit 0 missing
        _mirrorWith(w + 512, _roots(255, 22, 0)); // word 2, bit 255 missing

        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, w + 256));
        mirror.sealSpan(ETH, w, w + 300);

        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, w + 767));
        mirror.sealSpan(ETH, w + 257, w + 767);

        // Exactly the held parts seal.
        mirror.sealSpan(ETH, w, w + 255);
        mirror.sealSpan(ETH, w + 257, w + 766);

        assertEq(uint256(mirror.contiguousFrom(ETH, w, 10_000)), 256);
        assertEq(uint256(mirror.contiguousFrom(ETH, w + 257, 10_000)), 510);
        assertEq(uint256(mirror.contiguousFrom(ETH, w + 256, 10_000)), 0);
    }

    /// `_held` is the second state variable. Seeding it directly keeps these two tests about the
    /// contiguity check and its cost, rather than about filling 131k heights through `mirror()`
    /// (which the campaign does on-chain, in ~146 calls, and which a unit test cannot afford).
    function _holdWords(uint64 chainKey, uint64 firstWord, uint256 count, uint256 value) internal {
        bytes32 outer = keccak256(abi.encode(chainKey, uint256(1)));
        for (uint256 i; i < count; ++i) {
            bytes32 slot = keccak256(abi.encode(firstWord + uint64(i), outer));
            vm.store(address(mirror), slot, bytes32(value));
        }
    }

    /// A single span can now cover 2^17 blocks, and not one more.
    function test_sealWindowIsLarge() public {
        assertEq(uint256(mirror.MAX_SEAL_WINDOW()), 131_072);
        uint64 from = 20_000_224; // deliberately not word-aligned: 513 seeded words cover it either way
        _holdWords(ETH, from >> 8, 513, type(uint256).max); // 2^17 + 256 heights held

        assertTrue(mirror.isMirrored(ETH, from), "seeded bitmap should read as held");
        uint256 spanId = mirror.sealSpan(ETH, from, from + 131_071);
        assertTrue(mirror.spanCovers(spanId, ETH, from + 131_071));

        vm.expectRevert(EthereumMirror.SealWindowTooLarge.selector);
        mirror.sealSpan(ETH, from, from + 131_072);
    }

    /// Gas: sealing 2^17 blocks reads ~512 words, not 131,072 slots.
    function test_gas_sealTwoToTheSeventeen() public {
        uint64 from = 30_000_128; // = 117_188 * 256
        _holdWords(ETH, from >> 8, 512, type(uint256).max);

        uint256 g = gasleft();
        mirror.sealSpan(ETH, from, from + 131_071);
        uint256 used = g - gasleft();
        assertLt(used, 2_000_000, "sealing 2^17 blocks should cost about 512 cold reads");
        emit log_named_uint("gas to seal 131,072 blocks", used);
    }

    /// And the same seeded range with one bit cleared deep inside it names that height.
    function test_sealOfTwoToTheSeventeenFindsASingleClearBit() public {
        uint64 from = 40_000_000; // = 156_250 * 256
        _holdWords(ETH, from >> 8, 512, type(uint256).max);
        // clear bit 77 of word 300
        bytes32 outer = keccak256(abi.encode(ETH, uint256(1)));
        bytes32 slot = keccak256(abi.encode((from >> 8) + 300, outer));
        vm.store(address(mirror), slot, bytes32(type(uint256).max & ~(uint256(1) << 77)));

        uint64 missing = from + 300 * 256 + 77;
        assertFalse(mirror.isMirrored(ETH, missing));
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, missing));
        mirror.sealSpan(ETH, from, from + 131_071);
        assertEq(uint256(mirror.contiguousFrom(ETH, from, 200_000)), 300 * 256 + 77);
    }
}
