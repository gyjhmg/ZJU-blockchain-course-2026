// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MiniDEX —— 基于恒定乘积公式（x * y = k）的自动做市商交易所
/// @notice 支持任意两个代币组成交易池；原生 ETH 用 address(0) 表示，因此可以创建 A/B、A/ETH 等池子。
///         每次 swap 收取 0.3% 手续费，手续费直接留在储备中，由流动性提供者按份额分享。
///         流动性提供者拿到的是一个 ERC721 NFT，记录池子编号、份额与添加时间，销毁 NFT 即可取回资产。
contract MiniDEX is ERC721, ERC721Enumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 用 address(0) 代表原生 ETH
    address public constant ETH = address(0);
    /// @notice 手续费 0.3%：实际参与兑换的输入为 amountIn * 997 / 1000
    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;
    /// @notice 首次添加流动性时要求的最小份额，避免除零与粉尘池
    uint256 public constant MIN_LIQUIDITY = 1000;

    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 totalLP;
        uint256 createdTimestamp;
    }

    /// @notice 一份流动性头寸的信息，tokenId 即 NFT 编号
    struct Position {
        uint256 poolId;
        uint256 amount;
        uint256 timestamp;
    }

    /// @notice 池子总数，同时是最后一个池子的编号（池子编号从 1 开始）
    uint256 public poolCount;

    mapping(uint256 => Pool) public pools;
    /// @dev 代币对（按地址排序后）=> 池子编号，0 表示不存在
    mapping(address => mapping(address => uint256)) private _poolIdOf;
    mapping(uint256 => Position) public positions;
    /// @dev 池子 => 所有流动性 NFT 编号，便于前端列出"每个池子的流动性来源"
    mapping(uint256 => uint256[]) private _poolNftIds;

    uint256 private _nextNftId;

    event PoolCreated(uint256 poolId, address tokenA, address tokenB);
    event LiquidityAdded(
        uint256 poolId,
        uint256 nftId,
        address indexed provider,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    );
    event LiquidityRemoved(
        uint256 poolId,
        uint256 nftId,
        address indexed provider,
        uint256 amountA,
        uint256 amountB
    );
    event Swap(
        uint256 poolId,
        address indexed trader,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut
    );

    constructor() ERC721("MiniDEX LP Position", "MDEX-LP") {}

    // ---------------------------------------------------------------------
    // 交易池
    // ---------------------------------------------------------------------

    /// @notice 创建交易池，tokenA/tokenB 顺序无所谓，内部会按地址排序去重
    function createPool(address tokenA, address tokenB) external returns (uint256 poolId) {
        require(tokenA != ETH || tokenB != ETH, "MiniDEX: invalid pair");
        require(tokenA != tokenB, "MiniDEX: identical tokens");

        (address tA, address tB) = _sortTokens(tokenA, tokenB);
        require(_poolIdOf[tA][tB] == 0, "MiniDEX: pool exists");

        poolId = ++poolCount;
        pools[poolId] = Pool(tA, tB, 0, 0, 0, block.timestamp);
        _poolIdOf[tA][tB] = poolId;

        emit PoolCreated(poolId, tA, tB);
    }

    /// @notice 查询代币对对应的池子编号，0 表示尚未创建
    function getPoolId(address tokenA, address tokenB) external view returns (uint256) {
        (address tA, address tB) = _sortTokens(tokenA, tokenB);
        return _poolIdOf[tA][tB];
    }

    /// @notice 一次性取出所有池子，方便前端渲染
    function getPools() external view returns (Pool[] memory list) {
        list = new Pool[](poolCount);
        for (uint256 i = 1; i <= poolCount; i++) {
            list[i - 1] = pools[i];
        }
    }

    function getReserves(uint256 poolId) external view returns (uint256 reserveA, uint256 reserveB) {
        Pool storage pool = _requirePool(poolId);
        return (pool.reserveA, pool.reserveB);
    }

    /// @notice 某个池子当前所有流动性 NFT 的编号
    function getPoolNftIds(uint256 poolId) external view returns (uint256[] memory) {
        return _poolNftIds[poolId];
    }

    /// @notice 当前价格：1 个 tokenA 值多少个 tokenB（18 位定点数）
    function getPrice(uint256 poolId) external view returns (uint256) {
        Pool storage pool = _requirePool(poolId);
        if (pool.reserveA == 0) return 0;
        return pool.reserveB * 1e18 / pool.reserveA;
    }

    // ---------------------------------------------------------------------
    // 流动性
    // ---------------------------------------------------------------------

    /// @notice 添加流动性，铸造一个 ERC721 NFT 作为凭证
    /// @param amountA 愿意投入的 tokenA 数量（若 tokenA 是 ETH，则必须与 msg.value 一致）
    /// @param amountB 愿意投入的 tokenB 数量
    /// @return nftId 流动性凭证编号
    /// @return liquidity 本次实际获得的份额
    /// @return usedA 实际投入的 tokenA（非首次添加时可能少于 amountA，按比例取用）
    /// @return usedB 实际投入的 tokenB
    function addLiquidity(uint256 poolId, uint256 amountA, uint256 amountB)
        external
        payable
        nonReentrant
        returns (uint256 nftId, uint256 liquidity, uint256 usedA, uint256 usedB)
    {
        Pool storage pool = _requirePool(poolId);
        require(amountA > 0 && amountB > 0, "MiniDEX: zero amount");

        if (pool.tokenA == ETH) {
            require(msg.value == amountA, "MiniDEX: ETH amount mismatch");
        } else {
            require(msg.value == 0, "MiniDEX: unexpected ETH");
        }

        if (pool.totalLP == 0) {
            liquidity = Math.sqrt(amountA * amountB);
            require(liquidity > MIN_LIQUIDITY, "MiniDEX: liquidity too low");
            usedA = amountA;
            usedB = amountB;
        } else {
            // 按现有储备比例折算份额，取两边的较小值，保证不会破坏价格
            uint256 liquidityFromA = amountA * pool.totalLP / pool.reserveA;
            uint256 liquidityFromB = amountB * pool.totalLP / pool.reserveB;
            liquidity = Math.min(liquidityFromA, liquidityFromB);
            require(liquidity > 0, "MiniDEX: liquidity too low");

            usedA = liquidity * pool.reserveA / pool.totalLP;
            usedB = liquidity * pool.reserveB / pool.totalLP;
        }

        // 拉取资产：ETH 已经在 msg.value 里
        if (pool.tokenA != ETH) {
            IERC20(pool.tokenA).safeTransferFrom(msg.sender, address(this), usedA);
        } else if (msg.value > usedA) {
            // 非首次添加被取整截断时，把多余的 ETH 退回
            _sendETH(msg.sender, msg.value - usedA);
        }
        IERC20(pool.tokenB).safeTransferFrom(msg.sender, address(this), usedB);

        pool.reserveA += usedA;
        pool.reserveB += usedB;
        pool.totalLP += liquidity;

        nftId = ++_nextNftId;
        positions[nftId] = Position(poolId, liquidity, block.timestamp);
        _poolNftIds[poolId].push(nftId);
        _mint(msg.sender, nftId);

        emit LiquidityAdded(poolId, nftId, msg.sender, usedA, usedB, liquidity);
    }

    /// @notice 销毁流动性 NFT，取回对应比例的两种代币（含累积的手续费）
    function removeLiquidity(uint256 nftId)
        external
        nonReentrant
        returns (uint256 amountA, uint256 amountB)
    {
        require(_ownerOf(nftId) == msg.sender, "MiniDEX: not position owner");

        Position memory position = positions[nftId];
        Pool storage pool = _requirePool(position.poolId);
        require(pool.totalLP > 0, "MiniDEX: empty pool");

        amountA = position.amount * pool.reserveA / pool.totalLP;
        amountB = position.amount * pool.reserveB / pool.totalLP;
        require(amountA > 0 && amountB > 0, "MiniDEX: nothing to withdraw");

        pool.reserveA -= amountA;
        pool.reserveB -= amountB;
        pool.totalLP -= position.amount;

        delete positions[nftId];
        _removeNftFromPool(position.poolId, nftId);
        _burn(nftId);

        _send(pool.tokenA, msg.sender, amountA);
        _send(pool.tokenB, msg.sender, amountB);

        emit LiquidityRemoved(position.poolId, nftId, msg.sender, amountA, amountB);
    }

    // ---------------------------------------------------------------------
    // 兑换
    // ---------------------------------------------------------------------

    /// @notice 恒定乘积定价：扣掉 0.3% 手续费后能换到多少输出代币
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        require(reserveIn > 0 && reserveOut > 0, "MiniDEX: empty reserve");
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        return amountInWithFee * reserveOut / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    /// @notice 报价：在这个池子里用 amountIn 个 tokenIn 能换到多少 tokenOut
    function quoteSwap(uint256 poolId, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256)
    {
        Pool storage pool = _requirePool(poolId);
        if (tokenIn == pool.tokenA) {
            return getAmountOut(amountIn, pool.reserveA, pool.reserveB);
        }
        require(tokenIn == pool.tokenB, "MiniDEX: unknown token");
        return getAmountOut(amountIn, pool.reserveB, pool.reserveA);
    }

    /// @notice 用 tokenIn 换出另一种代币
    /// @param minAmountOut 滑点保护，实际输出少于该值则回滚
    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        Pool storage pool = _requirePool(poolId);
        require(amountIn > 0, "MiniDEX: zero input");

        bool aIn = tokenIn == pool.tokenA;
        require(aIn || tokenIn == pool.tokenB, "MiniDEX: unknown token");

        uint256 reserveIn = aIn ? pool.reserveA : pool.reserveB;
        uint256 reserveOut = aIn ? pool.reserveB : pool.reserveA;

        if (tokenIn == ETH) {
            require(msg.value == amountIn, "MiniDEX: ETH amount mismatch");
        } else {
            require(msg.value == 0, "MiniDEX: unexpected ETH");
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut > 0, "MiniDEX: insufficient output");
        require(amountOut >= minAmountOut, "MiniDEX: slippage");
        require(amountOut < reserveOut, "MiniDEX: insufficient liquidity");

        // 更新储备：输入全部进入储备（0.3% 手续费就此留给流动性提供者）
        if (aIn) {
            pool.reserveA = reserveIn + amountIn;
            pool.reserveB = reserveOut - amountOut;
        } else {
            pool.reserveB = reserveIn + amountIn;
            pool.reserveA = reserveOut - amountOut;
        }

        address tokenOut = aIn ? pool.tokenB : pool.tokenA;
        _send(tokenOut, msg.sender, amountOut);

        emit Swap(poolId, msg.sender, tokenIn, amountIn, tokenOut, amountOut);
    }

    // ---------------------------------------------------------------------
    // NFT 元数据
    // ---------------------------------------------------------------------

    /// @notice 链上生成 NFT 元数据：池子编号、两种代币、份额、添加时间
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);

        Position memory position = positions[tokenId];
        Pool memory pool = pools[position.poolId];

        string memory json = string.concat(
            '{"name":"MiniDEX LP #',
            Strings.toString(tokenId),
            '","description":"MiniDEX liquidity position","attributes":[',
            '{"trait_type":"poolId","value":',
            Strings.toString(position.poolId),
            '},{"trait_type":"tokenA","value":"',
            Strings.toHexString(pool.tokenA),
            '"},{"trait_type":"tokenB","value":"',
            Strings.toHexString(pool.tokenB),
            '"},{"trait_type":"liquidity","value":',
            Strings.toString(position.amount),
            '},{"trait_type":"createdAt","value":',
            Strings.toString(position.timestamp),
            "}]}"
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ---------------------------------------------------------------------
    // 内部工具
    // ---------------------------------------------------------------------

    function _requirePool(uint256 poolId) private view returns (Pool storage pool) {
        require(poolId > 0 && poolId <= poolCount, "MiniDEX: pool not found");
        return pools[poolId];
    }

    function _sortTokens(address tokenA, address tokenB) private pure returns (address, address) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == ETH) {
            _sendETH(to, amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _sendETH(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "MiniDEX: ETH transfer failed");
    }

    function _removeNftFromPool(uint256 poolId, uint256 nftId) private {
        uint256[] storage ids = _poolNftIds[poolId];
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == nftId) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                return;
            }
        }
    }

    // ERC721Enumerable 需要的重写

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
