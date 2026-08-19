import { HEARTBEAT_MS, type Config } from "./config.js";
import { error, log, makeThrottledLogger, warn } from "./log.js";
import { post } from "./rpc.js";
import { STATS_BODY, decodeStats, remaining, type MintStats } from "./stats.js";

export interface PollerHandle {
  stop(): void;
}

/**
 * Adaptive poll pacing.
 *
 * The RPC enforces a request budget over a rolling window, not a simple
 * per-second rate: measured live, a 50 ms poll ran clean for ~74 s and then
 * started returning HTTP 429, and once the budget is depleted even 100 ms
 * throttles. A process that may wait days cannot use a fixed interval - it
 * will exhaust any budget eventually.
 *
 * So the interval is discovered at runtime: back off multiplicatively when
 * throttled, and creep back toward the target after a clean streak. The loop
 * never stops polling, because a stopped poller misses the flip entirely.
 */
export class RateController {
  current: number;
  private lastChange = 0;
  private readonly target: number;
  private readonly max: number;
  private readonly recoverMs: number;

  constructor(targetMs: number, maxMs: number, recoverMs = 3_000) {
    this.target = targetMs;
    this.max = maxMs;
    this.current = targetMs;
    this.recoverMs = recoverMs;
  }

  /** HTTP 429. Returns true if the interval changed. */
  onThrottled(now = Date.now()): boolean {
    this.lastChange = now;
    const next = Math.min(this.max, Math.max(this.current * 2, this.target * 2));
    if (next === this.current) return false;
    this.current = next;
    return true;
  }

  /**
   * A clean response. Steps back toward the target after `recoverMs` of quiet.
   *
   * Recovery is measured in TIME, not in successful polls. Counting polls
   * couples recovery speed to how slow we already are: at a 2 s backoff, 40
   * polls is 80 seconds per step, so climbing back would take many minutes -
   * and a poller stuck at 2 s can be that far behind the flip.
   */
  onSuccess(now = Date.now()): boolean {
    if (this.current <= this.target) return false;
    if (now - this.lastChange < this.recoverMs) return false;
    this.lastChange = now;
    this.current = Math.max(this.target, Math.round(this.current * 0.8));
    return true;
  }
}

