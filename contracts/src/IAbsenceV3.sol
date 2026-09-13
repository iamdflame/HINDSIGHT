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
}
