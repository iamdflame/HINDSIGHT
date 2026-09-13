// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMirror} from "./IMirror.sol";
import {INativeQueryVerifier} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "@gluwa/asc-contracts/contracts/common/EvmV1Decoder.sol";

/// @title SubjectBinding
/// @notice Proof that a Creditcoin address speaks for an Ethereum address, drawn from Ethereum.
///
/// @dev THE PROBLEM THIS EXISTS FOR
///
///      `UnderwritingDesk.borrow` underwrites `msg.sender` and takes no subject argument, for a good
///      reason: if a caller could name their own subject, every refusal would be one parameter away
///      from being washed -- point at a clean address, collect the loan. The cost of that rule is
///      that the desk can only ever pay a wallet whose key the caller holds *on Creditcoin*, and the
///      addresses whose records are worth underwriting are on Ethereum. So the only borrower the desk
///      has ever paid is a fresh wallet with a trivially true claim, and everybody involved has had to
///      say so.
///
///      THE FIX, AND WHY IT DOES NOT REOPEN THE HOLE
///
///      An Ethereum address proves it controls a Creditcoin address the only way it can: by signing
///      an Ethereum transaction whose calldata names it. That transaction is then proven against a
///      root this chain already holds. The subject is still not a parameter the borrower chooses --
///      it is the `from` of a transaction they had to be able to sign. A liar pointing at a clean
///      stranger would need that stranger's Ethereum key, which is the same barrier as before.
///
///      The binding is a fact about key custody at a height, not a reputation, an identity or a
///      credential. Nothing is minted, nothing is transferable, and this contract cannot be used to
///      make any statement about an address other than "this key signed for that one".
///
///      WHAT THE CALLDATA MUST BE
///
///      Exactly 32 bytes: `MAGIC` (12) followed by the Creditcoin address (20). Any transaction from
///      the subject will do -- a zero-value self-send costs 21,000 gas plus calldata -- and the tag is
///      a keccak prefix, so no ordinary contract call can collide with it by accident.
///
///      REPLAY, AND WHY HEIGHT IS THE TIEBREAK
///
///      A bind transaction is public on Ethereum forever, so anyone can submit anyone's proof. That is
///      harmless -- the calldata names the controller, so submitting it can only bind the pair its
///      signer chose -- with one exception: an *old* bind could be replayed to drag a subject back to a
///      controller it has since moved away from. So every binding records the Ethereum height that
///      caused it, and a binding is only replaced from strictly higher up the chain. The newest
///      signature the submitter can find wins, which is the only ordering both sides can agree on
///      without asking this contract's operator, of which there is none.
///
///      NO OWNER, NO PAUSE, NO UPGRADE. Binding is permissionless and unbinding is not possible;
///      moving to a new controller means signing again, from the same Ethereum address, later.
contract SubjectBinding {
    IMirror public immutable MIRROR;

    /// @dev `bytes12(keccak256("hindsight.bind.v1"))`. A prefix, not a selector: it is not called.
    bytes12 public constant MAGIC = bytes12(0xbbe2d60e0629fc4d3921eff1);

    struct Binding {
        /// @dev The Ethereum address that signed. Zero means no binding.
        address subject;
        /// @dev Which source chain the subject lives on: the same address on two chains is two subjects.
        uint64 chainKey;
        /// @dev The height of the transaction that proved it. Only a higher one may replace it.
        uint64 height;
    }

    /// @notice What a Creditcoin address has proven it speaks for.
    mapping(address controller => Binding) internal _bound;

    /// @notice Which Creditcoin address currently speaks for a source-chain address.
    mapping(uint64 chainKey => mapping(address subject => address controller)) public controllerOf;

    /// @dev The height of the transaction behind `controllerOf`, so a replay cannot walk it backwards.
    mapping(uint64 chainKey => mapping(address subject => uint64 height)) public boundAtHeight;

    event Bound(address indexed controller, uint64 indexed chainKey, address indexed subject, uint64 height);
    event Rebound(address indexed controller, uint64 indexed chainKey, address indexed subject, uint64 fromHeight, uint64 toHeight);

    error NotABindingTransaction();
    error TransactionReverted();
    error NotNewer(uint64 have, uint64 offered);

    constructor(IMirror mirror_) {
        MIRROR = mirror_;
    }

    /// @notice The calldata an Ethereum address must sign to bind itself to `controller`.
    /// @dev Pure, so a wallet, a script or a page can produce it without a transaction.
    function bindingCalldata(address controller) public pure returns (bytes memory) {
        return abi.encodePacked(MAGIC, controller);
    }

    /// @notice Prove that the signer of an Ethereum transaction chose `controller` to speak for it.
    /// @dev Anyone may submit anyone's proof: the transaction names the controller, so submitting it
    ///      cannot bind a pair its signer did not choose.
    function bind(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings
    ) external returns (address controller, address subject) {
        // Fails closed: a transaction that is not in a held block does not return a value, it reverts.
        MIRROR.verifyOrRevert(chainKey, height, encodedTransaction, siblings);

        // A reverted transaction is not an act. The same rule the registry applies to a liquidation.
        if (EvmV1Decoder.decodeReceiptFields(encodedTransaction).receiptStatus != 1) revert TransactionReverted();

        EvmV1Decoder.CommonTxFields memory tx_ = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        controller = _controllerIn(tx_.data);
        subject = tx_.from;

        // Monotone in Ethereum height, in both directions, so a replayed old proof cannot drag either
        // side back to a pairing its signer has since replaced.
        uint64 hadForSubject = boundAtHeight[chainKey][subject];
        if (height <= hadForSubject) revert NotNewer(hadForSubject, height);

        Binding memory prior = _bound[controller];
        if (prior.subject != address(0) && height <= prior.height) revert NotNewer(prior.height, height);
        // This controller spoke for something else: that pairing ends here, rather than leaving two
        // live claims on one key.
        if (prior.subject != address(0) && (prior.subject != subject || prior.chainKey != chainKey)) {
            delete controllerOf[prior.chainKey][prior.subject];
            emit Rebound(controller, prior.chainKey, prior.subject, prior.height, height);
        }
        // The subject spoke through someone else: same, from the other side.
        address priorController = controllerOf[chainKey][subject];
        if (priorController != address(0) && priorController != controller) {
            delete _bound[priorController];
            emit Rebound(priorController, chainKey, subject, hadForSubject, height);
        }

        _bound[controller] = Binding({subject: subject, chainKey: chainKey, height: height});
        controllerOf[chainKey][subject] = controller;
        boundAtHeight[chainKey][subject] = height;
        emit Bound(controller, chainKey, subject, height);
    }

    /// @notice What `controller` speaks for, if anything. `subject` is zero when nothing.
    function boundSubject(address controller) external view returns (Binding memory) {
        return _bound[controller];
    }

    /// @notice The address a consumer should underwrite when `controller` asks: itself, unless it has
    ///         proven it speaks for someone on `chainKey`.
    /// @dev This is the whole interface a lender needs. It never returns an address the caller has not
    ///      proven control of, so passing its result to a refusal check cannot launder a record.
    function subjectFor(address controller, uint64 chainKey) external view returns (address) {
        Binding memory b = _bound[controller];
        return (b.subject != address(0) && b.chainKey == chainKey) ? b.subject : controller;
    }

    /// @dev The 20 bytes after `MAGIC`, or a revert if the calldata is not a binding at all.
    function _controllerIn(bytes memory data) private pure returns (address) {
        if (data.length != 32) revert NotABindingTransaction();
        bytes32 word;
        assembly {
            word := mload(add(data, 32))
        }
        if (bytes12(word) != MAGIC) revert NotABindingTransaction();
        return address(uint160(uint256(word)));
    }
}
