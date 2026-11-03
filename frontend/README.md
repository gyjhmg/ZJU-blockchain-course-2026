# MiniDEX 前端

React 19 + Vite 8 + ethers v6，通过 MetaMask（`window.ethereum`）与本地 Hardhat 节点交互。

## 运行

先按仓库根目录 README 启动本地链并部署合约（部署脚本会把合约地址写入 `src/utils/deployments.json`，ABI 写入 `src/utils/abis/`），然后：

```bash
npm install
npm run start     # http://localhost:3000
```

MetaMask 需要添加网络：RPC `http://127.0.0.1:8545`，Chain ID `31337`，并导入 `npm run node` 打印的测试账户私钥。

`npm run build` 会先跑 `tsc --noEmit` 再打包。

## 页面

| 页面 | 说明 |
| --- | --- |
| 钱包 | 连接 MetaMask、查看 ETH/ZJU/DXD 余额、领取测试代币与测试 ETH |
| 交易池 | 切换交易所、查看所有池子的储备/价格、创建新池子（支持 ETH 池） |
| 流动性 | 添加流动性（自动 approve）、查看自己的 NFT、销毁 NFT 取回资产、查看某个池子的全部流动性来源 |
| 兑换 | 输入数量实时报价、显示现价/成交价/价格影响、带 1% 滑点保护的兑换 |
| 套利 | 对比两个交易所的价格差，预览两个方向的套利利润，一键执行原子套利并展示前后价格与利润 |

## 代码结构

- `src/utils/web3.ts`：合约实例、读链函数、钱包连接与网络切换、格式化工具
- `src/pages/*.tsx`：五个页面
- `src/types.ts`：页面共享的 `AppCtx`（账户、签名器、提示消息、刷新计数）
- 未连接钱包时页面用只读 provider 直接读链，方便查看数据；写操作需要连接钱包。

URL 上可以带 `?tab=wallet|pools|liquidity|swap|arbitrage` 直达某个页面。
