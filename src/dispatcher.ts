import { FastLane } from "./fastlane.js";
import { log, warn } from "./log.js";
import type { PreparedTx } from "./presign.js";
import { post } from "./rpc.js";

export interface Shot {
  tx: PreparedTx;
  url: string;
  laneIndex: number;
  frame: Buffer;
  lane: FastLane;
}

/**
 * Everything needed to fire, assembled before the trigger: one TLS socket per
 * (transaction x endpoint), each with its complete HTTP request pre-framed as
 * bytes. At trigger time this only writes those bytes.
 */
export class Dispatcher {
  readonly lanes: FastLane[];
  readonly shots: Shot[] = [];
  private readonly warmFrames = new Map<FastLane, Buffer>();

  constructor(prepared: PreparedTx[], urls: string[]) {
    this.lanes = urls.map((u) => new FastLane(u, prepared.length));
    for (let li = 0; li < this.lanes.length; li++) {
      const lane = this.lanes[li]!;
      // A harmless request used only to keep each socket hot. It errors on
      // both endpoints - the handshake is the point.
      this.warmFrames.set(
        lane,
        lane.frame(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "eth_sendRawTransaction", params: ["0x00"] })),
      );
      for (let i = 0; i < prepared.length; i++) {
        const tx = prepared[i]!;
        this.shots.push({ tx, url: lane.url, laneIndex: i, frame: lane.frame(tx.body), lane });
      }
    }
  }

  async connect(): Promise<void> {
    for (const lane of this.lanes) {
      const ready = await lane.connect();
      const msg = `fastlane ${lane.url}: ${ready}/${lane.size} sockets open`;
      if (ready < lane.size) warn(`${msg} - short lanes will fall back to the https client`);
      else log(msg);
    }
    // One warm pass now. This keeps the sockets hot AND runs the exact fire()
    // path once, so it is JIT-compiled before the trigger rather than at it.
    await this.warm();
    await this.warm();
  }

  /** Keep every socket hot. Safe to call on a timer; never throws. */
  async warm(): Promise<void> {
    await Promise.allSettled(
      this.lanes.map(async (lane) => {
        const f = this.warmFrames.get(lane)!;
        await lane.warm(f);
      }),
    );
  }

  ready(): { ready: number; total: number } {
    return {
      ready: this.lanes.reduce((a, l) => a + l.readyCount(), 0),
      total: this.lanes.reduce((a, l) => a + l.size, 0),
    };
  }

  destroy(): void {
    for (const l of this.lanes) l.destroy();
  }
}

export interface ShotResult {
  tx: PreparedTx;
  url: string;
  /** raw JSON response text, or null if the transport itself failed */
  text: string | null;
  transportError: string | null;
  viaFallback: boolean;
}

/**
 * THE HOT PATH. One synchronous pre-framed write per shot. Any lane that is
 * not usable falls back to the ordinary https client so the transaction still
 * goes out - slower, but never dropped.
 */
export function fire(d: Dispatcher): {
  dispatchMs: number;
  results: Promise<ShotResult[]>;
  fallbacks: number;
} {
  const t0 = performance.now();
  const pending: Array<Promise<ShotResult>> = [];
  let fallbacks = 0;

  for (const s of d.shots) {
    const p = s.lane.fire(s.laneIndex, s.frame);
    if (p) {
      pending.push(
        p.then((r) => ({
          tx: s.tx,
          url: s.url,
          text: r.body,
          transportError: r.error,
          viaFallback: false,
        })),
      );
    } else {
      fallbacks++;
      pending.push(
        post(s.url, s.tx.body)
          .then((text) => ({ tx: s.tx, url: s.url, text, transportError: null, viaFallback: true }))
          .catch((e: Error) => ({
            tx: s.tx,
            url: s.url,
            text: null,
            transportError: e.message,
            viaFallback: true,
          })),
      );
    }
  }

  const dispatchMs = performance.now() - t0;
  return { dispatchMs, results: Promise.all(pending), fallbacks };
}
