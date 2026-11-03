export {};

declare global {
  interface Window {
    // MetaMask 注入的对象，类型用 any 简化
    ethereum?: any;
  }
}
