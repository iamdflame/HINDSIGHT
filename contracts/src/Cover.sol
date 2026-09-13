// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAbsence} from "./IAbsence.sol";
import {IAbsenceV3} from "./IAbsenceV3.sol";

/// @title Cover
/// @notice Insurance on a claim, priced by whoever is willing to write it, settled by the hunt.
///
/// @dev WHAT IT IS
///
///      A claim on the registry is open for a window during which anyone may refute it for half the
///      bond. Somebody who wants to rely on that claim once it stands -- a lender, say -- carries the
///      risk that it is refuted first. Cover lets a third party sell that risk: the underwriter locks a
///      payout, the buyer pays a premium, and the claim's own outcome decides who gets the payout. No
///      oracle is introduced; the hunter market *is* the oracle, and the registry's status is the only
///      thing this contract reads.
///
///      WHAT IT IS NOT, AND WHY
///
///      Not cover on a *standing* claim. A standing claim is one the window closed on unrefuted; the
///      registry will not take a refutation against it afterwards, because "standing" would mean
///      nothing if it could. So there is no later event to insure against, and a contract that sold
///      cover on standing claims would be selling cover on nothing. Cover is written while the claim
///      is open, and it settles when the claim does. The registry's rule is the product's rule.
///
///      NO OWNER, NO PAUSE, NO UPGRADE, NO PRICING MODEL. Every offer is one underwriter's own price
///      for one claim, and every payout is pull-payment: nothing here calls out with value.
contract Cover {
    IAbsenceV3 public immutable REGISTRY;

    enum State {
        None,
        /// Payout locked, nobody has bought.
        Offered,
        /// Bought; waiting for the claim to settle.
        Live,
        /// Settled or withdrawn; the payout has been assigned.
        Closed
    }

    struct Offer {
        uint256 claimId;
        address underwriter;
        address buyer;
        uint256 payout;
        uint256 premium;
        State state;
    }

    Offer[] internal _offers;

    /// @notice Pull-payment balances. Premiums, payouts and refunds all land here.
    mapping(address => uint256) public owed;

    event Offered(uint256 indexed offerId, uint256 indexed claimId, address indexed underwriter, uint256 payout, uint256 premium);
    event Bought(uint256 indexed offerId, address indexed buyer, uint256 premium);
    event Settled(uint256 indexed offerId, address indexed to, uint256 payout, bool claimRefuted);
    event Withdrawn(uint256 indexed offerId, address indexed underwriter, uint256 payout);
    event Paid(address indexed to, uint256 amount);

    error NoSuchOffer();
    error ClaimNotOpen();
    error ClaimWindowClosed();
    error WrongState();
    error ZeroPayout();
    error WrongPremium();
    error NotUnderwriter();
    error ClaimNotSettled();
    error TransferFailed();
    error NothingOwed();

    constructor(IAbsenceV3 registry_) {
        REGISTRY = registry_;
    }

    /// @notice Lock `msg.value` as the payout on `claimId`, for sale at `premium`.
    /// @dev Only while the claim is open with time left: an offer on a claim that cannot change is not
    ///      cover, it is a donation with extra steps.
    function offer(uint256 claimId, uint256 premium) external payable returns (uint256 offerId) {
        if (msg.value == 0) revert ZeroPayout();
        (IAbsence.Status status,, uint64 openUntil,,) = REGISTRY.assurance(claimId);
        if (status != IAbsence.Status.Open) revert ClaimNotOpen();
        if (block.timestamp > openUntil) revert ClaimWindowClosed();

        offerId = _offers.length;
        _offers.push(Offer({claimId: claimId, underwriter: msg.sender, buyer: address(0), payout: msg.value, premium: premium, state: State.Offered}));
        emit Offered(offerId, claimId, msg.sender, msg.value, premium);
    }

    /// @notice Take an offer: pay the premium, become the party paid if the claim is refuted.
    function buy(uint256 offerId) external payable {
        Offer storage o = _at(offerId);
        if (o.state != State.Offered) revert WrongState();
        if (msg.value != o.premium) revert WrongPremium();
        (IAbsence.Status status,, uint64 openUntil,,) = REGISTRY.assurance(o.claimId);
        if (status != IAbsence.Status.Open) revert ClaimNotOpen();
        if (block.timestamp > openUntil) revert ClaimWindowClosed();

        o.buyer = msg.sender;
        o.state = State.Live;
        owed[o.underwriter] += msg.value;
        emit Bought(offerId, msg.sender, msg.value);
    }

    /// @notice Assign the payout once the claim has settled. Anyone may call.
    /// @dev Refuted: the buyer collects. Standing: the underwriter takes the payout back (and already
    ///      has the premium). Still open: nothing yet -- and a claim past its window that nobody has
    ///      finalised is finalised by the registry's own permissionless `finalize`, not by this contract
    ///      guessing.
    function settle(uint256 offerId) external {
        Offer storage o = _at(offerId);
        if (o.state != State.Live) revert WrongState();
        (IAbsence.Status s,,,,) = REGISTRY.assurance(o.claimId);
        if (s == IAbsence.Status.Refuted) {
            o.state = State.Closed;
            owed[o.buyer] += o.payout;
            emit Settled(offerId, o.buyer, o.payout, true);
        } else if (s == IAbsence.Status.Standing) {
            o.state = State.Closed;
            owed[o.underwriter] += o.payout;
            emit Settled(offerId, o.underwriter, o.payout, false);
        } else {
            revert ClaimNotSettled();
        }
    }

    /// @notice Take an unbought offer back. Any time: nobody has paid for anything yet.
    function withdrawOffer(uint256 offerId) external {
        Offer storage o = _at(offerId);
        if (o.state != State.Offered) revert WrongState();
        if (msg.sender != o.underwriter) revert NotUnderwriter();
        o.state = State.Closed;
        owed[o.underwriter] += o.payout;
        emit Withdrawn(offerId, o.underwriter, o.payout);
    }

    /// @notice Collect whatever is owed to the caller.
    function withdraw() external {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Paid(msg.sender, amount);
    }

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function offerOf(uint256 offerId) external view returns (Offer memory) {
        return _at(offerId);
    }

    function _at(uint256 offerId) internal view returns (Offer storage) {
        if (offerId >= _offers.length) revert NoSuchOffer();
        return _offers[offerId];
    }
}
