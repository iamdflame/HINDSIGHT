// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaidInvoice} from "../src/PaidInvoice.sol";
import {IMirror} from "hindsight/IMirror.sol";
import {IAbsenceV3} from "hindsight/IAbsenceV3.sol";
import {EthereumMirror} from "hindsight/EthereumMirror.sol";
import {AbsenceRegistryV3} from "hindsight/AbsenceRegistryV3.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// The precompile at 0x0FD2, as it behaves for the one call that *does* need it: notarising a block.
contract MockVerifier {
    function verifyAndEmit(uint64, uint64, bytes calldata, INativeQueryVerifier.MerkleProof calldata, INativeQueryVerifier.ContinuityProof calldata) external pure returns (bool) {
        return true;
    }
}

/// @title What a consumer gets, and what it is protected from
/// @notice Runs against a real Ethereum mainnet transaction (a USDC transfer inside an Aave
///         liquidation) whose block the fixture holds. The interesting test is the second one: the
///         precompile is deleted and the consumer keeps working, because the root it needs was held
///         before the call and inclusion is a Merkle path against stored state.
contract PaidInvoiceTest is Test {
    EthereumMirror mirror;
    AbsenceRegistryV3 registry;
    PaidInvoice invoice;

    uint64 constant ETH = 3;
    address constant PRECOMPILE = address(uint160(0x0FD2));

    uint64 height;
    bytes txBytes;
    INativeQueryVerifier.MerkleProofEntry[] siblings;
    uint32 transferLog;

    function setUp() public {
        vm.etch(PRECOMPILE, address(new MockVerifier()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV3(mirror);
        invoice = new PaidInvoice(IMirror(address(mirror)), IAbsenceV3(address(registry)), ETH);

        string memory json = vm.readFile("../../contracts/test/fixtures/liquidation.json");
        height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        txBytes = vm.parseJsonBytes(json, ".txBytes");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        bytes32 lower = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        bytes32[] memory roots = vm.parseJsonBytes32Array(json, ".continuityRoots");
        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        for (uint256 i; i < sh.length; ++i) siblings.push(INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]}));

        // The one step that needs the precompile: holding the block. Done once, by anyone, before.
        mirror.mirror(ETH, height, txBytes, root, siblings, lower, roots);
        transferLog = _firstTransferLog(txBytes);
    }

    /// The first ERC-20 Transfer in the receipt: a liquidation moves collateral, so there is one.
    function _firstTransferLog(bytes memory encoded) internal pure returns (uint32) {
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encoded);
        for (uint32 i; i < r.receiptLogs.length; ++i) {
            if (r.receiptLogs[i].topics.length == 3 && r.receiptLogs[i].topics[0] == keccak256("Transfer(address,address,uint256)")) return i;
        }
        revert("fixture has no Transfer");
    }

    // Check 1 of 5 — status: the consumer refuses a reverted transaction. (In the contract.)
    // Check 2 of 5 — replay: the same leaf is never counted twice. (In the contract.)
    // Checks 3-5 — depth, clock, stall: yours, at the call site; `hindsight-mirror checks` measures them.

    function test_aRealTransferIsCountedOnce() public {
        uint256 amount = invoice.prove(height, txBytes, siblings, transferLog);
        assertGt(amount, 0);
        vm.expectRevert();
        invoice.prove(height, txBytes, siblings, transferLog);
    }

    /// The claim this template exists to let you make: with 0x0FD2 deleted, the answer does not change.
    function test_worksWithThePrecompileDeleted() public {
        vm.etch(PRECOMPILE, "");
        assertEq(PRECOMPILE.code.length, 0, "precompile is gone");
        uint256 amount = invoice.prove(height, txBytes, siblings, transferLog);
        assertGt(amount, 0, "inclusion is a Merkle path against a held root; nothing else is in the loop");
    }

    /// And the control: with the *mirror* gone, nothing can be proven, which is the right direction.
    function test_failsClosedWithoutTheMirror() public {
        vm.etch(address(mirror), "");
        vm.expectRevert();
        invoice.prove(height, txBytes, siblings, transferLog);
    }

    /// A block the archive does not hold is not "false"; it is unanswerable, and the consumer reverts.
    /// (The fixture's continuity proof holds a run of heights above the anchor, so step well past it.)
    function test_anUnheldBlockIsNotAnAnswer() public {
        uint64 unheld = height + 10_000;
        assertFalse(mirror.isMirrored(ETH, unheld));
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.NotMirrored.selector, ETH, unheld));
        invoice.prove(unheld, txBytes, siblings, transferLog);
    }

    /// A forged path against a held root is refused by the mirror before the consumer sees a log.
    function test_aForgedPathIsRefused() public {
        INativeQueryVerifier.MerkleProofEntry[] memory forged = siblings;
        forged[0].hash = bytes32(uint256(forged[0].hash) ^ 1);
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH, height));
        invoice.prove(height, txBytes, forged, transferLog);
    }
}
