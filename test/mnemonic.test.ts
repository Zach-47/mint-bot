import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DERIVATION_BASE, deriveWallets, normaliseMnemonic } from "../src/config.js";

/**
 * The standard test mnemonic used by Hardhat and Anvil. Its addresses are
 * published, so this is a real vector rather than a self-referential test.
 */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const KNOWN = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
];

test("derives the published addresses for the standard test mnemonic", () => {
  const w = deriveWallets(TEST_MNEMONIC, "", DEFAULT_DERIVATION_BASE, 5, 0);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.address), KNOWN);
});

test("uses the BIP-44 path wallet apps show as accounts 1..n", () => {
  const w = deriveWallets(TEST_MNEMONIC, "", DEFAULT_DERIVATION_BASE, 3, 0);
  assert.deepEqual(w.map((x) => x.path), [
    "m/44'/60'/0'/0/0",
    "m/44'/60'/0'/0/1",
    "m/44'/60'/0'/0/2",
  ]);
});

test("WALLET_START_INDEX offsets derivation but keeps indices contiguous", () => {
  const w = deriveWallets(TEST_MNEMONIC, "", DEFAULT_DERIVATION_BASE, 2, 3);
  assert.deepEqual(w.map((x) => x.address), [KNOWN[3], KNOWN[4]]);
  assert.deepEqual(w.map((x) => x.path), ["m/44'/60'/0'/0/3", "m/44'/60'/0'/0/4"]);
  // internal indices stay 0-based so logs and skip logic line up
  assert.deepEqual(w.map((x) => x.index), [0, 1]);
});

test("every derived wallet is distinct and can sign", () => {
  const w = deriveWallets(TEST_MNEMONIC, "", DEFAULT_DERIVATION_BASE, 5, 0);
  assert.equal(new Set(w.map((x) => x.address)).size, 5);
  for (const x of w) assert.ok(x.wallet.signingKey, "must expose a signing key");
});

test("a bad checksum is rejected rather than silently deriving other wallets", () => {
  // valid words, wrong checksum
  const bad = "test test test test test test test test test test test test";
  assert.throws(() => deriveWallets(bad, "", DEFAULT_DERIVATION_BASE, 1, 0), /checksum/i);
  // a word that is not in the wordlist
  assert.throws(
    () => deriveWallets("banana " + TEST_MNEMONIC.split(" ").slice(1).join(" "), "", DEFAULT_DERIVATION_BASE, 1, 0),
    /mnemonic/i,
  );
});

test("a passphrase produces a completely different wallet set", () => {
  const plain = deriveWallets(TEST_MNEMONIC, "", DEFAULT_DERIVATION_BASE, 5, 0);
  const withPass = deriveWallets(TEST_MNEMONIC, "hunter2", DEFAULT_DERIVATION_BASE, 5, 0);
  for (let i = 0; i < 5; i++) assert.notEqual(plain[i]!.address, withPass[i]!.address);
});

test("normaliseMnemonic tolerates messy pasted input", () => {
  assert.equal(normaliseMnemonic("  Test   TEST\ttest \n junk  "), "test test test junk");
  // a realistic paste with newlines and double spaces still derives correctly
  const messy = "  test  test test\ntest test test test test test test test JUNK ";
  const w = deriveWallets(normaliseMnemonic(messy), "", DEFAULT_DERIVATION_BASE, 1, 0);
  assert.equal(w[0]!.address, KNOWN[0]);
});
