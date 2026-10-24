// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RealEstateEscrow
/// @notice The buyer's 10% deposit is held in the seller's attorney's escrow account
///         (this contract; only the attorney can cancel). The deposit is paid to the
///         seller, and the deal closes, only when ALL of these are true:
///           1. the home inspection passed,
///           2. the buyer's final walkthrough passed,
///           3. the buyer says OK,
///           4. the seller says OK.
///         If the inspection or walkthrough fails the attorney returns the deposit to the buyer.
contract RealEstateEscrow {
    enum Status { None, Deposited, Closed, Cancelled }

    struct Deal {
        uint256 price;
        uint256 deposit;
        uint64 deadline;
        Status status;
        bool inspectionDone;
        bool inspectionPassed;
        bool walkthroughDone;
        bool walkthroughPassed;
        bool buyerOk;
        bool sellerOk;
        string property;
    }

    uint16 public constant DEPOSIT_BPS = 1000; // 10.00%

    address public immutable buyer;
    address public immutable seller;
    address public immutable attorney;   // seller's attorney: holds the escrow account
    address public immutable inspector;  // records the home-inspection result

    mapping(uint256 => Deal) public deals;

    event DealOpened(uint256 indexed dealId, uint256 price, uint256 deposit, uint64 deadline, string property);
    event InspectionRecorded(uint256 indexed dealId, bool passed, string evidence);
    event WalkthroughRecorded(uint256 indexed dealId, bool passed, string notes);
    event BuyerApproved(uint256 indexed dealId);
    event SellerApproved(uint256 indexed dealId);
    event DealClosed(uint256 indexed dealId, address indexed seller, uint256 amount);
    event DealCancelled(uint256 indexed dealId, address indexed refundedTo, uint256 amount, string reason);

    error NotBuyer();
    error NotSeller();
    error NotAttorney();
    error NotInspector();
    error BadDeal();
    error WrongDeposit();
    error InspectionNotPassed();
    error WalkthroughNotPassed();
    error AlreadyDone();
    error TooEarly();
    error TransferFailed();

    constructor(address _seller, address _attorney, address _inspector) {
        require(_seller != address(0) && _attorney != address(0) && _inspector != address(0), "zero address");
        require(
            msg.sender != _seller && msg.sender != _attorney && msg.sender != _inspector &&
            _seller != _attorney && _seller != _inspector && _attorney != _inspector,
            "parties must differ"
        );
        buyer = msg.sender;
        seller = _seller;
        attorney = _attorney;
        inspector = _inspector;
    }

    /// @notice Buyer signs the contract and deposits exactly 10% of the price into the attorney's escrow.
    function openDeal(uint256 dealId, uint256 price, uint64 deadline, string calldata property) external payable {
        if (msg.sender != buyer) revert NotBuyer();
        Deal storage d = deals[dealId];
        if (d.status != Status.None || price == 0) revert BadDeal();
        if (msg.value != (price * DEPOSIT_BPS) / 10_000) revert WrongDeposit();
        require(deadline > block.timestamp, "deadline in past");
        d.price = price;
        d.deposit = msg.value;
        d.deadline = deadline;
        d.status = Status.Deposited;
        d.property = property;
        emit DealOpened(dealId, price, msg.value, deadline, property);
    }

    /// @notice Inspector records the home-inspection result (once). `evidence` is a report reference or audit hash.
    function recordInspection(uint256 dealId, bool passed, string calldata evidence) external {
        if (msg.sender != inspector) revert NotInspector();
        Deal storage d = deals[dealId];
        if (d.status != Status.Deposited) revert BadDeal();
        if (d.inspectionDone) revert AlreadyDone();
        d.inspectionDone = true;
        d.inspectionPassed = passed;
        emit InspectionRecorded(dealId, passed, evidence);
    }

    /// @notice Buyer records the final walkthrough, which can only happen after a passed inspection.
    function recordWalkthrough(uint256 dealId, bool passed, string calldata notes) external {
        if (msg.sender != buyer) revert NotBuyer();
        Deal storage d = deals[dealId];
        if (d.status != Status.Deposited) revert BadDeal();
        if (!d.inspectionDone || !d.inspectionPassed) revert InspectionNotPassed();
        if (d.walkthroughDone) revert AlreadyDone();
        d.walkthroughDone = true;
        d.walkthroughPassed = passed;
        emit WalkthroughRecorded(dealId, passed, notes);
    }

    function buyerApprove(uint256 dealId) external {
        if (msg.sender != buyer) revert NotBuyer();
        Deal storage d = _ready(dealId);
        if (d.buyerOk) revert AlreadyDone();
        d.buyerOk = true;
        emit BuyerApproved(dealId);
        _tryClose(dealId, d);
    }

    function sellerApprove(uint256 dealId) external {
        if (msg.sender != seller) revert NotSeller();
        Deal storage d = _ready(dealId);
        if (d.sellerOk) revert AlreadyDone();
        d.sellerOk = true;
        emit SellerApproved(dealId);
        _tryClose(dealId, d);
    }

    /// @notice Attorney returns the deposit to the buyer (inspection/walkthrough failed or a party backs out).
    function cancel(uint256 dealId, string calldata reason) external {
        if (msg.sender != attorney) revert NotAttorney();
        Deal storage d = deals[dealId];
        if (d.status != Status.Deposited) revert BadDeal();
        _refund(dealId, d, reason);
    }

    /// @notice Buyer reclaims the deposit if the deal is still open after the deadline.
    function refundAfterDeadline(uint256 dealId) external {
        if (msg.sender != buyer) revert NotBuyer();
        Deal storage d = deals[dealId];
        if (d.status != Status.Deposited) revert BadDeal();
        if (block.timestamp < d.deadline) revert TooEarly();
        _refund(dealId, d, "deadline passed");
    }

    function _ready(uint256 dealId) private view returns (Deal storage d) {
        d = deals[dealId];
        if (d.status != Status.Deposited) revert BadDeal();
        if (!d.inspectionDone || !d.inspectionPassed) revert InspectionNotPassed();
        if (!d.walkthroughDone || !d.walkthroughPassed) revert WalkthroughNotPassed();
    }

    function _tryClose(uint256 dealId, Deal storage d) private {
        if (!(d.buyerOk && d.sellerOk)) return;
        d.status = Status.Closed;
        uint256 amt = d.deposit;
        (bool ok, ) = seller.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit DealClosed(dealId, seller, amt);
    }

    function _refund(uint256 dealId, Deal storage d, string memory reason) private {
        d.status = Status.Cancelled;
        uint256 amt = d.deposit;
        (bool ok, ) = buyer.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit DealCancelled(dealId, buyer, amt, reason);
    }
}
