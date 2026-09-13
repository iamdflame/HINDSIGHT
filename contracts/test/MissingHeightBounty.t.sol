// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {MissingHeightBounty} from "../src/MissingHeightBounty.sol";
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

contract Rejects {
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

/// @notice A filler that cannot receive ether, to exercise the payout failure path.
contract Deaf {
    MissingHeightBounty internal bounty;

    constructor(MissingHeightBounty b) {
        bounty = b;
    }

    function fill(
        uint64 chainKey,
        uint64 height,
        uint64 blockHeight,
        bytes calldata txBytes,
        bytes32 root,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lower,
        bytes32[] calldata roots
    ) external {
        bounty.fill(chainKey, height, blockHeight, txBytes, root, siblings, lower, roots);
    }
    // no receive(): the transfer must fail
}

/// @title The bounty pays the filler, and only the filler
/// @notice The design choice under test is that the bounty *performs* the fill rather than paying on
///         a later `collect`. The mirror records roots but not who supplied them, so any two-step
///         design pays whoever calls second -- reliably a front-runner. These tests pin that the
///         work and the payment are one transaction, and that the escrow cannot be lost or stolen.
contract MissingHeightBountyTest is Test {
    EthereumMirror internal mirror;
    MissingHeightBounty internal bounty;

    uint64 constant ETH = 3;

    uint64 internal blockHeight;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    address internal poster = address(0x9057);
    address internal filler = address(0xF111);
    address internal stranger = address(0x5712);

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();
        bounty = new MissingHeightBounty(mirror);

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

        vm.deal(poster, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    function _fill(address who, uint64 height) internal {
        vm.prank(who);
        bounty.fill(ETH, height, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
    }

    // ---------------------------------------------------------------------------------------
    // The headline
    // ---------------------------------------------------------------------------------------

    /// Post on a missing height; the filler notarises it through the bounty and is paid in the
    /// same transaction. There is no window in which the work is done but unpaid.
    function test_fillerIsPaidInTheSameTransaction() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
        assertFalse(mirror.isMirrored(ETH, blockHeight + 5));

        uint256 before = filler.balance;
        _fill(filler, blockHeight + 5);

        assertTrue(mirror.isMirrored(ETH, blockHeight + 5), "height was not filled");
        assertEq(filler.balance, before + 1 ether, "filler was not paid");
        (uint256 amount,) = bounty.bountyFor(ETH, blockHeight + 5);
        assertEq(amount, 0, "escrow not cleared");
    }

    /// One continuity proof covers many heights, so filling one bounty routinely fills neighbours
    /// for free. That is the behaviour that makes the archive cheap to complete.
    function test_oneFillClosesNeighbouringGapsForFree() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 3);
        _fill(filler, blockHeight + 3);

        for (uint256 i; i < continuityRoots.length; ++i) {
            assertTrue(mirror.isMirrored(ETH, blockHeight + uint64(i)), "neighbour left unfilled");
        }
    }

    // ---------------------------------------------------------------------------------------
    // Nothing can be stolen
    // ---------------------------------------------------------------------------------------

    /// A rejected proof retains nothing and pays nothing. The bounty adds no authority of its own.
    function test_rejectedProofPaysNothing() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
        vm.etch(address(uint160(0x0FD2)), address(new Rejects()).code);

        uint256 before = filler.balance;
        vm.prank(filler);
        vm.expectRevert(EthereumMirror.ProofRejected.selector);
        bounty.fill(ETH, blockHeight + 5, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);

        assertEq(filler.balance, before, "paid for a rejected proof");
        (uint256 amount,) = bounty.bountyFor(ETH, blockHeight + 5);
        assertEq(amount, 1 ether, "escrow was consumed by a rejected proof");
    }

    /// A valid proof whose range never reaches the bountied height fills nothing bountied, and is
    /// paid nothing. Pay for the hole that was actually filled, not for effort.
    function test_proofThatMissesTheHeightIsNotPaid() public {
        uint64 farAway = blockHeight + uint64(continuityRoots.length) + 1_000;
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, farAway);

        vm.prank(filler);
        vm.expectRevert(MissingHeightBounty.StillMissing.selector);
        bounty.fill(ETH, farAway, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);

        (uint256 amount,) = bounty.bountyFor(ETH, farAway);
        assertEq(amount, 1 ether, "escrow lost on a miss");
    }

    /// Filling a height with nothing posted is just `mirror()` with extra steps, and is refused so
    /// nobody mistakes it for a payout.
    function test_fillWithNothingPostedIsRefused() public {
        vm.prank(filler);
        vm.expectRevert(MissingHeightBounty.NothingPosted.selector);
        bounty.fill(ETH, blockHeight + 5, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
    }

    /// A bounty cannot be collected twice.
    function test_cannotFillTwice() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
        _fill(filler, blockHeight + 5);

        vm.prank(stranger);
        vm.expectRevert(MissingHeightBounty.NothingPosted.selector);
        bounty.fill(ETH, blockHeight + 5, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
    }

    /// If the filler cannot receive the payout, the whole fill reverts rather than retaining the
    /// roots and stranding the reward.
    function test_unpayableFillerRevertsTheWholeFill() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);

        Deaf deaf = new Deaf(bounty);
        vm.expectRevert(MissingHeightBounty.TransferFailed.selector);
        deaf.fill(ETH, blockHeight + 5, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);

        assertFalse(mirror.isMirrored(ETH, blockHeight + 5), "roots retained despite the revert");
        (uint256 amount,) = bounty.bountyFor(ETH, blockHeight + 5);
        assertEq(amount, 1 ether, "escrow consumed despite the revert");
    }

    // ---------------------------------------------------------------------------------------
    // Nothing can be lost
    // ---------------------------------------------------------------------------------------

    /// Posting on a height that is already held would be an immediate donation to the first
    /// caller, so it is refused.
    function test_cannotPostOnAHeldHeight() public {
        _fillMirrorDirectly();
        vm.prank(poster);
        vm.expectRevert(MissingHeightBounty.AlreadyHeld.selector);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
    }

    function test_cannotPostZero() public {
        vm.prank(poster);
        vm.expectRevert(MissingHeightBounty.ZeroAmount.selector);
        bounty.post{value: 0}(ETH, blockHeight + 5);
    }

    /// The poster can take an unfilled bounty back.
    function test_posterCanWithdrawWhileStillMissing() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);

        uint256 before = poster.balance;
        vm.prank(poster);
        bounty.withdraw(ETH, blockHeight + 5);
        assertEq(poster.balance, before + 1 ether);

        (uint256 amount,) = bounty.bountyFor(ETH, blockHeight + 5);
        assertEq(amount, 0);
    }

    /// ...but not once the height is held, because at that point it belongs to the filler.
    function test_cannotWithdrawOnceHeld() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
        _fillMirrorDirectly();

        vm.prank(poster);
        vm.expectRevert(MissingHeightBounty.AlreadyHeld.selector);
        bounty.withdraw(ETH, blockHeight + 5);
    }

    /// ...and never by somebody else.
    function test_strangerCannotWithdraw() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);

        vm.prank(stranger);
        vm.expectRevert(MissingHeightBounty.NotThePoster.selector);
        bounty.withdraw(ETH, blockHeight + 5);
    }

    function test_withdrawWithNothingPostedIsRefused() public {
        vm.prank(poster);
        vm.expectRevert(MissingHeightBounty.NothingPosted.selector);
        bounty.withdraw(ETH, blockHeight + 5);
    }

    /// Topping up keeps the original poster's refund right: adding to a stranger's bounty is a
    /// donation, and is documented as one rather than silently reassigning ownership.
    function test_topUpKeepsTheOriginalPoster() public {
        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, blockHeight + 5);
        vm.prank(stranger);
        bounty.post{value: 2 ether}(ETH, blockHeight + 5);

        (uint256 amount, address who) = bounty.bountyFor(ETH, blockHeight + 5);
        assertEq(amount, 3 ether);
        assertEq(who, poster, "top-up reassigned the poster");

        // And the filler gets the whole pot.
        uint256 before = filler.balance;
        _fill(filler, blockHeight + 5);
        assertEq(filler.balance, before + 3 ether);
    }

    /// Bounties are per chain and per height; one never satisfies another.
    function testFuzz_bountiesAreIsolatedByHeight(uint64 a, uint64 b) public {
        vm.assume(a != b);
        vm.assume(a > blockHeight + uint64(continuityRoots.length) && b > blockHeight + uint64(continuityRoots.length));
        vm.assume(a < type(uint64).max - 1 && b < type(uint64).max - 1);

        vm.prank(poster);
        bounty.post{value: 1 ether}(ETH, a);
        (uint256 onA,) = bounty.bountyFor(ETH, a);
        (uint256 onB,) = bounty.bountyFor(ETH, b);
        assertEq(onA, 1 ether);
        assertEq(onB, 0);
    }

    function _fillMirrorDirectly() internal {
        mirror.mirror(ETH, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
    }
}
