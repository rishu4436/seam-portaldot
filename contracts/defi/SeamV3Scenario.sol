// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {SeamTestMarket} from "./SeamTestMarket.sol";
import {SeamTestToken, SeamReferenceVault, SeamGuardRouter} from "./SeamDeFi.sol";

/// @notice Read-only eth_call creation harness. Never deployed by the app and never commits chain state.
/// Runs the exact market contracts through swap -> deposit -> full redemption in the target VM.
contract SeamV3Scenario {
    constructor(bytes32 id) {
        SeamTestMarket market = new SeamTestMarket(id);
        SeamTestToken usd = market.usd();
        SeamTestToken eth = market.eth();
        SeamReferenceVault vault = market.vault();
        SeamGuardRouter guard = market.guard();
        address[] memory path = new address[](2);
        path[0] = address(usd);
        path[1] = address(eth);
        uint256 amount = 100 * 1e6;
        uint256 quoted = market.pool().getAmountsOut(amount, path)[1];
        uint256 gasPriceLimit = type(uint256).max;
        SeamGuardRouter.Order memory order = SeamGuardRouter.Order({
            deploymentId: id,
            planId: keccak256("scenario swap"),
            target: address(market.pool()),
            tokenIn: address(usd),
            tokenOut: address(eth),
            amountIn: amount,
            minAmountOut: (quoted * 995) / 1000,
            recipient: address(this),
            deadline: block.timestamp + 300,
            maxGasPrice: gasPriceLimit
        });
        usd.approve(address(guard), amount);
        uint256 output = guard.swap(order);
        require(usd.balanceOf(address(this)) == 9_900 * 1e6, "SWAP_DEBIT");
        require(eth.balanceOf(address(this)) == 10 * 1e18 + output, "SWAP_CREDIT");
        require(usd.allowance(address(this), address(guard)) == 0, "SWAP_ALLOWANCE");

        order.planId = keccak256("scenario deposit");
        order.target = address(vault);
        order.tokenOut = address(vault);
        order.minAmountOut = vault.previewDeposit(amount);
        usd.approve(address(guard), amount);
        uint256 shares = guard.deposit(order);
        require(shares > 0 && vault.balanceOf(address(this)) == shares, "DEPOSIT_SHARES");

        order.planId = keccak256("scenario redeem");
        order.tokenIn = address(vault);
        order.tokenOut = address(usd);
        order.amountIn = shares;
        order.minAmountOut = vault.previewRedeem(shares);
        vault.approve(address(guard), shares);
        uint256 assets = guard.redeem(order);
        require(assets == amount && vault.balanceOf(address(this)) == 0, "FULL_REDEMPTION");
        require(usd.balanceOf(address(this)) == 9_900 * 1e6, "FINAL_BALANCE");
        require(vault.allowance(address(this), address(guard)) == 0, "REDEEM_ALLOWANCE");
        bytes memory proof = abi.encode(
            uint256(1),
            output,
            shares,
            assets,
            usd.balanceOf(address(this)),
            eth.balanceOf(address(this))
        );
        assembly {
            return(add(proof, 32), mload(proof))
        }
    }
}
