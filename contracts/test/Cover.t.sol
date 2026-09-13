// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {Cover} from "../src/Cover.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract CoverMockVerifier {
    function verifyAndEmit(uint64, uint64, bytes calldata, INativeQueryVerifier.MerkleProof calldata, INativeQueryVerifier.ContinuityProof calldata) external pure returns (bool) {
        return true;
    }
}

/// @title Cover settles the way the claim settles
/// @notice The oracle is the hunt. A claim about the fixture's real Aave borrower is refuted with the
///         real liquidation, and the buyer collects; the same claim about a clean address stands, and
///         the underwriter keeps both premium and payout. Nothing in between is a judgement call.
contract CoverTest is Test {
    EthereumMirror mirror;
    AbsenceRegistryV3 registry;
    Cover cover;

    uint64 constant ETH = 3;
    address constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    address constant LIQUIDATED = 0xa63f5B1AcE5Ef4BcE91d3f12f31B8F2eA110B980;
    address constant CLEAN = address(0xC1EA1);

    address claimant = address(0xA11CE);
    address underwriter = address(0x0DD5);
    address buyer = address(0xB0B);
    address hunter = address(0x4A47);

    uint64 height;
    bytes txBytes;
    INativeQueryVerifier.MerkleProofEntry[] siblings;
    uint256[] spans;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new CoverMockVerifier()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV3(mirror);
        cover = new Cover(registry);

        string memory json = vm.readFile("test/fixtures/liquidation.json");
        height = uint64(vm.parseJsonUint(json, ".headerNumber"));
        txBytes = vm.parseJsonBytes(json, ".txBytes");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        bytes32 lower = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        bytes32[] memory roots = vm.parseJsonBytes32Array(json, ".continuityRoots");
        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        for (uint256 i; i < sh.length; ++i) siblings.push(INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]}));
        mirror.mirror(ETH, height, txBytes, root, siblings, lower, roots);
        spans.push(mirror.sealSpan(ETH, height, height + uint64(roots.length) - 1));

        vm.deal(claimant, 100 ether);
        vm.deal(underwriter, 100 ether);
        vm.deal(buyer, 100 ether);
        vm.deal(hunter, 1 ether);
    }

    function _claim(address about) internal returns (uint256 id) {
        vm.prank(claimant);
        id = registry.assertAbsence{value: 2 ether}(spans, AAVE, LIQUIDATION_CALL, bytes32(uint256(uint160(about))), 3, 1 hours);
    }

    function _refute(uint256 id) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = siblings;
        bytes32 commitment = registry.commitmentFor(id, height, txBytes, sib, "salt", hunter);
        vm.prank(hunter);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(hunter);
        registry.revealRefutation(id, height, txBytes, sib, "salt");
    }

    function test_refutedClaimPaysTheBuyer() public {
        uint256 id = _claim(LIQUIDATED);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 5 ether}(id, 0.25 ether);
        vm.prank(buyer);
        cover.buy{value: 0.25 ether}(o);
        assertEq(cover.owed(underwriter), 0.25 ether, "the premium is the underwriter's the moment it is paid");

        _refute(id);
        cover.settle(o);
        assertEq(cover.owed(buyer), 5 ether, "the claim was false; the buyer collects");
        assertEq(cover.owed(underwriter), 0.25 ether, "the underwriter keeps only the premium");

        uint256 before = buyer.balance;
        vm.prank(buyer);
        cover.withdraw();
        assertEq(buyer.balance, before + 5 ether);
    }

    function test_standingClaimReturnsThePayoutToTheUnderwriter() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 5 ether}(id, 0.25 ether);
        vm.prank(buyer);
        cover.buy{value: 0.25 ether}(o);

        vm.warp(block.timestamp + 2 hours);
        registry.finalize(id);
        cover.settle(o);
        assertEq(cover.owed(underwriter), 5.25 ether, "premium and payout: the claim stood");
        assertEq(cover.owed(buyer), 0);
    }

    /// The oracle has not spoken. Nothing moves, and nobody -- not even this contract -- guesses.
    function test_cannotSettleWhileTheHuntIsStillRunning() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 1 ether}(id, 0.1 ether);
        vm.prank(buyer);
        cover.buy{value: 0.1 ether}(o);
        vm.expectRevert(Cover.ClaimNotSettled.selector);
        cover.settle(o);
        // Past the window but not finalised: still not settled. The registry's finalize is anyone's to call.
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(Cover.ClaimNotSettled.selector);
        cover.settle(o);
        registry.finalize(id);
        cover.settle(o);
        assertEq(cover.owed(underwriter), 1.1 ether);
    }

    /// Cover on a claim that cannot change is not cover. The registry will not take a refutation
    /// against a standing claim, so there is no event left to insure.
    function test_noCoverOnAClaimThatHasAlreadySettled() public {
        uint256 id = _claim(CLEAN);
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(id);
        vm.prank(underwriter);
        vm.expectRevert(Cover.ClaimNotOpen.selector);
        cover.offer{value: 1 ether}(id, 0.1 ether);

        uint256 lie = _claim(LIQUIDATED);
        _refute(lie);
        vm.prank(underwriter);
        vm.expectRevert(Cover.ClaimNotOpen.selector);
        cover.offer{value: 1 ether}(lie, 0.1 ether);
    }

    function test_noCoverBoughtAfterTheWindowCloses() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 1 ether}(id, 0.1 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(buyer);
        vm.expectRevert(Cover.ClaimWindowClosed.selector);
        cover.buy{value: 0.1 ether}(o);
    }

    function test_premiumMustBeExact() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 1 ether}(id, 0.1 ether);
        vm.prank(buyer);
        vm.expectRevert(Cover.WrongPremium.selector);
        cover.buy{value: 0.09 ether}(o);
    }

    function test_anUnboughtOfferCanBeWithdrawnOnlyByItsUnderwriter() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 1 ether}(id, 0.1 ether);
        vm.prank(buyer);
        vm.expectRevert(Cover.NotUnderwriter.selector);
        cover.withdrawOffer(o);
        vm.prank(underwriter);
        cover.withdrawOffer(o);
        assertEq(cover.owed(underwriter), 1 ether);
        vm.prank(buyer);
        vm.expectRevert(Cover.WrongState.selector);
        cover.buy{value: 0.1 ether}(o);
    }

    function test_aBoughtOfferCannotBeWithdrawnOrBoughtAgain() public {
        uint256 id = _claim(CLEAN);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 1 ether}(id, 0.1 ether);
        vm.prank(buyer);
        cover.buy{value: 0.1 ether}(o);
        vm.prank(underwriter);
        vm.expectRevert(Cover.WrongState.selector);
        cover.withdrawOffer(o);
        vm.prank(address(0xE15E));
        vm.deal(address(0xE15E), 1 ether);
        vm.expectRevert(Cover.WrongState.selector);
        cover.buy{value: 0.1 ether}(o);
    }

    /// Nothing calls out with value except `withdraw`, to the caller, for what is owed. Settling twice
    /// cannot pay twice, and settling assigns exactly the payout that was locked.
    function test_settleIsFinalAndConservesValue() public {
        uint256 id = _claim(LIQUIDATED);
        vm.prank(underwriter);
        uint256 o = cover.offer{value: 3 ether}(id, 0.5 ether);
        vm.prank(buyer);
        cover.buy{value: 0.5 ether}(o);
        _refute(id);
        cover.settle(o);
        vm.expectRevert(Cover.WrongState.selector);
        cover.settle(o);
        assertEq(cover.owed(buyer) + cover.owed(underwriter), 3.5 ether, "everything in is owed to somebody");
        assertEq(address(cover).balance, 3.5 ether);
    }

    function test_nothingOwedIsARevertNotAZeroTransfer() public {
        vm.prank(buyer);
        vm.expectRevert(Cover.NothingOwed.selector);
        cover.withdraw();
    }
}
