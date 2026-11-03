import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendUtils = path.resolve(here, "../../frontend/src/utils");

const TOKENS = [
  { name: "ZJU Coin", symbol: "ZJU" },
  { name: "Dex Dollar", symbol: "DXD" },
];

const ARTIFACTS = ["MiniDEX", "MockERC20", "ETHFaucet", "Arbitrage"];

async function main() {
  const { ethers } = await hre.network.create();
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`deployer : ${deployer.address}`);
  console.log(`chainId  : ${network.chainId}`);

  const tokenA = await ethers.deployContract("MockERC20", [TOKENS[0].name, TOKENS[0].symbol]);
  console.log("MockERC20 (tokenA) deploying ...");
  await tokenA.waitForDeployment();

  const tokenB = await ethers.deployContract("MockERC20", [TOKENS[1].name, TOKENS[1].symbol]);
  console.log("MockERC20 (tokenB) deploying ...");
  await tokenB.waitForDeployment();

  const ethFaucet = await ethers.deployContract("ETHFaucet");
  console.log("ETHFaucet deploying ...");
  await ethFaucet.waitForDeployment();

  const dex1 = await ethers.deployContract("MiniDEX");
  console.log("MiniDEX #1 deploying ...");
  await dex1.waitForDeployment();

  const dex2 = await ethers.deployContract("MiniDEX");
  console.log("MiniDEX #2 deploying ...");
  await dex2.waitForDeployment();

  const arbitrage = await ethers.deployContract("Arbitrage");
  console.log("Arbitrage deploying ...");
  await arbitrage.waitForDeployment();

  // 给 ETH 水龙头注资，供用户在前端领取测试以太币
  const fundTx = await deployer.sendTransaction({
    to: await ethFaucet.getAddress(),
    value: ethers.parseEther("100"),
  });
  await fundTx.wait();

  const deployments = {
    chainId: Number(network.chainId),
    network: process.env.HARDHAT_NETWORK ?? "localhost",
    deployer: deployer.address,
    tokens: TOKENS,
    contracts: {
      tokenA: await tokenA.getAddress(),
      tokenB: await tokenB.getAddress(),
      ethFaucet: await ethFaucet.getAddress(),
      dex1: await dex1.getAddress(),
      dex2: await dex2.getAddress(),
      arbitrage: await arbitrage.getAddress(),
    },
    deployedAt: new Date().toISOString(),
  };

  await mkdir(path.join(frontendUtils, "abis"), { recursive: true });
  await writeFile(
    path.join(frontendUtils, "deployments.json"),
    `${JSON.stringify(deployments, null, 2)}\n`,
  );

  for (const name of ARTIFACTS) {
    const artifact = await hre.artifacts.readArtifact(name);
    await writeFile(
      path.join(frontendUtils, "abis", `${name}.json`),
      `${JSON.stringify({ abi: artifact.abi }, null, 2)}\n`,
    );
  }

  console.log("\n部署完成，地址已经写入 frontend/src/utils/deployments.json:\n");
  for (const [key, address] of Object.entries(deployments.contracts)) {
    console.log(`  ${key.padEnd(10)} ${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
