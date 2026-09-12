// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAbsence
/// @notice The read surface a consumer uses to price a claim that something did *not* happen.
///
/// @dev Read this before integrating, because the thing on the other side of this interface is
///      not a proof.
///
///      Inclusion proofs prove presence. There is no Merkle path for an event that never
///      occurred, and no amount of Attestcoin makes one exist. So absence here is an economic
///      instrument, not a cryptographic one, and the interface is shaped to stop a caller
///      forgetting that: there is no `isClean(address)`, because a boolean would launder a bond
///      into a fact.
///
///      A claim in `Standing` means exactly this, and nothing more:
///
///          nobody refuted it within its window, over a gap-free sealed range,
///          while a named bond was at risk.
///
///      That is a statement about how much someone was willing to lose, and for how long. A
///      consumer that wants it to mean more should require a larger bond, not a different
///      interface. `holdsWithBond` exists so that requirement is expressed in code rather than
///      assumed.
///
///      `Refuted` is the only status backed by cryptography: somebody produced the transaction,
///      and it verified against a held root. A refuted claim is a proven lie. A standing claim is
///      an unchallenged assertion. Rendering them the same way is a product bug.
interface IAbsence {
    /// @dev Values are stable and must not be reordered; consumers compare against them on-chain.
    ///      `None` is the zero value so an unset claim is never mistaken for a live one.
    enum Status {
        None,
        Open,
        Refuted,
        Standing
    }

    /// @notice Everything needed to price a claim, in one call.
    /// @param claimId The claim to read.
    /// @return status Current status. `Open` means someone may still be hunting it.
    /// @return bond Amount currently escrowed, in wei. Zero once the claim has paid out.
    /// @return openUntil Unix timestamp after which the claim may be finalised.
    /// @return spanFrom First source-chain height the claim covers.
    /// @return spanTo Last source-chain height the claim covers.
    function assurance(uint256 claimId)
        external
        view
        returns (Status status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo);

    /// @notice Whether a claim stands *and* was backed by at least `minBond`.
    /// @dev The bond compared is the amount originally staked, not the live escrow, so a claim
    ///      does not appear cheaper after it has paid out. This is the call an underwriter should
    ///      make: it forces the caller to name the price of the lie it is willing to tolerate.
    function holdsWithBond(uint256 claimId, uint256 minBond) external view returns (bool);

    /// @notice Whether a claim stands at all, at any bond.
    /// @dev Deliberately weak. Prefer `holdsWithBond`.
    function holds(uint256 claimId) external view returns (bool);

    /// @notice Number of claims ever asserted.
    function claimCount() external view returns (uint256);
}
