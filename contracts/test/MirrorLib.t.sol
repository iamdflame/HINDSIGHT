// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {MirrorLib} from "../src/MirrorLib.sol";

/// @notice Validates the Solidity Merkle reimplementation against *real* Attestcoin proof data
///         for *real* Ethereum mainnet transactions, fetched live from the Creditcoin testnet
///         prover. If these pass, a mirrored root is sufficient to verify a mainnet transaction
///         with no continuity proof and no prover service.
contract MirrorLibTest is Test {
    struct Fixture {
        uint64 chainKey;
        uint64 headerNumber;
        uint64 txIndex;
        bytes txBytes;
        bytes32 root;
        bytes32[] siblingHashes;
        bool[] siblingIsLeft;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    function _load(string memory name) internal view returns (Fixture memory f) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name, ".json"));
        f.chainKey = uint64(vm.parseJsonUint(json, ".chainKey"));
        f.headerNumber = uint64(vm.parseJsonUint(json, ".headerNumber"));
        f.txIndex = uint64(vm.parseJsonUint(json, ".txIndex"));
        f.txBytes = vm.parseJsonBytes(json, ".txBytes");
        f.root = vm.parseJsonBytes32(json, ".root");
        f.siblingHashes = vm.parseJsonBytes32Array(json, ".siblingHashes");
        f.siblingIsLeft = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        f.lowerEndpointDigest = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        f.continuityRoots = vm.parseJsonBytes32Array(json, ".continuityRoots");
    }

    function _path(Fixture memory f) internal pure returns (MirrorLib.ProofEntry[] memory p) {
        p = new MirrorLib.ProofEntry[](f.siblingHashes.length);
        for (uint256 i; i < p.length; ++i) {
            p[i] = MirrorLib.ProofEntry({hash: f.siblingHashes[i], isLeft: f.siblingIsLeft[i]});
        }
    }

    /// The central claim: a leaf plus 9 sibling hashes reproduces the real block root.
    function test_reproducesRealMainnetRoot_liquidation() public view {
        Fixture memory f = _load("liquidation");
        assertEq(MirrorLib.computeRoot(f.txBytes, _path(f)), f.root, "root mismatch");
    }

    function test_reproducesRealMainnetRoot_repay() public view {
        Fixture memory f = _load("repay");
        assertEq(MirrorLib.computeRoot(f.txBytes, _path(f)), f.root, "root mismatch");
    }

    /// Intra-block ordering, recovered locally, must agree with the prover's own txIndex.
    function test_recoversTxIndexWithoutPrecompile() public view {
        Fixture memory a = _load("liquidation");
        assertEq(MirrorLib.txIndexOf(_path(a)), a.txIndex, "liquidation txIndex");
        Fixture memory b = _load("repay");
        assertEq(MirrorLib.txIndexOf(_path(b)), b.txIndex, "repay txIndex");
    }

    /// roots[0] is the queried block's own root: the continuity array is indexed from the
    /// query height, which is what licenses the mirror to store roots[i] as block height+i.
    function test_continuityRootsAreIndexedFromQueryHeight() public view {
        Fixture memory f = _load("liquidation");
        assertEq(f.continuityRoots[0], f.root, "roots[0] != queried block root");
        Fixture memory g = _load("repay");
        assertEq(g.continuityRoots[0], g.root, "roots[0] != queried block root");
    }

    /// Forgery: flipping a single byte of the transaction must not reproduce the root.
    function test_tamperedTxBytesFailsToReproduceRoot() public view {
        Fixture memory f = _load("liquidation");
        bytes memory t = f.txBytes;
        t[t.length - 1] = bytes1(uint8(t[t.length - 1]) ^ 0x01);
        assertTrue(MirrorLib.computeRoot(t, _path(f)) != f.root, "tampered tx reproduced root");
    }

    /// Forgery: mutating one sibling must not reproduce the root.
    function test_tamperedSiblingFailsToReproduceRoot() public view {
        Fixture memory f = _load("liquidation");
        MirrorLib.ProofEntry[] memory p = _path(f);
        p[0].hash = bytes32(uint256(p[0].hash) ^ 1);
        assertTrue(MirrorLib.computeRoot(f.txBytes, p) != f.root, "tampered sibling reproduced root");
    }

    /// Forgery: flipping a direction bit changes the claimed position, so it must not verify.
    function test_flippedDirectionFailsToReproduceRoot() public view {
        Fixture memory f = _load("liquidation");
        MirrorLib.ProofEntry[] memory p = _path(f);
        p[0].isLeft = !p[0].isLeft;
        assertTrue(MirrorLib.computeRoot(f.txBytes, p) != f.root, "flipped direction reproduced root");
    }

    /// Cost of verification once a root is mirrored. This is the number that replaces an
    /// unbounded continuity walk.
    function test_gas_verifyAgainstMirroredRoot() public view {
        Fixture memory f = _load("liquidation");
        MirrorLib.ProofEntry[] memory p = _path(f);
        uint256 g0 = gasleft();
        bytes32 r = MirrorLib.computeRoot(f.txBytes, p);
        uint256 used = g0 - gasleft();
        assertEq(r, f.root);
        console.log("gas to verify a real mainnet tx against a mirrored root:", used);
        console.log("merkle path length:", p.length);
    }
}
