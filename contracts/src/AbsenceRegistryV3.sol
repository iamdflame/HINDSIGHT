// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";
import {EthereumMirror} from "./EthereumMirror.sol";
import {IAbsence} from "./IAbsence.sol";
import {IAbsenceV3} from "./IAbsenceV3.sol";

/// @title AbsenceRegistryV3
/// @notice Two statements about Ethereum that inclusion proofs cannot make, each made checkable by
///         a bond that is partly burned when it is wrong.
///
/// @dev THE TWO STATEMENTS
///
///      `EmptySet`    -- no successful log matching (chainKey, venue, topic0, subject) exists in
///                       the gap-free range [from, to].
///      `CompleteSet` -- the listed members are *all* such logs in that range; nothing is omitted.
///
///      Both are refuted by one transaction the claimant did not account for: a matching log for
///      `EmptySet`, a matching log whose key is not in the member list for `CompleteSet`. Every
///      member of a `CompleteSet` is verified against the mirror at assertion time -- a `view` call
///      against a held root, never the precompile -- so a listed member is a real, successful,
///      matching log, and the only thing left to bond is omission.
///
///      WHY HALF THE BOND IS BURNED
///
///      If the whole bond went to the refuter, a claimant could stake a lie, refute it from a
///      second address, and end the day exactly where they started. Nothing would have been at
///      risk, and "bonded" would be decoration. Burning half makes a false claim cost something
///      that cannot be recovered by anyone, which is the only reason a standing claim carries
///      information. `enforceableLoss` exposes that number; `isUsable(id, exposure)` compares a
///      consumer's exposure against it, rather than against the headline bond.
///
///      WHAT IS UNCHANGED FROM V2, DELIBERATELY
///
///      Commit-reveal with the commitment binding `msg.sender`; no one-shot refute; span bounds
///      snapshotted at assertion; receipt status required to be `0x1`; a per-claimer cap on open
///      claims. Each exists because removing it reintroduces a specific attack.
///
///      WHY THERE IS AN INDEX
///
///      A consumer deciding about one address must not have to read every claim ever filed: the
///      first version of the desk did, capped the walk at 512, and so could be switched off for
///      everyone by five tCTC of junk claims. `recordOf(keyOf(...))` answers "anything refuted, open
///      or listed about this subject?" in one read, whatever else is on the board.
///
///      WHY A RETURNED BOND IS PULLED IF IT CANNOT BE PUSHED
///
///      `finalize` is how an Open claim stops being Open. If it pushed the bond and reverted on
///      failure, a claimant contract that rejects payment would keep its claim Open forever -- and
///      an Open claim blocks lending to its subject. The bond is pushed with a gas stipend and, if
///      that fails, credited to `owed` for the claimant to withdraw; the claim stands either way.
///
///      A claim in `Standing` still DOES NOT MEAN the statement is true. It means: nobody refuted
///      it within its window, over a gap-free range, while this much unrecoverable bond was at risk.
contract AbsenceRegistryV3 is IAbsenceV3 {
    EthereumMirror public immutable MIRROR;

    uint256 public constant MIN_BOND = 0.01 ether;
    uint64 public constant MIN_WINDOW = 15 minutes;
    uint256 public constant COMMIT_DELAY_BLOCKS = 1;
    uint256 public constant MAX_OPEN_PER_CLAIMER = 64;

    /// @notice Most spans one claim may bind. With 2^17-block spans, sixteen is over two years.
    uint256 public constant MAX_SPANS_PER_CLAIM = 16;

    /// @notice Most members a `CompleteSet` may enumerate. Bounds the assertion-time verification loop.
    uint256 public constant MAX_MEMBERS = 32;

    /// @notice Share of a refuted bond paid to the refuter, in basis points. The rest is burned.
    uint256 public constant REFUTER_SHARE_BPS = 5_000;

    /// @notice Where the burned share goes. No key, no code, no way back.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @dev A matching log, identified by where it sits. Strictly ordered by (height, txIndex, logIndex).
    struct Member {
        uint64 height;
        uint64 txIndex;
        uint32 logIndex;
    }

    /// @dev What a claimant supplies per member: enough to verify it against the mirror.
    struct MemberProof {
        uint64 height;
        uint32 logIndex;
        bytes encodedTransaction;
        INativeQueryVerifier.MerkleProofEntry[] siblings;
    }

    struct Claim {
        address claimant;
        address refuter;
        uint64 chainKey;
        address venue;
        bytes32 topic0;
        bytes32 subject;
        uint8 subjectTopic;
        uint64 spanFrom;
        uint64 spanTo;
        bytes32 spansHash;
        uint256 bond; // live escrow; zeroed when paid out
        uint256 bondStaked; // what was put at risk; never mutated
        uint64 openUntil;
        Status status;
        Kind kind;
        uint32 members; // CompleteSet only
        bytes32 membersHash; // keccak256(abi.encode(Member[])), CompleteSet only
    }

    Claim[] internal _claims;

    /// @notice commitment => block number at which it was recorded.
    mapping(bytes32 => uint256) public commitmentBlock;

    /// @notice claimant => number of their claims currently Open.
    mapping(address => uint256) public openClaims;

    /// @dev See `recordOf`. Packed into one slot.
    struct Record {
        uint32 open;
        uint32 refuted;
        uint64 lastEvidenceAt;
        uint64 lastMemberAt;
        uint32 total;
    }

    mapping(bytes32 => Record) internal _records;
    mapping(bytes32 => uint256[]) internal _underKey;

    /// @notice Bonds that could not be pushed back to their claimant. Withdraw with `withdraw()`.
    mapping(address => uint256) public owed;

    /// @notice Gas forwarded when returning a bond. Enough for an EOA or a smart wallet's receive;
    ///         not enough to turn `finalize` into somebody else's gas bill.
    uint256 public constant RETURN_GAS = 50_000;

    event AbsenceAsserted(
        uint256 indexed claimId,
        address indexed claimant,
        Kind kind,
        uint256[] spanIds,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint256 bond,
        uint64 openUntil,
        uint64 spanFrom,
        uint64 spanTo
    );
    /// @dev The full member list, so a refuter can reconstruct it from logs without asking anyone.
    event MembersListed(uint256 indexed claimId, Member[] members);
    event RefutationCommitted(bytes32 indexed commitment, address indexed by, uint256 atBlock);
    event AbsenceRefuted(
        uint256 indexed claimId,
        address indexed refuter,
        uint64 blockNumber,
        uint64 txIndex,
        uint256 paidToRefuter,
        uint256 burned
    );
    event AbsenceStands(uint256 indexed claimId, address indexed claimant, uint256 bondReturned);
    event BondOwed(address indexed claimant, uint256 amount);
    event Withdrawn(address indexed claimant, uint256 amount);

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
    error NoMembers();
    error TooManyMembers();
    error MembersNotOrdered(uint256 index);
    error MemberDoesNotMatch(uint256 index);
    error NoSuchLog();
    error WrongMemberList();
    error MemberAlreadyListed();
    error WrongKind();
    error NothingOwed();

    constructor(EthereumMirror mirror_) {
        MIRROR = mirror_;
    }

    // -------------------------------------------------------------------------------------------
    // Asserting
    // -------------------------------------------------------------------------------------------

    /// @notice Stake a bond on the statement that across every block covered by `spanIds`,
    ///         contract `venue` emitted no successful log matching `topic0` (and `subject`).
    function assertAbsence(
        uint256[] calldata spanIds,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 subjectTopic,
        uint64 window
    ) external payable returns (uint256 claimId) {
        (uint64 chainKey, uint64 from, uint64 to) = _openChecks(spanIds, subjectTopic, window);
        claimId = _push(Kind.EmptySet, chainKey, venue, topic0, subject, subjectTopic, from, to, spanIds, 0, bytes32(0), window);
    }

    /// @notice Stake a bond on the statement that `proofs` enumerate *every* successful log
    ///         matching `topic0`/`subject` at `venue` across `spanIds`.
    /// @dev Each member is verified against the mirror here, at assertion. That is a `view` per
    ///      member against a held root -- the precompile is not involved -- and it is what makes
    ///      the listed set trustworthy without a bond. The bond is for what is *not* listed.
    function assertComplete(
        uint256[] calldata spanIds,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 subjectTopic,
        uint64 window,
        MemberProof[] calldata proofs
    ) external payable returns (uint256 claimId) {
        if (proofs.length == 0) revert NoMembers();
        if (proofs.length > MAX_MEMBERS) revert TooManyMembers();
        (uint64 chainKey, uint64 from, uint64 to) = _openChecks(spanIds, subjectTopic, window);

        Member[] memory members = new Member[](proofs.length);
        for (uint256 i; i < proofs.length; ++i) {
            MemberProof calldata p = proofs[i];
            if (p.height < from || p.height > to) revert BlockOutsideSpan();

            // Verified against held history, never the precompile. Reverting form on purpose.
            uint64 txIndex = MIRROR.verifyOrRevert(chainKey, p.height, p.encodedTransaction, p.siblings);

            EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(p.encodedTransaction);
            if (receipt.receiptStatus != 1) revert TransactionFailed();
            if (!_logMatches(receipt, p.logIndex, venue, topic0, subject, subjectTopic)) revert MemberDoesNotMatch(i);

            Member memory m = Member({height: p.height, txIndex: txIndex, logIndex: p.logIndex});
            if (i > 0 && !_less(members[i - 1], m)) revert MembersNotOrdered(i);
            members[i] = m;
        }

        claimId = _push(
            Kind.CompleteSet,
            chainKey,
            venue,
            topic0,
            subject,
            subjectTopic,
            from,
            to,
            spanIds,
            uint32(proofs.length),
            keccak256(abi.encode(members)),
            window
        );
        // Members are strictly ordered, so the last one is the highest. Each is a verified,
        // successful, matching log: an event on record about this subject, whatever the claim's fate.
        Record storage r = _records[_keyOfClaim(_claims[claimId])];
        uint64 top = members[members.length - 1].height;
        if (top > r.lastMemberAt) r.lastMemberAt = top;
        emit MembersListed(claimId, members);
    }

    function _openChecks(uint256[] calldata spanIds, uint8 subjectTopic, uint64 window)
        internal
        view
        returns (uint64 chainKey, uint64 from, uint64 to)
    {
        if (msg.value < MIN_BOND) revert BondTooSmall();
        if (window < MIN_WINDOW) revert WindowTooShort();
        if (subjectTopic > 3) revert BadSubjectTopic();
        if (spanIds.length == 0) revert NoSpans();
        if (spanIds.length > MAX_SPANS_PER_CLAIM) revert TooManySpans();
        if (openClaims[msg.sender] >= MAX_OPEN_PER_CLAIMER) revert TooManyOpenClaims();

        EthereumMirror.Span memory first = MIRROR.spanOf(spanIds[0]);
        from = first.fromBlock;
        to = first.toBlock;
        chainKey = first.chainKey;
        for (uint256 i = 1; i < spanIds.length; ++i) {
            EthereumMirror.Span memory sp = MIRROR.spanOf(spanIds[i]);
            if (sp.chainKey != chainKey) revert SpansDifferentChains();
            // Adjacency, not merely order: a one-block hole is a hiding place for the very
            // transaction that would refute the claim.
            if (sp.fromBlock != to + 1) revert SpansNotAdjacent(to + 1, sp.fromBlock);
            to = sp.toBlock;
        }
    }

    function _push(
        Kind kind_,
        uint64 chainKey,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 subjectTopic,
        uint64 from,
        uint64 to,
        uint256[] calldata spanIds,
        uint32 members,
        bytes32 membersHash,
        uint64 window
    ) internal returns (uint256 claimId) {
        // A claim that constrains no topic constrains no subject; storing one would let it be
        // indexed, and read, as though it were about somebody.
        if (subjectTopic == 0) subject = bytes32(0);
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
                status: Status.Open,
                kind: kind_,
                members: members,
                membersHash: membersHash
            })
        );
        unchecked {
            ++openClaims[msg.sender];
        }
        bytes32 key = keyOf(chainKey, venue, topic0, subjectTopic, subject);
        Record storage r = _records[key];
        unchecked {
            ++r.open;
            ++r.total;
        }
        _underKey[key].push(claimId);
        emit AbsenceAsserted(claimId, msg.sender, kind_, spanIds, venue, topic0, subject, msg.value, openUntil, from, to);
    }

    // -------------------------------------------------------------------------------------------
    // Refuting: commit, then reveal
    // -------------------------------------------------------------------------------------------

    /// @notice Commitment for refuting an `EmptySet` claim. Pure, so it can be computed off-chain.
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

    /// @notice Commitment for refuting a `CompleteSet` claim. Includes the omitted log's index and
    ///         the member list the refuter will present, so neither can be swapped at reveal.
    function commitmentForComplete(
        uint256 claimId,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        uint32 logIndex,
        Member[] calldata members,
        bytes32 salt,
        address refuter
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(claimId, blockNumber, encodedTransaction, siblings, logIndex, members, salt, refuter));
    }

    /// @notice Record the intent to refute. Reveals nothing about the evidence.
    function commitRefutation(bytes32 commitment) external {
        if (commitmentBlock[commitment] != 0) revert AlreadyCommitted();
        commitmentBlock[commitment] = block.number;
        emit RefutationCommitted(commitment, msg.sender, block.number);
    }

    /// @notice Reveal one matching successful log inside an `EmptySet` claim's range.
    function revealRefutation(
        uint256 claimId,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 salt
    ) external {
        _requireAgedCommitment(commitmentFor(claimId, blockNumber, encodedTransaction, siblings, salt, msg.sender));

        Claim storage c = _openClaimInRange(claimId, blockNumber);
        if (c.kind != Kind.EmptySet) revert WrongKind();

        uint64 txIndex = MIRROR.verifyOrRevert(c.chainKey, blockNumber, encodedTransaction, siblings);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();
        if (!_contradicts(c, receipt)) revert NoContradictionFound();

        _settleRefutation(claimId, c, blockNumber, txIndex);
    }

    /// @notice Reveal one matching successful log inside a `CompleteSet` claim's range that the
    ///         claimant did not list.
    /// @param members The list exactly as asserted (available from `MembersListed`). Its hash must
    ///        match; the omitted log's key must not appear in it.
    function revealOmission(
        uint256 claimId,
        uint64 blockNumber,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        uint32 logIndex,
        Member[] calldata members,
        bytes32 salt
    ) external {
        _requireAgedCommitment(
            commitmentForComplete(claimId, blockNumber, encodedTransaction, siblings, logIndex, members, salt, msg.sender)
        );

        Claim storage c = _openClaimInRange(claimId, blockNumber);
        if (c.kind != Kind.CompleteSet) revert WrongKind();
        if (keccak256(abi.encode(members)) != c.membersHash) revert WrongMemberList();

        uint64 txIndex = MIRROR.verifyOrRevert(c.chainKey, blockNumber, encodedTransaction, siblings);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionFailed();
        if (!_logMatches(receipt, logIndex, c.venue, c.topic0, c.subject, c.subjectTopic)) revert NoContradictionFound();

        // The whole point: this key must be absent from the list the claimant bonded as complete.
        for (uint256 i; i < members.length; ++i) {
            if (members[i].height == blockNumber && members[i].txIndex == txIndex && members[i].logIndex == logIndex) {
                revert MemberAlreadyListed();
            }
        }

        _settleRefutation(claimId, c, blockNumber, txIndex);
    }

    function _requireAgedCommitment(bytes32 commitment) internal view {
        uint256 committedAt = commitmentBlock[commitment];
        if (committedAt == 0) revert NoCommitment();
        if (block.number < committedAt + COMMIT_DELAY_BLOCKS) revert CommitmentTooFresh();
    }

    function _openClaimInRange(uint256 claimId, uint64 blockNumber) internal view returns (Claim storage c) {
        c = _claimAt(claimId);
        if (c.status != Status.Open) revert ClaimNotOpen();
        if (block.timestamp > c.openUntil) revert WindowClosed();
        // Evidence must lie inside the range *as it stood when the claim was made*.
        if (blockNumber < c.spanFrom || blockNumber > c.spanTo) revert BlockOutsideSpan();
    }

    /// @dev Half to the refuter, half burned. The burn is the part that makes the bond a bond.
    function _settleRefutation(uint256 claimId, Claim storage c, uint64 blockNumber, uint64 txIndex) internal {
        c.status = Status.Refuted;
        c.refuter = msg.sender;
        uint256 bond = c.bond;
        c.bond = 0;
        _releaseOpenSlot(c.claimant);

        Record storage r = _records[_keyOfClaim(c)];
        unchecked {
            --r.open;
            ++r.refuted;
        }
        if (blockNumber > r.lastEvidenceAt) r.lastEvidenceAt = blockNumber;

        uint256 toRefuter = (bond * REFUTER_SHARE_BPS) / 10_000;
        uint256 burned = bond - toRefuter;

        emit AbsenceRefuted(claimId, msg.sender, blockNumber, txIndex, toRefuter, burned);

        (bool sent,) = payable(msg.sender).call{value: toRefuter}("");
        if (!sent) revert TransferFailed();
        (bool gone,) = payable(BURN).call{value: burned}("");
        if (!gone) revert TransferFailed();
    }

    /// @notice After the window closes unrefuted, record that fact and return the bond in full.
    /// @dev This records that nobody refuted. It does not record that the statement is true.
    function finalize(uint256 claimId) external {
        Claim storage c = _claimAt(claimId);
        if (c.status != Status.Open) revert ClaimNotOpen();
        if (block.timestamp <= c.openUntil) revert WindowStillOpen();

        c.status = Status.Standing;
        uint256 bond = c.bond;
        c.bond = 0;
        _releaseOpenSlot(c.claimant);
        unchecked {
            --_records[_keyOfClaim(c)].open;
        }

        emit AbsenceStands(claimId, c.claimant, bond);

        // Pushed with a stipend; if the claimant cannot or will not receive it, it is owed instead.
        // Either way the claim is no longer Open, which is the part other people depend on.
        (bool sent,) = payable(c.claimant).call{value: bond, gas: RETURN_GAS}("");
        if (!sent) {
            owed[c.claimant] += bond;
            emit BondOwed(c.claimant, bond);
        }
    }

    /// @notice Collect bonds `finalize` could not push.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);
        (bool sent,) = payable(msg.sender).call{value: amount}("");
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

    /// @dev Any log in the receipt matches the claim's filter.
    function _contradicts(Claim storage c, EvmV1Decoder.ReceiptFields memory receipt) internal view returns (bool) {
        for (uint32 i; i < receipt.receiptLogs.length; ++i) {
            if (_logMatches(receipt, i, c.venue, c.topic0, c.subject, c.subjectTopic)) return true;
        }
        return false;
    }

    /// @dev The log at `logIndex` matches the filter. Conservative: emitting contract, event
    ///      signature and (when constrained) the indexed subject must all line up.
    function _logMatches(
        EvmV1Decoder.ReceiptFields memory receipt,
        uint32 logIndex,
        address venue,
        bytes32 topic0,
        bytes32 subject,
        uint8 slot
    ) internal pure returns (bool) {
        if (logIndex >= receipt.receiptLogs.length) return false;
        EvmV1Decoder.LogEntry memory lg = receipt.receiptLogs[logIndex];
        if (lg.topics.length == 0) return false;
        if (venue != address(0) && lg.address_ != venue) return false;
        if (lg.topics[0] != topic0) return false;
        if (slot != 0) {
            if (lg.topics.length <= slot) return false;
            if (lg.topics[slot] != subject) return false;
        }
        return true;
    }

    function _less(Member memory a, Member memory b) internal pure returns (bool) {
        if (a.height != b.height) return a.height < b.height;
        if (a.txIndex != b.txIndex) return a.txIndex < b.txIndex;
        return a.logIndex < b.logIndex;
    }

    // -------------------------------------------------------------------------------------------
    // Reading -- consumers should prefer isUsable() or assurance()
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

    /// @inheritdoc IAbsence
    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    /// @inheritdoc IAbsenceV3
    function kind(uint256 claimId) external view returns (Kind) {
        return _claimAt(claimId).kind;
    }

    /// @inheritdoc IAbsenceV3
    function enforceableLoss(uint256 claimId) public view returns (uint256) {
        uint256 staked = _claimAt(claimId).bondStaked;
        return staked - (staked * REFUTER_SHARE_BPS) / 10_000;
    }

    /// @inheritdoc IAbsenceV3
    function isUsable(uint256 claimId, uint256 exposure) external view returns (bool) {
        return _claimAt(claimId).status == Status.Standing && enforceableLoss(claimId) >= exposure;
    }

    /// @inheritdoc IAbsenceV3
    function memberCount(uint256 claimId) external view returns (uint256) {
        return _claimAt(claimId).members;
    }

    /// @inheritdoc IAbsenceV3
    function keyOf(uint64 chainKey, address venue, bytes32 topic0, uint8 subjectTopic, bytes32 subject)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, venue, topic0, subjectTopic, subjectTopic == 0 ? bytes32(0) : subject));
    }

    /// @inheritdoc IAbsenceV3
    function recordOf(bytes32 key)
        external
        view
        returns (uint32 open, uint32 refuted, uint64 lastEvidenceAt, uint64 lastMemberAt, uint32 total)
    {
        Record storage r = _records[key];
        return (r.open, r.refuted, r.lastEvidenceAt, r.lastMemberAt, r.total);
    }

    /// @inheritdoc IAbsenceV3
    function claimUnderKey(bytes32 key, uint256 index) external view returns (uint256) {
        return _underKey[key][index];
    }

    function _keyOfClaim(Claim storage c) internal view returns (bytes32) {
        return keyOf(c.chainKey, c.venue, c.topic0, c.subjectTopic, c.subject);
    }

    function claimOf(uint256 claimId) external view returns (Claim memory) {
        return _claimAt(claimId);
    }

    function _claimAt(uint256 claimId) internal view returns (Claim storage) {
        if (claimId >= _claims.length) revert NoSuchClaim();
        return _claims[claimId];
    }
}
