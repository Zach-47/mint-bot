import https from "node:https";
import { URL } from "node:url";
import { USER_AGENT } from "./config.js";
import { warn } from "./log.js";

const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 24,
  maxFreeSockets: 24,
  timeout: 15_000,
});

export interface RpcError {
  code?: number;
  message: string;
}

interface ParsedUrl {
  hostname: string;
  port: number;
  path: string;
}

const urlCache = new Map<string, ParsedUrl>();

function parse(url: string): ParsedUrl {
  const hit = urlCache.get(url);
  if (hit) return hit;
  const u = new URL(url);
  const p: ParsedUrl = {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : 443,
    path: `${u.pathname}${u.search}`,
  };
  urlCache.set(url, p);
  return p;
}

let nextId = 1;
export function rpcId(): number {
  return nextId++;
}

/**
 * Raw POST of an already-serialised JSON body. This is the only function the
 * hot path touches - it does no encoding, no stringify, no allocation beyond
 * the request itself.
 */
export function post(url: string, body: string, timeoutMs = 15_000): Promise<string> {
  const u = parse(url);
  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        agent,
        hostname: u.hostname,
        port: u.port,
        path: u.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": USER_AGENT,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
            return;
          }
          resolve(text);
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

function unwrap(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 200)}`);
  }
  const o = parsed as { error?: RpcError; result?: unknown };
  if (o.error) {
    const err = new Error(o.error.message) as Error & { code?: number };
    if (o.error.code !== undefined) err.code = o.error.code;
    throw err;
  }
  return o.result;
}

export function buildBody(method: string, params: unknown[], id = rpcId()): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export async function call(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  return unwrap(await post(url, buildBody(method, params)));
}

/** Same as call() but returns the RPC error instead of throwing. */
export async function callSafe(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<{ result: unknown; error: RpcError | null }> {
  try {
    return { result: await call(url, method, params), error: null };
  } catch (e) {
    const err = e as Error & { code?: number };
    return { result: null, error: { message: err.message, ...(err.code !== undefined ? { code: err.code } : {}) } };
  }
}

export interface BatchRequest {
  method: string;
  params: unknown[];
}

export async function callBatch(
  url: string,
  requests: BatchRequest[],
): Promise<Array<{ result: unknown; error: RpcError | null }>> {
  if (requests.length === 0) return [];
  const bodies = requests.map((r) => ({ jsonrpc: "2.0", id: rpcId(), method: r.method, params: r.params }));
  const text = await post(url, JSON.stringify(bodies));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON batch response: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`batch response was not an array: ${text.slice(0, 200)}`);
  const byId = new Map<number, { result?: unknown; error?: RpcError }>();
  for (const item of parsed as Array<{ id: number; result?: unknown; error?: RpcError }>) {
    byId.set(item.id, item);
  }
  return bodies.map((b) => {
    const hit = byId.get(b.id);
    if (!hit) return { result: null, error: { message: "no response for request id" } };
    if (hit.error) return { result: null, error: hit.error };
    return { result: hit.result ?? null, error: null };
  });
}

export interface SendResult {
  txHash: string | null;
  error: RpcError | null;
}

export async function sendRaw(url: string, rawTxHex: string): Promise<SendResult> {
  const r = await callSafe(url, "eth_sendRawTransaction", [rawTxHex]);
  if (r.error) return { txHash: null, error: r.error };
  return { txHash: typeof r.result === "string" ? r.result : null, error: null };
}

/**
 * Keep-alive warmer. This process may idle for days; a cold socket means a
 * full TCP+TLS handshake at exactly the moment that matters.
 *
 * RPC_URL gets eth_chainId (cheap, doubles as a liveness check).
 * SEQUENCER_URL accepts no read methods, so the only way to keep its socket
 * hot is a deliberately-invalid eth_sendRawTransaction. The error is expected.
 */
export function startWarmer(urls: string[], intervalMs: number): NodeJS.Timeout {
  const warmOnce = (url: string): void => {
    const isSequencer = url.includes("sequencer");
    const body = isSequencer
      ? buildBody("eth_sendRawTransaction", ["0x00"])
      : buildBody("eth_chainId", []);
    post(url, body, 10_000).catch((e: Error) => {
      warn(`warmer: ${url} failed: ${e.message}`);
    });
  };
  const tick = (): void => {
    for (const u of urls) warmOnce(u);
  };
  tick();
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return t;
}

export function closeSockets(): void {
  agent.destroy();
}
