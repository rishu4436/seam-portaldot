// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IV2Router {
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) external view returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

/// @notice Development token. Minting is restricted to the local deployer; never a live asset representation.
contract SeamTestToken is ERC20 {
    address public immutable issuer;
    uint8 private immutable precision;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        issuer = msg.sender;
        precision = decimals_;
    }
    function decimals() public view override returns (uint8) {
        return precision;
    }
    function mint(address to, uint256 value) external {
        require(msg.sender == issuer, "ISSUER_ONLY");
        _mint(to, value);
    }
}

/// @notice Local reference venue with a two-token Uniswap-V2-compatible router interface.
/// It is experimental reference code, not an audited production market.
contract SeamReferencePool is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable token0;
    address public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed recipient,
        uint256 amountIn,
        uint256 amountOut
    );
    constructor(address a, address b) ERC20("Seam reference LP", "sLP") {
        require(a != address(0) && b != address(0) && a != b, "TOKENS");
        token0 = a;
        token1 = b;
    }
    function _reserves(address input) internal view returns (uint256 x, uint256 y) {
        require(input == token0 || input == token1, "TOKEN");
        return input == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }
    function _sync() internal {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }
    function addLiquidity(
        uint256 a,
        uint256 b,
        uint256 minShares,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256 shares) {
        require(block.timestamp <= deadline && a > 0 && b > 0 && to != address(0), "LIQUIDITY");
        uint256 supply = totalSupply();
        if (supply == 0) {
            shares = Math.sqrt(a * b);
            require(shares > 1000, "MIN_LIQUIDITY");
            shares -= 1000;
            _mint(address(0xdead), 1000);
        } else {
            shares = Math.min(Math.mulDiv(a, supply, reserve0), Math.mulDiv(b, supply, reserve1));
        }
        require(shares > 0 && shares >= minShares, "MIN_SHARES");
        uint256 before0 = IERC20(token0).balanceOf(address(this));
        uint256 before1 = IERC20(token1).balanceOf(address(this));
        IERC20(token0).safeTransferFrom(msg.sender, address(this), a);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), b);
        require(
            IERC20(token0).balanceOf(address(this)) - before0 == a &&
                IERC20(token1).balanceOf(address(this)) - before1 == b,
            "NONSTANDARD_TOKEN"
        );
        _mint(to, shares);
        _sync();
    }
    function removeLiquidity(
        uint256 shares,
        uint256 min0,
        uint256 min1,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256 a, uint256 b) {
        require(block.timestamp <= deadline && shares > 0 && to != address(0), "LIQUIDITY");
        a = Math.mulDiv(shares, reserve0, totalSupply());
        b = Math.mulDiv(shares, reserve1, totalSupply());
        require(a >= min0 && b >= min1, "MIN_OUTPUT");
        _burn(msg.sender, shares);
        IERC20(token0).safeTransfer(to, a);
        IERC20(token1).safeTransfer(to, b);
        _sync();
    }
    function getAmountsOut(
        uint256 amountIn,
        address[] calldata path
    ) public view returns (uint256[] memory amounts) {
        require(
            path.length == 2 && path[0] != path[1] && (path[1] == token0 || path[1] == token1),
            "PATH"
        );
        (uint256 x, uint256 y) = _reserves(path[0]);
        require(amountIn > 0 && x > 0 && y > 0, "NO_LIQUIDITY");
        uint256 weighted = amountIn * 997;
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = Math.mulDiv(weighted, y, x * 1000 + weighted);
        require(amounts[1] > 0 && amounts[1] < y, "DUST");
    }
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 minOut,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        require(
            block.timestamp <= deadline && to != address(0) && to != address(this),
            "DEADLINE_RECIPIENT"
        );
        amounts = getAmountsOut(amountIn, path);
        require(amounts[1] >= minOut, "MIN_OUTPUT");
        uint256 beforeIn = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        require(
            IERC20(path[0]).balanceOf(address(this)) - beforeIn == amountIn,
            "NONSTANDARD_TOKEN"
        );
        IERC20(path[1]).safeTransfer(to, amounts[1]);
        _sync();
        emit Swap(msg.sender, path[0], to, amountIn, amounts[1]);
    }
}

/// @notice Local ERC-4626 reference vault. It holds assets and advertises no yield strategy or APY.
contract SeamReferenceVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Seam reference vault shares", "svUSD") ERC4626(asset_) {}
}

