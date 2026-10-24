// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MilestoneEscrow
/// @notice Holds a contractor's funds per construction phase. A phase pays the
///         subcontractor only when 2 of 3 approvers (contractor, human inspector,
///         AI inspection agent) sign off. After the deadline, the contractor can
///         reclaim an unreleased phase.
contract MilestoneEscrow {
    enum Role { None, Contractor, Inspector, Agent }
    enum Status { None, Funded, Released, Refunded }

    struct Phase {
        uint256 amount;
        uint64 deadline;
        Status status;
        uint8 approvals;
        string description;
    }

    address public immutable contractor;
    address public immutable inspector;
    address public immutable agent;
    address payable public immutable subcontractor;
    uint8 public constant THRESHOLD = 2;

    mapping(uint256 => Phase) public phases;
    mapping(uint256 => mapping(address => bool)) public approvedBy;

    event PhaseFunded(uint256 indexed phaseId, uint256 amount, uint64 deadline, string description);
    event PhaseApproved(uint256 indexed phaseId, address indexed approver, Role role, uint8 approvals, string evidence);
    event PhaseReleased(uint256 indexed phaseId, address indexed to, uint256 amount);
    event PhaseRefunded(uint256 indexed phaseId, uint256 amount);

    error NotApprover();
    error NotContractor();
    error BadPhase();
    error AlreadyApproved();
    error TooEarly();
    error TransferFailed();

    constructor(address _inspector, address _agent, address payable _subcontractor) {
        require(_inspector != address(0) && _agent != address(0) && _subcontractor != address(0), "zero address");
        require(msg.sender != _inspector && msg.sender != _agent && _inspector != _agent, "approvers must differ");
        contractor = msg.sender;
        inspector = _inspector;
        agent = _agent;
        subcontractor = _subcontractor;
    }

    function roleOf(address who) public view returns (Role) {
        if (who == contractor) return Role.Contractor;
        if (who == inspector) return Role.Inspector;
        if (who == agent) return Role.Agent;
        return Role.None;
    }

    /// @notice Contractor locks funds for a phase.
    function fundPhase(uint256 phaseId, uint64 deadline, string calldata description) external payable {
        if (msg.sender != contractor) revert NotContractor();
        if (phases[phaseId].status != Status.None || msg.value == 0) revert BadPhase();
        require(deadline > block.timestamp, "deadline in past");
        phases[phaseId] = Phase(msg.value, deadline, Status.Funded, 0, description);
        emit PhaseFunded(phaseId, msg.value, deadline, description);
    }

    /// @notice An approver signs off. `evidence` is a short reference (e.g. an
    ///         audit-log hash or the payment tx hashes of the checks run).
    function approve(uint256 phaseId, string calldata evidence) external {
        Role role = roleOf(msg.sender);
        if (role == Role.None) revert NotApprover();
        Phase storage p = phases[phaseId];
        if (p.status != Status.Funded) revert BadPhase();
        if (approvedBy[phaseId][msg.sender]) revert AlreadyApproved();

        approvedBy[phaseId][msg.sender] = true;
        p.approvals += 1;
        emit PhaseApproved(phaseId, msg.sender, role, p.approvals, evidence);

        if (p.approvals >= THRESHOLD) {
            p.status = Status.Released;
            uint256 amt = p.amount;
            (bool ok, ) = subcontractor.call{value: amt}("");
            if (!ok) revert TransferFailed();
            emit PhaseReleased(phaseId, subcontractor, amt);
        }
    }

    /// @notice Contractor reclaims an unreleased phase after its deadline.
    function refund(uint256 phaseId) external {
        if (msg.sender != contractor) revert NotContractor();
        Phase storage p = phases[phaseId];
        if (p.status != Status.Funded) revert BadPhase();
        if (block.timestamp < p.deadline) revert TooEarly();
        p.status = Status.Refunded;
        uint256 amt = p.amount;
        (bool ok, ) = payable(contractor).call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit PhaseRefunded(phaseId, amt);
    }
}
