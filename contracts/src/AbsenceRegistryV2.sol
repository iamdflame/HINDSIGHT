// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {EthereumMirror} from "./EthereumMirror.sol";
import {IAbsence} from "./IAbsence.sol";

/// @title AbsenceRegistryV2
/// @notice Makes statements of the form "this did *not* happen on Ethereum" economically checkable,
///         over ranges long enough to be worth making.
///
/// @dev WHAT CHANGED FROM V1, AND WHY IT NEEDED A NEW DEPLOYMENT
///
///      V1 bound each claim to a single sealed span. Sealing walks one SLOAD per block and is
///      capped at `MAX_SEAL_WINDOW` (5,000), so one span is at most ~17 hours of Ethereum. Every
///      interesting credit question is asked over a week or a month, and "no liquidation in the
///      last 17 hours" is not a question anyone is underwriting against.
///
///      A claim here binds a *list* of spans, required to be adjacent and gap-free, so a week is
///      one claim over eleven spans rather than eleven claims nobody can compose. That is an ABI
///      change to the one function every consumer calls, which is why it is a redeploy rather than
///      a migration -- done once, before the market has volume, exactly as intended.
///
///      The mirror is untouched: V2 points at the same `EthereumMirror`, so the archive and every
///      root in it carry over intact.
///
///      WHY ADJACENCY IS THE WHOLE GAME
///
///      A gap between two spans is a place a disproving transaction can sit unseen, which would
///      let a false claim stand because nobody could reach the evidence. Contiguity is therefore
///      not a convenience check, it is the honesty of the instrument, and it is enforced here at
///      assertion time against bounds snapshotted from the mirror. `test_spanListWithAGapIsRejected`
///      and its fuzz counterpart are load-bearing tests, not coverage filler.
///
///      WHAT IS UNCHANGED, DELIBERATELY
///
///      Commit-reveal with the commitment binding `msg.sender`; no one-shot `refute()`; span bounds
///      snapshotted at assertion so a later `extendSpan` cannot widen a claim retroactively;
///      receipt status required to be `0x1`, because the block prover certifies inclusion and never
///      success. Each of those exists because removing it reintroduces a specific, known attack.
///
///      A claim in `Standing` still DOES NOT MEAN the event never happened. It means: nobody
///      refuted it within its window, over a gap-free range, while a named bond was at risk.
contract AbsenceRegistryV2 is IAbsence {
    EthereumMirror public immutable MIRROR;

    /// @notice Minimum bond. Must comfortably exceed the cost of refuting, or nobody hunts and an
    ///         unrefuted claim carries no information at all.
    uint256 public constant MIN_BOND = 0.01 ether;

    /// @notice Shortest permitted challenge window.
    uint64 public constant MIN_WINDOW = 15 minutes;

    /// @notice A commitment must age this many blocks before it can be revealed.
    uint256 public constant COMMIT_DELAY_BLOCKS = 1;

    /// @notice Most simultaneously-open claims one address may hold.
    /// @dev Without a cap, asserting true cleanliness about thousands of untouched addresses is a
    ///      cheap way to bury the board in claims that will all stand, drowning the few that
    ///      matter. The bond is the primary defence; this is the secondary one that stops a
    ///      well-funded spammer making the board useless to read.
    uint256 public constant MAX_OPEN_PER_CLAIMER = 64;

    /// @notice Most spans one claim may bind, bounding the assertion-time loop.
    uint256 public constant MAX_SPANS_PER_CLAIM = 64;

    struct Claim {
        address claimant;
        address refuter;
        uint64 chainKey;
        address venue;
        bytes32 topic0;
        bytes32 subject;
        uint8 subjectTopic;
        // Snapshotted at assertion. `extendSpan` is permissionless, so reading span bounds live
        // would let anyone widen a claim after the fact and drag a counterexample into range,
        // stealing the bond of a claimant whose statement was true when they made it.
        uint64 spanFrom;
        uint64 spanTo;
        /// @dev keccak of the spanId list, so the exact spans a claim was made over stay auditable
        ///      without paying to store an array per claim. The list itself is in the event.
        bytes32 spansHash;
        uint256 bond; // live escrow; zeroed when paid out
        uint256 bondStaked; // what was put at risk; never mutated
        uint64 openUntil;
        Status status;
    }

    Claim[] internal _claims;

    /// @notice commitment => block number at which it was recorded.
    mapping(bytes32 => uint256) public commitmentBlock;

    /// @notice claimant => number of their claims currently Open.
    mapping(address => uint256) public openClaims;

    event AbsenceAsserted(
        uint256 indexed claimId,
        address indexed claimant,
        uint256[] spanIds,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint256 bond,
        uint64 openUntil,
        uint64 spanFrom,
        uint64 spanTo
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
    error NoSpans();
    error TooManySpans();
    error SpansNotAdjacent(uint64 expectedFrom, uint64 actualFrom);
    error SpansDifferentChains();
    error TooManyOpenClaims();

    constructor(EthereumMirror mirror_) {
        MIRROR = mirror_;
    }

    // -------------------------------------------------------------------------------------------
    // Asserting
    // -------------------------------------------------------------------------------------------

    /// @notice Stake a bond on the statement that across every block covered by `spanIds`,
    ///         contract `venue` emitted no log matching `topic0` (and `subject`, when constrained).
    /// @param spanIds Sealed spans, in ascending order, each starting exactly where the previous
    ///        one ended. Together they must form one gap-free range.
    /// @param subjectTopic Which indexed topic slot must equal `subject` (1-3), or 0 to match any
    ///        log of that signature.
    function assertAbsence(
        uint256[] calldata spanIds,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 subjectTopic,
        uint64 window
    ) external payable returns (uint256 claimId) {
        if (msg.value < MIN_BOND) revert BondTooSmall();
        if (window < MIN_WINDOW) revert WindowTooShort();
        if (subjectTopic > 3) revert BadSubjectTopic();
        if (spanIds.length == 0) revert NoSpans();
        if (spanIds.length > MAX_SPANS_PER_CLAIM) revert TooManySpans();
        if (openClaims[msg.sender] >= MAX_OPEN_PER_CLAIMER) revert TooManyOpenClaims();

        // Reverts unless every span exists; also fixes which chain the claim is about.
        EthereumMirror.Span memory first = MIRROR.spanOf(spanIds[0]);
        uint64 from = first.fromBlock;
        uint64 to = first.toBlock;
        uint64 chainKey = first.chainKey;

        for (uint256 i = 1; i < spanIds.length; ++i) {
            EthereumMirror.Span memory sp = MIRROR.spanOf(spanIds[i]);
            if (sp.chainKey != chainKey) revert SpansDifferentChains();
            // Adjacency, not merely order: a one-block hole is a hiding place for the very
            // transaction that would refute the claim.
            if (sp.fromBlock != to + 1) revert SpansNotAdjacent(to + 1, sp.fromBlock);
            to = sp.toBlock;
        }

        claimId = _claims.length;
        uint64 openUntil = uint64(block.timestamp) + window;
        _claims.push(
            Claim({
                claimant: msg.sender,
                refuter: address(0),
                chainKey: chainKey,
                venue: venue,
                topic0: topic0,
                subject: subject,
                subjectTopic: subjectTopic,
                spanFrom: from,
                spanTo: to,
                spansHash: keccak256(abi.encode(spanIds)),
                bond: msg.value,
                bondStaked: msg.value,
                openUntil: openUntil,
                status: Status.Open
            })
        );
        unchecked {
            ++openClaims[msg.sender];
        }

        emit AbsenceAsserted(claimId, msg.sender, spanIds, venue, topic0, subject, msg.value, openUntil, from, to);
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

        // Evidence must lie inside the range *as it stood when the claim was made*.
        if (blockNumber < c.spanFrom || blockNumber > c.spanTo) revert BlockOutsideSpan();

        // Reverting form on purpose: a forged proof must take this transaction down, never return
        // a falsy value that a future refactor could forget to check.
        uint64 txIndex = MIRROR.verifyOrRevert(c.chainKey, blockNumber, encodedTransaction, siblings);

        // The block prover certifies inclusion, never success. A reverted transaction that merely
        // attempted a liquidation is not evidence that one occurred.
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();

        if (!_contradicts(c, receipt)) revert NoContradictionFound();

        c.status = Status.Refuted;
        c.refuter = msg.sender;
        uint256 bond = c.bond;
        c.bond = 0;
        _releaseOpenSlot(c.claimant);

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
        _releaseOpenSlot(c.claimant);

        emit AbsenceStands(claimId, c.claimant, bond);

        (bool sent,) = payable(c.claimant).call{value: bond}("");
        if (!sent) revert TransferFailed();
    }

    function _releaseOpenSlot(address claimant) internal {
        uint256 n = openClaims[claimant];
        if (n != 0) {
            unchecked {
                openClaims[claimant] = n - 1;
            }
        }
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

    /// @inheritdoc IAbsence
    function assurance(uint256 claimId)
        external
        view
        returns (Status status, uint256 bond, uint64 openUntil, uint64 spanFrom, uint64 spanTo)
    {
        Claim storage c = _claimAt(claimId);
        return (c.status, c.bondStaked, c.openUntil, c.spanFrom, c.spanTo);
    }

    /// @inheritdoc IAbsence
    function holdsWithBond(uint256 claimId, uint256 minBond) external view returns (bool) {
        Claim storage c = _claimAt(claimId);
        return c.status == Status.Standing && c.bondStaked >= minBond;
    }

    /// @inheritdoc IAbsence
    function holds(uint256 claimId) external view returns (bool) {
        return _claimAt(claimId).status == Status.Standing;
    }

    function claimOf(uint256 claimId) external view returns (Claim memory) {
        return _claimAt(claimId);
    }

    /// @inheritdoc IAbsence
    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    function _claimAt(uint256 claimId) internal view returns (Claim storage) {
        if (claimId >= _claims.length) revert NoSuchClaim();
        return _claims[claimId];
    }
}
