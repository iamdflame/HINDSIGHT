// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @notice Stand-in for the native block-prover precompile, which is Substrate runtime code and
///         therefore absent from a local EVM. Acceptance is what we mock; the Merkle mathematics
///         is validated against real prover output in MirrorLib.t.sol, and the real precompile is
///         exercised by the on-chain deployment script.
contract MockVerifier {
    // Inverted on purpose: `vm.etch` copies runtime code but not storage, so the flag must
    // default to the accepting case at the etched address.
    bool public rejecting;

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
}

contract EthereumMirrorTest is Test {
    EthereumMirror internal mirror;
    MockVerifier internal mock;

    uint64 constant ETH_MAINNET = 3;

    // Real Aave V3 liquidation on Ethereum mainnet, proof served by the Creditcoin testnet prover.
    uint64 internal blockHeight;
    uint64 internal expectedTxIndex;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    function setUp() public {
        mock = new MockVerifier();
        vm.etch(address(uint160(0x0FD2)), address(mock).code);
        mirror = new EthereumMirror();

        string memory json = vm.readFile("test/fixtures/liquidation.json");
        blockHeight = uint64(vm.parseJsonUint(json, ".headerNumber"));
        expectedTxIndex = uint64(vm.parseJsonUint(json, ".txIndex"));
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

    function _mirror() internal returns (uint64) {
        return mirror.mirror(
            ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
    }

    /// One query retains the commitment of every block its continuity proof carried.
    function test_oneQueryMirrorsWholeContinuityRange() public {
        uint64 added = _mirror();
        assertEq(added, uint64(continuityRoots.length), "should retain every root");
        assertEq(mirror.mirroredBlocks(ETH_MAINNET), added);

        for (uint256 i; i < continuityRoots.length; ++i) {
            uint64 bn = blockHeight + uint64(i);
            assertEq(mirror.rootOf(ETH_MAINNET, bn), continuityRoots[i], "root not retained");
        }
        console.log("Ethereum blocks mirrored by a single query:", added);
        console.log("contiguous span:", mirror.contiguousFrom(ETH_MAINNET, blockHeight, 500));
    }

    /// The payoff: a real mainnet transaction verifies against mirrored history with no
    /// continuity proof, no precompile call, and no prover service.
    function test_verifiesRealMainnetTxWithoutPrecompileOrProver() public {
        _mirror();
        // Remove the precompile entirely: mirrored history must remain verifiable without it.
        vm.etch(address(uint160(0x0FD2)), hex"");

        uint64 txIndex = mirror.verifyOrRevert(ETH_MAINNET, blockHeight, txBytes, siblings);
        assertEq(txIndex, expectedTxIndex, "txIndex mismatch");

        (bool valid, uint64 alsoIdx) = mirror.tryVerify(ETH_MAINNET, blockHeight, txBytes, siblings);
        assertTrue(valid, "tryVerify disagreed with verifyOrRevert");
        assertEq(alsoIdx, expectedTxIndex);
    }

    /// A neighbour block carried by the same proof is queryable even though no transaction of
    /// its own was ever proved. This is the coverage that makes absence claims checkable.
    function test_neighbourBlocksBecomeQueryable() public {
        _mirror();
        uint64 neighbour = blockHeight + uint64(continuityRoots.length) - 1;
        assertTrue(mirror.isMirrored(ETH_MAINNET, neighbour), "neighbour not mirrored");
        assertTrue(neighbour > blockHeight, "range should span more than the queried block");
    }

    /// A transaction that does not belong to the block must not verify against it.
    function test_foreignTxDoesNotVerify() public {
        _mirror();
        bytes memory tampered = txBytes;
        tampered[0] = bytes1(uint8(tampered[0]) ^ 0xFF);
        (bool valid,) = mirror.tryVerify(ETH_MAINNET, blockHeight, tampered, siblings);
        assertFalse(valid, "tampered tx verified");
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH_MAINNET, blockHeight));
        mirror.verifyOrRevert(ETH_MAINNET, blockHeight, tampered, siblings);
    }

    /// If the precompile rejects, nothing is retained.
    function test_rejectedProofRetainsNothing() public {
        MockVerifier(address(uint160(0x0FD2))).setRejecting(true);
        vm.expectRevert(EthereumMirror.ProofRejected.selector);
        _mirror();
        assertEq(mirror.mirroredBlocks(ETH_MAINNET), 0);
    }

    /// The caller passes `merkleRoot` and `continuityRoots` separately; the contract enforces the
    /// protocol invariant linking them rather than trusting the caller's ordering.
    function test_rejectsContinuityNotIndexedFromQueryHeight() public {
        bytes32[] memory shifted = new bytes32[](continuityRoots.length);
        for (uint256 i; i < continuityRoots.length; ++i) shifted[i] = continuityRoots[i];
        shifted[0] = bytes32(uint256(shifted[0]) ^ 1);

        vm.expectRevert();
        mirror.mirror(ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, shifted);
    }

    /// Re-mirroring the same range is idempotent, not double-counted.
    function test_reMirroringIsIdempotent() public {
        uint64 first = _mirror();
        uint64 second = _mirror();
        assertEq(second, 0, "second pass should add nothing");
        assertEq(mirror.mirroredBlocks(ETH_MAINNET), first);
    }

    /// Two accepted proofs disagreeing about one block would mean the attestation layer
    /// certified conflicting histories. The mirror refuses rather than silently overwriting.
    function test_conflictingRootIsRefused() public {
        _mirror();
        bytes32[] memory evil = new bytes32[](1);
        evil[0] = bytes32(uint256(continuityRoots[0]) ^ 0xdead);
        vm.expectRevert();
        mirror.mirror(ETH_MAINNET, blockHeight, txBytes, evil[0], siblings, lowerEndpointDigest, evil);
    }

    /// The two entry points must differ only in how they report failure, never in the verdict.
    function test_unmirroredBlock_revertsOrReturnsFalse() public {
        uint64 absent = blockHeight + 9_999_999;
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.NotMirrored.selector, ETH_MAINNET, absent));
        mirror.verifyOrRevert(ETH_MAINNET, absent, txBytes, siblings);

        (bool valid, uint64 idx) = mirror.tryVerify(ETH_MAINNET, absent, txBytes, siblings);
        assertFalse(valid, "tryVerify must not revert, and must not claim validity");
        assertEq(idx, 0, "no index for an unverified transaction");
    }

    /// A span may not be walked without bound.
    function test_sealWindowIsCapped() public {
        _mirror();
        // Read the constant first: vm.expectRevert binds to the next external call, and an
        // inlined getter would consume it.
        uint64 cap = mirror.MAX_SEAL_WINDOW();
        vm.expectRevert(EthereumMirror.SealWindowTooLarge.selector);
        mirror.sealSpan(ETH_MAINNET, blockHeight, blockHeight + cap);
    }

    function test_gas_mirrorWholeRange() public {
        uint256 g0 = gasleft();
        uint64 added = _mirror();
        uint256 used = g0 - gasleft();
        console.log("gas to mirror", added, "Ethereum block commitments:", used);
        console.log("gas per block retained:", used / added);
    }
}
