import { useCallback, useEffect, useState } from "react";
import type { AppCtx } from "../types";
import {
  ADDRESSES,
  DEX_LABELS,
  ETH_ADDRESS,
  TOKENS,
  arbitrageContract,
  checkArbitrage,
  ensureAllowance,
  fmt,
  loadPools,
  parseAmount,
  shortErr,
  type DexKey,
  type PoolView,
} from "../utils/web3";

interface Direction {
  key: string;
  label: string;
  buy: DexKey;
  sell: DexKey;
  poolBuy: number;
  poolSell: number;
  amountIn: bigint;
  amountMid: bigint;
  amountBack: bigint;
  profitable: boolean;
  buyPrice: number;
  sellPrice: number;
}

interface Executed {
  label: string;
  amountIn: bigint;
  amountMid: bigint;
  amountBack: bigint;
  profit: bigint;
  buyPriceBefore: number;
  buyPriceAfter: number;
  sellPriceBefore: number;
  sellPriceAfter: number;
}

export function ArbitragePage({ ctx }: { ctx: AppCtx }) {
  const [pools, setPools] = useState<Record<DexKey, PoolView[]>>({ dex1: [], dex2: [] });
  const [amount, setAmount] = useState("100");
  const [directions, setDirections] = useState<Direction[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [executed, setExecuted] = useState<Executed | null>(null);

  const tokenIn = TOKENS[0];
  const tokenOut = TOKENS[1];

  const findPool = (list: PoolView[]) =>
    list.find(
      (pool) =>
        (pool.tokenA.address === tokenIn.address && pool.tokenB.address === tokenOut.address) ||
        (pool.tokenA.address === tokenOut.address && pool.tokenB.address === tokenIn.address),
    );

  const load = useCallback(async () => {
    try {
      const [first, second] = await Promise.all([loadPools("dex1"), loadPools("dex2")]);
      setPools({ dex1: first, dex2: second });
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, ctx.version]);

  const poolA = findPool(pools.dex1);
  const poolB = findPool(pools.dex2);

  const refreshDirections = useCallback(async () => {
    const value = parseAmount(amount);
    if (!poolA || !poolB || value <= 0n) {
      setDirections([]);
      return;
    }
    try {
      const forward = await checkArbitrage("dex1", poolA.poolId, "dex2", poolB.poolId, tokenIn.address, value);
      const backward = await checkArbitrage("dex2", poolB.poolId, "dex1", poolA.poolId, tokenIn.address, value);
      setDirections([
        {
          key: "forward",
          label: `在${DEX_LABELS.dex1}用 ${tokenIn.symbol} 买 ${tokenOut.symbol}，再到${DEX_LABELS.dex2}卖出`,
          buy: "dex1",
          sell: "dex2",
          poolBuy: poolA.poolId,
          poolSell: poolB.poolId,
          amountIn: value,
          ...forward,
        },
        {
          key: "backward",
          label: `在${DEX_LABELS.dex2}用 ${tokenIn.symbol} 买 ${tokenOut.symbol}，再到${DEX_LABELS.dex1}卖出`,
          buy: "dex2",
          sell: "dex1",
          poolBuy: poolB.poolId,
          poolSell: poolA.poolId,
          amountIn: value,
          ...backward,
        },
      ]);
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, [amount, poolA?.poolId, poolB?.poolId]);

  useEffect(() => {
    void refreshDirections();
  }, [refreshDirections, ctx.version]);

  async function execute(direction: Direction) {
    if (!ctx.signer || !ctx.address) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    const value = parseAmount(amount);
    setBusy(direction.key);
    try {
      const contract = arbitrageContract(ctx.signer);
      await ensureAllowance(tokenIn.address, ctx.address, ADDRESSES.arbitrage, value, ctx.signer);
      const tx = await contract.arbitrage(
        ADDRESSES[direction.buy],
        direction.poolBuy,
        ADDRESSES[direction.sell],
        direction.poolSell,
        tokenIn.address,
        value,
        0n,
      );
      const receipt = await tx.wait();
      const parsed = (receipt?.logs ?? [])
        .map((log: any) => {
          try {
            return arbitrageContract().interface.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            return null;
          }
        })
        .find((item: any) => item?.name === "ArbitrageExecuted");

      if (parsed) {
        const args = parsed.args;
        setExecuted({
          label: direction.label,
          amountIn: BigInt(args.amountIn),
          amountMid: BigInt(args.amountMid),
          amountBack: BigInt(args.amountBack),
          profit: BigInt(args.profit),
          buyPriceBefore: Number(args.buyPriceBefore) / 1e18,
          buyPriceAfter: Number(args.buyPriceAfter) / 1e18,
          sellPriceBefore: Number(args.sellPriceBefore) / 1e18,
          sellPriceAfter: Number(args.sellPriceAfter) / 1e18,
        });
      }
      ctx.notify(`套利成功，利润 ${parsed ? fmt(BigInt(parsed.args.profit)) : "?"} ${tokenIn.symbol}`, "ok");
      ctx.bump();
    } catch (error) {
      const message = shortErr(error);
      ctx.notify(
        message.includes("no profit")
          ? "这次没有套利空间（两池价差不够覆盖手续费），交易已整体回滚"
          : `套利失败：${message}`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  const priceGap = poolA && poolB && poolA.priceAB > 0 ? poolB.priceAB / poolA.priceAB - 1 : 0;

  return (
    <section>
      <h2>原子套利</h2>
      <p className="hint">
        两个交易所对同一个币对各自维护自己的池子。价格出现差异时，套利者可以在便宜的池子买入、在贵的池子卖出，用一笔交易完成。
      </p>

      {(!poolA || !poolB) && (
        <p className="notice">
          需要先在"交易池"页面给交易所 1 和交易所 2 都创建 {tokenIn.symbol}/{tokenOut.symbol} 池子。
        </p>
      )}

      <table className="grid">
        <thead>
          <tr>
            <th>交易所</th>
            <th>池子</th>
            <th>储备</th>
            <th>价格（1 {tokenIn.symbol} = ? {tokenOut.symbol}）</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{DEX_LABELS.dex1}</td>
            <td>{poolA ? `#${poolA.poolId}` : "-"}</td>
            <td>{poolA ? `${fmt(poolA.reserveA)} ${poolA.tokenA.symbol} / ${fmt(poolA.reserveB)} ${poolA.tokenB.symbol}` : "-"}</td>
            <td>{poolA ? poolA.priceAB.toFixed(6) : "-"}</td>
          </tr>
          <tr>
            <td>{DEX_LABELS.dex2}</td>
            <td>{poolB ? `#${poolB.poolId}` : "-"}</td>
            <td>{poolB ? `${fmt(poolB.reserveA)} ${poolB.tokenA.symbol} / ${fmt(poolB.reserveB)} ${poolB.tokenB.symbol}` : "-"}</td>
            <td>{poolB ? poolB.priceAB.toFixed(6) : "-"}</td>
          </tr>
        </tbody>
      </table>
      {poolA && poolB && (
        <p className="hint">
          价差：{((priceGap * 100) as number).toFixed(2)}%（交易所 2 相对交易所 1 的价格变化）
        </p>
      )}

      <div className="row">
        <label>投入 {tokenIn.symbol}</label>
        <input value={amount} onChange={(event) => setAmount(event.target.value)} />
        {ctx.address && <span className="hint">套利合约需要先授权 {tokenIn.symbol}</span>}
      </div>

      <h3>套利空间</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>方向</th>
            <th>中间得到</th>
            <th>换回 {tokenIn.symbol}</th>
            <th>利润</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {directions.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                填入数量后显示
              </td>
            </tr>
          )}
          {directions.map((direction) => {
            const profit = direction.amountBack > direction.amountIn ? direction.amountBack - direction.amountIn : 0n;
            return (
              <tr key={direction.key}>
                <td>{direction.label}</td>
                <td>
                  {fmt(direction.amountMid)} {tokenOut.symbol}
                </td>
                <td>{fmt(direction.amountBack)}</td>
                <td className={direction.profitable ? "profit" : "loss"}>
                  {direction.profitable ? `+${fmt(profit)}` : "无利润"}
                </td>
                <td>
                  <button
                    onClick={() => void execute(direction)}
                    disabled={busy !== null || !direction.profitable}
                  >
                    {busy === direction.key ? "执行中…" : "执行套利"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {executed && (
        <>
          <h3>上一次套利结果</h3>
          <p className="hint">{executed.label}</p>
          <table className="grid">
            <tbody>
              <tr>
                <th>投入</th>
                <td>
                  {fmt(executed.amountIn)} {tokenIn.symbol}
                </td>
              </tr>
              <tr>
                <th>买到的中间代币</th>
                <td>
                  {fmt(executed.amountMid)} {tokenOut.symbol}
                </td>
              </tr>
              <tr>
                <th>卖回</th>
                <td>
                  {fmt(executed.amountBack)} {tokenIn.symbol}
                </td>
              </tr>
              <tr>
                <th>利润</th>
                <td className="profit">
                  +{fmt(executed.profit)} {tokenIn.symbol}
                </td>
              </tr>
              <tr>
                <th>买入口径价格（前 → 后）</th>
                <td>
                  {executed.buyPriceBefore.toFixed(6)} → {executed.buyPriceAfter.toFixed(6)}
                </td>
              </tr>
              <tr>
                <th>卖出口径价格（前 → 后）</th>
                <td>
                  {executed.sellPriceBefore.toFixed(6)} → {executed.sellPriceAfter.toFixed(6)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="hint">套利后两个池子的价格被拉近，价差消失时再次执行会整笔回滚。</p>
        </>
      )}

      <p className="hint">
        套利合约地址：<code>{ADDRESSES.arbitrage}</code>
        {tokenIn.address === ETH_ADDRESS ? "" : "（套利只支持 ERC20 计价的币对）"}
      </p>
    </section>
  );
}