/// @notice Transaction-scoped postconditions for V2 swaps and ERC-4626 deposit/redeem.
/// The caller chooses the venue. No owner, upgrades, pooled user custody, keeper or rescue authority.
contract SeamGuardRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public immutable deploymentId;
    mapping(address => mapping(bytes32 => bool)) public consumed;
    struct Order {
        bytes32 deploymentId;
        bytes32 planId;
        address target;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint256 deadline;
        uint256 maxGasPrice;
    }
    event ActionExecuted(
        bytes32 indexed planId,
        address indexed actor,
        uint8 kind,
        address target,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );
    constructor(bytes32 id) {
        require(id != bytes32(0), "DEPLOYMENT_ID");
        deploymentId = id;
    }
    function _check(Order calldata o) internal {
        require(o.deploymentId == deploymentId, "DEPLOYMENT_CHANGED");
        require(
            o.planId != bytes32(0) &&
                o.target.code.length > 0 &&
                o.tokenIn.code.length > 0 &&
                o.tokenOut.code.length > 0,
            "IDENTITY"
        );
        require(
            o.amountIn > 0 &&
                o.minAmountOut > 0 &&
                o.recipient != address(0) &&
                o.recipient != address(this),
            "AMOUNT_RECIPIENT"
        );
        require(block.timestamp <= o.deadline && tx.gasprice <= o.maxGasPrice, "DEADLINE_GAS");
        require(!consumed[msg.sender][o.planId], "PLAN_CONSUMED");
        consumed[msg.sender][o.planId] = true;
    }
    function _pull(address token, uint256 amount) internal returns (uint256 beforeBalance) {
        beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        require(
            IERC20(token).balanceOf(address(this)) - beforeBalance == amount,
            "NONSTANDARD_TOKEN"
        );
    }
    function swap(Order calldata o) external nonReentrant returns (uint256 amountOut) {
        _check(o);
        require(o.tokenIn != o.tokenOut, "TOKENS");
        uint256 beforeRouter = _pull(o.tokenIn, o.amountIn);
        uint256 beforeOut = IERC20(o.tokenOut).balanceOf(o.recipient);
        IERC20(o.tokenIn).forceApprove(o.target, o.amountIn);
        address[] memory path = new address[](2);
        path[0] = o.tokenIn;
        path[1] = o.tokenOut;
        IV2Router(o.target).swapExactTokensForTokens(
            o.amountIn,
            o.minAmountOut,
            path,
            o.recipient,
            o.deadline
        );
        IERC20(o.tokenIn).forceApprove(o.target, 0);
        amountOut = IERC20(o.tokenOut).balanceOf(o.recipient) - beforeOut;
        require(
            amountOut >= o.minAmountOut &&
                IERC20(o.tokenIn).balanceOf(address(this)) == beforeRouter,
            "POSTCONDITION"
        );
        emit ActionExecuted(
            o.planId,
            msg.sender,
            0,
            o.target,
            o.tokenIn,
            o.tokenOut,
            o.amountIn,
            amountOut,
            o.recipient
        );
    }
    function deposit(Order calldata o) external nonReentrant returns (uint256 shares) {
        _check(o);
        require(o.tokenOut == o.target && IERC4626(o.target).asset() == o.tokenIn, "VAULT_ASSET");
        uint256 beforeRouter = _pull(o.tokenIn, o.amountIn);
        uint256 beforeOut = IERC20(o.target).balanceOf(o.recipient);
        IERC20(o.tokenIn).forceApprove(o.target, o.amountIn);
        uint256 returned = IERC4626(o.target).deposit(o.amountIn, o.recipient);
        IERC20(o.tokenIn).forceApprove(o.target, 0);
        shares = IERC20(o.target).balanceOf(o.recipient) - beforeOut;
        require(
            shares == returned &&
                shares >= o.minAmountOut &&
                IERC20(o.tokenIn).balanceOf(address(this)) == beforeRouter,
            "POSTCONDITION"
        );
        emit ActionExecuted(
            o.planId,
            msg.sender,
            1,
            o.target,
            o.tokenIn,
            o.tokenOut,
            o.amountIn,
            shares,
            o.recipient
        );
    }
    function redeem(Order calldata o) external nonReentrant returns (uint256 assets) {
        _check(o);
        require(o.tokenIn == o.target && IERC4626(o.target).asset() == o.tokenOut, "VAULT_ASSET");
        uint256 beforeShares = IERC20(o.target).balanceOf(msg.sender);
        uint256 beforeOut = IERC20(o.tokenOut).balanceOf(o.recipient);
        uint256 returned = IERC4626(o.target).redeem(o.amountIn, o.recipient, msg.sender);
        assets = IERC20(o.tokenOut).balanceOf(o.recipient) - beforeOut;
        require(
            assets == returned &&
                assets >= o.minAmountOut &&
                beforeShares - IERC20(o.target).balanceOf(msg.sender) == o.amountIn,
            "POSTCONDITION"
        );
        emit ActionExecuted(
            o.planId,
            msg.sender,
            2,
            o.target,
            o.tokenIn,
            o.tokenOut,
            o.amountIn,
            assets,
            o.recipient
        );
    }
}
