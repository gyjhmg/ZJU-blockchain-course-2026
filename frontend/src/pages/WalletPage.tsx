import { useCallback, useEffect, useState } from "react";
import type { AppCtx } from "../types";
import {
  CHAIN_ID,
  RPC_URL,
  TOKENS,
  loadBalances,
  faucetContract,
  fmt,
  runTx,
  shortErr,
  tokenContract,
} from "../utils/web3";

export function WalletPage({ ctx }: { ctx: AppCtx }) {
  const [balances, setBalances] = useState<Awaited<ReturnType<typeof loadBalances>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ctx.address) {
      setBalances(null);
      return;
    }
    try {
      setBalances(await loadBalances(ctx.address));
    } catch (error) {
      ctx.notify(shortErr(error), "error");
    }
  }, [ctx.address]);

  useEffect(() => {
    void load();
  }, [load, ctx.version]);

  async function claimToken(symbol: string, address: string) {
    if (!ctx.signer) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    setBusy(symbol);
    try {
      await runTx(() => tokenContract(address, ctx.signer!).faucet());
      ctx.notify(`已领取 1000 ${symbol}`, "ok");
      ctx.bump();
    } catch (error) {
      ctx.notify(`领取 ${symbol} 失败：${shortErr(error)}`, "error");
    } finally {
      setBusy(null);
    }
  }

  async function claimEth() {
    if (!ctx.signer) {
      ctx.notify("请先连接钱包", "error");
      return;
    }
    setBusy("ETH");
    try {
      await runTx(() => faucetContract(ctx.signer!).claim());
      ctx.notify("已领取 1 ETH", "ok");
      ctx.bump();
    } catch (error) {
      const message = shortErr(error);
      ctx.notify(
        message.includes("cooldown") ? "这个地址 24 小时内已经领过了" : `领取 ETH 失败：${message}`,
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>钱包</h2>
      <div className="card">
        <p>
          当前账户：<code>{ctx.address ?? "未连接钱包（以下数据只读）"}</code>
        </p>
        {!ctx.address && <p className="hint">点击右上角"连接钱包"后可以领取测试代币、创建池子、交易。</p>}
        <p className="hint">
          网络：Hardhat Local · chainId {CHAIN_ID} · {RPC_URL}
        </p>
      </div>

      <h3>余额</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>资产</th>
            <th>余额</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ETH</td>
            <td>{fmt(balances?.eth)}</td>
          </tr>
          {TOKENS.map((token) => (
            <tr key={token.symbol}>
              <td>
                {token.symbol} <span className="hint">({token.name})</span>
              </td>
              <td>{fmt(token.symbol === "ZJU" ? balances?.zju : balances?.dxd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>领取测试资产</h3>
      <div className="row">
        {TOKENS.map((token) => (
          <button key={token.symbol} onClick={() => void claimToken(token.symbol, token.address)} disabled={!!busy}>
            {busy === token.symbol ? "领取中…" : `领取 1000 ${token.symbol}`}
          </button>
        ))}
        <button onClick={() => void claimEth()} disabled={!!busy}>
          {busy === "ETH" ? "领取中…" : "领取 1 ETH"}
        </button>
      </div>
      <p className="hint">
        每个地址对每种代币 1 小时可以领一次，测试 ETH 24 小时可以领一次。
      </p>
    </section>
  );
}
