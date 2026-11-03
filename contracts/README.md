# MiniDEX 合约工程

Hardhat 3 + ethers v6 + TypeScript，Solidity 0.8.20，OpenZeppelin 5.4.0。

## 合约

| 文件 | 说明 |
| --- | --- |
| `contracts/MiniDEX.sol` | AMM 交易所：创建池子、添加/撤销流动性（ERC721 凭证）、兑换；0.3% 手续费留在储备中给 LP |
| `contracts/MockERC20.sol` | 测试代币，`faucet()` 每地址每 1 小时领 1000 枚，`mint()` 供模拟脚本批量发币 |
| `contracts/ETHFaucet.sol` | 测试以太币水龙头，每地址每 24 小时领 1 ETH |
| `contracts/Arbitrage.sol` | 跨交易所原子套利，无利润则整笔 revert |

## 常用命令

```bash
npm install
npm run compile      # hardhat build
npm run typecheck    # 编译 + tsc --noEmit
npm test             # 14 个单元测试（内存链，不需要启动节点）
npm run node         # 启动本地节点 127.0.0.1:8545，chainId 31337，20 个账户
npm run deploy       # 部署全部合约（需要节点在跑），地址写入 frontend/src/utils/
npm run seed         # 创建演示池子与初始流动性
npm run simulate     # 20 个模拟用户随机交易 + 套利
```

部署脚本使用节点自带的已解锁账户（`accounts: "remote"`），所以本地节点需要保持运行。

如果本地节点跑在别的端口，用环境变量覆盖：`LOCAL_RPC_URL=http://127.0.0.1:7545 npm run deploy`。

## 接口速查

`MiniDEX`：

- `createPool(address tokenA, address tokenB) returns (uint256 poolId)`
- `addLiquidity(uint256 poolId, uint256 amountA, uint256 amountB) payable returns (uint256 nftId, uint256 liquidity, uint256 usedA, uint256 usedB)`
- `removeLiquidity(uint256 nftId) returns (uint256 amountA, uint256 amountB)`
- `swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut) payable returns (uint256 amountOut)`
- `getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) pure returns (uint256)`
- `quoteSwap(uint256 poolId, address tokenIn, uint256 amountIn) view returns (uint256)`
- `getPools() / getReserves(poolId) / getPrice(poolId) / getPoolId(tokenA, tokenB) / getPoolNftIds(poolId)`
- `positions(nftId) returns (poolId, amount, timestamp)`，NFT 本身是 ERC721Enumerable

`Arbitrage`：

- `arbitrage(dexBuy, poolIdBuy, dexSell, poolIdSell, tokenIn, amountIn, minProfit) returns (uint256 profit)`
- `checkOpportunity(dexBuy, poolIdBuy, dexSell, poolIdSell, tokenIn, amountIn) view returns (amountMid, amountBack, profitable, buyPrice, sellPrice)`

原生 ETH 在池子里用 `address(0)` 表示。
