import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

const { parseEther } = ethers;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function deployFixture() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();

  const tokenA = await ethers.deployContract("MockERC20", ["Token A", "TKA"]);
  const tokenB = await ethers.deployContract("MockERC20", ["Token B", "TKB"]);
  const ethFaucet = await ethers.deployContract("ETHFaucet");
  const dex1 = await ethers.deployContract("MiniDEX");
  const dex2 = await ethers.deployContract("MiniDEX");
  const arbitrage = await ethers.deployContract("Arbitrage");

  await Promise.all(
    [tokenA, tokenB, ethFaucet, dex1, dex2, arbitrage].map((c) => c.waitForDeployment()),
  );

  // 给 ETH 水龙头充值
  await deployer.sendTransaction({
    to: await ethFaucet.getAddress(),
    value: parseEther("100"),
  });

  const users = [deployer, alice, bob, carol];
  for (const user of users) {
    await tokenA.mint(user.address, parseEther("1000000"));
    await tokenB.mint(user.address, parseEther("1000000"));
  }

  for (const user of users) {
    for (const dex of [dex1, dex2]) {
      const dexAddress = await dex.getAddress();
      await tokenA.connect(user).approve(dexAddress, ethers.MaxUint256);
      await tokenB.connect(user).approve(dexAddress, ethers.MaxUint256);
    }
  }

  return {
    deployer,
    alice,
    bob,
    carol,
    tokenA,
    tokenB,
    ethFaucet,
    dex1,
    dex2,
    arbitrage,
    addrA: await tokenA.getAddress(),
    addrB: await tokenB.getAddress(),
    dex1Addr: await dex1.getAddress(),
    dex2Addr: await dex2.getAddress(),
    arbAddr: await arbitrage.getAddress(),
  };
}

