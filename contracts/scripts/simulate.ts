import hre from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deploymentsPath = path.resolve(here, "../../frontend/src/utils/deployments.json");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOTAL_STEPS = 60;
const STEP_DELAY_MS = 400;

interface Deployments {
  contracts: {
    tokenA: string;
    tokenB: string;
    ethFaucet: string;
    dex1: string;
    dex2: string;
    arbitrage: string;
  };
}

type Dex = Awaited<ReturnType<typeof asDex>>;

function asDex(ethers: any, address: string) {
  return ethers.getContractAt("MiniDEX", address);
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { ethers } = await hre.network.create();
  const deployments: Deployments = JSON.parse(await readFile(deploymentsPath, "utf8"));
  const { tokenA: tokenAAddress, tokenB: tokenBAddress, dex1: dex1Address, dex2: dex2Address, arbitrage: arbAddress } =
    deployments.contracts;

  const parseEther = ethers.parseEther;
  const formatEther = ethers.formatEther;

  const signers = await ethers.getSigners();
  const users = signers.slice(0, 20); // 20 个模拟用户
  console.log(`模拟用户数量：${users.length}`);

  const tokenA = await ethers.getContractAt("MockERC20", tokenAAddress);
  const tokenB = await ethers.getContractAt("MockERC20", tokenBAddress);
  const dexes: Dex[] = [await asDex(ethers, dex1Address), await asDex(ethers, dex2Address)];
  const dexNames = ["交易所 1", "交易所 2"];
  const arbitrage = await ethers.getContractAt("Arbitrage", arbAddress);

  // 1. 给每个用户发币并授权
  for (const user of users) {
    const balanceA: bigint = await tokenA.balanceOf(user.address);
    if (balanceA < parseEther("2000")) {
      await (await tokenA.mint(user.address, parseEther("20000"))).wait();
      await (await tokenB.mint(user.address, parseEther("20000"))).wait();
    }
    for (const dex of dexes) {
      const target = await dex.getAddress();
      await (await tokenA.connect(user).approve(target, ethers.MaxUint256)).wait();
      await (await tokenB.connect(user).approve(target, ethers.MaxUint256)).wait();
    }
    // 套利合约需要能拉走用户的 ZJU
    await (await tokenA.connect(user).approve(arbAddress, ethers.MaxUint256)).wait();
  }
  console.log("20 个用户已领取测试代币并完成授权（含套利合约）\n");

  const poolIds: number[] = [];
  for (const dex of dexes) {
    poolIds.push(Number(await dex.getPoolId(tokenAAddress, tokenBAddress)));
  }
  const ethPoolId = Number(await dexes[0].getPoolId(ZERO_ADDRESS, tokenAAddress));

  let actionCount = 0;
  let arbCount = 0;
  let currentStep = 0;
  const log = (message: string) =>
    console.log(`[${String(currentStep).padStart(2, "0")}/${TOTAL_STEPS}] ${message}`);

  for (let step = 0; step < TOTAL_STEPS; step++) {
    currentStep = step + 1;
    const user = users[Math.floor(Math.random() * users.length)];
    const dexIndex = Math.random() < 0.5 ? 0 : 1;
    const dex = dexes[dexIndex];
    const poolId = poolIds[dexIndex];
    const who = `${user.address.slice(0, 6)}…${user.address.slice(-4)}`;

    try {
      const dice = Math.random();

      if (dice < 0.6) {
        // 随机兑换：ZJU -> DXD 或 DXD -> ZJU
        const sellA = Math.random() < 0.5;
        const amountIn = parseEther(randomBetween(1, 200).toFixed(4));
        const tokenIn = sellA ? tokenAAddress : tokenBAddress;
        const out: bigint = await dex.quoteSwap(poolId, tokenIn, amountIn);
        if (out === 0n) continue;
        const tx = await dex.connect(user).swap(poolId, tokenIn, amountIn, (out * 97n) / 100n);
        await tx.wait();
        actionCount += 1;
        log(
          `${who} 在${dexNames[dexIndex]} 卖出 ${formatEther(amountIn)} ${sellA ? "ZJU" : "DXD"}，` +
            `换到 ${Number(formatEther(out)).toFixed(4)} ${sellA ? "DXD" : "ZJU"} (${tx.hash.slice(0, 10)}…)`,
        );
      } else if (dice < 0.85) {
        // 添加流动性（按当前比例）
        const pool = await dex.pools(poolId);
        const reserveA = BigInt(pool.reserveA);
        const reserveB = BigInt(pool.reserveB);
        if (reserveA === 0n) continue;
        const amountA = parseEther(randomBetween(10, 300).toFixed(4));
        const amountB = (amountA * reserveB) / reserveA;
        const tx = await dex.connect(user).addLiquidity(poolId, amountA, amountB);
        await tx.wait();
        actionCount += 1;
        log(
          `${who} 在${dexNames[dexIndex]} 添加流动性 ${formatEther(amountA)} ZJU + ${Number(formatEther(amountB)).toFixed(2)} DXD` +
            ` (${tx.hash.slice(0, 10)}…)`,
        );
      } else {
        // 撤销流动性：销毁自己的 NFT
        const count = Number(await dex.balanceOf(user.address));
        if (count === 0) continue;
        const nftId = BigInt(await dex.tokenOfOwnerByIndex(user.address, 0));
        const tx = await dex.connect(user).removeLiquidity(nftId);
        await tx.wait();
        actionCount += 1;
        log(`${who} 在${dexNames[dexIndex]} 销毁 NFT #${nftId} 撤销流动性 (${tx.hash.slice(0, 10)}…)`);
      }
    } catch (error: any) {
      console.log(`  跳过：${error.shortMessage ?? error.message}`);
    }

    // 偶尔让套利者出手：两个交易所出现价差就套利
    if (step % 6 === 5 && actionCount > 0) {
      try {
        const amountIn = parseEther("60");
        const opportunity = await arbitrage.checkOpportunity(
          dex1Address,
          poolIds[0],
          dex2Address,
          poolIds[1],
          tokenAAddress,
          amountIn,
        );
        const backward = await arbitrage.checkOpportunity(
          dex2Address,
          poolIds[1],
          dex1Address,
          poolIds[0],
          tokenAAddress,
          amountIn,
        );
        const arb = users[19];
        if (opportunity[2]) {
          const profit = opportunity[1] - amountIn;
          const tx = await arbitrage
            .connect(arb)
            .arbitrage(dex1Address, poolIds[0], dex2Address, poolIds[1], tokenAAddress, amountIn, 0n);
          await tx.wait();
          arbCount += 1;
          console.log(`[套利] ${arb.address.slice(0, 6)}… 在交易所1买入、交易所2卖出，利润 ${formatEther(profit)} ZJU`);
        } else if (backward[2]) {
          const tx = await arbitrage
            .connect(arb)
            .arbitrage(dex2Address, poolIds[1], dex1Address, poolIds[0], tokenAAddress, amountIn, 0n);
          await tx.wait();
          arbCount += 1;
          console.log(`[套利] ${arb.address.slice(0, 6)}… 在交易所2买入、交易所1卖出，利润 ${formatEther(backward[1] - amountIn)} ZJU`);
        }
      } catch (error: any) {
        console.log(`  套利跳过：${error.shortMessage ?? error.message}`);
      }
    }

    await sleep(STEP_DELAY_MS);
  }

  // 汇总
  console.log("\n================ 模拟结果 ================");
  console.log(`共执行 ${actionCount} 笔交易，其中套利 ${arbCount} 笔`);
  for (let i = 0; i < dexes.length; i++) {
    const pool = await dexes[i].pools(poolIds[i]);
    const reserveA = BigInt(pool.reserveA);
    const reserveB = BigInt(pool.reserveB);
    const price = reserveA === 0n ? 0 : Number(formatEther(reserveB)) / Number(formatEther(reserveA));
    console.log(
      `${dexNames[i]} ZJU/DXD 池#${poolIds[i]}：储备 ${Number(formatEther(reserveA)).toFixed(2)} ZJU / ` +
        `${Number(formatEther(reserveB)).toFixed(2)} DXD，价格 ${price.toFixed(6)}，LP 总量 ${Number(formatEther(pool.totalLP)).toFixed(2)}`,
    );
  }
  const ethPool = await dexes[0].pools(ethPoolId);
  console.log(
    `交易所 1 ETH/ZJU 池#${ethPoolId}：储备 ${Number(formatEther(ethPool.reserveA)).toFixed(4)} ETH / ` +
      `${Number(formatEther(ethPool.reserveB)).toFixed(2)} ZJU`,
  );

  let nftTotal = 0;
  for (const dex of dexes) {
    for (const user of users) {
      nftTotal += Number(await dex.balanceOf(user.address));
    }
  }
  console.log(`20 个用户当前持有流动性 NFT 共 ${nftTotal} 个`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
