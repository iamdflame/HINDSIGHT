// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {IMirror} from "../src/IMirror.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {ThrowawayDesk} from "./ThrowawayDesk.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract MockVerifier {
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

/// @title The desk refuses
/// @notice The product here is the refusal, so these tests are mostly about money *not* moving.
///         The headline pair is `test_unmarkedAddressBorrows` and `test_provenLiarIsRefused`: the
///         same desk, the same policy, one address paid and one turned away, with the difference
///         being a real Aave liquidation on Ethereum mainnet that nobody involved controls.
contract UnderwritingDeskTest is Test {
    EthereumMirror internal mirror;
    AbsenceRegistryV3 internal registry;
    UnderwritingDesk internal desk;

    uint64 constant ETH_MAINNET = 3;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;
    address constant LIQUIDATED_BORROWER = 0xa63f5B1AcE5Ef4BcE91d3f12f31B8F2eA110B980;

    address internal claimant = address(0xA11CE);
    address internal refuter = address(0xB0B);
    address internal cleanBorrower = address(0xC1EA1);

    uint64 internal blockHeight;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    uint256 internal spanId;
    uint256 internal blankFile;
    uint256 internal bondedClean;

    uint64 constant WINDOW = 20;
    uint256 constant PRINCIPAL = 1 ether;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new MockVerifier()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV3(mirror);
        desk = new UnderwritingDesk(IMirror(address(mirror)), registry);

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

        blankFile = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether
            })
        );
        bondedClean = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether
            })
        );

        vm.deal(claimant, 100 ether);
        vm.deal(refuter, 1 ether);
        vm.deal(address(this), 100 ether);
        desk.fund{value: 50 ether}();
    }

    function _subject(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _spans() internal view returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = spanId;
    }

    function _claimClean(address who, uint256 bond, uint64 window) internal returns (uint256 claimId) {
        vm.prank(claimant);
        claimId = registry.assertAbsence{value: bond}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, _subject(who), 3, window
        );
    }

    function _refute(address who, uint256 claimId) internal {
        INativeQueryVerifier.MerkleProofEntry[] memory sib = siblings;
        bytes32 commitment = registry.commitmentFor(claimId, blockHeight, txBytes, sib, "salt", who);
        vm.prank(who);
        registry.commitRefutation(commitment);
        vm.roll(block.number + 1);
        vm.prank(who);
        registry.revealRefutation(claimId, blockHeight, txBytes, sib, "salt");
    }

    // ---------------------------------------------------------------------------------------
    // The headline pair
    // ---------------------------------------------------------------------------------------

    /// Nothing is said about this address, and BlankFile does not pretend silence is innocence --
    /// it simply has no reason to refuse.
    function test_unmarkedAddressBorrows() public {
        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
        assertEq(cleanBorrower.balance, before + PRINCIPAL, "a blank file should borrow");
    }

    /// The same desk, the same policy, after a real liquidation is revealed against the address.
    function test_provenLiarIsRefused() public {
        uint256 claimId = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, claimId);
        assertEq(uint256(registry.claimOf(claimId).status), uint256(IAbsence.Status.Refuted));

        vm.deal(LIQUIDATED_BORROWER, 0);
        vm.prank(LIQUIDATED_BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ProvenLiar)
        );
        desk.borrow(blankFile, PRINCIPAL);
        assertEq(LIQUIDATED_BORROWER.balance, 0, "a proven liar must not be paid");
    }

    // ---------------------------------------------------------------------------------------
    // Fail-closed paths
    // ---------------------------------------------------------------------------------------

    /// An open claim means somebody is hunting. Do not lend into a fight.
    function test_openClaimBlocksLending() public {
        _claimClean(cleanBorrower, 1 ether, 1 hours);

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ClaimUnderHunt)
        );
        desk.borrow(blankFile, PRINCIPAL);
    }

    /// A standing claim is good news, and must not block the permissive policy.
    function test_standingClaimDoesNotBlockBlankFile() public {
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
        assertEq(cleanBorrower.balance, before + PRINCIPAL);
    }

    /// BondedClean will not lend on silence, which is the whole difference between the policies.
    function test_bondedCleanRefusesSilence() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.NoBondedCleanliness)
        );
        desk.borrow(bondedClean, PRINCIPAL);
    }

    function test_bondedCleanAcceptsASufficientBond() public {
        // Half the bond burns on refutation, so 2 ether staked is 1 ether the liar cannot recover,
        // which is exactly the principal being borrowed.
        uint256 claimId = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL);
        assertEq(cleanBorrower.balance, before + PRINCIPAL);
    }

    /// A claim backed by dust is not worth relying on, however confidently it is phrased. And a
    /// bond that only *nominally* covers the principal is not enough either: half of it would
    /// come back to the liar, so 1 ether staked covers 0.5 ether of exposure, not 1.
    function test_bondedCleanRejectsAnInsufficientBond() public {
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.NoBondedCleanliness)
        );
        desk.borrow(bondedClean, PRINCIPAL);
    }

    /// An answer drawn from history the archive does not hold is not an answer.
    function test_archiveTooShallowIsRefused() public {
        uint256 deep = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 50_000, // far more history than this mirror holds
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether
            })
        );

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ArchiveTooShallow)
        );
        desk.borrow(deep, PRINCIPAL);
    }

    /// A principal inside the policy's cap but beyond what the desk actually holds. The cap is
    /// checked first by design, so this needs a policy generous enough to reach the funds check.
    /// The mandate's named test: a 90-day policy on a shallow archive refuses. On the live desk
    /// this fails until the campaign has actually notarised 648,000 blocks -- which is the point.
    function test_deskRefusesArchiveTooShallowFor90Days() public {
        uint256 ninety = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 648_000,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether
            })
        );
        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, ninety, PRINCIPAL);
        assertFalse(ok);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));
    }

    function test_deskOutOfFundsIsRefused() public {
        uint256 generous = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 100 ether
            })
        );

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.DeskOutOfFunds)
        );
        desk.borrow(generous, 60 ether); // the desk holds 50
    }

    function test_unknownPolicyIsRefused() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(UnderwritingDesk.NoSuchPolicy.selector);
        desk.borrow(999, PRINCIPAL);
    }

    function test_principalAboveThePolicyCapIsRefused() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(UnderwritingDesk.PrincipalTooLarge.selector);
        desk.borrow(blankFile, 11 ether);
    }

    // ---------------------------------------------------------------------------------------
    // Soundness of the public view
    // ---------------------------------------------------------------------------------------

    /// `assess` is the predicate `borrow` gates on. If they could disagree, the view a judge runs
    /// would not be the code holding the money.
    function test_assessAgreesWithBorrowForEveryState() public {
        // 1. nothing said
        (bool ok,) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertTrue(ok, "assess said no while borrow says yes");
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);

        // 2. under hunt
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 1 hours);
        (bool ok2, UnderwritingDesk.Refusal why2) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertFalse(ok2);
        assertEq(uint256(why2), uint256(UnderwritingDesk.Refusal.ClaimUnderHunt));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why2));
        desk.borrow(blankFile, PRINCIPAL);

        // 3. standing
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(claimId);
        (bool ok3,) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertTrue(ok3);
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
    }

    /// The refusal cannot be washed by pointing at somebody else's address: there is no parameter
    /// for it. A liar assessing a clean stranger still cannot borrow.
    function test_aBorrowerCannotBorrowAgainstAnotherAddressesRecord() public {
        uint256 claimId = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, claimId);

        // The liar can see that a clean address would be fine...
        (bool otherOk,) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertTrue(otherOk, "the clean address should itself be fine");

        // ...and it does them no good, because borrow underwrites msg.sender.
        vm.prank(LIQUIDATED_BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ProvenLiar)
        );
        desk.borrow(blankFile, PRINCIPAL);
    }

    /// A claim about a different venue or a different event says nothing about this policy.
    function test_aClaimAboutAnotherVenueIsIgnored() public {
        vm.prank(claimant);
        registry.assertAbsence{value: 1 ether}(
            _spans(), address(0xDEAD), LIQUIDATION_CALL, _subject(cleanBorrower), 3, 1 hours
        );

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
        assertEq(cleanBorrower.balance, before + PRINCIPAL, "an unrelated venue should not block");
    }

    // ---------------------------------------------------------------------------------------
    // The file is not the UI
    // ---------------------------------------------------------------------------------------

    /// A consumer written against nothing but the frozen interfaces reaches the same facts.
    function test_aStrangerCanReadTheFileThroughInterfacesAlone() public {
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        ThrowawayDesk stranger = new ThrowawayDesk(IMirror(address(mirror)), IAbsence(address(registry)));

        assertTrue(stranger.wouldLend(ETH_MAINNET, blockHeight, claimId, 1 ether), "interfaces did not carry the fact");

        (IAbsence.Status status, uint256 bond,,,) = stranger.terms(claimId);
        assertEq(uint256(status), uint256(IAbsence.Status.Standing));
        assertEq(bond, 1 ether);
    }
}
