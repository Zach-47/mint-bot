import {
  NONCE_REFRESH_MS,
  WARMER_INTERVAL_MS,
  loadConfig,
  logConfig,
  type Config,
} from "./config.js";
import { error, fail, fmtEth, fmtMs, log, ok, warn } from "./log.js";
import { closeSockets, startWarmer } from "./rpc.js";
import { fetchWalletState, noncesChanged, presign, type PreparedTx } from "./presign.js";
import { startDryFirePoller, startPoller } from "./poller.js";
import { blast, collect, waitForReceipts, wouldFire } from "./blast.js";
import { Dispatcher } from "./dispatcher.js";
import { doctor } from "./doctor.js";
import { simulate } from "./simulate.js";
import { sweep, sweepDust } from "./sweep.js";
import { STATS_CALL } from "./stats.js";

const USAGE = `minipengs-bot

  doctor        preflight checks, exit non-zero on failure
  simulate      state-override gas simulation per wallet
  presign       sign and print tx hashes without broadcasting
  watch         poll and fire on trigger (default on Railway)
  dry-fire      full pipeline with an artificial trigger, no broadcast
  sweep         consolidate NFTs to RECIPIENT
  sweep --dust  return leftover native balance to RECIPIENT
`;

function logPresign(r: Awaited<ReturnType<typeof presign>>): void {
  log(`pre-signed ${r.prepared.length} tx in ${fmtMs(r.signMs)}`);
  for (const p of r.prepared) {
    log(`  ARMED wallet[${p.index}] ${p.address} nonce=${p.nonce} tx=${p.txHash}`);
  }
  for (const s of r.skipped) {
    warn(`  SKIP  wallet[${s.index}] ${s.address} already minted ${s.mintedBy} (at wallet limit)`);
  }
  log(`total value committed: ${fmtEth(r.totalValue)}`);
}

async function cmdWatch(cfg: Config): Promise<number> {
  logConfig(cfg);

  /* 2. doctor - abort on FAIL */
  log("--- preflight ---");
  const d = await doctor(cfg);
  if (d.failures > 0) {
    fail(`doctor reported ${d.failures} failure(s) - refusing to start watch`);
    return 1;
  }

  /* 3+4. warm sockets and keep them warm */
  log("--- arming ---");
  const warmer = startWarmer([cfg.rpcUrl, cfg.sequencerUrl], WARMER_INTERVAL_MS);

  /* 5+6. pre-sign */
  let result = await presign(cfg);
  logPresign(result);
  let prepared: PreparedTx[] = result.prepared;

  if (prepared.length === 0) {
    ok("every wallet is already at the wallet limit - nothing to do");
    clearInterval(warmer);
    return 0;
  }

  /* Build the fire-control: one pre-framed HTTP request per (tx x endpoint),
     each on its own persistent TLS socket. All of it before the trigger. */
  const endpoints = [cfg.rpcUrl, cfg.sequencerUrl];
  let dispatcher = new Dispatcher(prepared, endpoints);
  await dispatcher.connect();

  if (!cfg.armed) {
    warn("ARMED=false - the poller will run but WILL NOT BROADCAST");
  }

  /* 7. nonce freshness */
  const nonceTimer = setInterval(() => {
    fetchWalletState(cfg, cfg.wallets)
      .then(async (fresh) => {
        if (!noncesChanged(prepared, fresh)) return;
        warn("NONCE CHANGED - re-signing every transaction");
        const re = await presign(cfg);
        prepared = re.prepared;
        result = re;
        logPresign(re);
        const old = dispatcher;
        dispatcher = new Dispatcher(prepared, endpoints);
        await dispatcher.connect();
        old.destroy();
        warn("re-framed and reconnected every socket for the new nonces");
      })
      .catch((e: Error) => warn(`nonce refresh failed: ${e.message}`));
  }, NONCE_REFRESH_MS);

  /* 8+9. poll */
  log(`polling mintStats() every ${cfg.pollIntervalMs}ms (pipelined, non-blocking)`);

  return await new Promise<number>((resolve) => {
    // Keep every pre-framed socket hot. A cold socket at trigger time means a
    // TCP+TLS handshake at exactly the moment that matters.
    const laneWarmer = setInterval(() => {
      void dispatcher.warm().then(() => {
        const { ready, total } = dispatcher.ready();
        if (ready < total) warn(`fastlane degraded: ${ready}/${total} sockets ready`);
      });
    }, WARMER_INTERVAL_MS);

    const finish = (code: number): void => {
      clearInterval(warmer);
      clearInterval(nonceTimer);
      clearInterval(laneWarmer);
      dispatcher.destroy();
      resolve(code);
    };

    startPoller(cfg, {
      onSoldOut: () => {
        warn("sold out before we fired");
        finish(0);
      },
      onTrigger: (stats, t0) => {
        void stats;
        if (!cfg.armed) {
          wouldFire(prepared, endpoints);
          log(`trigger->wouldFire in ${fmtMs(performance.now() - t0)}`);
          finish(0);
          return;
        }

        /* 10. blast - synchronous pre-framed writes, nothing awaited */
        const { dispatchMs, results } = blast(dispatcher);
        log(`trigger->dispatch ${fmtMs(performance.now() - t0)} (dispatch ${fmtMs(dispatchMs)})`);

        void (async () => {
          try {
            const outcomes = await collect(prepared, results);
            const receipts = await waitForReceipts(cfg, prepared, outcomes, t0);

            const succeeded = receipts.filter((r) => r.status === 1n);
            const reverted = receipts.filter((r) => r.status !== 1n);
            const noReceipt = outcomes.filter(
              (o) => !receipts.some((r) => r.index === o.index),
            );
            const totalGas = receipts.reduce((a, r) => a + r.gasUsed, 0n);

            log("--- summary ---");
            log(`wallets dispatched : ${prepared.length}`);
            log(`minted             : ${succeeded.length}`);
            log(`reverted           : ${reverted.length}`);
            log(`no receipt         : ${noReceipt.length}`);
            log(`total gas used     : ${totalGas}`);
            log(`tokens acquired    : ${succeeded.length * cfg.quantity}`);
            if (succeeded.length > 0) {
              ok(`run \`npm run sweep\` to consolidate to ${cfg.recipient}`);
            }
            /* 11. exit cleanly - Railway ON_FAILURE must not respawn us */
            finish(succeeded.length > 0 ? 0 : 1);
          } catch (e) {
            error(`post-dispatch handling failed: ${(e as Error).message}`);
            finish(1);
          }
        })();
      },
    });
  });
}

