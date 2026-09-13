// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMirror} from "./IMirror.sol";
import {IAbsence} from "./IAbsence.sol";
import {IAbsenceV3} from "./IAbsenceV3.sol";

/// @title UnderwritingDesk
/// @notice A lender that reads the archive and the absence market, and refuses.
///
/// @dev WHAT THIS IS NOT
///
///      It is not a credit score, not a passport, not a soulbound token, not a 300-850 number.
///      Nothing here is minted and nothing is transferable. The product is the **refusal**: an
///      address walks up, the desk consults facts it did not author, and either pays or reverts.
///      A score would launder an economic bond into an attribute; a refusal does not.
///
///      WHY THE BORROWER CANNOT SAY WHO THEY ARE
///
///      `borrow` underwrites `msg.sender` and takes no subject argument. If a caller could name
///      their own subject, every refusal would be one parameter away from being washed: point at
///      a clean address, collect the loan. The subject of a liquidation is decoded from the log's
///      indexed topic by the registry, and the desk asks about the caller. Those two facts have to
///      meet at the same address or the money does not move.
///
///      `assess` exposes exactly the predicate `borrow` gates on, as a `view`, for any address.
///      It is not a parallel implementation -- both call `_assess` -- so a judge can run the
///      refusal against a real liquidated mainnet borrower without needing that borrower's key,
///      and know they are running the code that holds the money.
///
///      FAIL-CLOSED, IN BOTH DIRECTIONS THAT MATTER
///
///      If the archive does not hold every height of the policy's window, the desk refuses: an
///      answer drawn from history it does not hold is not an answer. Refusing on incapacity is the
///      only safe direction for a lender, and it is the direction most file-based designs get wrong.
///
///      WHAT IT READS, AND WHAT IT REFUSES TO BE FOOLED BY
///
///      The desk reads the registry only through `IAbsenceV3`, and only under one key: chain, venue,
///      event, topic slot and subject together. Matching on the subject alone would accept a true
///      statement about the wrong thing -- "no LiquidationCall whose *collateral asset* is 0xabc",
///      or "no LiquidationCall on Sepolia" -- as a clean record on mainnet. The key makes those
///      different files. The registry keeps running totals per key, so the decision is a handful
///      of reads however many claims exist, and nobody can switch the desk off by filing junk.
///
///      THE TWO POLICIES, AND WHY BOTH SHIP
///
///      `BlankFile` treats silence as acceptable: an address with nothing said about it can
///      borrow, and only an Open or Refuted claim blocks. This is the honest default, because it
///      does not pretend that "no evidence" is "evidence of none".
///
///      `BondedClean` requires someone to have staked a bond on this address's cleanliness and
///      survived a challenge window. It is stronger, and it is the one that looks like a green
///      check -- so it is never the default, and a consumer choosing it is choosing to rely on an
///      economic assertion rather than a cryptographic one.
contract UnderwritingDesk {
    IMirror public immutable MIRROR;
    IAbsenceV3 public immutable REGISTRY;

    /// @notice Most claims under one key the desk will examine looking for bonded cleanliness.
    /// @dev Only `BondedClean` walks, newest first, and only to find a *reason to lend*. Refusals
    ///      come from the registry's aggregates, which no volume of claims can hide. Somebody who
    ///      buries a subject's bonded claim under 64 newer ones gets that subject refused, not paid.
    uint256 public constant MAX_CLAIM_SCAN = 64;

    enum Kind {
        BlankFile,
        BondedClean
    }

    /// @dev Why a decision went the way it did. Returned rather than thrown by `assess`, so the
    ///      interface can render the reason instead of a bare failure. Appended, never reordered.
    enum Refusal {
        None,
        NoSuchPolicy,
        ArchiveTooShallow,
        ClaimUnderHunt,
        ProvenLiar,
        NoBondedCleanliness,
        DeskOutOfFunds,
        /// A `CompleteSet` listed a matching event about this subject inside the window. Each
        /// member was verified against the mirror at assertion: this is an inclusion fact.
        EventOnRecord,
        /// This desk already lent to this address under this policy. One loan each: the desk has
        /// no repayment path, and a lender without one that lends twice is a faucet.
        AlreadyLent
    }

    struct Policy {
        Kind kind;
        uint64 chainKey;
        /// @dev How many blocks of mirrored history the desk insists on before answering at all,
        ///      and how far back a refutation or a listed event still counts. The production
        ///      policy is 648,000 -- ninety days of Ethereum at 12s.
        uint64 window;
        /// @dev `BondedClean` only: how far below the archive head a clean claim may end and still
        ///      count. A claim is a statement about a fixed range; the head keeps moving.
        uint64 maxStaleness;
        address venue;
        bytes32 topic0;
        /// @dev Which indexed topic carries the subject, matching the registry's convention.
        uint8 subjectTopic;
        /// @dev `BondedClean` only: the least unrecoverable loss a lie must have cost.
        uint256 minBond;
        uint256 maxPrincipal;
    }

    Policy[] internal _policies;

    /// @notice borrower => policyId => lent.
    mapping(address => mapping(uint256 => bool)) public lent;

    event PolicyCreated(uint256 indexed policyId, Kind kind, address venue, bytes32 topic0, uint256 minBond);
    event Funded(address indexed from, uint256 amount);
    event Lent(address indexed borrower, uint256 indexed policyId, uint256 principal);

    error NoSuchPolicy();
    error BadPolicy();
    error PrincipalTooLarge();
    error ZeroPrincipal();
    error Rejected(Refusal reason);
    error TransferFailed();

    constructor(IMirror mirror_, IAbsenceV3 registry_) {
        MIRROR = mirror_;
        REGISTRY = registry_;
    }

    /// @notice Anyone may define a policy. There is no admin, and no policy can mark an address
    ///         eligible -- a policy only decides which public facts are consulted.
    function createPolicy(Policy calldata p) external returns (uint256 policyId) {
        // A subject has to be read from somewhere: a policy over topic slot 0 would consult
        // claims about nobody, and would lend to everybody.
        if (p.subjectTopic == 0 || p.subjectTopic > 3 || p.window == 0 || p.maxPrincipal == 0) revert BadPolicy();
        policyId = _policies.length;
        _policies.push(p);
        emit PolicyCreated(policyId, p.kind, p.venue, p.topic0, p.minBond);
    }

    /// @notice Put lendable funds behind the desk. No withdrawal path: this is a demonstration
    ///         lender, and a withdrawal function would be the one privileged operation here.
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice The decision, for any address, without moving money.
    /// @dev Same code path `borrow` gates on. If this returns false for an address, that address
    ///      cannot borrow, whoever is asking.
    function assess(address subject, uint256 policyId, uint256 principal)
        external
        view
        returns (bool ok, Refusal reason)
    {
        reason = _assess(subject, policyId, principal);
        ok = reason == Refusal.None;
    }

    /// @notice Borrow against your own record. Underwrites `msg.sender`, by construction.
    function borrow(uint256 policyId, uint256 principal) external {
        if (policyId >= _policies.length) revert NoSuchPolicy();
        if (principal == 0) revert ZeroPrincipal();
        if (principal > _policies[policyId].maxPrincipal) revert PrincipalTooLarge();

        Refusal reason = _assess(msg.sender, policyId, principal);
        if (reason != Refusal.None) revert Rejected(reason);

        lent[msg.sender][policyId] = true;
        emit Lent(msg.sender, policyId, principal);
        (bool sent,) = payable(msg.sender).call{value: principal}("");
        if (!sent) revert TransferFailed();
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function policyOf(uint256 policyId) external view returns (Policy memory) {
        if (policyId >= _policies.length) revert NoSuchPolicy();
        return _policies[policyId];
    }

    // -------------------------------------------------------------------------------------------
    // The decision
    // -------------------------------------------------------------------------------------------

    function _assess(address subject, uint256 policyId, uint256 principal) internal view returns (Refusal) {
        if (policyId >= _policies.length) return Refusal.NoSuchPolicy;
        Policy memory p = _policies[policyId];

        if (lent[subject][policyId]) return Refusal.AlreadyLent;
        if (address(this).balance < principal) return Refusal.DeskOutOfFunds;

        // An answer drawn from history the archive does not hold is not an answer. "Holds" means
        // every height in the window, not two endpoints: `lowestMirrored` and `highestMirrored`
        // can sit ninety days apart around a hole, and a liquidation inside that hole is one no
        // hunter can ever prove. `contiguousFrom` walks the held bitmap a word at a time, so the
        // 648,000-block policy reads ~2,532 slots -- free in `assess`, 7.03M gas cold in `borrow`
        // (measured, `test_gas_ninetyDayBorrowReadsTheBitmapWordWise`).
        // Anchored on the highest held height, so anyone mirroring an isolated window above a gap
        // makes the desk refuse until the gap is filled: fail-closed, which is the right way to fail.
        uint64 head = MIRROR.highestMirrored(p.chainKey);
        if (head == 0 || head < p.window) return Refusal.ArchiveTooShallow;
        uint64 floor = head - p.window;
        if (MIRROR.contiguousFrom(p.chainKey, floor, p.window + 1) <= p.window) return Refusal.ArchiveTooShallow;

        bytes32 key = REGISTRY.keyOf(p.chainKey, p.venue, p.topic0, p.subjectTopic, bytes32(uint256(uint160(subject))));
        (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total) = REGISTRY.recordOf(key);

        // Someone produced the transaction and it verified against a mirrored root, inside the
        // window. The only status backed by cryptography, and it is disqualifying.
        if (refuted != 0 && lastEvidenceAt >= floor) return Refusal.ProvenLiar;
        // Someone listed the event itself, verified at assertion. Also cryptography.
        if (lastMemberAt != 0 && lastMemberAt >= floor) return Refusal.EventOnRecord;
        // Somebody is hunting this address right now. Do not lend into a fight.
        if (open != 0) return Refusal.ClaimUnderHunt;

        if (p.kind == Kind.BlankFile) return Refusal.None;

        // BondedClean: a standing EmptySet that covers a full window of its own, ends near the head,
        // and whose *unrecoverable* half covers what the desk is about to pay out.
        uint256 need = principal > p.minBond ? principal : p.minBond;
        uint256 scanned;
        for (uint256 i = total; i > 0 && scanned < MAX_CLAIM_SCAN; ++scanned) {
            uint256 id = REGISTRY.claimUnderKey(key, --i);
            if (REGISTRY.kind(id) != IAbsenceV3.Kind.EmptySet) continue;
            if (!REGISTRY.isUsable(id, need)) continue;
            (,,, uint64 spanFrom, uint64 spanTo) = REGISTRY.assurance(id);
            if (spanTo - spanFrom < p.window) continue;
            if (spanTo + p.maxStaleness < head) continue;
            return Refusal.None;
        }
        return Refusal.NoBondedCleanliness;
    }
}
