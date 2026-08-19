import type { Config } from "./config.js";
import { error, fmtMs, log, ok, warn } from "./log.js";
import type { PreparedTx } from "./presign.js";
import { call, post } from "./rpc.js";
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

/**
 * Is this failure worth re-sending for?
 *
 * Only transport-level problems and rate limiting. A substantive rejection
 * (nonce too low, insufficient funds, reverted) will fail identically on a
 * second attempt and would only burn the window.
 */
export function isRetryable(err: string | null): boolean {
  if (!err) return false;
  const m = err.toLowerCase();
  if (m.includes("nonce too low")) return false;
  if (m.includes("insufficient funds")) return false;
  if (m.includes("intrinsic gas")) return false;
  if (m.includes("execution reverted")) return false;
  if (m.includes("underpriced")) return false;
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("socket") ||
    m.includes("timeout") ||
    m.includes("econnreset") ||
    m.includes("epipe") ||
    m.includes("hang up") ||
    m.includes("no response") ||
    m.includes("unparseable") ||
    m.includes("http 5")
  );
}

function accepted(s: ShotResult): boolean {
  if (s.text === null) return false;
  const p = parseSendResponse(s.text);
  return p.error === null || isAcceptedError(p.error);
}

export interface RetryOptions {
  deadlineMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** injectable for tests; defaults to the ordinary https client */
  send?: (url: string, body: string) => Promise<string>;
}

/**
 * Re-send transactions whose broadcast failed for transport or rate-limit
 * reasons. Re-sending a pre-signed transaction is free and idempotent - same
 * bytes, same nonce, so at worst the node answers "already known" and only one
 * can ever land.
 *
 * This runs AFTER the synchronous dispatch, so it never touches hot-path
 * timing. By this point the poller has stopped, so these are the only requests
 * in flight and the rate-limit budget is refilling rather than draining.
 *
 * A wallet stops being retried the moment ANY endpoint accepts it.
 */
export async function retryFailed(
  shots: ShotResult[],
  opts: RetryOptions = {},
): Promise<ShotResult[]> {
  const deadlineMs = opts.deadlineMs ?? 3_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const send = opts.send ?? post;
  const deadline = Date.now() + deadlineMs;

  const out = [...shots];
  const satisfied = new Set<number>();
  for (const s of out) if (accepted(s)) satisfied.add(s.tx.index);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const todo: number[] = [];
    for (let i = 0; i < out.length; i++) {
      const s = out[i]!;
      if (satisfied.has(s.tx.index)) continue;
      const err = s.text === null ? s.transportError : parseSendResponse(s.text).error;
      if (isRetryable(err)) todo.push(i);
    }
    if (todo.length === 0) break;
    if (Date.now() >= deadline) {
      warn(`retry deadline reached with ${todo.length} broadcast(s) still failing`);
      break;
    }

    await new Promise((r) => setTimeout(r, baseDelayMs * attempt));

    log(`retrying ${todo.length} broadcast(s), attempt ${attempt}/${maxAttempts}`);
    await Promise.all(
      todo.map(async (i) => {
        const s = out[i]!;
        try {
          const text = await send(s.url, s.tx.body);
          out[i] = { ...s, text, transportError: null };
          if (accepted(out[i]!)) satisfied.add(s.tx.index);
        } catch (e) {
          out[i] = { ...s, text: null, transportError: (e as Error).message };
        }
      }),
    );
  }
  return out;
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
