// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
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

/// @title A block was stored, not a receipt
/// @notice Re-verifying the transaction a block was notarised *with* would only show a cached
///         receipt. Verifying three *other* transactions in the same block -- at index 0, in the
///         middle, and at the very end -- with the precompile deleted from the EVM, is what shows
///         a whole block was stored.
///
/// @dev The fixtures under `random-block-second-tx/` were rebuilt from a public Ethereum node with
///      no prover involved, and their root reproduced the root the archive holds on CC3. Here they
///      are replayed against a local mirror, then `0x0FD2` is etched to empty and every one of them
///      still verifies. This is the Foundry twin of what `/independence` does against live state.
contract SecondTransactionTest is Test {
    EthereumMirror internal mirror;
    uint64 constant ETH = 3;

    uint64 internal height;
    bytes32 internal root;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();

        // Notarise the block with the transaction it was really notarised with (index 263), so
        // the stored root is the one the second transactions must meet.
        string memory json = vm.readFile("test/fixtures/liquidation.json");
        height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        root = vm.parseJsonBytes32(json, ".root");
        bytes memory txBytes = vm.parseJsonBytes(json, ".txBytes");
        bytes32 lower = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        bytes32[] memory roots = vm.parseJsonBytes32Array(json, ".continuityRoots");
        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        INativeQueryVerifier.MerkleProofEntry[] memory sib = new INativeQueryVerifier.MerkleProofEntry[](sh.length);
        for (uint256 i; i < sh.length; ++i) sib[i] = INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]});
        mirror.mirror(ETH, height, txBytes, root, sib, lower, roots);

        // Now the precompile is gone. Everything below runs without it.
        vm.etch(address(uint160(0x0FD2)), hex"");
    }

    function _load(string memory path)
        internal
        view
        returns (uint64 idx, bytes memory txBytes, INativeQueryVerifier.MerkleProofEntry[] memory sib)
    {
        string memory json = vm.readFile(path);
        idx = uint64(vm.parseJsonUint(json, ".txIndex"));
        txBytes = vm.parseJsonBytes(json, ".txBytes");
        assertEq(vm.parseJsonBytes32(json, ".root"), root, "fixture root is not the notarised root");
        assertEq(uint64(vm.parseJsonUint(json, ".headerNumber")), height, "fixture is for another block");
        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        sib = new INativeQueryVerifier.MerkleProofEntry[](sh.length);
        for (uint256 i; i < sh.length; ++i) sib[i] = INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]});
    }

    function _verifyEvery() internal view {
        VmSafe.DirEntry[] memory files = vm.readDir("test/fixtures/mainnet/random-block-second-tx");
        assertTrue(files.length >= 3, "expected at least three second-transaction fixtures");
        for (uint256 f; f < files.length; ++f) {
            (uint64 idx, bytes memory txBytes, INativeQueryVerifier.MerkleProofEntry[] memory sib) = _load(files[f].path);
            assertTrue(idx != 263, "that is the notarising transaction, not a second one");

            uint64 got = mirror.verifyOrRevert(ETH, height, txBytes, sib);
            assertEq(got, idx, "second transaction did not verify at its own index");

            (bool ok, uint64 also) = mirror.tryVerify(ETH, height, txBytes, sib);
            assertTrue(ok);
            assertEq(also, idx);
        }
    }

    /// Every second transaction verifies with the precompile deleted from the EVM.
    function test_secondTransactionsVerifyWithThePrecompileDeleted() public view {
        assertEq(address(uint160(0x0FD2)).code.length, 0, "precompile should be gone");
        _verifyEvery();
    }

    /// And corrupting any of their paths fails, still with no precompile to lean on.
    function test_corruptedSecondTransactionsFailWithThePrecompileDeleted() public {
        VmSafe.DirEntry[] memory files = vm.readDir("test/fixtures/mainnet/random-block-second-tx");
        for (uint256 f; f < files.length; ++f) {
            (, bytes memory txBytes, INativeQueryVerifier.MerkleProofEntry[] memory sib) = _load(files[f].path);
            sib[0].hash = bytes32(uint256(sib[0].hash) ^ 1);
            vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH, height));
            mirror.verifyOrRevert(ETH, height, txBytes, sib);
        }
    }
}
