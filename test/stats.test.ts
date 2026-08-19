import test from "node:test";
import assert from "node:assert/strict";
import { decodeStats, remaining } from "../src/stats.js";

function encode(words: bigint[]): string {
  return "0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("");
}

/**
 * Real mintStats() response shape captured from the chain:
 *   minted=1 cap=5000 price=1100000000000000 maxPerWallet=2
 *   sold=0   wallets=1 active=0 raised=1100000000000000
 */
const LIVE_RESPONSE =
  "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000003e871b540c00000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e871b540c000";

// Constructed from the same field values, asserted equal to the captured bytes.
const RECONSTRUCTED = encode([
  1n,
  5000n,
  1_100_000_000_000_000n,
  2n,
  0n,
  1n,
  0n,
  1_100_000_000_000_000n,
]);

test("captured response matches the documented field values", () => {
  assert.equal(LIVE_RESPONSE, RECONSTRUCTED);
});

test("decodeStats decodes the live pre-flip response", () => {
  const s = decodeStats(LIVE_RESPONSE);
  assert.equal(s.minted, 1n);
  assert.equal(s.cap, 5000n);
  assert.equal(s.price, 1_100_000_000_000_000n);
  assert.equal(s.maxPerWallet, 2n);
  assert.equal(s.sold, 0n);
  assert.equal(s.wallets, 1n);
  assert.equal(s.active, 0n);
  assert.equal(s.raised, 1_100_000_000_000_000n);
  assert.equal(remaining(s), 4999n);
});

test("active sits at hex offset 386, length 64", () => {
  const active = LIVE_RESPONSE.slice(386, 386 + 64);
  assert.equal(active.length, 64);
  assert.equal(BigInt("0x" + active), 0n);

  const flipped = encode([1n, 5000n, 1_100_000_000_000_000n, 2n, 0n, 1n, 1n, 0n]);
  assert.equal(BigInt("0x" + flipped.slice(386, 386 + 64)), 1n);
  assert.equal(decodeStats(flipped).active, 1n);
});

test("active is compared numerically, not by string match", () => {
  // A non-1 truthy value must still register as active.
  const odd = encode([1n, 5000n, 1_100_000_000_000_000n, 2n, 0n, 1n, 255n, 0n]);
  assert.notEqual(decodeStats(odd).active, 0n);
});

test("decodeStats rejects short and malformed returns", () => {
  assert.throws(() => decodeStats("0x"), /short return/);
  assert.throws(() => decodeStats("0x" + "00".repeat(200)), /short return/);
  assert.throws(() => decodeStats("nonsense"), /expected 0x-prefixed hex/);
});
