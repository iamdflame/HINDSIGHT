// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMirror} from "./IMirror.sol";

/// @title IMirrorSpans
/// @notice The sealed-span half of a mirror, for consumers that would rather read a proof than redo it.
///
/// @dev `IMirror` is frozen and is never edited, even to append -- so this extends it by inheritance,
///      exactly as `IAbsenceV3` extends `IAbsence`. A contract written against the frozen four keeps
///      working; one that wants to price a window cheaply imports this instead.
///
///      Why a consumer wants it: proving that a range of history is gap-free costs one storage read per
///      256 blocks, and `sealSpan` already paid that once and recorded the answer. Reading the seal is a
///      handful of slots. Walking the bitmap again for ninety days is 7.03M gas, which is a lender
///      nobody uses.
interface IMirrorSpans is IMirror {
    /// @dev Identical in layout and encoding to `EthereumMirror.Span`.
    struct Span {
        uint64 chainKey;
        uint64 fromBlock;
        uint64 toBlock;
    }

    /// @notice The range a sealed span covers. Reverts if the span does not exist.
    function spanOf(uint256 spanId) external view returns (Span memory);
}
