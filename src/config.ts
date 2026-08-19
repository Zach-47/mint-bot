import { config as loadEnv } from "dotenv";
import { Wallet, getAddress, isAddress } from "ethers";
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
  wallet: Wallet;
}

export interface Config {
  rpcUrl: string;
  sequencerUrl: string;
  recipient: string;
  pollIntervalMs: number;
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

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  /* private keys */
  const wallets: WalletCfg[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < 32; i++) {
    const raw = process.env[`PK_${i}`];
    if (raw === undefined || raw.trim() === "" || raw.trim() === "0x...") continue;
    const key = raw.trim();
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
  if (wallets.length === 0) die("no private keys found - set PK_0 .. PK_4");

  /* recipient */
  const recipientRaw = (process.env.RECIPIENT ?? DEFAULT_RECIPIENT).trim();
  if (!isAddress(recipientRaw)) die(`RECIPIENT is not a valid address: "${recipientRaw}"`);
  const recipient = getAddress(recipientRaw);

  /* quantity */
  const quantity = parseIntEnv("QUANTITY", 2, 1, MAX_PER_WALLET);

  /* poll interval */
  const pollIntervalMs = parseIntEnv("POLL_INTERVAL_MS", 50, 5, 10_000);

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
    rpcUrl,
    sequencerUrl,
    recipient,
    pollIntervalMs,
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
  log(`quantity=${cfg.quantity} pollIntervalMs=${cfg.pollIntervalMs}`);
  for (const w of cfg.wallets) log(`wallet[${w.index}] ${w.address}`);
  log(`ARMED=${cfg.armed}`);
}
