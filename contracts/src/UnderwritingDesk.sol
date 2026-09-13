// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMirror} from "./IMirror.sol";
import {IAbsence} from "./IAbsence.sol";
import {AbsenceRegistryV3} from "./AbsenceRegistryV3.sol";

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
///      If the archive does not cover the policy's window, the desk refuses: an answer drawn from
///      history it does not hold is not an answer. If there are more claims than it is willing to
///      walk, it refuses rather than sampling. Refusing on incapacity is the only safe direction
///      for a lender, and it is the direction most credit-file designs get wrong.
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
    AbsenceRegistryV3 public immutable REGISTRY;

    /// @notice Most registry claims the desk will walk before refusing outright.
    /// @dev A lender that cannot see every claim about an address must not lend to it. Sampling
    ///      would make the refusal probabilistic, which is the same as not having one.
    uint256 public constant MAX_CLAIM_SCAN = 512;

    enum Kind {
        BlankFile,
        BondedClean
    }

    /// @dev Why a decision went the way it did. Returned rather than thrown by `assess`, so the
    ///      interface can render the reason instead of a bare failure.
    enum Refusal {
        None,
        NoSuchPolicy,
        ArchiveTooShallow,
        ClaimUnderHunt,
        ProvenLiar,
        NoBondedCleanliness,
        DeskOutOfFunds
    }

    struct Policy {
        Kind kind;
        uint64 chainKey;
        /// @dev How many blocks of mirrored history the desk insists on before answering at all.
        ///      The production policy is 648,000 -- ninety days of Ethereum at 12s -- and the desk
        ///      refuses `ArchiveTooShallow` until the archive really holds that much.
        uint64 window;
        address venue;
        bytes32 topic0;
        /// @dev Which indexed topic carries the subject, matching the registry's convention.
        uint8 subjectTopic;
        /// @dev Only meaningful for `BondedClean`: the price of the lie the desk will tolerate.
        uint256 minBond;
        uint256 maxPrincipal;
    }

    Policy[] internal _policies;

    event PolicyCreated(uint256 indexed policyId, Kind kind, address venue, bytes32 topic0, uint256 minBond);
    event Funded(address indexed from, uint256 amount);
    event Lent(address indexed borrower, uint256 indexed policyId, uint256 principal);
    event Refused(address indexed borrower, uint256 indexed policyId, Refusal reason);

    error NoSuchPolicy();
    error PrincipalTooLarge();
    error Rejected(Refusal reason);
    error TransferFailed();

    constructor(IMirror mirror_, AbsenceRegistryV3 registry_) {
        MIRROR = mirror_;
        REGISTRY = registry_;
    }

    /// @notice Anyone may define a policy. There is no admin, and no policy can mark an address
    ///         eligible -- a policy only decides which public facts are consulted.
    function createPolicy(Policy calldata p) external returns (uint256 policyId) {
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
        if (principal > _policies[policyId].maxPrincipal) revert PrincipalTooLarge();

        Refusal reason = _assess(msg.sender, policyId, principal);
        if (reason != Refusal.None) {
            emit Refused(msg.sender, policyId, reason);
            revert Rejected(reason);
        }

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

        if (address(this).balance < principal) return Refusal.DeskOutOfFunds;

        // An answer drawn from history the archive does not hold is not an answer.
        uint64 head = MIRROR.highestMirrored(p.chainKey);
        uint64 low = MIRROR.lowestMirrored(p.chainKey);
        if (head == 0 || head < p.window || head - p.window < low) return Refusal.ArchiveTooShallow;

        bytes32 wanted = bytes32(uint256(uint160(subject)));
        uint256 n = REGISTRY.claimCount();
        if (n > MAX_CLAIM_SCAN) return Refusal.ClaimUnderHunt; // cannot see everything: do not lend

        bool bondedClean = false;

        for (uint256 i; i < n; ++i) {
            AbsenceRegistryV3.Claim memory c = REGISTRY.claimOf(i);
            if (c.subject != wanted) continue;
            if (c.venue != p.venue || c.topic0 != p.topic0) continue;

            if (c.status == IAbsence.Status.Refuted) {
                // Someone produced the transaction and it verified against a mirrored root. This
                // is the only status backed by cryptography, and it is disqualifying.
                return Refusal.ProvenLiar;
            }
            if (c.status == IAbsence.Status.Open) {
                // Somebody is hunting this address right now. Do not lend into a fight.
                return Refusal.ClaimUnderHunt;
            }
            // `isUsable` is the registry's own statement of "stood, and a lie would have cost at
            // least this". Sized against the *principal*, not the policy's nominal minBond: the
            // desk relies on the claim exactly as far as the liar would have lost, and no further.
            // The window check is the desk's own. A consumer written against IAbsenceV3 alone
            // reaches the same verdict.
            if (REGISTRY.isUsable(i, principal > p.minBond ? principal : p.minBond)) {
                if (c.spanTo >= head - p.window && c.spanFrom <= head) bondedClean = true;
            }
        }

        if (p.kind == Kind.BondedClean && !bondedClean) return Refusal.NoBondedCleanliness;

        return Refusal.None;
    }
}
