import hre from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deploymentsPath = path.resolve(here, "../../frontend/src/utils/deployments.json");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

async function main() {
  const { ethers } = await hre.network.create();
  const deployments: Deployments = JSON.parse(await readFile(deploymentsPath, "utf8"));
  const { tokenA: tokenAAddress, tokenB: tokenBAddress, dex1: dex1Address, dex2: dex2Address } =
    deployments.contracts;

  const [deployer, ...others] = await ethers.getSigners();
  const users = [deployer, ...others.slice(0, 10)];

  const tokenA = await ethers.getContractAt("MockERC20", tokenAAddress);
  const tokenB = await ethers.getContractAt("MockERC20", tokenBAddress);
  const dex1 = await ethers.getContractAt("MiniDEX", dex1Address);
  const dex2 = await ethers.getContractAt("MiniDEX", dex2Address);

  const parseEther = ethers.parseEther;

  // 1. 给演示账户发币（faucet 也可以在前端点，这里直接 mint 方便批量）
  for (const user of users) {
    await (await tokenA.mint(user.address, parseEther("100000"))).wait();
    await (await tokenB.mint(user.address, parseEther("100000"))).wait();
  }
  console.log(`给 ${users.length} 个账户各发 100000 ZJU / 100000 DXD`);

  // 2. 授权
  for (const user of users) {
    await (await tokenA.connect(user).approve(dex1Address, ethers.MaxUint256)).wait();
    await (await tokenB.connect(user).approve(dex1Address, ethers.MaxUint256)).wait();
    await (await tokenA.connect(user).approve(dex2Address, ethers.MaxUint256)).wait();
    await (await tokenB.connect(user).approve(dex2Address, ethers.MaxUint256)).wait();
  }
  console.log("已授权两个交易所");

  // 3. 在交易所 1 创建 ZJU/DXD 与 ETH/ZJU 池子，在交易所 2 创建 ZJU/DXD 池子
  await (await dex1.createPool(tokenAAddress, tokenBAddress)).wait();
  await (await dex1.createPool(ZERO_ADDRESS, tokenAAddress)).wait();
  await (await dex2.createPool(tokenAAddress, tokenBAddress)).wait();
  console.log("池子创建完成");

  const pool1 = await dex1.getPoolId(tokenAAddress, tokenBAddress);
  const pool2 = await dex2.getPoolId(tokenAAddress, tokenBAddress);
  const ethPool = await dex1.getPoolId(ZERO_ADDRESS, tokenAAddress);

  // 4. 注入初始流动性：两个交易所价格不同，方便演示套利
  //    交易所 1：1 ZJU = 1 DXD
  await (
    await dex1.addLiquidity(pool1, parseEther("10000"), parseEther("10000"))
  ).wait();
  //    交易所 2：1 ZJU = 1.5 DXD（ZJU 更贵）
  await (
    await dex2.addLiquidity(pool2, parseEther("10000"), parseEther("15000"))
  ).wait();
  //    ETH 池：1 ETH 换 1000 ZJU
  await (
    await dex1.addLiquidity(ethPool, parseEther("10"), parseEther("10000"), {
      value: parseEther("10"),
    })
  ).wait();

  for (const [name, dex, id] of [
    ["交易所 1 ZJU/DXD", dex1, pool1],
    ["交易所 1 ETH/ZJU", dex1, ethPool],
    ["交易所 2 ZJU/DXD", dex2, pool2],
  ] as const) {
    const pool = await dex.pools(id);
    console.log(
      `${name} 池#${id} 储备：${ethers.formatEther(pool.reserveA)} / ${ethers.formatEther(pool.reserveB)}`,
    );
  }

  console.log("\n演示数据准备完成，可以直接在前端操作。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