describe("MiniDEX", function () {
  describe("交易池", function () {
    it("创建池子后可以按代币对查到池子编号", async function () {
      const { dex1, addrA, addrB } = await networkHelpers.loadFixture(deployFixture);

      const poolId = await dex1.createPool.staticCall(addrA, addrB);
      expect(poolId).to.equal(1n);

      await expect(dex1.createPool(addrA, addrB)).to.emit(dex1, "PoolCreated");

      expect(await dex1.poolCount()).to.equal(1n);
      expect(await dex1.getPoolId(addrA, addrB)).to.equal(1n);
      expect(await dex1.getPoolId(addrB, addrA)).to.equal(1n);

      const pool = await dex1.pools(1n);
      expect(pool.tokenA < pool.tokenB).to.equal(true);
    });

    it("重复创建、同币对、ETH/ETH 都会回滚", async function () {
      const { dex1, addrA, addrB } = await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);

      await expect(dex1.createPool(addrA, addrB)).to.be.revertedWith("MiniDEX: pool exists");
      await expect(dex1.createPool(addrA, addrA)).to.be.revertedWith(
        "MiniDEX: identical tokens",
      );
      await expect(dex1.createPool(ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWith(
        "MiniDEX: invalid pair",
      );
    });
  });

  describe("流动性", function () {
    it("首次添加流动性按 sqrt(x*y) 计算份额，并给 LP 一个 ERC721", async function () {
      const { dex1, tokenA, addrA, addrB, deployer } =
        await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);

      await expect(dex1.addLiquidity(1n, parseEther("100"), parseEther("100"))).to.emit(
        dex1,
        "LiquidityAdded",
      );

      const pool = await dex1.pools(1n);
      expect(pool.reserveA).to.equal(parseEther("100"));
      expect(pool.reserveB).to.equal(parseEther("100"));
      expect(pool.totalLP).to.equal(parseEther("100"));

      expect(await dex1.balanceOf(deployer.address)).to.equal(1n);
      expect(await dex1.ownerOf(1n)).to.equal(deployer.address);

      const position = await dex1.positions(1n);
      expect(position.poolId).to.equal(1n);
      expect(position.amount).to.equal(parseEther("100"));
      expect(position.timestamp).to.be.greaterThan(0n);

      // 池子记录了这个 NFT 作为流动性来源
      expect(await dex1.getPoolNftIds(1n)).to.deep.equal([1n]);

      // 链上 metadata 可以读出池子信息
      const uri = await dex1.tokenURI(1n);
      expect(uri.startsWith("data:application/json;base64,")).to.equal(true);

      // 代币已经进入合约
      expect(await tokenA.balanceOf(await dex1.getAddress())).to.equal(parseEther("100"));
    });

    it("第二个 LP 按现有比例获得份额，多给的部分不取用", async function () {
      const { dex1, alice, addrA, addrB, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("100"), parseEther("100"));

      // alice 给 50 A + 100 B，实际只按比例取 50 + 50
      const quoted = await dex1
        .connect(alice)
        .addLiquidity.staticCall(1n, parseEther("50"), parseEther("100"));
      expect(quoted[1]).to.equal(parseEther("50")); // 份额
      expect(quoted[2]).to.equal(parseEther("50")); // 实际使用 amountA
      expect(quoted[3]).to.equal(parseEther("50")); // 实际使用 amountB

      const balABefore = await tokenA.balanceOf(alice.address);
      const balBBefore = await tokenB.balanceOf(alice.address);
      await dex1.connect(alice).addLiquidity(1n, parseEther("50"), parseEther("100"));
      expect(balABefore - (await tokenA.balanceOf(alice.address))).to.equal(parseEther("50"));
      expect(balBBefore - (await tokenB.balanceOf(alice.address))).to.equal(parseEther("50"));

      const pool = await dex1.pools(1n);
      expect(pool.totalLP).to.equal(parseEther("150"));
      expect(pool.reserveA).to.equal(parseEther("150"));
      expect(pool.reserveB).to.equal(parseEther("150"));
      expect(await dex1.balanceOf(alice.address)).to.equal(1n);
    });

    it("LP 撤池后拿回的数量大于最初投入（手续费分红）", async function () {
      const { dex1, deployer, alice, addrA, addrB, tokenA } =
        await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("100"), parseEther("100"));
      for (let i = 0; i < 5; i++) {
        await dex1.connect(alice).swap(1n, addrA, parseEther("10"), 0n);
      }

      const balBefore = await tokenA.balanceOf(deployer.address);
      await dex1.removeLiquidity(1n);
      const gained = (await tokenA.balanceOf(deployer.address)) - balBefore;
      expect(gained).to.be.greaterThan(parseEther("100"));

      const poolAfter = await dex1.pools(1n);
      expect(poolAfter.totalLP).to.equal(0n);
      expect(poolAfter.reserveA).to.equal(0n);
      expect(poolAfter.reserveB).to.equal(0n);

      // NFT 已经被销毁
      await expect(dex1.ownerOf(1n)).to.revert(ethers);
    });

    it("非持有人不能撤销别人的流动性", async function () {
      const { dex1, alice, addrA, addrB } = await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("100"), parseEther("100"));

      await expect(dex1.connect(alice).removeLiquidity(1n)).to.be.revertedWith(
        "MiniDEX: not position owner",
      );
    });
  });

  describe("兑换", function () {
    it("swap 输出金额与报价一致，且 k 值变大", async function () {
      const { dex1, alice, addrA, addrB, tokenB } =
        await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("100"), parseEther("100"));

      const amountIn = parseEther("10");
      const expectedOut = await dex1.getAmountOut(amountIn, parseEther("100"), parseEther("100"));
      expect(await dex1.quoteSwap(1n, addrA, amountIn)).to.equal(expectedOut);

      const balBefore = await tokenB.balanceOf(alice.address);
      await expect(dex1.connect(alice).swap(1n, addrA, amountIn, 0n)).to.emit(dex1, "Swap");
      const received = (await tokenB.balanceOf(alice.address)) - balBefore;
      expect(received).to.equal(expectedOut);

      const pool = await dex1.pools(1n);
      expect(pool.reserveA).to.equal(parseEther("110"));
      expect(pool.reserveB).to.equal(parseEther("100") - expectedOut);
      // 0.3% 手续费沉淀：乘积严格变大
      expect(pool.reserveA * pool.reserveB).to.be.greaterThan(
        parseEther("100") * parseEther("100"),
      );
    });

    it("滑点保护会回滚", async function () {
      const { dex1, alice, addrA, addrB } = await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("100"), parseEther("100"));

      await expect(
        dex1.connect(alice).swap(1n, addrA, parseEther("10"), parseEther("1000")),
      ).to.be.revertedWith("MiniDEX: slippage");

      await expect(dex1.connect(alice).swap(1n, addrA, 0n, 0n)).to.be.revertedWith(
        "MiniDEX: zero input",
      );
    });

    it("价格随交易改变，来回兑换会亏损手续费", async function () {
      const { dex1, alice, addrA, addrB, tokenA } =
        await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, addrB);
      await dex1.addLiquidity(1n, parseEther("1000"), parseEther("1000"));

      const priceBefore = await dex1.getPrice(1n);
      await dex1.connect(alice).swap(1n, addrA, parseEther("100"), 0n);
      const priceAfter = await dex1.getPrice(1n);
      // 卖出 A 之后池子里 A 变多，A 变便宜：1 个 A 换到的 B 变少
      expect(priceAfter).to.be.lessThan(priceBefore);

      const balBefore = await tokenA.balanceOf(alice.address);
      const back = await dex1.quoteSwap(1n, addrB, parseEther("50"));
      await dex1.connect(alice).swap(1n, addrB, parseEther("50"), 0n);
      const gained = (await tokenA.balanceOf(alice.address)) - balBefore;
      expect(gained).to.equal(back);
    });
  });

  describe("ETH 交易池", function () {
    it("可以创建 ETH/ERC20 池并双向兑换", async function () {
      const { dex1, alice, addrA, tokenA } = await networkHelpers.loadFixture(deployFixture);
      await dex1.createPool(addrA, ZERO_ADDRESS);

      const pool = await dex1.pools(1n);
      expect(pool.tokenA).to.equal(ZERO_ADDRESS); // ETH 地址为 0，排在前
      expect(pool.tokenB).to.equal(addrA);

      await dex1.addLiquidity(1n, parseEther("10"), parseEther("1000"), {
        value: parseEther("10"),
      });
      expect(await ethers.provider.getBalance(await dex1.getAddress())).to.equal(
        parseEther("10"),
      );

      // ETH -> TKA
      const outA = await dex1.quoteSwap(1n, ZERO_ADDRESS, parseEther("1"));
      const balABefore = await tokenA.balanceOf(alice.address);
      await dex1.connect(alice).swap(1n, ZERO_ADDRESS, parseEther("1"), 0n, {
        value: parseEther("1"),
      });
      expect((await tokenA.balanceOf(alice.address)) - balABefore).to.equal(outA);

      // TKA -> ETH
      const outEth = await dex1.quoteSwap(1n, addrA, parseEther("10"));
      const dexEthBefore = await ethers.provider.getBalance(await dex1.getAddress());
      await dex1.connect(alice).swap(1n, addrA, parseEther("10"), 0n);
      const dexEthAfter = await ethers.provider.getBalance(await dex1.getAddress());
      expect(dexEthBefore - dexEthAfter).to.equal(outEth);

      // msg.value 与 amountA 不一致会回滚
      await expect(
        dex1.addLiquidity(1n, parseEther("5"), parseEther("100"), { value: parseEther("1") }),
      ).to.be.revertedWith("MiniDEX: ETH amount mismatch");
    });

    it("ETH 水龙头每个地址每 24 小时只能领一次", async function () {
      const { ethFaucet, carol } = await networkHelpers.loadFixture(deployFixture);

      const before = await ethers.provider.getBalance(carol.address);
      const tx = await ethFaucet.connect(carol).claim();
      const receipt = await tx.wait();
      if (!receipt) throw new Error("claim 交易没有回执");
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(carol.address);

      expect(after - before + gasCost).to.equal(parseEther("1"));
      await expect(ethFaucet.connect(carol).claim()).to.be.revertedWith("ETHFaucet: cooldown");
    });
  });

  describe("原子套利", function () {
    async function twoPoolsFixture() {
      const f = await networkHelpers.loadFixture(deployFixture);
      await f.dex1.createPool(f.addrA, f.addrB);
      await f.dex2.createPool(f.addrA, f.addrB);
      // dex1：1 A = 1 B；dex2：1 A = 2 B（即 dex2 上 A 便宜）
      await f.dex1.addLiquidity(1n, parseEther("1000"), parseEther("1000"));
      await f.dex2.addLiquidity(1n, parseEther("1000"), parseEther("2000"));
      return f;
    }

    it("存在价格差时可以一次交易完成套利并盈利", async function () {
      const f = await twoPoolsFixture();
      const amountIn = parseEther("100");

      const opportunity = await f.arbitrage.checkOpportunity(
        f.dex2Addr,
        1n,
        f.dex1Addr,
        1n,
        f.addrA,
        amountIn,
      );
      expect(opportunity.profitable).to.equal(true);

      await f.tokenA.connect(f.alice).approve(f.arbAddr, ethers.MaxUint256);
      const expectedProfit = await f.arbitrage
        .connect(f.alice)
        .arbitrage.staticCall(f.dex2Addr, 1n, f.dex1Addr, 1n, f.addrA, amountIn, 0n);
      expect(expectedProfit).to.be.greaterThan(0n);

      const balBefore = await f.tokenA.balanceOf(f.alice.address);
      await expect(
        f.arbitrage
          .connect(f.alice)
          .arbitrage(f.dex2Addr, 1n, f.dex1Addr, 1n, f.addrA, amountIn, 0n),
      ).to.emit(f.arbitrage, "ArbitrageExecuted");
      const gained = (await f.tokenA.balanceOf(f.alice.address)) - balBefore;

      expect(gained).to.equal(expectedProfit);

      // 套利后两个池子的价格差被拉小
      const price1 = await f.dex1.getPrice(1n);
      const price2 = await f.dex2.getPrice(1n);
      const gapAfter = price2 > price1 ? price2 - price1 : price1 - price2;
      expect(gapAfter).to.be.lessThan(parseEther("1"));
    });

    it("没有价差时套利交易整体回滚", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await f.dex1.createPool(f.addrA, f.addrB);
      await f.dex2.createPool(f.addrA, f.addrB);
      await f.dex1.addLiquidity(1n, parseEther("1000"), parseEther("1000"));
      await f.dex2.addLiquidity(1n, parseEther("1000"), parseEther("1000"));

      await f.tokenA.connect(f.alice).approve(f.arbAddr, ethers.MaxUint256);

      await expect(
        f.arbitrage
          .connect(f.alice)
          .arbitrage(f.dex2Addr, 1n, f.dex1Addr, 1n, f.addrA, parseEther("100"), 0n),
      ).to.be.revertedWith("Arb: no profit");

      // 回滚后套利合约里没有残留代币
      expect(await f.tokenA.balanceOf(f.arbAddr)).to.equal(0n);
    });

    it("minProfit 设置过高会回滚", async function () {
      const f = await twoPoolsFixture();
      await f.tokenA.connect(f.alice).approve(f.arbAddr, ethers.MaxUint256);

      await expect(
        f.arbitrage
          .connect(f.alice)
          .arbitrage(
            f.dex2Addr,
            1n,
            f.dex1Addr,
            1n,
            f.addrA,
            parseEther("100"),
            parseEther("1000"),
          ),
      ).to.be.revertedWith("Arb: profit below minimum");
    });
  });
});
