import {
  CHAIN_ID_HEX,
  CONTRACT,
  GAS_MINT,
  MAX_FEE,
  type Config,
} from "./config.js";
import { fail, fmtEth, log, ok, warn } from "./log.js";
import { call, callBatch, callSafe } from "./rpc.js";
import { fetchWalletState } from "./presign.js";
import { decodeStats, fmtStats, STATS_CALL } from "./stats.js";

export interface DoctorResult {
  failures: number;
  warnings: number;
  medianRttMs: number;
}

export async function doctor(cfg: Config): Promise<DoctorResult> {
  let failures = 0;
  let warnings = 0;
  const FAIL = (m: string): void => {
    failures++;
    fail(m);
  };
  const WARN = (m: string): void => {
    warnings++;
    warn(m);
  };

  /* 1. chain id */
  try {
    const id = (await call(cfg.rpcUrl, "eth_chainId", [])) as string;
    if (BigInt(id) === BigInt(CHAIN_ID_HEX)) ok(`chainId ${id} (${Number(BigInt(id))})`);
    else FAIL(`chainId is ${id}, expected ${CHAIN_ID_HEX}`);
  } catch (e) {
    FAIL(`eth_chainId on RPC_URL failed: ${(e as Error).message}`);
  }

  /* 2. sequencer is the send-only endpoint */
  {
    const r = await callSafe(cfg.sequencerUrl, "eth_blockNumber", []);
    if (r.error && r.error.code === -32601) {
      ok(`sequencer reachable and rejects reads with -32601 (send-only, URL correct)`);
    } else if (r.error) {
      WARN(`sequencer rejected eth_blockNumber with "${r.error.message}" (expected code -32601)`);
    } else {
      WARN(`sequencer ANSWERED eth_blockNumber (${String(r.result)}) - is SEQUENCER_URL right?`);
    }
  }

  /* 3. contract has code */
  try {
    const code = (await call(cfg.rpcUrl, "eth_getCode", [CONTRACT, "latest"])) as string;
    if (code && code !== "0x") ok(`contract has code at ${CONTRACT} (${(code.length - 2) / 2} bytes)`);
    else FAIL(`no code at ${CONTRACT}`);
  } catch (e) {
    FAIL(`eth_getCode failed: ${(e as Error).message}`);
  }

  /* 4. mintStats decodes */
  let statsOk = false;
  try {
    const hex = (await call(cfg.rpcUrl, "eth_call", [STATS_CALL, "latest"])) as string;
    const s = decodeStats(hex);
    ok(`mintStats: ${fmtStats(s)}`);
    log(`  remaining = ${s.cap - s.minted}`);
    if (s.price !== 1_100_000_000_000_000n) {
      FAIL(`on-chain price ${s.price} != hardcoded 1100000000000000 - DO NOT ARM`);
    }
    if (s.active !== 0n) warn(`mintActive is ALREADY TRUE - the flip may have happened`);
    statsOk = true;
  } catch (e) {
    FAIL(`mintStats decode failed: ${(e as Error).message}`);
  }
  void statsOk;

  /* 5. per-wallet balance / nonce / mintedBy */
  try {
    const state = await fetchWalletState(cfg, cfg.wallets);
    const balances = await callBatch(
      cfg.rpcUrl,
      cfg.wallets.map((w) => ({ method: "eth_getBalance", params: [w.address, "latest"] })),
    );
    for (let i = 0; i < cfg.wallets.length; i++) {
      const w = cfg.wallets[i]!;
      const s = state.find((x) => x.index === w.index)!;
      const br = balances[i]!;
      if (br.error) {
        FAIL(`balance fetch failed for ${w.address}: ${br.error.message}`);
        continue;
      }
      const bal = BigInt(br.result as string);
      const line = `wallet[${w.index}] ${w.address} bal=${fmtEth(bal)} nonce=${s.nonce} mintedBy=${s.mintedBy}`;
      if (bal < cfg.minBalance) {
        FAIL(`${line} -- UNDER-FUNDED, need >= ${fmtEth(cfg.minBalance)}`);
      } else if (bal < cfg.warnBalance) {
        WARN(`${line} -- below ${fmtEth(cfg.warnBalance)}, sweep gas will be tight`);
      } else {
        ok(line);
      }
      if (s.mintedBy > 0n) {
        warn(`  wallet[${w.index}] has already minted ${s.mintedBy} - it will be skipped at presign`);
      }
    }
  } catch (e) {
    FAIL(`wallet state fetch failed: ${(e as Error).message}`);
  }

  /* 6. latency profile */
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    try {
      await call(cfg.rpcUrl, "eth_chainId", []);
      samples.push(performance.now() - t);
    } catch {
      /* counted by omission */
    }
  }
  let median = 0;
  if (samples.length === 0) {
    FAIL("latency profile: all 30 probes failed");
  } else {
    samples.sort((a, b) => a - b);
    median = samples[Math.floor(samples.length / 2)]!;
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!;
    const line = `latency n=${samples.length} min=${samples[0]!.toFixed(1)}ms median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms`;
    if (median > 60) WARN(`${line} -- median > 60ms, consider a closer region`);
    else ok(line);
  }

  /* 7. armed state */
  log("");
  log(`================  ARMED = ${cfg.armed ? "TRUE (will broadcast)" : "FALSE (will not broadcast)"}  ================`);
  log(`mint value per wallet: ${fmtEth(cfg.mintValue)} | gas reservation: ${fmtEth(GAS_MINT * MAX_FEE)}`);
  log(`minimum balance per wallet: ${fmtEth(cfg.minBalance)}`);
  log(`doctor: ${failures} FAIL, ${warnings} WARN`);

  return { failures, warnings, medianRttMs: median };
}
