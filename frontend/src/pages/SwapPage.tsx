import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppCtx } from "../types";
import {
  ADDRESSES,
  DEX_KEYS,
  DEX_LABELS,
  ETH_ADDRESS,
  dexContract,
  ensureAllowance,
  fmt,
  loadPools,
  parseAmount,
  quoteSwap,
  runTx,
  shortErr,
  type DexKey,
  type PoolView,
} from "../utils/web3";

export function SwapPage({ ctx }: { ctx: AppCtx }) {
  const [dexKey, setDexKey] = useState<DexKey>("dex1");
  const [pools, setPools] = useState<PoolView[]>([]);
  const [poolId, setPoolId] = useState<number>(0);
  const [tokenIn, setTokenIn] = useState<string>(ETH_ADDRESS);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selected = pools.find((pool) => pool.poolId === poolId) ?? null;
  const amountIn = parseAmount(amount);

  const tokenOut = useMemo(() => {
    if (!selected) return null;
    return selected.tokenA.address === tokenIn ? selected.tokenB : selected.tokenA;
  }, [selected, tokenIn]);

  const load = useCallback(async () => {
    try {
      const next = await loadPools(dexKey);
      setPools(next);
      setPoolId((prev) => (next.some((pool) => pool.poolId === prev) ? prev : (next[0]?.poolId ?? 0)));
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, [dexKey]);

  useEffect(() => {
    void load();
  }, [load, ctx.version]);

  useEffect(() => {
    if (!selected) {
      setTokenIn(ETH_ADDRESS);
      return;
    }
    setTokenIn(selected.tokenA.address);
  }, [selected?.poolId, selected?.dex]);

  useEffect(() => {
    let cancelled = false;
    async function fetchQuote() {
      if (!selected || amountIn <= 0n) {
        setQuote(null);
        return;
      }
      try {
        const out = await quoteSwap(dexKey, selected.poolId, tokenIn, amountIn);
        if (!cancelled) setQuote(out);
      } catch {
        if (!cancelled) setQuote(null);
      }
    }
    void fetchQuote();
    return () => {
      cancelled = true;
    };
  }, [dexKey, selected?.poolId, tokenIn, amount]);

  const reserveIn = selected
    ? selected.tokenA.address === tokenIn
      ? selected.reserveA
      : selected.reserveB
    : 0n;
  const reserveOut = selected
    ? selected.tokenA.address === tokenIn
      ? selected.reserveB
      : selected.reserveA
    : 0n;

  const spotPrice = reserveIn > 0n ? Number(reserveOut) / Number(reserveIn) : 0;
  const execPrice = quote !== null && amountIn > 0n ? Number(quote) / Number(amountIn) : 0;
  const priceImpact = spotPrice > 0 && execPrice > 0 ? 1 - execPrice / spotPrice : 0;

  async function doSwap() {
    if (!ctx.signer || !ctx.address) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    if (!selected || !tokenOut) {
      ctx.notify("请先选择交易池", "error");
      return;
    }
    if (amountIn <= 0n) {
      ctx.notify("请输入兑换数量", "error");
      return;
    }
    if (quote === null || quote === 0n) {
      ctx.notify("当前数量无法兑换", "error");
      return;
    }

    setBusy("swap");
    try {
      const dex = dexContract(dexKey, ctx.signer);
      if (tokenIn !== ETH_ADDRESS) {
        await ensureAllowance(tokenIn, ctx.address, ADDRESSES[dexKey], amountIn, ctx.signer);
      }
      const minOut = (quote * 99n) / 100n; // 1% 滑点保护
      const overrides = tokenIn === ETH_ADDRESS ? { value: amountIn } : {};
      await runTx(() => dex.swap(selected.poolId, tokenIn, amountIn, minOut, overrides));
      ctx.notify(`兑换成功：${amount} → 至少 ${fmt(minOut)} ${tokenOut.symbol}`, "ok");
      setAmount("");
      ctx.bump();
    } catch (error) {
      ctx.notify(`兑换失败：${shortErr(error)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>兑换</h2>

      <div className="row">
        {DEX_KEYS.map((key) => (
          <button key={key} className={key === dexKey ? "active" : ""} onClick={() => setDexKey(key)}>
            {DEX_LABELS[key]}
          </button>
        ))}
      </div>

      <div className="row">
        <label>交易池</label>
        <select value={poolId} onChange={(event) => setPoolId(Number(event.target.value))}>
          {pools.length === 0 && <option value={0}>（还没有池子）</option>}
          {pools.map((pool) => (
            <option key={pool.poolId} value={pool.poolId}>
              #{pool.poolId} {pool.tokenA.symbol}/{pool.tokenB.symbol}
            </option>
          ))}
        </select>
      </div>

      {selected && (
        <>
          <div className="row">
            <label>支付</label>
            <select value={tokenIn} onChange={(event) => setTokenIn(event.target.value)}>
              <option value={selected.tokenA.address}>{selected.tokenA.symbol}</option>
              <option value={selected.tokenB.address}>{selected.tokenB.symbol}</option>
            </select>
            <input
              placeholder="数量"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button onClick={() => void doSwap()} disabled={busy !== null}>
              {busy === "swap" ? "兑换中…" : "兑换"}
            </button>
          </div>

          <table className="grid">
            <tbody>
              <tr>
                <th>预计得到</th>
                <td>
                  {quote === null ? "-" : `${fmt(quote)} ${tokenOut?.symbol ?? ""}`}
                </td>
              </tr>
              <tr>
                <th>现价（不含手续费）</th>
                <td>{spotPrice ? spotPrice.toFixed(6) : "-"}</td>
              </tr>
              <tr>
                <th>本次成交价</th>
                <td>{execPrice ? execPrice.toFixed(6) : "-"}</td>
              </tr>
              <tr>
                <th>价格影响</th>
                <td>{priceImpact > 0 ? `${(priceImpact * 100).toFixed(2)}%` : "-"}</td>
              </tr>
              <tr>
                <th>最少收到（滑点 1%）</th>
                <td>{quote === null ? "-" : fmt((quote * 99n) / 100n)}</td>
              </tr>
            </tbody>
          </table>
          <p className="hint">
            价格由恒定乘积公式决定，每笔交易收取 0.3% 手续费并留在池子中，按份额分配给流动性提供者。
          </p>
        </>
      )}
    </section>
  );
}
