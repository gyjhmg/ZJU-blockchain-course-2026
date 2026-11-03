import { useCallback, useEffect, useState } from "react";
import type { AppCtx } from "../types";
import {
  ALL_TOKENS,
  DEX_KEYS,
  DEX_LABELS,
  dexContract,
  fmt,
  formatTime,
  loadPools,
  runTx,
  shortErr,
  type DexKey,
  type PoolView,
} from "../utils/web3";

export function PoolsPage({ ctx }: { ctx: AppCtx }) {
  const [dexKey, setDexKey] = useState<DexKey>("dex1");
  const [pools, setPools] = useState<PoolView[]>([]);
  const [tokenA, setTokenA] = useState<string>(ALL_TOKENS[0].address);
  const [tokenB, setTokenB] = useState<string>(ALL_TOKENS[1].address);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPools(await loadPools(dexKey));
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, [dexKey]);

  useEffect(() => {
    void load();
  }, [load, ctx.version]);

  async function createPool() {
    if (!ctx.signer) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    setBusy("create");
    try {
      await runTx(() => dexContract(dexKey, ctx.signer!).createPool(tokenA, tokenB));
      ctx.notify("交易池创建成功", "ok");
      ctx.bump();
    } catch (error) {
      ctx.notify(`创建失败：${shortErr(error)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>交易池</h2>

      <div className="row">
        {DEX_KEYS.map((key) => (
          <button
            key={key}
            className={key === dexKey ? "active" : ""}
            onClick={() => setDexKey(key)}
          >
            {DEX_LABELS[key]}
          </button>
        ))}
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>池编号</th>
            <th>币对</th>
            <th>储备 A</th>
            <th>储备 B</th>
            <th>价格（1 A = ? B）</th>
            <th>LP 总量</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {pools.length === 0 && (
            <tr>
              <td colSpan={7} className="hint">
                还没有交易池，先在下面创建一个
              </td>
            </tr>
          )}
          {pools.map((pool) => (
            <tr key={`${pool.dex}-${pool.poolId}`}>
              <td>#{pool.poolId}</td>
              <td>
                {pool.tokenA.symbol} / {pool.tokenB.symbol}
              </td>
              <td>{fmt(pool.reserveA)}</td>
              <td>{fmt(pool.reserveB)}</td>
              <td>{pool.priceAB ? pool.priceAB.toFixed(6) : "-"}</td>
              <td>{fmt(pool.totalLP)}</td>
              <td>{formatTime(pool.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>创建交易池</h3>
      <div className="row">
        <select value={tokenA} onChange={(event) => setTokenA(event.target.value)}>
          {ALL_TOKENS.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol}
            </option>
          ))}
        </select>
        <span>/</span>
        <select value={tokenB} onChange={(event) => setTokenB(event.target.value)}>
          {ALL_TOKENS.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol}
            </option>
          ))}
        </select>
        <button onClick={() => void createPool()} disabled={busy !== null}>
          {busy === "create" ? "创建中…" : "创建池子"}
        </button>
      </div>
      <p className="hint">
        支持 A/B 与 A/ETH 组合（ETH 用零地址表示）。币对顺序无所谓，合约内部会按地址排序去重。
      </p>
    </section>
  );
}
