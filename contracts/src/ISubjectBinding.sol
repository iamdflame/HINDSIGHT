// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISubjectBinding
/// @notice The one question a lender needs to ask about who a caller speaks for.
///
/// @dev A consumer holds this interface, not the contract: the binding contract can be replaced, and
///      a lender that imported the implementation would have to be replaced with it. `subjectFor`
///      never returns an address the caller has not proven control of, so passing its result straight
///      into a refusal check cannot launder a record -- which is the property that lets a desk accept
///      a subject at all.
interface ISubjectBinding {
    /// @notice The source-chain address `controller` has proven it speaks for, or `controller` itself.
    function subjectFor(address controller, uint64 chainKey) external view returns (address);

    /// @notice Who currently speaks for `subject` on `chainKey`, or zero if nobody has proven it.
    /// @dev The symmetric half, and the one a `view` needs: `subjectFor` answers about a caller, which
    ///      a public assessment of an arbitrary address does not have. Asking whether the subject has
    ///      *any* controller keeps the view and the transaction gating on the same predicate.
    function controllerOf(uint64 chainKey, address subject) external view returns (address);
}
