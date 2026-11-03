import { useCallback, useEffect, useState } from "react";
import type { AppCtx } from "../types";
import {
  ADDRESSES,
  DEX_KEYS,
  DEX_LABELS,
  ETH_ADDRESS,
  dexContract,
  ensureAllowance,
  fmt,
  formatTime,
  loadPoolSources,
  loadPools,
  loadPositions,
  parseAmount,
  runTx,
  shortAddress,
  shortErr,
  type DexKey,
  type PoolSourceView,
  type PoolView,
  type PositionView,
} from "../utils/web3";

export function LiquidityPage({ ctx }: { ctx: AppCtx }) {
  const [dexKey, setDexKey] = useState<DexKey>("dex1");
  const [pools, setPools] = useState<PoolView[]>([]);
  const [poolId, setPoolId] = useState<number>(0);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [sources, setSources] = useState<PoolSourceView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const selected = pools.find((pool) => pool.poolId === poolId) ?? null;

  const load = useCallback(async () => {
    try {
      const next = await loadPools(dexKey);
      setPools(next);
      setPoolId((prev) => (next.some((pool) => pool.poolId === prev) ? prev : (next[0]?.poolId ?? 0)));
      if (ctx.address) {
        setPositions(await loadPositions(dexKey, ctx.address));
      } else {
        setPositions([]);
      }
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, [dexKey, ctx.address]);

  useEffect(() => {
    void load();
  }, [load, ctx.version]);

  useEffect(() => {
    let cancelled = false;
    async function fetchSources() {
      if (!poolId) {
        setSources([]);
        return;
      }
      try {
        const next = await loadPoolSources(dexKey, poolId);
        if (!cancelled) setSources(next);
      } catch {
        if (!cancelled) setSources([]);
      }
    }
    void fetchSources();
    return () => {
      cancelled = true;
    };
  }, [dexKey, poolId, ctx.version]);

  async function addLiquidity() {
    if (!ctx.signer || !ctx.address) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    if (!selected) {
      ctx.notify("请先选择交易池", "error");
      return;
    }
    const valueA = parseAmount(amountA);
    const valueB = parseAmount(amountB);
    if (valueA <= 0n || valueB <= 0n) {
      ctx.notify("两种代币的数量都要大于 0", "error");
      return;
    }

    setBusy("add");
    try {
      const dex = dexContract(dexKey, ctx.signer);
      if (selected.tokenA.address !== ETH_ADDRESS) {
        await ensureAllowance(selected.tokenA.address, ctx.address, ADDRESSES[dexKey], valueA, ctx.signer);
      }
      if (selected.tokenB.address !== ETH_ADDRESS) {
        await ensureAllowance(selected.tokenB.address, ctx.address, ADDRESSES[dexKey], valueB, ctx.signer);
      }
      const overrides = selected.tokenA.address === ETH_ADDRESS ? { value: valueA } : {};
      await runTx(() => dex.addLiquidity(poolId, valueA, valueB, overrides));
      ctx.notify("添加流动性成功，已铸造流动性 NFT", "ok");
      setAmountA("");
      setAmountB("");
      ctx.bump();
    } catch (error) {
      ctx.notify(`添加失败：${shortErr(error)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeLiquidity(nftId: number) {
    if (!ctx.signer) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    if (!window.confirm(`销毁 NFT #${nftId} 并取回对应的代币？`)) return;
    setBusy(`remove-${nftId}`);
    try {
      await runTx(() => dexContract(dexKey, ctx.signer!).removeLiquidity(nftId));
      ctx.notify(`已销毁 NFT #${nftId}，代币与手续费分红已取回`, "ok");
      ctx.bump();
    } catch (error) {
      ctx.notify(`撤销失败：${shortErr(error)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  function fillProportional(side: "a" | "b") {
    if (!selected) return;
    if (side === "a") {
      const value = parseAmount(amountA);
      if (value <= 0n || selected.reserveA === 0n) return;
      const b = (value * selected.reserveB) / selected.reserveA;
      setAmountB(fmt(b, 18).replace(/,/g, ""));
    } else {
      const value = parseAmount(amountB);
      if (value <= 0n || selected.reserveB === 0n) return;
      const a = (value * selected.reserveA) / selected.reserveB;
      setAmountA(fmt(a, 18).replace(/,/g, ""));
    }
  }

  return (
    <section>
      <h2>流动性</h2>

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
        {selected && (
          <span className="hint">
            储备 {fmt(selected.reserveA)} {selected.tokenA.symbol} · {fmt(selected.reserveB)}{" "}
            {selected.tokenB.symbol}
          </span>
        )}
      </div>

      <h3>添加流动性</h3>
      <div className="row">
        <input
          placeholder={`${selected?.tokenA.symbol ?? "A"} 数量`}
          value={amountA}
          onChange={(event) => setAmountA(event.target.value)}
        />
        <button className="link" onClick={() => fillProportional("a")}>
          按比例
        </button>
        <input
          placeholder={`${selected?.tokenB.symbol ?? "B"} 数量`}
          value={amountB}
          onChange={(event) => setAmountB(event.target.value)}
        />
        <button className="link" onClick={() => fillProportional("b")}>
          按比例
        </button>
        <button onClick={() => void addLiquidity()} disabled={busy !== null || !selected}>
          {busy === "add" ? "处理中…" : "添加流动性"}
        </button>
      </div>
      <p className="hint">
        首次添加按 sqrt(amountA × amountB) 计算份额；之后按池子现有比例计算，多给的部分不会被取用。添加成功会得到一个 ERC721 流动性凭证。
      </p>

      <h3>我的流动性 NFT</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>NFT</th>
            <th>池子</th>
            <th>份额</th>
            <th>添加时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {positions.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                {ctx.address ? "当前账户还没有流动性 NFT" : "连接钱包后显示"}
              </td>
            </tr>
          )}
          {positions.map((position) => {
            const pool = pools.find((item) => item.poolId === position.poolId);
            return (
              <tr key={`${position.dex}-${position.nftId}`}>
                <td>#{position.nftId}</td>
                <td>
                  #{position.poolId} {pool ? `${pool.tokenA.symbol}/${pool.tokenB.symbol}` : ""}
                </td>
                <td>{fmt(position.amount)}</td>
                <td>{formatTime(position.timestamp)}</td>
                <td>
                  <button
                    onClick={() => void removeLiquidity(position.nftId)}
                    disabled={busy !== null || position.dex !== dexKey}
                    title={position.dex !== dexKey ? "请先切换到对应的交易所" : ""}
                  >
                    {busy === `remove-${position.nftId}` ? "销毁中…" : "销毁并取回"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>这个池子的流动性来源</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>NFT</th>
            <th>提供者</th>
            <th>份额</th>
            <th>添加时间</th>
          </tr>
        </thead>
        <tbody>
          {sources.length === 0 && (
            <tr>
              <td colSpan={4} className="hint">
                这个池子还没有流动性
              </td>
            </tr>
          )}
          {sources.map((source) => (
            <tr key={source.nftId}>
              <td>#{source.nftId}</td>
              <td>
                {shortAddress(source.owner)}
                {source.owner.toLowerCase() === ctx.address?.toLowerCase() ? "（我）" : ""}
              </td>
              <td>{fmt(source.amount)}</td>
              <td>{formatTime(source.timestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
