import { config as loadEnv } from "dotenv";
import { BaseWallet, HDNodeWallet, Mnemonic, Wallet, getAddress, isAddress } from "ethers";
import { fail, log } from "./log.js";

loadEnv();

/* ---------- verified constants (§1 of the build spec) ---------- */

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";
export const CONTRACT = "0xb6f2e19F5a8de2FbBDEA1d33A0E8965e77999bD4";
export const DEFAULT_RECIPIENT = "0x31F7E03c18A86a947e3E689C9B1B040fECBa38Ec";

export const SEL_MINT = "0xa0712d68";
export const SEL_MINT_STATS = "0xd7b2c656";
export const SEL_MINT_ACTIVE = "0x25fd90f3";
export const SEL_REMAINING = "0x55234ec0";
export const SEL_MINTED_BY = "0x3cef28d2";
export const SEL_TOKENS_OF = "0x8462151c";
export const SEL_TRANSFER_FROM = "0x23b872dd";
export const SEL_OWNER_OF = "0x6352211e";

export const PRICE_WEI = 1_100_000_000_000_000n;
export const MAX_PER_WALLET = 2;

export const GAS_MINT = 180_000n;
export const GAS_TRANSFER_FIRST = 140_000n;
export const GAS_TRANSFER_NEXT = 120_000n;
export const GAS_NATIVE_SEND = 21_000n;
export const MAX_FEE = 2_000_000_000n;
export const PRIORITY_FEE = 1_000_000_000n;

export const STATS_ACTIVE_WORD = 6; // hex offset 386, length 64

// simulate.ts state override
export const SLOT_MINT_ACTIVE =
  "0x0000000000000000000000000000000000000000000000000000000000000007";
export const SLOT_VALUE_ACTIVE =
  "0x000000000000000000000001563df358ca867875cda6144353dbe5cfd7c72838";

export const USER_AGENT = "minipengs-bot/1.0";

export const DEFAULT_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const DEFAULT_SEQUENCER_URL = "https://sequencer.mainnet.chain.robinhood.com";

export const WARMER_INTERVAL_MS = 20_000;
export const NONCE_REFRESH_MS = 60_000;
export const HEARTBEAT_MS = 30_000;

/* ---------- runtime config ---------- */

export interface WalletCfg {
  index: number;
  address: string;
  wallet: BaseWallet;
  /** derivation path when the wallet came from a mnemonic */
  path?: string;
}

/** Default BIP-44 account path - the same one MetaMask, Rabby and Ledger use. */
export const DEFAULT_DERIVATION_BASE = "m/44'/60'/0'/0";

export interface Config {
  /** where the keys came from, for logging - never contains key material */
  keySource: string;
  rpcUrl: string;
  sequencerUrl: string;
  recipient: string;
  pollIntervalMs: number;
  pollMaxIntervalMs: number;
  quantity: number;
  armed: boolean;
  wallets: WalletCfg[];
  /** exact msg.value for mint(quantity) */
  mintValue: bigint;
  /** minimum balance required to mint: value + gasLimit * maxFeePerGas */
  minBalance: bigint;
  /** comfortable balance incl. sweep headroom */
  warnBalance: bigint;
}

function die(msg: string): never {
  fail(msg);
  process.exit(1);
}

function parseIntEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    die(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

/**
 * Derive `count` wallets from a BIP-39 mnemonic, starting at `start`.
 *
 * Uses the standard BIP-44 path m/44'/60'/0'/0/i, so index i is the same
 * address your wallet app shows as account i+1. Verified against the
 * published test vectors for the standard test mnemonic.
 *
 * Pure and exported so it can be tested without touching the environment.
 */
export function deriveWallets(
  phrase: string,
  passphrase: string,
  base: string,
  count: number,
  start: number,
): Array<{ index: number; address: string; wallet: HDNodeWallet; path: string }> {
  // Throws on a bad word or a bad checksum - a typo must never silently
  // derive a different, unfunded set of wallets.
  Mnemonic.fromPhrase(phrase, passphrase);

  const out: Array<{ index: number; address: string; wallet: HDNodeWallet; path: string }> = [];
  for (let n = 0; n < count; n++) {
    const i = start + n;
    const path = `${base}/${i}`;
    const w = HDNodeWallet.fromPhrase(phrase, passphrase, path);
    out.push({ index: n, address: getAddress(w.address), wallet: w, path });
  }
  return out;
}

/** Normalise a mnemonic: trim, collapse whitespace, lowercase. */
export function normaliseMnemonic(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function loadWallets(): { wallets: WalletCfg[]; keySource: string } {
  const rawMnemonic = process.env.MNEMONIC ?? "";
  const hasMnemonic = rawMnemonic.trim() !== "" && !rawMnemonic.startsWith("word1 word2");
  const pkIndices: number[] = [];
  for (let i = 0; i < 32; i++) {
    const v = process.env[`PK_${i}`];
    if (v !== undefined && v.trim() !== "" && v.trim() !== "0x...") pkIndices.push(i);
  }

  if (hasMnemonic && pkIndices.length > 0) {
    die(
      `both MNEMONIC and PK_${pkIndices[0]} are set - that is ambiguous. ` +
        `Use one or the other, not both.`,
    );
  }

  if (hasMnemonic) {
    const phrase = normaliseMnemonic(rawMnemonic);
    const words = phrase.split(" ").length;
    if (![12, 15, 18, 21, 24].includes(words)) {
      die(`MNEMONIC has ${words} words - expected 12, 15, 18, 21 or 24`);
    }
    const count = parseIntEnv("WALLET_COUNT", 5, 1, 20);
    const start = parseIntEnv("WALLET_START_INDEX", 0, 0, 1_000_000);
    const base = (process.env.DERIVATION_PATH ?? DEFAULT_DERIVATION_BASE).trim();
    if (!/^m(\/\d+'?)+$/.test(base)) {
      die(`DERIVATION_PATH "${base}" is not a valid BIP-32 path prefix (e.g. m/44'/60'/0'/0)`);
    }
    const passphrase = process.env.MNEMONIC_PASSPHRASE ?? "";

    let derived: ReturnType<typeof deriveWallets>;
    try {
      derived = deriveWallets(phrase, passphrase, base, count, start);
    } catch (e) {
      // Never echo the phrase itself into the message.
      die(`MNEMONIC is not a valid BIP-39 phrase: ${(e as Error).message}`);
    }
    const wallets: WalletCfg[] = derived.map((d) => ({
      index: d.index,
      address: d.address,
      wallet: d.wallet,
      path: d.path,
    }));
    const last = start + count - 1;
    return {
      wallets,
      keySource: `mnemonic (${words} words${passphrase ? " + passphrase" : ""}), ${base}/${start}..${last}`,
    };
  }

  /* individual private keys */
  const wallets: WalletCfg[] = [];
  const seen = new Map<string, number>();
  for (const i of pkIndices) {
    const key = (process.env[`PK_${i}`] ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      die(`PK_${i} is not a 0x-prefixed 32-byte hex private key`);
    }
    let w: Wallet;
    try {
      w = new Wallet(key);
    } catch (e) {
      die(`PK_${i} failed to parse: ${(e as Error).message}`);
    }
    const addr = getAddress(w.address);
    const dup = seen.get(addr.toLowerCase());
    if (dup !== undefined) {
      die(`PK_${i} derives the same address as PK_${dup} (${addr}) - duplicated paste`);
    }
    seen.set(addr.toLowerCase(), i);
    wallets.push({ index: i, address: addr, wallet: w });
  }
  if (wallets.length === 0) {
    die("no wallets configured - set MNEMONIC, or PK_0 .. PK_4");
  }
  return { wallets, keySource: `private keys PK_${pkIndices.join(", PK_")}` };
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const { wallets, keySource } = loadWallets();

  /* recipient */
  const recipientRaw = (process.env.RECIPIENT ?? DEFAULT_RECIPIENT).trim();
  if (!isAddress(recipientRaw)) die(`RECIPIENT is not a valid address: "${recipientRaw}"`);
  const recipient = getAddress(recipientRaw);

  /* quantity */
  const quantity = parseIntEnv("QUANTITY", 2, 1, MAX_PER_WALLET);

  /* poll interval */
  // 100ms was chosen from live measurement: the RPC enforces a rolling request
  // budget and a 50ms poll starts returning 429 after ~74s. The poller adapts
  // from here at runtime, so this is a starting point, not a ceiling.
  const pollIntervalMs = parseIntEnv("POLL_INTERVAL_MS", 100, 5, 10_000);
  const pollMaxIntervalMs = parseIntEnv("POLL_MAX_INTERVAL_MS", 2_000, 50, 60_000);
  if (pollMaxIntervalMs < pollIntervalMs) {
    die(`POLL_MAX_INTERVAL_MS (${pollMaxIntervalMs}) must be >= POLL_INTERVAL_MS (${pollIntervalMs})`);
  }

  /* armed */
  const armedRaw = (process.env.ARMED ?? "false").trim();
  if (armedRaw !== "true" && armedRaw !== "false") {
    die(`ARMED must be exactly "true" or "false", got "${armedRaw}"`);
  }

  const rpcUrl = (process.env.RPC_URL ?? DEFAULT_RPC_URL).trim();
  const sequencerUrl = (process.env.SEQUENCER_URL ?? DEFAULT_SEQUENCER_URL).trim();
  for (const [name, url] of [["RPC_URL", rpcUrl], ["SEQUENCER_URL", sequencerUrl]] as const) {
    if (!/^https:\/\//.test(url)) die(`${name} must be an https:// URL, got "${url}"`);
  }

  const mintValue = PRICE_WEI * BigInt(quantity);
  const minBalance = mintValue + GAS_MINT * MAX_FEE;

  cached = {
    keySource,
    rpcUrl,
    sequencerUrl,
    recipient,
    pollIntervalMs,
    pollMaxIntervalMs,
    quantity,
    armed: armedRaw === "true",
    wallets,
    mintValue,
    minBalance,
    warnBalance: 3_000_000_000_000_000n,
  };
  return cached;
}

export function logConfig(cfg: Config): void {
  log(`chain=${CHAIN_ID} contract=${CONTRACT}`);
  log(`rpc=${cfg.rpcUrl}`);
  log(`sequencer=${cfg.sequencerUrl}`);
  log(`recipient=${cfg.recipient}`);
  log(`quantity=${cfg.quantity} pollIntervalMs=${cfg.pollIntervalMs} (max ${cfg.pollMaxIntervalMs}ms)`);
  log(`keys: ${cfg.keySource}`);
  for (const w of cfg.wallets) {
    log(`wallet[${w.index}] ${w.address}${w.path ? `  ${w.path}` : ""}`);
  }
  log(`ARMED=${cfg.armed}`);
}
