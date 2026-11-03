import { useCallback, useMemo, useState } from "react";
import type { Signer } from "ethers";
import "./App.css";
import type { AppCtx, NotifyKind } from "./types";
import { ADDRESSES, CHAIN_ID, connectWallet, shortAddress, shortErr } from "./utils/web3";
import { ArbitragePage } from "./pages/ArbitragePage";
import { LiquidityPage } from "./pages/LiquidityPage";
import { PoolsPage } from "./pages/PoolsPage";
import { SwapPage } from "./pages/SwapPage";
import { WalletPage } from "./pages/WalletPage";

type TabKey = "wallet" | "pools" | "liquidity" | "swap" | "arbitrage";

const TABS: { key: TabKey; label: string }[] = [
  { key: "wallet", label: "钱包" },
  { key: "pools", label: "交易池" },
  { key: "liquidity", label: "流动性" },
  { key: "swap", label: "兑换" },
  { key: "arbitrage", label: "套利" },
];

function initialTab(): TabKey {
  const requested = new URLSearchParams(window.location.search).get("tab");
  const found = TABS.find((item) => item.key === requested);
  return found ? found.key : "wallet";
}

function App() {
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<{ text: string; kind: NotifyKind } | null>(null);

  const notify = useCallback((text: string, kind: NotifyKind = "info") => {
    setMessage({ text, kind });
    window.setTimeout(() => {
      setMessage((current) => (current?.text === text ? null : current));
    }, 6000);
  }, []);

  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const ctx: AppCtx = useMemo(
    () => ({ address, signer, notify, bump, version }),
    [address, signer, notify, bump, version],
  );

  async function handleConnect() {
    try {
      const wallet = await connectWallet();
      setAddress(wallet.address);
      setSigner(wallet.signer);
      notify(`已连接 ${shortAddress(wallet.address)}`, "ok");
      bump();
    } catch (error) {
      notify(shortErr(error), "error");
    }
  }

  function handleDisconnect() {
    setAddress(null);
    setSigner(null);
    notify("已断开本地连接（MetaMask 里的授权不会撤销）", "info");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>MiniDEX</h1>
          <p className="hint">基于 AMM 的去中心化交易所 · 恒定乘积做市 · ERC721 流动性凭证</p>
        </div>
        <div className="wallet-box">
          <span className={address ? "badge ok" : "badge"}>
            {address ? shortAddress(address) : "未连接钱包"}
          </span>
          {address ? (
            <button className="link" onClick={handleDisconnect}>
              断开
            </button>
          ) : (
            <button onClick={() => void handleConnect()}>连接钱包</button>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={item.key === tab ? "tab active" : "tab"}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {message && <div className={`toast ${message.kind}`}>{message.text}</div>}

      <main>
        {tab === "wallet" && <WalletPage ctx={ctx} />}
        {tab === "pools" && <PoolsPage ctx={ctx} />}
        {tab === "liquidity" && <LiquidityPage ctx={ctx} />}
        {tab === "swap" && <SwapPage ctx={ctx} />}
        {tab === "arbitrage" && <ArbitragePage ctx={ctx} />}
      </main>

      <footer>
        <p className="hint">
          网络 chainId {CHAIN_ID} · 交易所 1 <code>{ADDRESSES.dex1}</code> · 交易所 2{" "}
          <code>{ADDRESSES.dex2}</code> · 套利合约 <code>{ADDRESSES.arbitrage}</code>
        </p>
      </footer>
    </div>
  );
}

export default App;
