import { parseAbi } from "viem";
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const poolAbi = parseAbi([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
]);
export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
]);
export const guardAbi = parseAbi([
  "function deploymentId() view returns (bytes32)",
  "function consumed(address,bytes32) view returns (bool)",
  "function swap((bytes32 deploymentId,bytes32 planId,address target,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline,uint256 maxGasPrice) order) returns (uint256)",
  "function deposit((bytes32 deploymentId,bytes32 planId,address target,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline,uint256 maxGasPrice) order) returns (uint256)",
  "function redeem((bytes32 deploymentId,bytes32 planId,address target,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline,uint256 maxGasPrice) order) returns (uint256)",
  "event ActionExecuted(bytes32 indexed planId,address indexed actor,uint8 kind,address target,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,address recipient)",
]);
