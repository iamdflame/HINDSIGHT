// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {IAbsence} from "../src/IAbsence.sol";
import {IAbsenceV3} from "../src/IAbsenceV3.sol";
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

/// A claimant that refuses to be paid, and can be told to change its mind.
contract StubbornClaimant {
    bool public accept;
    bool public burnGas;

    function setAccept(bool a) external {
        accept = a;
    }

    function setBurnGas(bool b) external {
        burnGas = b;
    }

    function assertAbsence(AbsenceRegistryV3 r, uint256[] calldata spans, address venue, bytes32 topic0, uint64 window)
        external
        payable
        returns (uint256)
    {
        return r.assertAbsence{value: msg.value}(spans, venue, topic0, bytes32(0), 0, window);
    }

    function withdraw(AbsenceRegistryV3 r) external {
        r.withdraw();
    }

    receive() external payable {
        if (burnGas) {
            while (true) {}
        }
        require(accept, "no thanks");
    }
}

/// @title Completeness, and the burn
/// @notice Six real Aave V3 liquidations on Ethereum mainnet, all inside a 64-block window, all
///         with their real Merkle paths. A `CompleteSet` claim that lists all six should stand. One
///         that lists five is refuted by the sixth, and the liar gets half their bond back from
///         nobody, because half of it no longer exists.
///
/// @dev Every member is verified against the mirror at assertion. The mock precompile is only
///      consulted for the *notarisation* of these blocks; from then on nothing here touches it.
contract AbsenceRegistryV3Test is Test {
    EthereumMirror internal mirror;
    AbsenceRegistryV3 internal registry;

    uint64 constant ETH = 3;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant LIQUIDATION_CALL = 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286;

    address internal claimant = address(0xA11CE);
    address internal refuter = address(0xB0B);
    address internal claimantsAlt = address(0xA11CE2);

    struct Fixture {
        uint64 height;
        uint64 txIndex;
        uint32 logIndex;
        bytes txBytes;
        bytes32 root;
        INativeQueryVerifier.MerkleProofEntry[] siblings;
    }

    Fixture[] internal fx; // sorted by (height, txIndex)
    uint64 internal from;
    uint64 internal to;
    uint256 internal spanId;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new Accepts()).code);
        mirror = new EthereumMirror();
        registry = new AbsenceRegistryV3(mirror);

        // Load every liquidation fixture that sits in the first cluster (heights < 25,955,000).
        VmSafe.DirEntry[] memory files = vm.readDir("test/fixtures/mainnet/aave-liquidations");
        for (uint256 i; i < files.length; ++i) {
            string memory json = vm.readFile(files[i].path);
            uint64 h = uint64(vm.parseJsonUint(json, ".headerNumber"));
            if (h >= 25_955_000) continue;
            _pushFixture(json, h);
        }
        assertTrue(fx.length >= 5, "need at least five clustered liquidations");
        _sortFixtures();

        from = fx[0].height;
        to = fx[fx.length - 1].height;

        // Mirror the whole window: real roots where a fixture exists, filler elsewhere.
        for (uint64 h = from; h <= to; ++h) {
            bytes32 root = keccak256(abi.encodePacked("filler", h));
            for (uint256 i; i < fx.length; ++i) {
                if (fx[i].height == h) root = fx[i].root;
            }
            bytes32[] memory one = new bytes32[](1);
            one[0] = root;
            INativeQueryVerifier.MerkleProofEntry[] memory none;
            mirror.mirror(ETH, h, hex"00", root, none, bytes32(0), one);
        }
        spanId = mirror.sealSpan(ETH, from, to);

        vm.deal(claimant, 100 ether);
        vm.deal(claimantsAlt, 100 ether);
        vm.deal(refuter, 1 ether);
    }

    function _pushFixture(string memory json, uint64 h) internal {
        fx.push();
        Fixture storage f = fx[fx.length - 1];
        f.height = h;
        f.txIndex = uint64(vm.parseJsonUint(json, ".txIndex"));
        f.txBytes = vm.parseJsonBytes(json, ".txBytes");
        f.root = vm.parseJsonBytes32(json, ".root");
        bytes32[] memory sh = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory sl = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        for (uint256 i; i < sh.length; ++i) {
            f.siblings.push(INativeQueryVerifier.MerkleProofEntry({hash: sh[i], isLeft: sl[i]}));
        }
        // Find the LiquidationCall log's index inside the receipt.
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(f.txBytes);
        bool found;
        for (uint32 i; i < r.receiptLogs.length; ++i) {
            if (r.receiptLogs[i].address_ == AAVE_V3_POOL && r.receiptLogs[i].topics[0] == LIQUIDATION_CALL) {
                f.logIndex = i;
                found = true;
                break;
            }
        }
        assertTrue(found, "fixture should carry a LiquidationCall log");
    }

    function _sortFixtures() internal {
        for (uint256 i = 1; i < fx.length; ++i) {
            for (uint256 j = i; j > 0; --j) {
                bool swap = fx[j].height < fx[j - 1].height
                    || (fx[j].height == fx[j - 1].height && fx[j].txIndex < fx[j - 1].txIndex);
                if (!swap) break;
                _swap(j, j - 1);
            }
        }
    }

    function _swap(uint256 a, uint256 b) internal {
        Fixture memory tmpA = fx[a];
        Fixture memory tmpB = fx[b];
        _set(a, tmpB);
        _set(b, tmpA);
    }

    function _set(uint256 i, Fixture memory f) internal {
        fx[i].height = f.height;
        fx[i].txIndex = f.txIndex;
        fx[i].logIndex = f.logIndex;
        fx[i].txBytes = f.txBytes;
        fx[i].root = f.root;
        delete fx[i].siblings;
        for (uint256 k; k < f.siblings.length; ++k) fx[i].siblings.push(f.siblings[k]);
    }

    function _spans() internal view returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = spanId;
    }

    /// Member proofs for every fixture except `omit` (pass `type(uint256).max` to omit none).
    function _proofs(uint256 omit) internal view returns (AbsenceRegistryV3.MemberProof[] memory ps) {
        uint256 n = omit < fx.length ? fx.length - 1 : fx.length;
        ps = new AbsenceRegistryV3.MemberProof[](n);
        uint256 k;
        for (uint256 i; i < fx.length; ++i) {
            if (i == omit) continue;
            ps[k++] = AbsenceRegistryV3.MemberProof({
                height: fx[i].height,
                logIndex: fx[i].logIndex,
                encodedTransaction: fx[i].txBytes,
                siblings: fx[i].siblings
            });
        }
    }

    function _members(uint256 omit) internal view returns (AbsenceRegistryV3.Member[] memory ms) {
        uint256 n = omit < fx.length ? fx.length - 1 : fx.length;
        ms = new AbsenceRegistryV3.Member[](n);
        uint256 k;
        for (uint256 i; i < fx.length; ++i) {
            if (i == omit) continue;
            ms[k++] = AbsenceRegistryV3.Member({height: fx[i].height, txIndex: fx[i].txIndex, logIndex: fx[i].logIndex});
        }
    }

    function _assertComplete(address who, uint256 omit, uint256 bond) internal returns (uint256) {
        vm.prank(who);
        return registry.assertComplete{value: bond}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, _proofs(omit)
        );
    }

    function _revealOmission(address who, uint256 claimId, uint256 omitted, uint256 listOmit) internal {
        Fixture storage f = fx[omitted];
        AbsenceRegistryV3.Member[] memory ms = _members(listOmit);
        INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
        bytes32 c = registry.commitmentForComplete(claimId, f.height, f.txBytes, sib, f.logIndex, ms, "salt", who);
        vm.prank(who);
        registry.commitRefutation(c);
        vm.roll(block.number + 1);
        vm.prank(who);
        registry.revealOmission(claimId, f.height, f.txBytes, sib, f.logIndex, ms, "salt");
    }

    // ---------------------------------------------------------------------------------------
    // The headline
    // ---------------------------------------------------------------------------------------

    /// All six listed: nothing to refute, and after the window it stands.
    function test_completeSetWithEveryMemberStands() public {
        uint256 id = _assertComplete(claimant, type(uint256).max, 1 ether);
        assertEq(uint256(registry.kind(id)), uint256(IAbsenceV3.Kind.CompleteSet));
        assertEq(registry.memberCount(id), fx.length);

        // Every listed member is a real matching log: try to refute with each and fail.
        for (uint256 i; i < fx.length; ++i) {
            Fixture storage f = fx[i];
            AbsenceRegistryV3.Member[] memory ms = _members(type(uint256).max);
            INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
            bytes32 c = registry.commitmentForComplete(id, f.height, f.txBytes, sib, f.logIndex, ms, bytes32(i), refuter);
            vm.prank(refuter);
            registry.commitRefutation(c);
            vm.roll(block.number + 1);
            vm.prank(refuter);
            vm.expectRevert(AbsenceRegistryV3.MemberAlreadyListed.selector);
            registry.revealOmission(id, f.height, f.txBytes, sib, f.logIndex, ms, bytes32(i));
        }

        vm.warp(block.timestamp + 2 hours);
        registry.finalize(id);
        assertTrue(registry.holds(id));
        assertTrue(registry.isUsable(id, 0.5 ether), "half of 1 ether is unrecoverable");
        assertFalse(registry.isUsable(id, 0.5 ether + 1), "and not a wei more");
    }

    /// Omit any one member and that member refutes the claim. The mandate's named test.
    function testFuzz_completeSetRefutedByOmittedMember(uint8 rawOmit) public {
        uint256 omit = uint256(rawOmit) % fx.length;
        uint256 id = _assertComplete(claimant, omit, 1 ether);
        assertEq(registry.memberCount(id), fx.length - 1);

        uint256 refuterBefore = refuter.balance;
        uint256 burnBefore = registry.BURN().balance;

        _revealOmission(refuter, id, omit, omit);

        (IAbsence.Status s,,,,) = registry.assurance(id);
        assertEq(uint256(s), uint256(IAbsence.Status.Refuted));
        assertEq(refuter.balance, refuterBefore + 0.5 ether, "refuter takes half");
        assertEq(registry.BURN().balance, burnBefore + 0.5 ether, "half is burned");
    }

    /// A liar who refutes their own claim from a second address gets half back and loses half
    /// forever. The mandate's other named test.
    function test_selfRefuteCannotRecoverBurn() public {
        uint256 omit = 2;
        uint256 id = _assertComplete(claimant, omit, 2 ether);

        // The claimant's alt address does the refuting.
        uint256 altBefore = claimantsAlt.balance;
        uint256 claimantBefore = claimant.balance;
        _revealOmission(claimantsAlt, id, omit, omit);

        assertEq(claimantsAlt.balance, altBefore + 1 ether, "alt receives exactly half");
        assertEq(claimant.balance, claimantBefore, "claimant gets nothing back");
        assertEq(registry.enforceableLoss(id), 1 ether, "the other half is the enforceable loss");
        // Sum of everything the claimant's two addresses hold is down by exactly the burn.
        assertEq(registry.BURN().balance, 1 ether);
    }

    // ---------------------------------------------------------------------------------------
    // Assertion-time checks: a listed member must be real
    // ---------------------------------------------------------------------------------------

    /// A member whose log does not match the filter is refused at assertion, not left for a hunter.
    function test_fabricatedMemberIsRefusedAtAssertion() public {
        AbsenceRegistryV3.MemberProof[] memory ps = _proofs(type(uint256).max);
        ps[1].logIndex = 0; // some other log in the same receipt, not the liquidation
        // (if index 0 happened to be the liquidation, use the last log instead)
        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(ps[1].encodedTransaction);
        if (r.receiptLogs[0].topics[0] == LIQUIDATION_CALL && r.receiptLogs[0].address_ == AAVE_V3_POOL) {
            ps[1].logIndex = uint32(r.receiptLogs.length - 1);
        }
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(AbsenceRegistryV3.MemberDoesNotMatch.selector, 1));
        registry.assertComplete{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, ps);
    }

    /// A member with a tampered path does not verify and the whole assertion reverts.
    function test_memberWithBadPathIsRefusedAtAssertion() public {
        AbsenceRegistryV3.MemberProof[] memory ps = _proofs(type(uint256).max);
        ps[0].siblings[0].hash = bytes32(uint256(ps[0].siblings[0].hash) ^ 1);
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH, ps[0].height));
        registry.assertComplete{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, ps);
    }

    function test_membersOutOfOrderAreRefused() public {
        AbsenceRegistryV3.MemberProof[] memory ps = _proofs(type(uint256).max);
        AbsenceRegistryV3.MemberProof memory t = ps[0];
        ps[0] = ps[1];
        ps[1] = t;
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(AbsenceRegistryV3.MembersNotOrdered.selector, 1));
        registry.assertComplete{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, ps);
    }

    function test_duplicateMemberIsRefused() public {
        AbsenceRegistryV3.MemberProof[] memory ps = new AbsenceRegistryV3.MemberProof[](2);
        ps[0] = _proofs(type(uint256).max)[0];
        ps[1] = ps[0];
        vm.prank(claimant);
        vm.expectRevert(abi.encodeWithSelector(AbsenceRegistryV3.MembersNotOrdered.selector, 1));
        registry.assertComplete{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, ps);
    }

    function test_memberOutsideTheSpanIsRefused() public {
        // Seal a span that stops one block short of the last fixture.
        uint256 shortSpan = mirror.sealSpan(ETH, from, to - 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = shortSpan;
        vm.prank(claimant);
        vm.expectRevert(AbsenceRegistryV3.BlockOutsideSpan.selector);
        registry.assertComplete{value: 1 ether}(
            ids, AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, _proofs(type(uint256).max)
        );
    }

    function test_emptyMemberListIsRefused() public {
        AbsenceRegistryV3.MemberProof[] memory none;
        vm.prank(claimant);
        vm.expectRevert(AbsenceRegistryV3.NoMembers.selector);
        registry.assertComplete{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours, none);
    }

    // ---------------------------------------------------------------------------------------
    // Refutation-time checks
    // ---------------------------------------------------------------------------------------

    /// The refuter must present the member list exactly as asserted.
    function test_refuterWithWrongMemberListIsRefused() public {
        uint256 omit = 3;
        uint256 id = _assertComplete(claimant, omit, 1 ether);

        // Present a list that omits a *different* member than the claimant did: hash mismatch.
        uint256 wrongOmit = 1;
        Fixture storage f = fx[omit];
        AbsenceRegistryV3.Member[] memory wrong = _members(wrongOmit);
        INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
        bytes32 c = registry.commitmentForComplete(id, f.height, f.txBytes, sib, f.logIndex, wrong, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(c);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistryV3.WrongMemberList.selector);
        registry.revealOmission(id, f.height, f.txBytes, sib, f.logIndex, wrong, "s");
    }

    /// An `EmptySet` claim cannot be refuted through the completeness path and vice versa.
    function test_wrongKindIsRefused() public {
        vm.prank(claimant);
        uint256 emptyId = registry.assertAbsence{value: 1 ether}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours
        );
        Fixture storage f = fx[0];
        AbsenceRegistryV3.Member[] memory none;
        INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
        bytes32 c = registry.commitmentForComplete(emptyId, f.height, f.txBytes, sib, f.logIndex, none, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(c);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        vm.expectRevert(AbsenceRegistryV3.WrongKind.selector);
        registry.revealOmission(emptyId, f.height, f.txBytes, sib, f.logIndex, none, "s");
    }

    /// EmptySet regression: a false "no liquidations here" is refuted, with the burn.
    // ---------------------------------------------------------------------------------------
    // The index a consumer reads instead of walking claims
    // ---------------------------------------------------------------------------------------

    function _key() internal view returns (bytes32) {
        return registry.keyOf(ETH, AAVE_V3_POOL, LIQUIDATION_CALL, 0, bytes32(0));
    }

    function test_recordFollowsEveryTransition() public {
        bytes32 key = _key();
        (uint32 open, uint32 refuted, uint64 ev, uint64 mem, uint32 total) = registry.recordOf(key);
        assertEq(open + refuted + ev + mem + total, 0);

        // EmptySet, refuted by fx[0]
        vm.prank(claimant);
        uint256 lie = registry.assertAbsence{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours);
        (open,,,, total) = registry.recordOf(key);
        assertEq(open, 1);
        assertEq(total, 1);
        assertEq(registry.claimUnderKey(key, 0), lie);

        Fixture storage f = fx[fx.length - 1];
        INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
        bytes32 c = registry.commitmentFor(lie, f.height, f.txBytes, sib, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(c);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        registry.revealRefutation(lie, f.height, f.txBytes, sib, "s");
        (open, refuted, ev,, total) = registry.recordOf(key);
        assertEq(open, 0);
        assertEq(refuted, 1);
        assertEq(ev, f.height, "evidence height recorded");

        // A second refutation lower down must not lower the recorded maximum.
        vm.prank(claimant);
        uint256 lie2 = registry.assertAbsence{value: 1 ether}(_spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours);
        Fixture storage g = fx[0];
        INativeQueryVerifier.MerkleProofEntry[] memory sib2 = g.siblings;
        bytes32 c2 = registry.commitmentFor(lie2, g.height, g.txBytes, sib2, "t", refuter);
        vm.prank(refuter);
        registry.commitRefutation(c2);
        vm.roll(block.number + 1);
        vm.prank(refuter);
        registry.revealRefutation(lie2, g.height, g.txBytes, sib2, "t");
        (, refuted, ev,,) = registry.recordOf(key);
        assertEq(refuted, 2);
        assertEq(ev, f.height, "maximum, not latest");

        // CompleteSet listing everything: lastMemberAt is the top member; stands; open returns to 0.
        uint256 full = _assertComplete(claimant, type(uint256).max, 1 ether);
        (open,,, mem, total) = registry.recordOf(key);
        assertEq(open, 1);
        assertEq(mem, fx[fx.length - 1].height);
        assertEq(total, 3);
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(full);
        (open,,, mem,) = registry.recordOf(key);
        assertEq(open, 0);
        assertEq(mem, fx[fx.length - 1].height, "a listed event stays on record after the claim stands");
    }

    function testFuzz_keyOfSeparatesEveryField(uint64 chainKey, address venue, bytes32 topic0, uint8 rawSlot, bytes32 subject) public view {
        uint8 slot = uint8(bound(rawSlot, 1, 3));
        bytes32 k = registry.keyOf(chainKey, venue, topic0, slot, subject);
        assertTrue(k != registry.keyOf(chainKey ^ 1, venue, topic0, slot, subject));
        assertTrue(k != registry.keyOf(chainKey, address(uint160(venue) ^ 1), topic0, slot, subject));
        assertTrue(k != registry.keyOf(chainKey, venue, topic0 ^ bytes32(uint256(1)), slot, subject));
        assertTrue(k != registry.keyOf(chainKey, venue, topic0, slot == 3 ? 2 : slot + 1, subject));
        assertTrue(k != registry.keyOf(chainKey, venue, topic0, slot, subject ^ bytes32(uint256(1))));
        // Slot zero constrains no subject, so every subject is the same key.
        assertEq(registry.keyOf(chainKey, venue, topic0, 0, subject), registry.keyOf(chainKey, venue, topic0, 0, bytes32(0)));
    }

    /// A claimant that will not take its bond back cannot keep its claim Open -- which would block
    /// lending to its subject forever. The claim stands; the bond waits to be withdrawn.
    function test_claimantRefusingItsBondCannotKeepAClaimOpen() public {
        StubbornClaimant stubborn = new StubbornClaimant();
        vm.deal(address(stubborn), 0);
        uint256 id = stubborn.assertAbsence{value: 1 ether}(registry, _spans(), AAVE_V3_POOL, keccak256("NeverEmitted()"), 15 minutes);
        vm.warp(block.timestamp + 16 minutes);

        registry.finalize(id);
        assertTrue(registry.holds(id), "stands despite the refused payment");
        assertEq(registry.owed(address(stubborn)), 1 ether);
        (uint32 open,,,,) = registry.recordOf(registry.keyOf(ETH, AAVE_V3_POOL, keccak256("NeverEmitted()"), 0, 0));
        assertEq(open, 0);

        vm.expectRevert(AbsenceRegistryV3.TransferFailed.selector);
        stubborn.withdraw(registry);

        stubborn.setAccept(true);
        stubborn.withdraw(registry);
        assertEq(address(stubborn).balance, 1 ether);
        assertEq(registry.owed(address(stubborn)), 0);

        vm.expectRevert(AbsenceRegistryV3.NothingOwed.selector);
        stubborn.withdraw(registry);
    }

    /// Nor can it turn finalisation into an out-of-gas trap for whoever calls it.
    function test_claimantBurningGasCannotBlockFinalize() public {
        StubbornClaimant hog = new StubbornClaimant();
        hog.setBurnGas(true);
        uint256 id = hog.assertAbsence{value: 1 ether}(registry, _spans(), AAVE_V3_POOL, keccak256("NeverEmitted()"), 15 minutes);
        vm.warp(block.timestamp + 16 minutes);

        uint256 g = gasleft();
        registry.finalize{gas: 200_000}(id);
        assertLt(g - gasleft(), 200_000);
        assertTrue(registry.holds(id));
        assertEq(registry.owed(address(hog)), 1 ether);
    }

    function test_emptySetStillRefutesWithBurn() public {
        vm.prank(claimant);
        uint256 id = registry.assertAbsence{value: 1 ether}(
            _spans(), AAVE_V3_POOL, LIQUIDATION_CALL, bytes32(0), 0, 1 hours
        );
        Fixture storage f = fx[0];
        INativeQueryVerifier.MerkleProofEntry[] memory sib = f.siblings;
        bytes32 c = registry.commitmentFor(id, f.height, f.txBytes, sib, "s", refuter);
        vm.prank(refuter);
        registry.commitRefutation(c);
        vm.roll(block.number + 1);
        uint256 before = refuter.balance;
        vm.prank(refuter);
        registry.revealRefutation(id, f.height, f.txBytes, sib, "s");
        assertEq(refuter.balance, before + 0.5 ether);
        assertEq(registry.BURN().balance, 0.5 ether);
    }

    // ---------------------------------------------------------------------------------------
    // The numbers a consumer sizes against
    // ---------------------------------------------------------------------------------------

    function testFuzz_enforceableLossIsExactlyTheBurnedHalf(uint96 rawBond) public {
        uint256 bond = uint256(rawBond) % 50 ether + 0.01 ether;
        uint256 id = _assertComplete(claimant, 0, bond);
        uint256 expectedLoss = bond - (bond * 5000) / 10_000;
        assertEq(registry.enforceableLoss(id), expectedLoss);

        uint256 burnBefore = registry.BURN().balance;
        _revealOmission(refuter, id, 0, 0);
        assertEq(registry.BURN().balance - burnBefore, expectedLoss, "burned amount equals enforceableLoss");
    }

    function testFuzz_isUsableBoundary(uint96 rawBond, uint96 rawExposure) public {
        uint256 bond = uint256(rawBond) % 50 ether + 0.01 ether;
        uint256 id = _assertComplete(claimant, type(uint256).max, bond);
        vm.warp(block.timestamp + 2 hours);
        registry.finalize(id);

        uint256 loss = registry.enforceableLoss(id);
        uint256 exposure = uint256(rawExposure) % (60 ether);
        assertEq(registry.isUsable(id, exposure), exposure <= loss);
    }

    /// A refuted or open claim is never usable, however large the bond.
    function test_onlyStandingIsUsable() public {
        uint256 open = _assertComplete(claimant, type(uint256).max, 10 ether);
        assertFalse(registry.isUsable(open, 1));
        uint256 lying = _assertComplete(claimant, 1, 10 ether);
        _revealOmission(refuter, lying, 1, 1);
        assertFalse(registry.isUsable(lying, 1));
    }

    /// The frozen four functions still answer exactly as before.
    function test_frozenInterfaceUnchanged() public {
        IAbsence frozen = IAbsence(address(registry));
        uint256 id = _assertComplete(claimant, type(uint256).max, 1 ether);
        (IAbsence.Status s, uint256 bond, uint64 openUntil, uint64 f, uint64 t) = frozen.assurance(id);
        assertEq(uint256(s), uint256(IAbsence.Status.Open));
        assertEq(bond, 1 ether);
        assertTrue(openUntil > block.timestamp);
        assertEq(f, from);
        assertEq(t, to);
        assertFalse(frozen.holds(id));
        assertFalse(frozen.holdsWithBond(id, 1 ether));
        assertEq(frozen.claimCount(), 1);
    }
}
