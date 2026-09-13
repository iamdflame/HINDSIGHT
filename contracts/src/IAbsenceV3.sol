// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAbsence} from "./IAbsence.sol";

/// @title IAbsenceV3
/// @notice What the registry learned to say after the first market ran. Extends `IAbsence` and
///         changes nothing in it -- a consumer written against the frozen four functions keeps
///         working, and one that wants the sharper numbers imports this instead.
///
/// @dev The frozen interface is never edited, even to append. Extension is by inheritance, so the
///      file a stranger vendored last month is byte-for-byte the file they can diff today.
interface IAbsenceV3 is IAbsence {
    /// @dev What a claim asserts. `EmptySet`: no matching log in the range. `CompleteSet`: the
    ///      listed members are *all* the matching logs in the range -- nothing was omitted.
    ///      Inclusion proofs cannot express either; both are economic, and both are refuted by
    ///      one transaction the claimant did not account for.
    enum Kind {
        EmptySet,
        CompleteSet
    }

    /// @notice Which of the two statements a claim makes.
    function kind(uint256 claimId) external view returns (Kind);

    /// @notice The part of the bond a liar cannot get back.
    /// @dev Half of every refuted bond is burned. Without that, a claimant could refute their own
    ///      false claim from a second address and walk away whole, and "bonded" would mean nothing.
    ///      This is the number a consumer should size exposure against -- not the headline bond,
    ///      because the headline bond is what the *refuter* receives, not what the liar loses.
    function enforceableLoss(uint256 claimId) external view returns (uint256);

    /// @notice Whether a claim stands *and* a false version of it would have cost its author at
    ///         least `exposure`.
    /// @dev The call an underwriter should make. `holdsWithBond` compares against what was staked;
    ///      this compares against what would be unrecoverable, which is the honest ceiling on how
    ///      much anyone should rely on the statement.
    function isUsable(uint256 claimId, uint256 exposure) external view returns (bool);

    /// @notice For a `CompleteSet` claim, how many members it enumerated. Zero for `EmptySet`.
    function memberCount(uint256 claimId) external view returns (uint256);

    /// @notice The index key for every claim about one subject, at one venue, for one event, on
    ///         one chain, read through one topic slot.
    /// @dev All five are part of the key because each one changes what a claim *means*. A claim
    ///      read through topic 1 of `LiquidationCall` is about a collateral asset, not a borrower;
    ///      a claim over Sepolia says nothing about mainnet. A consumer that matched on subject
    ///      alone could be handed a true statement about the wrong thing. When `subjectTopic` is
    ///      zero the claim constrains no subject, and the registry stores the subject as zero.
    function keyOf(uint64 chainKey, address venue, bytes32 topic0, uint8 subjectTopic, bytes32 subject)
        external
        pure
        returns (bytes32);

    /// @notice What is on record under a key, kept as running aggregates so that no consumer has to
    ///         walk the claim list -- and so that nobody can hide a refutation by filing a thousand
    ///         claims in front of it.
    /// @return open             claims under this key still `Open`. Includes claims whose window has
    ///                          closed but that nobody has finalised yet; `finalize` is permissionless.
    /// @return refuted          claims under this key that were refuted.
    /// @return lastEvidenceAt   the highest source-chain height at which refuting evidence sits, zero
    ///                          if nothing was ever refuted. Evidence always matches the subject.
    /// @return lastMemberAt     the highest height of any member a `CompleteSet` under this key listed
    ///                          -- each verified against the mirror at assertion -- zero if none.
    /// @return total            claims ever filed under this key.
    function recordOf(bytes32 key)
        external
        view
        returns (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total);

    /// @notice The `index`-th claim filed under `key`, oldest first; `index < total`.
    function claimUnderKey(bytes32 key, uint256 index) external view returns (uint256 claimId);
}
