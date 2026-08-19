import test from "node:test";
import assert from "node:assert/strict";
import { Transaction, Wallet, keccak256 } from "ethers";
import { mintCalldata, mintedByCalldata } from "../src/presign.js";
import { decodeUint256Array } from "../src/sweep.js";
import {
  CHAIN_ID,
  CONTRACT,
  GAS_MINT,
  MAX_FEE,
  PRICE_WEI,
  PRIORITY_FEE,
} from "../src/config.js";

test("mint calldata is the selector plus a left-padded uint256", () => {
  assert.equal(
    mintCalldata(2),
    "0xa0712d68" + "0".repeat(63) + "2",
  );
  assert.equal(mintCalldata(1), "0xa0712d68" + "0".repeat(63) + "1");
  assert.equal(mintCalldata(2).length, 10 + 64);
});

test("mintedBy calldata left-pads the address", () => {
  const d = mintedByCalldata("0x31F7E03c18A86a947e3E689C9B1B040fECBa38Ec");
  assert.equal(d.slice(0, 10), "0x3cef28d2");
  assert.equal(d.length, 10 + 64);
  assert.ok(d.endsWith("31f7e03c18a86a947e3e689c9b1b040fecba38ec"));
});

test("mint value for quantity 2 is exactly 2200000000000000 wei", () => {
  assert.equal(PRICE_WEI * 2n, 2_200_000_000_000_000n);
});

test("signed mint tx decodes back to the expected fields, and the local hash matches", async () => {
  const w = new Wallet("0x" + "11".repeat(32));
  const tx = Transaction.from({
    to: CONTRACT,
    data: mintCalldata(2),
    value: PRICE_WEI * 2n,
    gasLimit: GAS_MINT,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    type: 2,
    chainId: CHAIN_ID,
    nonce: 3,
  });
  tx.signature = w.signingKey.sign(tx.unsignedHash);
  const raw = tx.serialized;

  // The sync signing path must be byte-identical to ethers' async signer.
  const async_ = await w.signTransaction({
    to: CONTRACT,
    data: mintCalldata(2),
    value: PRICE_WEI * 2n,
    gasLimit: GAS_MINT,
    maxFeePerGas: MAX_FEE,
    maxPriorityFeePerGas: PRIORITY_FEE,
    type: 2,
    chainId: CHAIN_ID,
    nonce: 3,
  });
  assert.equal(raw, async_, "sync signing must match Wallet.signTransaction");

  // The tx hash is keccak of the raw bytes - no RPC needed.
  assert.equal(keccak256(raw), tx.hash);

  const back = Transaction.from(raw);
  assert.equal(back.to, CONTRACT);
  assert.equal(back.value, 2_200_000_000_000_000n);
  assert.equal(back.nonce, 3);
  assert.equal(back.chainId, BigInt(CHAIN_ID));
  assert.equal(back.gasLimit, GAS_MINT);
  assert.equal(back.maxFeePerGas, MAX_FEE);
  assert.equal(back.maxPriorityFeePerGas, PRIORITY_FEE);
  assert.equal(back.from, w.address);
  assert.equal(back.type, 2);
});

test("distinct keys produce distinct tx hashes", () => {
  const hashes = new Set<string>();
  for (let i = 1; i <= 5; i++) {
    const w = new Wallet("0x" + String(i).repeat(2).padStart(2, "0").repeat(32).slice(0, 64));
    const tx = Transaction.from({
      to: CONTRACT,
      data: mintCalldata(2),
      value: PRICE_WEI * 2n,
      gasLimit: GAS_MINT,
      maxFeePerGas: MAX_FEE,
      maxPriorityFeePerGas: PRIORITY_FEE,
      type: 2,
      chainId: CHAIN_ID,
      nonce: 0,
    });
    tx.signature = w.signingKey.sign(tx.unsignedHash);
    hashes.add(keccak256(tx.serialized));
  }
  assert.equal(hashes.size, 5);
});

test("tokensOfOwner return decodes to a uint256 array", () => {
  const enc = (words: bigint[]): string =>
    "0x" + words.map((w) => w.toString(16).padStart(64, "0")).join("");
  // offset, length, then elements
  assert.deepEqual(decodeUint256Array(enc([32n, 2n, 41n, 42n])), [41n, 42n]);
  assert.deepEqual(decodeUint256Array(enc([32n, 0n])), []);
  assert.deepEqual(decodeUint256Array("0x"), []);
});

test("restart idempotency: wallets at the per-wallet limit are excluded", async () => {
  const { selectEligible } = await import("../src/presign.js");
  const mk = (i: number) => ({ index: i, address: `0x${String(i).repeat(40)}`, wallet: {} as never });
  const wallets = [mk(0), mk(1), mk(2), mk(3)];
  const state = [
    { index: 0, address: wallets[0]!.address, nonce: 0, mintedBy: 0n }, // fresh
    { index: 1, address: wallets[1]!.address, nonce: 1, mintedBy: 1n }, // partial, may still mint
    { index: 2, address: wallets[2]!.address, nonce: 1, mintedBy: 2n }, // at limit -> skip
    { index: 3, address: wallets[3]!.address, nonce: 5, mintedBy: 3n }, // over limit -> skip
  ];

  const { eligible, skipped } = selectEligible(wallets, state);
  assert.deepEqual(eligible.map((e) => e.w.index), [0, 1]);
  assert.deepEqual(skipped.map((s) => s.index), [2, 3]);
});

test("every wallet at the limit yields nothing to sign", async () => {
  const { selectEligible } = await import("../src/presign.js");
  const mk = (i: number) => ({ index: i, address: `0x${String(i).repeat(40)}`, wallet: {} as never });
  const wallets = [mk(0), mk(1)];
  const state = wallets.map((w) => ({ index: w.index, address: w.address, nonce: 2, mintedBy: 2n }));
  const { eligible, skipped } = selectEligible(wallets, state);
  assert.equal(eligible.length, 0);
  assert.equal(skipped.length, 2);
});

test("noncesChanged detects a moved nonce and ignores unchanged ones", async () => {
  const { noncesChanged } = await import("../src/presign.js");
  const prep = [
    { index: 0, address: "0xa", txHash: "0x1", nonce: 4, body: "", raw: "" },
    { index: 1, address: "0xb", txHash: "0x2", nonce: 7, body: "", raw: "" },
  ];
  const same = [
    { index: 0, address: "0xa", nonce: 4, mintedBy: 0n },
    { index: 1, address: "0xb", nonce: 7, mintedBy: 0n },
  ];
  const moved = [
    { index: 0, address: "0xa", nonce: 4, mintedBy: 0n },
    { index: 1, address: "0xb", nonce: 8, mintedBy: 0n },
  ];
  assert.equal(noncesChanged(prep, same), false);
  assert.equal(noncesChanged(prep, moved), true);
});
