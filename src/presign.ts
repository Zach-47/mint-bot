import { Transaction, keccak256 } from "ethers";
import {
  CHAIN_ID,
  CONTRACT,
  GAS_MINT,
  MAX_FEE,
  MAX_PER_WALLET,
  PRIORITY_FEE,
  SEL_MINT,
  SEL_MINTED_BY,
  type Config,
  type WalletCfg,
} from "./config.js";
import { callBatch } from "./rpc.js";

export interface PreparedTx {
  index: number;
  address: string;
  txHash: string;
  nonce: number;
  /** fully serialised eth_sendRawTransaction request body - never rebuilt in the hot path */
  body: string;
  raw: string;
}

function pad32(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

export function mintCalldata(quantity: number): string {
  return SEL_MINT + pad32(BigInt(quantity));
}

export function mintedByCalldata(address: string): string {
  return SEL_MINTED_BY + address.slice(2).toLowerCase().padStart(64, "0");
}

export interface WalletState {
  index: number;
  address: string;
  nonce: number;
  mintedBy: bigint;
}

/** One batched round trip: nonce + mintedBy for every wallet. */
export async function fetchWalletState(cfg: Config, wallets: WalletCfg[]): Promise<WalletState[]> {
  const reqs = wallets.flatMap((w) => [
    { method: "eth_getTransactionCount", params: [w.address, "pending"] },
    { method: "eth_call", params: [{ to: CONTRACT, data: mintedByCalldata(w.address) }, "latest"] },
  ]);
  const res = await callBatch(cfg.rpcUrl, reqs);
  return wallets.map((w, i) => {
    const nonceRes = res[i * 2];
    const mintedRes = res[i * 2 + 1];
    if (!nonceRes || nonceRes.error) {
      throw new Error(
        `nonce fetch failed for ${w.address}: ${nonceRes?.error?.message ?? "no response"}`,
      );
    }
    if (!mintedRes || mintedRes.error) {
      throw new Error(
        `mintedBy failed for ${w.address}: ${mintedRes?.error?.message ?? "no response"}`,
      );
    }
    const mintedHex = mintedRes.result as string;
    return {
      index: w.index,
      address: w.address,
      nonce: Number(BigInt(nonceRes.result as string)),
      mintedBy: mintedHex && mintedHex !== "0x" ? BigInt(mintedHex) : 0n,
    };
  });
}

/**
 * Sign one mint tx synchronously. ethers' Wallet.signTransaction is async only
 * because of its Signer interface; the underlying signature is local and
 * synchronous. This path is verified byte-identical to signTransaction().
 */
function signMint(w: WalletCfg, nonce: number, data: string, value: bigint): PreparedTx {
  const tx = Transaction.from({
    to: CONTRACT,
    data,
    value,
    gasLimit: GAS_MINT,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    type: 2,
    chainId: CHAIN_ID,
    nonce,
  });
  tx.signature = w.wallet.signingKey.sign(tx.unsignedHash);
  const raw = tx.serialized;
  const txHash = keccak256(raw);
  // Pre-serialise the complete JSON-RPC body. JSON.stringify in the hot path
  // is wasted microseconds.
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1000 + w.index,
    method: "eth_sendRawTransaction",
    params: [raw],
  });
  return { index: w.index, address: w.address, txHash, nonce, body, raw };
}

export interface PresignResult {
  prepared: PreparedTx[];
  skipped: WalletState[];
  state: WalletState[];
  totalValue: bigint;
  signMs: number;
}

/**
 * Split wallets into those that should still mint and those already at the
 * per-wallet limit. This is what makes restarts idempotent: without it, a
 * crash-restart after a successful mint fires txs that revert with
 * WalletLimit().
 */
export function selectEligible(
  wallets: WalletCfg[],
  state: WalletState[],
  maxPerWallet = MAX_PER_WALLET,
): { eligible: Array<{ w: WalletCfg; s: WalletState }>; skipped: WalletState[] } {
  const eligible: Array<{ w: WalletCfg; s: WalletState }> = [];
  const skipped: WalletState[] = [];
  for (const w of wallets) {
    const s = state.find((x) => x.index === w.index);
    if (!s) continue;
    if (s.mintedBy >= BigInt(maxPerWallet)) skipped.push(s);
    else eligible.push({ w, s });
  }
  return { eligible, skipped };
}

/**
 * Called once at startup and again on any nonce change. Wallets already at
 * MAX_PER_WALLET are excluded so restarts are idempotent - without this, a
 * crash-restart after a successful mint fires txs that revert with WalletLimit().
 */
export async function presign(cfg: Config): Promise<PresignResult> {
  const state = await fetchWalletState(cfg, cfg.wallets);

  const { eligible, skipped } = selectEligible(cfg.wallets, state);

  const data = mintCalldata(cfg.quantity);
  const t0 = performance.now();
  const prepared = eligible.map(({ w, s }) => signMint(w, s.nonce, data, cfg.mintValue));
  const signMs = performance.now() - t0;

  return {
    prepared,
    skipped,
    state,
    totalValue: cfg.mintValue * BigInt(prepared.length),
    signMs,
  };
}

/** True if any wallet's on-chain nonce has moved away from what we signed. */
export function noncesChanged(prepared: PreparedTx[], fresh: WalletState[]): boolean {
  for (const p of prepared) {
    const s = fresh.find((x) => x.index === p.index);
    if (!s) continue;
    if (s.nonce !== p.nonce) return true;
  }
  return false;
}
