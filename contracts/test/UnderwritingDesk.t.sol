// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {IMirror} from "../src/IMirror.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {IAbsenceV3} from "../src/IAbsenceV3.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
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

    /// The fixture archive is 27 heights; a 26-block window is all of it, so the liquidation at
    /// its floor is inside the window the desk looks back over.
    uint64 constant WINDOW = 26;
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
                maxStaleness: 0,
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
                maxStaleness: 0,
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
                maxStaleness: 0,
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
                maxPrincipal: 10 ether
            })
        );
        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, ninety, PRINCIPAL);
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
                maxPrincipal: 10 ether
            })
        );
    }

    function _why(uint256 policyId) internal view returns (UnderwritingDesk.Refusal why) {
        (, why) = desk.assess(cleanBorrower, policyId, PRINCIPAL);
    }

    /// Endpoints ninety blocks apart, a hole in the middle. The v3.0 desk compared `head - window`
    /// with `lowestMirrored` and would have lent here; a liquidation in the hole is unprovable.
    function test_holeInsideTheWindowIsTooShallow() public {
        _mirrorRange(FAR, 101); // FAR .. FAR+100
        _mirrorRange(FAR + 150, 151); // FAR+150 .. FAR+300, hole at FAR+101 .. FAR+149
        assertEq(mirror.highestMirrored(ETH_MAINNET), FAR + 300);

        uint256 p = _policy(250); // head - window = FAR+50, above every endpoint check
        assertEq(uint256(_why(p)), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow), "hole must refuse");

        vm.prank(cleanBorrower);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.ArchiveTooShallow)
        );
        desk.borrow(p, PRINCIPAL);

        _mirrorRange(FAR + 100, 51); // fill FAR+100 .. FAR+150
        assertEq(uint256(_why(p)), uint256(UnderwritingDesk.Refusal.None), "filled window must answer");
    }

    /// One empty-looking hole of a single height at the very bottom of the window is enough.
    function test_singleMissingHeightAtTheWindowFloorRefuses() public {
        _mirrorRange(FAR, 100); // FAR .. FAR+99
        _mirrorRange(FAR + 101, 200); // FAR+101 .. FAR+300; FAR+100 missing
        assertEq(uint256(_why(_policy(200))), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow)); // floor = FAR+100
        assertEq(uint256(_why(_policy(199))), uint256(UnderwritingDesk.Refusal.None)); // floor = FAR+101
    }

    /// Anyone can mirror an isolated window above the archive. The desk must refuse, not lend
    /// across the gap -- and must answer again the moment the gap is filled.
    function test_isolatedWindowAboveTheArchiveFailsClosed() public {
        _mirrorRange(FAR, 1_000);
        uint256 p = _policy(500);
        assertEq(uint256(_why(p)), uint256(UnderwritingDesk.Refusal.None));

        _mirrorRange(FAR + 1_400, 50); // a stranger's window, 400 heights above the top
        assertEq(uint256(_why(p)), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));

        _mirrorRange(FAR + 999, 402);
        assertEq(uint256(_why(p)), uint256(UnderwritingDesk.Refusal.None));
    }

    /// The window is inclusive at both ends: `window + 1` heights. Exactly enough answers; one
    /// fewer does not.
    function testFuzz_depthBoundaryIsExact(uint16 lenSeed, uint16 windowSeed) public {
        uint64 len = uint64(bound(lenSeed, 2, 2_000));
        _mirrorRange(FAR, len); // FAR .. FAR+len-1, so head - low = len - 1
        uint64 window = uint64(bound(windowSeed, 1, 2_500));
        UnderwritingDesk.Refusal why = _why(_policy(window));
        if (window <= len - 1) assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.None));
        else assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.ArchiveTooShallow));
    }

    /// Gas: the 90-day policy walks ~2,532 bitmap words. Measured, and bounded, so a borrower is
    /// never priced out by the depth check itself.
    function test_gas_ninetyDayBorrowReadsTheBitmapWordWise() public {
        uint64 w0 = FAR >> 8;
        bytes32 outer = keccak256(abi.encode(ETH_MAINNET, uint256(1)));
        for (uint256 i; i < 2_535; ++i) {
            vm.store(address(mirror), keccak256(abi.encode(w0 + uint64(i), outer)), bytes32(type(uint256).max));
        }
        uint64 top = (w0 << 8) + 648_100;
        vm.store(address(mirror), keccak256(abi.encode(ETH_MAINNET, uint256(3))), bytes32(uint256(top)));
        vm.store(address(mirror), keccak256(abi.encode(ETH_MAINNET, uint256(4))), bytes32(uint256(w0 << 8)));

        uint256 ninety = _policy(648_000);
        assertEq(uint256(_why(ninety)), uint256(UnderwritingDesk.Refusal.None));

        // Cold storage, as a real borrow sees it: the assess above warmed every word it read.
        vm.cool(address(mirror));
        vm.prank(cleanBorrower);
        uint256 g = gasleft();
        desk.borrow(ninety, PRINCIPAL);
        uint256 used = g - gasleft();
        emit log_named_uint("borrow gas, 90-day policy", used);
        assertLt(used, 8_000_000);
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

        (bool ok, UnderwritingDesk.Refusal why) = desk.assess(LIQUIDATED_BORROWER, bondedClean, PRINCIPAL);
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

        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL);
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

        (bool ok,) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
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

        (, UnderwritingDesk.Refusal a) = desk.assess(LIQUIDATED_BORROWER, blankFile, PRINCIPAL);
        (, UnderwritingDesk.Refusal b) = desk.assess(LIQUIDATED_BORROWER, bondedClean, PRINCIPAL);
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

        uint256 before = cleanBorrower.balance;
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
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

        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness));

        // Re-filing on top makes the good claim newest again.
        uint256 again = _claimClean(cleanBorrower, 2 ether, 15 minutes);
        vm.warp(block.timestamp + 16 minutes);
        registry.finalize(again);
        (bool ok,) = desk.assess(cleanBorrower, bondedClean, PRINCIPAL);
        assertTrue(ok);
    }

    /// A refutation older than the policy's window is history the policy does not look back over.
    function test_refutationBelowTheWindowFloorDoesNotCount() public {
        uint256 id = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, id);
        (, UnderwritingDesk.Refusal inWindow) = desk.assess(LIQUIDATED_BORROWER, blankFile, PRINCIPAL);
        assertEq(uint256(inWindow), uint256(UnderwritingDesk.Refusal.ProvenLiar));

        // The liquidation sits at the archive floor; a 25-block window starts one height above it.
        (, UnderwritingDesk.Refusal shallow) = desk.assess(LIQUIDATED_BORROWER, _policy(25), PRINCIPAL);
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
                maxPrincipal: 10 ether
            })
        );
        (bool ok,) = desk.assess(cleanBorrower, wider, PRINCIPAL);
        assertTrue(ok, "a claim covering more than the window counts");

        // Extend the archive upward: the same claim now ends 40 blocks below the head.
        bytes32[] memory more = new bytes32[](41);
        uint64 top = blockHeight + 26;
        more[0] = mirror.rootOf(ETH_MAINNET, top);
        for (uint256 i = 1; i < more.length; ++i) more[i] = keccak256(abi.encode("above", i));
        INativeQueryVerifier.MerkleProofEntry[] memory none;
        mirror.mirror(ETH_MAINNET, top, hex"00", more[0], none, bytes32(0), more);

        (, UnderwritingDesk.Refusal stale) = desk.assess(cleanBorrower, wider, PRINCIPAL);
        assertEq(uint256(stale), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness), "stale claim must not count");

        uint256 tolerant = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: 25,
                maxStaleness: 40,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether
            })
        );
        (bool fresh,) = desk.assess(cleanBorrower, tolerant, PRINCIPAL);
        assertTrue(fresh, "within the policy's staleness tolerance");

        uint256 ninetyish = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH_MAINNET,
                window: 60,
                maxStaleness: 40,
                venue: AAVE_V3_POOL,
                topic0: LIQUIDATION_CALL,
                subjectTopic: 3,
                minBond: 1 ether,
                maxPrincipal: 10 ether
            })
        );
        (, UnderwritingDesk.Refusal narrow) = desk.assess(cleanBorrower, ninetyish, PRINCIPAL);
        assertEq(uint256(narrow), uint256(UnderwritingDesk.Refusal.NoBondedCleanliness), "26 blocks do not cover 60");
    }

    function test_oneLoanPerAddressPerPolicy() public {
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);
        (, UnderwritingDesk.Refusal why) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.AlreadyLent));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.AlreadyLent));
        desk.borrow(blankFile, PRINCIPAL);
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
                maxPrincipal: 10 ether
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
        // Each state on its own policy, because a loan already taken is itself a state.
        uint256 second = _policy(WINDOW);
        uint256 third = _policy(WINDOW);

        // 1. nothing said
        (bool ok,) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertTrue(ok, "assess said no while borrow says yes");
        vm.prank(cleanBorrower);
        desk.borrow(blankFile, PRINCIPAL);

        // 2. already lent
        (bool okLent, UnderwritingDesk.Refusal whyLent) = desk.assess(cleanBorrower, blankFile, PRINCIPAL);
        assertFalse(okLent);
        assertEq(uint256(whyLent), uint256(UnderwritingDesk.Refusal.AlreadyLent));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, whyLent));
        desk.borrow(blankFile, PRINCIPAL);

        // 3. under hunt
        uint256 claimId = _claimClean(cleanBorrower, 1 ether, 1 hours);
        (bool ok2, UnderwritingDesk.Refusal why2) = desk.assess(cleanBorrower, second, PRINCIPAL);
        assertFalse(ok2);
        assertEq(uint256(why2), uint256(UnderwritingDesk.Refusal.ClaimUnderHunt));
        vm.prank(cleanBorrower);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why2));
        desk.borrow(second, PRINCIPAL);

        // 4. standing
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(claimId);
        (bool ok3,) = desk.assess(cleanBorrower, second, PRINCIPAL);
        assertTrue(ok3);
        vm.prank(cleanBorrower);
        desk.borrow(second, PRINCIPAL);

        // 5. proven liar, on a policy never borrowed from
        uint256 lie = _claimClean(LIQUIDATED_BORROWER, 1 ether, 1 hours);
        _refute(refuter, lie);
        (bool ok4, UnderwritingDesk.Refusal why4) = desk.assess(LIQUIDATED_BORROWER, third, PRINCIPAL);
        assertFalse(ok4);
        assertEq(uint256(why4), uint256(UnderwritingDesk.Refusal.ProvenLiar));
        vm.prank(LIQUIDATED_BORROWER);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, why4));
        desk.borrow(third, PRINCIPAL);
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