async function cmdDryFire(cfg: Config): Promise<number> {
  logConfig(cfg);
  const warmer = startWarmer([cfg.rpcUrl, cfg.sequencerUrl], WARMER_INTERVAL_MS);
  const result = await presign(cfg);
  logPresign(result);
  if (result.prepared.length === 0) {
    warn("nothing pre-signed - every wallet is at the limit");
    clearInterval(warmer);
    return 0;
  }

  /* Identical pipeline to watch, except every pre-framed body is an eth_call
     instead of eth_sendRawTransaction. Same socket count, same framing, same
     dispatch loop - so the measured latency is the real one. */
  const endpoints = [cfg.rpcUrl, cfg.sequencerUrl];
  const callBodies: PreparedTx[] = result.prepared.map((p) => ({
    ...p,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2000 + p.index,
      method: "eth_call",
      params: [STATS_CALL, "latest"],
    }),
  }));
  const dispatcher = new Dispatcher(callBodies, endpoints);
  await dispatcher.connect();
  const { ready, total } = dispatcher.ready();
  log(`dry-fire: ${ready}/${total} pre-framed sockets ready`);
  log("dry-fire: artificial trigger when the block number crosses a multiple of 50, eth_call instead of send");

  return await new Promise<number>((resolve) => {
    startDryFirePoller(cfg, (bn, t0) => {
      void bn;
      const { dispatchMs, results, fallbacks } = blast(dispatcher);
      const e2e = performance.now() - t0;
      log(`DRY-FIRE dispatch=${fmtMs(dispatchMs)} trigger->dispatch=${fmtMs(e2e)} fallbacks=${fallbacks}`);
      if (dispatchMs >= 1) {
        warn(`dispatch >= 1ms - something is being computed that should be precomputed`);
      } else ok("dispatch < 1ms");
      if (e2e >= 5) warn(`trigger->dispatch >= 5ms`);
      else ok("trigger->dispatch < 5ms");

      void results.then((shots) => {
        const answered = shots.filter((s) => s.text !== null).length;
        log(`responses: ${answered}/${shots.length} returned cleanly`);
        for (const s of shots.filter((x) => x.text === null)) {
          warn(`  no response from ${s.url}: ${s.transportError}`);
        }
        clearInterval(warmer);
        dispatcher.destroy();
        resolve(answered === shots.length ? 0 : 1);
      });
    });
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "watch";

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cfg = loadConfig();

  switch (cmd) {
    case "doctor": {
      logConfig(cfg);
      const r = await doctor(cfg);
      return r.failures > 0 ? 1 : 0;
    }
    case "simulate": {
      logConfig(cfg);
      const failures = await simulate(cfg);
      return failures > 0 ? 1 : 0;
    }
    case "presign": {
      logConfig(cfg);
      const r = await presign(cfg);
      logPresign(r);
      return r.prepared.length > 0 ? 0 : 1;
    }
    case "watch":
      return await cmdWatch(cfg);
    case "dry-fire":
      return await cmdDryFire(cfg);
    case "sweep": {
      logConfig(cfg);
      if (argv.includes("--dust")) {
        await sweepDust(cfg);
      } else {
        await sweep(cfg);
      }
      return 0;
    }
    default:
      fail(`unknown subcommand "${cmd}"`);
      process.stdout.write(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    closeSockets();
    process.exit(code);
  })
  .catch((e: Error) => {
    error(`fatal: ${e.message}`);
    if (e.stack) process.stdout.write(e.stack + "\n");
    closeSockets();
    process.exit(1);
  });
