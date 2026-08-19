import tls from "node:tls";
import { URL } from "node:url";
import { USER_AGENT } from "./config.js";
import { log, warn } from "./log.js";

/**
 * A pool of persistent TLS sockets carrying pre-framed HTTP/1.1 requests.
 *
 * Node's https.request costs ~0.2 ms of synchronous work per call - object
 * construction, header validation, socket assignment. Ten of those blows the
 * dispatch budget. Here the entire HTTP request (headers + body) is built as
 * bytes at pre-sign time, so firing is a single socket.write() per tx, ~0.05 ms.
 *
 * One socket per transaction, so no pipelining is needed: socket i carries
 * exactly one in-flight request and its response resolves that request.
 *
 * This is a speed path, not a correctness path. If a socket is not ready the
 * caller falls back to the ordinary https client, and if response parsing ever
 * fails we still hold the locally-computed tx hash and confirm via receipts.
 */

/**
 * Parse one complete HTTP/1.1 response out of `text`.
 *
 * Returns null when the response is not yet complete, so the caller keeps
 * buffering. Handles both framings this chain uses: the RPC replies with
 * Transfer-Encoding: chunked, the sequencer with Content-Length.
 *
 * Pure and exported so it can be tested directly - it is the only hand-written
 * protocol code in the dispatch path.
 */
export function parseHttpResponse(text: string): { payload: string } | null {
  const split = text.indexOf("\r\n\r\n");
  if (split === -1) return null;

  const head = text.slice(0, split);
  const rest = text.slice(split + 4);
  const lower = head.toLowerCase();

  if (lower.includes("transfer-encoding: chunked")) {
    // <size-hex>\r\n<data>\r\n ... 0\r\n\r\n
    let out = "";
    let p = 0;
    for (;;) {
      const nl = rest.indexOf("\r\n", p);
      if (nl === -1) return null;
      const size = parseInt(rest.slice(p, nl).trim(), 16);
      if (Number.isNaN(size)) return null;
      if (size === 0) {
        // Consume the terminator too, so nothing is left in the buffer to
        // corrupt the next response on this socket. Normally "0\r\n\r\n";
        // tolerate optional trailers before the final blank line.
        const after = rest.slice(nl + 2);
        if (after.startsWith("\r\n")) return { payload: out };
        const endTrailers = after.indexOf("\r\n\r\n");
        if (endTrailers !== -1) return { payload: out };
        return null;
      }
      const start = nl + 2;
      if (rest.length < start + size) return null;
      out += rest.slice(start, start + size);
      p = start + size + 2;
    }
  }

  const m = /content-length:\s*(\d+)/i.exec(head);
  if (!m) return null;
  const want = Number(m[1]);
  if (Buffer.byteLength(rest) < want) return null;
  return { payload: rest.slice(0, want) };
}

interface Lane {
  socket: tls.TLSSocket | null;
  connecting: boolean;
  /** resolver for the request currently in flight on this socket */
  pending: ((r: { body: string | null; error: string | null }) => void) | null;
  buf: Buffer;
}

export class FastLane {
  readonly url: string;
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private lanes: Lane[] = [];

  constructor(url: string, size: number) {
    const u = new URL(url);
    this.url = url;
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : 443;
    this.path = u.pathname === "" ? "/" : u.pathname;
    for (let i = 0; i < size; i++) {
      this.lanes.push({ socket: null, connecting: false, pending: null, buf: Buffer.alloc(0) });
    }
  }

  /** Build the complete HTTP/1.1 request bytes for a JSON body. Done once, off the hot path. */
  frame(jsonBody: string): Buffer {
    const len = Buffer.byteLength(jsonBody);
    return Buffer.from(
      `POST ${this.path} HTTP/1.1\r\n` +
        `Host: ${this.host}\r\n` +
        `Content-Type: application/json\r\n` +
        `User-Agent: ${USER_AGENT}\r\n` +
        `Accept: application/json\r\n` +
        `Connection: keep-alive\r\n` +
        `Content-Length: ${len}\r\n\r\n` +
        jsonBody,
    );
  }

  get size(): number {
    return this.lanes.length;
  }

  readyCount(): number {
    return this.lanes.filter((l) => l.socket !== null && !l.socket.destroyed && l.socket.writable).length;
  }

  private handleData(lane: Lane, chunk: Buffer): void {
    lane.buf = lane.buf.length === 0 ? chunk : Buffer.concat([lane.buf, chunk]);
    const parsed = parseHttpResponse(lane.buf.toString("utf8"));
    if (!parsed) return; // incomplete, keep buffering
    lane.buf = Buffer.alloc(0);
    const resolve = lane.pending;
    lane.pending = null;
    if (resolve) resolve({ body: parsed.payload, error: null });
  }

  private connectLane(lane: Lane): Promise<void> {
    if (lane.connecting) return Promise.resolve();
    lane.connecting = true;
    return new Promise<void>((resolve) => {
      const s = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {
        s.setNoDelay(true);
        lane.socket = s;
        lane.connecting = false;
        resolve();
      });
      s.on("data", (d: Buffer) => this.handleData(lane, d));
      const drop = (why: string): void => {
        lane.connecting = false;
        lane.socket = null;
        lane.buf = Buffer.alloc(0);
        const p = lane.pending;
        lane.pending = null;
        if (p) p({ body: null, error: `socket ${why}` });
        resolve();
      };
      s.on("error", (e: Error) => drop(e.message));
      s.on("close", () => drop("closed"));
      s.on("end", () => drop("ended"));
    });
  }

  /** Open every lane. Call well before the trigger. */
  async connect(): Promise<number> {
    await Promise.all(this.lanes.map((l) => (l.socket ? Promise.resolve() : this.connectLane(l))));
    return this.readyCount();
  }

  /** Reopen any lane that has dropped. Cheap when everything is healthy. */
  async heal(): Promise<number> {
    const dead = this.lanes.filter((l) => !l.socket || l.socket.destroyed);
    if (dead.length > 0) {
      await Promise.all(dead.map((l) => this.connectLane(l)));
    }
    return this.readyCount();
  }

  /**
   * HOT PATH. Writes pre-framed bytes to lane `i`. Synchronous, never throws.
   * Returns null if the lane was not usable, so the caller can fall back.
   */
  fire(i: number, frame: Buffer): Promise<{ body: string | null; error: string | null }> | null {
    const lane = this.lanes[i];
    if (!lane || !lane.socket || lane.socket.destroyed || !lane.socket.writable) return null;
    if (lane.pending) return null; // lane already busy
    const p = new Promise<{ body: string | null; error: string | null }>((resolve) => {
      lane.pending = resolve;
    });
    try {
      lane.socket.write(frame);
    } catch {
      lane.pending = null;
      return null;
    }
    return p;
  }

  /** Keep sockets from idling out. Sends a real request down every lane. */
  async warm(frame: Buffer): Promise<void> {
    await this.heal();
    const waits: Promise<unknown>[] = [];
    for (let i = 0; i < this.lanes.length; i++) {
      const p = this.fire(i, frame);
      if (p) waits.push(p);
    }
    await Promise.allSettled(waits);
  }

  destroy(): void {
    for (const l of this.lanes) {
      l.socket?.destroy();
      l.socket = null;
    }
  }
}

export function logLaneHealth(lanes: FastLane[]): void {
  for (const l of lanes) {
    const ready = l.readyCount();
    const msg = `fastlane ${l.url}: ${ready}/${l.size} sockets ready`;
    if (ready < l.size) warn(msg);
    else log(msg);
  }
}
