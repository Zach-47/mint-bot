import { Transaction } from "ethers";
import {
  CHAIN_ID,
  CONTRACT,
  GAS_NATIVE_SEND,
  GAS_TRANSFER_FIRST,
  GAS_TRANSFER_NEXT,
  MAX_FEE,
  PRIORITY_FEE,
  SEL_OWNER_OF,
  SEL_TOKENS_OF,
  SEL_TRANSFER_FROM,
  type Config,
  type WalletCfg,
} from "./config.js";
import { error, fmtEth, log, ok, warn } from "./log.js";
import { call, callSafe } from "./rpc.js";

function pad32Addr(a: string): string {
  return a.slice(2).toLowerCase().padStart(64, "0");
}

function pad32Num(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** tokensOfOwner(address) -> uint256[] */
export function decodeUint256Array(hex: string): bigint[] {
  const body = hex.slice(2);
  if (body.length < 128) return [];
  const len = BigInt("0x" + body.slice(64, 128));
  const out: bigint[] = [];
  for (let i = 0n; i < len; i++) {
    const start = 128 + Number(i) * 64;
    out.push(BigInt("0x" + body.slice(start, start + 64)));
  }
  return out;
}

async function tokensOf(cfg: Config, address: string): Promise<bigint[]> {
  const hex = (await call(cfg.rpcUrl, "eth_call", [
    { to: CONTRACT, data: SEL_TOKENS_OF + pad32Addr(address) },
    "latest",
  ])) as string;
  return decodeUint256Array(hex);
}

async function ownerOf(cfg: Config, tokenId: bigint): Promise<string> {
  const hex = (await call(cfg.rpcUrl, "eth_call", [
    { to: CONTRACT, data: SEL_OWNER_OF + pad32Num(tokenId) },
    "latest",
  ])) as string;
  return "0x" + hex.slice(-40);
}

async function getNonce(cfg: Config, address: string): Promise<number> {
  const hex = (await call(cfg.rpcUrl, "eth_getTransactionCount", [address, "pending"])) as string;
  return Number(BigInt(hex));
}

async function getBalance(cfg: Config, address: string): Promise<bigint> {
  return BigInt((await call(cfg.rpcUrl, "eth_getBalance", [address, "latest"])) as string);
}

interface SentTx {
  hash: string;
  tokenId: bigint;
  gasLimit: bigint;
}

function signTx(
  w: WalletCfg,
  fields: { to: string; data?: string; value?: bigint; gasLimit: bigint; nonce: number },
): { raw: string; hash: string } {
  const tx = Transaction.from({
    to: fields.to,
    data: fields.data ?? "0x",
    value: fields.value ?? 0n,
    gasLimit: fields.gasLimit,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    type: 2,
    chainId: CHAIN_ID,
    nonce: fields.nonce,
  });
  tx.signature = w.wallet.signingKey.sign(tx.unsignedHash);
  return { raw: tx.serialized, hash: tx.hash! };
}

interface ReceiptInfo {
  status: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
}

async function waitReceipt(cfg: Config, hash: string, timeoutMs = 120_000): Promise<ReceiptInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await callSafe(cfg.rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (!r.error && r.result) {
      const rec = r.result as {
        status: string;
        gasUsed: string;
        effectiveGasPrice?: string;
        blockNumber: string;
      };
      return {
        status: BigInt(rec.status),
        gasUsed: BigInt(rec.gasUsed),
        effectiveGasPrice: rec.effectiveGasPrice ? BigInt(rec.effectiveGasPrice) : MAX_FEE,
        blockNumber: Number(BigInt(rec.blockNumber)),
      };
    }
    await new Promise((r2) => setTimeout(r2, 200));
  }
  return null;
}

export interface SweepRow {
  index: number;
  address: string;
  tokensFound: number;
  tokensMoved: number;
  gasSpent: bigint;
  balanceAfter: bigint;
}

