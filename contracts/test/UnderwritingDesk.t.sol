// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {IMirror} from "../src/IMirror.sol";
import {IMirrorSpans} from "../src/IMirrorSpans.sol";
import {SubjectBinding} from "../src/SubjectBinding.sol";
import {ISubjectBinding} from "../src/ISubjectBinding.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {IAbsenceV3} from "../src/IAbsenceV3.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {ThrowawayDesk} from "./ThrowawayDesk.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// The `0x0FD4` precompile, as it answered on CC3 when measured: four attestors, 100 CTC each.
contract MockStash {
    uint32 public count = 4;
    uint128 public bond = 100 ether;

    function getAttestorsCount(uint64) external view returns (uint32) {
        return count;
    }

    function getMinBondRequirement(uint64) external view returns (uint128) {
        return bond;
    }

    function set(uint32 c, uint128 b) external {
        count = c;
        bond = b;
    }
}

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
    MockStash internal stash;
    AbsenceRegistryV3 internal registry;
    SubjectBinding internal binding;
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

    /// The fixture archive is 27 heights; a 26-block window is all of it, so the liquidation at
    /// its floor is inside the window the desk looks back over.
    uint64 constant WINDOW = 26;
    uint256 constant PRINCIPAL = 1 ether;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new MockVerifier()).code);
        // `etch` copies runtime code, never storage, so the etched copy has to be told what the real
        // precompile answered: four attestors, 100 CTC each, measured on CC3 on 2026-09-13.
        vm.etch(address(uint160(0x0FD4)), address(new MockStash()).code);
        stash = MockStash(address(uint160(0x0FD4)));
        stash.set(4, 100 ether);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV3(mirror);
        binding = new SubjectBinding(IMirror(address(mirror)));
        desk = new UnderwritingDesk(IMirrorSpans(address(mirror)), registry, ISubjectBinding(address(binding)));

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
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        bondedClean = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether,
                requiresBinding: false
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

    /// The window a caller offers the desk as proof. One seal covers this fixture's whole archive.
    function _w() internal view returns (uint256[] memory ids) {
        return _spans();
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
    /// it answers the question. It does not hand over money: silence is not collateral.
    function test_blankFileAnswersButNeverLends() public {
        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, blankFile, 0, _w());
        assertTrue(ok, "an unmarked address is not refused");
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.None));

        (bool okMoney, UnderwritingDesk.Refusal whyMoney) = desk.assess(cleanBorrower, blankFile, PRINCIPAL, _w());
        assertFalse(okMoney);
        assertEq(uint256(whyMoney), uint256(UnderwritingDesk.Refusal.NeedsBondedCover));

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.NeedsBondedCover)
        );
        desk.borrow(blankFile, PRINCIPAL, _w());
    }

    /// The loan the desk does make: against a standing claim, at no more than ten times what a liar
    /// could not have recovered.
    function test_bondedCleanBorrowerIsPaid() public {
        uint256 claimId = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL, _w());
        assertEq(cleanBorrower.balance, before + PRINCIPAL, "a bonded clean file is lent to");
        assertEq(desk.totalOutstanding(), PRINCIPAL);
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
        desk.borrow(bondedClean, PRINCIPAL, _w());
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
        desk.borrow(bondedClean, PRINCIPAL, _w());
    }

    /// A standing claim is good news, and must not turn the permissive policy into a refusal.
    function test_standingClaimDoesNotBlockBlankFile() public {
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        (bool ok,) = desk.assess(cleanBorrower, blankFile, 0, _w());
        assertTrue(ok);
    }

    /// BondedClean will not lend on silence, which is the whole difference between the policies.
    function test_bondedCleanRefusesSilence() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.NoBondedCleanliness)
        );
        desk.borrow(bondedClean, PRINCIPAL, _w());
    }

    function test_bondedCleanAcceptsASufficientBond() public {
        // Half the bond burns on refutation, so 2 ether staked is 1 ether the liar cannot recover,
        // which is exactly the principal being borrowed.
        uint256 claimId = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(claimId);

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL, _w());
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
        desk.borrow(bondedClean, PRINCIPAL, _w());
    }

    /// An answer drawn from history the archive does not hold is not an answer.
    function test_archiveTooShallowIsRefused() public {
        uint256 deep = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 50_000, // far more history than this mirror holds
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ArchiveTooShallow)
        );
        desk.borrow(deep, PRINCIPAL, _w());
    }

    /// The mandate's named test: a 90-day policy on a shallow archive refuses. On the live desk
    /// this fails until the campaign has actually notarised 648,000 blocks -- which is the point.
    function test_deskRefusesArchiveTooShallowFor90Days() public {
        uint256 ninety = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 648_000,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, ninety, PRINCIPAL, _w());
        assertFalse(ok);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));
    }

    // ---------------------------------------------------------------------------------------
    // Depth means every height, not two endpoints
    // ---------------------------------------------------------------------------------------

    uint64 constant FAR = 30_000_000;

    function _heldRoots(uint256 len, uint256 seed) internal pure returns (bytes32[] memory r) {
        r = new bytes32[](len);
        // A root is a function of its height, so overlapping windows agree the way real ones do.
        for (uint256 i; i < len; ++i) r[i] = keccak256(abi.encode("root", seed + i));
    }

    function _mirrorRange(uint64 from, uint256 len) internal {
        bytes32[] memory roots = _heldRoots(len, from);
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(ETH_MAINNET, from, hex"00", roots[0], none, bytes32(0), roots);
    }

    function _policy(uint64 window) internal returns (uint256) {
        return desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: window,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
    }

    /// The same policy, but the kind that actually parts with money. Every "and then it lends" test
    /// needs one of these now: `BlankFile` answers and stops.
    function _bonded(uint64 window) internal returns (uint256) {
        return desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: window,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
    }

    /// A finalised EmptySet over the whole fixture archive: the bond a `BondedClean` loan sizes against.
    function _standing(address who) internal returns (uint256 claimId) {
        claimId = _claimClean(who, 2 ether, 15 minutes);
        _finalised(claimId);
    }

    /// A hole cannot be sealed across, so it cannot be offered as a window. This is the same fact the
    /// old desk paid 7M gas to rediscover on every call: `sealSpan` walks the bitmap once, reverts on
    /// the first missing height, and what it records is what the desk reads.
    function test_aHoleCannotBeSealedAndSoCannotBeOffered() public {
        _mirrorRange(FAR, 101); // FAR .. FAR+100
        _mirrorRange(FAR + 150, 151); // FAR+150 .. FAR+300, hole at FAR+101 .. FAR+149

        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.GapInSpan.selector, ETH_MAINNET, FAR + 101));
        mirror.sealSpan(ETH_MAINNET, FAR, FAR + 300);

        // The most that can be sealed below the hole is too short for a 250-block window.
        uint256[] memory shortSpan = new uint256[](1);
        shortSpan[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 100);
        uint256 p = _policy(250);
        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, p, 0, shortSpan);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "a short span is not a window");

        // Fill the hole, seal across it, and the same policy answers.
        _mirrorRange(FAR + 100, 51);
        uint256[] memory whole = new uint256[](1);
        whole[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 300);
        (bool ok,) = desk.assess(cleanBorrower, p, 0, whole);
        assertTrue(ok, "a sealed window answers");
    }

    /// Spans must be adjacent, on the policy's chain, and belong to the caller's claim of coverage.
    /// None of these is a privilege check: they are the arithmetic of "this range is held".
    function test_offeredSpansMustActuallyProveTheWindow() public {
        _mirrorRange(FAR, 600);
        _mirrorRange(FAR + 700, 300); // gap at FAR+600..FAR+699
        uint256 lower = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 599);
        uint256 upper = mirror.sealSpan(ETH_MAINNET, FAR + 700, FAR + 999);
        uint256 p = _policy(800);

        uint256[] memory notAdjacent = new uint256[](2);
        notAdjacent[0] = lower;
        notAdjacent[1] = upper;
        (, UnderwritingDesk.Refusal gap) = desk.assess(cleanBorrower, p, 0, notAdjacent);
        assertEq(uint256(gap), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "two spans with a gap between them");

        uint256[] memory none = new uint256[](0);
        (, UnderwritingDesk.Refusal empty) = desk.assess(cleanBorrower, p, 0, none);
        assertEq(uint256(empty), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "no span is no proof");

        // A span on another chain proves nothing about this one.
        bytes32[] memory roots = new bytes32[](900);
        for (uint256 i; i < roots.length; ++i) roots[i] = keccak256(abi.encode("sepolia", i));
        INativeQueryVerifier.MerkleProofEntry[] memory noSiblings;
        mirror.mirror(1, 11_000_000, hex"00", roots[0], noSiblings, bytes32(0), roots);
        uint256[] memory wrongChain = new uint256[](1);
        wrongChain[0] = mirror.sealSpan(1, 11_000_000, 11_000_899);
        (, UnderwritingDesk.Refusal chain) = desk.assess(cleanBorrower, p, 0, wrongChain);
        assertEq(uint256(chain), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "another chain is another file");
    }

    /// Two adjacent seals are one window. Ninety days is five of them.
    function test_adjacentSpansCompose() public {
        _mirrorRange(FAR, 1_000);
        uint256[] memory two = new uint256[](2);
        two[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 499);
        two[1] = mirror.sealSpan(ETH_MAINNET, FAR + 500, FAR + 999);
        (bool ok,) = desk.assess(cleanBorrower, _policy(999), 0, two);
        assertTrue(ok, "adjacent seals compose into one window");
    }

    /// Anyone can mirror an isolated window above the archive. A window that no longer reaches the head
    /// stops being underwritten on, and starts again when the gap is filled and re-sealed.
    function test_aWindowThatNoLongerReachesTheHeadIsRefused() public {
        _mirrorRange(FAR, 1_000);
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 999);
        uint256 p = _policy(500);
        (bool ok,) = desk.assess(cleanBorrower, p, 0, span);
        assertTrue(ok);

        _mirrorRange(FAR + 1_400, 50); // a stranger's window, 400 heights above the top
        (, UnderwritingDesk.Refusal stale) = desk.assess(cleanBorrower, p, 0, span);
        assertEq(uint256(stale), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "stale window must refuse");

        _mirrorRange(FAR + 999, 402);
        uint256[] memory fresh = new uint256[](1);
        fresh[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 1_449);
        (bool okAgain,) = desk.assess(cleanBorrower, p, 0, fresh);
        assertTrue(okAgain, "re-sealed to the head, it answers again");
    }

    /// A policy may tolerate a window that ends below the head, and says by how much.
    function test_maxStalenessIsThePolicysOwnTolerance() public {
        _mirrorRange(FAR, 1_000);
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + 999);
        _mirrorRange(FAR + 999, 101); // head is now 100 above the sealed window

        uint256 strict = _policy(500); // maxStaleness 0
        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, strict, 0, span);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));

        uint256 tolerant = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 500,
                maxStaleness: 100,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        (bool ok,) = desk.assess(cleanBorrower, tolerant, 0, span);
        assertTrue(ok, "within the policy's own staleness tolerance");
    }

    /// The window is inclusive at both ends: `window + 1` heights. Exactly enough answers; one fewer
    /// does not, whatever the caller offers.
    function testFuzz_depthBoundaryIsExact(uint16 lenSeed, uint16 windowSeed) public {
        uint64 len = uint64(bound(lenSeed, 2, 2_000));
        _mirrorRange(FAR, len); // FAR .. FAR+len-1
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH_MAINNET, FAR, FAR + len - 1);
        uint64 window = uint64(bound(windowSeed, 1, 2_500));
        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, _policy(window), 0, span);
        if (window <= len - 1) assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.None));
        else assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));
    }

    /// The budget that made this rewrite necessary. Ninety days used to cost 7.03M gas per `borrow`
    /// because the desk walked 2,532 bitmap words itself. Reading five seals is a handful of slots,
    /// and this test fails the build if that ever stops being true.
    function test_gas_ninetyDayDepthCheckUnder80k() public {
        // Seed 648,192 held heights, then seal them as five spans, exactly as the live archive is.
        uint64 w0 = FAR >> 8;
        bytes32 outer = keccak256(abi.encode(ETH_MAINNET, uint256(1)));
        for (uint256 i; i < 2_535; ++i) {
            vm.store(address(mirror), keccak256(abi.encode(w0 + uint64(i), outer)), bytes32(type(uint256).max));
        }
        uint64 base = w0 << 8;
        uint64 top = base + 648_100;
        vm.store(address(mirror), keccak256(abi.encode(ETH_MAINNET, uint256(3))), bytes32(uint256(top)));
        vm.store(address(mirror), keccak256(abi.encode(ETH_MAINNET, uint256(4))), bytes32(uint256(base)));

        uint256[] memory spans = new uint256[](5);
        uint64 each = 129_621; // five adjacent seals covering 648,101 heights
        for (uint256 i; i < 5; ++i) {
            uint64 lo = base + uint64(i) * each;
            uint64 hi = i == 4 ? top : lo + each - 1;
            spans[i] = mirror.sealSpan(ETH_MAINNET, lo, hi);
        }

        uint256 ninety = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: 648_000,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );

        // Cold, as a first caller sees it: the seals above warmed the slots this reads.
        vm.cool(address(mirror));
        vm.cool(address(registry));
        uint256 g = gasleft();
        (bool ok,) = desk.assess(cleanBorrower, ninety, 0, spans);
        uint256 used = g - gasleft();
        assertTrue(ok, "ninety days, sealed, answers");
        emit log_named_uint("ninety-day depth check, cold", used);
        assertLt(used, 80_000, "the depth check must stay cheap enough to sit inside borrow");
    }

    // ---------------------------------------------------------------------------------------
    // True statements about the wrong thing
    // ---------------------------------------------------------------------------------------

    function _finalised(uint256 claimId) internal {
        vm.warp(uint256(registry.claimOf(claimId).openUntil) + 1);
        registry.finalize(claimId);
    }

    /// Topic 1 of LiquidationCall is the collateral asset. "No liquidation whose collateral asset is
    /// this borrower" is true of every borrower, stands forever, and says nothing about them. The
    /// v3.0 desk matched on subject alone and would have lent against it.
    function test_claimReadThroughAnotherTopicIsNotCleanliness() public {
        vm.prank(claimant);
        uint256 id = registry.assertAbsence{value: 10 ether}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, _subject(LIQUIDATED_BORROWER), 1, 15 minutes
        );
        _finalised(id);
        assertTrue(registry.isUsable(id, PRINCIPAL), "the claim itself is usable -- for what it says");

        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(LIQUIDATED_BORROWER, bondedClean, PRINCIPAL, _w());
        assertFalse(ok);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness));
    }

    /// A claim over another chain's spans is a different file, however the addresses line up.
    function test_claimOnAnotherChainIsIgnored() public {
        uint64 sepolia = 1;
        bytes32[] memory roots = new bytes32[](40);
        for (uint256 i; i < roots.length; ++i) roots[i] = keccak256(abi.encode("sepolia", i));
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(sepolia, 11_000_000, hex"00", roots[0], none, bytes32(0), roots);
        uint256[] memory ids = new uint256[](1);
        ids[0] = mirror.sealSpan(sepolia, 11_000_000, 11_000_039);

        vm.prank(claimant);
        uint256 id = registry.assertAbsence{value: 10 ether}(
            ids, AAVE_V3_POOL, LIQUIDATION_CALL, _subject(cleanBorrower), 3, 15 minutes
        );
        _finalised(id);

        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL, _w());
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness));
    }

    /// A refuted claim that constrained no subject proves that *someone* was liquidated. It must
    /// not brand whichever address its author wrote in the subject field.
    function test_subjectlessRefutationBrandsNobody() public {
        vm.prank(claimant);
        uint256 id = registry.assertAbsence{value: 1 ether}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, _subject(cleanBorrower), 0, 1 hours
        );
        assertEq(registry.claimOf(id).subject, bytes32(0), "a subjectless claim stores no subject");
        _refute(refuter, id);
        assertEq(uint256(registry.claimOf(id).status), uint256(IAbsence.Status.Refuted));

        (bool ok,) = desk.assess(cleanBorrower, blankFile, 0, _w());
        assertTrue(ok, "nobody was proven anything about cleanBorrower");
    }

    function _liquidationLogIndex() internal view returns (uint32) {
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(txBytes);
        for (uint32 i; i < r.receiptLogs.length; ++i) {
            if (r.receiptLogs[i].address_ == AAVE_V3_POOL && r.receiptLogs[i].topics[0] == LIQUIDATION_CALL) return i;
        }
        revert("fixture has no LiquidationCall");
    }

    function _listLiquidation(uint256 bond) internal returns (uint256 id) {
        AbsenceRegistryV3.MemberProof[] memory ps = new AbsenceRegistryV3.MemberProof[](1);
        ps[0] = AbsenceRegistryV3.MemberProof({
            height: blockHeight, logIndex: _liquidationLogIndex(), encodedTransaction: txBytes, siblings: siblings
        });
        vm.prank(claimant);
        id = registry.assertComplete{value: bond}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, _subject(LIQUIDATED_BORROWER), 3, 15 minutes, ps
        );
    }

    /// A standing CompleteSet that lists the borrower's real liquidation is the opposite of a clean
    /// record. It is an inclusion fact, verified at assertion, and both policies refuse on it.
    function test_listedLiquidationIsEventOnRecordNotCleanliness() public {
        uint256 id = _listLiquidation(10 ether);
        _finalised(id);
        assertTrue(registry.isUsable(id, PRINCIPAL), "a standing CompleteSet is usable for what it says");

        (, UnderwritingDesk.Refusal a) = desk.assess(LIQUIDATED_BORROWER, blankFile, PRINCIPAL, _w());
        (, UnderwritingDesk.Refusal b) = desk.assess(LIQUIDATED_BORROWER, bondedClean, PRINCIPAL, _w());
        assertEq(uint256(a), uint256(UnderwritingDesk.Refusal.EventOnRecord));
        assertEq(uint256(b), uint256(UnderwritingDesk.Refusal.EventOnRecord));
    }

    /// Five hundred and thirteen junk claims switched the v3.0 desk off for everyone. Now they
    /// are someone else's file.
    function test_junkClaimsCannotSwitchOffTheDesk() public {
        for (uint256 j; j < 9; ++j) {
            address spammer = address(uint160(0x5BA0 + j));
            vm.deal(spammer, 1 ether);
            for (uint256 i; i < 64; ++i) {
                vm.prank(spammer);
                registry.assertAbsence{value: 0.01 ether}(
                    _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(uint256(j * 1000 + i + 1)), 3, 15 minutes
                );
            }
        }
        assertGt(registry.claimCount(), 512);

        _standing(cleanBorrower);
        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL, _w());
        assertEq(cleanBorrower.balance, before + PRINCIPAL);
    }

    /// Burying a subject's bonded claim under newer junk about the same subject can only cost
    /// that subject a loan -- never buy one for anybody.
    function test_buryingABondedClaimFailsClosed() public {
        uint256 good = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.deal(address(0xD00D), 10 ether);
        for (uint256 i; i < 64; ++i) {
            vm.prank(address(0xD00D));
            registry.assertAbsence{value: 0.01 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, _subject(cleanBorrower), 3, 15 minutes);
        }
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(good);
        for (uint256 i = 1; i <= 64; ++i) registry.finalize(good + i);

        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL, _w());
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness));

        // Re-filing on top makes the good claim newest again.
        uint256 again = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(again);
        (bool ok,) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL, _w());
        assertTrue(ok);
    }

    /// A refutation older than the policy's window is history the policy does not look back over.
    function test_refutationBelowTheWindowFloorDoesNotCount() public {
        uint256 id = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, id);
        (, UnderwritingDesk.Refusal inWindow) = desk.assess(LIQUIDATED_BORROWER, blankFile, 0, _w());
        assertEq(uint256(inWindow), uint256(UnderwritingDesk.Refusal.ProvenLiar));

        // The liquidation sits at the archive floor; a 25-block window starts one height above it.
        (, UnderwritingDesk.Refusal shallow) = desk.assess(LIQUIDATED_BORROWER, _policy(25), 0, _w());
        assertEq(uint256(shallow), uint256(UnderwritingDesk.Refusal.None));
    }

    /// A clean claim over one day does not make a ninety-day policy's case.
    function test_bondedCleanNeedsAClaimCoveringTheWholeWindow() public {
        uint256 id = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        _finalised(id);
        uint256 wider = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: 25, // archive is 27 heights; the claim covers 26 = spanTo - spanFrom
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        (bool ok,) = desk.assess(cleanBorrower, wider, PRINCIPAL, _w());
        assertTrue(ok, "a claim covering more than the window counts");

        // Extend the archive upward: the same claim now ends ten blocks below the head. A claim
        // covering 26 heights cannot serve a window that has slid further than 26 above it -- the
        // window floor would rise past the claim entirely -- so ten is the interesting distance.
        bytes32[] memory more = new bytes32[](11);
        uint64 top = blockHeight + 26;
        more[0] = mirror.rootOf(ETH_MAINNET, top);
        for (uint256 i = 1; i < more.length; ++i) more[i] = keccak256(abi.encode("above", i));
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(ETH_MAINNET, top, hex"00", more[0], none, bytes32(0), more);
        // Re-seal to the new head: the window is fresh again, and the *claim* is the only stale thing.
        uint256[] memory grown = new uint256[](1);
        grown[0] = mirror.sealSpan(ETH_MAINNET, blockHeight, top + 10);

        (, UnderwritingDesk.Refusal stale) = desk.assess(cleanBorrower, wider, PRINCIPAL, grown);
        assertEq(uint256(stale), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness), "stale claim must not count");

        uint256 tolerant = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: 25,
                maxStaleness: 10,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        (bool fresh,) = desk.assess(cleanBorrower, tolerant, PRINCIPAL, grown);
        assertTrue(fresh, "within the policy's staleness tolerance");

        uint256 ninetyish = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: 30,
                maxStaleness: 10,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
        (, UnderwritingDesk.Refusal narrow) = desk.assess(cleanBorrower, ninetyish, PRINCIPAL, grown);
        assertEq(uint256(narrow), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness), "26 blocks do not cover 30");
    }

    function test_oneLoanPerAddressPerPolicy() public {
        _standing(cleanBorrower);
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL, _w());
        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL, _w());
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.AlreadyLent));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.AlreadyLent));
        desk.borrow(bondedClean, PRINCIPAL, _w());
    }

    function test_policyThatReadsNoSubjectIsRejected() public {
        vm.expectRevert(UnderwritingDesk.BadPolicy.selector);
        desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 0,
                minBond: 0,
                maxPrincipal: 10 ether,
                requiresBinding: false
            })
        );
    }

    /// A principal inside the policy's cap but beyond what the desk actually holds. The cap is
    /// checked first by design, so this needs a policy generous enough to reach the funds check.
    function test_deskOutOfFundsIsRefused() public {
        uint256 generous = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH_MAINNET,
                window: WINDOW,
                maxStaleness: 0,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 100 ether,
                requiresBinding: false
            })
        );

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.DeskOutOfFunds)
        );
        desk.borrow(generous, 60 ether, _w()); // the desk holds 50
    }

    function test_unknownPolicyIsRefused() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(UnderwritingDesk.NoSuchPolicy.selector);
        desk.borrow(999, PRINCIPAL, _w());
    }

    function test_principalAboveThePolicyCapIsRefused() public {
        vm.prank(cleanBorrower);
        vm.expectRevert(UnderwritingDesk.PrincipalTooLarge.selector);
        desk.borrow(blankFile, 11 ether, _w());
    }

    // ---------------------------------------------------------------------------------------
    // Soundness of the public view
    // ---------------------------------------------------------------------------------------

    /// `assess` is the predicate `borrow` gates on. If they could disagree, the view a judge runs
    /// would not be the code holding the money.
    function test_assessAgreesWithBorrowForEveryState() public {
        // Each state on its own policy, because a loan already taken is itself a state.
        uint256 second = _bonded(WINDOW);
        uint256 third = _bonded(WINDOW);

        // 1. nothing said, under the permissive policy: it answers, and it does not lend.
        (bool ok1, UnderwritingDesk.Refusal why1) = desk.assess(cleanBorrower, blankFile, PRINCIPAL, _w());
        assertFalse(ok1);
        assertEq(uint256(why1), uint256(UnderwritingDesk.Refusal.NeedsBondedCover));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why1));
        desk.borrow(blankFile, PRINCIPAL, _w());

        // 2. under hunt
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 1 hours);
        (bool ok2, UnderwritingDesk.Refusal why2) = desk.assess(cleanBorrower, second, PRINCIPAL, _w());
        assertFalse(ok2);
        assertEq(uint256(why2), uint256(UnderwritingDesk.Refusal.ClaimUnderHunt));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why2));
        desk.borrow(second, PRINCIPAL, _w());

        // 3. standing: the one state in which money moves
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(claimId);
        (bool ok3,) = desk.assess(cleanBorrower, second, PRINCIPAL, _w());
        assertTrue(ok3, "assess said no while borrow says yes");
        vm.prank(cleanBorrower);
        desk.borrow(second, PRINCIPAL, _w());

        // 4. already lent
        (bool ok4, UnderwritingDesk.Refusal why4) = desk.assess(cleanBorrower, second, PRINCIPAL, _w());
        assertFalse(ok4);
        assertEq(uint256(why4), uint256(UnderwritingDesk.Refusal.AlreadyLent));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why4));
        desk.borrow(second, PRINCIPAL, _w());

        // 5. proven liar, on a policy never borrowed from
        uint256 lie = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, lie);
        (bool ok5, UnderwritingDesk.Refusal why5) = desk.assess(LIQUIDATED_BORROWER, third, PRINCIPAL, _w());
        assertFalse(ok5);
        assertEq(uint256(why5), uint256(UnderwritingDesk.Refusal.ProvenLiar));
        vm.prank(LIQUIDATED_BORROWER);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why5));
        desk.borrow(third, PRINCIPAL, _w());

        // 6. window no longer proven: the offered span stops describing the head
        _mirrorRange(FAR, 2);
        uint256[] memory stale = _w();
        (bool ok6, UnderwritingDesk.Refusal why6) = desk.assess(cleanBorrower, third, PRINCIPAL, stale);
        assertFalse(ok6);
        assertEq(uint256(why6), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why6));
        desk.borrow(third, PRINCIPAL, stale);
    }

    /// The refusal cannot be washed by pointing at somebody else's address: there is no parameter
    /// for it. A liar assessing a clean stranger still cannot borrow.
    function test_aBorrowerCannotBorrowAgainstAnotherAddressesRecord() public {
        uint256 claimId = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, claimId);
        _standing(cleanBorrower);

        // The liar can see that a clean address would be paid...
        (bool otherOk,) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL, _w());
        assertTrue(otherOk, "the clean address should itself be fine");

        // ...and it does them no good, because borrow underwrites msg.sender.
        vm.prank(LIQUIDATED_BORROWER);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ProvenLiar)
        );
        desk.borrow(bondedClean, PRINCIPAL, _w());
    }

    /// A claim about a different venue or a different event says nothing about this policy.
    function test_aClaimAboutAnotherVenueIsIgnored() public {
        vm.prank(claimant);
        registry.assertAbsence{value: 1 ether}(
            _spans(), address(0xDEAD), LIQUIDATION_CALL, _subject(cleanBorrower), 3, 1 hours
        );
        _standing(cleanBorrower);

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(bondedClean, PRINCIPAL, _w());
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
