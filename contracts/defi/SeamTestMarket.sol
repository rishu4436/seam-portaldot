// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SeamTestToken,
    SeamReferencePool,
    SeamReferenceVault,
    SeamGuardRouter
} from "./SeamDeFi.sol";

/// @notice Disposable test market. Both assets are valueless faucet tokens; no native tPOT is pooled.
/// Source-reviewed engineering fixture, not an independently audited investment protocol.
contract SeamTestMarket {
    uint256 public constant DOLLARS_PER_CLAIM = 10_000 * 1e6;
    uint256 public constant ETHERS_PER_CLAIM = 10 * 1e18;
    address public immutable bootstrapper;
    SeamTestToken public immutable usd;
    SeamTestToken public immutable eth;
    SeamReferencePool public immutable pool;
    SeamReferenceVault public immutable vault;
    SeamGuardRouter public immutable guard;
    mapping(address => bool) public claimed;
    event TestAssetsClaimed(address indexed account, uint256 dollars, uint256 ethers);

    constructor(bytes32 deploymentId) {
        require(block.chainid == 31337 || block.chainid == 420420777, "TEST_NETWORK_ONLY");
        bootstrapper = msg.sender;
        usd = new SeamTestToken("Seam Test Dollar", "sUSD", 6);
        eth = new SeamTestToken("Seam Test Ether", "sETH", 18);
        pool = new SeamReferencePool(address(usd), address(eth));
        vault = new SeamReferenceVault(IERC20(address(usd)));
        guard = new SeamGuardRouter(deploymentId);

        usd.mint(address(this), 1_001_000 * 1e6);
        eth.mint(address(this), 500 * 1e18);
        usd.approve(address(pool), 1_000_000 * 1e6);
        eth.approve(address(pool), 500 * 1e18);
        pool.addLiquidity(1_000_000 * 1e6, 500 * 1e18, 1, msg.sender, block.timestamp + 600);
        usd.approve(address(vault), 1_000 * 1e6);
        // Seed shares stay in this contract. There is no withdrawal or administrative rescue method.
        vault.deposit(1_000 * 1e6, address(this));
        _claim(msg.sender);
    }

    /// @notice One fixture allocation per address. Sybil resistance and monetary value are not claimed.
    function claimTestAssets() external {
        _claim(msg.sender);
    }

    function _claim(address account) private {
        require(!claimed[account], "ALREADY_CLAIMED");
        claimed[account] = true;
        usd.mint(account, DOLLARS_PER_CLAIM);
        eth.mint(account, ETHERS_PER_CLAIM);
        emit TestAssetsClaimed(account, DOLLARS_PER_CLAIM, ETHERS_PER_CLAIM);
    }
}
