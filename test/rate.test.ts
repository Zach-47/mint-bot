import test from "node:test";
import assert from "node:assert/strict";
import { RateController, isThrottle } from "../src/poller.js";

test("backs off multiplicatively when throttled, capped at max", () => {
  const r = new RateController(100, 2000);
  assert.equal(r.current, 100);
  r.onThrottled(); assert.equal(r.current, 200);
  r.onThrottled(); assert.equal(r.current, 400);
  r.onThrottled(); assert.equal(r.current, 800);
  r.onThrottled(); assert.equal(r.current, 1600);
  r.onThrottled(); assert.equal(r.current, 2000, "clamps to max");
  assert.equal(r.onThrottled(), false, "no further change once capped");
  assert.equal(r.current, 2000);
});

test("recovers only after a quiet period, measured in time", () => {
  const r = new RateController(100, 2000, 3000);
  r.onThrottled(0); // 200
  assert.equal(r.onSuccess(1000), false, "must not recover early");
  assert.equal(r.onSuccess(2999), false, "must not recover before the window");
  assert.equal(r.current, 200);
  assert.equal(r.onSuccess(3000), true, "recovers once the window elapses");
  assert.equal(r.current, 160);
});

test("recovery speed does not depend on how slow we already are", () => {
  // At the cap, a step must still take one window - not 40 slow polls.
  const r = new RateController(100, 2000, 3000);
  for (let i = 0; i < 6; i++) r.onThrottled(0);
  assert.equal(r.current, 2000);
  assert.equal(r.onSuccess(3000), true);
  assert.equal(r.current, 1600);
  // Full climb back is bounded and predictable, not open-ended.
  let t = 3000;
  let steps = 1;
  while (r.current > 100) { t += 3000; if (r.onSuccess(t)) steps++; }
  assert.ok(steps <= 15, `climb back should be bounded, took ${steps} steps`);
  assert.ok(t <= 60_000, `climb back should be under a minute of quiet, took ${t}ms`);
});

test("recovery never overshoots the target", () => {
  const r = new RateController(100, 2000, 3000);
  r.onThrottled(0);
  let t = 0;
  for (let n = 0; n < 500; n++) { t += 3000; r.onSuccess(t); }
  assert.equal(r.current, 100, "settles exactly at target");
  assert.equal(r.onSuccess(t + 10_000), false, "no churn once at target");
});

test("a throttle mid-recovery restarts the quiet window", () => {
  const r = new RateController(100, 2000, 3000);
  r.onThrottled(0); r.onThrottled(0);   // 400
  assert.equal(r.onSuccess(2500), false);
  r.onThrottled(2600);                  // 800, window restarts here
  assert.equal(r.current, 800);
  assert.equal(r.onSuccess(5000), false, "window restarted at the throttle");
  assert.equal(r.onSuccess(5600), true);
});

test("never polls faster than the target even from a fresh controller", () => {
  const r = new RateController(100, 2000, 3000);
  for (let i = 0; i < 100; i++) assert.equal(r.onSuccess(i * 5000), false);
  assert.equal(r.current, 100);
});

test("isThrottle recognises the RPC's 429 but not ordinary errors", () => {
  assert.ok(isThrottle('HTTP 429: {"error":{"code":429,"message":"Too Many Requests"}}'));
  assert.ok(isThrottle("Too Many Requests"));
  assert.equal(isThrottle("HTTP 503: upstream unavailable"), false);
  assert.equal(isThrottle("socket hang up"), false);
  assert.equal(isThrottle("execution reverted"), false);
});
