// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMiniDEX {
    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        payable
        returns (uint256 amountOut);

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256);

    function pools(uint256 poolId)
        external
        view
        returns (
            address tokenA,
            address tokenB,
            uint256 reserveA,
            uint256 reserveB,
            uint256 totalLP,
            uint256 createdTimestamp
        );
}

/// @title 原子套利合约
/// @notice 两个 MiniDEX 的同币对池子存在价格差时，用一笔交易完成"低价买入 + 高价卖出"。
///         如果最后没有利润（或利润低于 minProfit），整笔交易 revert，不会留下任何中间状态。
contract Arbitrage is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant PRICE_SCALE = 1e18;

    struct PoolInfo {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
    }

    /// @dev 套利过程的中间结果，集中放在结构体里避免局部变量过多导致 stack too deep
    struct ArbResult {
        uint256 amountMid;
        uint256 amountBack;
        uint256 profit;
        uint256 buyPriceBefore;
        uint256 buyPriceAfter;
        uint256 sellPriceBefore;
        uint256 sellPriceAfter;
    }

    event ArbitrageExecuted(
        address indexed caller,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountMid,
        uint256 amountBack,
        uint256 profit,
        uint256 buyPriceBefore,
        uint256 buyPriceAfter,
        uint256 sellPriceBefore,
        uint256 sellPriceAfter
    );

    /// @notice 只读检查当前套利空间，供前端展示（不发起交易）
    /// @return amountMid 在 dexBuy 换到的中间代币数量
    /// @return amountBack 把中间代币在 dexSell 卖回 tokenIn 得到的数量
    /// @return profitable 是否有利可图
    /// @return buyPrice / sellPrice 两个池子的价格（tokenB per tokenA，18 位定点）
    function checkOpportunity(
        IMiniDEX dexBuy,
        uint256 poolIdBuy,
        IMiniDEX dexSell,
        uint256 poolIdSell,
        address tokenIn,
        uint256 amountIn
    )
        public
        view
        returns (
            uint256 amountMid,
            uint256 amountBack,
            bool profitable,
            uint256 buyPrice,
            uint256 sellPrice
        )
    {
        require(amountIn > 0, "Arb: zero amount");

        (PoolInfo memory buyPool, PoolInfo memory sellPool, address tokenOut) =
            _route(dexBuy, poolIdBuy, dexSell, poolIdSell, tokenIn);

        (amountMid, amountBack) = _quote(buyPool, sellPool, tokenIn, tokenOut, amountIn);

        buyPrice = _price(buyPool.reserveA, buyPool.reserveB);
        sellPrice = _price(sellPool.reserveA, sellPool.reserveB);
        profitable = amountBack > amountIn;
    }

    /// @notice 执行套利：在 dexBuy 用 tokenIn 买入 tokenOut，再在 dexSell 把 tokenOut 卖回 tokenIn
    /// @param minProfit 最少要求的利润，达不到就 revert（整笔交易失败，链上状态不变）
    function arbitrage(
        IMiniDEX dexBuy,
        uint256 poolIdBuy,
        IMiniDEX dexSell,
        uint256 poolIdSell,
        address tokenIn,
        uint256 amountIn,
        uint256 minProfit
    ) external nonReentrant returns (uint256) {
        require(amountIn > 0, "Arb: zero amount");

        (PoolInfo memory buyPool, PoolInfo memory sellPool, address tokenOut) =
            _route(dexBuy, poolIdBuy, dexSell, poolIdSell, tokenIn);

        ArbResult memory result;
        result.buyPriceBefore = _price(buyPool.reserveA, buyPool.reserveB);
        result.sellPriceBefore = _price(sellPool.reserveA, sellPool.reserveB);

        uint256 startBalance = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        (result.amountMid, result.amountBack) =
            _swapRound(dexBuy, poolIdBuy, dexSell, poolIdSell, tokenIn, tokenOut, amountIn);

        uint256 endBalance = IERC20(tokenIn).balanceOf(address(this));
        require(endBalance >= startBalance + amountIn, "Arb: no profit");

        result.profit = endBalance - startBalance - amountIn;
        require(result.profit >= minProfit, "Arb: profit below minimum");

        IERC20(tokenIn).safeTransfer(msg.sender, amountIn + result.profit);

        (result.buyPriceAfter, result.sellPriceAfter) =
            _pricesAfter(dexBuy, poolIdBuy, dexSell, poolIdSell);

        emit ArbitrageExecuted(
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            result.amountMid,
            result.amountBack,
            result.profit,
            result.buyPriceBefore,
            result.buyPriceAfter,
            result.sellPriceBefore,
            result.sellPriceAfter
        );

        return result.profit;
    }

    // ---------------------------------------------------------------------
    // 内部工具
    // ---------------------------------------------------------------------

    /// @dev 校验两个池子的币对一致，并推导出中间代币
    function _route(
        IMiniDEX dexBuy,
        uint256 poolIdBuy,
        IMiniDEX dexSell,
        uint256 poolIdSell,
        address tokenIn
    ) private view returns (PoolInfo memory buyPool, PoolInfo memory sellPool, address tokenOut) {
        require(address(dexBuy) != address(0) && address(dexSell) != address(0), "Arb: zero dex");

        buyPool = _loadPool(dexBuy, poolIdBuy);
        sellPool = _loadPool(dexSell, poolIdSell);

        require(
            buyPool.tokenA == sellPool.tokenA && buyPool.tokenB == sellPool.tokenB,
            "Arb: pair mismatch"
        );
        require(tokenIn == buyPool.tokenA || tokenIn == buyPool.tokenB, "Arb: token not in pool");

        tokenOut = tokenIn == buyPool.tokenA ? buyPool.tokenB : buyPool.tokenA;
    }

    function _loadPool(IMiniDEX dex, uint256 poolId) private view returns (PoolInfo memory info) {
        (info.tokenA, info.tokenB, info.reserveA, info.reserveB, , ) = dex.pools(poolId);
    }

    /// @dev 两笔兑换的理论输出（按交易前的储备计算）
    function _quote(
        PoolInfo memory buyPool,
        PoolInfo memory sellPool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private pure returns (uint256 amountMid, uint256 amountBack) {
        bool aIn = tokenIn == buyPool.tokenA;
        amountMid = _getAmountOut(
            amountIn,
            aIn ? buyPool.reserveA : buyPool.reserveB,
            aIn ? buyPool.reserveB : buyPool.reserveA
        );

        bool midIsSellA = tokenOut == sellPool.tokenA;
        amountBack = _getAmountOut(
            amountMid,
            midIsSellA ? sellPool.reserveA : sellPool.reserveB,
            midIsSellA ? sellPool.reserveB : sellPool.reserveA
        );
    }

    /// @dev 与 MiniDEX 内公式一致：恒定乘积 + 0.3% 手续费
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256)
    {
        if (reserveIn == 0 || reserveOut == 0) return 0;
        uint256 amountInWithFee = amountIn * 997;
        return amountInWithFee * reserveOut / (reserveIn * 1000 + amountInWithFee);
    }

    /// @dev 两笔兑换：先在 dexBuy 买，再到 dexSell 卖
    function _swapRound(
        IMiniDEX dexBuy,
        uint256 poolIdBuy,
        IMiniDEX dexSell,
        uint256 poolIdSell,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private returns (uint256 amountMid, uint256 amountBack) {
        IERC20(tokenIn).forceApprove(address(dexBuy), amountIn);
        amountMid = dexBuy.swap(poolIdBuy, tokenIn, amountIn, 1);
        IERC20(tokenIn).forceApprove(address(dexBuy), 0);

        IERC20(tokenOut).forceApprove(address(dexSell), amountMid);
        amountBack = dexSell.swap(poolIdSell, tokenOut, amountMid, 1);
        IERC20(tokenOut).forceApprove(address(dexSell), 0);
    }

    function _pricesAfter(
        IMiniDEX dexBuy,
        uint256 poolIdBuy,
        IMiniDEX dexSell,
        uint256 poolIdSell
    ) private view returns (uint256 buyPrice, uint256 sellPrice) {
        PoolInfo memory buyPool = _loadPool(dexBuy, poolIdBuy);
        PoolInfo memory sellPool = _loadPool(dexSell, poolIdSell);
        buyPrice = _price(buyPool.reserveA, buyPool.reserveB);
        sellPrice = _price(sellPool.reserveA, sellPool.reserveB);
    }

    /// @dev 以 tokenB / tokenA 表示价格，18 位定点
    function _price(uint256 reserveA, uint256 reserveB) private pure returns (uint256) {
        if (reserveA == 0) return 0;
        return reserveB * PRICE_SCALE / reserveA;
    }
}
