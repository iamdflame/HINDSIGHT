// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV2} from "../src/AbsenceRegistryV2.sol";
import {MirrorLib} from "../src/MirrorLib.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
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

/// @title A reverted liquidation is not a liquidation
/// @notice The block prover certifies *inclusion*, never *success*. A transaction that attempted a
///         liquidation and reverted is in the block, has a valid Merkle path, and carries the
///         `LiquidationCall` log in its receipt fields as they were encoded -- and it did not
///         liquidate anyone. If the registry accepted it, a refuter could destroy a true claim with
///         evidence of nothing.
///
/// @dev The leaf under test is the real mainnet liquidation with only its receipt status rewritten
///      from 1 to 0, re-encoded, and mirrored in a one-leaf tree so that the Merkle path verifies.
///      Everything up to the status check passes; the status check must be the thing that stops it.
contract FailedTransactionTest is Test {
    EthereumMirror internal mirror;
    AbsenceRegistryV2 internal registry;

    uint64 constant ETH = 3;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    address constant LIQUIDATED_BORROWER = 0xa63f5B1AcE5Ef4BcE91d3f12f31B8F2eA110B980;

    address internal claimant = address(0xA11CE);
    address internal refuter = address(0xB0B);

    uint64 internal height;
    bytes internal realTx;
    bytes internal failedTx;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV2(mirror);

        string memory json = vm.readFile("test/fixtures/liquidation.json");
        height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        realTx = vm.parseJsonBytes(json, ".txBytes");
        failedTx = _withStatus(realTx, 0);

        vm.deal(claimant, 10 ether);
        vm.deal(refuter, 1 ether);
    }

    /// Re-encode a leaf with a different receipt status and nothing else changed.
    function _withStatus(bytes memory encoded, uint8 status) internal pure returns (bytes memory) {
        (uint8 txType, bytes[] memory chunks) = abi.decode(encoded, (uint8, bytes[]));
        uint256 receiptIdx = txType <= 2 ? 2 : 3;

        (, uint64 gasUsed, EvmV1Decoder.LogEntryTuple[] memory logs, bytes memory bloom) =
            abi.decode(chunks[receiptIdx], (uint8, uint64, EvmV1Decoder.LogEntryTuple[], bytes));

        chunks[receiptIdx] = abi.encode(status, gasUsed, logs, bloom);
        return abi.encode(txType, chunks);
    }

    /// Mirror a one-leaf block whose only transaction is `leaf`, at `at`. The mock verifier accepts
    /// it, which stands in for the real precompile having certified a block that really contained
    /// this transaction.
    function _mirrorSingleLeaf(bytes memory leaf, uint64 at) internal {
        bytes32 root = MirrorLib.hashLeaf(leaf);
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = root;
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(ETH, at, leaf, root, none, bytes32(0), roots);
    }

    function _claim(uint64 spanId_) internal returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = spanId_;
        vm.prank(claimant);
        return registry.assertAbsence{value: 1 ether}(
            ids, AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(uint256(uint160(LIQUIDATED_BORROWER))), 3, 1 hours
        );
    }

    function _reveal(uint256 claimId, uint64 at, bytes memory leaf) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        bytes32 commitment = registry.commitmentFor(claimId, at, leaf, none, "salt", refuter);
        vm.prank(refuter);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        registry.revealRefutation(claimId, at, leaf, none, "salt");
    }

    /// Sanity: the rewrite touched only the status byte. Same logs, same gas, same bloom.
    function test_rewriteChangesOnlyTheStatus() public view {
        EvmV1Decoder.ReceiptFields memory a = EvmV1Decoder.decodeReceiptFields(realTx);
        EvmV1Decoder.ReceiptFields memory b = EvmV1Decoder.decodeReceiptFields(failedTx);
        assertEq(a.receiptStatus, 1);
        assertEq(b.receiptStatus, 0);
        assertEq(a.receiptGasUsed, b.receiptGasUsed);
        assertEq(a.receiptLogs.length, b.receiptLogs.length);
        assertEq(keccak256(a.receiptLogsBloom), keccak256(b.receiptLogsBloom));
        assertTrue(a.receiptLogs.length > 0, "fixture should carry logs");
    }

    /// Control: the successful transaction, mirrored the same way, refutes the claim.
    function test_theSuccessfulTransactionRefutes() public {
        _mirrorSingleLeaf(realTx, height);
        uint64 spanId_ = uint64(mirror.sealSpan(ETH, height, height));
        uint256 claimId = _claim(spanId_);

        _reveal(claimId, height, realTx);
        (IAbsence.Status s,,,,) = registry.assurance(claimId);
        assertEq(uint256(s), uint256(IAbsence.Status.Refuted));
    }

    /// The point: identical in every way except that it reverted, and it is refused.
    function test_theRevertedTransactionCannotRefute() public {
        _mirrorSingleLeaf(failedTx, height);
        uint64 spanId_ = uint64(mirror.sealSpan(ETH, height, height));
        uint256 claimId = _claim(spanId_);

        // The path verifies -- the transaction really is in the mirrored block.
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.verifyOrRevert(ETH, height, failedTx, none);

        // And the registry still refuses it, because inclusion is not success.
        bytes32 commitment = registry.commitmentFor(claimId, height, failedTx, none, "salt", refuter);
        vm.prank(refuter);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistryV2.TransactionFailed.selector);
        registry.revealRefutation(claimId, height, failedTx, none, "salt");

        (IAbsence.Status s, uint256 bond,,,) = registry.assurance(claimId);
        assertEq(uint256(s), uint256(IAbsence.Status.Open), "claim should survive a reverted tx");
        assertEq(bond, 1 ether, "bond should be untouched");
    }

    /// Any non-1 status is a failure, not only 0.
    function testFuzz_anyNonSuccessStatusIsRefused(uint8 status) public {
        vm.assume(status != 1);
        bytes memory leaf = _withStatus(realTx, status);
        _mirrorSingleLeaf(leaf, height);
        uint64 spanId_ = uint64(mirror.sealSpan(ETH, height, height));
        uint256 claimId = _claim(spanId_);

        INativeQueryVerifier.MerkleProofEntry[] memory none;
        bytes32 commitment = registry.commitmentFor(claimId, height, leaf, none, "salt", refuter);
        vm.prank(refuter);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistryV2.TransactionFailed.selector);
        registry.revealRefutation(claimId, height, leaf, none, "salt");
    }
}
