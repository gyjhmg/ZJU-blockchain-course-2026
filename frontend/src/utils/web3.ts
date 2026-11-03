import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  MaxUint256,
  formatUnits,
  parseUnits,
  type Provider,
  type Signer,
} from "ethers";
import deployments from "./deployments.json";
import MiniDEXArtifact from "./abis/MiniDEX.json";
import MockERC20Artifact from "./abis/MockERC20.json";
import ETHFaucetArtifact from "./abis/ETHFaucet.json";
import ArbitrageArtifact from "./abis/Arbitrage.json";

export const RPC_URL = "http://127.0.0.1:8545";
export const CHAIN_ID = deployments.chainId;
export const ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ADDRESSES = deployments.contracts;

const MiniDEXAbi = MiniDEXArtifact.abi;
const MockERC20Abi = MockERC20Artifact.abi;
const ETHFaucetAbi = ETHFaucetArtifact.abi;
const ArbitrageAbi = ArbitrageArtifact.abi;

export const readProvider = new JsonRpcProvider(RPC_URL);

export type DexKey = "dex1" | "dex2";
export const DEX_KEYS: DexKey[] = ["dex1", "dex2"];
export const DEX_LABELS: Record<DexKey, string> = {
  dex1: "交易所 1",
  dex2: "交易所 2",
};

export interface TokenMeta {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
}

export const ETH_META: TokenMeta = {
  symbol: "ETH",
  name: "Ether",
  address: ETH_ADDRESS,
  decimals: 18,
};

export const TOKENS: TokenMeta[] = [
  { symbol: "ZJU", name: deployments.tokens[0].name, address: ADDRESSES.tokenA, decimals: 18 },
  { symbol: "DXD", name: deployments.tokens[1].name, address: ADDRESSES.tokenB, decimals: 18 },
];

export const ALL_TOKENS: TokenMeta[] = [ETH_META, ...TOKENS];

export function metaOf(address: string): TokenMeta {
  const found = ALL_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (found) return found;
  return { symbol: `${address.slice(0, 6)}…`, name: "Unknown Token", address, decimals: 18 };
}

export interface PoolView {
  dex: DexKey;
  poolId: number;
  tokenA: TokenMeta;
  tokenB: TokenMeta;
  reserveA: bigint;
  reserveB: bigint;
  totalLP: bigint;
  createdAt: number;
  /** 1 个 tokenA 值多少 tokenB */
  priceAB: number;
}

export interface PositionView {
  dex: DexKey;
  nftId: number;
  poolId: number;
  amount: bigint;
  timestamp: number;
}

