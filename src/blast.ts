import type { Config } from "./config.js";
import { error, fmtMs, log, ok, warn } from "./log.js";
import type { PreparedTx } from "./presign.js";
import { call } from "./rpc.js";
import { fire, type Dispatcher, type ShotResult } from "./dispatcher.js";

export interface EndpointOutcome {
  url: string;
  accepted: boolean;
  txHash: string | null;
  error: string | null;
  viaFallback: boolean;
}

export interface WalletOutcome {
  index: number;
  address: string;
  txHash: string;
  endpoints: EndpointOutcome[];
  accepted: boolean;
}

const ACCEPTED_ERROR_PATTERNS = [
  "already known",
  "already exists",
  "known transaction",
  "transaction already in pool",
];

function isAcceptedError(msg: string): boolean {
  const m = msg.toLowerCase();
  return ACCEPTED_ERROR_PATTERNS.some((p) => m.includes(p));
}

function hint(msg: string): string | null {
  const m = msg.toLowerCase();
  if (m.includes("insufficient funds")) return "wallet is under-funded";
  if (m.includes("nonce too low")) return "stale pre-sign - a tx from this wallet already landed";
  if (m.includes("nonce too high")) return "gap in nonces - another tx is pending ahead of this one";
  if (m.includes("max fee per gas less than block base fee")) {
    return "base fee moved above the 2 gwei ceiling - should not happen on this chain";
  }
  if (m.includes("replacement transaction underpriced")) return "a tx with this nonce is already pending";
  if (m.includes("intrinsic gas too low")) return "gas limit below intrinsic cost";
  if (m.includes("execution reverted")) return "the contract rejected the mint";
  if (m.includes("429") || m.includes("too many requests")) {
    return "rate limited on broadcast - the other endpoint is the fallback";
  }
  return null;
}

/** THE HOT PATH. Delegates to the pre-framed socket dispatcher. */
export function blast(d: Dispatcher): {
  dispatchMs: number;
  results: Promise<ShotResult[]>;
  fallbacks: number;
} {
  const r = fire(d);
  const txCount = new Set(d.shots.map((s) => s.tx.index)).size;
  log(
    `DISPATCHED ${txCount} tx across ${d.lanes.length} endpoints in ${fmtMs(r.dispatchMs)}` +
      (r.fallbacks > 0 ? ` (${r.fallbacks} via https fallback)` : ""),
  );
  return r;
}

function parseSendResponse(text: string): { txHash: string | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { txHash: null, error: `unparseable response: ${text.slice(0, 200)}` };
  }
  const o = parsed as { result?: unknown; error?: { message?: string; code?: number } };
  if (o.error) {
    const code = o.error.code !== undefined ? ` (code ${o.error.code})` : "";
    return { txHash: null, error: `${o.error.message ?? "unknown RPC error"}${code}` };
  }
  return { txHash: typeof o.result === "string" ? o.result : null, error: null };
}

export async function collect(
  prepared: PreparedTx[],
  results: Promise<ShotResult[]>,
): Promise<WalletOutcome[]> {
  const shots = await results;
  const byIndex = new Map<number, WalletOutcome>();
  for (const p of prepared) {
    byIndex.set(p.index, {
      index: p.index,
      address: p.address,
      txHash: p.txHash,
      endpoints: [],
      accepted: false,
    });
  }

  for (const s of shots) {
    const outcome = byIndex.get(s.tx.index);
    if (!outcome) continue;
    if (s.text === null) {
      outcome.endpoints.push({
        url: s.url,
        accepted: false,
        txHash: null,
        error: s.transportError ?? "no response",
        viaFallback: s.viaFallback,
      });
      continue;
    }
    const parsed = parseSendResponse(s.text);
    if (parsed.error && isAcceptedError(parsed.error)) {
      outcome.endpoints.push({
        url: s.url,
        accepted: true,
        txHash: s.tx.txHash,
        error: parsed.error,
        viaFallback: s.viaFallback,
      });
    } else if (parsed.error) {
      outcome.endpoints.push({
        url: s.url,
        accepted: false,
        txHash: null,
        error: parsed.error,
        viaFallback: s.viaFallback,
      });
    } else {
      outcome.endpoints.push({
        url: s.url,
        accepted: true,
        txHash: parsed.txHash,
        error: null,
        viaFallback: s.viaFallback,
      });
    }
  }

  const out = [...byIndex.values()].sort((a, b) => a.index - b.index);
  for (const o of out) {
    o.accepted = o.endpoints.some((e) => e.accepted);
    for (const e of o.endpoints) {
      const short = e.url.replace("https://", "").split(".")[0];
      const via = e.viaFallback ? " [fallback]" : "";
      if (e.accepted) {
        ok(`wallet[${o.index}] ${short}${via}: ACCEPTED ${e.txHash ?? o.txHash}${e.error ? ` (${e.error})` : ""}`);
      } else {
        const h = e.error ? hint(e.error) : null;
        warn(`wallet[${o.index}] ${short}${via}: REJECTED ${e.error}${h ? ` -- ${h}` : ""}`);
      }
    }
    if (!o.accepted) {
      const firstErr = o.endpoints.find((e) => e.error)?.error ?? "unknown";
      const h = hint(firstErr);
      error(
        `wallet[${o.index}] ${o.address} FAILED AT EVERY ENDPOINT: ${firstErr}${h ? ` -- ${h}` : ""}`,
      );
    }
  }
  return out;
}