export function isThrottle(msg: string): boolean {
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

export interface PollerHooks {
  /** Fired exactly once, synchronously, the first time active !== 0. */
  onTrigger(stats: MintStats, t0: number): void;
  /** Fired when cap - minted <= 0. The poller stops itself first. */
  onSoldOut(stats: MintStats): void;
}

class Rtt {
  private samples: number[] = [];
  private idx = 0;
  private readonly cap = 256;

  push(ms: number): void {
    if (this.samples.length < this.cap) this.samples.push(ms);
    else {
      this.samples[this.idx] = ms;
      this.idx = (this.idx + 1) % this.cap;
    }
  }

  median(): number {
    if (this.samples.length === 0) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }
}

export interface StatsHandlerDeps {
  onTrigger(stats: MintStats, t0: number): void;
  onSoldOut(stats: MintStats): void;
  onDecodeError(e: Error): void;
  stop(): void;
}

/**
 * The trigger decision, isolated from any timer so it can be tested directly.
 * Returns a handler that fires onTrigger AT MOST ONCE across any number of
 * concurrent invocations.
 */
export function makeStatsHandler(deps: StatsHandlerDeps): (hex: string) => void {
  // The latch. Set before any async work: responses are in flight
  // concurrently and several will report active at once.
  let fired = false;
  let soldOut = false;

  return (hex: string): void => {
    let stats: MintStats;
    try {
      stats = decodeStats(hex);
    } catch (e) {
      deps.onDecodeError(e as Error);
      return;
    }

    if (stats.active === 0n) return;

    if (remaining(stats) <= 0n) {
      if (soldOut) return;
      soldOut = true;
      log(`SOLD OUT (minted=${stats.minted} cap=${stats.cap}) - not firing`);
      deps.stop();
      deps.onSoldOut(stats);
      return;
    }

    if (fired) return;
    fired = true;

    const t0 = performance.now();
    deps.stop();
    log(`TRIGGER active=${stats.active} minted=${stats.minted} cap=${stats.cap}`);
    deps.onTrigger(stats, t0);
  };
}

/** Transport seam: defaults to the real socket post, replaceable in tests. */
export type PollTransport = (url: string, body: string) => Promise<string>;

export interface PollerOptions {
  transport?: PollTransport;
  /** called after every interval change, for tests and observability */
  onIntervalChange?: (ms: number) => void;
}

export function startPoller(
  cfg: Config,
  hooks: PollerHooks,
  opts: PollerOptions = {},
): PollerHandle {
  const transport: PollTransport = opts.transport ?? post;
  let stopped = false;
  let polls = 0;
  let errors = 0;
  let throttles = 0;
  let consecutiveErrors = 0;
  let lastStats: MintStats | null = null;
  const rtt = new Rtt();
  const started = Date.now();
  const throttle = makeThrottledLogger(1000);
  const rate = new RateController(cfg.pollIntervalMs, cfg.pollMaxIntervalMs);
  let timer: NodeJS.Timeout | null = null;

  const onPollError = (e: Error): void => {
    const msg = e.message;
    if (isThrottle(msg)) {
      throttles++;
      consecutiveErrors = 0; // being throttled is not the RPC being down
      if (rate.onThrottled()) {
        reschedule();
        opts.onIntervalChange?.(rate.current);
        warn(`rate limited (429) - backing off to ${rate.current}ms (${throttles} total)`);
      }
      return;
    }
    errors++;
    consecutiveErrors++;
    throttle("poll", () => warn(`poll error (${errors} total): ${msg}`));
    if (consecutiveErrors > 20) {
      throttle("poll-fatal", () =>
        error(`${consecutiveErrors} consecutive poll failures - RPC may be down. Still polling.`),
      );
    }
  };

  const onStats = makeStatsHandler({
    onTrigger: hooks.onTrigger,
    onSoldOut: hooks.onSoldOut,
    onDecodeError: onPollError,
    stop: () => stop(),
  });

  const tick = (): void => {
    if (stopped) return;
    polls++;
    const t = performance.now();
    // Fire and forget - do NOT await. Requests overlap in flight so detection
    // latency approaches RTT alone rather than RTT + interval.
    transport(cfg.rpcUrl, STATS_BODY)
      .then((text) => {
        rtt.push(performance.now() - t);
        consecutiveErrors = 0;
        const o = JSON.parse(text) as { result?: string; error?: { message: string } };
        if (o.error) throw new Error(o.error.message);
        if (typeof o.result !== "string") throw new Error("eth_call returned no result");
        if (rate.onSuccess()) {
          reschedule();
          opts.onIntervalChange?.(rate.current);
          log(`rate recovered - polling every ${rate.current}ms`);
        }
        lastStats = decodeStats(o.result);
        onStats(o.result);
      })
      .catch(onPollError);
  };

  function reschedule(): void {
    if (stopped) return;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, rate.current);
  }

  reschedule();
  tick();

  const heartbeat = setInterval(() => {
    const uptime = Math.floor((Date.now() - started) / 1000);
    const s = lastStats;
    log(
      `HEARTBEAT uptime=${uptime}s polls=${polls} errors=${errors} throttled=${throttles} ` +
        `interval=${rate.current}ms medianRtt=${rtt.median().toFixed(1)}ms ` +
        (s ? `minted=${s.minted}/${s.cap} active=${s.active}` : "stats=none"),
    );
  }, HEARTBEAT_MS);

  function stop(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    clearInterval(heartbeat);
  }

  return { stop };
}

/**
 * dry-fire: identical pipeline, but the trigger is artificial and nothing is
 * broadcast. Measures true end-to-end trigger -> dispatch latency.
 *
 * The trigger fires when the block number CROSSES a multiple of 50, not when
 * it equals one. Block time (~103 ms) is close to the poll RTT, so a poller
 * observes only a fraction of blocks - measured live, 30 of 145, with gaps of
 * up to 6 - and an equality test on a multiple of 50 can miss every one and
 * hang forever. Crossing is observable and keeps the ~5 s cadence.
 *
 * The real trigger is unaffected by this: mintStats() reports current state,
 * and `active` stays true once flipped, so it cannot be missed between blocks.
 */
export function startDryFirePoller(
  cfg: Config,
  onTrigger: (blockNumber: number, t0: number) => void,
): PollerHandle {
  let fired = false;
  let stopped = false;
  let polls = 0;
  let lastBucket = -1;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

  const tick = (): void => {
    if (stopped) return;
    polls++;
    post(cfg.rpcUrl, body)
      .then((text) => {
        const o = JSON.parse(text) as { result?: string };
        if (typeof o.result !== "string") return;
        const bn = Number(BigInt(o.result));
        const bucket = Math.floor(bn / 50);
        if (lastBucket === -1) {
          lastBucket = bucket;
          return;
        }
        if (bucket <= lastBucket) return;
        lastBucket = bucket;
        if (fired) return;
        fired = true;
        const t0 = performance.now();
        stop();
        log(`DRY TRIGGER at block ${bn} (crossed multiple of 50) after ${polls} polls`);
        onTrigger(bn, t0);
      })
      .catch((e: Error) => warn(`dry poll error: ${e.message}`));
  };

  const timer = setInterval(tick, cfg.pollIntervalMs);
  tick();

  function stop(): void {
    stopped = true;
    clearInterval(timer);
  }
  return { stop };
}