export interface PoolSourceView {
  nftId: number;
  owner: string;
  amount: bigint;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// 合约实例
// ---------------------------------------------------------------------------

export function dexContract(key: DexKey, runner: Provider | Signer = readProvider) {
  return new Contract(ADDRESSES[key], MiniDEXAbi, runner);
}

export function tokenContract(address: string, runner: Provider | Signer = readProvider) {
  return new Contract(address, MockERC20Abi, runner);
}

export function faucetContract(runner: Provider | Signer = readProvider) {
  return new Contract(ADDRESSES.ethFaucet, ETHFaucetAbi, runner);
}

export function arbitrageContract(runner: Provider | Signer = readProvider) {
  return new Contract(ADDRESSES.arbitrage, ArbitrageAbi, runner);
}

// ---------------------------------------------------------------------------
// 读链数据
// ---------------------------------------------------------------------------

export async function loadPools(key: DexKey, runner: Provider | Signer = readProvider) {
  const dex = dexContract(key, runner);
  const raw = await dex.getPools();
  const pools: PoolView[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const reserveA = BigInt(item.reserveA);
    const reserveB = BigInt(item.reserveB);
    pools.push({
      dex: key,
      poolId: i + 1,
      tokenA: metaOf(item.tokenA),
      tokenB: metaOf(item.tokenB),
      reserveA,
      reserveB,
      totalLP: BigInt(item.totalLP),
      createdAt: Number(item.createdTimestamp),
      priceAB: reserveA === 0n ? 0 : Number(formatUnits(reserveB, 18)) / Number(formatUnits(reserveA, 18)),
    });
  }
  return pools;
}

export async function loadPositions(
  key: DexKey,
  owner: string,
  runner: Provider | Signer = readProvider,
): Promise<PositionView[]> {
  const dex = dexContract(key, runner);
  const count = Number(await dex.balanceOf(owner));
  const positions: PositionView[] = [];
  for (let i = 0; i < count; i++) {
    const nftId = Number(await dex.tokenOfOwnerByIndex(owner, i));
    const position = await dex.positions(nftId);
    positions.push({
      dex: key,
      nftId,
      poolId: Number(position.poolId),
      amount: BigInt(position.amount),
      timestamp: Number(position.timestamp),
    });
  }
  return positions;
}

export async function loadPoolSources(
  key: DexKey,
  poolId: number,
  runner: Provider | Signer = readProvider,
): Promise<PoolSourceView[]> {
  const dex = dexContract(key, runner);
  const ids: bigint[] = await dex.getPoolNftIds(poolId);
  const sources: PoolSourceView[] = [];
  for (const id of ids) {
    const position = await dex.positions(id);
    const owner: string = await dex.ownerOf(id);
    sources.push({
      nftId: Number(id),
      owner,
      amount: BigInt(position.amount),
      timestamp: Number(position.timestamp),
    });
  }
  return sources;
}

export async function loadBalances(owner: string, runner: Provider | Signer = readProvider) {
  const provider: Provider = "getBalance" in runner ? (runner as Provider) : ((runner as Signer).provider as Provider);
  const eth = await provider.getBalance(owner);
  const zju = await tokenContract(TOKENS[0].address, runner).balanceOf(owner);
  const dxd = await tokenContract(TOKENS[1].address, runner).balanceOf(owner);
  return { eth: BigInt(eth), zju: BigInt(zju), dxd: BigInt(dxd) };
}

export async function quoteSwap(key: DexKey, poolId: number, tokenIn: string, amountIn: bigint) {
  const dex = dexContract(key, readProvider);
  const out: bigint = await dex.quoteSwap(poolId, tokenIn, amountIn);
  return BigInt(out);
}

export async function checkArbitrage(
  dexBuy: DexKey,
  poolIdBuy: number,
  dexSell: DexKey,
  poolIdSell: number,
  tokenIn: string,
  amountIn: bigint,
) {
  const arb = arbitrageContract();
  const result = await arb.checkOpportunity(
    ADDRESSES[dexBuy],
    poolIdBuy,
    ADDRESSES[dexSell],
    poolIdSell,
    tokenIn,
    amountIn,
  );
  return {
    amountMid: BigInt(result[0]),
    amountBack: BigInt(result[1]),
    profitable: Boolean(result[2]),
    buyPrice: Number(formatUnits(result[3], 18)),
    sellPrice: Number(formatUnits(result[4], 18)),
  };
}

// ---------------------------------------------------------------------------
// 钱包
// ---------------------------------------------------------------------------

export interface WalletInfo {
  provider: BrowserProvider;
  signer: Signer;
  address: string;
}

export async function ensureChain() {
  const eth = window.ethereum;
  if (!eth) return;
  const chainIdHex = `0x${CHAIN_ID.toString(16)}`;
  const current = await eth.request({ method: "eth_chainId" });
  if (Number(current) === CHAIN_ID) return;

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (error: any) {
    const code = error?.code ?? error?.data?.originalError?.code;
    if (code !== 4902) throw error;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: "Hardhat Local 31337",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC_URL],
        },
      ],
    });
  }
}

export async function connectWallet(): Promise<WalletInfo> {
  const eth = window.ethereum;
  if (!eth) {
    throw new Error("没有检测到 MetaMask，请先安装并解锁钱包");
  }
  const provider = new BrowserProvider(eth);
  await provider.send("eth_requestAccounts", []);
  await ensureChain();
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress() };
}

export const LOCKED_ADDRESS = deployments.deployer;

// ---------------------------------------------------------------------------
// 交易辅助
// ---------------------------------------------------------------------------

export async function ensureAllowance(
  tokenAddress: string,
  owner: string,
  spender: string,
  amount: bigint,
  signer: Signer,
) {
  if (tokenAddress.toLowerCase() === ETH_ADDRESS) return;
  const token = tokenContract(tokenAddress, signer);
  const allowance: bigint = await token.allowance(owner, spender);
  if (allowance >= amount) return;
  const tx = await token.approve(spender, MaxUint256);
  await tx.wait();
}

export async function runTx(fn: () => Promise<{ wait: () => Promise<unknown> }>) {
  const tx = await fn();
  await tx.wait();
  return tx;
}

export function shortErr(error: any): string {
  const message =
    error?.shortMessage ??
    error?.reason ??
    error?.info?.error?.message ??
    error?.data?.message ??
    error?.message ??
    String(error);
  return String(message);
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

export function fmt(value: bigint | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return "-";
  const text = formatUnits(value, 18);
  const num = Number(text);
  if (!Number.isFinite(num)) return text;
  if (num !== 0 && Math.abs(num) < 0.0001) return num.toExponential(2);
  return num.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function parseAmount(input: string): bigint {
  const text = input.trim();
  if (text === "" || Number.isNaN(Number(text))) return 0n;
  return parseUnits(text, 18);
}

export function shortAddress(address: string | null | undefined): string {
  if (!address) return "-";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatTime(timestamp: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString();
}

export function pct(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}