export interface Receipt {
  index: number;
  address: string;
  txHash: string;
  blockNumber: number;
  txIndex: number;
  gasUsed: bigint;
  status: bigint;
}

/**
 * Poll receipts for every wallet we dispatched. We use the locally-computed tx
 * hash, so this works even if a response could not be parsed.
 */
export async function waitForReceipts(
  cfg: Config,
  prepared: PreparedTx[],
  outcomes: WalletOutcome[],
  t0: number,
  timeoutMs = 60_000,
  intervalMs = 100,
): Promise<Receipt[]> {
  const pending = new Map<string, PreparedTx>();
  for (const p of prepared) {
    const o = outcomes.find((x) => x.index === p.index);
    if (o && !o.accepted) continue; // rejected everywhere, no receipt coming
    pending.set(p.txHash, p);
  }
  if (pending.size === 0) {
    warn("no accepted transactions - nothing to wait for");
    return [];
  }

  const found: Receipt[] = [];
  const deadline = Date.now() + timeoutMs;
  let firstReceiptLogged = false;

  while (pending.size > 0 && Date.now() < deadline) {
    const hashes = [...pending.keys()];
    const results = await Promise.allSettled(
      hashes.map((h) => call(cfg.rpcUrl, "eth_getTransactionReceipt", [h])),
    );
    for (let i = 0; i < hashes.length; i++) {
      const r = results[i]!;
      if (r.status !== "fulfilled" || r.value === null || r.value === undefined) continue;
      const rec = r.value as {
        blockNumber: string;
        transactionIndex: string;
        gasUsed: string;
        status: string;
      };
      const hash = hashes[i]!;
      const p = pending.get(hash)!;
      pending.delete(hash);

      if (!firstReceiptLogged) {
        firstReceiptLogged = true;
        log(`FIRST RECEIPT at +${fmtMs(performance.now() - t0)} from trigger detection`);
      }

      const receipt: Receipt = {
        index: p.index,
        address: p.address,
        txHash: hash,
        blockNumber: Number(BigInt(rec.blockNumber)),
        txIndex: Number(BigInt(rec.transactionIndex)),
        gasUsed: BigInt(rec.gasUsed),
        status: BigInt(rec.status),
      };
      found.push(receipt);
      const line =
        `wallet[${receipt.index}] block=${receipt.blockNumber} idx=${receipt.txIndex} ` +
        `gasUsed=${receipt.gasUsed} tx=${hash}`;
      if (receipt.status === 1n) ok(`MINTED ${line}`);
      else error(`REVERTED (status 0x0 - landed but failed, this is NOT a success) ${line}`);
    }
    if (pending.size === 0) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  for (const [hash, p] of pending) {
    error(`wallet[${p.index}] no receipt after ${timeoutMs}ms: ${hash}`);
  }
  return found;
}

export function wouldFire(prepared: PreparedTx[], urls: string[]): void {
  warn(`WOULD FIRE (ARMED=false) - ${prepared.length} tx x ${urls.length} endpoints, not dispatched`);
  for (const p of prepared) {
    warn(`  wallet[${p.index}] ${p.address} nonce=${p.nonce} tx=${p.txHash}`);
  }
}
