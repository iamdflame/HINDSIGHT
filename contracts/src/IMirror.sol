// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @title IMirror
/// @notice The import every other Attestcoin dApp on Creditcoin should be using.
///
/// @dev What this buys a caller.
///
///      An Attestcoin readability query costs one hash per block of continuity walked, and the
///      continuity lengthens as the transaction ages. Against a height already held by a mirror,
///      the same transaction verifies from a Merkle path alone: a `view` call, at a fixed cost,
///      with neither the hosted prover nor the block-prover precompile in the loop.
///
///      Integrating is one call. Instead of building a continuity proof and paying
///      `0x0FD2.verify`, hold this interface and ask:
///
///      ```solidity
///      uint64 index = IMirror(MIRROR).verifyOrRevert(3, height, txBytes, siblings);
///      ```
///
///      This interface is frozen. The address it is bound to may change; these signatures may not.
///
/// @dev On the two verification forms.
///
///      `verifyOrRevert` is the one to reach for. It matches the precompile's fail-closed habit:
///      a transaction that is not in the block does not return a value, it reverts. `tryVerify`
///      exists for callers that genuinely need to branch on the answer, and returning `false`
///      where a caller expected a revert is a well-known footgun -- so the two are kept separate
///      and the reverting form is the default. This split must never be reversed.
///
/// @dev What this interface deliberately does not offer.
///
///      No state or storage proofs: Attestcoin proves transaction inclusion, not account state,
///      so no implementation of this interface can tell you a balance at a height. No writes back
///      to the source chain. No notion of a transaction having *not* happened -- inclusion proofs
///      cannot express that, and pretending otherwise is the mistake this project exists to avoid.
///      For negatives, see `IAbsence`, which is an economic instrument and says so.
interface IMirror {
    /// @notice Transaction Merkle root held for a source-chain height, or zero if not held.
    /// @dev Zero is indistinguishable from "a block whose root really is zero", which cannot occur
    ///      for any block containing transactions. Prefer `isMirrored` for an existence question.
    function rootOf(uint64 chainKey, uint64 height) external view returns (bytes32);

    /// @notice Whether a height is held, and so answerable without the prover or the precompile.
    function isMirrored(uint64 chainKey, uint64 height) external view returns (bool);

    /// @notice Highest source-chain height held for a chain.
    function highestMirrored(uint64 chainKey) external view returns (uint64);

    /// @notice Lowest source-chain height held for a chain.
    function lowestMirrored(uint64 chainKey) external view returns (uint64);

    /// @notice Count of distinct heights held for a chain.
    function mirroredBlocks(uint64 chainKey) external view returns (uint64);

    /// @notice Verify a transaction against a held root, reverting if it does not belong.
    /// @return txIndex The transaction's index within its block, recovered from the path shape.
    function verifyOrRevert(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (uint64 txIndex);

    /// @notice Non-reverting form of `verifyOrRevert`.
    /// @dev Must never revert for a malformed path; it reports `false`. A caller that wants the
    ///      fail-closed behaviour should use `verifyOrRevert`.
    function tryVerify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external view returns (bool valid, uint64 txIndex);

    /// @notice Length of the gap-free run of held heights starting at `fromBlock`.
    /// @dev Costs one SLOAD per block walked, so `maxScan` bounds it. A run is what makes an
    ///      absence question answerable: a gap is exactly where a disproving transaction hides.
    function contiguousFrom(uint64 chainKey, uint64 fromBlock, uint64 maxScan)
        external
        view
        returns (uint64 span);

    /// @notice Whether a sealed span covers a given height.
    function spanCovers(uint256 spanId, uint64 chainKey, uint64 height) external view returns (bool);

    /// @notice Number of sealed spans.
    function spanCount() external view returns (uint256);
}