async function sweepWallet(cfg: Config, w: WalletCfg): Promise<SweepRow> {
  const row: SweepRow = {
    index: w.index,
    address: w.address,
    tokensFound: 0,
    tokensMoved: 0,
    gasSpent: 0n,
    balanceAfter: 0n,
  };

  const tokens = await tokensOf(cfg, w.address);
  row.tokensFound = tokens.length;
  if (tokens.length === 0) {
    log(`wallet[${w.index}] holds no tokens`);
    row.balanceAfter = await getBalance(cfg, w.address);
    return row;
  }
  log(`wallet[${w.index}] holds ${tokens.length} token(s): ${tokens.join(", ")}`);

  let nonce = await getNonce(cfg, w.address);

  // Sequential per wallet with nonce increment. The first transfer to the
  // recipient is more expensive (cold storage write in the wasSold hook).
  for (let i = 0; i < tokens.length; i++) {
    const tokenId = tokens[i]!;
    const gasLimit = i === 0 ? GAS_TRANSFER_FIRST : GAS_TRANSFER_NEXT;
    const data =
      SEL_TRANSFER_FROM + pad32Addr(w.address) + pad32Addr(cfg.recipient) + pad32Num(tokenId);

    const { raw, hash } = signTx(w, { to: CONTRACT, data, gasLimit, nonce });
    const sent = await callSafe(cfg.rpcUrl, "eth_sendRawTransaction", [raw]);
    if (sent.error) {
      error(`wallet[${w.index}] token ${tokenId} send failed: ${sent.error.message}`);
      continue;
    }
    nonce++;
    const sentTx: SentTx = { hash, tokenId, gasLimit };
    log(`wallet[${w.index}] token ${tokenId} -> ${cfg.recipient} tx=${sentTx.hash}`);

    const rec = await waitReceipt(cfg, hash);
    if (!rec) {
      error(`wallet[${w.index}] token ${tokenId} no receipt (timeout) tx=${hash}`);
      continue;
    }
    row.gasSpent += rec.gasUsed * rec.effectiveGasPrice;
    if (rec.status !== 1n) {
      error(`wallet[${w.index}] token ${tokenId} REVERTED in block ${rec.blockNumber}`);
      continue;
    }

    const owner = await ownerOf(cfg, tokenId);
    if (owner.toLowerCase() === cfg.recipient.toLowerCase()) {
      row.tokensMoved++;
      ok(`wallet[${w.index}] token ${tokenId} confirmed owned by recipient (gasUsed=${rec.gasUsed})`);
    } else {
      error(`wallet[${w.index}] token ${tokenId} transfer landed but owner is ${owner}`);
    }
  }

  row.balanceAfter = await getBalance(cfg, w.address);
  return row;
}

export async function sweep(cfg: Config): Promise<SweepRow[]> {
  log(`sweeping NFTs from ${cfg.wallets.length} wallet(s) to ${cfg.recipient}`);
  // Wallets run in parallel with each other; transfers are sequential within a wallet.
  const rows = await Promise.all(cfg.wallets.map((w) => sweepWallet(cfg, w)));

  log("");
  log("wallet | address                                    | found | moved | gas spent           | balance");
  log("-------+--------------------------------------------+-------+-------+---------------------+---------------------");
  let totalMoved = 0;
  let totalGas = 0n;
  for (const r of rows.sort((a, b) => a.index - b.index)) {
    totalMoved += r.tokensMoved;
    totalGas += r.gasSpent;
    log(
      `  ${String(r.index).padEnd(4)} | ${r.address} | ${String(r.tokensFound).padStart(5)} | ` +
        `${String(r.tokensMoved).padStart(5)} | ${fmtEth(r.gasSpent).padEnd(19)} | ${fmtEth(r.balanceAfter)}`,
    );
  }
  log(`total: ${totalMoved} token(s) moved, ${fmtEth(totalGas)} gas spent`);
  return rows;
}

/**
 * sweep --dust: return leftover native balance, leaving exactly enough for the
 * 21,000-gas send itself.
 */
export async function sweepDust(cfg: Config): Promise<void> {
  const reserve = GAS_NATIVE_SEND * MAX_FEE;
  log(`dust sweep to ${cfg.recipient}, reserving ${fmtEth(reserve)} per wallet for the send`);

  await Promise.all(
    cfg.wallets.map(async (w) => {
      const bal = await getBalance(cfg, w.address);
      const sendable = bal - reserve;
      if (sendable <= 0n) {
        warn(`wallet[${w.index}] balance ${fmtEth(bal)} <= reserve ${fmtEth(reserve)} - skipping`);
        return;
      }
      const nonce = await getNonce(cfg, w.address);
      const { raw, hash } = signTx(w, {
        to: cfg.recipient,
        value: sendable,
        gasLimit: GAS_NATIVE_SEND,
        nonce,
      });
      const sent = await callSafe(cfg.rpcUrl, "eth_sendRawTransaction", [raw]);
      if (sent.error) {
        error(`wallet[${w.index}] dust send failed: ${sent.error.message}`);
        return;
      }
      log(`wallet[${w.index}] sending ${fmtEth(sendable)} tx=${hash}`);
      const rec = await waitReceipt(cfg, hash);
      if (!rec) {
        error(`wallet[${w.index}] dust send no receipt: ${hash}`);
        return;
      }
      if (rec.status === 1n) {
        const after = await getBalance(cfg, w.address);
        ok(`wallet[${w.index}] dust swept, ${fmtEth(after)} left`);
      } else {
        error(`wallet[${w.index}] dust send REVERTED`);
      }
    }),
  );
}
