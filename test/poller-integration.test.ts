import test from "node:test";
import assert from "node:assert/strict";
import { startPoller } from "../src/poller.js";

function statsHex(active: bigint, minted = 1n, cap = 5000n): string {
  return (
    "0x" +
    [minted, cap, 1_100_000_000_000_000n, 2n, 0n, 1n, active, 0n]
      .map((w) => w.toString(16).padStart(64, "0"))
      .join("")
  );
}

const cfg = {
  rpcUrl: "https://rpc.invalid",
  pollIntervalMs: 20,
  pollMaxIntervalMs: 160,
} as never;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a 429 makes the live poller back off, and it recovers when clean", async () => {
  let throttling = true;
  const changes: number[] = [];

  const handle = startPoller(
    cfg,
    { onTrigger: () => {}, onSoldOut: () => {} },
    {
      transport: async () => {
        if (throttling) throw new Error('HTTP 429: {"error":{"message":"Too Many Requests"}}');
        return JSON.stringify({ jsonrpc: "2.0", id: 1, result: statsHex(0n) });
      },
      onIntervalChange: (ms) => changes.push(ms),
    },
  );

  await wait(700);
  assert.ok(changes.length > 0, "must have backed off while throttled");
  assert.ok(
    changes.every((v, i) => i === 0 || v >= changes[i - 1]!),
    "backoff must be monotonic while throttled",
  );
  const peak = changes[changes.length - 1]!;
  assert.ok(peak <= 160, `must respect the max interval, got ${peak}`);
  assert.ok(peak >= 40, `must actually slow down, got ${peak}`);

  // Now let it succeed and confirm it climbs back toward the target.
  throttling = false;
  await wait(4000); // one recovery window plus margin
  handle.stop();

  const final = changes[changes.length - 1]!;
  assert.ok(final < peak, `must recover below the throttled peak (${final} vs ${peak})`);
});

test("the poller keeps polling through throttling and still fires the trigger", async () => {
  let calls = 0;
  let fired = 0;

  const handle = startPoller(
    cfg,
    { onTrigger: () => fired++, onSoldOut: () => {} },
    {
      transport: async () => {
        calls++;
        // Throttle hard for the first stretch, then flip active on.
        if (calls < 5) throw new Error("HTTP 429: Too Many Requests");
        return JSON.stringify({ jsonrpc: "2.0", id: 1, result: statsHex(1n) });
      },
    },
  );

  await wait(1500);
  handle.stop();

  // Calls 1-4 are 429s, call 5 succeeds with active=1 and fires. The poller
  // then stops, so 5 calls is exactly right - it polled through every
  // throttle and still caught the flip on the first clean response.
  assert.ok(calls >= 5, `must have polled through all four throttles, got ${calls}`);
  assert.equal(fired, 1, "must fire exactly once, on the first clean response");
});
