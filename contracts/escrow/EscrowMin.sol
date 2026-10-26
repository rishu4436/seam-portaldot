// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title SeamEscrowMin: size-trimmed SeamEscrow (P1-02 budget check). Same rules as Escrow.sol:
///        release() by the payer any time or by anyone at/after releaseBlock; refund() by the payer before it.
///        One mapping id => packed struct, one event, bare reverts, no getters.
contract SeamEscrowMin {
    struct E {
        address payer; // slot 0: payer (20) + releaseBlock (8) + state (1)
        uint64 releaseBlock;
        uint8 state; // 0 none, 1 deposited, 2 released, 3 refunded
        address payee; // slot 1: payee (20) + amount (12)
        uint96 amount;
    }

    uint256 private n;
    mapping(uint256 => E) private es;

    /// state: 1 deposited, 2 released, 3 refunded
    event Escrow(uint256 indexed id, uint8 state);

    function deposit(address payee, uint64 releaseBlock) external payable returns (uint256 id) {
        if (msg.value == 0 || msg.value >> 96 != 0 || payee == address(0)) revert();
        id = n++;
        es[id] = E(msg.sender, releaseBlock, 1, payee, uint96(msg.value));
        emit Escrow(id, 1);
    }

    function release(uint256 id) external {
        E storage e = es[id];
        if (e.state != 1 || (msg.sender != e.payer && block.number < e.releaseBlock)) revert();
        e.state = 2;
        emit Escrow(id, 2);
        _send(e.payee, e.amount);
    }

    function refund(uint256 id) external {
        E storage e = es[id];
        if (e.state != 1 || msg.sender != e.payer || block.number >= e.releaseBlock) revert();
        e.state = 3;
        emit Escrow(id, 3);
        _send(e.payer, e.amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert();
    }
}

/// @title SeamEscrowOne: one escrow per contract. payer/payee/releaseBlock are immutable (in code, not storage);
///        the constructor takes the deposit. Storage is a single `done` flag. One event.
contract SeamEscrowOne {
    address private immutable payer;
    address private immutable payee;
    uint256 private immutable releaseBlock;
    bool private done;

    /// how: 2 released, 3 refunded
    event Settled(uint8 how);

    constructor(address payee_, uint256 releaseBlock_) payable {
        if (msg.value == 0 || payee_ == address(0)) revert();
        payer = msg.sender;
        payee = payee_;
        releaseBlock = releaseBlock_;
    }

    function release() external {
        if (done || (msg.sender != payer && block.number < releaseBlock)) revert();
        done = true;
        emit Settled(2);
        _send(payee);
    }

    function refund() external {
        if (done || msg.sender != payer || block.number >= releaseBlock) revert();
        done = true;
        emit Settled(3);
        _send(payer);
    }

    function _send(address to) private {
        (bool ok, ) = payable(to).call{value: address(this).balance}("");
        if (!ok) revert();
    }
}
