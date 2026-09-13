// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAttestorStash
/// @notice The two questions a lender should ask the attestation layer before it lends: how many
///         attestors stand behind a source chain, and what each of them has bonded.
///
/// @dev The precompile lives at `0x0FD4` and is read-only. Measured on CC3 on 2026-09-13 for
///      `chainKey 3`: four attestors, 100 CTC minimum bond each.
///
///      The idea of capping a credit pool by that number is Humanline's (`CreditLine.sol`,
///      `securityBudget()`), and it is a good one: every fact this desk underwrites on rests on the
///      attestor quorum for the source chain, so the money at risk should not exceed what that quorum
///      has at stake. This is that cap, on a desk whose facts are historical rather than live.
interface IAttestorStash {
    /// @notice How many attestors are bonded for `chainKey`.
    function getAttestorsCount(uint64 chainKey) external view returns (uint32 count);

    /// @notice The minimum bond each attestor for `chainKey` must post, in wei.
    function getMinBondRequirement(uint64 chainKey) external view returns (uint128 minBond);
}

library AttestorStash {
    address internal constant PRECOMPILE = address(0x0fd4);

    function get() internal pure returns (IAttestorStash) {
        return IAttestorStash(PRECOMPILE);
    }
}
