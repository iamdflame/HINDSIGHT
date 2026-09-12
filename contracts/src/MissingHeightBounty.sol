// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EthereumMirror} from "./EthereumMirror.sol";

/// @title MissingHeightBounty
/// @notice Pays whoever fills a hole in the archive, so the archive outlives whoever started it.
///
/// @dev WHY THE BOUNTY PERFORMS THE FILL ITSELF
///
///      The obvious design -- post a reward, let someone notarise the height, let them collect --
///      does not work. `EthereumMirror` records the roots but not who supplied them, so at
///      collection time there is nothing on-chain distinguishing the party who paid the gas from
///      an observer who watched them do it and called `collect` first. The reward would reliably
///      go to a front-runner, and nobody would fill anything.
///
///      So the bounty is the caller of `mirror()`. `fill` takes the proof, forwards it, checks the
///      height actually became held, and pays `msg.sender` in the same transaction. There is no
///      window in which the work is done but unpaid.
///
///      WHY THIS MATTERS BEYOND CONVENIENCE
///
///      An archive that only one funded party extends is that party's archive, and its coverage
///      ends when their interest does. Anyone may call `mirror()` directly and always could; this
///      contract adds the missing half, which is a reason for a stranger to bother. Posting a
///      bounty on a gap is how a consumer who needs a particular window pays for it to exist
///      without asking anyone's permission.
///
///      The reward is escrowed per height, so a bounty that is never filled is never lost -- the
///      poster can withdraw it while the height is still missing, and cannot once it is held.
contract MissingHeightBounty {
    EthereumMirror public immutable MIRROR;

    struct Bounty {
        uint256 amount;
        address poster;
    }

    /// @notice chainKey => height => escrowed reward.
    mapping(uint64 => mapping(uint64 => Bounty)) public bountyFor;

    event BountyPosted(uint64 indexed chainKey, uint64 indexed height, address indexed poster, uint256 amount);
    event BountyIncreased(uint64 indexed chainKey, uint64 indexed height, uint256 newAmount);
    event BountyWithdrawn(uint64 indexed chainKey, uint64 indexed height, address indexed poster, uint256 amount);
    event HeightFilled(uint64 indexed chainKey, uint64 indexed height, address indexed filler, uint256 paid);

    error NothingPosted();
    error AlreadyHeld();
    error NotThePoster();
    error StillMissing();
    error ZeroAmount();
    error TransferFailed();

    constructor(EthereumMirror mirror_) {
        MIRROR = mirror_;
    }

    /// @notice Offer a reward for notarising a specific source-chain height.
    /// @dev Posting on a height that is already held would be an immediate donation to the first
    ///      caller, so it is refused.
    function post(uint64 chainKey, uint64 height) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (MIRROR.isMirrored(chainKey, height)) revert AlreadyHeld();

        Bounty storage b = bountyFor[chainKey][height];
        if (b.amount == 0) {
            bountyFor[chainKey][height] = Bounty({amount: msg.value, poster: msg.sender});
            emit BountyPosted(chainKey, height, msg.sender, msg.value);
        } else {
            // Topping up someone else's bounty is allowed; the original poster keeps the refund
            // right, which is why adding to a stranger's bounty is a donation and is documented
            // as one rather than silently reassigning ownership.
            b.amount += msg.value;
            emit BountyIncreased(chainKey, height, b.amount);
        }
    }

    /// @notice Reclaim a reward, only while the height is still missing.
    function withdraw(uint64 chainKey, uint64 height) external {
        Bounty memory b = bountyFor[chainKey][height];
        if (b.amount == 0) revert NothingPosted();
        if (b.poster != msg.sender) revert NotThePoster();
        if (MIRROR.isMirrored(chainKey, height)) revert AlreadyHeld();

        delete bountyFor[chainKey][height];
        emit BountyWithdrawn(chainKey, height, msg.sender, b.amount);

        (bool sent,) = payable(msg.sender).call{value: b.amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice Notarise a missing height through the mirror and collect the posted reward.
    /// @dev The arguments are exactly `EthereumMirror.mirror`'s. This contract adds no authority
    ///      of its own: if the precompile rejects the proof, the inner call reverts and nothing is
    ///      paid. One continuity proof often covers many heights, so filling one bounty routinely
    ///      fills neighbouring gaps for free -- which is the behaviour that makes the archive
    ///      cheap to complete.
    function fill(
        uint64 chainKey,
        uint64 height,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external {
        Bounty memory b = bountyFor[chainKey][height];
        if (b.amount == 0) revert NothingPosted();
        if (MIRROR.isMirrored(chainKey, height)) revert AlreadyHeld();

        MIRROR.mirror(
            chainKey, blockHeight, encodedTransaction, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );

        // The proof may have been valid yet carried a range that never reached the bountied
        // height. Pay for the hole that was actually filled, not for effort.
        if (!MIRROR.isMirrored(chainKey, height)) revert StillMissing();

        delete bountyFor[chainKey][height];
        emit HeightFilled(chainKey, height, msg.sender, b.amount);

        (bool sent,) = payable(msg.sender).call{value: b.amount}("");
        if (!sent) revert TransferFailed();
    }
}
