// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMirror} from "./IMirror.sol";
import {IMirrorSpans} from "./IMirrorSpans.sol";
import {IAbsence} from "./IAbsence.sol";
import {IAbsenceV3} from "./IAbsenceV3.sol";
import {AttestorStash} from "./IAttestorStash.sol";
import {ISubjectBinding} from "./ISubjectBinding.sol";

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
///      The cost of that rule was that the desk could only pay a wallet holding a *Creditcoin* key,
///      while every record worth underwriting belongs to an *Ethereum* address -- so the only borrower
///      it ever paid was a fresh wallet whose clean claim was trivially true. `SubjectBinding` closes
///      that without reopening the hole: an Ethereum address signs a transaction naming a Creditcoin
///      address, the transaction is proven against a root this chain holds, and the desk underwrites
///      what `subjectFor(msg.sender)` returns. Still not a parameter -- a liar would need the
///      stranger's Ethereum key, which is the same barrier as before -- and an unbound caller is
///      underwritten as itself, exactly as in v4.
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
///      HOW THE WINDOW IS PROVEN, AND WHY IT IS NOT WALKED
///
///      Depth used to be checked by walking the held bitmap across the whole window: ~2,532 cold
///      SLOADs, 7.03M gas inside `borrow` for ninety days. A lender that expensive is a screenshot of
///      a `view`. The walk is now done once, by `sealSpan`, and the caller passes the sealed spans it
///      relies on: the desk checks they are adjacent, on the policy's chain, long enough to cover the
///      window, and recent enough to still describe the head. That is a handful of slots, and it is
///      the same fact -- a span cannot be sealed across a hole, and a held bit is never unset.
///
///      Passing spans is not a privilege. Anyone may seal; anyone may pass them; a caller who passes a
///      stale or short set is refused, and one who passes somebody else's spans gets the same answer.
///
///      WHAT BACKS THE MONEY
///
///      Two ceilings, neither of them ours to raise: a loan may not exceed ten times what a liar would
///      have lost (`enforceableLoss`, Utuh's sizing rule), and the desk's total outstanding may not
///      exceed what the attestor quorum for the source chain has bonded (`0x0FD4`, Humanline's rule).
///      `BlankFile` therefore answers but never lends: there is no bond under silence to size against.
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
    IMirrorSpans public immutable MIRROR;
    IAbsenceV3 public immutable REGISTRY;
    /// @notice Where a caller proves it speaks for a source-chain address. Read, never written.
    ISubjectBinding public immutable BINDING;

    /// @notice Most claims under one key the desk will examine looking for bonded cleanliness.
    /// @dev Only `BondedClean` walks, newest first, and only to find a *reason to lend*. Refusals
    ///      come from the registry's aggregates, which no volume of claims can hide. Somebody who
    ///      buries a subject's bonded claim under 64 newer ones gets that subject refused, not paid.
    uint256 public constant MAX_CLAIM_SCAN = 64;

    /// @notice Most spans a caller may offer as proof of one window. Ninety days is five 131,072 seals.
    uint256 public constant MAX_SPANS = 8;

    /// @notice A loan may not exceed this multiple of what a liar could not recover. Utuh's formula.
    uint256 public constant LEVERAGE_ON_ENFORCEABLE_LOSS = 10;

    /// @notice tCTC the desk may have outstanding per CTC the attestor quorum has bonded.
    uint256 public constant EXPOSURE_PER_BONDED_CTC = 1;

    /// @notice Everything lent so far. There is no repayment path, so this only grows -- which is the
    ///         honest way to compare it against a bonded ceiling.
    uint256 public totalOutstanding;

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
        AlreadyLent,
        /// Money against silence. `BlankFile` answers questions; it does not lend, because there is no
        /// bond beneath it to size a loan against.
        NeedsBondedCover,
        /// The desk's outstanding total would exceed what the attestor quorum for this chain has bonded.
        PoolCapReached,
        /// These terms only answer about addresses somebody has proven control of on the source chain.
        /// A Creditcoin wallet with no Ethereum history behind it has nothing here to underwrite, and a
        /// bonded claim that it has never been liquidated on Ethereum is true of every address ever
        /// generated. Requiring the binding is what stops that from being collateral.
        UnprovenSubject
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
        /// @dev Whether the subject must be a source-chain address somebody has proven control of.
        ///      Appended, because the frozen-shape rule applies to interfaces and this is a struct the
        ///      desk owns -- but a policy filed under an older desk cannot be migrated, only re-filed.
        bool requiresBinding;
    }

    Policy[] internal _policies;

    /// @notice borrower => policyId => lent.
    mapping(address => mapping(uint256 => bool)) public lent;

    event PolicyCreated(uint256 indexed policyId, Kind kind, address venue, bytes32 topic0, uint256 minBond);
    event Funded(address indexed from, uint256 amount);
    /// @dev `borrower` is the subject underwritten, which is the caller unless it proved otherwise.
    event Lent(address indexed borrower, uint256 indexed policyId, uint256 principal);

    error NoSuchPolicy();
    error BadPolicy();
    error PrincipalTooLarge();
    error ZeroPrincipal();
    error Rejected(Refusal reason);
    error TransferFailed();

    constructor(IMirrorSpans mirror_, IAbsenceV3 registry_, ISubjectBinding binding_) {
        MIRROR = mirror_;
        REGISTRY = registry_;
        BINDING = binding_;
    }

    /// @notice The address this desk would underwrite if `caller` asked under `policyId`: the caller,
    ///         unless it has proven on chain that it speaks for a source-chain address.
    /// @dev Public because a borrower is entitled to know which record is about to be read about them,
    ///      and because it is the only place the answer is decided.
    function subjectOf(address caller, uint256 policyId) public view returns (address) {
        if (policyId >= _policies.length) return caller;
        return BINDING.subjectFor(caller, _policies[policyId].chainKey);
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
    ///      cannot borrow, whoever is asking. Pass `principal = 0` to ask only what the file says.
    function assess(address subject, uint256 policyId, uint256 principal, uint256[] calldata spanIds)
        external
        view
        returns (bool ok, Refusal reason)
    {
        reason = _assess(subject, policyId, principal, spanIds);
        ok = reason == Refusal.None;
    }

    /// @notice Borrow against your own record. Underwrites `msg.sender`, or the source-chain address
    ///         `msg.sender` has proven it controls -- never one it merely names.
    function borrow(uint256 policyId, uint256 principal, uint256[] calldata spanIds) external {
        if (policyId >= _policies.length) revert NoSuchPolicy();
        if (principal == 0) revert ZeroPrincipal();
        if (principal > _policies[policyId].maxPrincipal) revert PrincipalTooLarge();

        address subject = subjectOf(msg.sender, policyId);
        Refusal reason = _assess(subject, policyId, principal, spanIds);
        if (reason != Refusal.None) revert Rejected(reason);

        // Keyed on the *subject*, not the caller: one record, one loan, however many Creditcoin keys
        // its owner rotates through.
        lent[subject][policyId] = true;
        totalOutstanding += principal;
        emit Lent(subject, policyId, principal);
        (bool sent,) = payable(msg.sender).call{value: principal}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice What the attestor quorum for `chainKey` has bonded, and the exposure the desk allows
    ///         against it. Read live from `0x0FD4` on every decision.
    function securityBudget(uint64 chainKey) public view returns (uint32 attestors, uint128 minBond, uint256 cap) {
        attestors = AttestorStash.get().getAttestorsCount(chainKey);
        minBond = AttestorStash.get().getMinBondRequirement(chainKey);
        cap = (uint256(attestors) * uint256(minBond) * EXPOSURE_PER_BONDED_CTC);
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

    function _assess(address subject, uint256 policyId, uint256 principal, uint256[] calldata spanIds)
        internal
        view
        returns (Refusal)
    {
        if (policyId >= _policies.length) return Refusal.NoSuchPolicy;
        Policy memory p = _policies[policyId];

        if (lent[subject][policyId]) return Refusal.AlreadyLent;
        if (address(this).balance < principal) return Refusal.DeskOutOfFunds;

        // The window, proven once by `sealSpan` and offered here rather than walked. A span cannot be
        // sealed across a hole and a held bit is never unset, so an old seal is still a true statement
        // about its range -- but it must be a *recent* one to describe the head, and long enough to
        // cover the policy's window.
        (bool proven, uint64 spanTo) = _windowProven(p, spanIds);
        // Not a new refusal: spans that do not prove the window mean the same thing they always did --
        // the archive does not demonstrably hold the history this policy answers from.
        if (!proven) return Refusal.ArchiveTooShallow;
        uint64 floor = spanTo - p.window;

        // Terms may insist the subject be a real source-chain address rather than a fresh wallet. The
        // question is asked about the *subject*, not the caller, so the view and the transaction gate
        // on one predicate: `borrow` resolves the caller to a subject first, and an unbound caller
        // resolves to itself, which almost never has a controller.
        if (p.requiresBinding && BINDING.controllerOf(p.chainKey, subject) == address(0)) return Refusal.UnprovenSubject;

        bytes32 key = REGISTRY.keyOf(p.chainKey, p.venue, p.topic0, p.subjectTopic, bytes32(uint256(uint160(subject))));
        (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total) = REGISTRY.recordOf(key);

        // Someone produced the transaction and it verified against a mirrored root, inside the
        // window. The only status backed by cryptography, and it is disqualifying.
        if (refuted != 0 && lastEvidenceAt >= floor) return Refusal.ProvenLiar;
        // Someone listed the event itself, verified at assertion. Also cryptography.
        if (lastMemberAt != 0 && lastMemberAt >= floor) return Refusal.EventOnRecord;
        // Somebody is hunting this address right now. Do not lend into a fight.
        if (open != 0) return Refusal.ClaimUnderHunt;

        // Asking what the file says costs nothing and needs no bond.
        if (principal == 0) return Refusal.None;

        // Money is different. Silence is not collateral, so BlankFile answers and stops here.
        if (p.kind == Kind.BlankFile) return Refusal.NeedsBondedCover;

        (,, uint256 cap) = securityBudget(p.chainKey);
        if (totalOutstanding + principal > cap) return Refusal.PoolCapReached;

        // BondedClean: a standing EmptySet that covers a full window of its own, ends inside this
        // window, and whose unrecoverable half backs the loan at no more than tenfold.
        uint256 need = (principal + LEVERAGE_ON_ENFORCEABLE_LOSS - 1) / LEVERAGE_ON_ENFORCEABLE_LOSS;
        if (need < p.minBond) need = p.minBond;
        uint256 scanned;
        for (uint256 i = total; i > 0 && scanned < MAX_CLAIM_SCAN; ++scanned) {
            uint256 id = REGISTRY.claimUnderKey(key, --i);
            if (REGISTRY.kind(id) != IAbsenceV3.Kind.EmptySet) continue;
            if (!REGISTRY.isUsable(id, need)) continue;
            (,,, uint64 claimFrom, uint64 claimTo) = REGISTRY.assurance(id);
            if (claimTo - claimFrom < p.window) continue;
            if (claimTo < floor) continue;
            if (claimTo + p.maxStaleness < spanTo) continue;
            return Refusal.None;
        }
        return Refusal.NoBondedCleanliness;
    }

    /// @dev The offered spans prove `[spanTo - window, spanTo]` is held with no gap, and `spanTo` is
    ///      close enough to the archive head to still be describing it.
    function _windowProven(Policy memory p, uint256[] calldata spanIds) internal view returns (bool, uint64) {
        if (spanIds.length == 0 || spanIds.length > MAX_SPANS) return (false, 0);
        IMirrorSpans.Span memory first = MIRROR.spanOf(spanIds[0]);
        if (first.chainKey != p.chainKey) return (false, 0);
        uint64 from = first.fromBlock;
        uint64 to = first.toBlock;
        for (uint256 i = 1; i < spanIds.length; ++i) {
            IMirrorSpans.Span memory sp = MIRROR.spanOf(spanIds[i]);
            // Adjacency, not merely order: a one-block hole is exactly what a sealed span rules out.
            if (sp.chainKey != p.chainKey || sp.fromBlock != to + 1) return (false, 0);
            to = sp.toBlock;
        }
        if (to - from < p.window) return (false, 0);
        uint64 head = MIRROR.highestMirrored(p.chainKey);
        if (head == 0 || to > head) return (false, 0);
        // `maxStaleness` is how far below the head a window may end and still be underwritten on.
        if (to + p.maxStaleness < head) return (false, 0);
        return (true, to);
    }
}
