import test from "node:test";
import assert from "node:assert/strict";
import { isRetryable, retryFailed } from "../src/blast.js";
import type { ShotResult } from "../src/dispatcher.js";
import type { PreparedTx } from "../src/presign.js";

const tx = (index: number): PreparedTx => ({
  index,
  address: `0xwallet${index}`,
  txHash: `0xhash${index}`,
  nonce: 0,
  body: `body${index}`,
  raw: "0x",
});

const shot = (index: number, url: string, text: string | null, transportError: string | null = null): ShotResult =>
  ({ tx: tx(index), url, text, transportError, viaFallback: false });

const okBody = (h: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: h });
const errBody = (m: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: m } });
const RATE = errBody("Too Many Requests");

test("classifies only transport and rate-limit failures as retryable", () => {
  assert.ok(isRetryable("HTTP 429: Too Many Requests"));
  assert.ok(isRetryable("socket hang up"));
  assert.ok(isRetryable("request timeout after 15000ms"));
  assert.ok(isRetryable("HTTP 502: bad gateway"));
  // substantive rejections must NOT be retried - they fail identically again
  assert.equal(isRetryable("nonce too low"), false);
  assert.equal(isRetryable("insufficient funds for gas * price + value"), false);
  assert.equal(isRetryable("execution reverted"), false);
  assert.equal(isRetryable("intrinsic gas too low"), false);
  assert.equal(isRetryable("replacement transaction underpriced"), false);
  assert.equal(isRetryable(null), false);
});

test("a rate-limited broadcast is re-sent and succeeds", async () => {
  let calls = 0;
  const out = await retryFailed([shot(0, "https://rpc", RATE)], {
    baseDelayMs: 1,
    send: async () => {
      calls++;
      return okBody("0xhash0");
    },
  });
  assert.equal(calls, 1);
  assert.equal(out[0]!.text, okBody("0xhash0"));
});

test("a substantive rejection is never re-sent", async () => {
  let calls = 0;
  const out = await retryFailed([shot(0, "https://rpc", errBody("nonce too low"))], {
    baseDelayMs: 1,
    send: async () => { calls++; return okBody("0x"); },
  });
  assert.equal(calls, 0, "must not retry a rejection that cannot succeed");
  assert.equal(out[0]!.text, errBody("nonce too low"));
});

test("a wallet already accepted at one endpoint is not retried at the other", async () => {
  let calls = 0;
  const shots = [
    shot(0, "https://rpc", RATE),          // throttled here
    shot(0, "https://sequencer", okBody("0xhash0")), // but accepted here
  ];
  await retryFailed(shots, { baseDelayMs: 1, send: async () => { calls++; return okBody("0x"); } });
  assert.equal(calls, 0, "the transaction is already out - no need to resend");
});

test("'already known' counts as accepted, so it is not retried", async () => {
  let calls = 0;
  await retryFailed([shot(0, "https://rpc", errBody("already known"))], {
    baseDelayMs: 1,
    send: async () => { calls++; return okBody("0x"); },
  });
  assert.equal(calls, 0);
});

test("gives up after maxAttempts and returns the last failure", async () => {
  let calls = 0;
  const out = await retryFailed([shot(0, "https://rpc", RATE)], {
    baseDelayMs: 1,
    maxAttempts: 3,
    send: async () => { calls++; return RATE; },
  });
  assert.equal(calls, 3, "bounded, does not spin forever");
  assert.equal(out[0]!.text, RATE);
});

test("stops at the deadline even with attempts remaining", async () => {
  let calls = 0;
  const t0 = Date.now();
  await retryFailed([shot(0, "https://rpc", RATE)], {
    baseDelayMs: 40,
    maxAttempts: 50,
    deadlineMs: 120,
    send: async () => { calls++; return RATE; },
  });
  const elapsed = Date.now() - t0;
  assert.ok(calls < 50, `must stop early, made ${calls} attempts`);
  assert.ok(elapsed < 1000, `must respect the deadline, took ${elapsed}ms`);
});

test("a transport failure during retry is recorded, not thrown", async () => {
  const out = await retryFailed([shot(0, "https://rpc", null, "socket hang up")], {
    baseDelayMs: 1,
    maxAttempts: 2,
    send: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(out[0]!.text, null);
  assert.match(out[0]!.transportError!, /ECONNRESET/);
});

test("retries several wallets concurrently and keeps them independent", async () => {
  const shots = [shot(0, "https://rpc", RATE), shot(1, "https://rpc", RATE)];
  const out = await retryFailed(shots, {
    baseDelayMs: 1,
    send: async (_url, body) => (body === "body0" ? okBody("0xhash0") : RATE),
  });
  assert.equal(out[0]!.text, okBody("0xhash0"), "wallet 0 recovered");
  assert.equal(out[1]!.text, RATE, "wallet 1 still failing, independently");
});
