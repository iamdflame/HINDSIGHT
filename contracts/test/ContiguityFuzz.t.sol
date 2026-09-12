// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV2} from "../src/AbsenceRegistryV2.sol";
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

/// @title Contiguity is the honesty of an absence claim
/// @notice A sealed span asserts that its whole range is held. If a single height inside it were
///         missing, that height is exactly where a disproving transaction could sit unreachable,
///         and a false claim would stand because nobody could produce the evidence.
///
/// @dev So "one missing height must make the range unsealable" is not a nice-to-have, it is the
///      property the negative side of this product depends on. It gets fuzzed over the position of
///      the gap, the width of the range, and the number of gaps, rather than checked at one
///      hand-picked index.
contract ContiguityFuzzTest is Test {
    EthereumMirror internal mirror;
    AbsenceRegistryV2 internal registry;

    uint64 constant ETH = 3;
    uint64 constant BASE = 1_000_000;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV2(mirror);
    }

    /// Fill `[BASE, BASE+len)` except the heights listed in `holes`.
    function _fill(uint256 len, uint256[] memory holes) internal {
        bytes32[] memory roots = new bytes32[](len);
        for (uint256 i; i < len; ++i) roots[i] = keccak256(abi.encodePacked("root", i));

        // Mirror the whole run first, then the holes are simply never written: `mirror()` always
        // retains a contiguous array, so gaps are produced by mirroring around them.
        uint256 cursor;
        while (cursor < len) {
            bool isHole = false;
            for (uint256 h; h < holes.length; ++h) {
                if (holes[h] == cursor) isHole = true;
            }
            if (isHole) {
                cursor++;
                continue;
            }
            uint256 runEnd = cursor;
            while (runEnd < len) {
                bool stop = false;
                for (uint256 h; h < holes.length; ++h) {
                    if (holes[h] == runEnd) stop = true;
                }
                if (stop) break;
                runEnd++;
            }
            bytes32[] memory slice = new bytes32[](runEnd - cursor);
            for (uint256 i; i < slice.length; ++i) slice[i] = roots[cursor + i];
            INativeQueryVerifier.MerkleProofEntry[] memory none;
            mirror.mirror(ETH, uint64(BASE + cursor), hex"00", slice[0], none, bytes32(0), slice);
            cursor = runEnd;
        }
    }

    /// A gap anywhere in the range makes the range unsealable, wherever it falls.
    function testFuzz_aGapAnywhereMakesTheRangeUnsealable(uint16 rawLen, uint16 rawHole) public {
        uint256 len = (uint256(rawLen) % 300) + 2; // 2..301
        uint256 hole = uint256(rawHole) % len;

        uint256[] memory holes = new uint256[](1);
        holes[0] = hole;
        _fill(len, holes);

        vm.expectRevert(
            abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, uint64(BASE + hole))
        );
        mirror.sealSpan(ETH, BASE, uint64(BASE + len - 1));
    }

    /// With no gap, the same range seals, and covers exactly what it says.
    function testFuzz_agaplessRangeSealsAndCoversExactly(uint16 rawLen) public {
        uint256 len = (uint256(rawLen) % 300) + 1;
        uint256[] memory none_;
        _fill(len, none_);

        uint256 spanId = mirror.sealSpan(ETH, BASE, uint64(BASE + len - 1));

        assertTrue(mirror.spanCovers(spanId, ETH, BASE), "span did not cover its own first block");
        assertTrue(mirror.spanCovers(spanId, ETH, uint64(BASE + len - 1)), "span did not cover its own last block");
        assertFalse(mirror.spanCovers(spanId, ETH, uint64(BASE + len)), "span covered a block beyond its end");
        if (BASE > 0) assertFalse(mirror.spanCovers(spanId, ETH, BASE - 1), "span covered a block before its start");
    }

    /// `contiguousFrom` stops at the first hole and never over-reports.
    function testFuzz_contiguousFromStopsAtTheFirstHole(uint16 rawLen, uint16 rawHole) public {
        uint256 len = (uint256(rawLen) % 300) + 2;
        uint256 hole = (uint256(rawHole) % (len - 1)) + 1; // never 0, so the run is non-empty

        uint256[] memory holes = new uint256[](1);
        holes[0] = hole;
        _fill(len, holes);

        assertEq(uint256(mirror.contiguousFrom(ETH, BASE, uint64(len))), hole, "run length disagreed with the hole");
    }

    /// Multiple gaps: sealing must fail at the *first* one, so the error names a real hole.
    function testFuzz_multipleGapsReportTheFirst(uint16 rawLen, uint16 rawA, uint16 rawB) public {
        uint256 len = (uint256(rawLen) % 200) + 4;
        uint256 a = (uint256(rawA) % (len - 1)) + 1;
        uint256 b = (uint256(rawB) % (len - 1)) + 1;
        if (a == b) return;
        uint256 first = a < b ? a : b;

        uint256[] memory holes = new uint256[](2);
        holes[0] = a;
        holes[1] = b;
        _fill(len, holes);

        vm.expectRevert(
            abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH, uint64(BASE + first))
        );
        mirror.sealSpan(ETH, BASE, uint64(BASE + len - 1));
    }

    // ---------------------------------------------------------------------------------------
    // Span lists, the V2 addition
    // ---------------------------------------------------------------------------------------

    /// Adjacent spans compose into one claim covering their union.
    function testFuzz_adjacentSpansCompose(uint8 rawParts, uint8 rawWidth) public {
        uint256 parts = (uint256(rawParts) % 6) + 2; // 2..7 spans
        uint256 width = (uint256(rawWidth) % 40) + 2;

        uint256[] memory none_;
        _fill(parts * width, none_);

        uint256[] memory spanIds = new uint256[](parts);
        for (uint256 i; i < parts; ++i) {
            spanIds[i] = mirror.sealSpan(ETH, uint64(BASE + i * width), uint64(BASE + (i + 1) * width - 1));
        }

        uint256 claimId = registry.assertAbsence{value: 0.01 ether}(
            spanIds, address(0xAAAA), keccak256("Topic"), bytes32(0), 0, 15 minutes
        );

        (, , , uint64 from, uint64 to) = registry.assurance(claimId);
        assertEq(uint256(from), BASE, "claim did not start at the first span");
        assertEq(uint256(to), BASE + parts * width - 1, "claim did not end at the last span");
    }

    /// A hole *between* two sealed spans is rejected, even though each span is itself gap-free.
    /// This is the attack the span list would otherwise open: seal around a gap, then claim across it.
    function testFuzz_spanListWithAGapIsRejected(uint8 rawWidth, uint8 rawSkip) public {
        uint256 width = (uint256(rawWidth) % 40) + 2;
        uint256 skip = (uint256(rawSkip) % 20) + 1; // blocks deliberately left unsealed between spans

        uint256[] memory none_;
        _fill(width * 2 + skip, none_);

        uint256[] memory spanIds = new uint256[](2);
        spanIds[0] = mirror.sealSpan(ETH, BASE, uint64(BASE + width - 1));
        spanIds[1] = mirror.sealSpan(ETH, uint64(BASE + width + skip), uint64(BASE + width + skip + width - 1));

        vm.expectRevert(
            abi.encodeWithSelector(
                AbsenceRegistryV2.SpansNotAdjacent.selector,
                uint64(BASE + width),
                uint64(BASE + width + skip)
            )
        );
        registry.assertAbsence{value: 0.01 ether}(
            spanIds, address(0xAAAA), keccak256("Topic"), bytes32(0), 0, 15 minutes
        );
    }

    /// Spans given out of order are rejected rather than silently sorted.
    function testFuzz_spanListOutOfOrderIsRejected(uint8 rawWidth) public {
        uint256 width = (uint256(rawWidth) % 40) + 2;
        uint256[] memory none_;
        _fill(width * 2, none_);

        uint256[] memory ordered = new uint256[](2);
        ordered[0] = mirror.sealSpan(ETH, BASE, uint64(BASE + width - 1));
        ordered[1] = mirror.sealSpan(ETH, uint64(BASE + width), uint64(BASE + 2 * width - 1));

        uint256[] memory reversed = new uint256[](2);
        reversed[0] = ordered[1];
        reversed[1] = ordered[0];

        vm.expectRevert();
        registry.assertAbsence{value: 0.01 ether}(
            reversed, address(0xAAAA), keccak256("Topic"), bytes32(0), 0, 15 minutes
        );
    }
}
