// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistry} from "../src/AbsenceRegistry.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract MockVerifier {
    bool public rejecting;

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

/// @notice End-to-end over a real Ethereum mainnet liquidation: a false statement of absence is
///         made about a real borrower and destroyed by their real on-chain liquidation.
contract AbsenceRegistryTest is Test {
    EthereumMirror internal mirror;
    AbsenceRegistry internal registry;

    uint64 constant ETH_MAINNET = 3;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    // The borrower liquidated in the fixture transaction (LiquidationCall topics[3] == user).
    address constant LIQUIDATED_BORROWER = 0xa63f5B1AcE5Ef4BcE91d3f12f31B8F2eA110B980;

    address internal claimant = address(0xA11CE);
    address internal refuter = address(0xB0B);

    uint64 internal blockHeight;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    uint256 internal spanId;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new MockVerifier()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistry(mirror);

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

        mirror.mirror(ETH_MAINNET, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
        spanId = mirror.sealSpan(ETH_MAINNET, blockHeight, blockHeight + uint64(continuityRoots.length) - 1);

        vm.deal(claimant, 10 ether);
        vm.deal(refuter, 1 ether);
    }

    /// Commit, advance a block, then reveal. Every refutation in this suite goes through the
    /// real two-phase path, because the one-shot path was removed as front-runnable.
    function _refute(address who, uint256 claimId, uint64 bn, bytes memory txb, bytes32 salt) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = siblings;
        bytes32 commitment = registry.commitmentFor(claimId, bn, txb, sib, salt, who);
        vm.prank(who);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(who);
        registry.revealRefutation(claimId, bn, txb, sib, salt);
    }

    function _subject(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _assertCleanRecord(address borrower) internal returns (uint256 claimId) {
        vm.prank(claimant);
        claimId = registry.assertAbsence{value: 1 ether}(
            spanId, AAVE_V3_POOL, LIQUIDATION_CALL, _subject(borrower), 3, 1 hours
        );
    }

    /// The headline: a lie about a real borrower is destroyed by their real liquidation, and the
    /// bond moves to whoever bothered to look.
    function test_falseClaimOfCleanRecordIsRefutedByRealLiquidation() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        assertFalse(registry.holds(claimId), "should not hold while open");

        uint256 before = refuter.balance;
        _refute(refuter, claimId, blockHeight, txBytes, "salt");

        assertEq(uint256(registry.claimOf(claimId).status), uint256(AbsenceRegistry.Status.Refuted));
        assertEq(refuter.balance, before + 1 ether, "refuter should take the bond");
        assertFalse(registry.holds(claimId), "refuted claim must never hold");
    }

    /// Cost of destroying a false statement about Ethereum history.
    function test_gas_refutation() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        bytes32 commitment = registry.commitmentFor(claimId, blockHeight, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        uint256 g0 = gasleft();
        registry.revealRefutation(claimId, blockHeight, txBytes, siblings, "s");
        console.log("gas to reveal a refutation:", g0 - gasleft());
    }

    /// A truthful statement survives: this borrower was not liquidated in this span.
    function test_trueClaimStandsAfterWindow() public {
        uint256 claimId = _assertCleanRecord(address(0xDEADBEEF));

        bytes32 cm = registry.commitmentFor(claimId, blockHeight, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.NoContradictionFound.selector);
        registry.revealRefutation(claimId, blockHeight, txBytes, siblings, "s");

        vm.warp(block.timestamp + 2 hours);
        uint256 before = claimant.balance;
        registry.finalize(claimId);

        assertTrue(registry.holds(claimId), "unrefuted claim should stand");
        assertEq(claimant.balance, before + 1 ether, "bond returned");
    }

    /// A real liquidation of a *different* borrower does not refute this claim.
    function test_wrongSubjectDoesNotRefute() public {
        uint256 claimId = _assertCleanRecord(address(0xCAFE));
        bytes32 cm = registry.commitmentFor(claimId, blockHeight, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.NoContradictionFound.selector);
        registry.revealRefutation(claimId, blockHeight, txBytes, siblings, "s");
    }

    /// A lookalike contract emitting the same signature is not evidence about the real venue.
    function test_lookalikeVenueDoesNotRefute() public {
        vm.prank(claimant);
        uint256 claimId = registry.assertAbsence{value: 1 ether}(
            spanId, address(0xBADC0DE), LIQUIDATION_CALL, _subject(LIQUIDATED_BORROWER), 3, 1 hours
        );
        bytes32 cm = registry.commitmentFor(claimId, blockHeight, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.NoContradictionFound.selector);
        registry.revealRefutation(claimId, blockHeight, txBytes, siblings, "s");
    }

    /// Evidence from outside the sealed span is inadmissible.
    function test_blockOutsideSpanIsRejected() public {
        uint256 farBlock = blockHeight + uint64(continuityRoots.length) + 500;
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        bytes32 cm = registry.commitmentFor(claimId, uint64(farBlock), txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.BlockOutsideSpan.selector);
        registry.revealRefutation(claimId, uint64(farBlock), txBytes, siblings, "s");
    }

    /// A tampered transaction cannot be used to steal a bond.
    function test_forgedEvidenceCannotStealBond() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        bytes memory forged = txBytes;
        forged[forged.length - 1] = bytes1(uint8(forged[forged.length - 1]) ^ 0x01);
        bytes32 cm = registry.commitmentFor(claimId, blockHeight, forged, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH_MAINNET, blockHeight));
        registry.revealRefutation(claimId, blockHeight, forged, siblings, "s");
    }

    /// Refutation after the window has closed is refused.
    function test_lateRefutationRejected() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        vm.warp(block.timestamp + 2 hours);
        bytes32 cm = registry.commitmentFor(claimId, blockHeight, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.WindowClosed.selector);
        registry.revealRefutation(claimId, blockHeight, txBytes, siblings, "s");
    }

    /// A refuted claim cannot then be finalized into a standing statement.
    function test_refutedClaimCannotBeFinalized() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        _refute(refuter, claimId, blockHeight, txBytes, "salt");
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(AbsenceRegistry.ClaimNotOpen.selector);
        registry.finalize(claimId);
    }

    /// A claim is judged against the span as it stood when it was made. `extendSpan` is
    /// permissionless, so reading span bounds live would let anyone widen a claim after the fact
    /// and drag a counterexample into scope, stealing the bond of an honest claimant.
    function test_extendingSpanCannotWidenAnExistingClaim() public {
        // A claim about a subject with no liquidation inside the sealed span.
        uint256 claimId = _assertCleanRecord(address(0xFEED));
        AbsenceRegistry.Claim memory before_ = registry.claimOf(claimId);
        uint64 originalTo = before_.spanTo;

        // An attacker notarises the blocks immediately above the span...
        uint64 nextFrom = originalTo + 1;
        bytes32[] memory moreRoots = new bytes32[](4);
        for (uint256 i; i < moreRoots.length; ++i) moreRoots[i] = keccak256(abi.encode("root", i));
        mirror.mirror(ETH_MAINNET, nextFrom, txBytes, moreRoots[0], siblings, bytes32(uint256(1)), moreRoots);

        // ...and widens the span to swallow them.
        mirror.extendSpan(spanId, nextFrom + uint64(moreRoots.length) - 1);
        EthereumMirror.Span memory grown = mirror.spanOf(spanId);
        assertGt(grown.toBlock, originalTo, "span really did grow");

        // The claim must not have grown with it.
        AbsenceRegistry.Claim memory after_ = registry.claimOf(claimId);
        assertEq(after_.spanFrom, before_.spanFrom, "lower bound moved");
        assertEq(after_.spanTo, originalTo, "claim scope widened after the fact");

        (,,, uint64 aFrom, uint64 aTo) = registry.assurance(claimId);
        assertEq(aTo, originalTo, "assurance() reported the widened range");
        assertEq(aFrom, before_.spanFrom);
    }

    /// Evidence from a block above the snapshotted upper bound is inadmissible.
    function test_evidenceAboveSnapshotUpperBoundRejected() public {
        uint256 claimId = _assertCleanRecord(LIQUIDATED_BORROWER);
        AbsenceRegistry.Claim memory c = registry.claimOf(claimId);
        uint64 above = c.spanTo + 1;
        bytes32 cm = registry.commitmentFor(claimId, above, txBytes, siblings, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(cm);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistry.BlockOutsideSpan.selector);
        registry.revealRefutation(claimId, above, txBytes, siblings, "s");
    }

    /// A span may not be sealed across a gap, since a gap is where a counterexample could hide.
    function test_spanWithGapCannotBeSealed() public {
        uint64 last = blockHeight + uint64(continuityRoots.length) - 1;
        vm.expectRevert();
        mirror.sealSpan(ETH_MAINNET, blockHeight, last + 1);
    }
}
