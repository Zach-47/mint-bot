import test from "node:test";
import assert from "node:assert/strict";
import { makeStatsHandler } from "../src/poller.js";

function encode(words: bigint[]): string {
  return "0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("");
}

const ACTIVE = encode([1n, 5000n, 1_100_000_000_000_000n, 2n, 0n, 1n, 1n, 0n]);
const INACTIVE = encode([1n, 5000n, 1_100_000_000_000_000n, 2n, 0n, 1n, 0n, 0n]);
const SOLD_OUT = encode([5000n, 5000n, 1_100_000_000_000_000n, 2n, 0n, 1n, 1n, 0n]);

test("latch: 10 concurrent active payloads trigger blast exactly once", () => {
  let triggers = 0;
  let stops = 0;
  const handler = makeStatsHandler({
    onTrigger: () => triggers++,
    onSoldOut: () => assert.fail("should not report sold out"),
    onDecodeError: (e) => assert.fail(`unexpected decode error: ${e.message}`),
    stop: () => stops++,
  });

  // Simulate concurrent in-flight responses all reporting active at once.
  for (let i = 0; i < 10; i++) handler(ACTIVE);

  assert.equal(triggers, 1, "onTrigger must fire exactly once");
  assert.equal(stops, 1, "poller must be stopped exactly once");
});

test("latch stays closed for inactive payloads", () => {
  let triggers = 0;
  const handler = makeStatsHandler({
    onTrigger: () => triggers++,
    onSoldOut: () => assert.fail("not sold out"),
    onDecodeError: () => assert.fail("no decode error expected"),
    stop: () => {},
  });
  for (let i = 0; i < 50; i++) handler(INACTIVE);
  assert.equal(triggers, 0);
});

test("sold out does not fire, and fires onSoldOut once", () => {
  let triggers = 0;
  let soldOut = 0;
  const handler = makeStatsHandler({
    onTrigger: () => triggers++,
    onSoldOut: () => soldOut++,
    onDecodeError: () => assert.fail("no decode error expected"),
    stop: () => {},
  });
  for (let i = 0; i < 10; i++) handler(SOLD_OUT);
  assert.equal(triggers, 0, "must not fire into a sold-out mint");
  assert.equal(soldOut, 1, "onSoldOut must fire exactly once");
});

test("decode errors route to onDecodeError and never trigger", () => {
  let triggers = 0;
  let errors = 0;
  const handler = makeStatsHandler({
    onTrigger: () => triggers++,
    onSoldOut: () => assert.fail("not sold out"),
    onDecodeError: () => errors++,
    stop: () => {},
  });
  handler("0x");
  handler("garbage");
  assert.equal(triggers, 0);
  assert.equal(errors, 2);
});
