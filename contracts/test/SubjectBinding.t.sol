// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EthereumMirror} from "../src/EthereumMirror.sol";
import {AbsenceRegistryV3} from "../src/AbsenceRegistryV3.sol";
import {UnderwritingDesk} from "../src/UnderwritingDesk.sol";
import {SubjectBinding} from "../src/SubjectBinding.sol";
import {ISubjectBinding} from "../src/ISubjectBinding.sol";
import {IMirror} from "../src/IMirror.sol";
import {IMirrorSpans} from "../src/IMirrorSpans.sol";
import {MirrorLib} from "../src/MirrorLib.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract BindMockVerifier {
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

contract BindMockStash {
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

/// @title Who a caller speaks for
/// @notice `borrow` underwrites the caller and takes no subject, which is the whole reason a refusal
///         cannot be washed -- and also the reason the desk could only ever pay a fresh Creditcoin
///         wallet. These tests are about closing that without reopening the first thing.
///
///         The binding transactions here are synthesised rather than pulled from mainnet, because no
///         real Ethereum transaction has yet been signed with this tag in its calldata. Every other
///         part of the path is real: the leaf is hashed the way the encoder hashes it, the root is
///         held by the mirror, and `verifyOrRevert` is the frozen interface a stranger would call.
contract SubjectBindingTest is Test {
    EthereumMirror internal mirror;
    SubjectBinding internal binding;
    AbsenceRegistryV3 internal registry;
    UnderwritingDesk internal desk;

    uint64 constant ETH = 3;
    uint64 constant SEPOLIA = 1;
    uint64 constant H = 25_000_000;

    address constant ALICE_ETH = address(0xA11CE);
    address constant BOB_ETH = address(0xB0B);
    address constant ALICE_CC = address(0xCC01);
    address constant BOB_CC = address(0xCC02);
    address constant STRANGER = address(0x5EE);
    address constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    INativeQueryVerifier.MerkleProofEntry[] internal noSiblings;

    function setUp() public {
        vm.etch(address(uint160(0x0FD2)), address(new BindMockVerifier()).code);
        vm.etch(address(uint160(0x0FD4)), address(new BindMockStash()).code);
        BindMockStash(address(uint160(0x0FD4))).set(4, 100 ether);
        mirror = new EthereumMirror();
        binding = new SubjectBinding(IMirror(address(mirror)));
        registry = new AbsenceRegistryV3(mirror);
        desk = new UnderwritingDesk(IMirrorSpans(address(mirror)), registry, ISubjectBinding(address(binding)));
    }

    /// One transaction, encoded the way the SDK encodes one, with arbitrary calldata.
    function _tx(address from, bytes memory data, uint8 status) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(uint64(7), uint64(21_000), from, false, from, uint256(0), data);
        chunks[1] = abi.encode(uint64(1), uint128(1 gwei), uint128(2 gwei), new EvmV1Decoder.AccessListEntry[](0), uint8(0), bytes32(0), bytes32(0));
        chunks[2] = abi.encode(status, uint64(21_000), new EvmV1Decoder.LogEntryTuple[](0), bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _bindTx(address from, address controller, uint8 status) internal view returns (bytes memory) {
        return _tx(from, binding.bindingCalldata(controller), status);
    }

    /// Hold a block on `chainKey` at `height` whose only transaction is `txBytes`.
    function _hold(uint64 chainKey, uint64 height, bytes memory txBytes) internal {
        bytes32[] memory roots = new bytes32[](1);
        roots[0] = MirrorLib.hashLeaf(txBytes);
        mirror.mirror(chainKey, height, hex"00", roots[0], noSiblings, bytes32(0), roots);
    }

    // ---------------------------------------------------------------------------------------
    // The binding itself
    // ---------------------------------------------------------------------------------------

    /// The calldata is a public, pure function of the controller: a wallet can produce it offline,
    /// and anyone reading the transaction on Etherscan can see exactly what was agreed to.
    function test_theCalldataIsThirtyTwoBytesAndSaysWho() public view {
        bytes memory data = binding.bindingCalldata(ALICE_CC);
        assertEq(data.length, 32, "twelve bytes of tag, twenty of address");
        assertEq(bytes12(bytes32(data)), binding.MAGIC());
        assertEq(address(uint160(uint256(bytes32(data)))), ALICE_CC);
    }

    function test_aSignedTransactionBindsTheAddressThatSignedIt() public {
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, txBytes);

        vm.expectEmit(true, true, true, true);
        emit SubjectBinding.Bound(ALICE_CC, ETH, ALICE_ETH, H);
        (address controller, address subject) = binding.bind(ETH, H, txBytes, noSiblings);

        assertEq(controller, ALICE_CC);
        assertEq(subject, ALICE_ETH);
        assertEq(binding.subjectFor(ALICE_CC, ETH), ALICE_ETH, "the controller now speaks for it");
        assertEq(binding.controllerOf(ETH, ALICE_ETH), ALICE_CC);
        assertEq(binding.boundSubject(ALICE_CC).height, H);
    }

    /// Nobody is bound by default, and an unbound caller is underwritten as itself -- which is v4's
    /// behaviour exactly. Adding binding must not change what happens to a caller who never uses it.
    function test_anUnboundCallerSpeaksOnlyForItself() public view {
        assertEq(binding.subjectFor(STRANGER, ETH), STRANGER);
        assertEq(binding.controllerOf(ETH, ALICE_ETH), address(0));
    }

    /// Anyone may submit anyone's proof, because a proof can only bind the pair its signer named.
    /// A stranger relaying Alice's transaction binds Alice to Alice's chosen address, not to theirs.
    function test_aStrangerMaySubmitTheProofAndStillCannotStealIt() public {
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, txBytes);
        vm.prank(STRANGER);
        binding.bind(ETH, H, txBytes, noSiblings);
        assertEq(binding.subjectFor(ALICE_CC, ETH), ALICE_ETH);
        assertEq(binding.subjectFor(STRANGER, ETH), STRANGER, "the relayer gained nothing");
    }

    /// The same twenty bytes on two chains are two different addresses with two different histories.
    function test_theSameAddressOnTwoChainsIsTwoSubjects() public {
        bytes memory onEth = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, onEth);
        binding.bind(ETH, H, onEth, noSiblings);

        assertEq(binding.subjectFor(ALICE_CC, ETH), ALICE_ETH);
        assertEq(binding.subjectFor(ALICE_CC, SEPOLIA), ALICE_CC, "a mainnet binding says nothing about Sepolia");
    }

    // ---------------------------------------------------------------------------------------
    // What is not a binding
    // ---------------------------------------------------------------------------------------

    function test_ordinaryCalldataIsNotABinding() public {
        bytes memory transfer = abi.encodeWithSignature("transfer(address,uint256)", ALICE_CC, 1 ether);
        bytes memory txBytes = _tx(ALICE_ETH, transfer, 1);
        _hold(ETH, H, txBytes);
        vm.expectRevert(SubjectBinding.NotABindingTransaction.selector);
        binding.bind(ETH, H, txBytes, noSiblings);
    }

    /// Thirty-two bytes that happen not to start with the tag. The tag is a keccak prefix, so this is
    /// the only way to land here on purpose and no way to land here by accident.
    function test_thirtyTwoBytesWithoutTheTagIsNotABinding() public {
        bytes memory txBytes = _tx(ALICE_ETH, abi.encode(uint256(uint160(ALICE_CC))), 1);
        _hold(ETH, H, txBytes);
        vm.expectRevert(SubjectBinding.NotABindingTransaction.selector);
        binding.bind(ETH, H, txBytes, noSiblings);
    }

    /// A reverted transaction is not an act. The same rule the registry applies to a liquidation.
    function test_aRevertedTransactionBindsNothing() public {
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 0);
        _hold(ETH, H, txBytes);
        vm.expectRevert(SubjectBinding.TransactionReverted.selector);
        binding.bind(ETH, H, txBytes, noSiblings);
        assertEq(binding.subjectFor(ALICE_CC, ETH), ALICE_CC);
    }

    /// Fail-closed, through the frozen interface: a transaction in a block nobody holds does not
    /// return a value, it reverts. This is the property the whole desk rests on.
    function test_aTransactionInAnUnheldBlockBindsNothing() public {
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.NotMirrored.selector, ETH, H));
        binding.bind(ETH, H, txBytes, noSiblings);
    }

    /// The block is held, but this transaction is not the one in it.
    function test_aTransactionForgedIntoAHeldBlockBindsNothing() public {
        _hold(ETH, H, _bindTx(BOB_ETH, BOB_CC, 1));
        bytes memory forged = _bindTx(ALICE_ETH, ALICE_CC, 1);
        vm.expectRevert(abi.encodeWithSelector(EthereumMirror.ProofInvalid.selector, ETH, H));
        binding.bind(ETH, H, forged, noSiblings);
    }

    // ---------------------------------------------------------------------------------------
    // Replay, and moving house
    // ---------------------------------------------------------------------------------------

    /// A bind transaction is public forever, so the interesting question is not whether it can be
    /// replayed -- it can -- but whether replaying it can undo a later decision. It cannot.
    function test_anOldProofCannotDragASubjectBack() public {
        bytes memory first = _bindTx(ALICE_ETH, ALICE_CC, 1);
        bytes memory second = _bindTx(ALICE_ETH, BOB_CC, 1);
        _hold(ETH, H, first);
        _hold(ETH, H + 100, second);

        binding.bind(ETH, H, first, noSiblings);
        binding.bind(ETH, H + 100, second, noSiblings);
        assertEq(binding.subjectFor(BOB_CC, ETH), ALICE_ETH, "Alice moved to a new key");
        assertEq(binding.subjectFor(ALICE_CC, ETH), ALICE_CC, "the old key speaks for nobody");

        vm.expectRevert(abi.encodeWithSelector(SubjectBinding.NotNewer.selector, H + 100, H));
        binding.bind(ETH, H, first, noSiblings);
        assertEq(binding.subjectFor(BOB_CC, ETH), ALICE_ETH, "and it stayed moved");
    }

    /// Re-submitting the *current* proof changes nothing and is refused rather than silently accepted:
    /// "not newer" is the honest answer, and it keeps `bind` from being a free write.
    function test_resubmittingTheSameProofIsRefused() public {
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, txBytes);
        binding.bind(ETH, H, txBytes, noSiblings);
        vm.expectRevert(abi.encodeWithSelector(SubjectBinding.NotNewer.selector, H, H));
        binding.bind(ETH, H, txBytes, noSiblings);
    }

    /// One key never speaks for two subjects at once: taking on a new one releases the old.
    function test_aControllerSpeaksForOneSubjectAtATime() public {
        bytes memory a = _bindTx(ALICE_ETH, ALICE_CC, 1);
        bytes memory b = _bindTx(BOB_ETH, ALICE_CC, 1);
        _hold(ETH, H, a);
        _hold(ETH, H + 1, b);
        binding.bind(ETH, H, a, noSiblings);
        binding.bind(ETH, H + 1, b, noSiblings);

        assertEq(binding.subjectFor(ALICE_CC, ETH), BOB_ETH, "the newest signature wins");
        assertEq(binding.controllerOf(ETH, ALICE_ETH), address(0), "and Alice has no controller again");
        assertEq(binding.controllerOf(ETH, BOB_ETH), ALICE_CC);
    }

    // ---------------------------------------------------------------------------------------
    // The desk, on a bound caller
    // ---------------------------------------------------------------------------------------

    /// The point of the whole exercise: a refusal that belongs to an Ethereum address now reaches the
    /// Creditcoin wallet asking on its behalf. A liquidated borrower cannot borrow here by moving key.
    function test_aBoundCallerIsUnderwrittenAsItsSubject() public {
        // One held day of Ethereum, sealed, so the policy has a window to be priced against.
        bytes32[] memory roots = new bytes32[](600);
        for (uint256 i; i < roots.length; ++i) roots[i] = keccak256(abi.encode("root", 26_000_000 + i));
        mirror.mirror(ETH, 26_000_000, hex"00", roots[0], noSiblings, bytes32(0), roots);
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH, 26_000_000, 26_000_599);

        uint256 policy = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BlankFile,
                chainKey: ETH,
                window: 500,
                maxStaleness: 0,
                venue: AAVE,
                topic0: keccak256("LiquidationCall"),
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 1 ether,
                requiresBinding: false
            })
        );

        // Before binding, the fresh Creditcoin wallet is underwritten as itself: a blank file.
        assertEq(desk.subjectOf(ALICE_CC, policy), ALICE_CC);
        (bool ok,) = desk.assess(ALICE_CC, policy, 0, span);
        assertTrue(ok, "nothing is known about the fresh wallet");

        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, txBytes);
        binding.bind(ETH, H, txBytes, noSiblings);

        // After binding, the desk reads Alice's Ethereum record for Alice's Creditcoin wallet.
        assertEq(desk.subjectOf(ALICE_CC, policy), ALICE_ETH, "the desk now asks about the Ethereum address");
    }

    /// The hole binding actually closes. A fresh Creditcoin wallet can buy a bonded claim that it was
    /// never liquidated on Ethereum -- true of every address ever generated, and cheap -- and v4 would
    /// have lent against it. Terms that require binding refuse that wallet until somebody proves it
    /// speaks for an address that actually has an Ethereum history to be clean about.
    function test_termsRequiringBindingRefuseAFreshWallet() public {
        bytes32[] memory roots = new bytes32[](600);
        for (uint256 i; i < roots.length; ++i) roots[i] = keccak256(abi.encode("root", 26_000_000 + i));
        mirror.mirror(ETH, 26_000_000, hex"00", roots[0], noSiblings, bytes32(0), roots);
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH, 26_000_000, 26_000_599);
        uint256 policy = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH,
                window: 500,
                maxStaleness: 0,
                venue: AAVE,
                topic0: keccak256("LiquidationCall"),
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 1 ether,
                requiresBinding: true
            })
        );
        vm.deal(address(this), 20 ether);
        desk.fund{value: 10 ether}();

        // A trivially true claim about the fresh wallet itself, filed and stood.
        vm.deal(STRANGER, 10 ether);
        vm.prank(STRANGER);
        uint256 vanity = registry.assertAbsence{value: 2 ether}(
            span, AAVE, keccak256("LiquidationCall"), bytes32(uint256(uint160(ALICE_CC))), 3, 15 minutes
        );
        vm.warp(uint256(registry.claimOf(vanity).openUntil) + 1);
        registry.finalize(vanity);

        (, UnderwritingDesk.Refusal why) = desk.assess(ALICE_CC, policy, 1 ether, span);
        assertEq(uint256(why), uint256(UnderwritingDesk.Refusal.UnprovenSubject), "a wallet with no Ethereum behind it");
        vm.prank(ALICE_CC);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.UnprovenSubject));
        desk.borrow(policy, 1 ether, span);

        // Bound to a real Ethereum address with a standing claim of its own, the same wallet is paid.
        vm.prank(STRANGER);
        uint256 real = registry.assertAbsence{value: 2 ether}(
            span, AAVE, keccak256("LiquidationCall"), bytes32(uint256(uint160(ALICE_ETH))), 3, 15 minutes
        );
        vm.warp(uint256(registry.claimOf(real).openUntil) + 1);
        registry.finalize(real);
        bytes memory txBytes = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, txBytes);
        binding.bind(ETH, H, txBytes, noSiblings);

        (bool ok,) = desk.assess(ALICE_ETH, policy, 1 ether, span);
        assertTrue(ok, "the Ethereum address, now with a controller, is underwritten");
        vm.prank(ALICE_CC);
        desk.borrow(policy, 1 ether, span);
        assertEq(ALICE_CC.balance, 1 ether);
    }

    /// The record, not the key, is what gets one loan. Rotating Creditcoin wallets buys nothing.
    function test_oneLoanPerSubjectHoweverManyKeysItRotatesThrough() public {
        bytes32[] memory roots = new bytes32[](600);
        for (uint256 i; i < roots.length; ++i) roots[i] = keccak256(abi.encode("root", 26_000_000 + i));
        mirror.mirror(ETH, 26_000_000, hex"00", roots[0], noSiblings, bytes32(0), roots);
        uint256[] memory span = new uint256[](1);
        span[0] = mirror.sealSpan(ETH, 26_000_000, 26_000_599);
        uint256 policy = desk.createPolicy(
            UnderwritingDesk.Policy({
                kind: UnderwritingDesk.Kind.BondedClean,
                chainKey: ETH,
                window: 500,
                maxStaleness: 0,
                venue: AAVE,
                topic0: keccak256("LiquidationCall"),
                subjectTopic: 3,
                minBond: 0,
                maxPrincipal: 1 ether,
                requiresBinding: false
            })
        );

        // A standing bonded claim about the *Ethereum* address, filed by somebody else entirely.
        uint256[] memory spans = new uint256[](1);
        spans[0] = span[0];
        vm.deal(STRANGER, 10 ether);
        vm.prank(STRANGER);
        uint256 claimId = registry.assertAbsence{value: 2 ether}(
            spans, AAVE, keccak256("LiquidationCall"), bytes32(uint256(uint160(ALICE_ETH))), 3, 15 minutes
        );
        vm.warp(uint256(registry.claimOf(claimId).openUntil) + 1);
        registry.finalize(claimId);

        vm.deal(address(this), 20 ether);
        desk.fund{value: 10 ether}();

        bytes memory first = _bindTx(ALICE_ETH, ALICE_CC, 1);
        _hold(ETH, H, first);
        binding.bind(ETH, H, first, noSiblings);

        vm.prank(ALICE_CC);
        desk.borrow(policy, 1 ether, span);
        assertEq(ALICE_CC.balance, 1 ether, "the loan reaches the key that proved it speaks for the record");
        assertTrue(desk.lent(ALICE_ETH, policy), "and the record is what is marked, not the key");

        // Now rotate: Alice signs again, later, naming a second Creditcoin wallet.
        bytes memory second = _bindTx(ALICE_ETH, BOB_CC, 1);
        _hold(ETH, H + 1, second);
        binding.bind(ETH, H + 1, second, noSiblings);

        vm.prank(BOB_CC);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingDesk.Rejected.selector, UnderwritingDesk.Refusal.AlreadyLent));
        desk.borrow(policy, 1 ether, span);
    }
}
