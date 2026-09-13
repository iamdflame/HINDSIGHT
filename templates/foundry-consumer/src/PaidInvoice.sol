// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMirror} from "hindsight/IMirror.sol";
import {IAbsenceV3} from "hindsight/IAbsenceV3.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @title PaidInvoice
/// @notice The smallest honest consumer: "this ERC-20 transfer happened on Ethereum" as a fact this
///         contract can act on, with no prover, no precompile and no oracle in the call path.
///
/// @dev Two imports, both frozen interfaces. `IMirror.verifyOrRevert` answers inclusion from a root
///      Creditcoin already holds -- a `view`, so a block held once is answerable forever for anyone.
///      `IAbsenceV3.isUsable` is the economic half: whether somebody has staked enough on a *negative*
///      ("no chargeback happened") for this contract to rely on it, sized against what a liar could
///      not recover rather than the headline bond. Neither is a score.
///
///      The five checks a consumer owes itself before acting are in the test file, each named; this
///      contract does the two that belong on chain (status and replay) and leaves depth, clock and
///      stall to the caller, because only the caller knows how much of each it can bear.
contract PaidInvoice {
    IMirror public immutable MIRROR;
    IAbsenceV3 public immutable REGISTRY;
    uint64 public immutable CHAIN_KEY;

    bytes32 private constant TRANSFER = keccak256("Transfer(address,address,uint256)");

    /// @dev (height, txIndex, logIndex) => counted. The replay key: the same leaf is never paid twice.
    mapping(bytes32 => bool) public counted;
    mapping(address token => mapping(address from => mapping(address to => uint256))) public paid;

    event Counted(address indexed token, address indexed from, address indexed to, uint256 amount, uint64 height, uint64 txIndex, uint32 logIndex);

    error NotATransfer();
    error TransactionReverted();
    error AlreadyCounted(uint64 height, uint64 txIndex, uint32 logIndex);

    constructor(IMirror mirror_, IAbsenceV3 registry_, uint64 chainKey) {
        MIRROR = mirror_;
        REGISTRY = registry_;
        CHAIN_KEY = chainKey;
    }

    /// @notice Prove a transfer and count it. Anyone may call; the proof decides, not the caller.
    function prove(uint64 height, bytes calldata encodedTransaction, INativeQueryVerifier.MerkleProofEntry[] calldata siblings, uint32 logIndex)
        external
        returns (uint256 amount)
    {
        // Fails closed: not in a held block, or not in the block at all, and this reverts.
        uint64 txIndex = MIRROR.verifyOrRevert(CHAIN_KEY, height, encodedTransaction, siblings);

        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (r.receiptStatus != 1) revert TransactionReverted();
        EvmV1Decoder.LogEntry memory log = r.receiptLogs[logIndex];
        if (log.topics.length != 3 || log.topics[0] != TRANSFER) revert NotATransfer();

        bytes32 key = keccak256(abi.encode(CHAIN_KEY, height, txIndex, logIndex));
        if (counted[key]) revert AlreadyCounted(height, txIndex, logIndex);
        counted[key] = true;

        address from = address(uint160(uint256(log.topics[1])));
        address to = address(uint160(uint256(log.topics[2])));
        amount = abi.decode(log.data, (uint256));
        paid[log.address_][from][to] += amount;
        emit Counted(log.address_, from, to, amount, height, txIndex, logIndex);
    }

    /// @notice Whether at least `amount` has been proven paid, token from `from` to `to`.
    function paidAtLeast(address token, address from, address to, uint256 amount) external view returns (bool) {
        return paid[token][from][to] >= amount;
    }

    /// @notice Whether a standing claim on the registry can carry `exposure` of reliance. Economic.
    function negativeUsable(uint256 claimId, uint256 exposure) external view returns (bool) {
        return REGISTRY.isUsable(claimId, exposure);
    }
}
