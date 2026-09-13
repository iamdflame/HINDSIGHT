// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMirror} from "../src/IMirror.sol";
import {IAbsence} from "../src/IAbsence.sol";

/// @title ThrowawayDesk
/// @notice A second consumer, written against nothing but `IMirror` and `IAbsence`.
///
/// @dev This contract exists to prove a negative about the architecture: that the file Hindsight
///      publishes is readable by someone who has never seen this repository's contracts. It
///      imports no concrete type, holds no reference to `EthereumMirror` or `AbsenceRegistryV3`,
///      and could be compiled against the interfaces alone.
///
///      If a future change to the main desk makes this one stop compiling, the interfaces were not
///      actually frozen and the "become the standard" claim is hollow. That is the test.
contract ThrowawayDesk {
    IMirror public immutable MIRROR;
    IAbsence public immutable ABSENCE;

    error NotCovered();
    error NotBonded();

    constructor(IMirror mirror_, IAbsence absence_) {
        MIRROR = mirror_;
        ABSENCE = absence_;
    }

    /// @notice The whole integration: is this height answerable, and does this claim hold at a
    ///         price I am willing to rely on?
    function wouldLend(uint64 chainKey, uint64 height, uint256 claimId, uint256 minBond)
        external
        view
        returns (bool)
    {
        if (!MIRROR.isMirrored(chainKey, height)) revert NotCovered();
        if (!ABSENCE.holdsWithBond(claimId, minBond)) revert NotBonded();
        return true;
    }

    /// @notice Reading a claim's terms without needing the registry's concrete type.
    function terms(uint256 claimId)
        external
        view
        returns (IAbsence.Status status, uint256 bond, uint64 openUntil, uint64 from, uint64 to)
    {
        return ABSENCE.assurance(claimId);
    }
}
