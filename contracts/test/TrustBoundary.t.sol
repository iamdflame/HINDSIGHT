// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {MirrorLib} from "../src/MirrorLib.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @notice Accepts everything, so these tests can isolate what the *mirror* checks from what the
///         precompile checks. The real precompile is the thing being stood in for, and the point
///         of this file is to establish exactly how much weight rests on it.
contract AlwaysAccepts {
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

/// @title Where the trust actually sits
/// @notice These tests pin exactly how much of the mirror's correctness rests on the precompile.
///
/// @dev `EthereumMirror.mirror()` never re-walks the continuity digest chain. The only check it
///      makes in its own code is `continuityRoots[0] == merkleRoot`; everything else about the
///      array is taken on the precompile's authority.
///
///      That delegation is sound -- altering any root diverges the terminal digest, so the
///      precompile's acceptance really does bind the whole array. It is also unavoidable:
///      `MirrorLib.walkDigests` returns a terminal digest, and only the attestation layer holds the
///      value to compare it against. The mirror could not perform an independent check even if it
///      wanted to.
///
///      History: the v1 deployment's `walkDigests` NatSpec claimed the mirror *did* assert this
///      "in its own code". It did not. v1 was fully verified on Blockscout and never redeployed, so
///      the source was left byte-for-byte and the correction lived here and in `CLAIMS.md`. The v2
///      redeploy corrected the comment itself; these tests remain as the executable statement of
///      the boundary, which has not moved.
contract TrustBoundaryTest is Test {
    EthereumMirror internal mirror;

    uint64 constant ETH_MAINNET = 3;

    uint64 internal blockHeight;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new AlwaysAccepts()).code);
        mirror = new EthereumMirror();

        string memory json = vm.readFile("test/fixtures/liquidation.json");
        blockHeight = uint64(vm.parseJsonUint(json, ".headerNumber"));
        txBytes = vm.parseJsonBytes(json, ".txBytes");
        merkleRoot = vm.parseJsonBytes32(json, ".root");
        lowerEndpointDigest = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        continuityRoots = vm.parseJsonBytes32Array(json, ".continuityRoots");

        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        for (uint256 i; i < sh.length; ++i) {
            siblings.push(INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]}));
        }
    }

    /// The mirror persists whatever array the precompile accepted, without re-deriving it.
    ///
    /// Corrupt every root except the first. A contract that re-walked the digest chain in its own
    /// code, as the `walkDigests` comment describes, would reject this. The mirror stores it.
    function test_mirrorTrustsThePrecompileForEveryRootAfterTheFirst() public {
        bytes32[] memory corrupted = new bytes32[](continuityRoots.length);
        corrupted[0] = merkleRoot; // the one entry the mirror does check
        for (uint256 i = 1; i < corrupted.length; ++i) {
            corrupted[i] = keccak256(abi.encodePacked("not the certified root", i));
        }

        mirror.mirror(ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, corrupted);

        // Stored verbatim: the mirror never independently established these.
        assertEq(
            mirror.rootOf(ETH_MAINNET, blockHeight + 1),
            corrupted[1],
            "mirror did not store the array the precompile accepted"
        );
        assertTrue(mirror.isMirrored(ETH_MAINNET, blockHeight + 1));
    }

    /// The single continuity check the mirror really does make in its own code.
    function test_theOnlyContinuityCheckIsThatRootZeroMatchesTheQueriedBlock() public {
        bytes32[] memory misindexed = new bytes32[](continuityRoots.length);
        for (uint256 i; i < misindexed.length; ++i) misindexed[i] = continuityRoots[i];
        misindexed[0] = keccak256("a root belonging to some other height");

        vm.expectRevert(
            abi.encodeWithSelector(
                EthereumMirror.ConflictingRoot.selector, blockHeight, merkleRoot, misindexed[0]
            )
        );
        mirror.mirror(ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, misindexed);
    }

    /// `walkDigests` is correct, and would in principle separate the honest array from the
    /// corrupted one. It is simply never reached from `mirror()`, and cannot be usefully: the value
    /// it returns is only meaningful against the attested terminal digest, which this contract
    /// does not have. This is the test that turns "reference helper" into "documented trust boundary".
    function test_walkDigestsWouldSeparateThemButIsNeverReached() public view {
        bytes32[] memory corrupted = new bytes32[](continuityRoots.length);
        corrupted[0] = continuityRoots[0];
        for (uint256 i = 1; i < corrupted.length; ++i) {
            corrupted[i] = keccak256(abi.encodePacked("not the certified root", i));
        }

        bytes32 honest = MirrorLib.walkDigests(blockHeight, continuityRoots, lowerEndpointDigest);
        bytes32 forged = MirrorLib.walkDigests(blockHeight, corrupted, lowerEndpointDigest);

        assertTrue(honest != forged, "digest chain failed to notice a corrupted array");
        assertTrue(honest != bytes32(0), "terminal digest should not be empty");
    }

    /// The genesis form of the digest -- a first block with no predecessor -- is the other helper
    /// the mirror never reaches. It is pinned here so that its shape is documented next to the
    /// reason it is unused: it belongs to the chain walk, and the chain walk belongs to the
    /// attestation layer.
    function test_genesisDigestIsTheChainedFormWithNoPredecessor() public pure {
        bytes32 root = keccak256("root");
        bytes32 genesis = MirrorLib.digestOf(1, root);
        assertEq(genesis, keccak256(abi.encodePacked(uint64(1), root)));
        // Distinct from the chained form even with a zero predecessor: the encoding differs.
        assertTrue(genesis != MirrorLib.digestOf(1, root, bytes32(0)));
        // And sensitive to both inputs.
        assertTrue(genesis != MirrorLib.digestOf(2, root));
        assertTrue(genesis != MirrorLib.digestOf(1, keccak256("other")));
    }

    /// Corollary, and the reason the delegation is acceptable: a rejecting precompile retains
    /// nothing at all. The mirror never writes on its own authority.
    function test_nothingIsRetainedWhenThePrecompileRefuses() public {
        vm.etch(address(uint160(0x0FD2)), address(new AlwaysRejects()).code);

        vm.expectRevert(EthereumMirror.ProofRejected.selector);
        mirror.mirror(
            ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );

        assertEq(mirror.mirroredBlocks(ETH_MAINNET), 0, "retained something without certification");
    }
}

contract AlwaysRejects {
    function verifyAndEmit(
        uint64,
        uint64,
        bytes calldata,
        INativeQueryVerifier.MerkleProof calldata,
        INativeQueryVerifier.ContinuityProof calldata
    ) external pure returns (bool) {
        return false;
    }
}
