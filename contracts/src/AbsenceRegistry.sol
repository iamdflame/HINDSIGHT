// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {EthereumMirror} from "./EthereumMirror.sol";

/// @title AbsenceRegistry
/// @notice Makes statements of the form "this did *not* happen on Ethereum" economically checkable.
///
/// @dev THE PROBLEM
///
///      Cross-chain verification proves that something happened. Nothing proves that something did
///      not. A borrower submits proofs of their repayments and omits the proof of their
///      liquidation, and no contract on any chain can tell the difference. Every cross-chain
///      credit, insurance and solvency design inherits this hole and plugs it by trusting an
///      indexer -- at which point the indexer, not the chain, is the source of truth.
///
///      WHY NOT PROVE IT CRYPTOGRAPHICALLY
///
///      Direct proof of absence means enumerating every transaction in every block of a range and
///      showing none matches. Ethereum blocks hold hundreds of transactions; the cost is
///      O(transactions) and the result expires the moment the range grows.
///
///      WHAT THIS CONTRACT ACTUALLY DOES -- STATED EXACTLY
///
///      It never proves absence. It runs a market in which asserting a false absence loses money.
///      Because `EthereumMirror` makes *positive* facts permissionless and cheap to prove, a
///      single counterexample is always cheap to produce:
///
///        assert   O(1)      claimant stakes a bond over a sealed, gap-free span
///        refute   O(log n)  anyone produces one contradicting transaction and takes the bond
///        finalise O(1)      unrefuted when the window closes, the statement is recorded as such
///
///      A claim in `Standing` DOES NOT MEAN the event never happened. It means precisely: no one
///      refuted it within its window, over one span, while a named bond was at risk. Consumers
///      must read `assurance()` and decide whether that bond is large enough for their exposure.
///      `holds()` is named for "the claim still holds", never for "this is true".
///
///      FRONT-RUNNING, AND WHY THERE IS NO DIRECT REFUTE
///
///      A one-shot `refute(claimId, block, txBytes, siblings)` puts every piece of evidence in
///      public calldata. Any searcher copies it and resubmits with a higher fee, so the bounty is
///      stolen rather than earned -- and if bounties cannot be earned, nobody hunts, and the whole
///      incentive argument collapses. An earlier version of this contract had exactly that bug.
///      Refutation is therefore commit-reveal only, and the commitment binds `msg.sender` so a
///      copied commitment is worthless to the copier. The unsafe single-call path was removed
///      rather than kept as a convenience, because a footgun beside a safe path is still a footgun.
contract AbsenceRegistry {
    EthereumMirror public immutable MIRROR;

    /// @notice Minimum bond. Must comfortably exceed the gas cost of refuting, or rational
    ///         watchdogs never bother and an unrefuted claim carries no information.
    ///         Measured refutation cost is ~300k gas; at 0.5 gwei that is ~1.5e-4 CTC, so this
    ///         leaves roughly two orders of magnitude of headroom. Asserted in the test suite.
    uint256 public constant MIN_BOND = 0.01 ether;

    /// @notice Shortest permitted challenge window. Deliberately modest so the mechanism can be
    ///         exercised end-to-end; a production deployment should use days, not minutes, and
    ///         consumers should read `openUntil` rather than assume.
    uint64 public constant MIN_WINDOW = 15 minutes;

    /// @notice A commitment must age at least this many blocks before it can be revealed, so that
    ///         evidence revealed in a reveal transaction cannot be reused by an observer.
    uint256 public constant COMMIT_DELAY_BLOCKS = 1;

    enum Status {
        None,
        Open,
        Refuted,
        Standing
    }

    struct Claim {
        address claimant;
        address refuter;
        uint256 spanId;
        uint64 chainKey;
        address venue;
        bytes32 topic0;
        bytes32 subject;
        uint8 subjectTopic;
        // Span bounds are snapshotted at assertion time, never read live. `extendSpan` is
        // permissionless, so a live read would let anyone widen a claim's scope after the fact and
        // drag a counterexample into range -- stealing the bond of a claimant whose statement was
        // true when they made it. What was staked is what is judged.
        uint64 spanFrom;
        uint64 spanTo;
        uint256 bond;       // live escrow; zeroed when paid out
        uint256 bondStaked; // what was put at risk; never mutated, so consumers can price trust
        uint64 openUntil;
        Status status;
    }

    Claim[] internal _claims;

    /// @notice commitment => block number at which it was recorded.
    mapping(bytes32 => uint256) public commitmentBlock;

    event AbsenceAsserted(
        uint256 indexed claimId,
        address indexed claimant,
        uint256 indexed spanId,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint256 bond,
        uint64 openUntil
    );
    event RefutationCommitted(bytes32 indexed commitment, address indexed by, uint256 atBlock);
    event AbsenceRefuted(
        uint256 indexed claimId, address indexed refuter, uint64 blockNumber, uint64 txIndex, uint256 bondPaid
    );
    event AbsenceStands(uint256 indexed claimId, address indexed claimant, uint256 bondReturned);

    error BondTooSmall();
    error WindowTooShort();
    error NoSuchClaim();
    error ClaimNotOpen();
    error WindowClosed();
    error WindowStillOpen();
    error BlockOutsideSpan();
    error TransactionFailed();
    error NoContradictionFound();
    error BadSubjectTopic();
    error TransferFailed();
    error AlreadyCommitted();
    error NoCommitment();
    error CommitmentTooFresh();

    constructor(EthereumMirror mirror_) {
        MIRROR = mirror_;
    }

    // -------------------------------------------------------------------------------------------
    // Asserting
    // -------------------------------------------------------------------------------------------

    /// @notice Stake a bond on the statement that across every block of `spanId`, contract `venue`
    ///         emitted no log matching `topic0` (and `subject`, when constrained).
    /// @param subjectTopic Which indexed topic slot must equal `subject` (1-3), or 0 to match any
    ///        log of that signature regardless of indexed parameters.
    function assertAbsence(
        uint256 spanId,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 subjectTopic,
        uint64 window
    ) external payable returns (uint256 claimId) {
        if (msg.value < MIN_BOND) revert BondTooSmall();
        if (window < MIN_WINDOW) revert WindowTooShort();
        if (subjectTopic > 3) revert BadSubjectTopic();

        // Reverts unless the span exists; also fixes which chain the claim is about.
        EthereumMirror.Span memory sp = MIRROR.spanOf(spanId);

        claimId = _claims.length;
        _claims.push(
            Claim({
                claimant: msg.sender,
                refuter: address(0),
                spanId: spanId,
                chainKey: sp.chainKey,
                venue: venue,
                topic0: topic0,
                subject: subject,
                subjectTopic: subjectTopic,
                spanFrom: sp.fromBlock,
                spanTo: sp.toBlock,
                bond: msg.value,
                bondStaked: msg.value,
                openUntil: uint64(block.timestamp) + window,
                status: Status.Open
            })
        );

        emit AbsenceAsserted(
            claimId, msg.sender, spanId, venue, topic0, subject, msg.value, uint64(block.timestamp) + window
        );
    }

    // -------------------------------------------------------------------------------------------
    // Refuting: commit, then reveal
    // -------------------------------------------------------------------------------------------

    /// @notice Compute the commitment for a refutation. Pure, so it can be called off-chain.
    /// @dev Binding `refuter` is what defeats copying: an observer who lifts the commitment from
    ///      the mempool cannot produce a reveal that hashes to it, because the sender differs.
    function commitmentFor(
        uint256 claimId,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 salt,
        address refuter
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(claimId, blockNumber, encodedTransaction, siblings, salt, refuter));
    }

    /// @notice Record the intent to refute. Reveals nothing about the evidence.
    function commitRefutation(bytes32 commitment) external {
        if (commitmentBlock[commitment] != 0) revert AlreadyCommitted();
        commitmentBlock[commitment] = block.number;
        emit RefutationCommitted(commitment, msg.sender, block.number);
    }

    /// @notice Reveal the evidence and take the bond.
    /// @dev Costs a Merkle path verification against mirrored history plus a receipt decode. No
    ///      continuity proof and no proving service are involved, which is what keeps refutation
    ///      cheap regardless of how old the block is -- and therefore keeps the incentive credible.
    function revealRefutation(
        uint256 claimId,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 salt
    ) external {
        bytes32 commitment = commitmentFor(claimId, blockNumber, encodedTransaction, siblings, salt, msg.sender);
        uint256 committedAt = commitmentBlock[commitment];
        if (committedAt == 0) revert NoCommitment();
        if (block.number < committedAt + COMMIT_DELAY_BLOCKS) revert CommitmentTooFresh();

        Claim storage c = _claimAt(claimId);
        if (c.status != Status.Open) revert ClaimNotOpen();
        if (block.timestamp > c.openUntil) revert WindowClosed();

        // Evidence must lie inside the span *as it stood when the claim was made*. Outside it, the
        // claim said nothing, so the transaction is not a contradiction.
        if (blockNumber < c.spanFrom || blockNumber > c.spanTo) revert BlockOutsideSpan();

        // Reverting form on purpose: a forged proof must take this transaction down, never return
        // a falsy value that a future refactor could forget to check.
        uint64 txIndex = MIRROR.verifyOrRevert(c.chainKey, blockNumber, encodedTransaction, siblings);

        // The block prover certifies inclusion, never success. A reverted transaction is not
        // evidence of anything.
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();

        if (!_contradicts(c, receipt)) revert NoContradictionFound();

        c.status = Status.Refuted;
        c.refuter = msg.sender;
        uint256 bond = c.bond;
        c.bond = 0;

        emit AbsenceRefuted(claimId, msg.sender, blockNumber, txIndex, bond);

        (bool sent,) = payable(msg.sender).call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice After the window closes unrefuted, record that fact and return the bond.
    /// @dev This records that nobody refuted. It does not record that the event never occurred.
    function finalize(uint256 claimId) external {
        Claim storage c = _claimAt(claimId);
        if (c.status != Status.Open) revert ClaimNotOpen();
        if (block.timestamp <= c.openUntil) revert WindowStillOpen();

        c.status = Status.Standing;
        uint256 bond = c.bond;
        c.bond = 0;

        emit AbsenceStands(claimId, c.claimant, bond);

        (bool sent,) = payable(c.claimant).call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    // -------------------------------------------------------------------------------------------
    // Matching
    // -------------------------------------------------------------------------------------------

    /// @dev Conservative by construction: emitting contract, event signature and (when
    ///      constrained) the indexed subject must all line up. A lookalike contract emitting the
    ///      same signature does not refute a claim about a real venue.
    function _contradicts(Claim storage c, EvmV1Decoder.ReceiptFields memory receipt) internal view returns (bool) {
        EvmV1Decoder.LogEntry[] memory logs = receipt.receiptLogs;
        address venue = c.venue;
        bytes32 topic0 = c.topic0;
        bytes32 subject = c.subject;
        uint8 slot = c.subjectTopic;

        for (uint256 i; i < logs.length; ++i) {
            EvmV1Decoder.LogEntry memory lg = logs[i];
            if (lg.topics.length == 0) continue;
            if (venue != address(0) && lg.address_ != venue) continue;
            if (lg.topics[0] != topic0) continue;
            if (slot != 0) {
                if (lg.topics.length <= slot) continue;
                if (lg.topics[slot] != subject) continue;
            }
            return true;
        }
        return false;
    }

    // -------------------------------------------------------------------------------------------
    // Reading -- consumers should prefer assurance() or holdsWithBond()
    // -------------------------------------------------------------------------------------------

    /// @notice Everything a consumer needs to price their trust in a claim.
    /// @return status     Open, Refuted or Standing.
    /// @return bond       Collateral that was at risk. A large statement backed by a small bond is
    ///                    weak evidence, and this is the field that reveals it.
    /// @return openUntil  When the challenge window closed, or closes.
    /// @return spanFrom   First source-chain block the statement covers.
    /// @return spanTo     Last source-chain block the statement covers. It says nothing outside this.
    function assurance(uint256 claimId)
        external
        view
        returns (Status status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)
    {
        Claim storage c = _claimAt(claimId);
        return (c.status, c.bondStaked, c.openUntil, c.spanFrom, c.spanTo);
    }

    /// @notice True when the claim survived its window AND at least `minBond` was at risk.
    /// @dev The form consumers should use. A claim backed by dust is not worth relying on, however
    ///      confidently it is phrased.
    function holdsWithBond(uint256 claimId, uint256 minBond) external view returns (bool) {
        Claim storage c = _claimAt(claimId);
        return c.status == Status.Standing && c.bondStaked >= minBond;
    }

    /// @notice Whether the claim was never refuted within its window.
    /// @dev NOT a statement that the event did not occur. See the contract-level notes.
    function holds(uint256 claimId) external view returns (bool) {
        return _claimAt(claimId).status == Status.Standing;
    }

    function claimOf(uint256 claimId) external view returns (Claim memory) {
        return _claimAt(claimId);
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    function _claimAt(uint256 claimId) internal view returns (Claim storage) {
        if (claimId >= _claims.length) revert NoSuchClaim();
        return _claims[claimId];
    }
}
