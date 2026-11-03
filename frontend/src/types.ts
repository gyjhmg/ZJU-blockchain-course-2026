import type { Signer } from "ethers";

export type NotifyKind = "info" | "ok" | "error";

export interface AppCtx {
  address: string | null;
  signer: Signer | null;
  notify: (message: string, kind?: NotifyKind) => void;
  bump: () => void;
  version: number;
}
