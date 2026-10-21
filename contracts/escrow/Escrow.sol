// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SeamEscrow: a minimal escrow for the SEAM Revive demo (P1-02).
/// @notice deposit() locks native value for a payee. release() pays the payee: the payer at any time, anyone once
///         block.number >= releaseAfterBlock. refund() returns it to the payer, only before releaseAfterBlock.
///         State is deterministic (ids count up from 0, no timestamps, no randomness) and every state change emits
///         one event. The only external interaction is the native value transfer to payee or payer.
contract SeamEscrow {
    enum State {
        None,
        Deposited,
        Released,
        Refunded
    }

    struct Escrow {
        address payer;
        address payee;
        uint128 amount;
        uint64 releaseAfterBlock;
        State state;
    }

    uint64 public nextId;
    mapping(uint64 => Escrow) public escrows;

    event Deposited(uint64 indexed id, address indexed payer, address indexed payee, uint128 amount, uint64 releaseAfterBlock);
    event Released(uint64 indexed id, address indexed payee, uint128 amount);
    event Refunded(uint64 indexed id, address indexed payer, uint128 amount);

    error ZeroValue();
    error ZeroPayee();
    error NotDeposited(uint64 id);
    error NotAllowed(uint64 id);
    error TooLate(uint64 id);
    error TransferFailed(uint64 id);

    function deposit(address payee, uint64 releaseAfterBlock) external payable returns (uint64 id) {
        if (msg.value == 0 || msg.value > type(uint128).max) revert ZeroValue();
        if (payee == address(0)) revert ZeroPayee();
        id = nextId++;
        escrows[id] = Escrow(msg.sender, payee, uint128(msg.value), releaseAfterBlock, State.Deposited);
        emit Deposited(id, msg.sender, payee, uint128(msg.value), releaseAfterBlock);
    }

    function release(uint64 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Deposited) revert NotDeposited(id);
        if (msg.sender != e.payer && block.number < e.releaseAfterBlock) revert NotAllowed(id);
        e.state = State.Released;
        emit Released(id, e.payee, e.amount);
        _send(id, e.payee, e.amount);
    }

    function refund(uint64 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Deposited) revert NotDeposited(id);
        if (msg.sender != e.payer) revert NotAllowed(id);
        if (block.number >= e.releaseAfterBlock) revert TooLate(id);
        e.state = State.Refunded;
        emit Refunded(id, e.payer, e.amount);
        _send(id, e.payer, e.amount);
    }

    /// State is set before the transfer (checks-effects-interactions), so a re-entering payee finds it settled.
    function _send(uint64 id, address to, uint128 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed(id);
    }
}
